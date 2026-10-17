import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runE2E } from '../scripts/e2e-chain.js';

test('scripted full chain and negative cases pass end to end', async () => {
  const result = await runE2E();
  assert.equal(result.ok, true);
  assert.equal(result.summary.checks, 12);
  assert.ok(result.summary.collected.startsWith('col_'));
  assert.ok(result.summary.delivery_id.startsWith('dlv_'));
  const failed = result.checks.filter((item) => item.status !== 'passed');
  assert.deepEqual(failed, []);
});
