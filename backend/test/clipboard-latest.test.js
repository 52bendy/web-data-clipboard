import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { getConfig } from '../src/config.js';
import { createServices } from '../src/services/index.js';

const TOKEN = 'a-secret-token';
const RAW_TEXT =
  '【中国移动】您的验证码是：839201，5分钟内有效。请勿泄漏给他人。';

function createClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
  };
}

function baseConfig(overrides = {}) {
  const defaults = getConfig({});
  return {
    ...defaults,
    apiSecretToken: TOKEN,
    enforceHttps: false,
    trustProxy: false,
    rateLimitEnabled: false,
    ...overrides,
  };
}

function createHarness({ ttlMs = 1_800_000 } = {}) {
  const clock = createClock();
  const config = baseConfig({
    clipboard: {
      ...getConfig({}).clipboard,
      ttlMs,
      maintenanceIntervalMs: 3_600_000,
    },
  });
  const services = createServices({ config, now: clock.now });
  return { clock, config, services };
}

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

const get = (base, path = '/api/v1/clipboard/latest', headers = {}) =>
  fetch(`${base}${path}`, { headers: { 'X-DCC-Token': TOKEN, ...headers } });

async function seed(services, overrides = {}) {
  return services.clipboardStore.write({
    full_text: RAW_TEXT,
    parsed_code: '839201',
    data_type: 'verification_code',
    source: { device_name: '小米 13Pro', platform: 'android' },
    ...overrides,
  });
}

test('returns the exact PRD §4.1.2 contract with a numeric server updated_at', async () => {
  const { clock, config, services } = createHarness();
  const record = await seed(services);

  await withServer({ config, services, now: clock.now }, async (base) => {
    const response = await get(base);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await response.json(), {
      code: 200,
      data: {
        content: '839201',
        type: 'verification_code',
        raw_text: RAW_TEXT,
        source_device: '小米 13Pro',
        platform: 'android',
        updated_at: clock.now(),
        expire_in_seconds: 1800,
      },
    });
    assert.equal(
      response.headers.get('etag'),
      `"${clock.now()}-${record.clipboard_id}"`,
    );
    assert.equal(
      response.headers.get('last-modified'),
      new Date(clock.now()).toUTCString(),
    );
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});

test('text-only records fall back to raw_text for content', async () => {
  const { clock, config, services } = createHarness();
  await seed(services, {
    full_text: '今晚回家吃饭',
    parsed_code: null,
    data_type: 'text',
    source: { device_name: 'iPhone 15', platform: 'ios' },
  });

  await withServer({ config, services, now: clock.now }, async (base) => {
    const body = await (await get(base)).json();
    assert.equal(body.data.content, '今晚回家吃饭');
    assert.equal(body.data.type, 'text');
    assert.equal(body.data.source_device, 'iPhone 15');
    assert.equal(body.data.platform, 'ios');
  });
});

test('expire_in_seconds counts down and the record expires at TTL', async () => {
  const { clock, config, services } = createHarness({ ttlMs: 2_000 });
  await seed(services);

  await withServer({ config, services, now: clock.now }, async (base) => {
    assert.equal((await (await get(base)).json()).data.expire_in_seconds, 2);
    clock.advance(1_200);
    assert.equal((await (await get(base)).json()).data.expire_in_seconds, 1);
    clock.advance(800);
    const expired = await get(base);
    assert.equal(expired.status, 404);
    assert.deepEqual(await expired.json(), {
      code: 404,
      message: 'No clipboard data available.',
      data: null,
    });
  });
});

test('an expired clipboard never leaks history and a fresh write starts over', async () => {
  const { clock, config, services } = createHarness({ ttlMs: 1_000 });
  await seed(services, { full_text: 'old secret', parsed_code: '111111' });
  clock.advance(1_000);
  await seed(services, { full_text: 'new secret', parsed_code: '222222' });

  await withServer({ config, services, now: clock.now }, async (base) => {
    const body = await (await get(base)).json();
    assert.equal(body.data.content, '222222');
    assert.equal(body.data.raw_text, 'new secret');
  });
});

test('missing or wrong header tokens are 401; query-string tokens are always 400', async () => {
  const { clock, config, services } = createHarness();
  await seed(services);

  await withServer({ config, services, now: clock.now }, async (base) => {
    const missing = await fetch(`${base}/api/v1/clipboard/latest`);
    assert.equal(missing.status, 401);
    const wrong = await fetch(`${base}/api/v1/clipboard/latest`, {
      headers: { 'X-DCC-Token': 'wrong' },
    });
    assert.equal(wrong.status, 401);

    const queryOnly = await fetch(
      `${base}/api/v1/clipboard/latest?token=${TOKEN}`,
    );
    assert.equal(queryOnly.status, 400);
    assert.deepEqual(await queryOnly.json(), {
      code: 400,
      message:
        'Token must be sent in the X-DCC-Token header; query-string tokens are not supported.',
      data: null,
    });

    const queryWithHeader = await get(
      base,
      `/api/v1/clipboard/latest?token=${TOKEN}`,
    );
    assert.equal(queryWithHeader.status, 400);
    assert.deepEqual(await queryWithHeader.json(), {
      code: 400,
      message:
        'Token must be sent in the X-DCC-Token header; query-string tokens are not supported.',
      data: null,
    });
  });
});

test('empty clipboard returns the documented 404 envelope', async () => {
  const { clock, config, services } = createHarness();
  await withServer({ config, services, now: clock.now }, async (base) => {
    const response = await get(base);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      code: 404,
      message: 'No clipboard data available.',
      data: null,
    });
  });
});

test('conditional requests identify unchanged clipboard with 304', async () => {
  const { clock, config, services } = createHarness();
  await seed(services);
  const updatedAt = clock.now();

  await withServer({ config, services, now: clock.now }, async (base) => {
    const first = await get(base);
    const etag = first.headers.get('etag');

    const byEtag = await get(base, undefined, { 'If-None-Match': etag });
    assert.equal(byEtag.status, 304);
    assert.equal(await byEtag.text(), '');
    assert.equal(byEtag.headers.get('etag'), etag);

    const byRawUpdatedAt = await get(base, undefined, {
      'If-None-Match': String(updatedAt),
    });
    assert.equal(byRawUpdatedAt.status, 304);

    const byDate = await get(base, undefined, {
      'If-Modified-Since': new Date(updatedAt).toUTCString(),
    });
    assert.equal(byDate.status, 304);

    const staleDate = await get(base, undefined, {
      'If-Modified-Since': new Date(updatedAt - 60_000).toUTCString(),
    });
    assert.equal(staleDate.status, 200);

    const byQuery = await get(
      base,
      `/api/v1/clipboard/latest?updated_after=${updatedAt}`,
    );
    assert.equal(byQuery.status, 304);

    const olderThanRecord = await get(
      base,
      `/api/v1/clipboard/latest?updated_after=${updatedAt - 1}`,
    );
    assert.equal(olderThanRecord.status, 200);

    clock.advance(1_000);
    await seed(services, { full_text: 'newer', parsed_code: '654321' });
    const changed = await get(base, undefined, { 'If-None-Match': etag });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get('etag'), etag);
    assert.equal((await changed.json()).data.content, '654321');
  });
});

test('unsupported methods return the shared 405 envelope', async () => {
  const { clock, config, services } = createHarness();
  await withServer({ config, services, now: clock.now }, async (base) => {
    const response = await fetch(`${base}/api/v1/clipboard/latest`, {
      method: 'POST',
      headers: { 'X-DCC-Token': TOKEN },
    });
    assert.equal(response.status, 405);
    assert.deepEqual(await response.json(), {
      code: 405,
      message: 'Method not allowed.',
      data: null,
    });
  });
});
