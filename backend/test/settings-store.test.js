import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../src/services/storage/index.js';
import {
  createSettingsStore,
  SettingsError,
} from '../src/services/settings-store.js';

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

function makeStore(overrides = {}) {
  const storage = createStorage({ type: 'memory', now: () => NOW });
  const config = {
    autoExtract: true,
    maskSender: true,
    apiSecretToken: 'initial-token',
    ...overrides,
  };
  const store = createSettingsStore({
    storage,
    config,
    now: () => NOW,
    tokenFactory: () => 'dcc_0123456789abcdef0123456789abcdef',
  });
  return { storage, config, store };
}

test('settings default from config and mask the token', () => {
  const { store } = makeStore();
  const view = store.view();
  assert.equal(view.auto_extract, true);
  assert.equal(view.mask_sender, true);
  assert.equal(view.webhook_url, '');
  assert.equal(view.token_configured, true);
  assert.equal(view.token_masked, 'init****oken');
  assert.equal(view.updated_at, null);
});

test('update persists toggles and applies them to the live config', async () => {
  const { storage, config, store } = makeStore();
  const view = await store.update({
    auto_extract: false,
    mask_sender: false,
    webhook_url: 'https://example.com/hooks/dcc',
  });
  assert.equal(view.auto_extract, false);
  assert.equal(view.mask_sender, false);
  assert.equal(view.webhook_url, 'https://example.com/hooks/dcc');
  assert.equal(view.updated_at, new Date(NOW).toISOString());
  assert.equal(config.autoExtract, false);
  assert.equal(config.maskSender, false);
  assert.equal(config.apiSecretToken, 'initial-token');

  const saved = await storage.get('admin:settings');
  assert.equal(saved.auto_extract, false);
  assert.equal(saved.mask_sender, false);
  assert.equal(saved.webhook_url, 'https://example.com/hooks/dcc');
});

test('hydrate restores persisted settings after a restart', async () => {
  const { storage } = makeStore();
  await storage.set('admin:settings', {
    auto_extract: false,
    mask_sender: false,
    webhook_url: 'https://hooks.example.com/dcc',
    api_secret_token: 'persisted-token',
    updated_at: '2026-10-16T10:00:00.000Z',
  });
  const config = {
    autoExtract: true,
    maskSender: true,
    apiSecretToken: 'env-token',
  };
  const store = createSettingsStore({ storage, config, now: () => NOW });
  assert.equal(config.apiSecretToken, 'env-token');
  const view = await store.hydrate();
  assert.equal(view.auto_extract, false);
  assert.equal(view.mask_sender, false);
  assert.equal(view.webhook_url, 'https://hooks.example.com/dcc');
  assert.equal(config.autoExtract, false);
  assert.equal(config.maskSender, false);
  assert.equal(config.apiSecretToken, 'persisted-token');
});

test('invalid settings are rejected with typed errors', async () => {
  const { store } = makeStore();
  await assert.rejects(
    () => store.update({ auto_extract: 'yes' }),
    (error) =>
      error instanceof SettingsError && error.code === 'invalid_auto_extract',
  );
  await assert.rejects(
    () => store.update({ mask_sender: 1 }),
    (error) =>
      error instanceof SettingsError && error.code === 'invalid_mask_sender',
  );
  await assert.rejects(
    () => store.update({ webhook_url: 'http://example.com/hook' }),
    (error) =>
      error instanceof SettingsError && error.code === 'invalid_webhook_url',
  );
  await assert.rejects(
    () => store.update({ webhook_url: 'https://127.0.0.1/hook' }),
    /private or loopback/,
  );
  await assert.rejects(
    () => store.update({ webhook_url: 'https://localhost/hook' }),
    /private or loopback/,
  );
  await assert.rejects(
    () => store.update({ webhook_url: 'not a url' }),
    /valid URL/,
  );
  await assert.rejects(() => store.update(null), /JSON object/);
});

test('rotateToken issues a new token, invalidates the old one and persists', async () => {
  const { storage, config, store } = makeStore();
  const token = await store.rotateToken();
  assert.equal(token, 'dcc_0123456789abcdef0123456789abcdef');
  assert.equal(config.apiSecretToken, token);
  assert.equal(store.view().token_masked, 'dcc_****cdef');

  const saved = await storage.get('admin:settings');
  assert.equal(saved.api_secret_token, token);

  const restarted = createSettingsStore({
    storage,
    config: {
      autoExtract: true,
      maskSender: true,
      apiSecretToken: 'env-token',
    },
    now: () => NOW,
  });
  await restarted.hydrate();
  assert.equal(restarted.getToken(), token);
});
