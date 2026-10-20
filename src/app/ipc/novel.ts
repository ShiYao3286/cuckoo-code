/**
 * 写作台 IPC（需求 041）
 *
 * 职责：
 *  1. 章节/设定文件的读写（限定在 <项目目录>/novel/ 内，防目录穿越）
 *  2. 把写作台的 AI 请求转发到当前窗口的 AI 页面（复用 sendToChat）
 *  3. 把 AI 的流式回复转发回写作台
 *
 * 设计约束（与用户约定）：
 *  - 写作台只服务「已初始化项目」的窗口（初始化仍在网页模式完成）
 *  - 文件由写作台自己管，不经过 AI 的工具调用 → 避免 AI 擅自改稿
 *  - 所有写操作限制在 novel/ 目录内
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import * as windowState from '../window.js';

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

/** 小说根目录名（相对项目根） */
const NOVEL_DIR = 'novel';
/** 章节目录 */
const CHAPTER_DIR = 'novel/章节';
/** 设定目录 */
const SETTING_DIR = 'novel/设定';
/** 单个章节大小上限（2MB，与 read-project-file 一致） */
const MAX_FILE = 2 * 1024 * 1024;

/** 写作台上下文：从 sender 反查窗口 */
function ctxOf(event: any): any {
  try {
    return windowState.getContextByWebContents(event.sender);
  } catch (_) {
    return null;
  }
}

/** 取当前项目根目录 */
function projectRootOf(event: any): string | null {
  const ctx = ctxOf(event);
  const store = ctx ? ctx.sessionStore : null;
  const dir = store && store.state ? store.state.selectedProjectDir : null;
  return dir || null;
}

/**
 * 解析并校验路径：必须落在 <项目根>/novel/ 内。
 * 与 read-project-file 同款防护（含同前缀兄弟目录绕过）。
 */
function resolveInNovel(rootDir: string, relPath: any): { ok: true; abs: string } | { ok: false; error: string } {
  if (!relPath || typeof relPath !== 'string') return { ok: false, error: '缺少路径' };
  const novelAbs = path.resolve(rootDir, NOVEL_DIR);
  const abs = path.resolve(rootDir, relPath);
  // 必须在 novel/ 目录内（含等于 novel 根）
  if (abs !== novelAbs && !abs.startsWith(novelAbs + path.sep)) {
    return { ok: false, error: '非法路径（只能操作 novel/ 目录）' };
  }
  return { ok: true, abs };
}

/** 中文按字符计，英文按词计（网文习惯：中文环境基本全按字符） */
function countWords(text: string): number {
  if (!text) return 0;
  // 去掉 Markdown 语法符号与空白，统计可见字符
  const cleaned = text
    .replace(/^#{1,6}\s+/gm, '')   // 标题 #
    .replace(/[*_`>~]/g, '')       // 强调/引用/代码标记
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接只留文字
    .replace(/\s+/g, '');
  return cleaned.length;
}

/** 从文件名解析章节标题（"第001章-标题.md" → "第001章 标题"） */
function chapterTitleOf(fileName: string): string {
  const base = fileName.replace(/\.md$/i, '');
  const m = base.match(/^(第\d+章)[-_ ]*(.*)$/);
  if (m) return m[1] + (m[2] ? ' ' + m[2] : '');
  return base;
}

/** 章节排序键：抽「第 N 章」的数字，无则用文件名 */
function chapterSortKey(fileName: string): number {
  const m = fileName.match(/第(\d+)章/);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

/** 读取某目录下的 md 文件（单层） */
function listMd(dirAbs: string): string[] {
  try {
    return fs.readdirSync(dirAbs)
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .sort();
  } catch (_) {
    return [];
  }
}

/** 初始化 novel 目录结构（幂等） */
function ensureNovelTree(rootDir: string): void {
  const dirs = [
    path.join(rootDir, NOVEL_DIR),
    path.join(rootDir, CHAPTER_DIR),
    path.join(rootDir, SETTING_DIR),
  ];
  for (const d of dirs) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (_) { /* ignore */ }
  }
}

function registerNovelIpc(): void {
  // ===== 项目 =====
  ipcMain.handle('novel-get-project', async (event: any) => {
    const root = projectRootOf(event);
    if (!root) return { success: false, error: '未初始化项目', needsInit: true };
    // 校验目录真实存在（项目目录可能已被删/移动）
    if (!fs.existsSync(root)) return { success: false, error: '项目目录不存在', needsInit: true };
    const novelExists = fs.existsSync(path.join(root, NOVEL_DIR));
    return { success: true, dir: root, novelExists };
  });

  ipcMain.handle('novel-ensure-tree', async (event: any) => {
    const root = projectRootOf(event);
    if (!root) return { success: false, error: '未初始化项目', needsInit: true };
    try {
      ensureNovelTree(root);
      return { success: true, dir: root };
    } catch (err: any) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  });

  // ===== 章节 =====
  ipcMain.handle('novel-list-chapters', async (event: any) => {
    const root = projectRootOf(event);
    if (!root) return { success: false, error: '未初始化项目', needsInit: true };
    const chapAbs = path.join(root, CHAPTER_DIR);
    const files = listMd(chapAbs);
    const chapters = files.map((name) => {
      let words = 0;
      try {
        words = countWords(fs.readFileSync(path.join(chapAbs, name), 'utf-8'));
      } catch (_) { /* ignore */ }
      return {
        name,
        title: chapterTitleOf(name),
        path: CHAPTER_DIR + '/' + name,
        words,
        order: chapterSortKey(name),
      };
    }).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    return { success: true, chapters };
  });

  ipcMain.handle('novel-read-chapter', async (event: any, { relPath }: any) => {
    const root = projectRootOf(event);
    if (!root) return { success: false, error: '未初始化项目', needsInit: true };
    const r = resolveInNovel(root, relPath);
    if (!r.ok) return { success: false, error: r.error };
    try {
      const st = fs.statSync(r.abs);
      if (!st.isFile()) return { success: false, error: '不是文件' };
      if (st.size > MAX_FILE) return { success: false, error: '文件过大（>2MB）' };
      return { success: true, content: fs.readFileSync(r.abs, 'utf-8'), size: st.size };
    } catch (err: any) {
      if (err && err.code === 'ENOENT') return { success: false, error: '章节不存在' };
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('novel-write-chapter', async (event: any, { relPath, content }: any) => {
    const root = projectRootOf(event);
    if (!root) return { success: false, error: '未初始化项目', needsInit: true };
    const r = resolveInNovel(root, relPath);
    if (!r.ok) return { success: false, error: r.error };
    if (typeof content !== 'string') return { success: false, error: 'content 必须是字符串' };
    if (Buffer.byteLength(content, 'utf-8') > MAX_FILE) return { success: false, error: '内容过大（>2MB）' };
    try {
      fs.mkdirSync(path.dirname(r.abs), { recursive: true });
      fs.writeFileSync(r.abs, content, 'utf-8');
      return { success: true, bytes: Buffer.byteLength(content, 'utf-8'), words: countWords(content) };
    } catch (err: any) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('novel-create-chapter', async (event: any, { title }: any) => {
    const root = projectRootOf(event);
    if (!root) return { success: false, error: '未初始化项目', needsInit: true };
    try {
      ensureNovelTree(root);
      const chapAbs = path.join(root, CHAPTER_DIR);
      // 序号 = 现有最大章号 + 1
      const existing = listMd(chapAbs);
      let maxNo = 0;
      for (const f of existing) {
        const m = f.match(/第(\d+)章/);
        if (m) maxNo = Math.max(maxNo, parseInt(m[1], 10));
      }
      const no = String(maxNo + 1).padStart(3, '0');
      const cleanTitle = String(title || '').replace(/[\\/:*?"<>|]/g, '').trim() || '未命名';
      const fileName = '第' + no + '章-' + cleanTitle + '.md';
      const abs = path.join(chapAbs, fileName);
      if (fs.existsSync(abs)) return { success: false, error: '章节已存在: ' + fileName };
      const tpl = '# 第' + no + '章 ' + cleanTitle + '\n\n';
      fs.writeFileSync(abs, tpl, 'utf-8');
      return {
        success: true,
        relPath: CHAPTER_DIR + '/' + fileName,
        name: fileName,
        title: '第' + no + '章 ' + cleanTitle,
        content: tpl,
      };
    } catch (err: any) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  });

  // ===== 设定 =====
  ipcMain.handle('novel-list-settings', async (event: any) => {
    const root = projectRootOf(event);
    if (!root) return { success: false, error: '未初始化项目', needsInit: true };
    const dirAbs = path.join(root, SETTING_DIR);
    const files = listMd(dirAbs);
    return {
      success: true,
      settings: files.map((name) => ({
        name,
        title: name.replace(/\.md$/i, ''),
        path: SETTING_DIR + '/' + name,
      })),
    };
  });

  // ===== AI 对话 =====
  // 写作台的请求转发到当前窗口的 AI 页面（复用 sendToChat，走网页账号，零成本）。
  // 由 AI 页面的 bridge 拦截回复，再经 'novel-ai-event' 回传写作台。
  let pendingRequests = 0;

  ipcMain.handle('novel-send-message', async (event: any, { text }: any) => {
    const ctx = ctxOf(event);
    if (!ctx || !ctx.view || ctx.view.webContents.isDestroyed()) {
      return { success: false, error: 'AI 页面不可用' };
    }
    if (!text || typeof text !== 'string') return { success: false, error: '消息为空' };
    try {
      // 转发到 AI 页面的 bridge，由它调用 chat-input 的 sendToChat
      ctx.view.webContents.send('novel-user-message', { text });
      pendingRequests++;
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('novel-stop', async (event: any) => {
    const ctx = ctxOf(event);
    try {
      if (ctx && ctx.view && !ctx.view.webContents.isDestroyed()) {
        ctx.view.webContents.send('novel-stop-request');
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('novel-exit', async (event: any) => {
    const ctx = ctxOf(event);
    try {
      ctx?.win?.__ckToggleNovel?.(false);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  });

  // 写作台页面就绪
  ipcMain.on('novel-ready', () => { /* 预留：首屏可主动推送状态 */ });

  // ===== AI 事件中转（bridge 侧 → 写作台视图）=====
  // bridge 收到 AI 流式回复后经此转发；不直接跨 WebContentsView 发，
  // 因为 bridge 只拿到自己的 webContents，需要主进程定位 novel view。
  ipcMain.on('novel-ai-event-relay', (event: any, payload: any) => {
    try {
      const ctx = ctxOf(event);
      const win = ctx && ctx.win ? ctx.win : null;
      const nv = win ? (win as any).__ckNovelView : null;
      if (!nv || nv.webContents.isDestroyed()) return;
      // 只有写作台可见/存在时才转发，避免无谓 IPC
      nv.webContents.send('novel-ai-event', payload);
    } catch (_) { /* ignore */ }
  });
}

/** 把 AI 事件推给写作台（由 bridge 侧调用） */
function pushNovelAiEvent(win: any, payload: any): void {
  try {
    const nv = win && (win as any).__ckNovelView;
    if (!nv || nv.webContents.isDestroyed()) return;
    nv.webContents.send('novel-ai-event', payload);
  } catch (_) { /* ignore */ }
}

export { registerNovelIpc, pushNovelAiEvent, countWords, chapterTitleOf, chapterSortKey, NOVEL_DIR, CHAPTER_DIR, SETTING_DIR };
