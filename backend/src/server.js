import { createServer as createHttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { getConfig } from './config.js';
import { health } from '../api/v1/health.js';
import { createCollectHandler } from '../api/v1/collect.js';
import { createWebhookHandlers } from '../api/v1/webhooks.js';
import { createServices } from './services/index.js';
import { authorize } from './middleware/auth.js';
import { errorResponse } from './middleware/errors.js';
import { isHttps } from './middleware/httpsEnforce.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { rateLimit } from './middleware/rateLimit.js';
import { createLogger } from './utils/logger.js';

const WEBHOOK_ID_PATH = /^\/api\/v1\/webhooks\/[^/]+$/;
const WEBHOOK_TEST_PATH = /^\/api\/v1\/webhooks\/[^/]+\/test$/;

/**
 * Shared app factory (REQ-202610-1252): security headers → HTTPS enforcement
 * → health (always public) → route table → shared 404/405/500 envelopes.
 * Route handlers receive `(request, url)` and return a Web `Response`.
 */
export function createApp({
  config = getConfig(),
  routes = [],
  logger = createLogger(),
} = {}) {
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
      // Health stays public and cannot be shadowed by a later route.
      if (request.method === 'GET' && url.pathname === '/api/v1/health') {
        return await send(response, health());
      }
      const route = routes.find(
        (item) => item.method === request.method && matches(item, url.pathname),
      );
      if (route) {
        if (route.auth) {
          const denied = authorize(request, config.apiSecretToken);
          if (denied) return await send(response, denied);
        }
        return await send(response, await route.handler(request, url));
      }
      // Known path with an unsupported method gets 405 rather than 404.
      if (routes.some((item) => matches(item, url.pathname))) {
        return await send(response, errorResponse(405));
      }
      return await send(response, errorResponse(404));
    } catch (error) {
      logger.error('request.failed', {
        path: request.url,
        error: String(error),
      });
      return send(response, errorResponse(500));
    }
  };
}

function matches(route, pathname) {
  return route.match ? route.match(pathname) : route.path === pathname;
}

async function send(response, result) {
  const body = await result.text();
  for (const [name, value] of result.headers) {
    if (!response.hasHeader(name)) response.setHeader(name, value);
  }
  response.writeHead(result.status);
  response.end(body);
}

/** Registers every backend route that has landed so far. */
export function buildRoutes({ config, services, logger }) {
  const collect = createCollectHandler({ config, services, logger });
  const webhooks = createWebhookHandlers({ config, services, logger });
  return [
    {
      method: 'POST',
      path: '/api/v1/collect',
      auth: true,
      handler: rateLimit({ config })(collect),
    },
    {
      method: 'GET',
      path: '/api/v1/webhooks',
      auth: true,
      handler: webhooks.list,
    },
    {
      method: 'POST',
      path: '/api/v1/webhooks',
      auth: true,
      handler: webhooks.create,
    },
    {
      method: 'GET',
      path: '/api/v1/webhooks/deliveries',
      auth: true,
      handler: webhooks.deliveries,
    },
    {
      method: 'GET',
      match: (pathname) => WEBHOOK_ID_PATH.test(pathname),
      auth: true,
      handler: webhooks.get,
    },
    {
      method: 'PATCH',
      match: (pathname) => WEBHOOK_ID_PATH.test(pathname),
      auth: true,
      handler: webhooks.update,
    },
    {
      method: 'DELETE',
      match: (pathname) => WEBHOOK_ID_PATH.test(pathname),
      auth: true,
      handler: webhooks.remove,
    },
    {
      method: 'POST',
      match: (pathname) => WEBHOOK_TEST_PATH.test(pathname),
      auth: true,
      handler: webhooks.test,
    },
  ];
}

export function createServer({
  config = getConfig(),
  services = null,
  logger = createLogger(),
  routes = null,
} = {}) {
  const appServices = services ?? createServices({ config, logger });
  const appRoutes =
    routes ?? buildRoutes({ config, services: appServices, logger });

  // Sweep expired clipboard entries so TTL cleanup does not rely on reads
  // alone (§8.2). The timer must not keep the process alive on its own.
  const purgeTimer = setInterval(() => {
    appServices.clipboardStore
      .purgeExpired()
      .catch((error) =>
        logger.error('clipboard.purge_failed', { error: String(error) }),
      );
  }, config.clipboard?.maintenanceIntervalMs ?? 60000);
  purgeTimer.unref();

  const server = createHttpServer(
    createApp({ config, routes: appRoutes, logger }),
  );
  server.on('close', () => clearInterval(purgeTimer));
  return server;
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
