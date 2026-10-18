import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/services/storage/memory-storage.js';
import {
  ClipboardNamespaceError,
  DEFAULT_NAMESPACE,
  historyKey,
  latestKey,
  normalizeNamespace,
} from '../src/services/clipboard-namespace.js';
import { createClipboardStore } from '../src/services/clipboard-store.js';

function createClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
  };
}

function makeStore() {
  const clock = createClock();
  const storage = createMemoryStorage({ now: clock.now });
  const store = createClipboardStore({ storage, now: clock.now });
  return { clock, storage, store };
}

test('normalizes namespaces and rejects unsafe values', () => {
  assert.equal(normalizeNamespace(undefined), DEFAULT_NAMESPACE);
  assert.equal(normalizeNamespace(''), DEFAULT_NAMESPACE);
  assert.equal(normalizeNamespace('  '), DEFAULT_NAMESPACE);
  assert.equal(normalizeNamespace('project-a'), 'project-a');
  assert.equal(normalizeNamespace(' Team.Alpha_1 '), 'Team.Alpha_1');

  for (const value of [
    '../etc',
    'has space',
    '-leading-dash',
    'a/b',
    'x'.repeat(65),
    42,
  ]) {
    assert.throws(
      () => normalizeNamespace(value),
      ClipboardNamespaceError,
      String(value),
    );
  }
});

test('default namespace keeps the legacy storage keys', async () => {
  const { storage, store } = makeStore();
  await store.write({ full_text: 'legacy', data_type: 'text' });
  assert.equal(latestKey('default'), 'clipboard:latest');
  assert.equal(historyKey('default'), 'clipboard:history');
  assert.equal((await storage.get('clipboard:latest')).full_text, 'legacy');
  assert.equal((await storage.get('clipboard:history')).length, 1);
});

test('namespaces have independent latest records and histories', async () => {
  const { clock, store } = makeStore();
  await store.write(
    { full_text: 'sms message', data_type: 'text' },
    { namespace: 'default' },
  );
  clock.advance(1000);
  await store.write(
    { full_text: 'project a payload', data_type: 'text' },
    { namespace: 'project-a' },
  );
  clock.advance(1000);
  await store.write(
    { full_text: 'project b payload', data_type: 'text' },
    { namespace: 'project-b' },
  );
  clock.advance(1000);
  await store.write(
    { full_text: 'project a second', data_type: 'text' },
    { namespace: 'project-a' },
  );

  assert.equal((await store.getLatest()).full_text, 'sms message');
  assert.equal(
    (await store.getLatest('project-a')).full_text,
    'project a second',
  );
  assert.equal(
    (await store.getLatest('project-b')).full_text,
    'project b payload',
  );

  assert.deepEqual(
    (await store.getHistory({ namespace: 'project-a' })).map(
      (entry) => entry.full_text,
    ),
    ['project a payload', 'project a second'],
  );
  assert.equal((await store.getHistory({ namespace: 'default' })).length, 1);

  const namespaces = await store.listNamespaces();
  assert.deepEqual(
    namespaces.map((entry) => entry.namespace),
    ['default', 'project-a', 'project-b'],
  );
  assert.equal(
    namespaces.find((entry) => entry.namespace === 'project-a').writes,
    2,
  );
});

test('writes accept a namespace inside the input object', async () => {
  const { store } = makeStore();
  const record = await store.write({
    full_text: 'inline namespace',
    data_type: 'text',
    namespace: 'inline',
  });
  assert.equal(record.namespace, 'inline');
  assert.equal((await store.getLatest('inline')).full_text, 'inline namespace');
});

test('purgeExpired trims every namespace history', async () => {
  const { clock, store } = makeStore();
  await store.write(
    { full_text: 'old a', data_type: 'text' },
    { namespace: 'a' },
  );
  clock.advance(10_000);
  await store.write(
    { full_text: 'fresh b', data_type: 'text' },
    { namespace: 'b' },
  );
  await store.purgeExpired();
  assert.equal((await store.getHistory({ namespace: 'a' })).length, 1);
  assert.equal((await store.getHistory({ namespace: 'b' })).length, 1);
});
