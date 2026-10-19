/**
 * 会话正文读取（036）
 *
 * 从 DeepSeek 的 IndexedDB 读出「主对话链」上的完整消息（含正文），
 * 供记忆整理管道使用。
 *
 * 与 compaction.ts 的 getMessagesFromIndexedDB 的区别：
 *   - 那个只取 message_id/role/parent_id（够 share/create 用）
 *   - 这个要正文（content/fragments），并且要按主链顺序返回
 *
 * 关键约束：
 *   - 必须在**已登录且已进入会话页**的渲染进程里执行（否则 deepseek-chat 库未初始化）
 *   - 调用方负责在正确的 webContents 上执行本函数体（见 conversation-reader.ts）
 *
 * 正文来源的两种可能形态（容错处理，不预设）：
 *   a) m.content 是字符串
 *   b) m.fragments 是数组，每项有 content/text（hook 的流式帧结构）
 * 若都不是，返回空串并记录字段名（供后续排查）。
 */

/** 读出的一条消息 */
interface ConversationMessage {
  messageId: number;
  role: string;
  /** 正文；取不到时为空串 */
  content: string;
  /** 正文来源：'content' | 'fragments' | 'unknown' */
  contentSource: string;
  /** 取不到正文时的原始字段名（排查用） */
  rawKeys?: string[];
}

/**
 * 在页面内执行：读指定会话的全部消息（含正文）。
 *
 * 注意：本函数会被 toString() 后注入页面，**不能引用任何外部变量**。
 */
function readConversationInPage(sessionId: string): Promise<{
  messages: ConversationMessage[];
  currentMessageId: number | null;
  storeNames: string[];
  error?: string;
}> {
  return new Promise((resolve) => {
    const done = (v: any) => resolve(v);
    let req: any;
    try {
      req = (indexedDB as any).open('deepseek-chat');
    } catch (e: any) {
      return done({ messages: [], currentMessageId: null, storeNames: [], error: 'open failed: ' + (e && e.message) });
    }
    req.onerror = () => done({ messages: [], currentMessageId: null, storeNames: [], error: 'open error' });
    req.onsuccess = () => {
      const db = req.result;
      try {
        const storeNames = Array.from(db.objectStoreNames) as string[];
        if (storeNames.indexOf('history-message') === -1) {
          db.close();
          return done({ messages: [], currentMessageId: null, storeNames, error: 'no history-message store' });
        }
        const tx = db.transaction('history-message', 'readonly');
        const store = tx.objectStore('history-message');
        const g = store.get(sessionId);
        g.onerror = () => { db.close(); done({ messages: [], currentMessageId: null, storeNames, error: 'get error' }); };
        g.onsuccess = () => {
          db.close();
          const val = g.result;
          const data = val && val.data;
          const msgs = data && data.chat_messages;
          if (!Array.isArray(msgs)) {
            return done({ messages: [], currentMessageId: null, storeNames, error: 'no chat_messages' });
          }

          // 抽取正文：优先 content 字符串，其次 fragments 数组
          const extractContent = (m: any): { content: string; source: string; rawKeys: string[] } => {
            if (typeof m.content === 'string' && m.content) {
              return { content: m.content, source: 'content', rawKeys: [] };
            }
            if (Array.isArray(m.fragments) && m.fragments.length > 0) {
              let s = '';
              for (const f of m.fragments) {
                if (!f) continue;
                if (typeof f.content === 'string') s += f.content;
                else if (typeof f.text === 'string') s += f.text;
              }
              if (s) return { content: s, source: 'fragments', rawKeys: [] };
            }
            return { content: '', source: 'unknown', rawKeys: Object.keys(m) };
          };

          const byId = new Map<number, any>();
          for (const m of msgs) {
            if (m && typeof m.message_id === 'number') byId.set(m.message_id, m);
          }

          // 沿 parent_id 回溯主链
          const leaf0 = data && data.chat_session && data.chat_session.current_message_id;
          let leaf: number | null = (typeof leaf0 === 'number' && byId.has(leaf0)) ? leaf0 : null;
          if (leaf == null) {
            let maxId: number | null = null;
            for (const m of msgs) {
              if (m && typeof m.message_id === 'number' && (maxId == null || m.message_id > maxId)) maxId = m.message_id;
            }
            leaf = maxId;
          }

          const chain: any[] = [];
          const seen = new Set<number>();
          let cur: number | null = leaf;
          while (cur != null && byId.has(cur) && !seen.has(cur)) {
            seen.add(cur);
            const m = byId.get(cur);
            chain.push(m);
            cur = (m && typeof m.parent_id === 'number') ? m.parent_id : null;
          }
          chain.reverse();

          const ordered = (chain.length <= 1 && msgs.length > 1) ? msgs.slice() : chain;
          ordered.sort((a, b) => (a.message_id || 0) - (b.message_id || 0));

          const messages = ordered.map((m: any) => {
            const ex = extractContent(m);
            return {
              messageId: m.message_id,
              role: String(m.role || ''),
              content: ex.content,
              contentSource: ex.source,
              rawKeys: ex.rawKeys.length > 0 ? ex.rawKeys : undefined,
            };
          });

          done({ messages, currentMessageId: leaf, storeNames });
        };
      } catch (e: any) {
        try { db.close(); } catch (_) {}
        done({ messages: [], currentMessageId: null, storeNames: [], error: 'exception: ' + (e && e.message) });
      }
    };
  });
}

export { readConversationInPage };
export type { ConversationMessage };
