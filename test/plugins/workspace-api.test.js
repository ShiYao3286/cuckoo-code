'use strict';
import { test, describe } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 需求 040：插件工作区 API（ctx.workspace）
 *
 * UI 插件跑在渲染进程，原本只能读自己插件目录（ctx.assets），拿不到项目文件。
 * 这组 API 补上读写能力，并把它们**严格限制在项目目录内**。
 *
 * 本测试覆盖两件事：
 *   1) 链路完整性（IPC / preload / ui-runtime 三段都在）
 *   2) 防目录穿越逻辑的核心规则（用与实现相同的判定式验证边界）
 */

const ROOT = process.cwd();
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

/** 与 ipc/session.ts resolveInProject 相同的判定逻辑（用于独立验证边界规则） */
function isInsideProject(rootDir, relPath) {
  const rootAbs = path.resolve(rootDir);
  const abs = path.resolve(rootDir, relPath);
  return abs === rootAbs || abs.startsWith(rootAbs + path.sep);
}

describe('防目录穿越规则', () => {
  const root = path.join(ROOT, 'test', 'tmp', 'wsfixture');

  test('项目内相对路径放行', () => {
    assert.strictEqual(isInsideProject(root, 'novel/章节/第001章.md'), true);
    assert.strictEqual(isInsideProject(root, 'a.txt'), true);
    assert.strictEqual(isInsideProject(root, './x/y.md'), true);
  });

  test('项目根本身放行', () => {
    assert.strictEqual(isInsideProject(root, '.'), true);
    assert.strictEqual(isInsideProject(root, ''), true);
  });

  test('../ 穿越被拒绝', () => {
    assert.strictEqual(isInsideProject(root, '../evil.txt'), false);
    assert.strictEqual(isInsideProject(root, '../../etc/passwd'), false);
    assert.strictEqual(isInsideProject(root, 'a/../../b.txt'), false);
  });

  test('绝对路径跳出被拒绝', () => {
    assert.strictEqual(isInsideProject(root, 'C:\\Windows\\System32\\drivers\\etc\\hosts'), false);
    assert.strictEqual(isInsideProject(root, '/etc/passwd'), false);
  });

  test('同前缀的兄弟目录不算项目内（classic 前缀绕过）', () => {
    // root = .../wsfixture，而 .../wsfixture-evil 不应被当成内部
    const sibling = root + '-evil';
    const rootAbs = path.resolve(root);
    const abs = path.resolve(sibling);
    assert.strictEqual(abs.startsWith(rootAbs + path.sep), false, '前缀相同但不同目录必须拒绝');
  });
});

describe('工作区 API 链路完整性', () => {
  test('① 主进程有四个 handler', () => {
    const src = read('src/app/ipc/session.ts');
    for (const ch of ['plugin-workspace-read', 'plugin-workspace-write', 'plugin-workspace-list', 'plugin-workspace-exists']) {
      assert.ok(src.includes("'" + ch + "'"), '缺少 handler: ' + ch);
    }
    assert.match(src, /resolveInProject/, '应有统一的路径校验函数');
  });

  test('② 写通道也做穿越校验（不能只给读加防护）', () => {
    const src = read('src/app/ipc/session.ts');
    const idx = src.indexOf("ipcMain.handle('plugin-workspace-write'");
    const body = src.slice(idx, idx + 900);
    assert.match(body, /resolveInProject/, '写也必须走统一校验');
    assert.match(body, /typeof content !== 'string'/, '应校验 content 类型');
  });

  test('③ 读通道拒绝二进制与超大文件（与 read-project-file 一致）', () => {
    const src = read('src/app/ipc/session.ts');
    const idx = src.indexOf("ipcMain.handle('plugin-workspace-read'");
    const body = src.slice(idx, idx + 900);
    assert.match(body, /includes\(0\)/, '应拒绝二进制');
    assert.match(body, /2 \* 1024 \* 1024/, '应有 2MB 上限');
  });

  test('④ preload 暴露四个方法', () => {
    const src = read('src/bridge/api.ts');
    for (const m of ['workspaceRead', 'workspaceWrite', 'workspaceList', 'workspaceExists']) {
      assert.match(src, new RegExp(m + '\\s*:'), 'preload 缺 ' + m);
    }
  });

  test('⑤ ui-runtime 暴露 ctx.workspace', () => {
    const src = read('src/plugins/runtime/ui-runtime.ts');
    assert.match(src, /\(ui as any\)\.workspace\s*=/, '应挂 ctx.workspace');
    for (const m of ['readText', 'writeText', 'list:', 'exists']) {
      assert.ok(src.includes(m), 'ctx.workspace 缺 ' + m);
    }
    assert.match(src, /uiRootCache/, 'root 用缓存（ctx 多为同步接口）');
  });

  test('⑥ ctx.overlay 仍在（改动不能误删既有能力）', () => {
    const src = read('src/plugins/runtime/ui-runtime.ts');
    assert.match(src, /\(ui as any\)\.overlay\s*=/, 'ctx.overlay 不能丢');
    assert.match(src, /setInteractive/, 'ctx.overlay.setInteractive 不能丢');
  });
});
