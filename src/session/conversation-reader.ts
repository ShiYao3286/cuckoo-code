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

          /**
           * 抽取正文。
           *
           * 三层策略（从确定到自适应）：
           *   1. 已知字段：m.content（字符串）/ m.fragments（数组）
           *   2. 常见嵌套：m.message.content / m.data.content 等
           *   3. 兜底扫描：遍历所有字符串字段，取最长的那个（正文通常显著长于其他字段）
           *
           * 为什么不硬编码字段名：DeepSeek 的 IDB 结构可能随版本变化，
           * 而「正文是消息里最长的字符串」这个观察是稳定的。
           * 探测命中时把 source 写成 'auto:<字段名>'，便于排查。
           */
          const extractContent = (m: any): { content: string; source: string; rawKeys: string[] } => {
            // 1. 已知字段
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

            // 2. 常见嵌套
            for (const wrapKey of ['message', 'data', 'payload', 'body']) {
              const inner = m[wrapKey];
              if (inner && typeof inner === 'object') {
                if (typeof inner.content === 'string' && inner.content) {
                  return { content: inner.content, source: 'auto:' + wrapKey + '.content', rawKeys: [] };
                }
                if (typeof inner.text === 'string' && inner.text) {
                  return { content: inner.text, source: 'auto:' + wrapKey + '.text', rawKeys: [] };
                }
              }
            }

            // 3. 兜底：找最长的字符串字段
            //    排除明显不是正文的字段（id/时间戳/角色/父指针）
            const skip = new Set(['role', 'id', 'message_id', 'parent_id', 'status', 'model', 'type', 'created_at', 'updated_at', 'inserted_at']);
            // 排除 ISO 时间戳格式（如 2026-10-19T12:00:00Z）——它们可能比短正文长
            const isIsoTimestamp = (s: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s);
            let bestKey = '';
            let bestVal = '';
            for (const k of Object.keys(m)) {
              if (skip.has(k)) continue;
              const v = m[k];
              if (typeof v !== 'string') continue;
              if (isIsoTimestamp(v)) continue;
              if (v.length > bestVal.length) {
                bestKey = k;
                bestVal = v;
              }
            }
            // 长度阈值：2 字符（中文 2 字已有意义；配合上面的时间戳排除，误判风险可控）
            if (bestVal.length >= 2) {
              return { content: bestVal, source: 'auto:' + bestKey, rawKeys: [] };
            }

            // 全都没命中：把字段名和类型 dump 出去，供排查
            const debugKeys = Object.keys(m).map((k) => k + '(' + typeof m[k] + ')');
            return { content: '', source: 'unknown', rawKeys: debugKeys };
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
