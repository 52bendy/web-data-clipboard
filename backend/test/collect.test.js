import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCollectHandler } from '../api/v1/collect.js';
import { createServer } from '../src/server.js';
import { createServices } from '../src/services/index.js';
import { createDispatcher } from '../src/services/webhook-dispatcher.js';

/** Fixed server clock for deterministic collection ids. */
const NOW = 1728950400000;

function makeConfig({ collect = {}, clipboard = {} } = {}) {
  return {
    apiSecretToken: 'test-token',
    autoExtract: true,
    storage: { driver: 'memory' },
    collect: {
      maxRawContentLength: 4096,
      maxBodyBytes: 64 * 1024,
      ...collect,
    },
    clipboard: {
      ttlMs: 1800000,
      historyMaxEntries: 500,
      historyMaxAgeMs: 86400000,
      maintenanceIntervalMs: 60000,
      ...clipboard,
    },
  };
}

const validBody = () => ({
  device_id: 'android_mi13_001',
  device_name: '小米 13Pro',
  platform: 'android',
  sender: '+8610086',
  raw_content:
    '【中国移动】您的验证码是：839201，5分钟内有效。请勿泄漏给他人。',
  timestamp: NOW - 1000,
});

function makeTestLogger(logs) {
  const push = (level) => (event, fields) =>
    logs.push({ level, event, ...fields });
  return { info: push('info'), warn: push('warn'), error: push('error') };
}

/** Node-style fake request: plain headers + async-iterable body. */
function makeRequest({
  method = 'POST',
  token = 'test-token',
  headers = {},
  body = '',
} = {}) {
  const allHeaders = { ...headers };
  if (token !== null) allHeaders['x-dcc-token'] = token;
  return {
    method,
    headers: allHeaders,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body, 'utf8');
    },
  };
}

function makeHandler(overrides = {}) {
  const config = overrides.config ?? makeConfig();
  const services = overrides.services ?? createServices({ config });
  const logs = [];
  const logger = makeTestLogger(logs);
  const dispatcher = createDispatcher({ logger });
  const handler = createCollectHandler({
    config,
    services,
    logger,
    now: () => NOW,
    randomInt: () => 123456,
    dispatch: overrides.dispatch ?? dispatcher.dispatch.bind(dispatcher),
  });
  return { handler, services, logs, dispatcher };
}

function post(handler, body, options = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return handler(makeRequest({ body: raw, ...options }));
}

test('accepts a valid report and updates the clipboard (§4.1.1)', async () => {
  const { handler, services } = makeHandler();
  const response = await post(handler, validBody());

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    code: 200,
    message: 'Data collected successfully',
    data: {
      collection_id: `col_${NOW}123456`,
      extracted_code: '839201',
      clipboard_updated: true,
    },
  });

  const latest = await services.clipboardStore.getLatest();
  assert.equal(latest.parsed_code, '839201');
  assert.equal(latest.data_type, 'verification_code');
  assert.equal(latest.full_text, validBody().raw_content);
  // The device timestamp is kept as a reference only (defect 23).
  assert.equal(latest.client_timestamp, validBody().timestamp);
  assert.equal(latest.updated_at, latest.received_at);
  assert.ok(Number.isFinite(Date.parse(latest.received_at)));
  assert.deepEqual(latest.source, {
    device_name: '小米 13Pro',
    platform: 'android',
  });
});

test('stores raw text when no code is extracted', async () => {
  const { handler, services } = makeHandler();
  const body = {
    ...validBody(),
    raw_content: '您的快递已到达菜鸟驿站，请及时取件。',
  };
  const response = await post(handler, body);

  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.extracted_code, null);
  const latest = await services.clipboardStore.getLatest();
  assert.equal(latest.data_type, 'text');
  assert.equal(latest.parsed_code, null);
});

test('device clock skew never overrides server arrival order (defect 23)', async () => {
  const { handler, services } = makeHandler();
  const first = await post(handler, {
    ...validBody(),
    raw_content: '验证码 111111，5分钟内有效。',
    timestamp: NOW + 120_000,
  });
  const second = await post(handler, {
    ...validBody(),
    raw_content: '验证码 222222，5分钟内有效。',
    timestamp: NOW - 120_000,
  });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);

  const latest = await services.clipboardStore.getLatest();
  assert.equal(latest.parsed_code, '222222');
  assert.equal(latest.seq, 2);
  assert.equal(latest.client_timestamp, NOW - 120_000);
  assert.ok(Number.isFinite(Date.parse(latest.received_at)));

  const history = await services.clipboardStore.getHistory();
  assert.equal(history.length, 2);
  assert.equal(history[1].overwrote.clipboard_id, history[0].clipboard_id);
});

test('rejects a missing or invalid token with the shared 401 envelope', async () => {
  const { handler } = makeHandler();
  for (const token of [null, '', 'wrong-token']) {
    const response = await post(handler, validBody(), { token });
    assert.equal(response.status, 401);
    const payload = await response.json();
    assert.equal(payload.code, 401);
    assert.equal(payload.data, null);
    assert.equal(typeof payload.message, 'string');
  }
});

test('fails closed when the server token is not configured', async () => {
  const { handler } = makeHandler({ config: makeConfig() });
  const unconfigured = makeHandler({
    config: { ...makeConfig(), apiSecretToken: '' },
  });
  const response = await post(unconfigured.handler, validBody(), {
    token: 'anything',
  });
  assert.equal(response.status, 401);
  // sanity: the configured handler still accepts the same request shape
  assert.equal((await post(handler, validBody())).status, 200);
});

test('rejects a malformed JSON body', async () => {
  const { handler } = makeHandler();
  for (const raw of ['', '{"device_id":', 'not json', '{bad}']) {
    const response = await post(handler, raw);
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.code, 400);
    assert.equal(payload.data, null);
  }
});

test('rejects JSON that is not an object', async () => {
  const { handler } = makeHandler();
  for (const raw of ['[1,2]', '"text"', 'null', '42', 'true']) {
    const response = await post(handler, raw);
    assert.equal(response.status, 400);
  }
});

test('rejects invalid fields with a 400 envelope', async () => {
  const cases = [
    ['device_id missing', { device_id: undefined }],
    ['device_id empty', { device_id: '' }],
    ['device_id with spaces', { device_id: 'android mi13' }],
    ['device_id too long', { device_id: 'a'.repeat(129) }],
    ['device_name missing', { device_name: undefined }],
    ['device_name blank', { device_name: '   ' }],
    ['device_name too long', { device_name: 'x'.repeat(129) }],
    ['platform missing', { platform: undefined }],
    ['platform unknown', { platform: 'windows' }],
    ['platform wrong case', { platform: 'ANDROID' }],
    ['sender wrong type', { sender: 12345 }],
    ['sender too long', { sender: 'x'.repeat(65) }],
    ['raw_content missing', { raw_content: undefined }],
    ['raw_content empty', { raw_content: '' }],
    ['raw_content whitespace', { raw_content: '  \n ' }],
    ['raw_content too long', { raw_content: 'a'.repeat(4097) }],
    ['timestamp missing', { timestamp: undefined }],
    ['timestamp not a number', { timestamp: '2026-10-16' }],
    ['timestamp fractional', { timestamp: NOW - 0.5 }],
    ['timestamp before 2000', { timestamp: 946684799999 }],
    ['timestamp too far ahead', { timestamp: NOW + 24 * 60 * 60 * 1000 + 1 }],
  ];
  for (const [name, patch] of cases) {
    const { handler } = makeHandler();
    const response = await post(handler, { ...validBody(), ...patch });
    assert.equal(response.status, 400, name);
    const payload = await response.json();
    assert.equal(payload.code, 400, name);
    assert.equal(payload.data, null, name);
    assert.equal(typeof payload.message, 'string', name);
  }
});

test('accepts boundary values and ignores unknown fields', async () => {
  const { handler } = makeHandler();
  const boundary = {
    ...validBody(),
    raw_content: 'a'.repeat(4096),
    timestamp: NOW + 24 * 60 * 60 * 1000,
    extra_field: 'ignored',
  };
  assert.equal((await post(handler, boundary)).status, 200);

  const withoutSender = { ...validBody() };
  delete withoutSender.sender;
  assert.equal((await post(handler, withoutSender)).status, 200);
});

test('rejects oversized bodies with 413', async () => {
  const config = makeConfig({ collect: { maxBodyBytes: 1024 } });
  const { handler } = makeHandler({ config });
  const response = await post(handler, {
    ...validBody(),
    raw_content: 'a'.repeat(2048),
  });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, 413);
});

test('rejects non-POST methods with 405', async () => {
  const { handler } = makeHandler();
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const response = await handler(makeRequest({ method, body: '' }));
    assert.equal(response.status, 405);
    assert.equal((await response.json()).code, 405);
  }
});

test('dispatch runs asynchronously and never blocks the response', async () => {
  const calls = [];
  const { handler } = makeHandler({
    dispatch: (record, context) => {
      calls.push({ record, context });
      return new Promise(() => {}); // never settles: response must not wait
    },
  });
  const response = await post(handler, validBody());
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].context.collection_id, data.collection_id);
  assert.equal(calls[0].record.parsed_code, '839201');
});

test('dispatch failures do not fail the collection', async () => {
  const { handler, logs } = makeHandler({
    dispatch: () => Promise.reject(new Error('sink down')),
  });
  const response = await post(handler, validBody());
  assert.equal(response.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(
    logs.some((entry) => entry.event === 'collect.dispatch_failed'),
    'dispatch failure should be logged',
  );
});

test('logs the full chain keyed by collection id', async () => {
  const { handler, logs } = makeHandler();
  const response = await post(handler, validBody());
  const { data } = await response.json();

  const chain = logs.filter((entry) => entry.event.startsWith('collect.'));
  for (const event of [
    'collect.received',
    'collect.extracted',
    'collect.clipboard_updated',
    'collect.responded',
  ]) {
    assert.ok(
      chain.some((entry) => entry.event === event),
      `missing log event ${event}`,
    );
  }
  for (const entry of chain) {
    assert.equal(entry.collection_id, data.collection_id);
    assert.equal(entry.device_id, 'android_mi13_001');
  }
  assert.ok(
    logs.some((entry) => entry.event === 'dispatch.skipped'),
    'the dispatcher should log that no sinks are registered yet',
  );
});

test('rejected reports are logged without minting a collection id', async () => {
  const { handler, logs } = makeHandler();
  await post(handler, { ...validBody(), platform: 'windows' });
  await post(handler, 'not json');
  await post(handler, validBody(), { token: 'wrong' });
  const events = logs.map((entry) => entry.event);
  for (const event of [
    'collect.invalid_payload',
    'collect.invalid_json',
    'collect.unauthorized',
  ]) {
    assert.ok(events.includes(event), `missing log event ${event}`);
  }
  assert.ok(
    logs.every((entry) => entry.collection_id === undefined),
    'failed requests must not carry a collection id',
  );
});

test('concurrent reports all land in the clipboard history', async () => {
  const { handler, services } = makeHandler();
  const responses = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      post(handler, {
        ...validBody(),
        device_id: `device_${index}`,
        raw_content: `验证码 ${String(100000 + index)}，5分钟内有效。`,
      }),
    ),
  );
  for (const response of responses) {
    assert.equal(response.status, 200);
  }
  const history = await services.clipboardStore.getHistory();
  assert.equal(history.length, 5);
  assert.equal(history.at(-1).parsed_code, '100004');
});

test('HTTP: the dev server serves collect end to end', async () => {
  const quiet = { info() {}, warn() {}, error() {} };
  const server = createServer({ config: makeConfig(), logger: quiet });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const accepted = await fetch(`${base}/api/v1/collect`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dcc-token': 'test-token',
      },
      body: JSON.stringify(validBody()),
    });
    assert.equal(accepted.status, 200);
    const payload = await accepted.json();
    assert.equal(payload.code, 200);
    assert.equal(payload.data.extracted_code, '839201');
    assert.equal(payload.data.clipboard_updated, true);

    const unauthorized = await fetch(`${base}/api/v1/collect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody()),
    });
    assert.equal(unauthorized.status, 401);

    const wrongMethod = await fetch(`${base}/api/v1/collect`);
    assert.equal(wrongMethod.status, 405);

    const health = await fetch(`${base}/api/v1/health`);
    assert.equal(health.status, 200);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
