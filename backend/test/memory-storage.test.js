import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/services/storage/memory-storage.js';

function createClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
  };
}

test('set/get/delete round-trip returns defensive copies', async () => {
  const storage = createMemoryStorage();
  await storage.set('k', { a: 1 });

  const value = await storage.get('k');
  assert.deepEqual(value, { a: 1 });
  value.a = 2; // mutating the returned copy must not affect the store
  assert.deepEqual(await storage.get('k'), { a: 1 });

  await storage.delete('k');
  assert.equal(await storage.get('k'), null);
});

test('entries expire exactly at their TTL boundary', async () => {
  const clock = createClock();
  const storage = createMemoryStorage({ now: clock.now });
  await storage.set('k', 'v', { ttlMs: 1000 });

  clock.advance(999);
  assert.equal(await storage.get('k'), 'v');

  clock.advance(1);
  assert.equal(await storage.get('k'), null);
});

test('update serializes concurrent read-modify-write cycles', async () => {
  const storage = createMemoryStorage();
  const bump = async (current) => {
    // Force interleaving: without per-key serialization this loses updates.
    await Promise.resolve();
    return (current ?? 0) + 1;
  };

  await Promise.all(
    Array.from({ length: 100 }, () => storage.update('counter', bump)),
  );
  assert.equal(await storage.get('counter'), 100);
});

test('update sees expired values as absent and deletes on undefined', async () => {
  const clock = createClock();
  const storage = createMemoryStorage({ now: clock.now });
  await storage.set('k', 'v', { ttlMs: 100 });
  clock.advance(100);

  const seen = [];
  await storage.update('k', (current) => {
    seen.push(current);
    return undefined;
  });

  assert.deepEqual(seen, [null]);
  assert.equal(await storage.get('k'), null);
});

test('purgeExpired removes only expired entries and reports the count', async () => {
  const clock = createClock();
  const storage = createMemoryStorage({ now: clock.now });
  await storage.set('short', 1, { ttlMs: 100 });
  await storage.set('long', 2, { ttlMs: 10_000 });
  await storage.set('forever', 3);

  clock.advance(100);
  assert.equal(await storage.purgeExpired(), 1);
  assert.equal(await storage.get('short'), null);
  assert.equal(await storage.get('long'), 2);
  assert.equal(await storage.get('forever'), 3);
  assert.equal(await storage.purgeExpired(), 0);
});
