import { createServer as createHttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { getConfig } from './config.js';
import { health } from '../api/v1/health.js';
import { createAdmin, isManagementApiPath } from './admin/index.js';
import { authorize } from './middleware/auth.js';
import { errorResponse } from './middleware/errors.js';
import { isHttps } from './middleware/httpsEnforce.js';
import { securityHeaders } from './middleware/securityHeaders.js';

export function createApp({ config = getConfig(), routes, adminOptions } = {}) {
  const admin = createAdmin({ config, ...adminOptions });
  return async (request, response) => {
    try {
      const https = isHttps(request, config.trustProxy === true);
      for (const [name, value] of Object.entries(securityHeaders(config, https))) {
        response.setHeader(name, value);
      }
      if (config.enforceHttps && !https) {
        return await send(response, errorResponse(403));
      }
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

      // Admin pages, login/logout and /api/admin/* live outside the API route
      // table so every future admin asset is covered by one guard.
      const adminResponse = await admin.handle(request, url, { https });
      if (adminResponse) return await send(response, adminResponse);

      // Management APIs (devices / webhooks / logs / stats / settings) are
      // admin-only by prefix even before their routes land: anonymous requests
      // get 401 rather than 404, and a future route cannot accidentally ship
      // without the guard.
      const managementApi = isManagementApiPath(url.pathname);
      if (managementApi && !admin.authenticate(request)) {
        return await send(response, admin.unauthorized());
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/health') {
        return await send(response, health());
      }
      const route = routes?.find((item) => item.method === request.method && item.path === url.pathname);
      if (route) {
        if (route.admin && !managementApi && !admin.authenticate(request)) {
          return await send(response, admin.unauthorized());
        }
        if (route.auth) {
          const denied = authorize(request, config.apiSecretToken);
          if (denied) return await send(response, denied);
        }
        return await send(response, await route.handler(request, url));
      }
      return await send(response, errorResponse(404));
    } catch {
      return send(response, errorResponse(500));
    }
  };
}

async function send(response, result) {
  const body = await result.text();
  for (const [name, value] of result.headers) {
    if (!response.hasHeader(name)) response.setHeader(name, value);
  }
  response.writeHead(result.status);
  response.end(body);
}

export function createServer(options) {
  return createHttpServer(createApp(options));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = getConfig();
  if (!config.apiSecretToken) console.warn('API_SECRET_TOKEN is not configured; protected routes will fail closed.');
  if (!config.admin.passwordHash && !config.admin.password) {
    console.warn('Admin credentials are not configured; /admin and management APIs will fail closed.');
  } else if (config.admin.password && !config.admin.passwordHash) {
    console.warn('ADMIN_PASSWORD is plaintext; prefer ADMIN_PASSWORD_HASH for production.');
  }
  const server = createServer({ config });
  server.listen(config.port, () =>
    console.log(`Backend listening on http://localhost:${config.port}`),
  );
}
