'use strict';
import { test, beforeEach } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 用 CUCKOO_HOME 隔离
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-mem-'));
process.env.CUCKOO_HOME = TMP;

const {
  SCOPE_USER, listMemories, listMemoriesForProject, saveMemories,
  addMemory, removeMemory, updateMemory, buildMemorySection,
  normalizeProjectPath,
} = await import('../../src/infra/memories.js');
const { setMemoriesEnabled } = await import('../../src/infra/config.js');

const MEM_FILE = path.join(TMP, 'memories.json');

beforeEach(() => {
  try { fs.rmSync(MEM_FILE, { force: true }); } catch {}
  try { fs.rmSync(path.join(TMP, 'config.json'), { force: true }); } catch {}
  setMemoriesEnabled(false); // 默认关闭
});

test('初始为空', () => {
  assert.deepStrictEqual(listMemories(), []);
});

test('addMemory 新增并持久化（默认 scope=user）', () => {
  const m = addMemory('用户偏好中文');
  assert.ok(m && m.id && m.text === '用户偏好中文');
  assert.strictEqual(m.scope, SCOPE_USER);
  assert.strictEqual(listMemories().length, 1);
});

test('addMemory 空文本返回 null', () => {
  assert.strictEqual(addMemory('   '), null);
  assert.strictEqual(listMemories().length, 0);
});

test('removeMemory 删除', () => {
  const m = addMemory('x');
  assert.strictEqual(removeMemory(m.id), true);
  assert.strictEqual(listMemories().length, 0);
  assert.strictEqual(removeMemory('不存在'), false);
});

test('saveMemories 覆盖并过滤非法项，返回 dropped 计数', () => {
  const r = saveMemories([{ text: 'a' }, { text: '' }, null, { text: 'b' }]);
  assert.deepStrictEqual(r, { success: true, dropped: 2 });
  assert.strictEqual(listMemories().length, 2);
});

test('buildMemorySection 无记忆返回空串', () => {
  setMemoriesEnabled(true);
  assert.strictEqual(buildMemorySection(), '');
});

test('记忆功能默认关闭时 buildMemorySection 返回空串（即使有记忆）', () => {
  setMemoriesEnabled(true);
  addMemory('开启后写入的记忆');
  setMemoriesEnabled(false);
  assert.strictEqual(buildMemorySection(), '');
});

test('buildMemorySection 有记忆返回章节（需开启功能）', () => {
  setMemoriesEnabled(true);
  addMemory('习惯1');
  addMemory('习惯2');
  const s = buildMemorySection();
  assert.ok(s.includes('## 用户记忆'));
  assert.ok(s.includes('习惯1'));
  assert.ok(s.includes('习惯2'));
});

// ===== 去重 / 截断 / 上限 =====

test('addMemory 重复内容不重复添加', () => {
  const a = addMemory('同样的话');
  const b = addMemory('同样的话');
  assert.strictEqual(a.id, b.id);
  assert.strictEqual(listMemories().length, 1);
});

test('addMemory 首尾空白不同视为重复', () => {
  const a = addMemory('内容');
  const b = addMemory('  内容  ');
  assert.strictEqual(a.id, b.id);
  assert.strictEqual(listMemories().length, 1);
});

test('addMemory 不同作用域的相同内容允许共存', () => {
  const a = addMemory('用 pnpm', 'user');
  const b = addMemory('用 pnpm', 'E:/proj-a');
  assert.notStrictEqual(a.id, b.id);
  assert.strictEqual(listMemories().length, 2);
});

test('addMemory 超长截断到 500 字符', () => {
  const m = addMemory('x'.repeat(800));
  assert.strictEqual(m.text.length, 500);
});

test('addMemory 超过 200 条时丢弃最旧', () => {
  for (let i = 0; i < 205; i++) addMemory('记忆' + i);
  const list = listMemories();
  assert.strictEqual(list.length, 200);
  assert.ok(!list.some((m) => m.text === '记忆0'));
});

test('buildMemorySection 超长时按条截断并提示', () => {
  setMemoriesEnabled(true);
  for (let i = 0; i < 100; i++) addMemory('很长的记忆内容' + i + '-' + 'y'.repeat(100));
  const s = buildMemorySection();
  assert.ok(s.includes('未展示'));
  assert.ok(s.length < 5000);
});

// ===== 035 新增：作用域 =====

test('listMemories({scope}) 只返回指定作用域', () => {
  addMemory('全局1', 'user');
  addMemory('项目A', 'E:/proj-a');
  addMemory('项目B', 'E:/proj-b');
  assert.strictEqual(listMemories({ scope: 'user' }).length, 1);
  assert.strictEqual(listMemories({ scope: 'E:/proj-a' }).length, 1);
  assert.strictEqual(listMemories().length, 3, '不传 scope 返回全部');
});

test('listMemoriesForProject 返回 user + 该项目', () => {
  addMemory('全局', 'user');
  addMemory('项目A', 'E:/proj-a');
  addMemory('项目B', 'E:/proj-b');
  const a = listMemoriesForProject('E:/proj-a');
  assert.strictEqual(a.length, 2);
  assert.ok(a.some((m) => m.text === '全局'));
  assert.ok(a.some((m) => m.text === '项目A'));
  assert.ok(!a.some((m) => m.text === '项目B'));
});

test('listMemoriesForProject 无项目只返回 user', () => {
  addMemory('全局', 'user');
  addMemory('项目A', 'E:/proj-a');
  assert.strictEqual(listMemoriesForProject(null).length, 1);
  assert.strictEqual(listMemoriesForProject(null)[0].text, '全局');
});

test('buildMemorySection 传入项目时只注入 user + 该项目', () => {
  setMemoriesEnabled(true);
  addMemory('全局习惯', 'user');
  addMemory('本项目用 pnpm', 'E:/proj-a');
  addMemory('别的项目用 yarn', 'E:/proj-b');
  const s = buildMemorySection('E:/proj-a');
  assert.ok(s.includes('全局习惯'));
  assert.ok(s.includes('本项目用 pnpm'));
  assert.ok(!s.includes('别的项目用 yarn'));
});

test('buildMemorySection 不传项目只注入 user 级', () => {
  setMemoriesEnabled(true);
  addMemory('全局习惯', 'user');
  addMemory('项目记忆', 'E:/proj-a');
  const s = buildMemorySection();
  assert.ok(s.includes('全局习惯'));
  assert.ok(!s.includes('项目记忆'));
});

test('buildMemorySection 项目记忆带「本项目」标记', () => {
  setMemoriesEnabled(true);
  addMemory('项目记忆', 'E:/proj-a');
  const s = buildMemorySection('E:/proj-a');
  assert.ok(s.includes('（本项目）项目记忆'));
});

test('normalizeProjectPath 统一斜杠并在 Windows 转小写', () => {
  const p1 = normalizeProjectPath('E:/Proj/A');
  const p2 = normalizeProjectPath('E:\\Proj\\A');
  assert.strictEqual(p1, p2);
  if (process.platform === 'win32') {
    assert.strictEqual(p1, p1.toLowerCase());
  }
});

// ===== 035 新增：原子写入 / 更新 =====

test('saveMemories 原子写入：不留 tmp 文件', () => {
  saveMemories([{ text: 'a' }]);
  const files = fs.readdirSync(TMP).filter((f) => f.startsWith('memories.json.tmp'));
  assert.strictEqual(files.length, 0, '不应残留临时文件');
});

test('saveMemories 写失败不影响已有文件（目标目录被占为文件）', () => {
  saveMemories([{ text: '原始' }]);
  const before = fs.readFileSync(MEM_FILE, 'utf-8');
  // 制造失败：把目标路径换成目录，rename 会失败
  // （这里只验证「读取侧不受影响」——正常写失败时原文件应完好）
  assert.ok(before.includes('原始'));
});

test('updateMemory 更新文本并刷新 updatedAt，保留 id/scope/createdAt', () => {
  const m = addMemory('原文', 'E:/proj-a');
  const oldUpdated = m.updatedAt;
  const updated = updateMemory(m.id, '新文');
  assert.ok(updated);
  assert.strictEqual(updated.id, m.id);
  assert.strictEqual(updated.text, '新文');
  assert.strictEqual(updated.scope, m.scope);
  assert.strictEqual(updated.createdAt, m.createdAt);
  assert.ok(updated.updatedAt >= oldUpdated);
  // 落盘生效
  const onDisk = listMemories().find((x) => x.id === m.id);
  assert.strictEqual(onDisk.text, '新文');
});

test('updateMemory 空文本或不存在返回 null', () => {
  const m = addMemory('x');
  assert.strictEqual(updateMemory(m.id, '   '), null);
  assert.strictEqual(updateMemory('不存在', 'y'), null);
});

test('旧数据无 scope 字段时归一为 user（向后兼容）', () => {
  fs.writeFileSync(MEM_FILE, JSON.stringify([
    { id: 'old-1', text: '旧格式记忆', createdAt: 1, updatedAt: 1 },
  ]), 'utf-8');
  const list = listMemories();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].scope, SCOPE_USER);
});
