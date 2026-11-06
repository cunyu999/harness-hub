/**
 * token 用量归一化: 各 harness 原始字段差异很大, 统一成 {input,output,cached,total}。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { addUsage, emptyUsage, normalizeUsage } from '../packages/core/src/usage.js';

test('Claude 的 snake_case 用量', () => {
  const u = normalizeUsage({
    input_tokens: 1309,
    output_tokens: 969,
    cache_read_input_tokens: 20505,
    cache_creation_input_tokens: 0,
  });
  assert.ok(u);
  assert.equal(u.input, 1309);
  assert.equal(u.output, 969);
  assert.equal(u.cached, 20505);
  assert.equal(u.total, 1309 + 20505 + 969, '缓存读取也算进总量');
});

test('Codex 的 last/total 结构取本回合', () => {
  const u = normalizeUsage({
    last: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    total: { inputTokens: 9999, outputTokens: 9999, totalTokens: 19998 },
  });
  assert.ok(u);
  assert.equal(u.input, 120);
  assert.equal(u.output, 30);
  assert.equal(u.total, 150);
});

test('已经归一化的形状原样读回', () => {
  const u = normalizeUsage({ input: 10, output: 5, cached: 2, total: 17 });
  assert.ok(u);
  assert.deepEqual(u, { input: 10, output: 5, cached: 2, total: 17 });
});

test('没有用量信息时返回 null, 不编造 0', () => {
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage({}), null);
  assert.equal(normalizeUsage({ stopReason: 'end_turn' }), null);
});

test('累加与空值', () => {
  const a = { input: 10, output: 5, cached: 1, total: 16 };
  const b = { input: 2, output: 3, cached: 0, total: 5 };
  assert.deepEqual(addUsage(a, b), { input: 12, output: 8, cached: 1, total: 21 });
  assert.deepEqual(emptyUsage(), { input: 0, output: 0, cached: 0, total: 0 });
});
