/**
 * 记忆工具测试（035）：listMemories / remember scope / forgetMemory。
 * 用真实存储层（CUCKOO_HOME 隔离），只 mock 工具层的存储注入。
 */
import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-memtool-'));
process.env.CUCKOO_HOME = TMP;

const { RememberTool, ForgetMemoryTool, ListMemoriesTool, injectMemoryStore, resetMemoryStore } =
  await import('../../src/tools/impl/remember.js');
const { addMemory, removeMemory, listMemories } = await import('../../src/infra/memories.js');
const { setMemoriesEnabled } = await import('../../src/infra/config.js');

/** 接真实存储层（不 mock 内部模块，符合项目测试原则） */
function wireStore() {
  injectMemoryStore({
    add: (text, scope) => { const m = addMemory(text, scope); return m ? { id: m.id, scope: m.scope } : null; },
    remove: (id) => removeMemory(id),
    list: () => listMemories().map((m) => ({ id: m.id, text: m.text, scope: m.scope, createdAt: m.createdAt })),
  });
}

beforeEach(() => {
  try { fs.rmSync(path.join(TMP, 'memories.json'), { force: true }); } catch {}
  try { fs.rmSync(path.join(TMP, 'config.json'), { force: true }); } catch {}
  setMemoriesEnabled(true);
  wireStore();
});

afterEach(() => {
  resetMemoryStore();
  setMemoriesEnabled(false);
});

test('功能关闭时三个工具都拒绝', async () => {
  setMemoriesEnabled(false);
  const r1 = await new RememberTool().execute({ text: 'x' });
  const r2 = await new ForgetMemoryTool().execute({ id: 'x' });
  const r3 = await new ListMemoriesTool().execute({});
  assert.strictEqual(r1.success, false);
  assert.strictEqual(r2.success, false);
  assert.strictEqual(r3.success, false);
  assert.match(r1.error, /已关闭/);
});

test('remember 默认写 user 作用域', async () => {
  const r = await new RememberTool().execute({ text: '用户偏好中文' });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data.scope, 'user');
  assert.ok(r.data.id);
  assert.strictEqual(listMemories()[0].scope, 'user');
});

test('remember scope=project 需要项目上下文', async () => {
  const r = await new RememberTool().execute({ text: '这个仓库用 pnpm', scope: 'project' });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /无项目上下文|scope 非法/);
});

test('remember scope=project 有项目时写入项目路径', async () => {
  const r = await new RememberTool().execute({
    text: '这个仓库用 pnpm', scope: 'project', projectDir: 'E:/proj-a',
  });
  assert.strictEqual(r.success, true);
  assert.ok(r.data.scope !== 'user');
  assert.ok(r.data.scope.includes('proj-a'));
});

test('listMemories 默认返回 user + 当前项目', async () => {
  await new RememberTool().execute({ text: '全局', scope: 'user' });
  await new RememberTool().execute({ text: '项目A', scope: 'project', projectDir: 'E:/proj-a' });
  await new RememberTool().execute({ text: '项目B', scope: 'project', projectDir: 'E:/proj-b' });

  const r = await new ListMemoriesTool().execute({ projectDir: 'E:/proj-a' });
  assert.strictEqual(r.success, true);
  const texts = r.data.map((m) => m.text);
  assert.ok(texts.includes('全局'));
  assert.ok(texts.includes('项目A'));
  assert.ok(!texts.includes('项目B'), '别的项目记忆不应出现');
});

test('listMemories 返回的 scope 是标签而非绝对路径', async () => {
  await new RememberTool().execute({ text: '项目A', scope: 'project', projectDir: 'E:/proj-a' });
  const r = await new ListMemoriesTool().execute({ projectDir: 'E:/proj-a' });
  assert.strictEqual(r.data[0].scope, 'project');
});

test('listMemories scope=user 只返回用户级', async () => {
  await new RememberTool().execute({ text: '全局', scope: 'user' });
  await new RememberTool().execute({ text: '项目A', scope: 'project', projectDir: 'E:/proj-a' });
  const r = await new ListMemoriesTool().execute({ scope: 'user', projectDir: 'E:/proj-a' });
  assert.strictEqual(r.data.length, 1);
  assert.strictEqual(r.data[0].text, '全局');
});

test('listMemories scope=project 无项目上下文时报错', async () => {
  const r = await new ListMemoriesTool().execute({ scope: 'project' });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /无项目上下文/);
});

test('forgetMemory 用 listMemories 拿到的 id 能删除', async () => {
  await new RememberTool().execute({ text: '待删除' });
  const listed = await new ListMemoriesTool().execute({});
  const id = listed.data[0].id;
  const r = await new ForgetMemoryTool().execute({ id });
  assert.strictEqual(r.success, true);
  assert.strictEqual(listMemories().length, 0);
});

test('forgetMemory 不存在时提示去 listMemories 查', async () => {
  const r = await new ForgetMemoryTool().execute({ id: '不存在' });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /listMemories/);
});

test('无存储注入时报"未初始化"', async () => {
  resetMemoryStore();
  const r = await new RememberTool().execute({ text: 'x' });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /未初始化/);
});

test('remember 空内容拒绝', async () => {
  const r = await new RememberTool().execute({ text: '   ' });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /内容为空/);
});
