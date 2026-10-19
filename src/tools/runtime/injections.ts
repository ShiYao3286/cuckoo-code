/**
 * 每轮注入通道（T2）
 *
 * 背景：JsRunner 里有若干"拼在回传输出开头"的内容——规则注入、重复调用提醒，
 * 将来还会有别的（纪律提醒等）。此前每加一种就在 run() 里手动 prepend 一次，
 * 顺序靠代码先后隐式决定，没有去重、没有长度上限。
 *
 * 本模块把这件事收口成一个通道：
 *  - **顺序**：blocks 按传入顺序自上而下（调用方显式决定，不再靠 prepend 的巧合）
 *  - **去重**：完全相同的块只保留一次（规则与提醒可能撞车）
 *  - **预算**：总长超限时按块截断，并显式告知"已截断"，而不是悄悄丢掉
 *
 * 为什么不做成"每轮注入整份纪律"：纪律全文约 2KB，每轮重发会挤占上下文，
 * 长会话更早触发压缩（NEXT-PLAN T2 风险项）。错误码本身已带下一步指令，
 * 真正需要每轮可见的是"这次为什么被拦 + 该怎么改"，那是工具结果的职责。
 */

/** 单块长度上限（字符） */
const MAX_BLOCK_CHARS = 1500;
/** 所有注入块合计上限（字符） */
const MAX_TOTAL_CHARS = 3000;

/** 截断单块，超出部分用省略标记收尾 */
function capBlock(text: string): string {
  if (text.length <= MAX_BLOCK_CHARS) return text;
  return text.slice(0, MAX_BLOCK_CHARS) + '\n…（本条提醒过长，已截断）';
}

/**
 * 把若干注入块拼到输出开头。
 *
 * @param output 工具脚本的原始回传文本（可为空串）
 * @param blocks 注入块，按期望出现顺序排列；空串/null 会被忽略
 * @returns 拼好的文本（无有效块时原样返回 output）
 */
function prependInjections(output: string, blocks: Array<string | null | undefined>): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  let total = 0;
  let truncated = false;

  for (const raw of blocks) {
    if (typeof raw !== 'string') continue;
    const text = raw.trim();
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);

    let piece = capBlock(text);
    if (piece.length !== text.length) truncated = true;
    if (total + piece.length > MAX_TOTAL_CHARS) {
      // 预算耗尽：停止追加后续块（顺序在前的优先保留）
      truncated = true;
      break;
    }
    total += piece.length;
    kept.push(piece);
  }

  if (kept.length === 0) return output;
  let head = kept.join('\n\n');
  if (truncated) {
    head += '\n\n（本轮注入内容较多，已按预算截断；完整规则请 read 对应文件。）';
  }
  return output ? head + '\n\n' + output : head;
}

export { prependInjections, MAX_BLOCK_CHARS, MAX_TOTAL_CHARS };
