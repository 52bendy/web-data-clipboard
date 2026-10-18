import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getConfig } from '../src/config.js';

test('port defaults to 3000 and can be overridden', () => {
  assert.equal(getConfig({}).port, 3000);
  assert.equal(getConfig({ PORT: '8080' }).port, 8080);
});

test('device online threshold defaults to 24h and falls back for invalid values', () => {
  assert.equal(getConfig({}).devices.onlineThresholdMs, 86_400_000);
  assert.equal(getConfig({ DEVICE_ONLINE_THRESHOLD_MS: '12345' }).devices.onlineThresholdMs, 12345);
  assert.equal(getConfig({ DEVICE_ONLINE_THRESHOLD_MS: '0' }).devices.onlineThresholdMs, 86_400_000);
  assert.equal(getConfig({ DEVICE_ONLINE_THRESHOLD_MS: 'bad' }).devices.onlineThresholdMs, 86_400_000);
});

test('autoExtract defaults to true and can be disabled via env', () => {
  assert.equal(getConfig({}).autoExtract, true);
  assert.equal(getConfig({ AUTO_EXTRACT: 'true' }).autoExtract, true);
  assert.equal(getConfig({ AUTO_EXTRACT: 'false' }).autoExtract, false);
  assert.equal(getConfig({ AUTO_EXTRACT: '0' }).autoExtract, false);
});

test('maskSender defaults to true and can be disabled via env', () => {
  assert.equal(getConfig({}).maskSender, true);
  assert.equal(getConfig({ MASK_SENDER: 'true' }).maskSender, true);
  assert.equal(getConfig({ MASK_SENDER: 'false' }).maskSender, false);
  assert.equal(getConfig({ MASK_SENDER: '0' }).maskSender, false);
});

test('SMS collector metadata defaults and namespace are configurable', () => {
  const defaults = getConfig({});
  assert.equal(defaults.collect.project, 'sms');
  assert.equal(defaults.collect.sourceLabel, '短信采集');
  assert.equal(defaults.collect.namespace, 'default');

  const custom = getConfig({
    SMS_PROJECT: 'inbox',
    SMS_SOURCE_LABEL: '公司短信',
    SMS_NAMESPACE: 'sms-inbox',
  });
  assert.equal(custom.collect.project, 'inbox');
  assert.equal(custom.collect.sourceLabel, '公司短信');
  assert.equal(custom.collect.namespace, 'sms-inbox');

  assert.throws(
    () => getConfig({ SMS_NAMESPACE: '../bad' }),
    /SMS_NAMESPACE/,
  );
});

test('CLIPBOARD_TOKENS parses project scopes with safe defaults', () => {
  const raw = JSON.stringify([
    {
      token: 'token-a',
      project: 'project-a',
      label: '项目 A',
      namespaces: ['project-a', 'shared'],
      permissions: ['read', 'write'],
    },
    { token: 'token-b', project: 'project-b' },
  ]);
  const tokens = getConfig({ CLIPBOARD_TOKENS: raw }).clipboard.tokens;
  assert.equal(tokens.length, 2);
  assert.deepEqual(tokens[0], {
    token: 'token-a',
    project: 'project-a',
    label: '项目 A',
    name: 'project-a',
    collector: 'api',
    namespaces: ['project-a', 'shared'],
    permissions: ['read', 'write'],
  });
  assert.deepEqual(tokens[1].namespaces, ['default']);
  assert.deepEqual(tokens[1].permissions, ['read', 'write']);
});

test('CLIPBOARD_TOKENS rejects malformed or unsafe entries', () => {
  const invalid = [
    'not json',
    JSON.stringify({ token: 'x', project: 'p' }),
    JSON.stringify([{ token: '', project: 'p' }]),
    JSON.stringify([{ token: 'x' }]),
    JSON.stringify([
      { token: 'x', project: 'p', namespaces: [] },
    ]),
    JSON.stringify([
      { token: 'x', project: 'p', namespaces: ['../bad'] },
    ]),
    JSON.stringify([
      { token: 'x', project: 'p', permissions: ['admin'] },
    ]),
    JSON.stringify([
      { token: 'x', project: 'p' },
      { token: 'x', project: 'q' },
    ]),
  ];
  for (const value of invalid) {
    assert.throws(() => getConfig({ CLIPBOARD_TOKENS: value }), Error, value);
  }
});

test('log retention defaults are bounded and configurable', () => {
  const defaults = getConfig({}).logs;
  assert.equal(defaults.maxEntries, 1000);
  assert.equal(defaults.maxAgeMs, 7 * 24 * 60 * 60 * 1000);
  const custom = getConfig({
    LOG_MAX_ENTRIES: '50',
    LOG_MAX_AGE_MS: '3600000',
  }).logs;
  assert.equal(custom.maxEntries, 50);
  assert.equal(custom.maxAgeMs, 3600000);
  const unlimited = getConfig({
    LOG_MAX_ENTRIES: '0',
    LOG_MAX_AGE_MS: '0',
  }).logs;
  assert.equal(unlimited.maxEntries, 0);
  assert.equal(unlimited.maxAgeMs, 0);
});
