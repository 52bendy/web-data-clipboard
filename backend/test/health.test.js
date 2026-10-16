import { test } from 'node:test';
import assert from 'node:assert/strict';
import { health } from '../api/v1/health.js';

test('health responds with an OK JSON payload', async () => {
  const response = health();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});
