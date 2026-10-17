import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'private-admin-password';
const API_TOKEN = 'api-token-for-tests';
const silentLogger = { info() {}, warn() {}, error() {} };
const ADMIN_PUBLIC_DIR = fileURLToPath(
  new URL('../public/admin', import.meta.url),
);

function makeConfig(overrides = {}) {
  return {
    apiSecretToken: API_TOKEN,
    enforceHttps: false,
    trustProxy: false,
    contentSecurityPolicy: "default-src 'self'",
    hstsMaxAge: 31536000,
    rateLimitEnabled: false,
    rateLimitPerMinute: 30,
    rateLimitWindowSeconds: 60,
    autoExtract: true,
    maskSender: true,
    storage: { driver: 'memory' },
    clipboard: {
      ttlMs: 1800000,
      historyMaxEntries: 500,
      historyMaxAgeMs: 86400000,
      maintenanceIntervalMs: 60000,
    },
    collect: { maxRawContentLength: 4096, maxBodyBytes: 65536 },
    devices: { onlineThresholdMs: 1000 },
    logs: { maxEntries: 1000, maxAgeMs: 7 * 86400000 },
    admin: {
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
      passwordHash: '',
      sessionTtlMs: 3600000,
      loginMaxAttempts: 10,
      loginWindowMs: 900000,
      maxSessions: 100,
      cookieSecure: 'auto',
    },
    ...overrides,
  };
}

async function withServer(options, run) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function login(base) {
  const response = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
    }),
  });
  const cookie = (response.headers.get('set-cookie') || '').split(';')[0];
  const body = await response.json();
  return { response, cookie, csrf: body.data.csrfToken, body };
}

const ADMIN_API_CASES = [
  ['GET', '/api/admin/session'],
  ['GET', '/api/admin/devices'],
  ['GET', '/api/admin/logs'],
  ['GET', '/api/admin/stats'],
  ['GET', '/api/admin/settings'],
  ['PATCH', '/api/admin/settings'],
  ['POST', '/api/admin/token/reset'],
  ['POST', '/api/admin/logout'],
  ['GET', '/api/admin/unknown'],
];

const MANAGEMENT_API_CASES = [
  ['GET', '/api/v1/devices'],
  ['GET', '/api/v1/logs'],
  ['GET', '/api/v1/stats'],
  ['GET', '/api/v1/webhooks'],
  ['GET', '/api/v1/settings'],
];

function assertAdminUnauthorized(body) {
  assert.deepEqual(body, {
    code: 401,
    message: 'Admin authentication required.',
    data: null,
  });
}

test('defect 20 regression: anonymous requests cannot reach any admin page or asset', async () => {
  const files = (await readdir(ADMIN_PUBLIC_DIR))
    .filter((name) => name !== 'login.css')
    .sort();
  assert.ok(files.length >= 9, 'admin public directory is not empty');

  await withServer(
    {
      config: makeConfig(),
      logger: silentLogger,
      adminOptions: { logger: silentLogger },
    },
    async (base) => {
      // The login form and its stylesheet are the only public admin assets.
      const loginPage = await fetch(`${base}/admin/login`);
      assert.equal(loginPage.status, 200);
      assert.equal(loginPage.headers.get('x-robots-tag'), 'noindex, nofollow');
      assert.equal((await fetch(`${base}/admin/login.css`)).status, 200);

      for (const path of ['/admin', '/admin/']) {
        const response = await fetch(`${base}${path}`, { redirect: 'manual' });
        assert.equal(response.status, 302, path);
        assert.match(
          response.headers.get('location') || '',
          /^\/admin\/login\?next=/,
        );
      }

      for (const file of files) {
        const path = `/admin/${file}`;
        const response = await fetch(`${base}${path}`, { redirect: 'manual' });
        assert.equal(response.status, 302, path);
        assert.match(
          response.headers.get('location') || '',
          /^\/admin\/login\?next=/,
        );
        const body = await response.text();
        assert.doesNotMatch(body, /raw_content|13800138000|839201/);
      }
    },
  );
});

test('defect 20 regression: anonymous and API-token-only requests cannot call admin APIs', async () => {
  await withServer(
    {
      config: makeConfig(),
      logger: silentLogger,
      adminOptions: { logger: silentLogger },
    },
    async (base) => {
      for (const [method, path] of ADMIN_API_CASES) {
        for (const headers of [{}, { 'x-dcc-token': API_TOKEN }]) {
          const response = await fetch(`${base}${path}`, { method, headers });
          assert.equal(response.status, 401, `${method} ${path}`);
          assert.equal(
            response.headers.get('x-robots-tag'),
            'noindex, nofollow',
          );
          assertAdminUnauthorized(await response.json());
        }
      }

      // Management APIs are part of the admin surface once an admin account
      // exists; a valid device token must not read SMS history or statistics.
      for (const [method, path] of MANAGEMENT_API_CASES) {
        for (const headers of [{}, { 'x-dcc-token': API_TOKEN }]) {
          const response = await fetch(`${base}${path}`, { method, headers });
          assert.equal(response.status, 401, `${method} ${path}`);
          assertAdminUnauthorized(await response.json());
        }
      }
    },
  );
});

test('defect 20 regression: an authenticated admin session still reaches every module', async () => {
  await withServer(
    {
      config: makeConfig(),
      logger: silentLogger,
      adminOptions: { logger: silentLogger },
    },
    async (base) => {
      const { response, cookie, csrf } = await login(base);
      assert.equal(response.status, 200);

      for (const path of [
        '/admin',
        '/admin/devices.html',
        '/admin/logs.html',
        '/admin/settings.html',
      ]) {
        const page = await fetch(`${base}${path}`, { headers: { cookie } });
        assert.equal(page.status, 200, path);
      }

      for (const path of [
        '/api/admin/devices',
        '/api/admin/logs',
        '/api/admin/stats',
        '/api/admin/settings',
      ]) {
        const api = await fetch(`${base}${path}`, { headers: { cookie } });
        assert.equal(api.status, 200, path);
      }

      const settings = await fetch(`${base}/api/admin/settings`, {
        headers: { cookie },
      });
      assert.equal((await settings.json()).data.token_configured, true);

      const noCsrf = await fetch(`${base}/api/admin/token/reset`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      assert.equal(noCsrf.status, 403);

      const rotated = await fetch(`${base}/api/admin/token/reset`, {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          'x-csrf-token': csrf,
        },
        body: JSON.stringify({ confirm: true }),
      });
      assert.equal(rotated.status, 200);
      const rotatedBody = await rotated.json();
      assert.equal(typeof rotatedBody.data.token, 'string');
      assert.ok(rotatedBody.data.token.length >= 20);
    },
  );
});

test('defect 20 regression: admin surface fails closed without credentials', async () => {
  const options = {
    config: makeConfig({
      admin: {
        username: ADMIN_USERNAME,
        password: '',
        passwordHash: '',
        sessionTtlMs: 3600000,
        loginMaxAttempts: 10,
        loginWindowMs: 900000,
        maxSessions: 100,
        cookieSecure: 'auto',
      },
    }),
    logger: silentLogger,
    adminOptions: { logger: silentLogger },
  };

  await withServer(options, async (base) => {
    for (const path of ['/admin', '/admin/logs.html', '/admin/settings.html']) {
      const response = await fetch(`${base}${path}`, { redirect: 'manual' });
      assert.equal(response.status, 503, path);
      assert.match(await response.text(), /后台未启用/);
    }

    for (const [method, path] of [
      ['GET', '/api/admin/session'],
      ['GET', '/api/admin/logs'],
      ['POST', '/api/admin/token/reset'],
    ]) {
      const response = await fetch(`${base}${path}`, { method });
      assert.equal(response.status, 401, `${method} ${path}`);
      assertAdminUnauthorized(await response.json());
    }
  });
});
