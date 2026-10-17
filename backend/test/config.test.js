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
