import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/services/storage/memory-storage.js';
import {
  ClipboardEntryError,
  DEFAULT_TTL_MS,
  MAX_FULL_TEXT_LENGTH,
  createClipboardStore,
} from '../src/services/clipboard-store.js';

function createClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
  };
}

function createHarness(overrides = {}) {
  const clock = createClock();
  const storage = createMemoryStorage({ now: clock.now });
  const store = createClipboardStore({ storage, now: clock.now, ...overrides });
  return { clock, storage, store };
}

test('write stores the §7.1 shape with server-assigned fields', async () => {
  const { clock, store } = createHarness();
  const record = await store.write({
    full_text: 'Your code is 123456',
    parsed_code: '123456',
    data_type: 'code',
    source: { device_name: 'pixel-7', platform: 'android' },
  });

  assert.match(record.clipboard_id, /^[0-9a-f-]{36}$/);
  assert.equal(record.data_type, 'code');
  assert.equal(record.parsed_code, '123456');
  assert.equal(record.full_text, 'Your code is 123456');
  assert.equal(record.updated_at, new Date(clock.now()).toISOString());
  assert.deepEqual(record.source, {
    device_name: 'pixel-7',
    platform: 'android',
  });
  assert.equal(record.seq, 1);
  assert.deepEqual(await store.getLatest(), record);
});

test('client-supplied timestamps and ids are ignored (defect 23)', async () => {
  const { clock, store } = createHarness();
  clock.advance(60_000);

  const record = await store.write({
    full_text: 'hello',
    clipboard_id: 'client-id',
    seq: 999,
    updated_at: '1999-01-01T00:00:00.000Z',
  });

  assert.notEqual(record.clipboard_id, 'client-id');
  assert.equal(record.seq, 1);
  assert.equal(record.updated_at, new Date(clock.now()).toISOString());
  assert.deepEqual(record.source, {
    device_name: 'unknown',
    platform: 'unknown',
  });
});

test('latest is the last accepted write by server order, not client time', async () => {
  const { store } = createHarness();
  await store.write({ full_text: 'first', updated_at: '2999-01-01T00:00:00Z' });
  await store.write({
    full_text: 'second',
    updated_at: '1999-01-01T00:00:00Z',
  });

  const latest = await store.getLatest();
  assert.equal(latest.full_text, 'second');
  assert.equal(latest.seq, 2);
});

test('concurrent writes leave no dirty data and all land in history', async () => {
  const { store } = createHarness();
  const inputs = Array.from({ length: 50 }, (_, i) => ({
    full_text: `text-${i}`,
    parsed_code: `code-${i}`,
    data_type: 'code',
    source: { device_name: `device-${i % 5}`, platform: 'android' },
  }));

  const results = await Promise.all(inputs.map((input) => store.write(input)));

  // every write got a distinct server sequence number, in call order
  assert.deepEqual(
    results.map((record) => record.seq),
    Array.from({ length: 50 }, (_, i) => i + 1),
  );

  // the latest record is exactly one of the submitted payloads (no torn data)
  const latest = await store.getLatest();
  assert.equal(latest.seq, 50);
  const index = Number(latest.full_text.split('-')[1]);
  assert.equal(latest.parsed_code, `code-${index}`);

  // history contains every write, paired correctly, in server order
  const history = await store.getHistory();
  assert.equal(history.length, 50);
  assert.deepEqual(
    history.map((entry) => entry.full_text),
    Array.from({ length: 50 }, (_, i) => `text-${i}`),
  );
  for (const entry of history) {
    const i = Number(entry.full_text.split('-')[1]);
    assert.equal(entry.parsed_code, `code-${i}`);
  }
  assert.equal(new Set(history.map((entry) => entry.clipboard_id)).size, 50);
});

test('TTL: reads return null exactly when the record expires', async () => {
  const { clock, store } = createHarness();
  await store.write({ full_text: 'expiring' });

  clock.advance(DEFAULT_TTL_MS - 1);
  assert.notEqual(await store.getLatest(), null);

  clock.advance(1);
  assert.equal(await store.getLatest(), null);
});

test('a configurable TTL is honoured and expiry starts a fresh clipboard', async () => {
  const { clock, store } = createHarness({ ttlMs: 1000 });
  await store.write({ full_text: 'a' });

  clock.advance(1000);
  assert.equal(await store.getLatest(), null);

  const record = await store.write({ full_text: 'b' });
  assert.equal(record.seq, 1);
});

test('history keeps only the configured number of entries', async () => {
  const { store } = createHarness({ historyMaxEntries: 3 });
  for (let i = 0; i < 5; i += 1) await store.write({ full_text: `t-${i}` });

  const history = await store.getHistory();
  assert.deepEqual(
    history.map((entry) => entry.full_text),
    ['t-2', 't-3', 't-4'],
  );
});

test('history drops entries older than the retention age', async () => {
  const { clock, store } = createHarness({ historyMaxAgeMs: 1000 });
  await store.write({ full_text: 'old' });

  clock.advance(1001);
  await store.write({ full_text: 'new' });

  const history = await store.getHistory();
  assert.deepEqual(
    history.map((entry) => entry.full_text),
    ['new'],
  );
});

test('getHistory({ limit }) returns the most recent entries', async () => {
  const { store } = createHarness();
  for (let i = 0; i < 4; i += 1) await store.write({ full_text: `h-${i}` });

  const history = await store.getHistory({ limit: 2 });
  assert.deepEqual(
    history.map((entry) => entry.full_text),
    ['h-2', 'h-3'],
  );
});

test('invalid entries are rejected with typed errors', async () => {
  const { store } = createHarness();
  const isCode = (code) => (error) =>
    error instanceof ClipboardEntryError && error.code === code;

  await assert.rejects(() => store.write(null), isCode('invalid_entry'));
  await assert.rejects(() => store.write({}), isCode('invalid_full_text'));
  await assert.rejects(
    () => store.write({ full_text: '' }),
    isCode('invalid_full_text'),
  );
  await assert.rejects(
    () => store.write({ full_text: 'x'.repeat(MAX_FULL_TEXT_LENGTH + 1) }),
    isCode('full_text_too_long'),
  );
  await assert.rejects(
    () => store.write({ full_text: 'x', parsed_code: 42 }),
    isCode('invalid_parsed_code'),
  );
  await assert.rejects(
    () => store.write({ full_text: 'x', data_type: '' }),
    isCode('invalid_data_type'),
  );
  await assert.rejects(
    () => store.write({ full_text: 'x', source: 'android' }),
    isCode('invalid_source'),
  );

  assert.equal(await store.getLatest(), null);
  assert.deepEqual(await store.getHistory(), []);

  const boundary = await store.write({
    full_text: 'x'.repeat(MAX_FULL_TEXT_LENGTH),
  });
  assert.equal(boundary.full_text.length, MAX_FULL_TEXT_LENGTH);
});

test('purgeExpired clears the expired clipboard and trims history', async () => {
  const { clock, store } = createHarness({
    ttlMs: 1000,
    historyMaxAgeMs: 1000,
  });
  await store.write({ full_text: 'first' });

  clock.advance(1001);
  assert.equal(await store.purgeExpired(), 1);
  assert.equal(await store.getLatest(), null);
  assert.deepEqual(await store.getHistory(), []);
});
