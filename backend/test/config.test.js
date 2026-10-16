import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getConfig } from '../src/config.js';

test('port defaults to 3000 and can be overridden', () => {
  assert.equal(getConfig({}).port, 3000);
  assert.equal(getConfig({ PORT: '8080' }).port, 8080);
});

test('autoExtract defaults to true and can be disabled via env', () => {
  assert.equal(getConfig({}).autoExtract, true);
  assert.equal(getConfig({ AUTO_EXTRACT: 'true' }).autoExtract, true);
  assert.equal(getConfig({ AUTO_EXTRACT: 'false' }).autoExtract, false);
  assert.equal(getConfig({ AUTO_EXTRACT: '0' }).autoExtract, false);
});
