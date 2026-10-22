import { Tool } from '../core/Tool.js';
import type { ToolApiMeta } from '../core/Tool.js';
import { ToolResult } from '../core/ToolResult.js';
import { assertUrlAllowed } from '../../infra/ssrf-guard.js';

// ========== D12：API 契约元数据（构建期生成 api.d.ts）==========
export const apiMetas: ToolApiMeta[] = [
  {
    order: 13,
    category: 'WebFetch',
    name: 'webSearch',
    types: [
      '/** webSearch 的选项 */',
      'interface WebSearchOptions {',
      '  /** 最大返回条数，默认 8，上限 20 */',
      '  maxResults?: number;',
      '}',
      '/** webSearch 的单条结果 */',
      'interface WebSearchItem {',
      '  title: string;',
      '  url: string;',
      '  snippet: string;',
      '}',
    ].join('\n'),
    doc: [
      '用查询词做网页搜索，返回标题、URL 与摘要（最多 8 条）。',
      '用于「先定位候选页面，再对具体页面用 webFetch 抓正文」——比直接猜 URL 盲抓可靠。',
      '数据源为 DuckDuckGo Lite（无需 API key）。',
      '返回纯文本：每条形如「1. <title> — <url>」+ 缩进的摘要行。',
      '搜索无结果时返回 "No results found"。',
    ].join('\n'),
    params: 'query: string, options?: WebSearchOptions',
    returns: 'Promise<string>',
    paramDocs: {
      query: '搜索查询词',
      options: '可选，maxResults（默认 8，上限 20）',
    },
    throws: 'query 为空、请求超时或失败时抛出异常',
  },
];

const SEARCH_TIMEOUT_MS = 15000;
const SEARCH_MAX_RESULTS = 8;
const SEARCH_MAX_RESULTS_CAP = 20;
const SEARCH_MAX_BYTES = 512 * 1024;
const SNIPPET_MAX_CHARS = 300;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 常见 HTML 实体解码（够用即可，不引第三方库） */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, d) => {
      const code = Number(d);
      return Number.isFinite(code) ? String.fromCharCode(code) : _m;
    });
}

/** 去掉标签、压缩空白、截断 */
function stripTags(html: string): string {
  const text = decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  return text.length > SNIPPET_MAX_CHARS ? text.slice(0, SNIPPET_MAX_CHARS) + '…' : text;
}

/**
 * 从 DuckDuckGo 的跳转链接里还原真实 URL。
 * 形如 //duckduckgo.com/l/?uddg=<encoded>&rut=... → 取 uddg 解码。
 * 非跳转链接原样返回。
 */
function resolveRealUrl(href: string): string {
  let h = decodeEntities(href).trim();
  if (h.startsWith('//')) h = 'https:' + h;
  try {
    const u = new URL(h);
    if (u.hostname.endsWith('duckduckgo.com') && u.pathname === '/l/') {
      const target = u.searchParams.get('uddg');
      if (target) return target;
    }
    return u.toString();
  } catch (_) {
    return h;
  }
}

/**
 * 解析 DuckDuckGo Lite 的结果页。
 *
 * 结构（实测）：结果按 <tr> 分块，每条结果里
 *   <a rel="nofollow" href="..." class='result-link'>标题</a>
 * 紧随其后可能有
 *   <td class='result-snippet'>摘要</td>
 * 广告块带 class="result-sponsored"，直接跳过。
 */
function parseResults(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
  const out: Array<{ title: string; url: string; snippet: string }> = [];
  // 按 <tr 切块，广告块通常独立成块
  const rows = html.split(/<tr/i);
  for (let i = 0; i < rows.length && out.length < maxResults; i++) {
    const row = rows[i];
    if (/result-sponsored/i.test(row)) continue;
    // 结果链接：href 可能出现在 class 之前或之后
    const linkMatch = row.match(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*\bclass=["']result-link["'][^>]*>([\s\S]*?)<\/a>/i)
      || row.match(/<a\b[^>]*\bclass=["']result-link["'][^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const url = resolveRealUrl(linkMatch[1]);
    const title = stripTags(linkMatch[2]);
    if (!title || !url) continue;
    // 摘要：同一块内，或下一块里（DDG Lite 的 snippet 常紧跟链接行）
    let snippet = '';
    const sm = row.match(/<td[^>]*class=["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/i)
      || (rows[i + 1] ? rows[i + 1].match(/<td[^>]*class=["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/i) : null);
    if (sm) snippet = stripTags(sm[1]);
    // 去重（DDG 偶尔重复同一 URL）
    if (out.some((r) => r.url === url)) continue;
    out.push({ title, url, snippet });
  }
  return out;
}

/** 结果格式化为纯文本 */
function formatResults(query: string, items: Array<{ title: string; url: string; snippet: string }>): string {
  const header = 'Search "' + query + '" — ' + items.length + ' result' + (items.length === 1 ? '' : 's');
  const body = items.map((it, i) => {
    const lines = [(i + 1) + '. ' + it.title, '   ' + it.url];
    if (it.snippet) lines.push('   ' + it.snippet);
    return lines.join('\n');
  }).join('\n\n');
  return header + '\n\n' + body;
}

function parseSearchArgs(query: any, maxResults: any): { query: string; maxResults: number } {
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new Error('query must be a non-empty string');
  }
  let n = SEARCH_MAX_RESULTS;
  if (maxResults !== undefined && maxResults !== null) {
    const parsed = Number(maxResults);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error('maxResults must be a positive integer');
    }
    n = Math.min(parsed, SEARCH_MAX_RESULTS_CAP);
  }
  return { query: query.trim(), maxResults: n };
}

class WebSearchTool extends Tool {
  constructor() {
    super(
      'webSearch',
      '用查询词做网页搜索，返回标题、URL 与摘要（默认 8 条，上限 20）。用于先定位候选页面，再用 webFetch 抓取正文。数据源 DuckDuckGo Lite（无需 API key）。',
      {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索查询词' },
          maxResults: { type: 'number', description: '最大返回条数，默认 ' + SEARCH_MAX_RESULTS + '，上限 ' + SEARCH_MAX_RESULTS_CAP },
        },
        required: ['query'],
        additionalProperties: false,
      },
      'webSearch(query, options?)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:webSearch',
      order: 110,
      text: '调研类任务先用 webSearch(query) 定位候选页面，再对具体 URL 用 webFetch 抓正文——比直接猜 URL 盲抓可靠。搜索返回标题、URL 和摘要，摘要通常已足够判断要不要打开。',
    };
  }

  async execute(params: any): Promise<ToolResult> {
    const { query, maxResults, ssrfGuard } = params;
    let input: { query: string; maxResults: number };
    try {
      input = parseSearchArgs(query, maxResults);
    } catch (err: any) {
      return ToolResult.error(err.message);
    }

    const endpoint = 'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(input.query);
    if (ssrfGuard === true) {
      try {
        await assertUrlAllowed(endpoint);
      } catch (e: any) {
        return ToolResult.error(e.message);
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      });
      if (!response.ok) {
        clearTimeout(timeoutId);
        return ToolResult.error('搜索请求失败: HTTP ' + response.status);
      }
      // 流式读取 + 大小上限
      const reader = response.body ? response.body.getReader() : null;
      const chunks: Uint8Array[] = [];
      let received = 0;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value!.byteLength;
          if (received > SEARCH_MAX_BYTES) {
            const remain = SEARCH_MAX_BYTES - (received - value!.byteLength);
            if (remain > 0) chunks.push(value!.slice(0, remain));
            try { await reader.cancel(); } catch (_) {}
            break;
          }
          chunks.push(value!);
        }
      }
      clearTimeout(timeoutId);

      const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
      const items = parseResults(html, input.maxResults);
      console.log('[WebSearchTool] 搜索完成: q=' + input.query + ', 命中 ' + items.length + ' 条');

      if (items.length === 0) {
        return ToolResult.success('No results found');
      }
      return ToolResult.successWithMeta(formatResults(input.query, items), {
        totalCount: items.length,
        returnedCount: items.length,
        truncated: false,
      });
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        return ToolResult.error('搜索请求超时 (超过 ' + SEARCH_TIMEOUT_MS + 'ms)');
      }
      return ToolResult.error('搜索失败: ' + err.message);
    }
  }
}

/** JsRunner 沙箱注入：定义 globalThis.webSearch。 */
export function bootstrap(__call: any): void {
  (globalThis as any).webSearch = async function (query: any, options: any) {
    options = options || {};
    return await __call('webSearch', { query: query, maxResults: options.maxResults });
  };
}

export { WebSearchTool, parseSearchArgs, parseResults, resolveRealUrl };
