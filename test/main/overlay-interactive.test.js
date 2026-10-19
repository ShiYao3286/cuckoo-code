'use strict';
import { test, describe } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 覆盖层交互模式（需求 037）的静态契约测试。
 *
 * 为什么只做静态断言：交互模式的真实行为依赖 Electron BrowserWindow
 * （setFocusable / setIgnoreMouseEvents / focus），Node 测试环境无法实例化。
 * 真实有效性由真机验证（CDP 查 document.hasFocus()）确认。
 * 这里锁住"链路不能断"——任何一环缺失都会让插件调不到：
 *
 *   plugin ui  →  ctx.ui.overlay.setInteractive
 *              →  window.electronAPI.overlaySetInteractive
 *              →  IPC 'plugin-overlay-set-interactive'
 *              →  win.__ckSetOverlayInteractive
 *              →  setFocusable(true) + setIgnoreMouseEvents(false)
 */

const ROOT = process.cwd();
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

describe('覆盖层交互模式：链路完整性', () => {
  test('① 主进程暴露切换器（window.__ckSetOverlayInteractive）', () => {
    const src = read('src/app/entry.ts');
    assert.match(src, /__ckSetOverlayInteractive\s*=/, '应挂切换器到 window');
    assert.match(src, /const setOverlayInteractive\s*=/, '应有实现函数');
  });

  test('② 交互模式必须同时做三件事：可聚焦 / 取消穿透 / 抢焦点', () => {
    const src = read('src/app/entry.ts');
    const body = src.slice(src.indexOf('const setOverlayInteractive'), src.indexOf('__ckSetOverlayInteractive ='));
    assert.match(body, /setFocusable\(true\)/, '必须 setFocusable(true)，否则键盘/IME 进不来');
    assert.match(body, /setIgnoreMouseEvents\(false\)/, '必须取消鼠标穿透，否则点击进不来');
    assert.match(body, /\.focus\(\)/, '必须主动抢焦点，否则要点一下才开始');
  });

  test('③ 退出交互模式要恢复桌宠语义（不可聚焦 + 穿透）', () => {
    const src = read('src/app/entry.ts');
    const start = src.indexOf('const setOverlayInteractive');
    const body = src.slice(start, src.indexOf('__ckSetOverlayInteractive ='));
    assert.match(body, /setFocusable\(false\)/, '退出时应恢复不可聚焦');
    assert.match(body, /setIgnoreMouseEvents\(true/, '退出时应恢复穿透');
  });

  test('④ 穿透轮询在交互模式下必须让路（否则抢走输入）', () => {
    const src = read('src/app/ipc/plugin.ts');
    const idx = src.indexOf('定时轮询鼠标');
    const body = src.slice(idx, idx + 1400);
    assert.match(body, /__ckOverlayInteractive/, '轮询应检查交互模式标记');
    assert.match(body, /return;/, '交互模式时应直接返回，不碰穿透开关');
  });

  test('⑤ IPC 通道三段打通（main / preload / ui-runtime）', () => {
    assert.match(read('src/app/ipc/plugin.ts'), /plugin-overlay-set-interactive/, '主进程缺 handler');
    assert.match(read('src/bridge/api.ts'), /overlaySetInteractive/, 'preload 缺 API');
    assert.match(read('src/plugins/runtime/ui-runtime.ts'), /setInteractive/, 'ui-runtime 缺转发');
  });

  test('⑥ 页面重载后要重新抢焦点（否则刷新一次输入就断）', () => {
    const src = read('src/app/entry.ts');
    const idx = src.indexOf("did-finish-load");
    const body = src.slice(idx, idx + 600);
    assert.match(body, /overlayInteractive/, 'did-finish-load 应区分交互模式');
    assert.match(body, /focus\(\)/, '交互模式重载后应重新 focus');
  });

  test('⑦ 默认仍是桌宠形态（focusable:false，行为不破坏）', () => {
    const src = read('src/app/entry.ts');
    const idx = src.indexOf('const ow = new BrowserWindow');
    const body = src.slice(idx, idx + 800);
    assert.match(body, /focusable:\s*false/, '创建时默认不可聚焦（保持桌宠行为）');
  });
});
