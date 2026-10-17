import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/services/storage/memory-storage.js';
import {
  createWebhookStore,
  WebhookConfigError,
} from '../src/services/webhook-store.js';
import { WebhookTargetError } from '../src/services/webhook-target.js';

const NOW = 1760000000000;
const resolveHost = async () => [{ address: '93.184.216.34', family: 4 }];

function makeStore(overrides = {}) {
  return createWebhookStore({
    storage: createMemoryStorage({ now: () => NOW }),
    now: () => NOW,
    resolveHost,
    ...overrides,
  });
}

test('creates a webhook with a generated secret and sensible defaults', async () => {
  const store = makeStore();
  const webhook = await store.create({ url: 'https://example.com/hook' });
  assert.match(webhook.webhook_id, /^wh_/);
  assert.equal(webhook.name, 'example.com');
  assert.equal(webhook.url, 'https://example.com/hook');
  assert.equal(webhook.enabled, true);
  assert.match(webhook.secret, /^whsec_[0-9a-f]{64}$/);
  assert.equal(webhook.created_at, new Date(NOW).toISOString());
  assert.deepEqual(await store.list(), [webhook]);
  assert.deepEqual(await store.get(webhook.webhook_id), webhook);
  assert.equal(await store.get('wh_missing'), null);
});

test('accepts name and disabled flag, and rejects invalid fields', async () => {
  const store = makeStore();
  const webhook = await store.create({
    url: 'https://example.com/hook',
    name: '  财务通知  ',
    enabled: false,
  });
  assert.equal(webhook.name, '财务通知');
  assert.equal(webhook.enabled, false);

  await assert.rejects(
    store.create({ url: 'https://example.com/hook', name: 'x'.repeat(101) }),
    (error) =>
      error instanceof WebhookConfigError && error.code === 'invalid_name',
  );
  await assert.rejects(
    store.create({ url: 'https://example.com/hook', enabled: 'yes' }),
    (error) =>
      error instanceof WebhookConfigError && error.code === 'invalid_enabled',
  );
  await assert.rejects(
    store.create({ url: 'https://example.com/hook', name: 42 }),
    WebhookConfigError,
  );
  await assert.rejects(
    store.create({ url: 'http://example.com/hook' }),
    WebhookTargetError,
  );
  await assert.rejects(store.create(null), WebhookConfigError);
});

test('updates name, enabled and rotates the secret', async () => {
  const store = makeStore();
  const webhook = await store.create({ url: 'https://example.com/hook' });
  const updated = await store.update(webhook.webhook_id, {
    name: 'Ops',
    enabled: false,
    rotate_secret: true,
  });
  assert.equal(updated.name, 'Ops');
  assert.equal(updated.enabled, false);
  assert.notEqual(updated.secret, webhook.secret);
  assert.equal(updated.created_at, webhook.created_at);
  assert.equal(updated.updated_at, new Date(NOW).toISOString());

  const newUrl = await store.update(webhook.webhook_id, {
    url: 'https://example.org/other',
  });
  assert.equal(newUrl.url, 'https://example.org/other');
  await assert.rejects(
    store.update(webhook.webhook_id, { url: 'https://127.0.0.1/hook' }),
    WebhookTargetError,
  );
});

test('returns not_found for unknown ids and enforces the config cap', async () => {
  const store = makeStore({ maxConfigs: 1 });
  await store.create({ url: 'https://one.example.com/hook' });
  await assert.rejects(
    store.create({ url: 'https://two.example.com/hook' }),
    (error) =>
      error instanceof WebhookConfigError && error.code === 'too_many_webhooks',
  );

  await assert.rejects(
    store.update('wh_missing', { enabled: false }),
    (error) =>
      error instanceof WebhookConfigError && error.code === 'not_found',
  );
  await assert.rejects(
    store.remove('wh_missing'),
    (error) =>
      error instanceof WebhookConfigError && error.code === 'not_found',
  );
  const [webhook] = await store.list();
  const removed = await store.remove(webhook.webhook_id);
  assert.equal(removed.webhook_id, webhook.webhook_id);
  assert.deepEqual(await store.list(), []);
});

test('persists configs through the shared storage adapter', async () => {
  const storage = createMemoryStorage({ now: () => NOW });
  const first = createWebhookStore({
    storage,
    now: () => NOW,
    resolveHost,
  });
  const webhook = await first.create({ url: 'https://example.com/hook' });
  const second = createWebhookStore({
    storage,
    now: () => NOW,
    resolveHost,
  });
  assert.deepEqual(await second.get(webhook.webhook_id), webhook);
});

test('records bounded delivery history with filters and newest-first order', async () => {
  const store = makeStore({ maxDeliveries: 3 });
  for (let index = 0; index < 5; index += 1) {
    await store.recordDelivery({
      delivery_id: `dlv_${index}`,
      webhook_id: index % 2 === 0 ? 'wh_a' : 'wh_b',
      status: index === 4 ? 'failed' : 'success',
      created_at: index,
    });
  }
  const all = await store.listDeliveries();
  assert.deepEqual(
    all.map((item) => item.delivery_id),
    ['dlv_4', 'dlv_3', 'dlv_2'],
  );
  const failed = await store.listDeliveries({ status: 'failed' });
  assert.equal(failed.length, 1);
  assert.equal(failed[0].delivery_id, 'dlv_4');
  const byWebhook = await store.listDeliveries({ webhookId: 'wh_a', limit: 2 });
  assert.deepEqual(
    byWebhook.map((item) => item.delivery_id),
    ['dlv_4', 'dlv_2'],
  );
  const limited = await store.listDeliveries({ limit: 1 });
  assert.deepEqual(
    limited.map((item) => item.delivery_id),
    ['dlv_4'],
  );
});
