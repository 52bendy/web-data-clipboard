import { createServer } from 'node:http';
import { getConfig } from './config.js';
import { health } from '../api/v1/health.js';
import { createServices } from './services/index.js';

const config = getConfig();
const { clipboardStore } = createServices({ config });

// Sweep expired clipboard entries so TTL cleanup does not rely on reads alone
// (§8.2). The timer must not keep the process alive on its own.
const purgeTimer = setInterval(() => {
  clipboardStore
    .purgeExpired()
    .catch((error) => console.error('clipboard purge failed:', error));
}, config.clipboard.maintenanceIntervalMs);
purgeTimer.unref();

const server = createServer(async (request, response) => {
  const url = new URL(
    request.url,
    `http://${request.headers.host || 'localhost'}`,
  );
  if (request.method === 'GET' && url.pathname === '/api/v1/health') {
    const result = health();
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(await result.text());
    return;
  }
  response.writeHead(404, {
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(config.port, () =>
  console.log(`Backend listening on http://localhost:${config.port}`),
);
