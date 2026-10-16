import { createServer } from 'node:http';
import { getConfig } from './config.js';
import { health } from '../api/v1/health.js';

const { port } = getConfig();

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

server.listen(port, () =>
  console.log(`Backend listening on http://localhost:${port}`),
);
