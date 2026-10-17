import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import vercelHandler from '../api/index.js';
import healthHandler from '../api/v1/health.js';

function mockResponse() {
  return {
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

async function request(handler, path) {
  const response = mockResponse();
  await handler({ method: 'GET', url: path, headers: { host: 'localhost' } }, response);
  return { ...response, json: JSON.parse(response.body) };
}

test('createApp responds to health and unknown paths', async () => {
  const handler = createApp();
  const health = await request(handler, '/api/v1/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { status: 'ok' });
  const missing = await request(handler, '/missing');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json, { error: 'not_found' });
});

test('health Vercel Function directly serves GET and rejects other methods', async () => {
  const health = await request(healthHandler, '/api/v1/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { status: 'ok' });

  const response = mockResponse();
  await healthHandler(
    { method: 'POST', url: '/ignored', headers: {} },
    response,
  );
  assert.equal(response.status, 405);
  assert.deepEqual(JSON.parse(response.body), { error: 'method_not_allowed' });
});

test('Vercel handler responds to health and unknown paths', async () => {
  const health = await request(vercelHandler, '/api/v1/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { status: 'ok' });
  const missing = await request(vercelHandler, '/missing');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json, { error: 'not_found' });
});
