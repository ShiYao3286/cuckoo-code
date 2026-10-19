import { Tool } from '../core/Tool.js';
import type { ToolApiMeta } from '../core/Tool.js';
import { ToolResult } from '../core/ToolResult.js';
import { observe, statVersion } from '../runtime/fs-observation.js';
import fs from 'node:fs';
import path from 'node:path';

// ========== D12：API 契约元数据（构建期生成 api.d.ts）==========
export const apiMetas: ToolApiMeta[] = [
  {
    order: 1,
    category: '文件读写',
    name: 'read',
    types: [
      '/** read 的选项 */',
      'interface ReadOptions {',
      '  /** 1-based 起始行号，默认 1 */',
      '  offset?: number;',
      '  /** 最大返回行数，默认 2000，上限 2000 */',
      '  limit?: number;',
      '}',
    ].join('\n'),
    doc: [
      '读取 UTF-8 文本文件并返回带行号的内容窗口。',
      '通过 offset 和 limit 分段读取大文件。输出为格式化文本：',
      '<path>...</path>',
      '<type>file</type>',
      '<content>',
      '行号: 内容',
      '...',
      '(footer 提示是否继续读取)',
      '</content>',
    ].join('\n'),
    params: 'filePath: string, options?: ReadOptions',
    returns: 'Promise<string>',
    paramDocs: {
      filePath: '相对（基于项目根目录）或绝对路径',
      options: '可选，offset/limit',
    },
    throws: '文件不存在、不是文件、offset 越界或读取失败时抛出异常',
  },
];

// 与 dsh read 对齐的默认上限
const READ_LIMIT = 2000;
const READ_MAX_LINE_LENGTH = 2000;
const READ_MAX_BYTES = 50 * 1024;
// 流式读块大小（T4）：只影响内存占用，不影响输出
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * 校验并归一化 read 参数。
 * offset/limit 必须是正整数，limit 不能超过 READ_LIMIT。
 */
function parseReadArgs(filePath: any, offset: any, limit: any): { offset: number; limit: number } {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('filePath must be a non-empty string');
  }
  const parsedOffset = offset === undefined || offset === null ? 1 : Number(offset);
  const parsedLimit = limit === undefined || limit === null ? READ_LIMIT : Number(limit);
  if (!Number.isInteger(parsedOffset) || parsedOffset < 1) {
    throw new Error('offset must be a positive integer');
  }
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
    throw new Error('limit must be a positive integer');
  }
  if (parsedLimit > READ_LIMIT) {
    throw new Error('limit must be less than or equal to ' + READ_LIMIT);
  }
  return { offset: parsedOffset, limit: parsedLimit };
}

function truncateLine(line: string, maxLineLength: number): string {
  return line.length > maxLineLength
    ? line.substring(0, maxLineLength) + '... (line truncated to ' + maxLineLength + ' chars)'
    : line;
}

function lineByteSize(line: string, currentLineCount: number): number {
  return Buffer.byteLength(line, 'utf8') + (currentLineCount > 0 ? 1 : 0);
}

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

interface WindowRequest {
  offset: number;
  limit: number;
  maxLineLength: number;
  maxBytes: number;
}

interface WindowLine {
  number: number;
  text: string;
}

interface WindowResult {
  lines: WindowLine[];
  totalLines: number;
  truncatedByBytes: boolean;
}

/**
 * 从全文构建带行号的窗口，逻辑对齐 dsh read-render.buildWindow。
 */
function buildWindow(text: string, request: WindowRequest, displayPath: string): WindowResult {
  const acc = { lines: [] as WindowLine[], totalLines: 0, outputBytes: 0, truncatedByBytes: false };
  const rawLines = text.split(/\r?\n/);

  // 按行扫描：每行都计入 totalLines，但只保留窗口内的行
  for (const rawLine of rawLines) {
    acc.totalLines += 1;
    if (acc.truncatedByBytes || acc.totalLines < request.offset || acc.lines.length >= request.limit) continue;

    const lineText = stripCarriageReturn(rawLine);
    const text2 = truncateLine(lineText, request.maxLineLength);
    const bytes = lineByteSize(text2, acc.lines.length);
    if (acc.outputBytes + bytes > request.maxBytes) {
      acc.truncatedByBytes = true;
      continue;
    }
    acc.outputBytes += bytes;
    acc.lines.push({ number: acc.totalLines, text: text2 });
  }

  if (!acc.truncatedByBytes && request.offset > acc.totalLines && !(acc.totalLines === 0 && request.offset === 1)) {
    throw new Error('offset ' + request.offset + ' is out of range for "' + displayPath + '" (' + acc.totalLines + ' lines)');
  }

  return {
    lines: acc.lines,
    totalLines: acc.totalLines,
    truncatedByBytes: acc.truncatedByBytes,
  };
}

/**
 * 流式读取文件并构建窗口（T4）。
 *
 * 为什么不能只读窗口区间：回传的 footer 要显示 `of N lines`，需要**精确总行数**。
 * 所以仍然要扫完全文，但不再把整份文件读成一个大字符串——
 * 按块读、逐行计数，只为窗口内的行构造字符串，内存占用从 O(文件大小) 降到 O(块 + 窗口)。
 *
 * 语义与 `buildWindow(fs.readFileSync(path, 'utf-8'))` **逐字节等价**（含这些边界）：
 *  - 空文件 → 1 行（与 `''.split(/\r?\n/)` = `['']` 一致）
 *  - 文件以换行结尾 → 末尾多一个空行（与 split 一致）
 *  - CRLF → 行尾 \r 去掉（与 stripCarriageReturn 一致）
 *  - UTF-8 多字节字符不会被块边界切断：\n(0x0A) 不会出现在多字节序列内部
 *
 * @throws 文件读取失败或 offset 越界
 */
function readFileWindow(absPath: string, request: WindowRequest, displayPath: string): WindowResult {
  const acc = { lines: [] as WindowLine[], totalLines: 0, outputBytes: 0, truncatedByBytes: false };
  const fd = fs.openSync(absPath, 'r');
  try {
    const chunkBuf = Buffer.alloc(READ_CHUNK_BYTES);
    let pending: Buffer = Buffer.alloc(0);
    let sawAnyByte = false;
    let lastByteWasNewline = false;

    /** 收一行（buf 不含换行符） */
    const emit = (lineBuf: Buffer): void => {
      acc.totalLines += 1;
      if (acc.truncatedByBytes || acc.totalLines < request.offset || acc.lines.length >= request.limit) return;
      const lineText = stripCarriageReturn(lineBuf.toString('utf-8'));
      const text = truncateLine(lineText, request.maxLineLength);
      const bytes = lineByteSize(text, acc.lines.length);
      if (acc.outputBytes + bytes > request.maxBytes) {
        acc.truncatedByBytes = true;
        return;
      }
      acc.outputBytes += bytes;
      acc.lines.push({ number: acc.totalLines, text });
    };

    while (true) {
      const n = fs.readSync(fd, chunkBuf, 0, chunkBuf.length, null);
      if (n === 0) break;
      sawAnyByte = true;
      const chunk = n === chunkBuf.length ? chunkBuf : chunkBuf.subarray(0, n);
      const combined = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      let start = 0;
      let idx: number;
      while ((idx = combined.indexOf(0x0a, start)) !== -1) {
        emit(combined.subarray(start, idx));
        start = idx + 1;
      }
      // 未完成的行必须复制：combined 可能引用 chunkBuf，下次 readSync 会覆盖
      pending = start < combined.length ? Buffer.from(combined.subarray(start)) : Buffer.alloc(0);
      lastByteWasNewline = combined[combined.length - 1] === 0x0a;
    }

    // 收尾（三种互斥情形，覆盖 split 语义）
    if (!sawAnyByte) {
      emit(Buffer.alloc(0)); // 空文件 = 1 个空行
    } else if (pending.length > 0) {
      emit(pending); // 末尾无换行的最后一行
    } else if (lastByteWasNewline) {
      emit(Buffer.alloc(0)); // 文件以换行结尾 → 尾部空行
    }
  } finally {
    fs.closeSync(fd);
  }

  if (!acc.truncatedByBytes && request.offset > acc.totalLines && !(acc.totalLines === 0 && request.offset === 1)) {
    throw new Error('offset ' + request.offset + ' is out of range for "' + displayPath + '" (' + acc.totalLines + ' lines)');
  }

  return {
    lines: acc.lines,
    totalLines: acc.totalLines,
    truncatedByBytes: acc.truncatedByBytes,
  };
}

/**
 * 与 dsh formatReadOutput 保持一致：返回 envelope，包含行号和 footer。
 */
function formatReadOutput(displayPath: string, outcome: any): string {
  const endLine = outcome.lines.length > 0
    ? outcome.lines[outcome.lines.length - 1].number
    : Math.max(0, outcome.offset - 1);

  let footer;
  if (outcome.truncatedByBytes) {
    footer = '(Output capped. Showing lines ' + outcome.offset + '-' + endLine + '. Use offset=' + (endLine + 1) + ' to continue.)';
  } else if (endLine < outcome.totalLines) {
    footer = '(Showing lines ' + outcome.offset + '-' + endLine + ' of ' + outcome.totalLines + '. Use offset=' + (endLine + 1) + ' to continue.)';
  } else {
    footer = '(End of file - total ' + outcome.totalLines + ' lines)';
  }

  const body = outcome.lines.length > 0
    ? outcome.lines.map((line: WindowLine) => line.number + ': ' + line.text).join('\n') + '\n\n' + footer
    : footer;

  return '<path>' + displayPath + '</path>\n<type>file</type>\n<content>\n' + body + '\n</content>';
}

/**
 * read 工具 - 完全仿照 dsh 的 read。
 * 返回带行号的文本窗口，支持 offset/limit 分段读取大文件。
 */
class ReadTool extends Tool {
  constructor() {
    super(
      'read',
      '读取 UTF-8 文本文件并返回带行号的内容窗口。支持 offset/limit 分段读取大文件。',
      {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: '要读取的文件路径（相对路径基于项目根目录，或绝对路径）'
          },
          offset: {
            type: 'number',
            description: '1-based 起始行号，默认 1'
          },
          limit: {
            type: 'number',
            description: '最大返回行数，默认 ' + READ_LIMIT + '，上限 ' + READ_LIMIT
          }
        },
        required: ['filePath'],
        additionalProperties: false
      },
      'read(filePath, options?)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:read',
      order: 100,
      text: '使用 read 工具（而不是 cat 等 shell 命令）来查看文本文件。结果包含行号。使用 offset 和 limit 继续读取大文件。'
    };
  }

  async execute(params: any): Promise<ToolResult> {
    const { filePath, offset, limit, projectDir } = params;

    try {
      const input = parseReadArgs(filePath, offset, limit);

      // 路径解析：相对路径基于 projectDir
      const normalizedPath = String(filePath).replace(/\//g, path.sep);
      let resolvedPath = normalizedPath;
      if (!path.isAbsolute(normalizedPath) && projectDir) {
        resolvedPath = path.join(projectDir, normalizedPath);
      } else if (!path.isAbsolute(normalizedPath)) {
        resolvedPath = path.resolve(normalizedPath);
      }

      // 文件存在性与类型检查
      if (!fs.existsSync(resolvedPath)) {
        return ToolResult.error('文件不存在: ' + resolvedPath);
      }
      const stat = fs.statSync(resolvedPath);
      if (!stat.isFile()) {
        return ToolResult.error('不是文件: ' + resolvedPath);
      }

      // 流式扫描（T4）：不再把整份文件读成字符串，内存 O(块+窗口)；totalLines 仍精确
      const request: WindowRequest = {
        offset: input.offset,
        limit: input.limit,
        maxLineLength: READ_MAX_LINE_LENGTH,
        maxBytes: READ_MAX_BYTES,
      };
      const window = readFileWindow(resolvedPath, request, filePath);

      // 记录权威观察：本会话此后 edit/write 该文件才被视为"读过"
      // 版本串必须走 statVersion（含内容指纹）——不要在这里手拼，
      // 格式一旦与 statVersion 漂移，护栏会永久误判 STALE_VERSION。
      const observedVersion = statVersion(resolvedPath);
      if (observedVersion) observe(params && params.sessionId, resolvedPath, observedVersion);

      console.log('[ReadTool] 已读取:', resolvedPath, 'offset=' + input.offset, 'limit=' + input.limit, 'totalLines=' + window.totalLines);
      return ToolResult.success(formatReadOutput(filePath, { ...window, offset: input.offset }));
    } catch (err: any) {
      return ToolResult.error('读取文件失败: ' + err.message);
    }
  }
}

/**
 * JsRunner 沙箱注入：定义 globalThis.read。
 * 源码经 scripts/build-tool-api.mjs 提取组装进 JsRunner 的 BOOTSTRAP。
 */
export function bootstrap(__call: any): void {
  (globalThis as any).read = async function (filePath: any, options: any) {
    options = options || {};
    return await __call('read', {
      filePath: filePath,
      offset: options.offset,
      limit: options.limit,
    });
  };
}

export { ReadTool, READ_LIMIT, READ_MAX_LINE_LENGTH, READ_MAX_BYTES, READ_CHUNK_BYTES, parseReadArgs, buildWindow, readFileWindow, formatReadOutput };
