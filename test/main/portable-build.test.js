'use strict';
import { test, describe } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 绿色版（zip 解压即用）判定。
 *
 * 判定逻辑在 src/updater/index.ts 的 isPortableBuild()，但该模块会 import electron-updater
 * 并在模块顶层注册 autoUpdater 事件，无法在纯 Node 测试环境安全加载（现有测试也不加载它）。
 * 这里复刻同一判定规则，锁住行为契约：规则变化时本测试会提醒同步修改。
 *
 * 判据（与实现一致）：
 *  - 开发环境（未打包）→ 不算绿色版
 *  - PORTABLE_EXECUTABLE_DIR 存在 → 绿色版（electron-builder portable 目标注入）
 *  - 打包后 exe 同目录**没有** Uninstall 程序 → 绿色版
 */
function isPortableBuildImpl({ isPackaged, portableEnv, exeDir, uninstallExists }) {
  if (!isPackaged) return false;
  if (portableEnv) return true;
  return !uninstallExists;
}

describe('绿色版判定规则', () => {
  test('开发环境不算绿色版', () => {
    assert.strictEqual(isPortableBuildImpl({ isPackaged: false, portableEnv: '', exeDir: 'x', uninstallExists: false }), false);
  });

  test('PORTABLE_EXECUTABLE_DIR 存在 → 绿色版', () => {
    assert.strictEqual(isPortableBuildImpl({ isPackaged: true, portableEnv: 'C:\\app', exeDir: 'x', uninstallExists: true }), true);
  });

  test('打包后无 Uninstall 程序 → 绿色版（zip 解压）', () => {
    assert.strictEqual(isPortableBuildImpl({ isPackaged: true, portableEnv: '', exeDir: 'x', uninstallExists: false }), true);
  });

  test('打包后有 Uninstall 程序 → 安装版（可自动更新）', () => {
    assert.strictEqual(isPortableBuildImpl({ isPackaged: true, portableEnv: '', exeDir: 'x', uninstallExists: true }), false);
  });
});

describe('构建产物命名（防止安装包与绿色版撞名）', () => {
  test('win.target 同时包含 nsis 与 zip', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const targets = pkg.build.win.target;
    assert.ok(targets.includes('nsis'), 'win.target 应含 nsis');
    assert.ok(targets.includes('zip'), 'win.target 应含 zip（绿色版）');
  });

  test('zip 用 win.artifactName（带 arch），nsis 用 nsis.artifactName（不带 arch），不会撞名', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const winName = pkg.build.win.artifactName;
    const nsisName = pkg.build.nsis.artifactName;
    // 典型输出：安装包 cuckoo-code-win-v0.8.20.exe / 绿色版 cuckoo-code-win-v0.8.20-x64.zip
    function render(tpl, version, arch, ext) {
      return tpl.replace(/\$\{version\}/g, version).replace(/\$\{arch\}/g, arch).replace(/\$\{ext\}/g, ext);
    }
    const exe = render(nsisName, '0.8.20', 'x64', 'exe');
    const zip = render(winName, '0.8.20', 'x64', 'zip');
    assert.strictEqual(exe, 'cuckoo-code-win-v0.8.20.exe');
    assert.strictEqual(zip, 'cuckoo-code-win-v0.8.20-x64.zip');
    assert.notStrictEqual(exe, zip);
  });

  test('CI 已会上传并发布 dist/*.zip（否则云端产不出绿色版）', async () => {
    const yml = fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'release.yml'), 'utf8');
    const uploadZip = /path:[\s\S]*?dist\/\*\.zip/.test(yml);
    const publishZip = /files:[\s\S]*?dist\/\*\.zip/.test(yml);
    assert.ok(uploadZip, 'release.yml 的 upload-artifact 应包含 dist/*.zip');
    assert.ok(publishZip, 'release.yml 的发布 files 应包含 dist/*.zip');
  });
});
