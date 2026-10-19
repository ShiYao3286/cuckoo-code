/**
 * 工具注册表 - 管理所有可用工具
 *
 * execute() 是所有工具调用的唯一收口（JsRunner 的 hostBridge 与 IPC 的
 * execute-tool 都走这里），因此**跨工具的护栏放这里**，不要散落到各 impl。
 */
import { Tool } from './Tool.js';
import { ToolResult, ToolErrorCode } from './ToolResult.js';
import { isPlanReadOnly, guardPlanReadOnly, isWriteTool } from '../../infra/plan-mode.js';
import type { PromptSection, ToolDescription } from './Tool.js';

class ToolRegistry {
  tools: Map<string, Tool>;

  constructor() {
    this.tools = new Map();
  }

  register(tool: Tool): void {
    if (!tool || !tool.name) {
      throw new Error('工具必须有 name 属性');
    }
    if (this.tools.has(tool.name)) {
      console.warn('[ToolRegistry] 工具 ' + tool.name + ' 已存在，将被覆盖');
    }
    this.tools.set(tool.name, tool);
    console.log('[ToolRegistry] 注册工具: ' + tool.name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  async execute(name: string, params: any): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return ToolResult.error('未找到工具: ' + name);
    }
    // ===== 计划模式只读护栏（034）=====
    // 草稿/待确认阶段拒绝一切有副作用的工具（write/edit/deleteFile/bash/pwsh/mysql/injectJS/mcpCall）。
    // 此前这条纪律只写在提示词（discipline.md 第 7 条），工具层不拦——属于"说了不生效"那类。
    // 必须在 execute 之前判定：护栏的意义就是"不让它执行"，副作用发生后无法回滚。
    // todoWrite 不在黑名单：草稿期的正确动作恰恰是列计划。
    if (isPlanReadOnly(params && params.sessionId) && isWriteTool(name)) {
      const msg = guardPlanReadOnly(params && params.sessionId, name);
      return ToolResult.error('[error code: ' + ToolErrorCode.PLAN_READ_ONLY + '] ' + (msg || '计划模式下只读'),
        ToolErrorCode.PLAN_READ_ONLY);
    }
    try {
      return await tool.execute(params);
    } catch (err: any) {
      return ToolResult.error('工具执行失败: ' + err.message);
    }
  }

  getDescriptions(): ToolDescription[] {
    return Array.from(this.tools.values()).filter(t => t.isEnabled()).map(t => t.getDescription());
  }

  /** 列出运行时动态工具（插件工具等，需运行期注入沙箱） */
  getDynamicTools(): Tool[] {
    return Array.from(this.tools.values()).filter((t) => (t as any).dynamic === true);
  }

  getFormattedToolsForPrompt(): string {
    const descriptions = this.getDescriptions();
    if (descriptions.length === 0) return '暂无可用工具';

    return descriptions.map((t, i) => {
      const params = t.parameters.properties ? Object.keys(t.parameters.properties).join(', ') : '无';
      return (i + 1) + '. **' + t.name + '** - ' + t.description + '\n   参数: ' + params;
    }).join('\n\n');
  }

  size(): number {
    return this.tools.size;
  }

  listNames(): string[] {
    return Array.from(this.tools.keys());
  }

  getFormattedJsApiForPrompt(): string {
    const descriptions = this.getDescriptions().filter((t) => t.jsApi);
    if (descriptions.length === 0) return '暂无可用工具';

    return descriptions.map((t, i) => {
      const sig = '\u0060' + t.jsApi + '\u0060';
      return (i + 1) + '. ' + sig + ' — ' + t.description;
    }).join('\n');
  }

  getPromptSections(): PromptSection[] {
    const sections: PromptSection[] = [];
    for (const tool of this.tools.values()) {
      if (!tool.isEnabled()) continue;
      const section = tool.getPromptSection();
      if (section && typeof section.text === 'string' && section.text.trim().length > 0) {
        sections.push({
          name: section.name || ('tool:' + tool.name),
          order: typeof section.order === 'number' ? section.order : 100,
          text: section.text
        });
      }
    }
    sections.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    return sections;
  }

  getFormattedPromptSections(): string {
    const sections = this.getPromptSections();
    if (sections.length === 0) return '';
    return sections.map(s => s.text).join('\n\n');
  }
}

export { ToolRegistry };
