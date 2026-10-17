import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceRegistry } from '../src/services/device-registry.js';
import { createMemoryStorage } from '../src/services/storage/index.js';

const device = (device_id) => ({ device_id, device_name: `Device ${device_id}`, platform: 'android' });

function makeRegistry(now = () => 1_800_000_000_000) {
  const storage = createMemoryStorage({ now });
  return { registry: createDeviceRegistry({ storage, now }), storage };
}

test('touch creates a device then preserves first_seen on refresh', async () => {
  let time = 1_800_000_000_000;
  const { registry } = makeRegistry(() => time);
  const created = await registry.touch(device('phone-a'));
  assert.equal(created.created, true);
  assert.equal(created.first_seen, new Date(time).toISOString());
  time += 5_000;
  const updated = await registry.touch({
    ...device('phone-a'),
    device_name: 'Renamed',
    platform: 'ios',
  });
  assert.equal(updated.created, false);
  assert.equal(updated.first_seen, created.first_seen);
  assert.equal(updated.device_name, 'Renamed');
  assert.equal(updated.platform, 'ios');
  assert.equal(updated.last_seen, new Date(time).toISOString());
});

test('concurrent touch calls preserve every device', async () => {
  const { registry } = makeRegistry();
  await Promise.all(Array.from({ length: 20 }, (_, index) =>
    registry.touch(device(`phone-${index}`)),
  ));
  const result = await registry.list();
  assert.equal(result.stats.total, 20);
});

test('list sorts deterministically and computes online stats including boundary', async () => {
  let time = 1_800_000_000_000;
  const { registry } = makeRegistry(() => time);
  await registry.touch(device('z-device'));
  time += 1_000;
  await registry.touch(device('a-device'));
  await registry.touch(device('b-device'));
  time += 86_400_000;
  const result = await registry.list({ onlineThresholdMs: 86_400_000 });
  assert.deepEqual(result.devices.map(({ device_id }) => device_id), ['a-device', 'b-device', 'z-device']);
  assert.deepEqual(result.stats, {
    total: 3, online: 2, offline: 1, online_threshold_ms: 86_400_000,
  });
  time += 1;
  const stale = await registry.list({ onlineThresholdMs: 86_400_000 });
  assert.equal(stale.stats.offline, 3);
  assert.equal(stale.devices[0].online, false);
});

test('empty registry returns empty devices and zero counts', async () => {
  const { registry } = makeRegistry();
  assert.deepEqual(await registry.list(), {
    devices: [],
    stats: { total: 0, online: 0, offline: 0, online_threshold_ms: 86_400_000 },
  });
});
