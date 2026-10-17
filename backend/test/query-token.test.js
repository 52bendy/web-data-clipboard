import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { getConfig } from '../src/config.js';
import { createServices } from '../src/services/index.js';
import {
  findQueryToken,
  rejectQueryToken,
  QUERY_TOKEN_MESSAGE,
} from '../src/middleware/queryToken.js';

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
    clipboard: {
      ...defaults.clipboard,
      maintenanceIntervalMs: 3_600_000,
    },
    ...overrides,
  };
}

function createHarness() {
  const clock = createClock();
  const config = baseConfig();
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

const seed = (services, overrides = {}) =>
  services.clipboardStore.write({
    full_text: RAW_TEXT,
    parsed_code: '839201',
    data_type: 'verification_code',
    source: { device_name: '小米 13Pro', platform: 'android' },
    ...overrides,
  });

const read = (base, path = '/api/v1/clipboard/latest', headers = {}) =>
  fetch(`${base}${path}`, { headers: { 'X-DCC-Token': TOKEN, ...headers } });

test('findQueryToken detects token-like names case-insensitively', () => {
  const rejected = [
    'token',
    'TOKEN',
    'Token',
    'access_token',
    'access-token',
    'accessToken',
    'api_key',
    'apikey',
    'apiKey',
    'auth_token',
    'authorization',
    'auth',
    'x-dcc-token',
    'x_dcc_token',
    'X-DCC-Token',
    'client_secret',
    'secret',
    'password',
    'jwt',
    'token[]',
  ];
  for (const name of rejected) {
    const url = new URL(
      `http://localhost/api/v1/clipboard/latest?${encodeURIComponent(name)}=x`,
    );
    assert.equal(findQueryToken(url), name, `expected ${name} to be rejected`);
  }

  // Percent-encoded parameter names are decoded by URLSearchParams first.
  assert.equal(
    findQueryToken(new URL('http://localhost/x?to%6ben=x')),
    'token',
  );

  for (const name of ['updated_after', 'device_id', 'mask', 'q', 'keyword']) {
    const url = new URL(`http://localhost/api/v1/clipboard/latest?${name}=x`);
    assert.equal(findQueryToken(url), null, `expected ${name} to be allowed`);
  }
});

test('rejectQueryToken returns the shared 400 envelope for credentials', async () => {
  assert.equal(rejectQueryToken(new URL('http://localhost/x')), null);

  const response = rejectQueryToken(
    new URL('http://localhost/x?access_token=secret'),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    code: 400,
    message: QUERY_TOKEN_MESSAGE,
    data: null,
  });
});

test('clipboard reads reject token-like query parameters before auth', async () => {
  const { clock, config, services } = createHarness();
  await seed(services);

  await withServer({ config, services, now: clock.now }, async (base) => {
    const names = [
      'token',
      'TOKEN',
      'access_token',
      'access-token',
      'accessToken',
      'api_key',
      'apikey',
      'auth_token',
      'authorization',
      'auth',
      'x-dcc-token',
      'client_secret',
      'secret',
      'password',
      'jwt',
    ];
    for (const name of names) {
      const response = await fetch(
        `${base}/api/v1/clipboard/latest?${encodeURIComponent(name)}=${TOKEN}`,
      );
      assert.equal(response.status, 400, name);
      assert.deepEqual(
        await response.json(),
        { code: 400, message: QUERY_TOKEN_MESSAGE, data: null },
        name,
      );
    }

    const encoded = await fetch(
      `${base}/api/v1/clipboard/latest?to%6ben=${TOKEN}`,
    );
    assert.equal(encoded.status, 400);

    const noValue = await fetch(`${base}/api/v1/clipboard/latest?token`);
    assert.equal(noValue.status, 400);

    // A valid header does not make a query token acceptable.
    const withHeader = await read(
      base,
      `/api/v1/clipboard/latest?token=${TOKEN}`,
    );
    assert.equal(withHeader.status, 400);
    assert.deepEqual(await withHeader.json(), {
      code: 400,
      message: QUERY_TOKEN_MESSAGE,
      data: null,
    });
  });
});

test('the query-token guard covers every route, not just clipboard reads', async () => {
  const { clock, config, services } = createHarness();

  await withServer({ config, services, now: clock.now }, async (base) => {
    const health = await fetch(`${base}/api/v1/health?token=${TOKEN}`);
    assert.equal(health.status, 400);
    assert.deepEqual(await health.json(), {
      code: 400,
      message: QUERY_TOKEN_MESSAGE,
      data: null,
    });

    const unknown = await fetch(`${base}/does-not-exist?access_token=${TOKEN}`);
    assert.equal(unknown.status, 400);
  });
});

test('updated_after polling is not mistaken for a credential', async () => {
  const { clock, config, services } = createHarness();
  const record = await seed(services);

  await withServer({ config, services, now: clock.now }, async (base) => {
    const response = await read(
      base,
      `/api/v1/clipboard/latest?updated_after=${record.updated_at}`,
    );
    assert.equal(response.status, 304);
    assert.equal(await response.text(), '');
  });
});

test('Authorization Bearer is a header alternative; query tokens still fail', async () => {
  const { clock, config, services } = createHarness();
  await seed(services);

  await withServer({ config, services, now: clock.now }, async (base) => {
    const bearer = await fetch(`${base}/api/v1/clipboard/latest`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(bearer.status, 200);

    const wrongBearer = await fetch(`${base}/api/v1/clipboard/latest`, {
      headers: { Authorization: 'Bearer wrong' },
    });
    assert.equal(wrongBearer.status, 401);

    const basic = await fetch(`${base}/api/v1/clipboard/latest`, {
      headers: { Authorization: `Basic ${TOKEN}` },
    });
    assert.equal(basic.status, 401);

    const queryWithBearer = await fetch(
      `${base}/api/v1/clipboard/latest?token=${TOKEN}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    assert.equal(queryWithBearer.status, 400);
  });
});
