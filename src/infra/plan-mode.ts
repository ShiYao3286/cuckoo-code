/**
 * 计划模式阶段（主进程侧镜像）
 *
 * 背景：plan 状态原本只存在于 harness 渲染进程的 localStorage，
 * 工具层（主进程）拿不到——"草稿期只读"只能靠提示词自觉（032 档案遗留项）。
 * 本模块把 harness 的阶段变化上报到主进程，供 write/edit/deleteFile 强制拦截。
 *
 * 为什么放 infra：依赖铁律 `infra ← providers ← tools ← bridge ← session ← app`，
 * tools 不能 import session/app；harness IPC（app 层）写、tools 层读，infra 是唯一合法交点。
 *
 * 键：sessionStore 的 currentSessionId（与 ipc/tool.ts 传给工具的 settings.sessionId 同源，
 * 保证写入方与读取方用同一个键）。值：harness 的 planState.phase，无计划时为 'off'。
 */

export type PlanPhase = 'draft' | 'confirm' | 'exec' | 'done' | 'blocked' | 'off';

/** sessionId -> 阶段 */
const phaseBySession = new Map<string, PlanPhase>();

/** 会话数上限（防长期运行累积；Map 保持插入序，超限淘汰最旧） */
const MAX_SESSIONS = 200;

const VALID_PHASES: PlanPhase[] = ['draft', 'confirm', 'exec', 'done', 'blocked', 'off'];

function sessionKey(sessionId: any): string {
  return typeof sessionId === 'string' && sessionId ? sessionId : '(default)';
}

/** 上报某会话的计划阶段（非法值忽略，防渲染进程异常数据污染） */
function setPlanPhase(sessionId: any, phase: any): void {
  if (VALID_PHASES.indexOf(phase) === -1) return;
  const key = sessionKey(sessionId);
  phaseBySession.set(key, phase);
  while (phaseBySession.size > MAX_SESSIONS) {
    const first = phaseBySession.keys().next().value;
    if (first === undefined) break;
    phaseBySession.delete(first);
  }
}

/** 读取某会话的计划阶段（未知返回 'off'） */
function getPlanPhase(sessionId: any): PlanPhase {
  return phaseBySession.get(sessionKey(sessionId)) || 'off';
}

/**
 * 该会话是否处于"只读阶段"（草拟/待确认）。
 * exec/done/blocked/off 不拦——用户确认后就是要让模型干活。
 */
function isPlanReadOnly(sessionId: any): boolean {
  const p = getPlanPhase(sessionId);
  return p === 'draft' || p === 'confirm';
}

/** 会话删除/新对话时清理（与 rules/injection.ts 的 clearSession 对齐） */
function clearSession(sessionId: any): void {
  phaseBySession.delete(sessionKey(sessionId));
}

/** 清空全部（仅测试用） */
function clearAll(): void {
  phaseBySession.clear();
}

/**
 * 计划只读护栏：草稿/待确认阶段拒绝写类工具。
 * @returns null = 放行；否则返回给模型的拒绝文本（含下一步）
 */
function guardPlanReadOnly(sessionId: any, toolName: string, phase: PlanPhase | null = null): string | null {
  const p = phase || getPlanPhase(sessionId);
  if (p !== 'draft' && p !== 'confirm') return null;
  return '当前处于计划模式（' + (p === 'draft' ? '草拟' : '等待用户确认') + '阶段），禁止一切写操作。'
    + '被拒绝的调用: ' + toolName + '\n'
    + '下一步: 用 todoWrite([{content, status:"pending"}, …]) 列出分步计划（写成 cuckoo 代码块），'
    + '然后用一两句话说明计划已列出、等待用户确认。用户确认进入执行阶段后才能改文件。';
}

/**
 * 有副作用的工具黑名单（计划草稿/待确认期拒绝）。
 *
 * 为什么用黑名单而不是"只放行读工具"：todoWrite/goalDone/goalBlocked/nameConversation
 * 这些"元工具"在草稿期必须可用——草稿期的正确动作恰恰是 todoWrite 列计划。
 * 白名单会把这些也拦掉，黑名单只拦真正改世界的。
 * mcpCall 也拦：MCP server 能做任何事，等同 bash。
 * runAgent 也拦：子代理在**另一个会话**里执行，那边的计划镜像是 off——
 * 不拦就等于留了一条"草稿期借子代理偷跑写操作"的绕过通道。
 */
const WRITE_TOOLS = new Set([
  'write', 'edit', 'deleteFile',
  'bash', 'pwsh', 'mysql',
  'injectJS', 'mcpCall', 'runAgent',
]);

/** 该工具是否属于"有副作用"（受计划只读护栏约束） */
function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}

export { setPlanPhase, getPlanPhase, isPlanReadOnly, isWriteTool, guardPlanReadOnly, clearSession, clearAll };
