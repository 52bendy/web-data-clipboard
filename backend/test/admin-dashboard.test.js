import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { getConfig } from '../src/config.js';
import { createServices } from '../src/services/index.js';

const TOKEN = 'a-secret-token';
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'correct horse battery staple';
const silentLogger = { info() {}, warn() {}, error() {} };
const DAY = 24 * 60 * 60 * 1000;

function createClock(start = Date.UTC(2026, 9, 17, 12, 0, 0)) {
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
    admin: {
      ...defaults.admin,
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
      passwordHash: '',
    },
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
  const server = createServer({
    adminOptions: { logger: silentLogger },
    ...options,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function login(base) {
  const response = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
    }),
  });
  const cookie = (response.headers.get('set-cookie') || '').split(';')[0];
  return { response, cookie, body: await response.json() };
}

function logEntry(overrides = {}) {
  return {
    collection_id: 'col_1',
    device_id: 'android_mi13_001',
    device_name: '小米 13Pro',
    platform: 'android',
    sender: '13800138000',
    raw_content: '【中国移动】您的验证码是：839201，5分钟内有效。',
    extracted_code: '839201',
    data_type: 'verification_code',
    status: 'written',
    client_timestamp: null,
    ...overrides,
  };
}

async function seed(services, { text = true } = {}) {
  await services.collectionLogStore.append(logEntry());
  if (text) {
    await services.collectionLogStore.append(
      logEntry({
        collection_id: 'col_2',
        device_id: 'iphone_15',
        device_name: 'iPhone 15',
        platform: 'ios',
        sender: '95555',
        raw_content: '您的快递已到达菜鸟驿站',
        extracted_code: null,
        data_type: 'text',
      }),
    );
  }
  await services.clipboardStore.write({
    full_text: '【中国移动】您的验证码是：839201，5分钟内有效。',
    parsed_code: '839201',
    data_type: 'verification_code',
    source: { device_name: '小米 13Pro', platform: 'android' },
  });
}

test('dashboard API rejects anonymous requests with the admin envelope', async () => {
  const { config, services } = createHarness();
  await withServer({ config, services }, async (base) => {
    const response = await fetch(`${base}/api/admin/dashboard`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      code: 401,
      message: 'Admin authentication required.',
      data: null,
    });
  });
});

test('empty dashboard reports zero stats and an explicit empty clipboard state', async () => {
  const { config, services } = createHarness();
  await withServer({ config, services }, async (base) => {
    const { cookie } = await login(base);
    const response = await fetch(`${base}/api/admin/dashboard`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.code, 200);
    assert.equal(body.data.clipboard, null);
    assert.equal(body.data.clipboard_state, 'empty');
    assert.equal(body.data.clipboard_expired_at, null);
    assert.equal(body.data.stats.today_collected, 0);
    assert.equal(body.data.stats.today_extracted, 0);
    assert.equal(body.data.stats.bound_devices, 0);
  });
});

test('dashboard stats and clipboard match the public APIs field by field', async () => {
  const { clock, config, services } = createHarness();
  await seed(services);

  await withServer({ config, services, now: clock.now }, async (base) => {
    const { cookie } = await login(base);
    const dashboard = await (
      await fetch(`${base}/api/admin/dashboard`, { headers: { cookie } })
    ).json();
    // REQ-202610-1260: once admin credentials exist, management read APIs
    // authenticate with the admin session instead of X-DCC-Token.
    const stats = await (
      await fetch(`${base}/api/v1/stats`, { headers: { cookie } })
    ).json();
    const latest = await (
      await fetch(`${base}/api/v1/clipboard/latest`, {
        headers: { 'X-DCC-Token': TOKEN },
      })
    ).json();

    assert.equal(dashboard.data.clipboard_state, 'active');
    assert.deepEqual(dashboard.data.stats, stats.data);
    assert.deepEqual(dashboard.data.clipboard, latest.data);
    assert.equal(dashboard.data.stats.today_collected, 2);
    assert.equal(dashboard.data.stats.today_extracted, 1);
    assert.equal(dashboard.data.stats.bound_devices, 2);
    assert.equal(dashboard.data.clipboard.content, '839201');
    assert.equal(dashboard.data.clipboard.raw_text, logEntry().raw_content);
    assert.equal(dashboard.data.clipboard.source_device, '小米 13Pro');
    assert.equal(dashboard.data.clipboard.platform, 'android');
    assert.equal(typeof dashboard.data.clipboard.updated_at, 'number');
  });
});

test('expired clipboard is reported without leaking content', async () => {
  const { clock, config, services } = createHarness({ ttlMs: 1_000 });
  await seed(services);
  clock.advance(1_001);

  await withServer({ config, services, now: clock.now }, async (base) => {
    const { cookie } = await login(base);
    const response = await fetch(`${base}/api/admin/dashboard`, {
      headers: { cookie },
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.ok(!text.includes('839201'), 'expired content must not be returned');
    const body = JSON.parse(text);
    assert.equal(body.data.clipboard, null);
    assert.equal(body.data.clipboard_state, 'expired');
    assert.equal(
      body.data.clipboard_expired_at,
      Date.UTC(2026, 9, 17, 12, 0, 0) + 1_000,
    );

    const publicRead = await fetch(`${base}/api/v1/clipboard/latest`, {
      headers: { 'X-DCC-Token': TOKEN },
    });
    assert.equal(publicRead.status, 404);
  });
});

test('admin dashboard page and assets are served behind the session', async () => {
  const { config, services } = createHarness();
  await withServer({ config, services }, async (base) => {
    const anonymous = await fetch(`${base}/admin`, { redirect: 'manual' });
    assert.equal(anonymous.status, 302);

    const { cookie } = await login(base);
    const page = await fetch(`${base}/admin`, { headers: { cookie } });
    assert.equal(page.status, 200);
    const html = await page.text();
    for (const marker of [
      'id="stat-collected"',
      'id="stat-extracted"',
      'id="stat-devices"',
      'id="clipboard-content"',
      'id="copy-button"',
      'id="manual-refresh"',
      'id="clipboard-empty"',
      'id="clipboard-expired"',
      '/admin/dashboard.js',
    ]) {
      assert.ok(html.includes(marker), `missing ${marker}`);
    }

    const script = await fetch(`${base}/admin/dashboard.js`, {
      headers: { cookie },
    });
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
    assert.match(await script.text(), /navigator\.clipboard/);
  });
});

test('admin session can read stats without exposing the collection token', async () => {
  const { clock, config, services } = createHarness();
  await seed(services);

  await withServer({ config, services, now: clock.now }, async (base) => {
    const { cookie } = await login(base);
    const withCookie = await fetch(`${base}/api/v1/stats`, {
      headers: { cookie },
    });
    assert.equal(withCookie.status, 200);
    const body = await withCookie.json();
    assert.equal(body.data.today_collected, 2);

    // REQ-202610-1260: a valid collection token must not bypass the admin
    // session on management API prefixes.
    const withToken = await fetch(`${base}/api/v1/stats`, {
      headers: { 'X-DCC-Token': TOKEN },
    });
    assert.equal(withToken.status, 401);

    const anonymous = await fetch(`${base}/api/v1/stats`);
    assert.equal(anonymous.status, 401);
    assert.deepEqual(await anonymous.json(), {
      code: 401,
      message: 'Admin authentication required.',
      data: null,
    });
  });
});

test('dashboard stats use the same local day window as the stats API', async () => {
  const { clock, config, services } = createHarness();
  await services.collectionLogStore.append(
    logEntry({
      collection_id: 'col_yesterday',
      received_at: new Date(clock.now() - DAY).toISOString(),
    }),
  );
  await services.collectionLogStore.append(logEntry({ collection_id: 'col_today' }));

  await withServer({ config, services, now: clock.now }, async (base) => {
    const { cookie } = await login(base);
    const dashboard = await (
      await fetch(`${base}/api/admin/dashboard`, { headers: { cookie } })
    ).json();
    assert.equal(dashboard.data.stats.today_collected, 1);
    assert.equal(dashboard.data.stats.bound_devices, 1);
  });
});
