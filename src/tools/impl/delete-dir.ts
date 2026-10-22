import { Tool } from '../core/Tool.js';
import type { ToolApiMeta } from '../core/Tool.js';
import { ToolResult, ToolErrorCode } from '../core/ToolResult.js';
import { isProtectedPath } from '../../infra/protected-paths.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ========== D12：API 契约元数据（构建期生成 api.d.ts）==========
export const apiMetas: ToolApiMeta[] = [
  {
    order: 11,
    category: '删除',
    name: 'deleteDir',
    types: [
      '/** deleteDir 的选项 */',
      'interface DeleteDirOptions {',
      '  /** 删除非空目录时必须显式传 true（默认 false，非空目录会拒绝） */',
      '  recursive?: boolean;',
      '  /** 只列出将删除的内容，不实际删除 */',
      '  dryRun?: boolean;',
      '}',
      '/** deleteDir 的返回值 */',
      'interface DirDeleteResult {',
      '  message: string;',
      '  /** 被删除（或 dryRun 下将被删除）的目录绝对路径 */',
      '  path: string;',
      '  /** 实际删除的条目数（文件 + 子目录；dryRun 时为将要删除的数量） */',
      '  deleted: number;',
      '}',
    ].join('\n'),
    doc: [
      '删除一个目录（不可恢复）。非空目录必须显式传 recursive: true。',
      '安全护栏：拒绝删除磁盘根、用户主目录、项目根目录、系统目录、受保护路径；',
      '不跟随符号链接（链接本身被删除，目标不受影响）。',
      '建议先用 dryRun: true 预览将删除的条目数，确认后再实删。',
      '返回 { message, path, deleted }。',
    ].join('\n'),
    params: 'dirPath: string, options?: DeleteDirOptions',
    returns: 'Promise<DirDeleteResult>',
    paramDocs: {
      dirPath: '要删除的目录路径（相对路径基于项目根目录）',
      options: '可选，{ recursive?: boolean, dryRun?: boolean }',
    },
    throws: '目录不存在、不是目录、目标受保护、非空但未传 recursive 时抛出异常',
  },
];

/** 递归统计条目数（不跟随符号链接） */
function countEntries(dir: string): number {
  let n = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const e of entries) {
      n += 1;
      // 只对真实目录下钻；符号链接不跟随
      if (e.isDirectory()) stack.push(path.join(cur, e.name));
    }
  }
  return n;
}

/**
 * 解析并校验目标路径。
 * @returns { absPath } 或 { error }
 */
function resolveAndGuard(dirPath: any, projectDir: any): { absPath?: string; error?: string } {
  if (typeof dirPath !== 'string' || dirPath.trim().length === 0) {
    return { error: 'dirPath 必须是非空字符串' };
  }
  let abs = dirPath;
  if (!path.isAbsolute(abs) && projectDir) {
    abs = path.join(projectDir, dirPath);
  } else if (!path.isAbsolute(abs)) {
    abs = path.resolve(dirPath);
  }
  abs = path.resolve(abs);

  // ---- 高危目标护栏 ----
  const parsed = path.parse(abs);
  if (abs === parsed.root) {
    return { error: '拒绝删除: 目标是磁盘根目录（' + abs + '）' };
  }
  // 盘符根（C:\ 之类）已被上面覆盖；再防一层"单段路径"
  if (path.relative(parsed.root, abs) === '') {
    return { error: '拒绝删除: 目标是磁盘根目录（' + abs + '）' };
  }
  const home = path.resolve(os.homedir());
  if (abs === home) {
    return { error: '拒绝删除: 目标是用户主目录（' + abs + '）' };
  }
  // 系统目录（Windows）
  if (process.platform === 'win32') {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const sysResolved = path.resolve(sysRoot);
    if (abs === sysResolved || abs.startsWith(sysResolved + path.sep)) {
      return { error: '拒绝删除: 目标是系统目录（' + abs + '）' };
    }
    const progFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData]
      .filter(Boolean)
      .map((p) => path.resolve(p as string));
    for (const pf of progFiles) {
      if (abs === pf || abs.startsWith(pf + path.sep)) {
        return { error: '拒绝删除: 目标是系统安装目录（' + abs + '）' };
      }
    }
  }
  // 项目根目录本身
  if (projectDir && path.resolve(projectDir) === abs) {
    return { error: '拒绝删除: 目标是当前项目根目录（' + abs + '）。若确需清空，请逐个删除子项。' };
  }
  // 受保护路径（快照/记忆）
  const guard = isProtectedPath(abs);
  if (guard) {
    return { error: '拒绝删除: ' + guard };
  }
  return { absPath: abs };
}

class DeleteDirTool extends Tool {
  constructor() {
    super(
      'deleteDir',
      '删除一个目录（不可恢复）。非空目录必须显式传 recursive: true。拒绝删除磁盘根/用户主目录/项目根目录/系统目录/受保护路径；不跟随符号链接。建议先用 dryRun: true 预览。',
      {
        type: 'object',
        properties: {
          dirPath: { type: 'string', description: '要删除的目录路径（相对路径基于项目根目录）' },
          options: {
            type: 'object',
            description: '可选，{ recursive?: boolean, dryRun?: boolean }',
            properties: {
              recursive: { type: 'boolean', description: '删除非空目录时必须为 true，默认 false' },
              dryRun: { type: 'boolean', description: '只预览将删除的条目数，不实际删除，默认 false' },
            },
            additionalProperties: false,
          },
        },
        required: ['dirPath'],
        additionalProperties: false,
      },
      'deleteDir(dirPath, options?)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:deleteDir',
      order: 112.5,
      text: '删除目录用 deleteDir(dirPath, { recursive?, dryRun? })，不要用 bash/pwsh 拼 rm -rf。非空目录必须 recursive: true；不确定内容时先 dryRun: true 看条目数。此操作不可撤销。',
    };
  }

  async execute(params: any): Promise<ToolResult> {
    const { dirPath, projectDir, options } = params;
    const recursive = !!(options && options.recursive === true);
    const dryRun = !!(options && options.dryRun === true);

    const guard = resolveAndGuard(dirPath, projectDir);
    if (guard.error) {
      return ToolResult.error(guard.error, ToolErrorCode.PROTECTED_PATH);
    }
    const abs = guard.absPath!;

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(abs);
    } catch (err: any) {
      return ToolResult.error('目录不存在或无法访问: ' + abs + '（' + err.message + '）', ToolErrorCode.NOT_FOUND);
    }

    // 符号链接：只删链接本身，不跟随
    if (stat.isSymbolicLink()) {
      try {
        fs.unlinkSync(abs);
        return ToolResult.success({ message: '已删除符号链接: ' + abs, path: abs, deleted: 1 });
      } catch (err: any) {
        return ToolResult.error('删除符号链接失败: ' + err.message);
      }
    }
    if (!stat.isDirectory()) {
      return ToolResult.error('路径不是目录: ' + abs + '（删除文件请用 deleteFile）', ToolErrorCode.INVALID_ARGS);
    }

    let entries: string[];
    try {
      entries = fs.readdirSync(abs);
    } catch (err: any) {
      return ToolResult.error('无法读取目录内容: ' + err.message);
    }

    // 非空但未开 recursive：拒绝
    if (entries.length > 0 && !recursive) {
      return ToolResult.error(
        '目录非空（' + entries.length + ' 个直接子项）。确认要全部删除时传 recursive: true；'
          + '或先 dryRun: true 预览条目数。',
        ToolErrorCode.INVALID_ARGS
      );
    }

    const count = entries.length === 0 ? 0 : countEntries(abs);

    if (dryRun) {
      return ToolResult.successWithMeta(
        { message: '（dryRun）将删除目录: ' + abs + '，共 ' + count + ' 个条目', path: abs, deleted: count },
        { totalCount: count, returnedCount: count, truncated: false }
      );
    }

    try {
      fs.rmSync(abs, { recursive: true, force: false, maxRetries: 2 });
      console.log('[DeleteDirTool] 已删除目录:', abs, '条目数=' + count);
      return ToolResult.success({ message: '目录已删除: ' + abs + '（' + count + ' 个条目）', path: abs, deleted: count });
    } catch (err: any) {
      return ToolResult.error('删除目录失败: ' + err.message);
    }
  }
}

/** JsRunner 沙箱注入：定义 globalThis.deleteDir。 */
export function bootstrap(__call: any): void {
  (globalThis as any).deleteDir = async function (dirPath: any, options: any) {
    options = options || {};
    return await __call('deleteDir', {
      dirPath: dirPath,
      options: { recursive: options.recursive === true, dryRun: options.dryRun === true },
    });
  };
}

export { DeleteDirTool, resolveAndGuard, countEntries };
