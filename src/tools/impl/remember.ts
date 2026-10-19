import { Tool } from '../core/Tool.js';
import type { ToolApiMeta } from '../core/Tool.js';
import { ToolResult } from '../core/ToolResult.js';
import { isMemoriesEnabled } from '../../infra/config.js';
import { normalizeProjectPath } from '../../infra/memories.js';

// ========== D12：API 契约元数据 ==========
export const apiMetas: ToolApiMeta[] = [
  {
    order: 17,
    feature: 'memories',
    category: '记忆',
    name: 'remember',
    doc: '把用户明确表达的偏好、习惯或长期有用的事实记入长期记忆（跨会话保留）。后续对话会自动注入这些记忆。默认记为用户级（所有项目生效）；若只对当前项目适用，传 scope: "project"。',
    params: 'text: string, scope?: string',
    returns: 'Promise<{ id: string, message: string, scope: string }>',
    paramDocs: {
      text: '要记住的内容（一句话，如"用户偏好用中文回复"）',
      scope: '作用域："user"（默认，所有项目生效）或 "project"（仅当前项目）',
    },
    returnsDoc: '{ id: string, message: string, scope: string }',
    throws: '缺少窗口上下文、内容为空或记忆功能已关闭时抛出异常',
  },
  {
    order: 18,
    feature: 'memories',
    category: '记忆',
    name: 'forgetMemory',
    doc: '按 id 删除一条长期记忆（当用户要求"忘掉"某事，或记忆已过时）。先用 listMemories 查看现有记忆及其 id。',
    params: 'id: string',
    returns: 'Promise<string>',
    paramDocs: {
      id: '要删除的记忆 id',
    },
    returnsDoc: '确认消息',
    throws: 'id 为空、记忆不存在或记忆功能已关闭时抛出异常',
  },
  {
    order: 19,
    feature: 'memories',
    category: '记忆',
    name: 'listMemories',
    doc: '列出长期记忆及其 id。默认列出「用户级 + 当前项目」的全部可见记忆；传 scope 可只看某一层。用于删除前确认 id，或回答"你记得我什么"。',
    params: 'options?: { scope?: string }',
    returns: 'Promise<Array<{ id, text, scope, createdAt }>>',
    paramDocs: {
      options: '可选，{ scope?: "user" | "project" | "all" }，默认 "all"（用户级 + 当前项目）',
    },
    returnsDoc: '记忆数组，scope 字段标明每条属于用户级还是项目级',
    throws: '记忆功能已关闭时抛出异常',
  },
];

/**
 * 记忆存储接口（由 app 层注入，避免 tools → app 反向依赖）。
 *
 * 注意：不提供 getProjectDir()。项目目录是**每窗口**不同的，而 store 是全局单例；
 * 工具改为从 params.projectDir 取（JsRunner 每次调用都会带），避免全局状态串味。
 */
export interface MemoryStore {
  /** 新增；scope 为 "user" 或规范化项目路径 */
  add: (text: string, scope?: string) => { id: string; scope: string } | null;
  remove: (id: string) => boolean;
  /** 列出全部（含 scope），由工具按需过滤 */
  list: () => Array<{ id: string; text: string; scope: string; createdAt: number }>;
}

let _store: MemoryStore | null = null;

/** 由 app 层注入 */
export function injectMemoryStore(store: MemoryStore): void {
  _store = store;
}

/** 供测试用：清空注入 */
export function resetMemoryStore(): void {
  _store = null;
}

/**
 * 解析 scope 参数为存储层可用的值。
 * @param raw 用户/模型传入的 scope（"user" | "project" | 绝对路径 | undefined）
 * @param projectDir 当前调用的项目目录（来自 params.projectDir）
 * @returns 规范化后的 scope；非法时返回 null
 */
function resolveScope(raw: any, projectDir: string | null | undefined): string | null {
  if (raw === undefined || raw === null || raw === '') return 'user';
  const s = String(raw).trim();
  if (s === 'user') return 'user';
  if (s === 'project') {
    if (!projectDir) return null; // 无项目上下文，无法解析 project
    return normalizeProjectPath(projectDir);
  }
  // 允许直接传绝对路径（高级用法）
  return s;
}

class RememberTool extends Tool {
  constructor() {
    super(
      'remember',
      '把用户偏好、习惯或长期有用的事实记入长期记忆（跨会话保留）。默认用户级；仅当前项目适用时传 scope: "project"。',
      {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要记住的内容（一句话）' },
          scope: {
            type: 'string',
            description: '作用域："user"（默认，所有项目生效）或 "project"（仅当前项目）',
            default: 'user',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
      'remember(text, scope?)'
    );
  }

  isEnabled() {
    return isMemoriesEnabled();
  }

  getPromptSection() {
    return {
      name: 'tool:remember',
      order: 115,
      text: [
        '**长期记忆**：当用户明确表达**偏好、习惯或长期有用的事实**（如"以后都用中文回复"、"提交信息用中文"、"我讨厌写注释"）时，记下来——后续对话会自动带上这些记忆。',
        '**两种作用域**：默认记为用户级（scope 省略或传 "user"），所有项目生效；若这条只对当前项目适用（如"这个仓库用 pnpm"），传 scope: "project"。',
        '两种记法：① 调用 remember(text, scope?)（推荐，正文干净）；② 在回复里**单独一行**输出 [记忆]内容（更轻，软件会自动捕获；注意标记会留在对话正文里）。标记必须在行首单独成行，且只能记为用户级。',
        '只记**稳定、可复用**的信息；不要记一次性任务细节。',
        '记忆已过时或用户要求忘记时，先用 listMemories() 查 id，再用 forgetMemory(id) 删除。',
      ].join('\n'),
    };
  }

  async execute(params: any): Promise<ToolResult> {
    if (!isMemoriesEnabled()) return ToolResult.error('记忆功能已关闭（可在侧边栏「记忆」页开启）');
    const text = String(params.text || '').trim();
    if (!text) return ToolResult.error('记忆内容为空');
    if (!_store) return ToolResult.error('记忆存储未初始化');

    const scope = resolveScope(params.scope, params && params.projectDir);
    if (scope === null) {
      return ToolResult.error('scope 非法：传 "user"（所有项目）、"project"（仅当前项目）或绝对路径。当前无项目上下文，无法用 "project"。');
    }

    try {
      const r = _store.add(text, scope);
      if (!r) return ToolResult.error('保存失败');
      return ToolResult.success({ id: r.id, message: '已记住：' + text, scope: r.scope });
    } catch (err: any) {
      return ToolResult.error('保存记忆失败: ' + err.message);
    }
  }
}

class ForgetMemoryTool extends Tool {
  constructor() {
    super(
      'forgetMemory',
      '按 id 删除一条长期记忆。先用 listMemories() 查 id。',
      {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要删除的记忆 id' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      'forgetMemory(id)'
    );
  }

  isEnabled() {
    return isMemoriesEnabled();
  }

  async execute(params: any): Promise<ToolResult> {
    if (!isMemoriesEnabled()) return ToolResult.error('记忆功能已关闭（可在侧边栏「记忆」页开启）');
    const id = String(params.id || '').trim();
    if (!id) return ToolResult.error('id 为空');
    if (!_store) return ToolResult.error('记忆存储未初始化');
    try {
      const ok = _store.remove(id);
      if (!ok) return ToolResult.error('记忆不存在: ' + id + '。可用 listMemories() 查看现有记忆的 id。');
      return ToolResult.success('已删除记忆: ' + id);
    } catch (err: any) {
      return ToolResult.error('删除记忆失败: ' + err.message);
    }
  }
}

class ListMemoriesTool extends Tool {
  constructor() {
    super(
      'listMemories',
      '列出长期记忆及其 id。默认列出「用户级 + 当前项目」；传 scope 可只看某一层。',
      {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            description: '"all"（默认：用户级 + 当前项目）| "user"（仅用户级）| "project"（仅当前项目）',
            enum: ['all', 'user', 'project'],
            default: 'all',
          },
        },
        additionalProperties: false,
      },
      'listMemories(options?)'
    );
  }

  isEnabled() {
    return isMemoriesEnabled();
  }

  async execute(params: any): Promise<ToolResult> {
    if (!isMemoriesEnabled()) return ToolResult.error('记忆功能已关闭（可在侧边栏「记忆」页开启）');
    if (!_store) return ToolResult.error('记忆存储未初始化');

    const want = params && params.scope ? String(params.scope) : 'all';
    // 存储层的 scope 已规范化（统一斜杠、Windows 转小写），比较前必须同样规范化
    const rawDir = (params && params.projectDir) || null;
    const projectDir = rawDir ? normalizeProjectPath(rawDir) : null;
    const all = _store.list();

    let filtered;
    if (want === 'user') {
      filtered = all.filter((m) => m.scope === 'user');
    } else if (want === 'project') {
      if (!projectDir) {
        return ToolResult.error('当前无项目上下文，无法列项目级记忆。请传 scope: "user" 或 "all"。');
      }
      filtered = all.filter((m) => m.scope === projectDir);
    } else {
      // all：用户级 + 当前项目
      filtered = projectDir
        ? all.filter((m) => m.scope === 'user' || m.scope === projectDir)
        : all.filter((m) => m.scope === 'user');
    }

    // 返回时把 scope 简化为可读标签：user / project（避免把绝对路径暴露给模型）
    const out = filtered.map((m) => ({
      id: m.id,
      text: m.text,
      scope: m.scope === 'user' ? 'user' : 'project',
      createdAt: m.createdAt,
    }));
    return ToolResult.success(out);
  }
}

/** JsRunner 沙箱注入 */
export function bootstrap(__call: any): void {
  (globalThis as any).remember = async function (text: any, scope: any) {
    return await __call('remember', { text: text, scope: scope });
  };
  (globalThis as any).forgetMemory = async function (id: any) {
    return await __call('forgetMemory', { id: id });
  };
  (globalThis as any).listMemories = async function (options: any) {
    options = options || {};
    return await __call('listMemories', { scope: options.scope });
  };
}

export { RememberTool, ForgetMemoryTool, ListMemoriesTool };
