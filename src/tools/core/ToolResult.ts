/**
 * 统一的工具执行结果
 *
 * code：稳定的机器可路由错误码（移植自 DSH 的 HarnessError.code 理念——
 * "route on this, never by parsing message"）。可选；无码时为 null。
 * 有码时 JsRunner 会把 `[error code: X]` 渲染进回传给模型的文本，
 * 让模型按码分流处理，而不是靠正则猜中文错误文案。
 */
/** 工具结果元数据：供 JsRunner 汇总成给模型的结构化提示（不进沙箱返回值） */
interface ToolResultMeta {
  /** 结果是否被截断（模型应据此决定是否用 offset 续读 / 缩小范围） */
  truncated?: boolean;
  /** 总条数/总行数（已知时） */
  totalCount?: number;
  /** 本次返回的条数/行数 */
  returnedCount?: number;
  /** 续读建议（如 "Use offset=2001 to continue."），拼进汇总提示 */
  hint?: string;
}

class ToolResult {
  success: boolean;
  data: any;
  error: any;
  code: string | null;
  meta: ToolResultMeta | null;

  constructor(success: boolean, data: any, error: any, code?: string | null, meta?: ToolResultMeta | null) {
    this.success = success;
    this.data = data;
    this.error = error;
    this.code = code || null;
    this.meta = meta || null;
  }

  static success(data: any): ToolResult {
    return new ToolResult(true, data, null);
  }

  /**
   * 成功 + 元数据。用于 read/grep/bash/webFetch 等可能截断的工具：
   * data 仍是给模型的原文本，meta 由 JsRunner 汇总成脚本末尾的结构化提示。
   */
  static successWithMeta(data: any, meta: ToolResultMeta): ToolResult {
    return new ToolResult(true, data, null, null, meta);
  }

  static error(error: any, code?: string): ToolResult {
    return new ToolResult(false, null, error, code || null);
  }

  toString(): string {
    return this.success
      ? '✅ 成功: ' + JSON.stringify(this.data)
      : '❌ 失败: ' + this.error;
  }
}

/**
 * 工具错误码（唯一真相源）。
 * 新增码时同步在 src/prompt/discipline.md 的「失败分流」表里补一行说明。
 */
const ToolErrorCode = {
  /** 未先 read 就 edit/write 一个已存在的文件 */
  NOT_OBSERVED: 'NOT_OBSERVED',
  /** 上次读取后文件已被改动，需重新 read */
  STALE_VERSION: 'STALE_VERSION',
  /** oldString 未命中 */
  NO_MATCH: 'NO_MATCH',
  /** oldString 多处命中且未设 replaceAll */
  AMBIGUOUS_MATCH: 'AMBIGUOUS_MATCH',
  /** 目标路径受保护（用户数据） */
  PROTECTED_PATH: 'PROTECTED_PATH',
  /** 文件不存在 */
  NOT_FOUND: 'NOT_FOUND',
  /** 参数非法 */
  INVALID_ARGS: 'INVALID_ARGS',
  /** 计划模式草稿/待确认阶段禁止写操作 */
  PLAN_READ_ONLY: 'PLAN_READ_ONLY',
} as const;

export { ToolResult, ToolErrorCode };
export type { ToolResultMeta };
