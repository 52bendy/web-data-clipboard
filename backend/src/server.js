import { createServer as createHttpServer } from 'node:http';
import { getConfig } from './config.js';
import { health } from '../api/v1/health.js';
import { createCollectHandler } from '../api/v1/collect.js';
import { createLogsHandler } from '../api/v1/logs.js';
import { createStatsHandler } from '../api/v1/stats.js';
import { createServices } from './services/index.js';
import { errorResponse } from './middleware/errors.js';
import { createLogger } from './utils/logger.js';

/**
 * Zero-dependency development server. Routes are registered here as their
 * requirements land; REQ-202610-1252 restructures this into the shared
 * app/route table, keeping route handlers unchanged.
 */
export function createServer({
  config = getConfig(),
  services = createServices({ config }),
  logger = createLogger(),
} = {}) {
  const collect = createCollectHandler({ config, services, logger });
  const logs = createLogsHandler({ config, services, logger });
  const stats = createStatsHandler({ config, services, logger });

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
  }, config.clipboard.maintenanceIntervalMs);
  purgeTimer.unref();

  return createHttpServer(async (request, response) => {
    const url = new URL(
      request.url,
      `http://${request.headers.host || 'localhost'}`,
    );
    try {
      if (url.pathname === '/api/v1/collect') {
        if (request.method !== 'POST') {
          return send(response, errorResponse(405));
        }
        return send(response, await collect(request));
      }
      if (url.pathname === '/api/v1/logs') {
        return send(response, await logs(request));
      }
      if (url.pathname === '/api/v1/stats') {
        return send(response, await stats(request));
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/health') {
        return send(response, health());
      }
      return send(response, errorResponse(404));
    } catch (error) {
      logger.error('request.failed', {
        path: url.pathname,
        error: String(error),
      });
      return send(response, errorResponse(500));
    }
  });
}

async function send(response, result) {
  response.writeHead(result.status, Object.fromEntries(result.headers));
  response.end(await result.text());
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  const config = getConfig();
  if (!config.apiSecretToken) {
    console.warn(
      'API_SECRET_TOKEN is not configured; collect/logs/stats will reject all requests (fail closed).',
    );
  }
  const server = createServer({ config });
  server.listen(config.port, () =>
    console.log(`Backend listening on http://localhost:${config.port}`),
  );
}
