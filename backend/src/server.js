import { createServer as createHttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { getConfig } from './config.js';
import { health } from '../api/v1/health.js';
import { authorize } from './middleware/auth.js';
import { errorResponse } from './middleware/errors.js';
import { isHttps } from './middleware/httpsEnforce.js';
import { securityHeaders } from './middleware/securityHeaders.js';

export function createApp({ config = getConfig(), routes } = {}) {
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
      if (request.method === 'GET' && url.pathname === '/api/v1/health') {
        return await send(response, health());
      }
      const route = routes?.find((item) => item.method === request.method && item.path === url.pathname);
      if (route) {
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
  const server = createServer({ config });
  server.listen(config.port, () =>
    console.log(`Backend listening on http://localhost:${config.port}`),
  );
}
