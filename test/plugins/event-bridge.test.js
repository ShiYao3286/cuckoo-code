'use strict';
import { test, describe, beforeEach } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  registerContext, unregisterContext, clearContexts, getActiveContexts, broadcast,
} from '../../src/plugins/runtime/compat/bridge.js';

const ROOT = process.cwd();
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

beforeEach(() => clearContexts());

/**
 * 需求 038：UI 插件收不到 agent/* 事件
 *
 * 根因：PluginHost.loadAll 是实际加载路径（plugin-system.ts 走它），
 * 但 PluginHost 从不调用 registerContext，而 bindCuckooEvents 派发时
 * 只遍历 compat/bridge 的 activeContexts —— 于是事件永远到不了插件。
 * PluginHost 自己虽有一套 broadcast()，却没有事件源驱动，形同虚设。
 */

describe('事件桥：PluginHost 必须注册 context', () => {
  test('PluginHost.load 会 registerContext（源码契约）', () => {
    const src = read('src/plugins/runtime/plugin-host.ts');
    assert.match(src, /registerContext/, 'PluginHost 应注册 context 到事件桥');
    // 必须在 load 成功记录之后、返回之前
    const loadIdx = src.indexOf('this.records.set(plugin.name');
    const regIdx = src.indexOf('registerContext(plugin.ctx');
    assert.ok(loadIdx > 0, '应找到 records.set');
    assert.ok(regIdx > loadIdx, 'registerContext 应在记录插件之后调用');
  });

  test('PluginHost.unload 会 unregisterContext（防泄漏）', () => {
    const src = read('src/plugins/runtime/plugin-host.ts');
    const idx = src.indexOf('unload(name: string)');
    const body = src.slice(idx, idx + 700);
    assert.match(body, /unregisterContext/, '卸载时应从事件桥摘除');
  });

  test('broadcast 只派发给已注册的 context', () => {
    const got = [];
    const ctx = { __bus: { emit: (ev, ...args) => got.push({ ev, args }) } };
    // 未注册时收不到
    broadcast('agent/assistant-stream', { frame: { text: 'x' } });
    assert.strictEqual(got.length, 0, '未注册的 context 不应收到事件');
    // 注册后能收到
    registerContext(ctx);
    assert.strictEqual(getActiveContexts().length, 1);
    broadcast('agent/assistant-stream', { frame: { text: 'hello' } });
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].ev, 'agent/assistant-stream');
    assert.strictEqual(got[0].args[0].frame.text, 'hello');
    // 反注册后收不到
    unregisterContext(ctx);
    broadcast('agent/assistant-stream', { frame: { text: 'again' } });
    assert.strictEqual(got.length, 1, '反注册后不应再收到');
  });

  test('broadcast 跳过没有 __bus 的 context（不抛错）', () => {
    registerContext({});  // 没有 __bus
    assert.doesNotThrow(() => broadcast('agent/turn-end', { text: 'x' }));
  });

  test('单个监听器抛错不影响其他 context', () => {
    const ok = [];
    registerContext({ __bus: { emit: () => { throw new Error('boom'); } } });
    registerContext({ __bus: { emit: (ev) => ok.push(ev) } });
    assert.doesNotThrow(() => broadcast('tool/result', {}));
    assert.deepStrictEqual(ok, ['tool/result'], '第二个 context 仍应收到');
  });
});
