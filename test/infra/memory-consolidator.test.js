/**
 * 记忆整理器测试：JSON 提取容错、错误处理。
 * 不测真实 LLM 调用（那需要网络和 Key），只测边界。
 */
import { test } from 'vitest';
import assert from 'node:assert';
import { extractJson, consolidateProfile } from '../../src/infra/memory-consolidator.js';

test('extractJson 普通 JSON', () => {
  assert.deepStrictEqual(extractJson('{"a":1}'), { a: 1 });
});

test('extractJson 剥 markdown 代码块', () => {
  assert.deepStrictEqual(extractJson('\u0060\u0060\u0060json\n{"a":1}\n\u0060\u0060\u0060'), { a: 1 });
  assert.deepStrictEqual(extractJson('\u0060\u0060\u0060\n{"a":1}\n\u0060\u0060\u0060'), { a: 1 });
});

test('extractJson 前后有空白', () => {
  assert.deepStrictEqual(extractJson('  {"a":1}  '), { a: 1 });
});

test('extractJson 非法 JSON 抛错', () => {
  assert.throws(() => extractJson('{invalid'));
});

test('consolidateProfile 无网络时返回失败而非抛异常', async () => {
  const r = await consolidateProfile({
    existingProfile: { identity: '', communication: '', engineering: '', environment: '', projects: {}, notes: '' },
    conversation: '用户: 你好',
    baseUrl: 'http://127.0.0.1:1',
    model: 'x',
    apiKey: 'k',
    timeoutMs: 2000,
  });
  assert.strictEqual(r.success, false);
  assert.ok(r.error);
  assert.ok(typeof r.elapsedMs === 'number');
});

test('consolidateProfile 超时返回明确错误', async () => {
  // 用一个必然超时的目标（本地不存在的慢服务不好造，这里用 1ms 超时对真实 DNS 解析）
  const r = await consolidateProfile({
    existingProfile: { identity: '', communication: '', engineering: '', environment: '', projects: {}, notes: '' },
    conversation: '用户: 你好',
    baseUrl: 'http://10.255.255.1',
    model: 'x',
    apiKey: 'k',
    timeoutMs: 50,
  });
  assert.strictEqual(r.success, false);
  assert.ok(r.error);
});
