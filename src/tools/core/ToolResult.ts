/**
 * 统一的工具执行结果
 *
 * code：稳定的机器可路由错误码（移植自 DSH 的 HarnessError.code 理念——
 * "route on this, never by parsing message"）。可选；无码时为 null。
 * 有码时 JsRunner 会把 `[error code: X]` 渲染进回传给模型的文本，
 * 让模型按码分流处理，而不是靠正则猜中文错误文案。
 */
class ToolResult {
  success: boolean;
  data: any;
  error: any;
  code: string | null;

  constructor(success: boolean, data: any, error: any, code?: string | null) {
    this.success = success;
    this.data = data;
    this.error = error;
    this.code = code || null;
  }

  static success(data: any): ToolResult {
    return new ToolResult(true, data, null);
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
} as const;

export { ToolResult, ToolErrorCode };
