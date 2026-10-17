import { createServer as createHttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { getConfig } from './config.js';
import { health } from '../api/v1/health.js';
import { createClipboardLatestHandler } from '../api/v1/clipboard-latest.js';
import { authorize } from './middleware/auth.js';
import { errorResponse } from './middleware/errors.js';
import { isHttps } from './middleware/httpsEnforce.js';
import { rejectQueryToken } from './middleware/queryToken.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { createServices } from './services/index.js';

export function createApp({ config = getConfig(), routes } = {}) {
  return async (request, response) => {
    try {
      const https = isHttps(request, config.trustProxy === true);
      for (const [name, value] of Object.entries(
        securityHeaders(config, https),
      )) {
        response.setHeader(name, value);
      }
      if (config.enforceHttps && !https) {
        return await send(response, errorResponse(403));
      }
      const url = new URL(
        request.url,
        `http://${request.headers.host || 'localhost'}`,
      );
      // Defect 21: reject token-like query parameters before routing or auth,
      // so no endpoint (current or future) can silently accept them.
      const queryTokenDenied = rejectQueryToken(url);
      if (queryTokenDenied) return await send(response, queryTokenDenied);
      if (request.method === 'GET' && url.pathname === '/api/v1/health') {
        return await send(response, health());
      }
      const route = routes?.find(
        (item) => item.method === request.method && item.path === url.pathname,
      );
      if (route) {
        if (route.auth) {
          const denied = authorize(request, config.apiSecretToken);
          if (denied) return await send(response, denied);
        }
        return await send(response, await route.handler(request, url));
      }
      // A known path with an unsupported method is 405, not 404.
      if (routes?.some((item) => item.path === url.pathname)) {
        return await send(response, errorResponse(405));
      }
      return await send(response, errorResponse(404));
    } catch {
      return send(response, errorResponse(500));
    }
  };
}

/** Builds the dev server with the default API route table. */
export function createServer({
  config = getConfig(),
  services = createServices({ config }),
  routes,
  now = Date.now,
} = {}) {
  const defaultRoutes = routes ?? [
    {
      method: 'GET',
      path: '/api/v1/clipboard/latest',
      auth: true,
      handler: createClipboardLatestHandler({ config, services, now }),
    },
  ];

  // Sweep expired clipboard entries so TTL cleanup does not rely on reads
  // alone (§8.2). The timer must not keep the process alive on its own.
  const purgeTimer = setInterval(
    () => {
      services.clipboardStore
        .purgeExpired()
        .catch((error) => console.error('clipboard purge failed:', error));
    },
    config.clipboard?.maintenanceIntervalMs ?? 60 * 1000,
  );
  purgeTimer.unref();

  const server = createHttpServer(createApp({ config, routes: defaultRoutes }));
  server.on('close', () => clearInterval(purgeTimer));
  return server;
}

async function send(response, result) {
  const body = await result.text();
  for (const [name, value] of result.headers) {
    if (!response.hasHeader(name)) response.setHeader(name, value);
  }
  response.writeHead(result.status);
  response.end(body);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const config = getConfig();
  if (!config.apiSecretToken) {
    console.warn(
      'API_SECRET_TOKEN is not configured; protected routes will fail closed.',
    );
  }
  const server = createServer({ config });
  server.listen(config.port, () =>
    console.log(`Backend listening on http://localhost:${config.port}`),
  );
}
