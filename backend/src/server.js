import { createServer as createHttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { getConfig } from './config.js';
import { health } from '../api/v1/health.js';
import { createClipboardLatestHandler } from '../api/v1/clipboard-latest.js';
import { createCollectHandler } from '../api/v1/collect.js';
import { createLogsHandler } from '../api/v1/logs.js';
import { createStatsHandler } from '../api/v1/stats.js';
import { createAdmin, isManagementApiPath } from './admin/index.js';
import { createDashboardApi } from './admin/dashboard-api.js';
import { authorize } from './middleware/auth.js';
import { errorResponse } from './middleware/errors.js';
import { isHttps } from './middleware/httpsEnforce.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { createServices } from './services/index.js';
import { createLogger } from './utils/logger.js';

/**
 * Shared application pipeline: security headers → HTTPS → admin pages/API →
 * management-prefix guard → public API route table.
 *
 * `routes` entries may opt into `auth: true` (X-DCC-Token) and `allowAdmin:
 * true` (an authenticated admin session may call the route without a token,
 * used by the log board / dashboard family of management APIs).
 */
export function createApp({
  config = getConfig(),
  routes,
  services,
  adminOptions,
  now = Date.now,
} = {}) {
  const apiHandlers = { ...(adminOptions?.apiHandlers ?? {}) };
  if (services) {
    apiHandlers['/api/admin/dashboard'] = createDashboardApi({
      config,
      services,
      now,
    });
  }
  const admin = createAdmin({
    config,
    ...adminOptions,
    apiHandlers,
  });

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

      // Admin pages, login/logout and /api/admin/* live outside the API route
      // table so every future admin asset is covered by one guard.
      const adminResponse = await admin.handle(request, url, { https });
      if (adminResponse) return await send(response, adminResponse);

      const route = routes?.find(
        (item) => item.method === request.method && item.path === url.pathname,
      );
      const pathKnown = routes?.some((item) => item.path === url.pathname);
      const managementApi = isManagementApiPath(url.pathname);
      const adminSession = managementApi ? admin.authenticate(request) : null;

      // Management APIs (devices / webhooks / logs / stats / settings) are
      // admin-only by prefix. Routes that intentionally support the
      // X-DCC-Token contract stay reachable for token clients; anonymous
      // callers still receive the admin 401 rather than a route hint.
      if (managementApi && !adminSession) {
        const hasToken = Boolean(request.headers['x-dcc-token']);
        if (!pathKnown || (route?.auth && !hasToken)) {
          return await send(response, admin.unauthorized());
        }
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/health') {
        return await send(response, health());
      }
      if (route) {
        if (route.admin && !managementApi && !admin.authenticate(request)) {
          return await send(response, admin.unauthorized());
        }
        if (route.auth) {
          const adminAllowed =
            route.allowAdmin === true && admin.authenticate(request);
          if (!adminAllowed) {
            const denied = authorize(request, config.apiSecretToken);
            if (denied) return await send(response, denied);
          }
        }
        return await send(response, await route.handler(request, url));
      }
      // A known path with an unsupported method is 405, not 404.
      if (pathKnown) {
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
  adminOptions,
  logger = createLogger(),
} = {}) {
  const collect = createCollectHandler({ config, services, logger });
  const clipboardLatest = createClipboardLatestHandler({
    config,
    services,
    now,
  });
  const logs = createLogsHandler({ config, services, logger });
  const stats = createStatsHandler({ config, services, logger });

  const defaultRoutes = routes ?? [
    { method: 'POST', path: '/api/v1/collect', auth: true, handler: collect },
    {
      method: 'GET',
      path: '/api/v1/clipboard/latest',
      auth: true,
      handler: clipboardLatest,
    },
    {
      method: 'GET',
      path: '/api/v1/logs',
      auth: true,
      allowAdmin: true,
      handler: logs,
    },
    {
      method: 'GET',
      path: '/api/v1/stats',
      auth: true,
      allowAdmin: true,
      handler: stats,
    },
  ];

  // Sweep expired clipboard entries and enforce log retention so neither
  // store relies on reads alone (§8.2). The timer must not keep the process
  // alive on its own.
  const purgeTimer = setInterval(() => {
    services.clipboardStore
      .purgeExpired()
      .catch((error) =>
        logger.error('clipboard.purge_failed', { error: String(error) }),
      );
    services.collectionLogStore
      .prune()
      .catch((error) =>
        logger.error('logs.prune_failed', { error: String(error) }),
      );
  }, config.clipboard?.maintenanceIntervalMs ?? 60 * 1000);
  purgeTimer.unref();

  const server = createHttpServer(
    createApp({
      config,
      routes: defaultRoutes,
      services,
      adminOptions,
      now,
    }),
  );
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = getConfig();
  if (!config.apiSecretToken) {
    console.warn(
      'API_SECRET_TOKEN is not configured; protected routes will fail closed.',
    );
  }
  if (!config.admin.passwordHash && !config.admin.password) {
    console.warn(
      'Admin credentials are not configured; /admin and management APIs will fail closed.',
    );
  } else if (config.admin.password && !config.admin.passwordHash) {
    console.warn(
      'ADMIN_PASSWORD is plaintext; prefer ADMIN_PASSWORD_HASH for production.',
    );
  }
  const server = createServer({ config });
  server.listen(config.port, () =>
    console.log(`Backend listening on http://localhost:${config.port}`),
  );
}
