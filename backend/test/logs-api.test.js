import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCollectHandler } from '../api/v1/collect.js';
import { createLogsHandler } from '../api/v1/logs.js';
import { createStatsHandler } from '../api/v1/stats.js';
import { createServer } from '../src/server.js';
import { createServices } from '../src/services/index.js';

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function makeConfig({
  maskSender = true,
  logs = {},
  token = 'test-token',
} = {}) {
  return {
    apiSecretToken: token,
    autoExtract: true,
    maskSender,
    storage: { driver: 'memory' },
    collect: { maxRawContentLength: 4096, maxBodyBytes: 64 * 1024 },
    clipboard: {
      ttlMs: 1800000,
      historyMaxEntries: 500,
      historyMaxAgeMs: DAY,
      maintenanceIntervalMs: 60000,
    },
    logs: { maxEntries: 1000, maxAgeMs: 7 * DAY, ...logs },
  };
}

function makeServices(config = makeConfig()) {
  return createServices({ config, now: () => NOW });
}

function makeRequest({
  method = 'GET',
  url = '/api/v1/logs',
  token = 'test-token',
} = {}) {
  const headers = {};
  if (token !== null) headers['x-dcc-token'] = token;
  return { method, url, headers };
}

function entry(overrides = {}) {
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
    client_timestamp: NOW - 1000,
    received_at: new Date(NOW).toISOString(),
    ...overrides,
  };
}

async function seed(services) {
  await services.collectionLogStore.append(entry({ collection_id: 'col_1' }));
  await services.collectionLogStore.append(
    entry({
      collection_id: 'col_2',
      device_id: 'iphone_15',
      device_name: 'iPhone 15',
      sender: '95555',
      raw_content: '您的快递已到达菜鸟驿站',
      extracted_code: null,
      data_type: 'text',
      received_at: new Date(NOW - 60 * 1000).toISOString(),
    }),
  );
  await services.collectionLogStore.append(
    entry({
      collection_id: 'col_3',
      sender: '+8613900139000',
      received_at: new Date(Date.UTC(2026, 9, 16, 9, 0)).toISOString(),
    }),
  );
}

test('logs API requires the X-DCC-Token header', async () => {
  const config = makeConfig();
  const services = makeServices(config);
  const handler = createLogsHandler({ config, services });
  for (const token of [null, '', 'wrong']) {
    const response = await handler(makeRequest({ token }));
    assert.equal(response.status, 401, `token=${token}`);
    assert.equal((await response.json()).code, 401);
  }
  const ok = await handler(makeRequest());
  assert.equal(ok.status, 200);
});

test('logs API rejects non-GET methods', async () => {
  const config = makeConfig();
  const handler = createLogsHandler({ config, services: makeServices(config) });
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const response = await handler(makeRequest({ method }));
    assert.equal(response.status, 405);
  }
});

test('logs API paginates newest first', async () => {
  const config = makeConfig();
  const services = makeServices(config);
  await seed(services);
  const handler = createLogsHandler({ config, services });

  const response = await handler(
    makeRequest({ url: '/api/v1/logs?page=1&page_size=2' }),
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.code, 200);
  assert.equal(payload.data.total, 3);
  assert.equal(payload.data.total_pages, 2);
  assert.equal(payload.data.page, 1);
  assert.equal(payload.data.page_size, 2);
  assert.equal(payload.data.items.length, 2);
  assert.deepEqual(
    payload.data.items.map((item) => item.collection_id),
    ['col_1', 'col_2'],
  );
});

test('logs API filters by device, date and keyword', async () => {
  const config = makeConfig();
  const services = makeServices(config);
  await seed(services);
  const handler = createLogsHandler({ config, services });

  const byDevice = await (
    await handler(makeRequest({ url: '/api/v1/logs?device=iphone' }))
  ).json();
  assert.deepEqual(
    byDevice.data.items.map((item) => item.collection_id),
    ['col_2'],
  );

  const byDeviceId = await (
    await handler(makeRequest({ url: '/api/v1/logs?device_id=iphone_15' }))
  ).json();
  assert.deepEqual(
    byDeviceId.data.items.map((item) => item.collection_id),
    ['col_2'],
  );

  const byDate = await (
    await handler(makeRequest({ url: '/api/v1/logs?date=2026-10-16' }))
  ).json();
  assert.deepEqual(
    byDate.data.items.map((item) => item.collection_id),
    ['col_3'],
  );

  const byKeyword = await (
    await handler(makeRequest({ url: '/api/v1/logs?keyword=快递' }))
  ).json();
  assert.deepEqual(
    byKeyword.data.items.map((item) => item.collection_id),
    ['col_2'],
  );

  const byRange = await (
    await handler(
      makeRequest({ url: '/api/v1/logs?from=2026-10-16&to=2026-10-17' }),
    )
  ).json();
  assert.equal(byRange.data.total, 3);
});

test('logs API rejects invalid query parameters with 400', async () => {
  const config = makeConfig();
  const handler = createLogsHandler({ config, services: makeServices(config) });
  const urls = [
    '/api/v1/logs?page=0',
    '/api/v1/logs?page=x',
    '/api/v1/logs?page_size=0',
    '/api/v1/logs?page_size=101',
    '/api/v1/logs?date=2026-02-30',
    '/api/v1/logs?date=2026-10-17&from=2026-10-16',
    '/api/v1/logs?from=2026-10-17&to=2026-10-16',
  ];
  for (const url of urls) {
    const response = await handler(makeRequest({ url }));
    assert.equal(response.status, 400, url);
    assert.equal((await response.json()).code, 400, url);
  }
});

test('sender masking is on by default and can be switched off', async () => {
  const maskedConfig = makeConfig();
  const maskedServices = makeServices(maskedConfig);
  await seed(maskedServices);
  const maskedHandler = createLogsHandler({
    config: maskedConfig,
    services: maskedServices,
  });
  const masked = await (await maskedHandler(makeRequest())).json();
  assert.equal(masked.data.masked, true);
  assert.deepEqual(
    masked.data.items.map((item) => item.sender),
    ['138****8000', '95555', '+86139****9000'],
  );

  const plainConfig = makeConfig({ maskSender: false });
  const plainServices = makeServices(plainConfig);
  await seed(plainServices);
  const plainHandler = createLogsHandler({
    config: plainConfig,
    services: plainServices,
  });
  const plain = await (await plainHandler(makeRequest())).json();
  assert.equal(plain.data.masked, false);
  assert.deepEqual(
    plain.data.items.map((item) => item.sender),
    ['13800138000', '95555', '+8613900139000'],
  );
});

test('mask query parameter overrides the server default per request', async () => {
  const config = makeConfig();
  const services = makeServices(config);
  await seed(services);
  const handler = createLogsHandler({ config, services });

  const raw = await (
    await handler(makeRequest({ url: '/api/v1/logs?mask=0' }))
  ).json();
  assert.equal(raw.data.masked, false);
  assert.equal(raw.data.items[0].sender, '13800138000');

  const plainConfig = makeConfig({ maskSender: false });
  const plainServices = makeServices(plainConfig);
  await seed(plainServices);
  const plainHandler = createLogsHandler({
    config: plainConfig,
    services: plainServices,
  });
  const masked = await (
    await plainHandler(makeRequest({ url: '/api/v1/logs?mask=1' }))
  ).json();
  assert.equal(masked.data.masked, true);
  assert.equal(masked.data.items[0].sender, '138****8000');

  const invalid = await handler(
    makeRequest({ url: '/api/v1/logs?mask=maybe' }),
  );
  assert.equal(invalid.status, 400);
});

test('stats API returns today counts and bound devices', async () => {
  const config = makeConfig();
  const services = makeServices(config);
  await seed(services);
  const handler = createStatsHandler({ config, services });

  const response = await handler(makeRequest({ url: '/api/v1/stats' }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.data, {
    date: '2026-10-17',
    today_collected: 2,
    today_extracted: 1,
    bound_devices: 2,
  });

  assert.equal((await handler(makeRequest({ token: null }))).status, 401);
  assert.equal((await handler(makeRequest({ method: 'POST' }))).status, 405);
});

test('collect writes a log entry used by the logs and stats APIs', async () => {
  const config = makeConfig();
  const services = makeServices(config);
  const collect = createCollectHandler({
    config,
    services,
    now: () => NOW,
    randomInt: () => 123456,
    dispatch: async () => ({ dispatched: 0 }),
  });
  const body = {
    device_id: 'android_mi13_001',
    device_name: '小米 13Pro',
    platform: 'android',
    sender: '13800138000',
    raw_content: '【中国移动】您的验证码是：839201，5分钟内有效。',
    timestamp: NOW - 1000,
  };
  const request = {
    method: 'POST',
    url: '/api/v1/collect',
    headers: { 'x-dcc-token': 'test-token' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body), 'utf8');
    },
  };
  const response = await collect(request);
  assert.equal(response.status, 200);

  const logs = await services.collectionLogStore.query();
  assert.equal(logs.total, 1);
  assert.equal(logs.items[0].collection_id, `col_${NOW}123456`);
  assert.equal(logs.items[0].sender, '13800138000');
  assert.equal(logs.items[0].extracted_code, '839201');
  assert.equal(logs.items[0].device_name, '小米 13Pro');

  const stats = await services.collectionLogStore.getStats();
  assert.equal(stats.today_collected, 1);
  assert.equal(stats.today_extracted, 1);
  assert.equal(stats.bound_devices, 1);
});

test('HTTP: collect -> logs/stats end to end through the dev server', async () => {
  const config = makeConfig();
  const services = createServices({ config });
  const quiet = { info() {}, warn() {}, error() {} };
  const server = createServer({ config, services, logger: quiet });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const collected = await fetch(`${base}/api/v1/collect`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dcc-token': 'test-token',
      },
      body: JSON.stringify({
        device_id: 'android_mi13_001',
        device_name: '小米 13Pro',
        platform: 'android',
        sender: '13800138000',
        raw_content: '【中国移动】您的验证码是：839201，5分钟内有效。',
        timestamp: Date.now() - 1000,
      }),
    });
    assert.equal(collected.status, 200);

    const logs = await fetch(`${base}/api/v1/logs`, {
      headers: { 'x-dcc-token': 'test-token' },
    });
    assert.equal(logs.status, 200);
    const logsPayload = await logs.json();
    assert.equal(logsPayload.data.total, 1);
    assert.equal(logsPayload.data.items[0].sender, '138****8000');

    const stats = await fetch(`${base}/api/v1/stats`, {
      headers: { 'x-dcc-token': 'test-token' },
    });
    assert.equal(stats.status, 200);
    const statsPayload = await stats.json();
    assert.equal(statsPayload.data.today_collected, 1);
    assert.equal(statsPayload.data.bound_devices, 1);

    const anonymous = await fetch(`${base}/api/v1/logs`);
    assert.equal(anonymous.status, 401);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
