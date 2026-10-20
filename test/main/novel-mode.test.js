'use strict';
import { test, describe } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 需求 041：写作台模式（第三视图）
 *
 * 三模式互斥：网页 / 纯净(harnedd) / 写作(novel)。
 * 用户约定：初始化仍在网页模式完成，写作台只服务已初始化项目。
 *
 * 本测试锁住"链路不能断"和"安全边界不能被绕过"：
 *   - 视图创建/切换/布局三段都在
 *   - 文件操作限制在 novel/ 内
 *   - AI 只回文本，工具调用要被拦截
 */

const ROOT = process.cwd();
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

/** 与 src/app/ipc/novel.ts resolveInNovel 相同的判定（独立验证边界） */
function isInsideNovel(rootDir, relPath) {
  const novelAbs = path.resolve(rootDir, 'novel');
  const abs = path.resolve(rootDir, relPath);
  return abs === novelAbs || abs.startsWith(novelAbs + path.sep);
}

describe('写作台：文件操作边界', () => {
  const root = path.join(ROOT, 'test', 'tmp', 'novelfixture');

  test('novel/ 内的路径放行', () => {
    assert.strictEqual(isInsideNovel(root, 'novel/章节/第001章.md'), true);
    assert.strictEqual(isInsideNovel(root, 'novel/设定/人物.md'), true);
    assert.strictEqual(isInsideNovel(root, 'novel'), true);
  });

  test('novel/ 外一律拒绝（不能碰项目其他文件）', () => {
    assert.strictEqual(isInsideNovel(root, 'package.json'), false);
    assert.strictEqual(isInsideNovel(root, 'src/app/entry.ts'), false);
    assert.strictEqual(isInsideNovel(root, 'novel/../package.json'), false);
    assert.strictEqual(isInsideNovel(root, 'novel/../../etc/passwd'), false);
  });

  test('同前缀兄弟目录不算 novel 内', () => {
    // novel-evil 不应被当成 novel 内部
    const rootAbs = path.resolve(root);
    const abs = path.resolve(path.join(root, 'novel-evil', 'x.md'));
    assert.strictEqual(abs.startsWith(path.resolve(rootAbs, 'novel') + path.sep), false);
  });
});

describe('写作台：链路完整性', () => {
  test('① 主进程创建写作台视图并支持切换', () => {
    const src = read('src/app/entry.ts');
    assert.match(src, /ensureNovelView/, '应创建写作台视图');
    assert.match(src, /__ckToggleNovel/, '应有切换函数');
    assert.match(src, /novel-preload\.js/, '应使用独立 preload');
    assert.match(src, /ui\/novel\.html/, '应加载 novel.html');
  });

  test('② 三模式互斥：进写作台要先退出纯净模式', () => {
    const src = read('src/app/entry.ts');
    const idx = src.indexOf('__ckToggleNovel = (show?: boolean)');
    const body = src.slice(idx, idx + 1200);
    assert.match(body, /__ckHarnessVisible/, '应检查纯净模式状态');
    assert.match(body, /__ckToggleHarness\?\.\(false\)/, '应退出纯净模式（互斥）');
    assert.match(body, /view\.setVisible\(false\)/, '应隐藏 AI 网页（后台继续跑）');
  });

  test('③ 布局函数包含写作台（否则尺寸为 0 看不见）', () => {
    const src = read('src/app/entry.ts');
    const idx = src.indexOf('const layoutView = () =>');
    const body = src.slice(idx, idx + 2200);
    assert.match(body, /__ckNovelView/, 'layoutView 应处理写作台视图');
    assert.match(body, /__ckNovelVisible/, '应按可见状态决定尺寸');
  });

  test('④ 快捷键与菜单入口', () => {
    const src = read('src/app/entry.ts');
    assert.match(src, /CmdOrCtrl\+Shift\+W/, '应有写作台快捷键');
    assert.match(src, /写作台模式/, '菜单应有写作台项');
  });

  test('⑤ IPC 已注册', () => {
    const idxSrc = read('src/app/ipc/index.ts');
    assert.match(idxSrc, /registerNovelIpc/, 'IPC 注册入口应引入');
    assert.match(idxSrc, /registerNovelIpc\(\)/, 'IPC 应被调用');
    const novel = read('src/app/ipc/novel.ts');
    for (const ch of [
      'novel-get-project', 'novel-ensure-tree', 'novel-list-chapters',
      'novel-read-chapter', 'novel-write-chapter', 'novel-create-chapter',
      'novel-list-settings', 'novel-send-message',
    ]) {
      assert.ok(novel.includes("'" + ch + "'"), '缺 IPC: ' + ch);
    }
  });

  test('⑥ 写章节用 resolveInNovel 校验（不能只靠前端）', () => {
    const src = read('src/app/ipc/novel.ts');
    const idx = src.indexOf("ipcMain.handle('novel-write-chapter'");
    const body = src.slice(idx, idx + 900);
    assert.match(body, /resolveInNovel/, '写入必须主进程侧校验路径');
    assert.match(body, /MAX_FILE/, '应有大小上限');
  });

  test('⑦ 构建脚本接入 compile', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.match(pkg.scripts.compile, /build-novel\.mjs/, 'compile 应包含写作台构建');
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'build-novel.mjs')), '应有构建脚本');
    // novel.ts 必须从 tsc 排除，否则会产出双份
    const tsb = JSON.parse(read('tsconfig.build.json'));
    assert.ok(tsb.exclude.includes('src/ui/novel.ts'), 'novel.ts 应从 tsc 排除（esbuild 负责）');
  });
});

describe('写作台：AI 只回文本', () => {
  test('⑧ 拦截 AI 的工具调用企图', () => {
    const src = read('src/bridge/novel-bridge.ts');
    assert.match(src, /hasToolBlock/, '应有工具块检测');
    assert.match(src, /```\s*\*\?cuckoo|cuckoo/, '应检测 cuckoo 代码块');
    assert.match(src, /type: 'blocked'/, '应回传 blocked 事件');
    // 拦截后不得把内容当正常回复发出去
    const idx = src.indexOf('hasToolBlock(full)');
    assert.ok(idx > 0, '应检查完整回复');
    const after = src.slice(idx, idx + 400);
    assert.match(after, /return;/, '命中工具块应直接返回，不转发正文');
  });

  test('⑨ 写作请求带"只回文本"约束', () => {
    const src = read('src/ui/novel.ts');
    assert.match(src, /只回文本/, '提示词应明确只回文本');
    assert.match(src, /不要调用任何工具|不要.*工具/, '应明确禁止调用工具');
  });

  test('⑩ 桥接已接入 bridge/entry（否则写作台收不到回复）', () => {
    const src = read('src/bridge/entry.ts');
    assert.match(src, /startNovelBridge/, 'bridge/entry 应启动写作台桥接');
  });
});

describe('写作台：窗口上下文反查（回归）', () => {
  /**
   * 真机踩到的坑：写作台的 IPC 全部返回「未初始化项目」。
   * 根因是 getContextByWebContents 只认 win/view/harnessView，
   * 漏了 novelView → 反查不到 sessionStore → selectedProjectDir 恒 null。
   * 这类"漏一个视图"的 bug 不会报错，只会静默返回 needsInit，很难查。
   */
  test('getContextByWebContents 必须认识 novelView', () => {
    const src = read('src/app/window.ts');
    const idx = src.indexOf('function getContextByWebContents');
    assert.ok(idx > 0, '应找到函数');
    const body = src.slice(idx, idx + 900);
    assert.match(body, /novelView/, '应把写作台视图纳入反查（否则 IPC 拿不到 sessionStore）');
    assert.match(body, /harnessView/, 'harness 视图的既有支持不能丢');
  });

  test('写作台视图挂到窗口上下文（ctx.novelView）', () => {
    const src = read('src/app/entry.ts');
    const idx = src.indexOf('const ensureNovelView');
    assert.ok(idx > 0, '应找到 ensureNovelView');
    const body = src.slice(idx, idx + 1400);
    assert.match(body, /ctx\.novelView\s*=\s*nv/, '应挂到 ctx.novelView 供反查');
  });
});
