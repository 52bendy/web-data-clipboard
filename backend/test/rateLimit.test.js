import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { rateLimit } from '../src/middleware/rateLimit.js';
import { getConfig } from '../src/config.js';

const config = (overrides = {}) => ({ ...getConfig({}), apiSecretToken: 'secret', enforceHttps: false, trustProxy: false, ...overrides });
async function withServer(options, run) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}
const handler = () => new Response('ok');
const route = (cfg, handlerFn = handler) => ({ method: 'GET', path: '/limited', handler: rateLimit({ config: cfg })(handlerFn) });
const send = (base, token = 'secret', headers = {}) => fetch(`${base}/limited`, { headers: { 'X-DCC-Token': token, ...headers } });
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('rate limit config defaults and validates overrides', () => {
  assert.equal(getConfig({}).rateLimitEnabled, true);
  assert.equal(getConfig({}).rateLimitPerMinute, 30);
  assert.equal(getConfig({}).rateLimitWindowSeconds, 60);
  assert.equal(getConfig({ RATE_LIMIT_ENABLED: 'false' }).rateLimitEnabled, false);
  assert.equal(getConfig({ RATE_LIMIT_PER_MINUTE: '2' }).rateLimitPerMinute, 2);
  assert.throws(() => getConfig({ RATE_LIMIT_ENABLED: 'maybe' }), /RATE_LIMIT_ENABLED/);
  assert.throws(() => getConfig({ RATE_LIMIT_PER_MINUTE: '0' }), /RATE_LIMIT_PER_MINUTE/);
  assert.throws(() => getConfig({ RATE_LIMIT_WINDOW_SECONDS: 'NaN' }), /RATE_LIMIT_WINDOW_SECONDS/);
});

test('default threshold allows 30 requests and returns the shared 429 envelope on 31', async () => {
  const cfg = config();
  await withServer({ config: cfg, routes: [route(cfg)] }, async (base) => {
    for (let i = 1; i <= 30; i += 1) assert.equal((await send(base)).status, 200);
    const response = await send(base);
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { code: 429, message: 'Too many requests.', data: null });
    assert.ok(Number(response.headers.get('retry-after')) >= 1);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });
});

test('token and IP counters are independently enforced over HTTP', async () => {
  const cfg = config({ rateLimitPerMinute: 2, trustProxy: true });
  await withServer({ config: cfg, routes: [route(cfg)] }, async (base) => {
    assert.equal((await send(base, 'token-a', { 'X-Forwarded-For': '192.0.2.1' })).status, 200);
    assert.equal((await send(base, 'token-b', { 'X-Forwarded-For': '192.0.2.1' })).status, 200);
    assert.equal((await send(base, 'token-a', { 'X-Forwarded-For': '192.0.2.2' })).status, 200);
    assert.equal((await send(base, 'token-a', { 'X-Forwarded-For': '192.0.2.3' })).status, 429);
    assert.equal((await send(base, 'token-c', { 'X-Forwarded-For': '192.0.2.1' })).status, 429);
  });
});

test('untrusted forwarded IP is ignored and trusted proxy uses first address', async () => {
  const untrusted = config({ rateLimitPerMinute: 1 });
  await withServer({ config: untrusted, routes: [route(untrusted)] }, async (base) => {
    assert.equal((await send(base, 'token-a', { 'X-Forwarded-For': '192.0.2.1' })).status, 200);
    assert.equal((await send(base, 'token-b', { 'X-Forwarded-For': '192.0.2.2' })).status, 429);
  });
  const trusted = config({ rateLimitPerMinute: 1, trustProxy: true });
  await withServer({ config: trusted, routes: [route(trusted)] }, async (base) => {
    assert.equal((await send(base, 'token-a', { 'X-Forwarded-For': '192.0.2.1, 10.0.0.1' })).status, 200);
    assert.equal((await send(base, 'token-b', { 'X-Forwarded-For': '192.0.2.2, 10.0.0.1' })).status, 200);
  });
});

test('configurable threshold, disabled mode, and fixed-window recovery work over HTTP', async () => {
  const cfg = config({ rateLimitPerMinute: 1, rateLimitWindowSeconds: 2 });
  await withServer({ config: cfg, routes: [route(cfg)] }, async (base) => {
    assert.equal((await send(base)).status, 200);
    const limited = await send(base);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    await sleep(2100);
    assert.equal((await send(base)).status, 200);
  });
  const disabled = config({ rateLimitEnabled: false, rateLimitPerMinute: 1 });
  await withServer({ config: disabled, routes: [route(disabled)] }, async (base) => {
    for (let i = 0; i < 3; i += 1) assert.equal((await send(base)).status, 200);
  });
});
