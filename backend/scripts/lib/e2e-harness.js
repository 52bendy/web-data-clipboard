import http from 'node:http';
import { once } from 'node:events';
import { createServer } from '../../src/server.js';
import { getConfig } from '../../src/config.js';
import { createServices } from '../../src/services/index.js';

/** Shared secret used only by the local, in-process E2E harness. */
export const E2E_TOKEN = 'e2e-secret-token';

/**
 * Builds a complete config object for the E2E harness. Real deployments read
 * `process.env`; the script injects deterministic values so every case is
 * reproducible and never touches a developer's environment.
 */
export function buildE2EConfig(overrides = {}, { receiverUrl } = {}) {
  const defaults = getConfig({});
  const config = {
    ...defaults,
    apiSecretToken: E2E_TOKEN,
    enforceHttps: false,
    trustProxy: true,
    rateLimitEnabled: false,
    clipboard: {
      ...defaults.clipboard,
      ttlMs: 10_000,
      maintenanceIntervalMs: 60_000,
    },
    collect: {
      ...defaults.collect,
      maxBodyBytes: 1_024,
    },
    webhook: {
      ...defaults.webhook,
      maxAttempts: 1,
      retryBaseDelayMs: 10,
    },
    admin: {
      ...defaults.admin,
      username: 'admin',
      password: '',
      passwordHash: '',
    },
    ...overrides,
  };
  for (const section of ['clipboard', 'collect', 'webhook', 'admin']) {
    if (overrides[section]) {
      config[section] = { ...config[section], ...overrides[section] };
    }
  }

  if (receiverUrl) {
    // The script's webhook receiver is a local HTTP server, while the public
    // webhook contract requires an https URL. Keep the production target
    // validation for config creation by resolving a public test address, and
    // route only the transport to the local receiver. This exercises the
    // real dispatcher, payload builder and HMAC signing end to end.
    config.webhook = {
      ...config.webhook,
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      validateTarget: async (url) => new URL(url),
      send: async (target, { body, headers, timeoutMs }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(receiverUrl, {
            method: 'POST',
            headers,
            body,
            signal: controller.signal,
          });
          return {
            status: response.status,
            body: await response.text(),
          };
        } finally {
          clearTimeout(timer);
        }
      },
    };
  }
  return config;
}

/** Starts a local webhook receiver and records every raw request. */
export async function startReceiver() {
  const received = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    received.push({
      method: request.method,
      headers: request.headers,
      body: rawBody,
    });
    response.writeHead(204);
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/webhook`,
    received,
    close: () => closeServer(server),
  };
}

/** Starts the backend in-process; the caller owns the returned server. */
export async function startBackend({ receiverUrl, overrides } = {}) {
  const config = buildE2EConfig(overrides, { receiverUrl });
  const services = createServices({ config });
  const server = createServer({ config, services });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    config,
    services,
    server,
    close: () => closeServer(server),
  };
}

/** Fetch helper that returns status, headers, parsed JSON and raw text. */
export async function request(base, path, options = {}) {
  const { token, headers = {}, body, method = 'GET' } = options;
  const requestHeaders = { ...headers };
  if (token) requestHeaders['X-DCC-Token'] = token;
  let payload = body;
  if (body !== undefined && body !== null && typeof body !== 'string') {
    payload = JSON.stringify(body);
    requestHeaders['content-type'] ??= 'application/json';
  }
  const response = await fetch(`${base}${path}`, {
    method,
    headers: requestHeaders,
    body: payload,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return {
    status: response.status,
    headers: response.headers,
    text,
    body: json,
  };
}

/** Polls until `predicate` returns truthy or the timeout elapses. */
export async function waitFor(
  predicate,
  { timeoutMs = 3_000, intervalMs = 25 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (lastError) throw lastError;
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

export async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

/** A plausible §4.1.1 device report; timestamp is filled at call time. */
export function collectPayload(overrides = {}) {
  return {
    device_id: 'android_e2e_001',
    device_name: 'E2E 小米 13Pro',
    platform: 'android',
    sender: '13800138000',
    raw_content: '【中国移动】您的验证码是：839201，5分钟内有效。',
    timestamp: Date.now(),
    ...overrides,
  };
}
