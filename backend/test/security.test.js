import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';
import { createServer } from '../src/server.js';
import { errorResponse } from '../src/middleware/errors.js';

async function withServer(options, run) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const config = (overrides = {}) => ({
  apiSecretToken: 'a-secret-token',
  enforceHttps: false,
  trustProxy: false,
  contentSecurityPolicy: "default-src 'self'",
  hstsMaxAge: 31536000,
  ...overrides,
});

test('health stays public and receives security headers', async () => {
  await withServer({ config: config() }, async (base) => {
    const response = await fetch(`${base}/api/v1/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('content-security-policy'), "default-src 'self'");
  });
});

test('protected routes accept only a valid header token', async () => {
  const options = {
    config: config(),
    routes: [{ method: 'GET', path: '/private', auth: true, handler: () => new Response('{"ok":true}') }],
  };
  await withServer(options, async (base) => {
    const missing = await fetch(`${base}/private`);
    assert.equal(missing.status, 401);
    assert.deepEqual(await missing.json(), {
      code: 401, message: 'Missing or invalid X-DCC-Token header.', data: null,
    });

    const queryOnly = await fetch(`${base}/private?token=a-secret-token`);
    assert.equal(queryOnly.status, 400);

    for (const token of ['', 'wrong', 'x'.repeat(4097)]) {
      const response = await fetch(`${base}/private`, { headers: { 'X-DCC-Token': token } });
      assert.equal(response.status, 401);
    }
    const response = await fetch(`${base}/private`, { headers: { 'X-DCC-Token': 'a-secret-token' } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    const bearer = await fetch(`${base}/private`, {
      headers: { Authorization: 'Bearer a-secret-token' },
    });
    assert.equal(bearer.status, 200);
    assert.deepEqual(await bearer.json(), { ok: true });
  });
});

test('shared error responses cover the documented status codes', async () => {
  for (const status of [400, 401, 404, 429, 500]) {
    const response = errorResponse(status);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), {
      code: status,
      message: status === 401 ? 'Missing or invalid X-DCC-Token header.' : {
        400: 'Bad request.', 404: 'Not found.', 429: 'Too many requests.', 500: 'Internal server error.',
      }[status],
      data: null,
    });
  }
});

test('missing server token fails closed', async () => {
  await withServer({ config: config({ apiSecretToken: '' }), routes: [
    { method: 'GET', path: '/private', auth: true, handler: () => new Response('ok') },
  ] }, async (base) => {
    const response = await fetch(`${base}/private`, { headers: { 'X-DCC-Token': 'anything' } });
    assert.equal(response.status, 401);
  });
});

test('HTTPS enforcement honors forwarded protocol and override', async () => {
  await withServer({ config: config({ enforceHttps: true, trustProxy: true }) }, async (base) => {
    const direct = await fetch(`${base}/unknown`);
    assert.equal(direct.status, 403);
    assert.deepEqual(await direct.json(), { code: 403, message: 'HTTPS is required.', data: null });
    const secure = await fetch(`${base}/api/v1/health`, { headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(secure.status, 200);
    assert.equal(secure.headers.get('strict-transport-security'), 'max-age=31536000');
    const insecure = await fetch(`${base}/api/v1/health`, { headers: { 'x-forwarded-proto': 'http' } });
    assert.equal(insecure.status, 403);
  });
  await withServer({ config: config({ enforceHttps: false }) }, async (base) => {
    assert.equal((await fetch(`${base}/api/v1/health`)).status, 200);
  });
});

test('404 and thrown route errors use the shared envelope', async () => {
  await withServer({ config: config(), routes: [
    { method: 'GET', path: '/explode', handler: () => { throw new Error('secret'); } },
  ] }, async (base) => {
    for (const [path, status, message] of [
      ['/missing', 404, 'Not found.'],
      ['/explode', 500, 'Internal server error.'],
    ]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { code: status, message, data: null });
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }
  });
});

test('body stream failures return the shared 500 envelope', async () => {
  await withServer({ config: config(), routes: [
    {
      method: 'GET',
      path: '/broken-body',
      handler: () => new Response(new ReadableStream({
        start(controller) { controller.error(new Error('stream failed')); },
      })),
    },
  ] }, async (base) => {
    const response = await fetch(`${base}/broken-body`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      code: 500, message: 'Internal server error.', data: null,
    });
  });
});

test('health cannot be shadowed and route headers cannot weaken security headers', async () => {
  await withServer({ config: config(), routes: [
    { method: 'GET', path: '/api/v1/health', auth: true, handler: () => new Response('private') },
    { method: 'GET', path: '/custom', handler: () => new Response('ok', { headers: { 'x-frame-options': 'SAMEORIGIN' } }) },
  ] }, async (base) => {
    const healthResponse = await fetch(`${base}/api/v1/health`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), { status: 'ok' });
    const custom = await fetch(`${base}/custom`);
    assert.equal(custom.headers.get('x-frame-options'), 'DENY');
  });
});

test('untrusted forwarded protocol is ignored', async () => {
  await withServer({ config: config({ enforceHttps: true, trustProxy: false }) }, async (base) => {
    const response = await fetch(`${base}/api/v1/health`, { headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });
});

test('security headers are configurable', async () => {
  await withServer({ config: config({ contentSecurityPolicy: "default-src 'none'" }) }, async (base) => {
    const response = await fetch(`${base}/api/v1/health`);
    assert.equal(response.headers.get('content-security-policy'), "default-src 'none'");
  });
});
