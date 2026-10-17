import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { getConfig } from '../src/config.js';
import { createServices } from '../src/services/index.js';

const TOKEN = 'ttl-semantics-token';
const RAW_TEXT =
  '【中国移动】您的验证码是：839201，5分钟内有效。请勿泄漏给他人。';
const QUIET_LOGGER = { info() {}, warn() {}, error() {} };

function createClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
  };
}

function createHarness({ ttlMs = 1_800_000 } = {}) {
  const clock = createClock();
  const defaults = getConfig({});
  const config = {
    ...defaults,
    apiSecretToken: TOKEN,
    enforceHttps: false,
    trustProxy: false,
    rateLimitEnabled: false,
    clipboard: {
      ...defaults.clipboard,
      ttlMs,
      maintenanceIntervalMs: 3_600_000,
    },
    logs: {
      ...defaults.logs,
      maxEntries: 100,
      maxAgeMs: 24 * 60 * 60 * 1000,
    },
  };
  const services = createServices({ config, now: clock.now });
  return { clock, config, services };
}

async function withServer({ clock, config, services }, run) {
  const server = createServer({
    config,
    services,
    now: clock.now,
    logger: QUIET_LOGGER,
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

const getLatest = (base, headers = {}) =>
  fetch(`${base}/api/v1/clipboard/latest`, {
    headers: { 'X-DCC-Token': TOKEN, ...headers },
  });

const getLogs = (base) =>
  fetch(`${base}/api/v1/logs?page=1&page_size=20`, {
    headers: { 'X-DCC-Token': TOKEN },
  });

const getStats = (base) =>
  fetch(`${base}/api/v1/stats`, {
    headers: { 'X-DCC-Token': TOKEN },
  });

function collectPayload(now) {
  return {
    device_id: 'ttl-device-1',
    device_name: 'TTL 测试设备',
    platform: 'android',
    sender: '13800138000',
    raw_content: RAW_TEXT,
    timestamp: now,
  };
}

async function postCollect(base, payload) {
  return fetch(`${base}/api/v1/collect`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-DCC-Token': TOKEN,
    },
    body: JSON.stringify(payload),
  });
}

test('expiry boundary is inclusive: 200 before TTL, 404 exactly at TTL', async () => {
  const harness = createHarness({ ttlMs: 2_000 });
  const { clock, services } = harness;
  await services.clipboardStore.write({
    full_text: RAW_TEXT,
    parsed_code: '839201',
    data_type: 'verification_code',
    source: { device_name: 'TTL 测试设备', platform: 'android' },
  });

  await withServer(harness, async (base) => {
    const live = await getLatest(base);
    assert.equal(live.status, 200);
    assert.equal((await live.json()).data.expire_in_seconds, 2);
    const etag = live.headers.get('etag');
    assert.ok(etag);

    clock.advance(1_999);
    const lastValid = await getLatest(base);
    assert.equal(lastValid.status, 200);
    assert.equal((await lastValid.json()).data.expire_in_seconds, 1);

    clock.advance(1);
    const expired = await getLatest(base);
    assert.equal(expired.status, 404);
    assert.equal(expired.headers.get('cache-control'), 'no-store');
    assert.equal(expired.headers.get('etag'), null);

    const bodyText = await expired.text();
    assert.deepEqual(JSON.parse(bodyText), {
      code: 404,
      message: 'No clipboard data available.',
      data: null,
    });
    assert.ok(!bodyText.includes('839201'));
    assert.ok(!bodyText.includes(RAW_TEXT));

    // A persisted ETag from the expired record must not turn the read into a
    // 304: there is no current representation to validate.
    const staleConditional = await getLatest(base, {
      'If-None-Match': etag,
    });
    assert.equal(staleConditional.status, 404);
    assert.equal(staleConditional.headers.get('etag'), null);
  });
});

test('an expired read is indistinguishable from a never-written clipboard', async () => {
  const expiredHarness = createHarness({ ttlMs: 1_000 });
  await expiredHarness.services.clipboardStore.write({
    full_text: RAW_TEXT,
    parsed_code: '839201',
    data_type: 'verification_code',
  });
  expiredHarness.clock.advance(1_000);

  const emptyHarness = createHarness();
  let expiredBody;
  let emptyBody;

  await withServer(expiredHarness, async (base) => {
    const response = await getLatest(base);
    assert.equal(response.status, 404);
    expiredBody = await response.json();
  });
  await withServer(emptyHarness, async (base) => {
    const response = await getLatest(base);
    assert.equal(response.status, 404);
    emptyBody = await response.json();
  });

  assert.deepEqual(expiredBody, emptyBody);
});

test('clipboard TTL expiry deletes only the latest record; logs, stats and history remain', async () => {
  const harness = createHarness({ ttlMs: 1_000 });
  const { clock, services } = harness;
  let collectionId;

  await withServer(harness, async (base) => {
    const collected = await postCollect(base, collectPayload(clock.now()));
    assert.equal(collected.status, 200);
    const collectedBody = await collected.json();
    collectionId = collectedBody.data.collection_id;
    assert.equal(collectedBody.data.extracted_code, '839201');

    const latestBeforeExpiry = await services.clipboardStore.getLatest();
    assert.ok(latestBeforeExpiry);
    const latestId = latestBeforeExpiry.clipboard_id;

    clock.advance(1_000);
    assert.equal((await getLatest(base)).status, 404);

    // The public read endpoint never exposes history, but the admin log API
    // and statistics continue to see the accepted report after TTL expiry.
    const logs = await getLogs(base);
    assert.equal(logs.status, 200);
    const logsBody = await logs.json();
    assert.equal(logsBody.data.items.length, 1);
    assert.equal(logsBody.data.items[0].collection_id, collectionId);
    assert.equal(logsBody.data.items[0].raw_content, RAW_TEXT);
    assert.equal(logsBody.data.items[0].extracted_code, '839201');

    const stats = await getStats(base);
    assert.equal(stats.status, 200);
    const statsBody = await stats.json();
    assert.equal(statsBody.data.today_collected, 1);
    assert.equal(statsBody.data.today_extracted, 1);
    assert.equal(statsBody.data.bound_devices, 1);

    // The clipboard's internal append-only history has its own retention and
    // is not deleted by the latest-record TTL or the purge sweep.
    const historyBefore = await services.clipboardStore.getHistory();
    assert.equal(historyBefore.length, 1);
    assert.equal(historyBefore[0].clipboard_id, latestId);

    await services.clipboardStore.purgeExpired();

    const historyAfter = await services.clipboardStore.getHistory();
    assert.equal(historyAfter.length, 1);
    assert.equal(historyAfter[0].clipboard_id, latestId);
    assert.equal(await services.storage.get('clipboard:latest'), null);
    const rawLogs = await services.storage.get('collection:logs');
    assert.ok(Array.isArray(rawLogs));
    assert.equal(rawLogs.length, 1);
    assert.equal(rawLogs[0].raw_content, RAW_TEXT);
  });
});
