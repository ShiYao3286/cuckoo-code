/**
 * 全局配置读写测试，重点覆盖 BOM 容错（035 排查发现）。
 */
import { test, beforeEach } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-cfg-'));
process.env.CUCKOO_HOME = TMP;

const { readConfig, writeConfig, isMemoriesEnabled, setMemoriesEnabled, getEnabledToolFeatures } =
  await import('../../src/infra/config.js');

const CFG = path.join(TMP, 'config.json');

beforeEach(() => {
  try { fs.rmSync(CFG, { force: true }); } catch {}
  // 清缓存：写一次默认值再删（writeConfig 内部会清）
  writeConfig({ memoriesEnabled: false, fsGuardEnabled: true, repeatCallThreshold: 3 });
  try { fs.rmSync(CFG, { force: true }); } catch {}
});

test('文件不存在时返回默认值', () => {
  const c = readConfig();
  assert.strictEqual(c.memoriesEnabled, false);
  assert.strictEqual(c.fsGuardEnabled, true);
  assert.strictEqual(c.repeatCallThreshold, 3);
});

test('正常读写往返', () => {
  writeConfig({ memoriesEnabled: true });
  assert.strictEqual(isMemoriesEnabled(), true);
  assert.strictEqual(readConfig().fsGuardEnabled, true, '未指定的字段保持原值');
});

test('BOM 容错：带 BOM 的配置能正确读取（关键回归）', () => {
  // 模拟 PowerShell Set-Content -Encoding UTF8 / 记事本保存
  fs.writeFileSync(CFG, Buffer.concat([
    Buffer.from([0xEF, 0xBB, 0xBF]),
    Buffer.from(JSON.stringify({ memoriesEnabled: true, fsGuardEnabled: false, repeatCallThreshold: 5 }), 'utf-8'),
  ]));
  const c = readConfig();
  assert.strictEqual(c.memoriesEnabled, true, 'BOM 不应导致解析失败回退默认值');
  assert.strictEqual(c.fsGuardEnabled, false);
  assert.strictEqual(c.repeatCallThreshold, 5);
});

test('非法 JSON 回退默认值（不抛异常）', () => {
  fs.writeFileSync(CFG, '{invalid', 'utf-8');
  const c = readConfig();
  assert.strictEqual(c.memoriesEnabled, false);
  assert.strictEqual(c.fsGuardEnabled, true);
});

test('writeConfig 写出的文件不带 BOM', () => {
  writeConfig({ memoriesEnabled: true });
  const buf = fs.readFileSync(CFG);
  const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  assert.strictEqual(hasBom, false);
});

test('fsGuardEnabled 默认开：旧配置无此字段视为启用', () => {
  fs.writeFileSync(CFG, JSON.stringify({ memoriesEnabled: false }), 'utf-8');
  assert.strictEqual(readConfig().fsGuardEnabled, true);
});

test('fsGuardEnabled 显式 false 才关闭', () => {
  writeConfig({ fsGuardEnabled: false });
  assert.strictEqual(readConfig().fsGuardEnabled, false);
});

test('getEnabledToolFeatures：记忆关闭时为空，开启时为 [memories]', () => {
  setMemoriesEnabled(false);
  assert.deepStrictEqual(getEnabledToolFeatures(), []);
  setMemoriesEnabled(true);
  assert.deepStrictEqual(getEnabledToolFeatures(), ['memories']);
});

test('缓存失效：外部改动（改了 size）能被读到', () => {
  writeConfig({ memoriesEnabled: false });
  assert.strictEqual(isMemoriesEnabled(), false);
  // 外部写一个长度不同的内容（带 BOM 也不算，这里用不同字段数）
  fs.writeFileSync(CFG, JSON.stringify({ memoriesEnabled: true, fsGuardEnabled: true, repeatCallThreshold: 3, extra: 1 }), 'utf-8');
  assert.strictEqual(isMemoriesEnabled(), true, 'size 变了应失效缓存');
});
