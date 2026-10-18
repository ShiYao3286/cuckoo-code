/**
 * goalBlocked 工具 —— 目标模式的显式受阻动作
 *
 * AI 在目标确实无法继续推进时调用本工具，主进程向该窗口的 harness 视图
 * 推送 goal-blocked 事件，暂停自动推进并把「需要什么才能继续」显示给用户。
 *
 * 为什么需要它（取代靠正则猜"模型是否在索要信息"）：
 * 自动续跑用文本特征判断"模型在等人"不可靠——漏判会刷成一堆重复索要，
 * 误判会把模型的正常推进当故障停下。受阻应当是**模型的显式声明**，
 * 与 goalDone 同一个道理（见 goal-done.ts：文本标记 [[GOAL_DONE]] 已被工具取代）。
 *
 * 语义取自 DSH 的 dsh-tool-goal（goal blocked / blocked_reason）：
 * 只有跨多轮持续存在的障碍才算受阻，"有点难/还没做完"不算。
 */
import { Tool } from '../core/Tool.js';
import type { ToolApiMeta } from '../core/Tool.js';
import { ToolResult } from '../core/ToolResult.js';

/**
 * 推送"目标受阻"事件到该窗口的 harness 视图（由 app 层注入，避免 tools → app 的反向依赖）。
 * @returns { success, error? }
 */
export type GoalBlockedPusher = (windowId: number, reason: string) => { success: boolean; error?: string };

let _pushGoalBlocked: GoalBlockedPusher | null = null;

/** 由 app 层注入实现 */
export function injectGoalBlockedPusher(fn: GoalBlockedPusher): void {
  _pushGoalBlocked = fn;
}

// ========== D12：API 契约元数据（构建期生成 api.d.ts）==========
export const apiMetas: ToolApiMeta[] = [
  {
    order: 20,
    category: '任务管理',
    name: 'goalBlocked',
    doc: [
      '宣告当前目标（/goal 设定的自动多轮任务）被阻塞，暂停自动推进并等待用户处理。',
      'reason 要写清"需要什么才能继续"（凭据、决策、缺失文件、外部服务…），用户据此决定下一步。',
      '只在阻碍**确实无法靠自己绕过**时调用：还没做完、有点难、不太确定都不算阻塞——继续推进或直接提问。',
      '非目标模式的普通对话不需要调用本工具。',
    ].join('\n'),
    params: 'reason: string',
    returns: 'Promise<string>',
    paramDocs: {
      reason: '阻塞原因与所需条件（一句话，面向用户，如"需要目标机器的 SSH 凭据才能继续"）',
    },
    returnsDoc: '确认消息',
    throws: '缺少窗口上下文、窗口已关闭、原因为空或纯净对话模式未开启时抛出异常',
  },
];

class GoalBlockedTool extends Tool {
  constructor() {
    super(
      'goalBlocked',
      '宣告当前目标（/goal 设定的自动多轮任务）被阻塞，暂停自动推进并等待用户处理。仅在阻碍无法靠自己绕过时调用，reason 写清需要什么才能继续。',
      {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: '阻塞原因与所需条件（面向用户的一句话）',
          },
        },
        required: ['reason'],
        additionalProperties: false,
      },
      'goalBlocked(reason)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:goalBlocked',
      order: 116,
      text: [
        '**目标受阻**：仅当目标因**外部条件缺失**确实推不下去时（需要凭据 / 需要用户决策 / 依赖的服务没起来 / 缺关键文件），调用 goalBlocked("我需要什么才能继续") 暂停自动推进，把决定权交回用户。',
        '以下都**不是**阻塞：还没做完、有点难、不太确定、还需要更多验证——这些情况继续推进或直接提问即可。',
        '同一个阻碍至少要持续两三轮、且你已认真试过绕过办法，才算阻塞；不要一遇阻力就停。',
        '目标全部完成用 goalDone()，被卡住用 goalBlocked(reason)，两者不要混用；普通对话（非目标模式）都不要调用。',
      ].join('\n'),
    };
  }

  async execute(params: any): Promise<ToolResult> {
    const reason = String((params && params.reason) || '').trim();
    if (!reason) return ToolResult.error('goalBlocked 需要 reason：请说明被什么卡住、需要什么才能继续');
    const { currentWindowId, windowId } = params || {};
    const targetWindowId = currentWindowId !== undefined && currentWindowId !== null ? currentWindowId : windowId;
    if (targetWindowId === undefined || targetWindowId === null) {
      return ToolResult.error('缺少窗口上下文，无法定位当前对话窗口');
    }
    if (!_pushGoalBlocked) return ToolResult.error('目标受阻推送器未初始化');
    const r = _pushGoalBlocked(targetWindowId, reason);
    if (!r || !r.success) {
      return ToolResult.error(r && r.error ? r.error : '推送目标受阻事件失败');
    }
    console.log('[GoalBlockedTool] AI 已宣告目标受阻（window ' + targetWindowId + '）: ' + reason);
    return ToolResult.success({ message: '目标已标记为受阻，自动推进已暂停，等待用户处理。' });
  }
}

/** JsRunner 沙箱注入：定义 globalThis.goalBlocked。 */
export function bootstrap(__call: any): void {
  (globalThis as any).goalBlocked = async function (reason: any) {
    return await __call('goalBlocked', { reason: reason });
  };
}

export { GoalBlockedTool };
