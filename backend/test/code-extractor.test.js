import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCode } from '../src/services/code-extractor.js';
import { positiveSamples, negativeSamples } from './fixtures/code-samples.js';

test('样例集规模满足验收要求（正/负各不少于 20 条）', () => {
  assert.ok(positiveSamples.length >= 20, `正例 ${positiveSamples.length} 条`);
  assert.ok(negativeSamples.length >= 20, `负例 ${negativeSamples.length} 条`);
});

test('正样例 100% 提取出预期验证码', () => {
  for (const { text, expected } of positiveSamples) {
    const result = extractCode(text);
    assert.equal(result.extracted_code, expected, `正例未通过：${text}`);
    assert.equal(result.type, 'verification_code', `类型错误：${text}`);
  }
});

test('负样例 100% 不误提取', () => {
  for (const { text, reason } of negativeSamples) {
    const result = extractCode(text);
    assert.equal(
      result.extracted_code,
      null,
      `负例误提取（${reason}）：${text}`,
    );
    assert.equal(result.type, 'text', `类型错误（${reason}）：${text}`);
  }
});

test('输出契约只包含 extracted_code 与 type', () => {
  const result = extractCode('【某平台】验证码：930614');
  assert.deepEqual(Object.keys(result).sort(), ['extracted_code', 'type']);
});

test('「自动提取」关闭时仅按原文处理', () => {
  const text = '【某平台】验证码：930614，请勿泄露。';
  assert.deepEqual(extractCode(text, { autoExtract: false }), {
    extracted_code: null,
    type: 'text',
  });
  // 开关缺省为开启
  assert.equal(extractCode(text).extracted_code, '930614');
});

test('引擎为纯函数：相同输入恒定输出且不修改入参', () => {
  const text = '【某银行】验证码 317159，请勿泄露。';
  const options = Object.freeze({ autoExtract: true });
  const first = extractCode(text, options);
  const second = extractCode(text, options);
  const third = extractCode(text, options);
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
  assert.deepEqual(options, { autoExtract: true });
});

test('边界输入不抛错且按无码处理', () => {
  for (const input of [undefined, null, '', '验证码已发送', 123456, {}]) {
    const result = extractCode(input);
    assert.deepEqual(result, { extracted_code: null, type: 'text' });
  }
});

test('关键词与数字距离过远时不提取', () => {
  const result = extractCode('Use code to sign in. Your order is 4471.');
  assert.equal(result.extracted_code, null);
});

test('超长数字串不提取，其中的片段也不算候选', () => {
  const result = extractCode('【某平台】验证码 1234567890，请勿泄露。');
  assert.equal(result.extracted_code, null);
});
