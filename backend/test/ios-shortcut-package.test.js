import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { validateCollectPayload } from '../src/services/collect-service.js';

const here = dirname(fileURLToPath(import.meta.url));
const iosDir = resolve(here, '../../ios-scripts');

test('iOS sample payload satisfies the collect contract', async () => {
  const raw = await readFile(
    resolve(iosDir, 'examples/sample-payload.json'),
    'utf8',
  );
  const body = JSON.parse(raw);

  const result = validateCollectPayload(body, { now: body.timestamp + 1000 });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(
    Object.keys(body).sort(),
    [
      'device_id',
      'device_name',
      'platform',
      'raw_content',
      'sender',
      'timestamp',
    ].sort(),
  );
  assert.equal(body.platform, 'ios');
  assert.equal(Number.isInteger(body.timestamp), true);
  assert.equal(typeof body.sender, 'string');
});

test('iOS shortcut package contains the expected actions and placeholders', async () => {
  const buffer = await readFile(resolve(iosDir, 'sms-collector.shortcut'));
  assert.equal(buffer.subarray(0, 8).toString('ascii'), 'bplist00');

  const text = buffer.toString('latin1');
  for (const identifier of [
    'is.workflow.actions.gettext',
    'is.workflow.actions.getdevicedetails',
    'is.workflow.actions.date',
    'is.workflow.actions.gettimebetweendates',
    'is.workflow.actions.math',
    'is.workflow.actions.downloadurl',
    'is.workflow.actions.notification',
  ]) {
    assert.ok(text.includes(identifier), identifier);
  }
  for (const key of [
    'device_id',
    'device_name',
    'platform',
    'sender',
    'raw_content',
    'timestamp',
    'X-DCC-Token',
  ]) {
    assert.ok(text.includes(key), key);
  }
  assert.ok(text.includes('https://YOUR-SERVER.example.com/api/v1/collect'));
  assert.ok(text.includes('PASTE_YOUR_TOKEN_HERE'));
  assert.ok(text.includes('ios_shortcut_001'));
});

test('iOS shortcut source plist stays readable and contains import questions', async () => {
  const xml = await readFile(
    resolve(iosDir, 'sms-collector.source.plist'),
    'utf8',
  );
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.ok(xml.includes('<key>WFWorkflowImportQuestions</key>'));
  assert.ok(xml.includes('WFWorkflowActionIdentifier'));
  assert.ok(xml.includes('WFJSONValues'));
});
