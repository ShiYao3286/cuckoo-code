/**
 * 写作台 ↔ AI 桥接（需求 041）
 *
 * 职责：
 *  1. 接主进程的 'novel-user-message' → 调用 sendToChat 发到 AI 网页（走网页账号，零成本）
 *  2. 把 AI 的流式回复（observer.onStream）→ 回传主进程 → 写作台
 *  3. 拦截 AI 试图执行工具的情况（写作模式下 AI 不应碰文件）
 *
 * 设计约束（与用户约定）：
 *  - AI 只返回文本，文件由写作台自己读写
 *  - 若回复里出现 ```cuckoo 代码块，判定 AI 想执行操作 → 丢弃并提示
 */
import { createRequire } from 'node:module';
import { onStream, onInterceptedResponse } from './intercept/observer.js';
import { sendToChat } from '../overlay/chat-input.js';

const require = createRequire(import.meta.url);
const { ipcRenderer } = require('electron');

/** 是否处于写作台模式（由主进程通知） */
let novelMode = false;
/** 当前是否有待接收的写作请求 */
let awaiting = false;
/** 累积的流式文本 */
let streamBuf = '';
/** 拦截计数（给写作台提示） */
let blockedCount = 0;

/** 把事件推给写作台（经主进程转发到 novel view） */
function pushToNovel(payload: any): void {
  try {
    ipcRenderer.send('novel-ai-event-relay', payload);
  } catch (_) { /* ignore */ }
}

/** 判断文本里是否含可执行工具代码块（AI 想改文件的信号） */
function hasToolBlock(text: string): boolean {
  return /```\s*cuckoo/i.test(text) || /<cuckoo-ai-block/i.test(text);
}

/** 启动写作台桥接 */
function startNovelBridge(): void {
  // 主进程 → 写作台请求
  try {
    ipcRenderer.on('novel-user-message', async (_e: any, { text }: any) => {
      if (!text || typeof text !== 'string') return;
      awaiting = true;
      streamBuf = '';
      blockedCount = 0;
      const ok = await sendToChat(text, 'novel', 200);
      if (!ok) {
        awaiting = false;
        pushToNovel({ type: 'error', error: '消息未能发送到 AI（输入框不可用）' });
      }
    });
  } catch (_) { /* ignore */ }

  // 主进程 → 写作台模式变化
  try {
    ipcRenderer.on('novel-mode-changed', (_e: any, data: any) => {
      novelMode = !!(data && data.novel);
      if (!novelMode) awaiting = false;
    });
  } catch (_) { /* ignore */ }

  // 停止请求
  try {
    ipcRenderer.on('novel-stop-request', () => {
      awaiting = false;
      streamBuf = '';
      pushToNovel({ type: 'turn-end', text: '' });
    });
  } catch (_) { /* ignore */ }

  // ===== AI 流式回复 → 写作台 =====
  onStream((ev: any) => {
    if (!awaiting) return;
    const t = ev && ev.text ? String(ev.text) : '';
    if (t) {
      streamBuf += t;
      pushToNovel({ type: 'stream', text: t });
    }
  });

  // ===== 整条回复收完 → 检查是否试图调用工具 =====
  onInterceptedResponse((text: string) => {
    if (!awaiting) return;
    awaiting = false;
    const full = text || streamBuf;

    if (hasToolBlock(full)) {
      // AI 想执行操作：丢弃，不交给写作台写回
      blockedCount++;
      pushToNovel({
        type: 'blocked',
        error: 'AI 试图执行工具操作，已拦截。写作模式下 AI 只应返回文本。',
        count: blockedCount,
      });
      streamBuf = '';
      return;
    }

    pushToNovel({ type: 'turn-end', text: full });
    streamBuf = '';
  });
}

export { startNovelBridge, hasToolBlock };
