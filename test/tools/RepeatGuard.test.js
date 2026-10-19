'use strict';
import { test, describe, beforeEach } from 'vitest';
import assert from 'node:assert';
import {
  recordCall, resetSession, resetAll, stableArgs, signatureOf,
} from '../../src/tools/runtime/repeat-guard.js';

beforeEach(() => resetAll());

describe('stableArgs（签名规范化）', () => {
  test('对象键顺序不同 → 签名相同（否则轮询参数换个顺序就漏判）', () => {
    const a = signatureOf('grep', { pattern: 'x', options: { path: 'p', include: '*.ts' } });
    const b = signatureOf('grep', { options: { include: '*.ts', path: 'p' }, pattern: 'x' });
    assert.strictEqual(a, b);
  });

  test('参数不同 → 签名不同', () => {
    assert.notStrictEqual(signatureOf('read', { filePath: 'a' }), signatureOf('read', { filePath: 'b' }));
  });

  test('数组保持顺序敏感', () => {
    assert.notStrictEqual(stableArgs([1, 2]), stableArgs([2, 1]));
  });

  test('超长字符串截断（大内容不进内存）', () => {
    const s = stableArgs({ content: 'x'.repeat(5000) });
    assert.ok(s.length < 400, '签名应远小于原文: ' + s.length);
  });

  test('循环引用不抛错', () => {
    const o = { a: 1 };
    o.self = o;
    assert.doesNotThrow(() => stableArgs(o));
  });
});

describe('recordCall（重复提醒）', () => {
  test('前两次不提醒，第三次起提醒', () => {
    assert.strictEqual(recordCall('s1', 'bash', { command: 'ls' }, true), '');
    assert.strictEqual(recordCall('s1', 'bash', { command: 'ls' }, true), '');
    const third = recordCall('s1', 'bash', { command: 'ls' }, true);
    assert.match(third, /重复调用提醒/);
    assert.match(third, /连续 3 次/);
  });

  test('中间夹了别的调用 → 连续计数清零', () => {
    recordCall('s2', 'bash', { command: 'ls' }, true);
    recordCall('s2', 'bash', { command: 'ls' }, true);
    recordCall('s2', 'read', { filePath: 'a' }, true); // 打断
    assert.strictEqual(recordCall('s2', 'bash', { command: 'ls' }, true), '');
  });

  test('失败调用用"失败调用"措辞（与成功区分）', () => {
    recordCall('s3', 'edit', { filePath: 'a' }, false);
    recordCall('s3', 'edit', { filePath: 'a' }, false);
    const hint = recordCall('s3', 'edit', { filePath: 'a' }, false);
    assert.match(hint, /失败调用/);
  });

  test('提醒最多两次（不刷屏）', () => {
    for (let i = 0; i < 2; i++) recordCall('s4', 'bash', { command: 'x' }, true);
    assert.ok(recordCall('s4', 'bash', { command: 'x' }, true)); // 第3次
    assert.ok(recordCall('s4', 'bash', { command: 'x' }, true)); // 第4次
    assert.strictEqual(recordCall('s4', 'bash', { command: 'x' }, true), ''); // 第5次静默
  });

  test('阈值 <=0 关闭提醒', () => {
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(recordCall('s5', 'bash', { command: 'x' }, true, 0), '');
    }
  });

  test('会话隔离：A 会话的重复不影响 B 会话', () => {
    recordCall('sA', 'bash', { command: 'x' }, true);
    recordCall('sA', 'bash', { command: 'x' }, true);
    assert.strictEqual(recordCall('sB', 'bash', { command: 'x' }, true), '');
  });

  test('resetSession 清零该会话', () => {
    recordCall('s6', 'bash', { command: 'x' }, true);
    recordCall('s6', 'bash', { command: 'x' }, true);
    resetSession('s6');
    assert.strictEqual(recordCall('s6', 'bash', { command: 'x' }, true), '');
  });

  test('提醒文本包含工具名与参数摘要（模型能知道是哪个调用）', () => {
    recordCall('s7', 'grep', { pattern: 'TODO' }, true);
    recordCall('s7', 'grep', { pattern: 'TODO' }, true);
    const hint = recordCall('s7', 'grep', { pattern: 'TODO' }, true);
    assert.match(hint, /grep/);
    assert.match(hint, /TODO/);
    assert.match(hint, /goalBlocked/, '应给出"确实卡住"的出口');
  });
});
