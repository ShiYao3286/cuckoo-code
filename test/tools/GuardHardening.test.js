'use strict';
import { test, describe, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { ReadTool } from '../../src/tools/impl/read.js';
import { EditTool } from '../../src/tools/impl/edit.js';
import { WriteTool } from '../../src/tools/impl/write.js';
import { DeleteFileTool } from '../../src/tools/impl/delete-file.js';
import { clearAll, statVersion, getObservation } from '../../src/tools/runtime/fs-observation.js';
import { buildTruncatedOutput, getSpillDir } from '../../src/tools/runtime/spill.js';
import { writeConfig } from '../../src/infra/config.js';

const tmpRoot = path.join(process.cwd(), 'test', 'tmp', 'guard2');
let sid;
let seq = 0;

/**
 * 配置隔离：所有用例写自己的 CUCKOO_HOME，避免污染用户真实的 ~/.cuckoo，
 * 也避免用例之间因共用配置文件 + mtime 精度而互相干扰。
 */
const testHome = path.join(process.cwd(), 'test', 'tmp', 'guard2-home');
const origHome = process.env.CUCKOO_HOME;

beforeEach(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
  fs.mkdirSync(testHome, { recursive: true });
  process.env.CUCKOO_HOME = testHome;
  clearAll();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  sid = 's2-' + (++seq);
  writeConfig({ fsGuardEnabled: true });
});

afterEach(() => {
  if (origHome === undefined) delete process.env.CUCKOO_HOME;
  else process.env.CUCKOO_HOME = origHome;
  fs.rmSync(testHome, { recursive: true, force: true });
});

function write(name, content) { fs.writeFileSync(path.join(tmpRoot, name), content); }
function bumpMtime(name, deltaMs = 2000) {
  const p = path.join(tmpRoot, name);
  const st = fs.statSync(p);
  const t = new Date(st.mtimeMs + deltaMs);
  fs.utimesSync(p, t, t);
}

describe('write 也做版本比对（与 edit 一致）', () => {
  test('read 后文件被外部改动 → write 拒绝 STALE_VERSION（此前会直接覆盖）', async () => {
    write('a.txt', 'original');
    await new ReadTool().execute({ filePath: 'a.txt', projectDir: tmpRoot, sessionId: sid });
    // 外部改动：内容变了、mtime 也变了
    fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'changed by someone else');
    bumpMtime('a.txt');

    const r = await new WriteTool().execute({ filePath: 'a.txt', content: 'my new content', projectDir: tmpRoot, sessionId: sid });
    assert.strictEqual(r.success, false, '应拒绝覆盖');
    assert.strictEqual(r.code, 'STALE_VERSION');
    assert.strictEqual(fs.readFileSync(path.join(tmpRoot, 'a.txt'), 'utf8'), 'changed by someone else', '外部改动必须保留');
  });

  test('read 后文件未变 → write 正常覆盖', async () => {
    write('b.txt', 'original');
    await new ReadTool().execute({ filePath: 'b.txt', projectDir: tmpRoot, sessionId: sid });
    const r = await new WriteTool().execute({ filePath: 'b.txt', content: 'replaced', projectDir: tmpRoot, sessionId: sid });
    assert.strictEqual(r.success, true);
    assert.strictEqual(fs.readFileSync(path.join(tmpRoot, 'b.txt'), 'utf8'), 'replaced');
  });

  test('自写后连续 write 仍允许（自改即已观察）', async () => {
    const w = new WriteTool();
    await w.execute({ filePath: 'c.txt', content: 'v1', projectDir: tmpRoot, sessionId: sid });
    const r = await w.execute({ filePath: 'c.txt', content: 'v2', projectDir: tmpRoot, sessionId: sid });
    assert.strictEqual(r.success, true);
    assert.strictEqual(fs.readFileSync(path.join(tmpRoot, 'c.txt'), 'utf8'), 'v2');
  });
});

describe('版本代理的内容指纹（修同毫秒等长修改漏判）', () => {
  test('同毫秒、等长、mtime 不变的内容替换，版本串仍能区分', async () => {
    const p = path.join(tmpRoot, 'fp.txt');
    fs.writeFileSync(p, 'AAAA');
    const v1 = statVersion(p);
    fs.writeFileSync(p, 'BBBB');
    const v2 = statVersion(p);
    // 前提确认：mtime/size 确实可能相同（这正是之前的漏洞）
    const s1 = fs.statSync(p).size;
    assert.strictEqual(s1, 4, '等长');
    assert.notStrictEqual(v1, v2, '内容不同则版本串必须不同（指纹生效）');
  });

  test('read → 同毫秒等长外部改写 → edit 被 STALE_VERSION 拦住', async () => {
    const p = path.join(tmpRoot, 'fp2.txt');
    fs.writeFileSync(p, 'hello world');
    await new ReadTool().execute({ filePath: 'fp2.txt', projectDir: tmpRoot, sessionId: sid });
    // 等长替换（11 字节 → 11 字节），不碰 mtime
    fs.writeFileSync(p, 'HELLO WORLD');
    const r = await new EditTool().execute({
      filePath: 'fp2.txt', oldString: 'hello', newString: 'hi', projectDir: tmpRoot, sessionId: sid,
    });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.code, 'STALE_VERSION');
    assert.strictEqual(fs.readFileSync(p, 'utf8'), 'HELLO WORLD');
  });
});

describe('deleteFile 护栏', () => {
  test('未读过的文件 → 拒绝删除，码 NOT_OBSERVED，文件仍在', async () => {
    write('victim.txt', 'important');
    const r = await new DeleteFileTool().execute({ filePath: 'victim.txt', projectDir: tmpRoot, sessionId: sid });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.code, 'NOT_OBSERVED');
    assert.ok(fs.existsSync(path.join(tmpRoot, 'victim.txt')), '文件不应被删除');
  });

  test('read 之后可以删除', async () => {
    write('bye.txt', 'x');
    await new ReadTool().execute({ filePath: 'bye.txt', projectDir: tmpRoot, sessionId: sid });
    const r = await new DeleteFileTool().execute({ filePath: 'bye.txt', projectDir: tmpRoot, sessionId: sid });
    assert.strictEqual(r.success, true);
    assert.strictEqual(fs.existsSync(path.join(tmpRoot, 'bye.txt')), false);
  });

  test('关闭护栏后可删未读文件', async () => {
    writeConfig({ fsGuardEnabled: false });
    try {
      write('nofilter.txt', 'x');
      const r = await new DeleteFileTool().execute({ filePath: 'nofilter.txt', projectDir: tmpRoot, sessionId: sid });
      assert.strictEqual(r.success, true);
    } finally {
      writeConfig({ fsGuardEnabled: true });
    }
  });
});

describe('长输出落盘（spill）', () => {
  test('超限输出落盘，回传文本含路径与读法提示', async () => {
    clearAll();
    fs.rmSync(getSpillDir(), { recursive: true, force: true });
    const big = 'A'.repeat(30000) + '\nMIDDLE\n' + 'B'.repeat(10000);
    const out = buildTruncatedOutput(big, 20000, 'spill-sess');
    assert.ok(out.length < big.length, '回传文本应短于原文');
    assert.match(out, /【完整输出已落盘】/);
    assert.match(out, /grep\(pattern/);
    assert.match(out, /read\(/);
    // 从提示里抠出路径并验证文件真实存在、内容完整
    const m = out.match(/【完整输出已落盘】([^\n]+)/);
    assert.ok(m, '应给出落盘路径');
    const file = m[1].trim();
    assert.ok(fs.existsSync(file), '落盘文件应存在: ' + file);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), big, '落盘内容应完整');
  });

  test('未超限则原样返回，不落盘', () => {
    const small = 'short output';
    assert.strictEqual(buildTruncatedOutput(small, 20000, 'x'), small);
  });

  test('会话 id 含路径特殊字符时不会逃逸目录', async () => {
    fs.rmSync(getSpillDir(), { recursive: true, force: true });
    const big = 'x'.repeat(25000);
    const out = buildTruncatedOutput(big, 20000, '../../evil/../sid');
    const m = out.match(/【完整输出已落盘】([^\n]+)/);
    const file = m[1].trim();
    // 真正的断言是"没有逃出 spill 目录"，而不是"字面不含 .."——
    // 清理后的名字形如 .._.._evil_.._sid，含 ".." 子串但仍在目录内，是合法的。
    const resolved = path.resolve(file);
    const dir = path.resolve(getSpillDir());
    assert.ok(resolved.startsWith(dir + path.sep), '必须落在 spill 目录内: ' + resolved);
    assert.ok(fs.existsSync(file), '文件应真实存在于该路径');
  });
});
