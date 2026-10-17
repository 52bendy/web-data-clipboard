import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../src/services/storage/index.js';
import { createClipboardStore } from '../src/services/clipboard-store.js';

/**
 * Minimal adapter implementing only the documented storage contract. It proves
 * the business layer depends on the interface, not on the memory adapter.
 */
function createPlainMapStorage() {
  const map = new Map();
  return {
    async get(key) {
      return map.has(key) ? structuredClone(map.get(key)) : null;
    },
    async set(key, value) {
      map.set(key, structuredClone(value));
    },
    async delete(key) {
      map.delete(key);
    },
    async update(key, updater) {
      const current = map.has(key) ? structuredClone(map.get(key)) : null;
      const next = await updater(current);
      if (next === undefined) {
        map.delete(key);
        return null;
      }
      map.set(key, structuredClone(next));
      return structuredClone(next);
    },
    async purgeExpired() {
      return 0;
    },
  };
}

test('business layer runs unchanged on a different storage adapter', async () => {
  const store = createClipboardStore({ storage: createPlainMapStorage() });
  await store.write({
    full_text: 'portable',
    source: { device_name: 'device', platform: 'ios' },
  });

  const latest = await store.getLatest();
  assert.equal(latest.full_text, 'portable');
  assert.equal(latest.seq, 1);
  assert.equal((await store.getHistory()).length, 1);
});

test('createStorage returns a working memory adapter by default', async () => {
  const storage = createStorage();
  await storage.set('k', 1);
  assert.equal(await storage.get('k'), 1);
});

test('createStorage rejects unknown drivers', () => {
  assert.throws(
    () => createStorage({ type: 'redis' }),
    /Unsupported storage type: redis/,
  );
});
