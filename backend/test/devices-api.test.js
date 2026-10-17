import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { createServices } from '../src/services/index.js';

const nowEpoch = () => Date.now();
const config = {
  apiSecretToken: 'device-secret',
  enforceHttps: false,
  trustProxy: false,
  contentSecurityPolicy: "default-src 'self'",
  hstsMaxAge: 31536000,
  rateLimitEnabled: false,
  autoExtract: true,
  storage: { driver: 'memory' },
  clipboard: { ttlMs: 1800000, historyMaxEntries: 500, historyMaxAgeMs: 86400000, maintenanceIntervalMs: 60000 },
  collect: { maxRawContentLength: 4096, maxBodyBytes: 65536 },
  devices: { onlineThresholdMs: 1000 },
};

function validPayload(deviceId = 'device-1', deviceName = 'Test phone') {
  return {
    device_id: deviceId,
    device_name: deviceName,
    platform: 'android',
    sender: 'tester',
    raw_content: 'Your verification code is 123456',
    timestamp: nowEpoch(),
  };
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

test('devices endpoint requires auth and returns empty stats', async () => {
  await withServer({ config, services: createServices({ config }) }, async (base) => {
    const denied = await fetch(`${base}/api/v1/devices`);
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), {
      code: 401, message: 'Missing or invalid X-DCC-Token header.', data: null,
    });
    const wrongToken = await fetch(`${base}/api/v1/devices`, {
      headers: { 'X-DCC-Token': 'wrong' },
    });
    assert.equal(wrongToken.status, 401);
    const empty = await fetch(`${base}/api/v1/devices`, {
      headers: { 'X-DCC-Token': 'device-secret' },
    });
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), {
      code: 200,
      message: 'Devices retrieved successfully',
      data: {
        devices: [],
        stats: { total: 0, online: 0, offline: 0, online_threshold_ms: 1000 },
      },
    });
    assert.equal((await fetch(`${base}/api/v1/devices`, { method: 'POST' })).status, 405);
  });
});

test('collect registers and refreshes device, list reports online status', async () => {
  let now = Date.now();
  const services = createServices({ config, now: () => now });
  await withServer({ config, services }, async (base) => {
    const postCollect = (payload) => fetch(`${base}/api/v1/collect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-DCC-Token': 'device-secret' },
      body: JSON.stringify(payload),
    });
    assert.equal((await postCollect(validPayload())).status, 200);
    const first = await services.deviceRegistry.list({ onlineThresholdMs: 1000 });
    assert.equal(first.devices[0].device_id, 'device-1');
    const firstSeen = first.devices[0].first_seen;

    now += 500;
    assert.equal((await postCollect(validPayload('device-1', 'Renamed'))).status, 200);
    const listed = await fetch(`${base}/api/v1/devices`, {
      headers: { 'X-DCC-Token': 'device-secret' },
    });
    const body = await listed.json();
    assert.equal(body.data.devices[0].device_name, 'Renamed');
    assert.equal(body.data.devices[0].first_seen, firstSeen);
    assert.equal(body.data.stats.online_threshold_ms, 1000);
    assert.equal(body.data.devices[0].online, true);
    assert.equal(body.data.stats.online, 1);
    assert.equal(body.data.stats.offline, 0);

    now += 1001;
    const offline = await (await fetch(`${base}/api/v1/devices`, {
      headers: { 'X-DCC-Token': 'device-secret' },
    })).json();
    assert.equal(offline.data.devices[0].online, false);
    assert.equal(offline.data.stats.offline, 1);

    const rejected = await fetch(`${base}/api/v1/collect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-DCC-Token': 'device-secret' },
      body: JSON.stringify({ ...validPayload('bad-device'), platform: 'other' }),
    });
    assert.equal(rejected.status, 400);
    const unauthorized = await fetch(`${base}/api/v1/collect`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validPayload('unauthorized-device')),
    });
    assert.equal(unauthorized.status, 401);
    const queryToken = await fetch(`${base}/api/v1/devices?token=device-secret`);
    assert.equal(queryToken.status, 401);
    assert.equal((await services.deviceRegistry.list()).stats.total, 1);
  });
});

test('registry failures are logged without failing collection', async () => {
  const logs = [];
  const logger = {
    info() {}, warn() {}, error: (event, fields) => logs.push({ event, ...fields }),
  };
  const services = {
    clipboardStore: { write: async () => ({ clipboard_id: 'clip-1' }) },
    deviceRegistry: { touch: async () => { throw new Error('registry unavailable'); } },
  };
  await withServer({ config, services, logger }, async (base) => {
    const response = await fetch(`${base}/api/v1/collect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-DCC-Token': 'device-secret' },
      body: JSON.stringify(validPayload()),
    });
    assert.equal(response.status, 200);
    assert.equal(logs[0].event, 'device.register_failed');
  });
});
