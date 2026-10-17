import { createServer as createHttpServer } from 'node:http';
import { getConfig } from './config.js';
import { health } from '../api/v1/health.js';
import { createCollectHandler } from '../api/v1/collect.js';
import { createServices } from './services/index.js';
import { errorResponse } from './middleware/errors.js';
import { createLogger } from './utils/logger.js';
import { authorize } from './middleware/auth.js';
import { isHttps } from './middleware/httpsEnforce.js';
import { rateLimit } from './middleware/rateLimit.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { pathToFileURL } from 'node:url';

/** Create the shared request handler with mandatory security controls. */
export function createApp({
  config = getConfig(),
  services = createServices({ config }),
  logger = createLogger(),
  routes = [],
} = {}) {
  const collect = createCollectHandler({ config, services, logger });
  const protectedCollect = rateLimit({ config })(collect);
  const builtInRoutes = [
    { method: 'POST', path: '/api/v1/collect', auth: false, handler: protectedCollect },
    ...routes.filter((route) => route.path !== '/api/v1/health'),
  ];

  return async (request, response) => {
    try {
      const https = isHttps(request, config.trustProxy === true);
      for (const [name, value] of Object.entries(securityHeaders({
        contentSecurityPolicy: config.contentSecurityPolicy || "default-src 'self'",
        hstsMaxAge: config.hstsMaxAge ?? 31536000,
      }, https))) response.setHeader(name, value);
      if (config.enforceHttps && !https) return await send(response, errorResponse(403));

      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      if (request.method === 'GET' && url.pathname === '/api/v1/health') {
        return await send(response, health());
      }
      if (url.pathname === '/api/v1/collect' && request.method !== 'POST') {
        return await send(response, errorResponse(405));
      }
      const route = builtInRoutes.find((item) => item.method === request.method && item.path === url.pathname);
      if (route) {
        if (route.auth) {
          const denied = authorize(request, config.apiSecretToken);
          if (denied) return await send(response, denied);
        }
        return await send(response, await route.handler(request, url));
      }
      return await send(response, errorResponse(404));
    } catch (error) {
      logger.error('request.failed', { error: String(error) });
      return await send(response, errorResponse(500));
    }
  };
}

export function createServer(options = {}) {
  const config = options.config || getConfig();
  const services = options.services || createServices({ config });
  const logger = options.logger || createLogger();
  const app = createApp({ ...options, config, services, logger });
  const server = createHttpServer(app);
  const purgeTimer = setInterval(() => {
    services.clipboardStore.purgeExpired().catch((error) =>
      logger.error('clipboard.purge_failed', { error: String(error) }),
    );
  }, config.clipboard?.maintenanceIntervalMs || 60_000);
  purgeTimer.unref();
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
      'API_SECRET_TOKEN is not configured; /api/v1/collect will reject all requests (fail closed).',
    );
  }
  const server = createServer({ config });
  server.listen(config.port, () =>
    console.log(`Backend listening on http://localhost:${config.port}`),
  );
}
