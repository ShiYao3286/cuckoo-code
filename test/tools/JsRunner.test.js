'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import { JsRunner } from '../../src/tools/runtime/JsRunner.js';
import { registry } from '../../src/tools/index.js';

test('JsRunner 执行简单 JS 代码', async () => {
  const runner = new JsRunner(registry);
  const r = await runner.run('const x = 1 + 2; log(x);', process.cwd());
  assert.strictEqual(r.success, true);
  assert.ok(r.output.includes('3'));
});

test('JsRunner 空代码报错', async () => {
  const runner = new JsRunner(registry);
  const r = await runner.run('', null);
  assert.strictEqual(r.success, false);
  assert.match(r.error, /无效的 JS 代码/);
});

test('JsRunner null 代码报错', async () => {
  const runner = new JsRunner(registry);
  const r = await runner.run(null, null);
  assert.strictEqual(r.success, false);
});

test('JsRunner 语法错误返回失败', async () => {
  const runner = new JsRunner(registry);
  let r;
  try { r = await runner.run('const = ;', process.cwd()); } catch (e) { r = { success: false, error: e.message }; }
  assert.strictEqual(r.success, false);
  assert.ok(r.error);
});

test('JsRunner 调用 read 工具', async () => {
  const runner = new JsRunner(registry);
  const r = await runner.run('const c = await read("package.json"); log(c.slice(0, 20));', process.cwd());
  assert.strictEqual(r.success, true);
  assert.ok(r.output.length > 0);
});

test('JsRunner 未知工具报错', async () => {
  const runner = new JsRunner(registry);
  const r = await runner.run('await read("a.txt")', null);
  assert.strictEqual(r.success, false);
  assert.ok(r.error);
});

test('JsRunner 沙箱支持 sleep', async () => {
  const runner = new JsRunner(registry);
  const t0 = Date.now();
  const r = await runner.run('await sleep(50); log("done");', process.cwd());
  assert.strictEqual(r.success, true);
  assert.ok(r.output.includes('done'));
  assert.ok(Date.now() - t0 >= 40);
});

test('JsRunner 沙箱支持 setTimeout', async () => {
  const runner = new JsRunner(registry);
  const r = await runner.run('await new Promise(res => setTimeout(() => { log("timed"); res(); }, 30));', process.cwd());
  assert.strictEqual(r.success, true);
  assert.ok(r.output.includes('timed'));
});

// ===== 重复调用提醒（033）=====

test('JsRunner 连续相同调用第三次起，提醒拼进 output 开头', async () => {
  const { resetAll } = await import('../../src/tools/runtime/repeat-guard.js');
  resetAll();
  const runner = new JsRunner(registry);
  const sid = 'repeat-e2e-' + Date.now();
  const code = 'const a = await todoWrite([{content:"x",status:"pending"}]); log("ran");';
  await runner.run(code, process.cwd(), 1, { sessionId: sid });
  await runner.run(code, process.cwd(), 1, { sessionId: sid });
  const r = await runner.run(code, process.cwd(), 1, { sessionId: sid });
  assert.strictEqual(r.success, true);
  assert.match(r.output, /重复调用提醒/);
  // 提醒必须在开头——尾部会被截断逻辑切掉
  assert.ok(r.output.indexOf('重复调用提醒') < r.output.indexOf('ran'), '提醒应拼在输出开头');
});

test('JsRunner 重复提醒不污染工具返回值契约（沙箱内拿到的 data 不含提醒）', async () => {
  const { resetAll } = await import('../../src/tools/runtime/repeat-guard.js');
  resetAll();
  const runner = new JsRunner(registry);
  const sid = 'repeat-contract-' + Date.now();
  // 沙箱里 r 是工具 data。若提醒被错误塞进 data，r 里就会出现"重复调用提醒"字样，
  // AI 基于 data 做的字符串/字段处理都会被污染。提醒只允许出现在最终 output。
  let sawReminderInsideSandbox = false;
  let hintSeenInOutput = false;
  for (let i = 0; i < 4; i++) {
    const r = await runner.run(
      'const v = await todoWrite([{content:"x",status:"pending"}]);'
      + 'if (String(v).indexOf("重复调用提醒") !== -1) { log("POLLUTED"); } else { log("CLEAN"); }',
      process.cwd(), 1, { sessionId: sid }
    );
    assert.strictEqual(r.success, true, '第 ' + (i + 1) + ' 次应成功: ' + r.error);
    if (r.output.includes('POLLUTED')) sawReminderInsideSandbox = true;
    assert.ok(r.output.includes('CLEAN'), '沙箱内 data 应不含提醒');
    // 第 3 次起（阈值=3）提醒应出现在 output 里
    if (i >= 2) hintSeenInOutput = hintSeenInOutput || /重复调用提醒/.test(r.output);
  }
  assert.strictEqual(sawReminderInsideSandbox, false);
  assert.ok(hintSeenInOutput, '第 3 次起 output 应带提醒（证明提醒确实发出）');
});

test('JsRunner 不同参数不触发提醒（轮询 offset 变化合法）', async () => {
  const { resetAll } = await import('../../src/tools/runtime/repeat-guard.js');
  resetAll();
  const runner = new JsRunner(registry);
  const sid = 'repeat-neg-' + Date.now();
  for (let i = 1; i <= 4; i++) {
    const r = await runner.run(
      'await read("package.json", { offset: ' + i + ', limit: 2 }); log("ok");',
      process.cwd(), 1, { sessionId: sid }
    );
    assert.strictEqual(r.success, true);
    assert.ok(!r.output.includes('重复调用提醒'), '第 ' + i + ' 次不应提醒');
  }
});

