/**
 * 存储层 v2 测试：v1 数组自动升级、画像读写、元信息游标。
 */
import { test, beforeEach } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-mf-'));
process.env.CUCKOO_HOME = TMP;

const {
  readMemoriesFile, writeMemoriesFile, getMemoriesFilePath,
  emptyProfile, emptyMeta, normalizeProfile, normalizeMeta,
} = await import('../../src/infra/memories-file.js');
const { readProfile, readMeta, writeProfile, clearProfile, hasProfileContent } =
  await import('../../src/infra/memory-profile.js');

const FILE = path.join(TMP, 'memories.json');

beforeEach(() => {
  try { fs.rmSync(FILE, { force: true }); } catch {}
});

test('文件不存在 → 返回空结构', () => {
  const f = readMemoriesFile();
  assert.strictEqual(f.version, 2);
  assert.deepStrictEqual(f.profile, emptyProfile());
  assert.deepStrictEqual(f.savedMemories, []);
  assert.deepStrictEqual(f.meta, emptyMeta());
});

test('v1 数组格式自动升级为 v2（关键向后兼容）', () => {
  fs.writeFileSync(FILE, JSON.stringify([
    { id: 'a', text: '旧记忆1', createdAt: 1, updatedAt: 1 },
    { id: 'b', text: '旧记忆2', createdAt: 2, updatedAt: 2 },
  ]), 'utf-8');
  const f = readMemoriesFile();
  assert.strictEqual(f.version, 2);
  assert.strictEqual(f.savedMemories.length, 2);
  assert.deepStrictEqual(f.profile, emptyProfile());
});

test('v2 对象格式正常读取', () => {
  fs.writeFileSync(FILE, JSON.stringify({
    version: 2,
    profile: { identity: '开发者', communication: '简洁', engineering: '', environment: '', projects: {}, notes: '' },
    savedMemories: [{ id: 'x', text: 't', scope: 'user', createdAt: 1, updatedAt: 1 }],
    meta: { lastConsolidatedMessageId: 100, lastConsolidatedAt: 999, model: 'test-model' },
  }), 'utf-8');
  const f = readMemoriesFile();
  assert.strictEqual(f.profile.identity, '开发者');
  assert.strictEqual(f.meta.lastConsolidatedMessageId, 100);
  assert.strictEqual(f.meta.model, 'test-model');
});

test('损坏的 JSON → 返回空结构不抛异常', () => {
  fs.writeFileSync(FILE, '{invalid', 'utf-8');
  const f = readMemoriesFile();
  assert.deepStrictEqual(f.savedMemories, []);
});

test('normalizeProfile 容忍不规范输入', () => {
  assert.deepStrictEqual(normalizeProfile(null), emptyProfile());
  assert.deepStrictEqual(normalizeProfile('string'), emptyProfile());
  assert.deepStrictEqual(normalizeProfile([]), emptyProfile());
  // 字段类型错误
  const p = normalizeProfile({ identity: 123, projects: ['a'], notes: null });
  assert.strictEqual(p.identity, '');
  assert.deepStrictEqual(p.projects, {});
  assert.strictEqual(p.notes, '');
  // 合法输入
  const ok = normalizeProfile({ identity: 'x', projects: { 'E:/a': 'y' } });
  assert.strictEqual(ok.identity, 'x');
  assert.deepStrictEqual(ok.projects, { 'E:/a': 'y' });
});

test('normalizeMeta 容忍不规范输入', () => {
  assert.deepStrictEqual(normalizeMeta(null), emptyMeta());
  const m = normalizeMeta({ lastConsolidatedMessageId: 'x', lastConsolidatedAt: 5, model: 123 });
  assert.strictEqual(m.lastConsolidatedMessageId, 0);
  assert.strictEqual(m.lastConsolidatedAt, 5);
  assert.strictEqual(m.model, '');
});

test('writeProfile 只改画像，不动 savedMemories', () => {
  fs.writeFileSync(FILE, JSON.stringify({
    version: 2,
    profile: emptyProfile(),
    savedMemories: [{ id: 'x', text: '保留我', scope: 'user', createdAt: 1, updatedAt: 1 }],
    meta: emptyMeta(),
  }), 'utf-8');
  const w = writeProfile({ identity: '新身份' });
  assert.strictEqual(w.success, true);
  const f = readMemoriesFile();
  assert.strictEqual(f.profile.identity, '新身份');
  assert.strictEqual(f.savedMemories.length, 1);
  assert.strictEqual(f.savedMemories[0].text, '保留我');
});

test('writeProfile 更新 meta 游标', () => {
  writeProfile({ identity: 'x' }, { lastConsolidatedMessageId: 500, model: 'm1' });
  const meta = readMeta();
  assert.strictEqual(meta.lastConsolidatedMessageId, 500);
  assert.strictEqual(meta.model, 'm1');
  assert.ok(meta.lastConsolidatedAt > 0);
});

test('writeProfile 后 hasProfileContent 为 true', () => {
  assert.strictEqual(hasProfileContent(), false);
  writeProfile({ identity: 'x' });
  assert.strictEqual(hasProfileContent(), true);
});

test('clearProfile 清空画像但保留 savedMemories', () => {
  fs.writeFileSync(FILE, JSON.stringify({
    version: 2,
    profile: { identity: 'x', communication: '', engineering: '', environment: '', projects: {}, notes: '' },
    savedMemories: [{ id: 'y', text: '保留', scope: 'user', createdAt: 1, updatedAt: 1 }],
    meta: { lastConsolidatedMessageId: 10, lastConsolidatedAt: 20, model: 'm' },
  }), 'utf-8');
  clearProfile();
  const f = readMemoriesFile();
  assert.deepStrictEqual(f.profile, emptyProfile());
  assert.deepStrictEqual(f.meta, emptyMeta());
  assert.strictEqual(f.savedMemories.length, 1);
});

test('readProfile 无文件时返回空画像', () => {
  assert.deepStrictEqual(readProfile(), emptyProfile());
});

test('原子写：不留 tmp 文件', () => {
  writeProfile({ identity: 'x' });
  const tmp = fs.readdirSync(TMP).filter((f) => f.startsWith('memories.json.tmp'));
  assert.strictEqual(tmp.length, 0);
});
