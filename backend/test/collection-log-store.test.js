import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/services/storage/memory-storage.js';
import {
  CollectionLogError,
  createCollectionLogStore,
} from '../src/services/collection-log-store.js';

/** Fixed clock: 2026-10-17T12:00:00Z (server runs in UTC). */
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

function makeStore({ maxEntries, maxAgeMs, now = NOW } = {}) {
  let seq = 0;
  const store = createCollectionLogStore({
    storage: createMemoryStorage({ now: () => now }),
    maxEntries,
    maxAgeMs,
    now: () => now,
    idFactory: () => `log_${++seq}`,
  });
  return store;
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

test('appends a normalized log entry with server receive time', async () => {
  const store = makeStore();
  const record = await store.append(entry());
  assert.equal(record.log_id, 'log_1');
  assert.equal(record.collection_id, 'col_1');
  assert.equal(record.received_at, new Date(NOW).toISOString());

  const result = await store.query();
  assert.equal(result.total, 1);
  assert.deepEqual(result.items[0], record);
});

test('returns newest entries first with pagination metadata', async () => {
  const store = makeStore();
  for (let index = 0; index < 5; index += 1) {
    await store.append(
      entry({
        collection_id: `col_${index}`,
        received_at: new Date(NOW + index * 1000).toISOString(),
      }),
    );
  }
  const first = await store.query({ page: 1, pageSize: 2 });
  assert.equal(first.total, 5);
  assert.equal(first.total_pages, 3);
  assert.equal(first.page, 1);
  assert.equal(first.page_size, 2);
  assert.deepEqual(
    first.items.map((item) => item.collection_id),
    ['col_4', 'col_3'],
  );

  const last = await store.query({ page: 3, pageSize: 2 });
  assert.deepEqual(
    last.items.map((item) => item.collection_id),
    ['col_0'],
  );

  const beyond = await store.query({ page: 9, pageSize: 2 });
  assert.equal(beyond.items.length, 0);
});

test('filters by device id/name, keyword and date range', async () => {
  const store = makeStore();
  await store.append(
    entry({
      collection_id: 'col_a',
      device_id: 'android_mi13_001',
      device_name: '小米 13Pro',
      sender: '10086',
      raw_content: '验证码 111111',
      extracted_code: '111111',
      received_at: new Date(Date.UTC(2026, 9, 16, 23, 30)).toISOString(),
    }),
  );
  await store.append(
    entry({
      collection_id: 'col_b',
      device_id: 'iphone_15',
      device_name: 'iPhone 15',
      sender: '95555',
      raw_content: '您的快递已到达菜鸟驿站',
      extracted_code: null,
      data_type: 'text',
      received_at: new Date(Date.UTC(2026, 9, 17, 8, 0)).toISOString(),
    }),
  );
  await store.append(
    entry({
      collection_id: 'col_c',
      device_id: 'android_mi13_001',
      device_name: '小米 13Pro',
      sender: '13800138000',
      raw_content: '验证码 222222',
      extracted_code: '222222',
      received_at: new Date(Date.UTC(2026, 9, 17, 9, 0)).toISOString(),
    }),
  );

  const byDevice = await store.query({ device: 'iphone' });
  assert.deepEqual(
    byDevice.items.map((item) => item.collection_id),
    ['col_b'],
  );

  const byDeviceId = await store.query({ deviceId: 'iphone_15' });
  assert.deepEqual(
    byDeviceId.items.map((item) => item.collection_id),
    ['col_b'],
  );

  const byDeviceName = await store.query({ deviceName: '小米' });
  assert.deepEqual(
    byDeviceName.items.map((item) => item.collection_id),
    ['col_c', 'col_a'],
  );

  const byKeyword = await store.query({ keyword: '222222' });
  assert.deepEqual(
    byKeyword.items.map((item) => item.collection_id),
    ['col_c'],
  );

  const byDate = await store.query({ date: '2026-10-17' });
  assert.deepEqual(
    byDate.items.map((item) => item.collection_id),
    ['col_c', 'col_b'],
  );

  const range = await store.query({ from: '2026-10-16', to: '2026-10-16' });
  assert.deepEqual(
    range.items.map((item) => item.collection_id),
    ['col_a'],
  );
});

test('rejects invalid pagination and date filters', async () => {
  const store = makeStore();
  for (const query of [
    { page: 0 },
    { pageSize: 0 },
    { pageSize: 101 },
    { date: '2026-02-30' },
    { date: '17-10-2026' },
    { from: '2026-10-17', to: '2026-10-16' },
    { date: '2026-10-17', from: '2026-10-16' },
  ]) {
    await assert.rejects(store.query(query), CollectionLogError);
  }
});

test('concurrent appends all land in the log', async () => {
  const store = makeStore();
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.append(entry({ collection_id: `col_${index}` })),
    ),
  );
  const result = await store.query({ pageSize: 100 });
  assert.equal(result.total, 20);
  assert.equal(
    new Set(result.items.map((item) => item.collection_id)).size,
    20,
  );
});

test('enforces the entry-count retention limit', async () => {
  const store = makeStore({ maxEntries: 3 });
  for (let index = 0; index < 5; index += 1) {
    await store.append(
      entry({
        collection_id: `col_${index}`,
        received_at: new Date(NOW + index * 1000).toISOString(),
      }),
    );
  }
  const result = await store.query();
  assert.equal(result.total, 3);
  assert.deepEqual(
    result.items.map((item) => item.collection_id),
    ['col_4', 'col_3', 'col_2'],
  );
});

test('enforces the age retention limit on append, query and prune', async () => {
  const store = makeStore({ maxAgeMs: 24 * 60 * 60 * 1000 });
  await store.append(
    entry({
      collection_id: 'old',
      received_at: new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString(),
    }),
  );
  await store.append(entry({ collection_id: 'fresh' }));

  const result = await store.query();
  assert.deepEqual(
    result.items.map((item) => item.collection_id),
    ['fresh'],
  );

  await store.prune();
  const afterPrune = await store.query();
  assert.equal(afterPrune.total, 1);
});

test('computes today counts and bound devices from retained logs', async () => {
  const store = makeStore();
  await store.append(entry({ collection_id: 'col_1', device_id: 'device_a' }));
  await store.append(
    entry({
      collection_id: 'col_2',
      device_id: 'device_a',
      extracted_code: null,
      data_type: 'text',
    }),
  );
  await store.append(
    entry({
      collection_id: 'col_3',
      device_id: 'device_b',
      extracted_code: '999999',
    }),
  );
  await store.append(
    entry({
      collection_id: 'col_old',
      device_id: 'device_c',
      received_at: new Date(NOW - 24 * 60 * 60 * 1000).toISOString(),
    }),
  );

  const stats = await store.getStats();
  assert.deepEqual(stats, {
    date: '2026-10-17',
    today_collected: 3,
    today_extracted: 2,
    today_api_writes: 0,
    bound_devices: 3,
  });
});

test('validates required fields', async () => {
  const store = makeStore();
  for (const patch of [
    { collection_id: undefined },
    { device_id: '' },
    { device_name: 1 },
    { platform: null },
    { raw_content: '' },
    { extracted_code: 123 },
    { client_timestamp: -1 },
    { received_at: 'not-a-date' },
  ]) {
    await assert.rejects(store.append(entry(patch)), CollectionLogError);
  }
});
