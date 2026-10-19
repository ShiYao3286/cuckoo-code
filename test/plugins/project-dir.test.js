'use strict';
import { test, describe } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 需求 039：插件拿不到项目目录
 *
 * 根因：HostCapabilities.getProjectDir 原实现读 DOM 元素 `cuckoo-project-dir` 的 textContent，
 * 但全仓库没有任何代码创建该元素（只有 plugin-system.ts 在读取它）→ 永远返回 null。
 * 后果：任何依赖项目目录的插件（如小说写作台要定位正文目录）都无法工作。
 *
 * 真机验证（CDP 查 AI 页面）：document.getElementById('cuckoo-project-dir') === null
 *
 * 修复：改走 IPC 'get-project-dir'（主进程 sessionStore，AI 页面在 getContextByWebContents 范围内），
 * 异步拉取后缓存（插件 ctx 是同步接口），并在 'project-dir-updated' 时刷新。
 */

const ROOT = process.cwd();
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

describe('插件项目目录：链路完整性', () => {
  test('① 主进程有 get-project-dir handler（读 sessionStore）', () => {
    const src = read('src/app/ipc/shell.ts');
    const idx = src.indexOf("ipcMain.handle('get-project-dir'");
    assert.ok(idx > 0, '应存在 get-project-dir handler');
    const body = src.slice(idx, idx + 400);
    assert.match(body, /selectedProjectDir/, '应从 sessionStore 取 selectedProjectDir');
  });

  test('② AI 页面 API 暴露 getProjectDir（插件跑在 AI 页面）', () => {
    const src = read('src/bridge/api.ts');
    assert.match(src, /getProjectDir:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('get-project-dir'\)/,
      'bridge/api.ts 应暴露 getProjectDir');
  });

  test('③ 宿主能力不再读 DOM 元素（那是死代码）', () => {
    const src = read('src/bridge/plugin-system.ts');
    const idx = src.indexOf('function buildHost');
    assert.ok(idx > 0);
    const body = src.slice(idx, idx + 3000);
    assert.ok(!/getElementById\('cuckoo-project-dir'\)/.test(body),
      '不应再读 cuckoo-project-dir 元素（全仓库无人创建它）');
    assert.match(body, /api\.getProjectDir/, '应通过 electronAPI.getProjectDir 拉取');
    assert.match(body, /cachedProjectDir/, '同步接口需缓存');
  });

  test('④ 项目目录变更时刷新缓存（否则切项目后插件用旧路径）', () => {
    const src = read('src/bridge/plugin-system.ts');
    assert.match(src, /onProjectDirUpdated/, '应订阅 project-dir-updated');
    const api = read('src/bridge/api.ts');
    assert.match(api, /onProjectDirUpdated/, 'api.ts 应暴露订阅方法');
    assert.match(api, /project-dir-updated/, '应监听正确的 IPC 频道');
  });

  test('⑤ 主进程确实会发 project-dir-updated 给 AI 页面', () => {
    const src = read('src/session/project-context.ts');
    assert.match(src, /view\.webContents\.send\('project-dir-updated'/, '初始化时应发给 view');
    const store = read('src/session/store.ts');
    assert.match(store, /send\('project-dir-updated'/, '目录变化时应发给 view');
  });

  test('⑥ ctx.sessions.current() 走 host.getProjectDir（同步可得）', () => {
    const src = read('src/plugins/runtime/context.ts');
    assert.match(src, /getProjectDir\(\)/, 'context 应调用 host.getProjectDir');
    assert.match(src, /projectDir:\s*host\.getProjectDir\(\)/, 'sessions.current 应带 projectDir');
  });
});
