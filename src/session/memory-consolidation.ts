/**
 * 记忆整理的主进程编排（036）
 *
 * 职责：把「读对话 → 格式化 → 调 LLM → 返回预览」串起来。
 * 不直接写盘——写盘由 IPC 层在用户确认后调用 memory-profile.writeProfile。
 *
 * 设计要点：
 *   - 增量：只读 lastConsolidatedMessageId 之后的新对话
 *   - 预览：返回 { oldProfile, newProfile, conversationCount, usage }，等用户确认
 *   - 降级：对话太短（< 2 条）时直接拒绝，不浪费 LLM 调用
 */
import * as windowState from '../app/window.js';
import { readConversationInPage } from './conversation-reader.js';
import type { ConversationMessage } from './conversation-reader.js';
import { readProfile, readMeta } from '../infra/memory-profile.js';
import { consolidateProfile } from '../infra/memory-consolidator.js';
import { getMemoryLlmConfig, isMemoryConsolidationEnabled } from '../infra/config.js';
import { getMemoryApiKey } from '../app/memory-credentials.js';

/** 一次整理预览的结果 */
interface PreviewResult {
  success: boolean;
  /** 现有画像 */
  oldProfile?: any;
  /** LLM 重写后的新画像（未落盘） */
  newProfile?: any;
  /** 本次整理覆盖的消息数 */
  messageCount?: number;
  /** 本次覆盖的最大 messageId（确认后作为新游标） */
  maxMessageId?: number;
  usage?: { promptTokens: number; completionTokens: number };
  elapsedMs?: number;
  error?: string;
}

/**
 * 把消息数组格式化成 prompt 用的对话文本。
 * @param messages 按时间升序
 * @param projectDir 用于在文本里标注项目路径（帮助 LLM 区分 projects 字段）
 */
function formatConversation(messages: ConversationMessage[], projectDir: string | null): string {
  const lines: string[] = [];
  if (projectDir) {
    lines.push('[项目目录: ' + projectDir + ']');
    lines.push('');
  }
  for (const m of messages) {
    if (!m.content) continue;
    const who = m.role === 'USER' ? '用户' : (m.role === 'ASSISTANT' ? 'AI' : m.role);
    lines.push(who + ': ' + m.content);
  }
  return lines.join('\n');
}

/**
 * 从当前活跃窗口读会话消息。
 * 读不到时返回 null（窗口不存在 / 未登录 / IDB 未就绪）。
 */
async function readMessagesFromActiveWindow(): Promise<{
  messages: ConversationMessage[];
  sessionId: string | null;
  projectDir: string | null;
} | null> {
  const ctx = windowState.getMainContext();
  if (!ctx || !ctx.view || ctx.view.webContents.isDestroyed()) return null;

  const wc = ctx.view.webContents;
  const url = String(wc.getURL() || '');
  // 从 URL 取 sessionId：https://chat.deepseek.com/a/chat/s/<uuid>
  const m = url.match(/\/chat\/s\/([0-9a-f-]{36})/i);
  const sessionId = m ? m[1] : null;
  if (!sessionId) return null;

  const store = ctx.sessionStore;
  const projectDir = (store && store.state && store.state.selectedProjectDir) || null;

  const fnSrc = '(' + readConversationInPage.toString() + ')(' + JSON.stringify(sessionId) + ')';
  let result: any;
  try {
    result = await wc.executeJavaScript(fnSrc, true);
  } catch (err: any) {
    console.error('[MemoryConsolidation] 读取会话失败:', err && err.message);
    return null;
  }
  if (!result || !Array.isArray(result.messages)) return null;
  return { messages: result.messages, sessionId, projectDir };
}

/**
 * 生成整理预览（不写盘）。
 *
 * 调用方（IPC）拿到结果后展示给用户，用户确认后再调 writeProfile 落盘。
 */
async function previewConsolidation(): Promise<PreviewResult> {
  const t0 = Date.now();

  if (!isMemoryConsolidationEnabled()) {
    return { success: false, error: '记忆整理未启用（需在设置里配置 LLM 端点与模型）' };
  }
  const llm = getMemoryLlmConfig();
  if (!llm) return { success: false, error: 'LLM 配置不完整' };

  const apiKey = getMemoryApiKey();
  if (!apiKey) return { success: false, error: '未配置 API Key' };

  const read = await readMessagesFromActiveWindow();
  if (!read) {
    return { success: false, error: '读不到当前会话（请确认已在 AI 窗口打开某个对话）' };
  }

  const oldProfile = readProfile();
  const meta = readMeta();
  const cursor = meta.lastConsolidatedMessageId || 0;

  // 增量：先按游标过滤，再看正文能否取出——分开诊断，否则「正文取不到」会被误报成「没有新对话」
  const afterCursor = read.messages.filter((m) => m.messageId > cursor);
  if (afterCursor.length === 0) {
    return {
      success: false,
      error: '没有新对话可整理（上次已整理到最新，游标=' + cursor + '）',
    };
  }

  const fresh = afterCursor.filter((m) => m.content);
  if (fresh.length === 0) {
    // 正文取不到：把字段结构 dump 出来，便于定位（这是 036 真机验证的关键诊断点）
    const sample = afterCursor[afterCursor.length - 1];
    const diag = sample && sample.rawKeys
      ? sample.rawKeys.join(', ')
      : '(无诊断信息)';
    return {
      success: false,
      error:
        '读到了 ' + afterCursor.length + ' 条消息，但取不到正文。\n' +
        '消息对象的字段：' + diag + '\n' +
        '请把这段信息反馈给开发者——需要根据实际字段名调整正文提取逻辑。',
    };
  }

  if (fresh.length < 2) {
    return {
      success: false,
      error: '新对话太少（' + fresh.length + ' 条，至少需要一对问答）',
    };
  }

  const conversation = formatConversation(fresh, read.projectDir);
  if (!conversation.trim()) {
    return { success: false, error: '对话正文为空' };
  }

  const r = await consolidateProfile({
    existingProfile: oldProfile,
    conversation,
    baseUrl: llm.baseUrl,
    model: llm.model,
    apiKey,
    timeoutMs: 180000,
  });

  if (!r.success) {
    return { success: false, error: r.error, elapsedMs: Date.now() - t0 };
  }

  const maxMessageId = fresh.reduce((max, m) => Math.max(max, m.messageId), cursor);

  return {
    success: true,
    oldProfile,
    newProfile: r.profile,
    messageCount: fresh.length,
    maxMessageId,
    usage: r.usage,
    elapsedMs: Date.now() - t0,
  };
}

export { previewConsolidation, formatConversation, readMessagesFromActiveWindow };
export type { PreviewResult };
