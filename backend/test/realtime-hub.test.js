import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/services/storage/index.js';
import { createClipboardStore } from '../src/services/clipboard-store.js';
import {
  createRealtimeHub,
  formatClipboardEventId,
} from '../src/services/realtime-hub.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('publishes events to every subscriber and stops after unsubscribe', () => {
  const hub = createRealtimeHub({
    maxConnections: 5,
    heartbeatIntervalMs: 1_000,
  });
  const first = [];
  const second = [];
  const a = hub.subscribe({ onEvent: (event) => first.push(event) });
  const b = hub.subscribe({ onEvent: (event) => second.push(event) });

  assert.equal(hub.stats().active, 2);
  const event = {
    id: '1-clip',
    event: 'clipboard.updated',
    data: { content: '123456' },
  };
  assert.equal(hub.publish(event), 2);
  assert.deepEqual(first, [event]);
  assert.deepEqual(second, [event]);

  a.close();
  assert.equal(hub.stats().active, 1);
  hub.publish({ ...event, id: '2-clip' });
  assert.equal(first.length, 1);
  assert.equal(second.length, 2);

  b.close();
  hub.closeAll();
  assert.equal(hub.stats().active, 0);
});

test('rejects connections above the configured cap and counts them', () => {
  const hub = createRealtimeHub({
    maxConnections: 1,
    heartbeatIntervalMs: 1_000,
  });
  const first = hub.subscribe({});
  assert.ok(first);
  assert.equal(hub.subscribe({}), null);
  assert.equal(hub.stats().active, 1);
  assert.equal(hub.stats().rejected, 1);

  first.close();
  assert.equal(hub.stats().active, 0);
  const second = hub.subscribe({});
  assert.ok(second);
  second.close();
});

test('one shared timer emits heartbeat ticks and stops with the last client', async () => {
  const hub = createRealtimeHub({ heartbeatIntervalMs: 20 });
  let ticks = 0;
  const connection = hub.subscribe({
    onHeartbeat: () => {
      ticks += 1;
    },
  });

  await sleep(70);
  assert.ok(ticks >= 2, `expected at least 2 heartbeats, got ${ticks}`);
  connection.close();
  const afterClose = ticks;
  await sleep(50);
  assert.equal(ticks, afterClose);
});

test('connection TTL closes the subscriber with a ttl reason', async () => {
  const hub = createRealtimeHub({
    heartbeatIntervalMs: 1_000,
    connectionTtlMs: 20,
  });
  let reason = null;
  const connection = hub.subscribe({
    onClose: (value) => {
      reason = value;
    },
  });

  await sleep(60);
  assert.equal(reason, 'ttl');
  assert.equal(connection.active, false);
  assert.equal(hub.stats().active, 0);
});

test('formatClipboardEventId is stable and ignores malformed records', () => {
  const updatedAt = '2026-10-17T12:00:00.000Z';
  assert.equal(
    formatClipboardEventId({
      updated_at: updatedAt,
      clipboard_id: 'abc',
    }),
    `${Date.parse(updatedAt)}-abc`,
  );
  assert.equal(formatClipboardEventId(null), null);
  assert.equal(formatClipboardEventId({ clipboard_id: 'abc' }), null);
});

test('clipboard writes invoke onWrite only after the record is persisted', async () => {
  const storage = createMemoryStorage();
  const seen = [];
  const store = createClipboardStore({
    storage,
    onWrite: (record) => seen.push(record),
  });

  const record = await store.write({
    full_text: 'hello',
    parsed_code: null,
    data_type: 'text',
    source: { device_name: 'test', platform: 'android' },
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].clipboard_id, record.clipboard_id);
  assert.deepEqual(await store.getLatest(), record);
});

test('onWrite failures never reject an accepted clipboard write', async () => {
  const storage = createMemoryStorage();
  const errors = [];
  const store = createClipboardStore({
    storage,
    onWrite: () => {
      throw new Error('hook failed');
    },
    logger: { error: (event, fields) => errors.push({ event, fields }) },
  });

  const record = await store.write({ full_text: 'still saved' });
  assert.ok(record.clipboard_id);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].event, 'clipboard.write_hook_failed');
  assert.equal((await store.getLatest()).full_text, 'still saved');
});
