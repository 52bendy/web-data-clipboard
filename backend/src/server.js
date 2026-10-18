import { createServer as createHttpServer } from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { getConfig } from './config.js';
import { health } from '../api/v1/health.js';
import { createClipboardLatestHandler } from '../api/v1/clipboard-latest.js';
import { createClipboardStreamHandler } from '../api/v1/clipboard-stream.js';
import { createClipboardWriteHandler } from '../api/v1/clipboard-write.js';
import { createCollectHandler } from '../api/v1/collect.js';
import { createLogsHandler } from '../api/v1/logs.js';
import { createStatsHandler } from '../api/v1/stats.js';
import { createDevicesHandler } from '../api/v1/devices.js';
import { createWebhookHandlers } from '../api/v1/webhooks.js';
import {
  createAdminDevicesHandler,
  createAdminSettingsHandlers,
} from '../api/admin/management.js';
import { createAdmin, isManagementApiPath } from './admin/index.js';
import { createDashboardApi } from './admin/dashboard-api.js';
import { createServices } from './services/index.js';
import { authorize } from './middleware/auth.js';
import { authenticateClipboardRequest } from './middleware/clipboard-auth.js';
import { errorResponse } from './middleware/errors.js';
import { isHttps } from './middleware/httpsEnforce.js';
import { rejectQueryToken } from './middleware/queryToken.js';
import { rateLimit } from './middleware/rateLimit.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { createLogger } from './utils/logger.js';

const WEBHOOK_ID_PATH = /^\/api\/v1\/webhooks\/[^/]+$/;
const WEBHOOK_TEST_PATH = /^\/api\/v1\/webhooks\/[^/]+\/test$/;

/**
 * Shared app factory (REQ-202610-1252): security headers → HTTPS enforcement
 * → admin pages/API → route table → shared 404/405/500 envelopes.
 *
 * Route precedence is deliberate: registered routes authenticate themselves
 * (X-DCC-Token) or through the admin session (`admin: true`). Management API
 * prefixes without a registered route still fail closed with 401 for
 * anonymous callers, so a future route cannot accidentally ship public.
 */
export function createApp({
  config = getConfig(),
  routes = [],
  logger = createLogger(),
  adminOptions,
} = {}) {
  const admin = createAdmin({ config, ...adminOptions });

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

      if (request.method === 'GET' && url.pathname === '/api/v1/health') {
        return await send(response, health());
      }

      const pathRoutes = routes.filter((item) => matches(item, url.pathname));
      const route = pathRoutes.find((item) => item.method === request.method);

      // Known path with an unsupported method gets 405 rather than 404/401.
      if (!route && pathRoutes.length > 0) {
        return await send(response, errorResponse(405));
      }

      if (route) {
        const managementApi = isManagementApiPath(url.pathname);
        const session =
          route.admin || managementApi ? admin.authenticate(request) : null;
        if (route.admin) {
          if (!session) return await send(response, admin.unauthorized());
          const csrfError = admin.checkCsrf(request, session);
          if (csrfError) return await send(response, csrfError);
        }
        // Header-only endpoints (e.g. the SSE feed) reject credential-like
        // query parameters before authentication so a leaked URL token gets a
        // loud 400 instead of a misleading 401 (defect 21).
        if (route.queryToken) {
          const queryTokenDenied = rejectQueryToken(url);
          if (queryTokenDenied) return await send(response, queryTokenDenied);
        }
        if (route.clipboardAuth) {
          // Clipboard routes accept the system token plus project-scoped
          // CLIPBOARD_TOKENS credentials (REQ-202610-1276).
          const auth = authenticateClipboardRequest(request, config);
          if (!auth.ok) return await send(response, auth.response);
        } else if (route.auth) {
          // Management APIs (devices / logs / stats / webhooks / settings)
          // move to the admin session once admin credentials are configured
          // (REQ-202610-1260). Before that they stay usable with X-DCC-Token
          // so deployments without a management UI keep working.
          if (managementApi && admin.enabled) {
            if (!session) return await send(response, admin.unauthorized());
          } else if (!session) {
            const denied = authorize(request, config.apiSecretToken);
            if (denied) return await send(response, denied);
          }
        }
        return await send(response, await route.handler(request, url));
      }

      // Known management prefixes without a route: reject anonymous callers
      // with 401 instead of leaking a 404.
      if (isManagementApiPath(url.pathname)) {
        if (!admin.authenticate(request)) {
          return await send(response, admin.unauthorized());
        }
        return await send(response, errorResponse(404));
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
  for (const [name, value] of result.headers) {
    if (!response.hasHeader(name)) response.setHeader(name, value);
  }
  // SSE responses must stay open and are streamed frame by frame. Every other
  // response is buffered first, so a body stream that fails before producing
  // output still reaches the shared 500 handler instead of aborting the socket.
  const contentType = result.headers.get('content-type') ?? '';
  if (!contentType.startsWith('text/event-stream')) {
    const body = await result.text();
    response.writeHead(result.status);
    response.end(body);
    return;
  }
  response.writeHead(result.status);
  if (!result.body) {
    response.end();
    return;
  }
  const stream = Readable.fromWeb(result.body);
  stream.on('error', () => {
    if (!response.writableEnded) response.destroy();
  });
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}

/** Registers every backend route that has landed so far. */
export function buildRoutes({ config, services, logger, now = Date.now }) {
  const collect = createCollectHandler({ config, services, logger });
  const logs = createLogsHandler({
    config,
    services,
    logger,
    requireToken: false,
  });
  const stats = createStatsHandler({
    config,
    services,
    logger,
    requireToken: false,
  });
  const devices = createDevicesHandler({
    deviceRegistry: services.deviceRegistry,
    config,
  });
  const webhooks = createWebhookHandlers({ config, services, logger, now });
  const adminDevices = createAdminDevicesHandler({ services, config });
  const settings = createAdminSettingsHandlers({ services, logger });
  // The dashboard aggregate needs both stores. Keep route registration
  // tolerant of partial service mocks (unit tests mount only what they use);
  // production always passes the full service container.
  const dashboard =
    services?.collectionLogStore && services?.clipboardStore
      ? createDashboardApi({ config, services, now })
      : null;
  const clipboardLatest = createClipboardLatestHandler({
    config,
    services,
    now,
  });
  const clipboardWrite = createClipboardWriteHandler({
    config,
    services,
    logger,
    now,
  });
  // Partial service mocks used by unit tests may not build the realtime hub;
  // only register the feed when the full service graph is present.
  const clipboardStream =
    services?.clipboardStore && services?.realtimeHub
      ? createClipboardStreamHandler({ config, services, now })
      : null;
  const routes = [
    {
      method: 'POST',
      path: '/api/v1/collect',
      auth: false,
      handler: rateLimit({ config })(collect),
    },
    {
      method: 'POST',
      path: '/api/v1/clipboard/write',
      clipboardAuth: true,
      queryToken: true,
      handler: clipboardWrite,
    },
    {
      method: 'GET',
      path: '/api/v1/clipboard/latest',
      clipboardAuth: true,
      handler: clipboardLatest,
    },
    ...(clipboardStream
      ? [
          {
            method: 'GET',
            path: '/api/v1/clipboard/stream',
            clipboardAuth: true,
            queryToken: true,
            handler: clipboardStream,
          },
        ]
      : []),
    { method: 'GET', path: '/api/v1/logs', auth: true, handler: logs },
    { method: 'GET', path: '/api/v1/stats', auth: true, handler: stats },
    { method: 'GET', path: '/api/v1/devices', auth: true, handler: devices },
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
    { method: 'GET', path: '/api/admin/devices', admin: true, handler: adminDevices },
    { method: 'GET', path: '/api/admin/logs', admin: true, handler: logs },
    { method: 'GET', path: '/api/admin/stats', admin: true, handler: stats },
    { method: 'GET', path: '/api/admin/settings', admin: true, handler: settings.get },
    { method: 'PATCH', path: '/api/admin/settings', admin: true, handler: settings.update },
    {
      method: 'POST',
      path: '/api/admin/token/reset',
      admin: true,
      handler: settings.resetToken,
    },
  ];
  if (dashboard) {
    const adminDevicesIndex = routes.findIndex(
      (route) => route.path === '/api/admin/devices',
    );
    routes.splice(adminDevicesIndex === -1 ? routes.length : adminDevicesIndex, 0, {
      method: 'GET',
      path: '/api/admin/dashboard',
      admin: true,
      handler: dashboard,
    });
  }
  return routes;
}

export function createServer({
  config = getConfig(),
  services = null,
  logger = createLogger(),
  routes = null,
  adminOptions,
  now = Date.now,
} = {}) {
  const appServices = services ?? createServices({ config, logger });
  const appRoutes =
    routes ?? buildRoutes({ config, services: appServices, logger, now });

  // Sweep expired clipboard entries and enforce log retention so neither
  // store relies on reads alone (§8.2). The timer must not keep the process
  // alive on its own.
  const purgeTimer = setInterval(() => {
    appServices.clipboardStore
      ?.purgeExpired()
      .catch((error) =>
        logger.error('clipboard.purge_failed', { error: String(error) }),
      );
    appServices.collectionLogStore
      ?.prune()
      .catch((error) =>
        logger.error('logs.prune_failed', { error: String(error) }),
      );
  }, config.clipboard?.maintenanceIntervalMs ?? 60000);
  purgeTimer.unref();

  const server = createHttpServer(
    createApp({
      config,
      routes: appRoutes,
      logger,
      adminOptions,
    }),
  );
  server.on('close', () => clearInterval(purgeTimer));
  return server;
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
  const services = createServices({ config });
  await services.settingsStore?.hydrate?.();
  const server = createServer({ config, services });
  server.listen(config.port, () =>
    console.log(`Backend listening on http://localhost:${config.port}`),
  );
}
