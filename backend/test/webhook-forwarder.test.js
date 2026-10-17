import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createMemoryStorage } from '../src/services/storage/memory-storage.js';
import { createWebhookStore } from '../src/services/webhook-store.js';
import {
  buildWebhookPayload,
  createWebhookForwarder,
  formatWebhookMessage,
  signWebhookPayload,
} from '../src/services/webhook-forwarder.js';
import { WebhookTargetError } from '../src/services/webhook-target.js';

const NOW = 1760000000000;
const resolveHost = async () => [{ address: '93.184.216.34', family: 4 }];
const validateTarget = async (value) => new URL(value);

const record = {
  clipboard_id: 'clip_1',
  data_type: 'verification_code',
  parsed_code: '839201',
  full_text: '【中国移动】您的验证码是：839201，5分钟内有效。',
  updated_at: '2026-10-17T02:00:00.000Z',
  source: { device_name: '小米 13Pro', platform: 'android' },
};
const context = {
  collection_id: 'col_123',
  device_id: 'android_mi13_001',
  sender: '+8610086',
};

function makeLogger() {
  const entries = [];
  const push = (level) => (event, fields) =>
    entries.push({ level, event, ...fields });
  return {
    entries,
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  };
}

async function setup({ config = {}, send, sleep = async () => {} } = {}) {
  const store = createWebhookStore({
    storage: createMemoryStorage({ now: () => NOW }),
    now: () => NOW,
    resolveHost,
  });
  const webhook = await store.create({
    url: 'https://example.com/hook',
    name: 'Test hook',
  });
  const logger = makeLogger();
  const calls = [];
  const fakeSend =
    send ??
    (async (target, request) => {
      calls.push({ target: target.toString(), ...request });
      return { status: 200, body: 'ok' };
    });
  const forwarder = createWebhookForwarder({
    config: {
      webhook: {
        timeoutMs: 1000,
        maxAttempts: 3,
        retryBaseDelayMs: 100,
        ...config,
      },
    },
    webhookStore: store,
    logger,
    now: () => NOW,
    send: fakeSend,
    sleep,
    validateTarget,
    randomId: () => 'fixed-id',
  });
  return { store, webhook, logger, calls, forwarder };
}

test('formats the §7.2.2 message template with code and device', () => {
  const message = formatWebhookMessage(record);
  assert.match(message, /📱 收到新验证码/);
  assert.match(message, /-------------------/);
  assert.match(message, /验证码：839201/);
  assert.match(message, /来源设备：小米 13Pro/);
  assert.match(message, /原始短信：/);
  assert.ok(message.includes('\n\n\n原始短信：'));

  const payload = buildWebhookPayload(record, context, {
    deliveryId: 'dlv_x',
    nowMs: NOW,
  });
  assert.equal(payload.event, 'clipboard.updated');
  assert.equal(payload.delivery_id, 'dlv_x');
  assert.equal(payload.collection_id, 'col_123');
  assert.equal(payload.sender, '+8610086');
  assert.equal(payload.data.parsed_code, '839201');
  assert.equal(payload.data.source.device_name, '小米 13Pro');
  assert.equal(payload.message, message);
});

test('signs the timestamp and exact body with HMAC-SHA256', () => {
  const body = '{"hello":"世界"}';
  const signature = signWebhookPayload('whsec_secret', '1760000000', body);
  const expected = createHmac('sha256', 'whsec_secret')
    .update(`1760000000.${body}`)
    .digest('hex');
  assert.equal(signature, `sha256=${expected}`);
});

test('delivers a signed payload and records success', async () => {
  const { store, webhook, calls, forwarder } = await setup();
  const delivery = await forwarder.deliverOne(webhook, record, context);

  assert.equal(delivery.status, 'success');
  assert.equal(delivery.attempts, 1);
  assert.equal(delivery.http_status, 200);
  assert.equal(calls.length, 1);

  const sent = calls[0];
  assert.equal(sent.target, 'https://example.com/hook');
  assert.equal(sent.headers['x-dcc-event'], 'clipboard.updated');
  assert.equal(sent.headers['x-dcc-delivery-id'], 'dlv_fixed-id');
  assert.equal(sent.headers['x-dcc-timestamp'], '1760000000');
  const expectedSignature = createHmac('sha256', webhook.secret)
    .update(`1760000000.${sent.body}`)
    .digest('hex');
  assert.equal(sent.headers['x-dcc-signature'], `sha256=${expectedSignature}`);

  const payload = JSON.parse(sent.body);
  assert.equal(payload.data.parsed_code, '839201');
  assert.equal(payload.sender, '+8610086');
  assert.match(payload.message, /原始短信：/);

  const [stored] = await store.listDeliveries();
  assert.equal(stored.delivery_id, delivery.delivery_id);
  assert.equal(stored.status, 'success');
  assert.equal(stored.response_excerpt, 'ok');
});

test('retries with exponential backoff until a 2xx response', async () => {
  const responses = [500, 502, 200];
  const calls = [];
  const delays = [];
  const { forwarder, webhook, store } = await setup({
    send: async (target, request) => {
      calls.push(request);
      return { status: responses[calls.length - 1], body: 'nope' };
    },
    sleep: async (milliseconds) => delays.push(milliseconds),
  });

  const delivery = await forwarder.deliverOne(webhook, record, context);
  assert.equal(delivery.status, 'success');
  assert.equal(delivery.attempts, 3);
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [100, 200]);
  const [stored] = await store.listDeliveries();
  assert.equal(stored.attempts, 3);
});

test('records a failed delivery after exhausting retries', async () => {
  const calls = [];
  const { forwarder, webhook, store, logger } = await setup({
    send: async (target, request) => {
      calls.push(request);
      return { status: 503, body: 'unavailable' };
    },
  });

  const delivery = await forwarder.deliverOne(webhook, record, context);
  assert.equal(delivery.status, 'failed');
  assert.equal(delivery.attempts, 3);
  assert.equal(delivery.http_status, 503);
  assert.match(delivery.error, /HTTP 503/);
  assert.equal(calls.length, 3);
  const [stored] = await store.listDeliveries();
  assert.equal(stored.status, 'failed');
  assert.ok(
    logger.entries.some((entry) => entry.event === 'webhook.delivery.failed'),
  );
});

test('retries transport errors and records the final error', async () => {
  let attempts = 0;
  const { forwarder, webhook, store } = await setup({
    send: async () => {
      attempts += 1;
      throw new Error('webhook request timed out');
    },
  });
  const delivery = await forwarder.deliverOne(webhook, record, context);
  assert.equal(attempts, 3);
  assert.equal(delivery.status, 'failed');
  assert.match(delivery.error, /timed out/);
  const [stored] = await store.listDeliveries();
  assert.equal(stored.http_status, null);
});

test('blocks a target that fails revalidation and never sends', async () => {
  const calls = [];
  const store = createWebhookStore({
    storage: createMemoryStorage({ now: () => NOW }),
    now: () => NOW,
    resolveHost,
  });
  const webhook = await store.create({ url: 'https://example.com/hook' });
  const forwarder = createWebhookForwarder({
    config: { webhook: { maxAttempts: 2, retryBaseDelayMs: 0 } },
    webhookStore: store,
    logger: makeLogger(),
    now: () => NOW,
    send: async (...args) => {
      calls.push(args);
      return { status: 200 };
    },
    sleep: async () => {},
    validateTarget: async () => {
      throw new WebhookTargetError('blocked', 'blocked_target');
    },
    randomId: () => 'blocked-id',
  });
  const delivery = await forwarder.deliverOne(webhook, record, context);
  assert.equal(calls.length, 0);
  assert.equal(delivery.status, 'failed');
  assert.match(delivery.error, /blocked_target/);
});

test('deliverToAll fans out to enabled hooks only and skips when none', async () => {
  const { store, forwarder, calls } = await setup();
  const disabled = await store.create({
    url: 'https://disabled.example.com/hook',
    enabled: false,
  });
  const result = await forwarder.deliverToAll(record, context);
  assert.deepEqual(result, { dispatched: 1, succeeded: 1, failed: 0 });
  assert.equal(calls.length, 1);

  await store.update(disabled.webhook_id, { enabled: true });
  const both = await forwarder.deliverToAll(record, context);
  assert.equal(both.dispatched, 2);
  assert.equal(calls.length, 3);

  const emptyStore = createWebhookStore({
    storage: createMemoryStorage({ now: () => NOW }),
    now: () => NOW,
    resolveHost,
  });
  const emptyForwarder = createWebhookForwarder({
    config: { webhook: { maxAttempts: 1 } },
    webhookStore: emptyStore,
    logger: makeLogger(),
    now: () => NOW,
    send: async () => {
      throw new Error('must not be called');
    },
    validateTarget,
  });
  assert.deepEqual(await emptyForwarder.deliverToAll(record, context), {
    dispatched: 0,
    succeeded: 0,
    failed: 0,
  });
});

test('marks test deliveries with test: true', async () => {
  const { forwarder, webhook, store } = await setup();
  const delivery = await forwarder.deliverOne(webhook, record, context, {
    test: true,
  });
  assert.equal(delivery.test, true);
  const [stored] = await store.listDeliveries();
  assert.equal(stored.test, true);
});
