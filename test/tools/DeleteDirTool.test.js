'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeleteDirTool, resolveAndGuard, countEntries } from '../../src/tools/impl/delete-dir.js';

function tmpRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-dd-' + tag + '-'));
}

test('resolveAndGuard 拒绝空路径', () => {
  assert.ok(resolveAndGuard('', null).error);
  assert.ok(resolveAndGuard(null, null).error);
  assert.ok(resolveAndGuard(123, null).error);
});

test('resolveAndGuard 拒绝磁盘根', () => {
  const root = path.parse(process.cwd()).root;
  assert.ok(resolveAndGuard(root, null).error);
});

test('resolveAndGuard 拒绝用户主目录', () => {
  assert.ok(resolveAndGuard(os.homedir(), null).error);
});

test('resolveAndGuard 拒绝项目根目录本身', () => {
  const proj = tmpRoot('proj');
  try {
    const r = resolveAndGuard(proj, proj);
    assert.ok(r.error && r.error.includes('项目根目录'));
  } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});

test('resolveAndGuard 允许项目内子目录', () => {
  const proj = tmpRoot('proj2');
  try {
    const sub = path.join(proj, 'sub');
    fs.mkdirSync(sub);
    const r = resolveAndGuard('sub', proj);
    assert.strictEqual(r.error, undefined);
    assert.strictEqual(r.absPath, path.resolve(sub));
  } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});

test('countEntries 递归计数（不跟随符号链接）', () => {
  const d = tmpRoot('count');
  try {
    fs.mkdirSync(path.join(d, 'a'));
    fs.mkdirSync(path.join(d, 'a', 'b'));
    fs.writeFileSync(path.join(d, 'a', 'b', 'f.txt'), 'x');
    fs.writeFileSync(path.join(d, 'g.txt'), 'y');
    // a, a/b, a/b/f.txt, g.txt = 4
    assert.strictEqual(countEntries(d), 4);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('deleteDir 拒绝删除非空目录（未传 recursive）', async () => {
  const proj = tmpRoot('nonempty');
  try {
    const sub = path.join(proj, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'x.txt'), 'x');
    const tool = new DeleteDirTool();
    const r = await tool.execute({ dirPath: 'sub', projectDir: proj });
    assert.strictEqual(r.success, false);
    assert.ok(String(r.error).includes('非空'));
    assert.ok(fs.existsSync(sub), '目录应仍存在');
  } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});

test('deleteDir 空目录直接删除', async () => {
  const proj = tmpRoot('empty');
  try {
    const sub = path.join(proj, 'sub');
    fs.mkdirSync(sub);
    const tool = new DeleteDirTool();
    const r = await tool.execute({ dirPath: 'sub', projectDir: proj });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.data.deleted, 0);
    assert.ok(!fs.existsSync(sub));
  } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});

test('deleteDir dryRun 只预览不删除', async () => {
  const proj = tmpRoot('dry');
  try {
    const sub = path.join(proj, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'a.txt'), 'a');
    fs.writeFileSync(path.join(sub, 'b.txt'), 'b');
    const tool = new DeleteDirTool();
    const r = await tool.execute({ dirPath: 'sub', projectDir: proj, options: { recursive: true, dryRun: true } });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.data.deleted, 2);
    assert.ok(fs.existsSync(sub), 'dryRun 不应删除');
  } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});

test('deleteDir recursive 真正删除非空目录', async () => {
  const proj = tmpRoot('rec');
  try {
    const sub = path.join(proj, 'sub');
    fs.mkdirSync(path.join(sub, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(sub, 'nested', 'f.txt'), 'x');
    const tool = new DeleteDirTool();
    const r = await tool.execute({ dirPath: 'sub', projectDir: proj, options: { recursive: true } });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.data.deleted, 2); // nested + f.txt
    assert.ok(!fs.existsSync(sub));
  } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});

test('deleteDir 拒绝删除文件（应走 deleteFile）', async () => {
  const proj = tmpRoot('isfile');
  try {
    const f = path.join(proj, 'a.txt');
    fs.writeFileSync(f, 'x');
    const tool = new DeleteDirTool();
    const r = await tool.execute({ dirPath: 'a.txt', projectDir: proj });
    assert.strictEqual(r.success, false);
    assert.ok(String(r.error).includes('不是目录'));
    assert.ok(fs.existsSync(f));
  } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});

test('deleteDir 目录不存在时给出 NOT_FOUND', async () => {
  const proj = tmpRoot('nf');
  try {
    const tool = new DeleteDirTool();
    const r = await tool.execute({ dirPath: 'nope', projectDir: proj });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.code, 'NOT_FOUND');
  } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});

test('deleteDir 拒绝受保护路径', async () => {
  const prev = process.env.CUCKOO_HOME;
  const fakeHome = tmpRoot('home');
  process.env.CUCKOO_HOME = fakeHome;
  try {
    const snap = path.join(fakeHome, 'snapshots');
    fs.mkdirSync(snap, { recursive: true });
    const tool = new DeleteDirTool();
    const r = await tool.execute({ dirPath: snap });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.code, 'PROTECTED_PATH');
    assert.ok(fs.existsSync(snap));
  } finally {
    if (prev === undefined) delete process.env.CUCKOO_HOME; else process.env.CUCKOO_HOME = prev;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
