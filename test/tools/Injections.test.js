/**
 * 每轮注入通道（T2）单元测试：顺序 / 去重 / 预算。
 */
import { test } from 'vitest';
import assert from 'node:assert';
import { prependInjections, MAX_BLOCK_CHARS, MAX_TOTAL_CHARS } from '../../src/tools/runtime/injections.js';

test('prependInjections：按传入顺序拼接，空块忽略', () => {
  const out = prependInjections('BODY', ['第一', '', null, undefined, '第二']);
  assert.strictEqual(out, '第一\n\n第二\n\nBODY');
});

test('prependInjections：无有效块时原样返回', () => {
  assert.strictEqual(prependInjections('BODY', []), 'BODY');
  assert.strictEqual(prependInjections('BODY', ['', null, '   ']), 'BODY');
  assert.strictEqual(prependInjections('', ['   ']), '');
});

test('prependInjections：输出为空时只返回注入块', () => {
  assert.strictEqual(prependInjections('', ['提示']), '提示');
});

test('prependInjections：完全相同的块只保留一次', () => {
  const out = prependInjections('BODY', ['同样的提醒', '同样的提醒']);
  assert.strictEqual(out, '同样的提醒\n\nBODY');
});

test('prependInjections：单块超长时截断并标注', () => {
  const long = 'x'.repeat(MAX_BLOCK_CHARS + 100);
  const out = prependInjections('BODY', [long]);
  assert.ok(out.includes('已截断'));
  assert.ok(out.length < long.length + 200);
});

test('prependInjections：总预算耗尽时停止追加后续块', () => {
  // 每块接近单块上限，两块合计必定超过总预算
  const a = 'a'.repeat(MAX_BLOCK_CHARS);
  const b = 'b'.repeat(MAX_BLOCK_CHARS);
  const c = 'c'.repeat(MAX_BLOCK_CHARS);
  const out = prependInjections('BODY', [a, b, c]);
  assert.ok(out.includes('a'.repeat(MAX_BLOCK_CHARS)), '第一块应保留');
  assert.ok(!out.includes('c'.repeat(MAX_BLOCK_CHARS)), '预算耗尽后不再追加');
  assert.ok(out.includes('已按预算截断'));
  assert.ok(out.length <= MAX_TOTAL_CHARS + 200);
});
