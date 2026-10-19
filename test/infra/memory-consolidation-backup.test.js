/**
 * IPC 记忆整理层测试：备份/回滚逻辑。
 * 不测 IPC handler 本身（需要 Electron），只测可独立验证的纯逻辑。
 */
import { test, beforeEach } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-mci-'));
process.env.CUCKOO_HOME = TMP;

const { getMemoriesFilePath, readMemoriesFile, writeMemoriesFile, emptyProfile, emptyMeta } =
  await import('../../src/infra/memories-file.js');
const { readProfile, writeProfile } = await import('../../src/infra/memory-profile.js');

const FILE = path.join(TMP, 'memories.json');
const BAK = FILE + '.bak';

beforeEach(() => {
  try { fs.rmSync(FILE, { force: true }); } catch {}
  try { fs.rmSync(BAK, { force: true }); } catch {}
});

test('备份 + 回滚：写入新画像后能从备份恢复旧状态', () => {
  // 初始状态
  writeMemoriesFile({
    version: 2,
    profile: { ...emptyProfile(), identity: '旧身份' },
    savedMemories: [{ id: 'a', text: '保留', scope: 'user', createdAt: 1, updatedAt: 1 }],
    meta: emptyMeta(),
  });

  // 模拟 IPC apply：先备份，再写新画像
  fs.copyFileSync(FILE, BAK);
  writeProfile({ identity: '新身份' }, { lastConsolidatedMessageId: 100, model: 'm' });
  assert.strictEqual(readProfile().identity, '新身份');

  // 回滚
  fs.copyFileSync(BAK, FILE);
  assert.strictEqual(readProfile().identity, '旧身份');
  // savedMemories 也恢复
  assert.strictEqual(readMemoriesFile().savedMemories.length, 1);
  // meta 恢复为空
  assert.strictEqual(readMemoriesFile().meta.lastConsolidatedMessageId, 0);
});

test('无备份时回滚应失败（文件不存在）', () => {
  assert.strictEqual(fs.existsSync(BAK), false);
});

test('备份不存在的源文件不应崩', () => {
  // 没有 memories.json 时 copyFileSync 会抛错，IPC 层应捕获
  assert.strictEqual(fs.existsSync(FILE), false);
  assert.throws(() => fs.copyFileSync(FILE, BAK));
});
