import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getConfig } from '../src/config.js';
import { createMemoryStorage } from '../src/services/storage/memory-storage.js';
import { createWebhookStore } from '../src/services/webhook-store.js';
import {
  createWebhookForwarder,
  signWebhookPayload,
} from '../src/services/webhook-forwarder.js';
import {
  isHostAllowed,
  normalizeAllowedHost,
  normalizeAllowedHosts,
  validateWebhookUrl,
} from '../src/services/webhook-target.js';

const NOW = 1760000000000;
const publicResolver = async () => [
  { address: '93.184.216.34', family: 4 },
  { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
];

const record = {
  clipboard_id: 'clip_1',
  data_type: 'verification_code',
  parsed_code: '839201',
  full_text: '【中国移动】您的验证码是：839201，5分钟内有效。',
  updated_at: '2026-10-17T02:00:00.000Z',
  source: { device_name: '小米 13Pro', platform: 'android' },
};

function silentLogger() {
  return { info() {}, warn() {}, error() {} };
}

function makeStore(allowedHosts = []) {
  return createWebhookStore({
    storage: createMemoryStorage({ now: () => NOW }),
    now: () => NOW,
    resolveHost: publicResolver,
    allowedHosts,
  });
}

test('WEBHOOK_ALLOWED_HOSTS parses, normalizes and fails fast on bad entries', () => {
  const config = getConfig({
    WEBHOOK_ALLOWED_HOSTS: ' Example.COM , *.hooks.example.net ',
  });
  assert.deepEqual(config.webhook.allowedHosts, [
    'example.com',
    '*.hooks.example.net',
  ]);
  assert.deepEqual(getConfig({}).webhook.allowedHosts, []);
  assert.deepEqual(
    getConfig({ WEBHOOK_ALLOWED_HOSTS: '  ' }).webhook.allowedHosts,
    [],
  );

  for (const invalid of [
    'https://example.com',
    '*',
    '*.',
    'example.com/path',
    'localhost',
    'example.com:443',
  ]) {
    assert.throws(
      () => getConfig({ WEBHOOK_ALLOWED_HOSTS: invalid }),
      /WEBHOOK_ALLOWED_HOSTS is invalid/,
      invalid,
    );
  }
});

test('allowlist entry normalization supports exact hosts, IPs and wildcards', () => {
  assert.equal(
    normalizeAllowedHost(' Hooks.Example.COM. '),
    'hooks.example.com',
  );
  assert.equal(normalizeAllowedHost('93.184.216.34'), '93.184.216.34');
  assert.equal(normalizeAllowedHost('*.Example.com'), '*.example.com');
  assert.deepEqual(normalizeAllowedHosts(['a.example.com', 'A.EXAMPLE.COM']), [
    'a.example.com',
  ]);
  assert.throws(() => normalizeAllowedHost(''), /must not be empty/);
  assert.throws(() => normalizeAllowedHost(42), /must be strings/);
});

test('allowlist matching is case-insensitive and wildcard-safe', () => {
  const allowed = ['hooks.example.com', '*.partner.example'];
  assert.equal(isHostAllowed('HOOKS.EXAMPLE.COM.', allowed), true);
  assert.equal(isHostAllowed('a.partner.example', allowed), true);
  assert.equal(isHostAllowed('a.b.partner.example', allowed), true);
  assert.equal(isHostAllowed('partner.example', allowed), false);
  assert.equal(isHostAllowed('evilpartner.example', allowed), false);
  assert.equal(isHostAllowed('hooks.example.com.evil.test', allowed), false);
  assert.equal(isHostAllowed('anything.example.com', []), true);
});

test('allowlist rejects targets that are not listed before DNS resolution', async () => {
  let resolved = 0;
  const countingResolver = async () => {
    resolved += 1;
    return publicResolver();
  };

  await assert.rejects(
    validateWebhookUrl('https://evil.example.com/hook', {
      resolveHost: countingResolver,
      allowedHosts: ['hooks.example.com'],
    }),
    (error) => error.code === 'host_not_allowed',
  );
  assert.equal(resolved, 0);

  const accepted = await validateWebhookUrl('https://hooks.example.com/hook', {
    resolveHost: countingResolver,
    allowedHosts: ['hooks.example.com'],
  });
  assert.equal(accepted.toString(), 'https://hooks.example.com/hook');
  assert.equal(resolved, 1);

  await assert.rejects(
    validateWebhookUrl('https://93.184.216.34/hook', {
      resolveHost: publicResolver,
      allowedHosts: ['hooks.example.com'],
    }),
    (error) => error.code === 'host_not_allowed',
  );
});

test('allowlist cannot override the loopback/private target blocklist', async () => {
  for (const url of [
    'https://127.0.0.1/hook',
    'https://169.254.169.254/latest/meta-data/',
    'https://10.0.0.5/hook',
    'https://[::1]/hook',
  ]) {
    await assert.rejects(
      validateWebhookUrl(url, {
        resolveHost: publicResolver,
        allowedHosts: ['127.0.0.1', '169.254.169.254', '10.0.0.5', '::1'],
      }),
      (error) => error.code === 'blocked_target',
      url,
    );
  }
});

test('webhook store enforces the allowlist on create and update', async () => {
  const store = makeStore(['hooks.example.com']);
  await assert.rejects(
    store.create({ url: 'https://evil.example.com/hook' }),
    (error) => error.code === 'host_not_allowed',
  );

  const webhook = await store.create({ url: 'https://hooks.example.com/hook' });
  await assert.rejects(
    store.update(webhook.webhook_id, { url: 'https://evil.example.com/hook' }),
    (error) => error.code === 'host_not_allowed',
  );
  assert.equal((await store.get(webhook.webhook_id)).url, webhook.url);
});

test('delivery re-validates the allowlist and never sends to a removed target', async () => {
  const store = makeStore();
  const webhook = await store.create({ url: 'https://hooks.example.com/hook' });
  let sent = 0;
  const forwarder = createWebhookForwarder({
    config: {
      webhook: {
        allowedHosts: ['other.example.com'],
        maxAttempts: 2,
        retryBaseDelayMs: 0,
      },
    },
    webhookStore: store,
    logger: silentLogger(),
    now: () => NOW,
    send: async () => {
      sent += 1;
      return { status: 200 };
    },
    sleep: async () => {},
    validateTarget: (url, options) =>
      validateWebhookUrl(url, { ...options, resolveHost: publicResolver }),
    randomId: () => 'blocked-allowlist',
  });

  const delivery = await forwarder.deliverOne(webhook, record, {
    collection_id: 'col_1',
  });
  assert.equal(sent, 0);
  assert.equal(delivery.status, 'failed');
  assert.match(delivery.error, /host_not_allowed/);
  assert.equal(delivery.attempts, 2);
});

test('documented HMAC verification accepts genuine bodies and rejects tampering', () => {
  const secret = 'whsec_test_secret';
  const timestamp = '1760000000';
  const body = JSON.stringify({ event: 'clipboard.updated', value: '839201' });
  const signature = signWebhookPayload(secret, timestamp, body);

  function verify(rawBody, headers, sharedSecret) {
    const received = headers['x-dcc-signature'] ?? '';
    const expected =
      'sha256=' +
      createHmac('sha256', sharedSecret)
        .update(`${headers['x-dcc-timestamp']}.${rawBody}`)
        .digest('hex');
    const a = Buffer.from(received);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  const headers = {
    'x-dcc-timestamp': timestamp,
    'x-dcc-signature': signature,
  };
  assert.equal(verify(body, headers, secret), true);
  assert.equal(
    verify(body.replace('839201', '839202'), headers, secret),
    false,
  );
  assert.equal(
    verify(body, { ...headers, 'x-dcc-timestamp': '1760000001' }, secret),
    false,
  );
  assert.equal(
    verify(body, { ...headers, 'x-dcc-signature': 'sha256=deadbeef' }, secret),
    false,
  );
});
