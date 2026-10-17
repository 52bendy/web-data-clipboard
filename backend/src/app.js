import { getConfig } from './config.js';
import { health } from '../api/v1/health.js';

export function createApp({ config = getConfig() } = {}) {
  void config;
  return async (request, response) => {
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
  };
}
