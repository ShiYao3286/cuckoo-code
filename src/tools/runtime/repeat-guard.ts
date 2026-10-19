/**
 * 重复工具调用检测（移植 DSH 的 dsh-repeat-tool-reminder 思路）
 *
 * 问题：模型卡住时最常见的失败模式是**反复发同一个调用**——
 * 同一个 read、同一条 bash、同一个失败的 edit。每次都是一次完整的网页往返，
 * 零 token 成本只是名义上的，实际烧的是网页额度与等待时间。
 *
 * DSH 的做法是独立插件（69.9KB，含 schema/类型）在工具调用上做提醒。
 * Cuckoo 没有那条事件总线，改为在 JsRunner 的 hostBridge 里记账：
 * 同一会话内，(工具名 + 规范化参数) 连续出现时，把提醒**拼进回传结果**——
 * 走的是模型每轮必读的通道，比在提示词里写"别重复"有效得多。
 *
 * 设计要点：
 *  - **只提醒、不阻断**：重复有时是合理的（轮询日志、等构建）。硬拦会打断合法用法。
 *  - 按会话隔离；同一脚本内重置（一个脚本里 for 循环调用 get 不算跨轮重复）。
 *  - 连续重复才计数，中间夹了别的调用就清零（"连续"才说明卡住）。
 *  - 结果不变但调用相同 → 更容易卡住；本项目简化处理，只按调用签名判重。
 */

/** 一次调用的登记 */
interface RepeatState {
  /** 上一次调用的签名 */
  lastSignature: string;
  /** 连续相同次数 */
  streak: number;
  /** 已提醒过的次数（避免每次重复都刷提醒） */
  warned: number;
}

const DEFAULT_THRESHOLD = 3;
const MAX_WARNINGS = 2;

/** 按会话隔离的检测状态 */
/** 按会话隔离的检测状态（会话数有上限，防长期运行累积） */
const stateBySession = new Map<string, RepeatState>();
const MAX_SESSIONS = 200;

function sessionKey(sessionId: any): string {
  return typeof sessionId === 'string' && sessionId ? sessionId : '(default)';
}

/** 会话超量时按插入顺序淘汰最旧（Map 保持插入序） */
function evictOldestSession(): void {
  while (stateBySession.size > MAX_SESSIONS) {
    const first = stateBySession.keys().next().value;
    if (first === undefined) break;
    stateBySession.delete(first);
  }
}

/**
 * 稳定序列化参数：对象键排序，避免 {a:1,b:2} 与 {b:2,a:1} 被判成不同调用。
 * 数组保持顺序（顺序有意义）。超长值截断，避免大内容进内存。
 */
function stableArgs(args: any): string {
  try {
    const seen = new WeakSet();
    const norm = (v: any): any => {
      if (v === null || typeof v !== 'object') {
        if (typeof v === 'string' && v.length > 200) return v.slice(0, 200) + '…';
        return v;
      }
      if (seen.has(v)) return '[circular]';
      seen.add(v);
      if (Array.isArray(v)) return v.map(norm);
      const out: Record<string, any> = {};
      for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
      return out;
    };
    return JSON.stringify(norm(args));
  } catch (_) {
    return '';
  }
}

/** 调用签名：工具名 + 规范化参数 */
function signatureOf(toolName: string, args: any): string {
  return toolName + '|' + stableArgs(args);
}

/** 重置某会话的检测状态（新任务/新对话/新脚本时调用） */
function resetSession(sessionId: any): void {
  stateBySession.delete(sessionKey(sessionId));
}

/** 清空全部（仅测试） */
function resetAll(): void {
  stateBySession.clear();
}

/**
 * 登记一次工具调用，返回需要追加到结果文本的提醒（无则空串）。
 *
 * @param sessionId 会话 id
 * @param toolName 工具名
 * @param args 调用参数
 * @param success 本次是否成功
 * @param threshold 连续多少次算卡住（默认 3）
 */
function recordCall(
  sessionId: any,
  toolName: string,
  args: any,
  success: boolean,
  threshold: number = DEFAULT_THRESHOLD
): string {
  // 阈值 <=0 = 关闭提醒（配置项语义）；但仍要维持 streak 连续性，
  // 简单起见直接不记账不提醒。
  if (!Number.isFinite(threshold) || threshold <= 0) return '';
  const key = sessionKey(sessionId);
  const sig = signatureOf(toolName, args);
  let st = stateBySession.get(key);
  if (!st) {
    st = { lastSignature: '', streak: 0, warned: 0 };
    stateBySession.set(key, st);
    evictOldestSession();
  }

  if (sig === st.lastSignature) {
    st.streak++;
  } else {
    st.lastSignature = sig;
    st.streak = 1;
    st.warned = 0;
  }

  if (st.streak < threshold) return '';
  if (st.warned >= MAX_WARNINGS) return '';
  st.warned++;

  const what = success ? '同一个调用' : '同一个失败调用';
  return [
    '【重复调用提醒】你已经连续 ' + st.streak + ' 次' + what + '：' + toolName + ' ' + shortArgs(args),
    '继续重复不会有新结果。请换策略：',
    '① 若在轮询等待，说明当前在等什么，并改用更长的等待或先做别的步骤；',
    '② 若命令/工具报错，按失败信息调整参数后再试，不要原样重发；',
    '③ 若不确定文件/命令的真实状态，换个检查手段（read 指定行窗口、grep 目标片段、换一条命令）；',
    '④ 若确实被外部条件卡住，用 goalBlocked("需要什么才能继续") 交回用户。',
  ].join('\n');
}

/** 参数摘要（提醒里显示，避免整段大内容进提醒） */
function shortArgs(args: any): string {
  try {
    const s = JSON.stringify(args);
    if (!s || s === '{}') return '';
    return s.length > 160 ? s.slice(0, 160) + '…' : s;
  } catch (_) {
    return '';
  }
}

export { recordCall, resetSession, resetAll, signatureOf, stableArgs, DEFAULT_THRESHOLD };
