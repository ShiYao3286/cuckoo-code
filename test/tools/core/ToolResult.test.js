'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import { ToolResult } from '../../../src/tools/core/ToolResult.js';

test('ToolResult.success 设置成功态', () => {
  const r = ToolResult.success({ a: 1 });
  assert.strictEqual(r.success, true);
  assert.deepStrictEqual(r.data, { a: 1 });
  assert.strictEqual(r.error, null);
});

test('ToolResult.error 设置失败态', () => {
  const r = ToolResult.error('boom');
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.data, null);
  assert.strictEqual(r.error, 'boom');
});

test('ToolResult 构造函数直接设置字段', () => {
  const r = new ToolResult(true, 'd', null);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data, 'd');
});

test('ToolResult.toString 成功含 JSON', () => {
  const s = ToolResult.success({ x: 1 }).toString();
  assert.ok(s.includes('成功'));
  assert.ok(s.includes('{"x":1}'));
});

test('ToolResult.toString 失败含错误', () => {
  const s = ToolResult.error('err').toString();
  assert.ok(s.includes('失败'));
  assert.ok(s.includes('err'));
});

test('ToolResult.success 传 null 数据', () => {
  const r = ToolResult.success(null);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data, null);
});

test('ToolResult.successWithMeta 带元数据且不污染 data', () => {
  const r = ToolResult.successWithMeta('body', { truncated: true, totalCount: 100, returnedCount: 10, hint: 'go on' });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data, 'body');
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.meta.truncated, true);
  assert.strictEqual(r.meta.totalCount, 100);
  assert.strictEqual(r.meta.hint, 'go on');
});

test('ToolResult 无 meta 时 meta 为 null（兼容旧路径）', () => {
  assert.strictEqual(ToolResult.success('x').meta, null);
  assert.strictEqual(ToolResult.error('e').meta, null);
});
