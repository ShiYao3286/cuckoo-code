/**
 * 记忆整理器（036）
 *
 * 把「现有画像 + 新对话」交给 LLM，得到重写后的完整画像。
 *
 * 为什么用「重写」而非「追加」：追加会越积越多、互相矛盾；
 * 重写让 LLM 主动合并、淘汰过时信息（借鉴 GPT Dreaming 的核心思路）。
 *
 * Prompt 设计详见 docs/memory-consolidation-prompt.md，核心约束：
 *   - 六个字段必须是字符串段落（projects 是对象）
 *   - 不得虚构、不得记录任务、不得跨字段重复
 *   - 反面示例只描述错误形态，不给正面样例（正面样例会被弱模型照抄）
 *
 * 模型选型验证结论：flash 级小模型编造率高，不可用；plus 级或大参数免费模型可接受。
 */
import type { MemoryProfile } from './memories-file.js';

/** 一次整理请求 */
interface ConsolidateRequest {
  /** 现有画像（首次整理时为空画像） */
  existingProfile: MemoryProfile;
  /** 新对话文本（已格式化为「用户: xxx / AI: xxx」） */
  conversation: string;
  /** LLM 端点（OpenAI 兼容，如 https://open.bigmodel.cn/api/paas/v4） */
  baseUrl: string;
  /** 模型名 */
  model: string;
  /** API Key */
  apiKey: string;
  /** 超时毫秒（默认 120 秒，大参数免费模型可能较慢） */
  timeoutMs?: number;
}

/** 整理结果 */
interface ConsolidateResult {
  success: boolean;
  /** 重写后的画像 */
  profile?: MemoryProfile;
  /** 原始返回文本（排查用） */
  rawText?: string;
  /** token 用量 */
  usage?: { promptTokens: number; completionTokens: number };
  error?: string;
  /** 耗时 ms */
  elapsedMs: number;
}

const SYSTEM_PROMPT = [
  '你是记忆整理器。把用户的历史对话合成为一份「用户画像」，供 AI 助手在后续对话中理解用户。',
  '',
  '## 硬性格式要求（违反即失败）',
  '',
  '- identity / communication / engineering / environment / notes：**必须是一个字符串**，是连贯的中文段落。',
  '  **禁止**输出数组、嵌套对象、Markdown 列表、多个短句堆砌。',
  '- projects：**必须是对象**，key 是项目的绝对路径（如 "E:/proj/foo"），value 是该项目的约定字符串。',
  '  如果对话里没有明确的项目路径，projects 输出空对象 {}。',
  '- 某节没有信息就输出空字符串 ""，**不要**写「无」「未知」「暂无」。',
  '',
  '## 内容规则',
  '',
  '1. **重写而非追加**：输出是重写后的完整画像，不是增量。',
  '2. **主动合并与淘汰**：新信息与旧矛盾时以新的为准；旧信息过时则删掉。',
  '3. **推断而非罗列**：不写「用户用了 pnpm 三次」，要写「用户偏好 pnpm」。',
  '4. **保守**：不确定的不写；一次性任务细节（「帮我看这个文件」）不记。',
  '5. **不臆造**：只基于给定材料，不推测用户没表达过的偏好。',
  '6. **不串味**：身份归 identity，沟通风格归 communication，工具链/规范归 engineering，',
  '   操作系统/路径习惯归 environment。技术栈属于 identity 或 engineering，不要塞进 communication。',
  '',
  '## 各字段该写什么',
  '',
  '- identity：**跨项目稳定的身份**——职业、技术背景、长期从事的项目类型。',
  '  **禁止**写入「当前正在做什么」「关注某个功能」「想加某个特性」这类一次性任务。',
  '- communication：**只写沟通方式**——语言偏好、详细程度、对反问/客套的态度。',
  '  不要写任何工具、框架、提交规范、编码习惯。',
  '- engineering：**工程习惯**——工具链、代码风格、测试框架、提交规范、目录约定。',
  '- environment：**环境约束**——操作系统、shell、路径特征、编码习惯。',
  '- projects：**仅当对话中出现了明确的绝对路径**才写。key 必须是路径（含 / 或 \\\\ 或盘符），',
  '  value 是该项目的专属约定。没有路径就输出 {}。技术栈名不是项目路径。',
  '- notes：**其他长期有用且不属于以上任何一类**的信息（账号、外部服务、长期目标）。',
  '  **同一条信息只能出现在一个字段里**，不要在多处重复。',
  '',
  '## 三条铁律（违反即失败）',
  '',
  '1. **不得虚构**：只写对话里明确出现过的信息。不要根据「常见开发者习惯」补充任何内容。',
  '2. **不得记录任务**：具体的 bug 修复、功能开发、文件修改过程都不属于画像。',
  '3. **不得重复**：同一条信息只放最合适的那个字段，不要在 engineering 和 notes 里各写一遍。',
  '',
  '## 反面示例（只说明错误形态，不要照抄内容）',
  '',
  '✗ 把对象/数组塞进字符串字段',
  '✗ 把技术栈名（如 "Electron"）当成 projects 的 key',
  '✗ 把「修复 BOM 问题」这类任务细节写进 notes',
  '✗ 同一条信息在多个字段重复出现',
  '',
  '## 输出',
  '',
  '严格 JSON，不要 markdown 代码块包裹：',
  '',
  '{',
  '  "identity": "字符串",',
  '  "communication": "字符串",',
  '  "engineering": "字符串",',
  '  "environment": "字符串",',
  '  "projects": {},',
  '  "notes": "字符串"',
  '}',
  '',
  '**警告：必须直接输出上述 JSON 对象，不要包含任何解释性文字、不要输出“这...”等内容，必须以 { 开头，以 } 结尾。**',
].join('\n');

/** 从 LLM 返回文本里抽出 JSON（容错 markdown 代码块包裹、以及前后废话） */
function extractJson(text: string): any {
  let s = String(text || '').trim();
  // 1. 剥 markdown 代码块
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1].trim();
  
  // 2. 暴力截取第一个 { 到最后一个 } 之间的内容
  // （有些模型废话太多，或者不支持 response_format，只能手动抠）
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    s = s.slice(start, end + 1);
  }
  
  return JSON.parse(s);
}

/**
 * 调 LLM 重写画像。
 * 不抛异常——所有错误包成 { success: false, error }。
 */
async function consolidateProfile(req: ConsolidateRequest): Promise<ConsolidateResult> {
  const t0 = Date.now();
  const timeoutMs = req.timeoutMs || 120000;

  const userPrompt = [
    '## 现有画像',
    '',
    JSON.stringify(req.existingProfile, null, 2),
    '',
    '## 新对话',
    '',
    req.conversation,
    '',
    '---',
    '',
    '请输出重写后的完整画像（JSON）。',
  ].join('\n');

  const url = req.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + req.apiKey,
      },
      body: JSON.stringify({
        model: req.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return {
        success: false,
        elapsedMs: Date.now() - t0,
        error: 'LLM 请求失败 (' + res.status + '): ' + txt.slice(0, 300),
      };
    }

    const data: any = await res.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) {
      return { success: false, elapsedMs: Date.now() - t0, error: 'LLM 未返回内容' };
    }

    let parsed: any;
    try {
      parsed = extractJson(content);
    } catch (e: any) {
      return {
        success: false,
        elapsedMs: Date.now() - t0,
        rawText: String(content).slice(0, 1000),
        error: 'LLM 返回的不是合法 JSON: ' + (e && e.message),
      };
    }

    return {
      success: true,
      profile: parsed,
      rawText: String(content).slice(0, 2000),
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens || 0,
        completionTokens: data.usage.completion_tokens || 0,
      } : undefined,
      elapsedMs: Date.now() - t0,
    };
  } catch (err: any) {
    const msg = err && err.name === 'AbortError'
      ? 'LLM 请求超时（' + Math.round(timeoutMs / 1000) + ' 秒）'
      : (err && err.message ? err.message : String(err));
    return { success: false, elapsedMs: Date.now() - t0, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

export { consolidateProfile, extractJson, SYSTEM_PROMPT };
export type { ConsolidateRequest, ConsolidateResult };
