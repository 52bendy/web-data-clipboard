import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskLogEntry, maskSender } from '../src/utils/mask.js';

test('masks the middle of a mainland mobile number', () => {
  assert.equal(maskSender('13800138000'), '138****8000');
  assert.equal(maskSender(' 13912345678 '), '139****5678');
});

test('preserves the +86 / 86 country prefix while masking', () => {
  assert.equal(maskSender('+8613800138000'), '+86138****8000');
  assert.equal(maskSender('8613800138000'), '86138****8000');
});

test('tolerates spaces and dashes in phone numbers', () => {
  assert.equal(maskSender('138-0013-8000'), '138****8000');
  assert.equal(maskSender('+86 138 0013 8000'), '+86138****8000');
});

test('leaves short service codes and non-numeric senders untouched', () => {
  assert.equal(maskSender('10086'), '10086');
  assert.equal(maskSender('95555'), '95555');
  assert.equal(maskSender('10690001'), '10690001');
  assert.equal(maskSender('中国移动'), '中国移动');
  assert.equal(maskSender(''), '');
  assert.equal(maskSender(null), null);
  assert.equal(maskSender(undefined), undefined);
});

test('masks other long phone-like numbers as well', () => {
  assert.equal(maskSender('+14155552671'), '+141****2671');
  assert.equal(maskSender('4155552671'), '415****2671');
});

test('maskLogEntry copies the entry and only masks the sender', () => {
  const entry = {
    log_id: 'log_1',
    sender: '13800138000',
    raw_content: '验证码 1234',
  };
  assert.deepEqual(maskLogEntry(entry, true), {
    ...entry,
    sender: '138****8000',
  });
  assert.deepEqual(maskLogEntry(entry, false), entry);
  assert.equal(entry.sender, '13800138000', 'input must not be mutated');
});
