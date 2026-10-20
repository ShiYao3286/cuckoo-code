/**
 * 写作台页面 preload（需求 041）
 *
 * 暴露 window.novelAPI：项目/章节读写、AI 对话、模式切换。
 * 与 harness-preload 同构，独立于官方内部模块。
 *
 * 安全：所有文件操作都在主进程侧校验路径（必须落在项目目录内），
 * 本 preload 只做通道转发。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { contextBridge, ipcRenderer } = require('electron');

const novelAPI = {
  // ===== 项目 =====
  /** 当前项目目录（写作台只服务已初始化项目） */
  getProjectDir: () => ipcRenderer.invoke('novel-get-project'),
  /** 确保 novel 目录结构存在（首次使用时创建） */
  ensureNovelTree: () => ipcRenderer.invoke('novel-ensure-tree'),

  // ===== 章节 =====
  /** 列出章节：{ success, chapters: [{ name, path, words }] } */
  listChapters: () => ipcRenderer.invoke('novel-list-chapters'),
  /** 读章节正文：{ success, content, size } */
  readChapter: (relPath: string) => ipcRenderer.invoke('novel-read-chapter', { relPath }),
  /** 写章节正文：{ success, bytes } */
  writeChapter: (relPath: string, content: string) => ipcRenderer.invoke('novel-write-chapter', { relPath, content }),
  /** 新建章节：{ success, relPath, content } */
  createChapter: (title: string) => ipcRenderer.invoke('novel-create-chapter', { title }),

  // ===== 设定 =====
  /** 列设定文件 */
  listSettings: () => ipcRenderer.invoke('novel-list-settings'),
  /** 读设定文件 */
  readSetting: (relPath: string) => ipcRenderer.invoke('novel-read-chapter', { relPath }),
  /** 写设定文件 */
  writeSetting: (relPath: string, content: string) => ipcRenderer.invoke('novel-write-chapter', { relPath, content }),

  // ===== AI =====
  /** 发送消息给 AI（主进程转发到 AI 页面） */
  sendMessage: (text: string) => ipcRenderer.invoke('novel-send-message', { text }),
  /** 停止生成 */
  stopGeneration: () => ipcRenderer.invoke('novel-stop'),
  /** 订阅 AI 事件（stream / turn-end / error） */
  onAiEvent: (cb: (payload: any) => void) => {
    ipcRenderer.on('novel-ai-event', (_e: any, payload: any) => cb(payload));
  },
  /** 订阅状态（项目目录变化等） */
  onState: (cb: (payload: any) => void) => {
    ipcRenderer.on('novel-state', (_e: any, payload: any) => cb(payload));
  },

  // ===== 模式切换 =====
  /** 切回网页模式 */
  backToWeb: () => ipcRenderer.invoke('novel-exit'),
  /** 页面就绪 */
  ready: () => ipcRenderer.send('novel-ready'),

  // ===== 主题 =====
  themeGet: () => ipcRenderer.invoke('theme-get'),
  onThemeChanged: (cb: (snap: any) => void) => {
    ipcRenderer.on('theme-changed', (_e: any, snap: any) => cb(snap));
  },
};

try {
  contextBridge.exposeInMainWorld('novelAPI', novelAPI);
} catch (err) {
  console.error('[Cuckoo Novel] contextBridge 失败:', err);
}
(window as any).novelAPI = novelAPI;

export {};
