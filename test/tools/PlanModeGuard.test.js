'use strict';
import { test, describe, beforeEach } from 'vitest';
import assert from 'node:assert';
import {
  setPlanPhase, getPlanPhase, isPlanReadOnly, isWriteTool, guardPlanReadOnly, clearSession, clearAll,
} from '../../src/infra/plan-mode.js';
import { registry } from '../../src/tools/index.js';

beforeEach(() => clearAll());

describe('plan-mode 镜像（主进程侧）', () => {
  test('默认 off：未知会话不拦', () => {
    assert.strictEqual(getPlanPhase('nobody'), 'off');
    assert.strictEqual(isPlanReadOnly('nobody'), false);
  });

  test('draft/confirm 是只读期；exec/done/blocked/off 放行', () => {
    for (const p of ['draft', 'confirm']) {
      setPlanPhase('s1', p);
      assert.strictEqual(isPlanReadOnly('s1'), true, p + ' 应只读');
    }
    for (const p of ['exec', 'done', 'blocked', 'off']) {
      setPlanPhase('s1', p);
      assert.strictEqual(isPlanReadOnly('s1'), false, p + ' 应放行');
    }
  });

  test('非法阶段被忽略（渲染进程异常数据不污染镜像）', () => {
    setPlanPhase('s2', 'draft');
    setPlanPhase('s2', 'HACK');
    assert.strictEqual(getPlanPhase('s2'), 'draft', '非法值不应覆盖');
    setPlanPhase('s2', null);
    assert.strictEqual(getPlanPhase('s2'), 'draft');
  });

  test('会话隔离 + clearSession', () => {
    setPlanPhase('sA', 'draft');
    assert.strictEqual(isPlanReadOnly('sB'), false);
    clearSession('sA');
    assert.strictEqual(isPlanReadOnly('sA'), false);
  });

  test('guardPlanReadOnly 文案含 todoWrite 出口', () => {
    setPlanPhase('s3', 'draft');
    const msg = guardPlanReadOnly('s3', 'bash');
    assert.ok(msg && msg.includes('todoWrite'), '必须告诉模型下一步（列计划）而不是只说不行');
    assert.ok(msg.includes('bash'), '应回显被拒的调用名');
    assert.strictEqual(guardPlanReadOnly('s4', 'bash'), null, 'off 阶段放行');
  });
});

describe('写工具黑名单', () => {
  test('副作用工具全在黑名单（mcpCall/injectJS 能力等同 bash；runAgent 会借子代理绕过镜像）', () => {
    for (const t of ['write', 'edit', 'deleteFile', 'bash', 'pwsh', 'mysql', 'injectJS', 'mcpCall', 'runAgent']) {
      assert.strictEqual(isWriteTool(t), true, t + ' 应受计划只读约束');
    }
  });

  test('元工具/读工具不在黑名单（草稿期要靠 todoWrite 列计划）', () => {
    for (const t of ['read', 'readLines', 'glob', 'grep', 'todoWrite', 'goalDone', 'goalBlocked',
      'webFetch', 'nameConversation', 'mcpListServers', 'mcpGetTools']) {
      assert.strictEqual(isWriteTool(t), false, t + ' 不应被计划只读拦截');
    }
  });
});

describe('registry.execute 计划只读护栏（两条 IPC 路径的共同收口）', () => {
  test('draft 期 write 被拒：PLAN_READ_ONLY，且不执行', async () => {
    setPlanPhase('g1', 'draft');
    const r = await registry.execute('write', {
      filePath: 'should-not-exist.txt', content: 'x', projectDir: process.cwd(), sessionId: 'g1',
    });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.code, 'PLAN_READ_ONLY');
    assert.match(String(r.error), /计划模式/);
    // 错误文本不能自带 [error code:] 前缀——由 JsRunner 统一渲染（030 约定），
    // 这里自己拼会重复成两遍。
    assert.ok(!String(r.error).includes('[error code:'), 'registry 不应自行拼错误码前缀');
  });

  test('E2E：经 JsRunner 渲染后前缀只出现一次（防重复拼接回归）', async () => {
    const { JsRunner } = await import('../../src/tools/runtime/JsRunner.js');
    setPlanPhase('g1b', 'draft');
    const runner = new JsRunner(registry);
    const r = await runner.run('await write("nope.txt", "x");', process.cwd(), 1, { sessionId: 'g1b' });
    assert.strictEqual(r.success, false);
    const occurrences = (String(r.error).match(/\[error code: PLAN_READ_ONLY\]/g) || []).length;
    assert.strictEqual(occurrences, 1, '错误码前缀应恰好一次，实际 ' + occurrences + ' 次\n' + r.error);
  });

  test('draft 期 bash 被拒（副作用命令不允许偷跑）', async () => {
    setPlanPhase('g2', 'confirm');
    const r = await registry.execute('bash', { command: 'echo hi', projectDir: process.cwd(), sessionId: 'g2' });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.code, 'PLAN_READ_ONLY');
  });

  test('draft 期 todoWrite 放行（列计划是草稿期的正确动作）', async () => {
    setPlanPhase('g3', 'draft');
    const r = await registry.execute('todoWrite', {
      todos: [{ content: 'step1', status: 'pending' }], projectDir: process.cwd(), sessionId: 'g3',
    });
    assert.strictEqual(r.success, true, r.error);
  });

  test('draft 期 read 放行', async () => {
    setPlanPhase('g4', 'draft');
    const r = await registry.execute('read', { filePath: 'package.json', projectDir: process.cwd(), sessionId: 'g4' });
    assert.strictEqual(r.success, true);
  });

  test('exec 期 write 恢复放行（用户确认后要能干活）', async () => {
    setPlanPhase('g5', 'exec');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.join(process.cwd(), 'test', 'tmp', 'planmode');
    fs.mkdirSync(dir, { recursive: true });
    try {
      const r = await registry.execute('write', { filePath: 'ok.txt', content: 'v', projectDir: dir, sessionId: 'g5' });
      assert.strictEqual(r.success, true, r.error);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('无 sessionId（直连/插件调用）归 default 键，不误伤', async () => {
    const r = await registry.execute('read', { filePath: 'package.json', projectDir: process.cwd() });
    assert.strictEqual(r.success, true);
  });
});
