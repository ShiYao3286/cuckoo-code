#!/usr/bin/env node
/**
 * 记忆整理最小验证脚本（多 provider 支持）
 *
 * 用途：在写任何生产代码前，先验证「LLM 能不能把对话提炼成好画像」。
 *
 * 用法：
 *   # 智谱（推荐，免费）
 *   ZHIPU_API_KEY=xxx node scripts/verify-memory-consolidation.mjs
 *
 *   # DeepSeek（备选，约 ¥0.001-0.01/次）
 *   DEEPSEEK_API_KEY=sk-xxx node scripts/verify-memory-consolidation.mjs
 *
 *   # 从文件读入真实对话
 *   ZHIPU_API_KEY=xxx node scripts/verify-memory-consolidation.mjs my-conv.txt
 *
 * 环境变量：
 *   MEMORY_PROVIDER = zhipu | deepseek  （自动检测，也可显式指定）
 *   MEMORY_MODEL    = 模型名            （默认见下，可按需覆盖）
 */

import fs from 'node:fs';

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
].join('\n');

// ===== 样例数据（替换成你的真实对话）=====
const SAMPLE_CONVERSATION = [
  '用户: 帮我看看这个 Electron 项目，我想加个记忆功能',
  'AI: 好的，我先看下项目结构...',
  '用户: 用 TypeScript 写，别用 any',
  'AI: 明白，我会用严格类型',
  '用户: 测试用 vitest，不要 jest',
  'AI: 好的，vitest 配置在哪？',
  '用户: 提交信息按 type(编号) 格式，中文描述',
  'AI: 了解，比如 fix(035): xxx',
  '用户: 对。另外我 Windows，路径有中文，注意编码',
  'AI: 明白，会注意 UTF-8 和 BOM 问题',
  '用户: 回复别太啰嗦，直接说结论',
  'AI: 好的',
].join('\n');

const SAMPLE_EXISTING = {
  identity: '',
  communication: '',
  engineering: '',
  environment: '',
  projects: {},
  notes: '用户的 GitHub 主页是 https://github.com/shiqi3286-create',
};

/**
 * 解析 provider 配置。
 * 智谱和 DeepSeek 都兼容 OpenAI 的 /chat/completions 格式，
 * 差异只在 baseURL、模型名、key 环境变量。
 */
function resolveProvider() {
  const explicit = (process.env.MEMORY_PROVIDER || '').toLowerCase();

  // 通用 OpenAI 兼容端点（本地代理 / 自建服务）
  const customBase = process.env.MEMORY_BASE_URL;
  const customKey = process.env.MEMORY_API_KEY;
  if (explicit === 'openai-compat' || (!explicit && customBase && customKey)) {
    if (!customBase || !customKey) {
      throw new Error('MEMORY_PROVIDER=openai-compat 需要同时设置 MEMORY_BASE_URL 和 MEMORY_API_KEY');
    }
    const model = process.env.MEMORY_MODEL;
    if (!model) throw new Error('MEMORY_PROVIDER=openai-compat 需要设置 MEMORY_MODEL');
    return {
      name: 'openai-compat',
      key: customKey,
      url: customBase.replace(/\/+$/, '') + '/chat/completions',
      model,
      supportsJsonMode: true,
      pricing: null,
      freeHint: process.env.MEMORY_FREE_HINT || '自定义端点（费用未知）',
    };
  }

  const zhipuKey = process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY;
  const deepseekKey = process.env.DEEPSEEK_API_KEY;

  if (explicit === 'zhipu' || (!explicit && zhipuKey)) {
    if (!zhipuKey) {
      throw new Error('已指定 MEMORY_PROVIDER=zhipu，但未设置 ZHIPU_API_KEY');
    }
    const zhipuModel = process.env.MEMORY_MODEL || 'glm-4-flash';
    // 智谱是否免费取决于型号，不是取决于 provider。
    // 免费档型号历史上先后有 GLM-4-Flash / GLM-4.5-Flash 等，会变；
    // 这里只按型号名里是否含 "flash" 粗略判断，不精确但足够提示用。
    // 精确价格请到 https://open.bigmodel.cn/ 控制台核对。
    const zhipuFree = /flash/i.test(zhipuModel);
    return {
      name: 'zhipu',
      key: zhipuKey,
      url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      model: zhipuModel,
      supportsJsonMode: true,
      // 元/百万 token（输入, 输出）；null 表示免费或未知
      pricing: zhipuFree ? null : [1, 1],
      freeHint: zhipuFree ? '免费档（按型号名含 flash 判断，以控制台为准）' : '付费型号',
    };
  }

  if (explicit === 'deepseek' || (!explicit && deepseekKey)) {
    if (!deepseekKey) {
      throw new Error('已指定 MEMORY_PROVIDER=deepseek，但未设置 DEEPSEEK_API_KEY');
    }
    return {
      name: 'deepseek',
      key: deepseekKey,
      url: 'https://api.deepseek.com/chat/completions',
      model: process.env.MEMORY_MODEL || 'deepseek-chat',
      supportsJsonMode: true,
      // 元/百万 token（输入, 输出），deepseek-chat 参考价
      pricing: [1, 2],
      freeHint: '',
    };
  }

  throw new Error(
    '未找到可用的 API Key。\n' +
    '  智谱：设置 ZHIPU_API_KEY（免费，推荐）\n' +
    '  DeepSeek：设置 DEEPSEEK_API_KEY\n' +
    '也可用 MEMORY_PROVIDER 显式指定。'
  );
}

async function consolidate(provider, existingProfile, conversation) {
  const userPrompt = [
    '## 现有画像',
    '',
    JSON.stringify(existingProfile, null, 2),
    '',
    '## 新对话',
    '',
    conversation,
    '',
    '---',
    '',
    '请输出重写后的完整画像（JSON）。',
  ].join('\n');

  const body = {
    model: provider.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.3,
  };
  if (provider.supportsJsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const res = await fetch(provider.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + provider.key,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error('API 请求失败 (' + res.status + '): ' + text);
  }

  const data = await res.json();
  let content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error('API 未返回内容: ' + JSON.stringify(data).slice(0, 300));

  // 容错：有些模型即使开了 json_mode 仍会包 markdown 代码块
  content = content.trim();
  const fence = content.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) content = fence[1];

  return {
    profile: JSON.parse(content),
    usage: data.usage,
  };
}

async function main() {
  console.log('=== 记忆整理验证 ===\n');

  const provider = resolveProvider();
  console.log('Provider:', provider.name);
  console.log('模型    :', provider.model);
  console.log('');

  const convFile = process.argv[2];
  const conversation = convFile
    ? fs.readFileSync(convFile, 'utf-8')
    : SAMPLE_CONVERSATION;

  console.log('输入对话长度:', conversation.length, '字符');
  console.log('现有画像:', JSON.stringify(SAMPLE_EXISTING, null, 2));
  console.log('\n调用 API 中...\n');

  const t0 = Date.now();
  const { profile, usage } = await consolidate(provider, SAMPLE_EXISTING, conversation);
  const ms = Date.now() - t0;

  console.log('=== 输出画像 ===');
  console.log(JSON.stringify(profile, null, 2));

  console.log('\n=== 统计 ===');
  console.log('耗时:', ms, 'ms');
  if (usage) {
    console.log('输入 token:', usage.prompt_tokens);
    console.log('输出 token:', usage.completion_tokens);
    if (provider.pricing) {
      const [inPrice, outPrice] = provider.pricing;
      const cost = (usage.prompt_tokens / 1e6) * inPrice + (usage.completion_tokens / 1e6) * outPrice;
      console.log('预估成本: ¥' + cost.toFixed(4) + '（按 ' + inPrice + '/' + outPrice + ' 元每百万 token）');
    } else {
      console.log('成本: ' + (provider.freeHint || '免费或未知'));
    }
  }

  // ===== 忠实度检查（需要对话原文）=====
  //
  // 前几轮教训：自检只看「字段形状」，抓不到幻觉。
  // flash 编造了「前端开发者」「熟悉 JavaScript」「对反问和客套敏感」——
  // 原文一个字都没有，但所有形状检查全过。
  //
  // 这里用粗糙但有效的方法：从输出里抽取「实义词」，看有多少能在原文找到痕迹。
  // 不追求精确——只要能把「大段编造」和「忠于原文」区分开就够了。

  // 自检结果收集器（忠实度检查与后续形状检查共用）
  const checks = [];
  const add = (label, ok, detail) => checks.push({ label, ok: !!ok, detail });

  console.log('\n=== 忠实度检查（对照原文）===');

  /**
   * 从画像里抽取可验证的「事实片段」，逐条去原文找支撑。
   * 返回 { text, field, supported }
   */
  function extractClaims(p) {
    const claims = [];
    for (const field of ['identity', 'communication', 'engineering', 'environment', 'notes']) {
      const v = p[field];
      if (typeof v !== 'string' || !v.trim()) continue;
      // 按标点切成短句，只保留有实际内容的（>=6 字符）
      const sentences = v.split(/[，。；、,.;]/).map((s) => s.trim()).filter((s) => s.length >= 6);
      for (const s of sentences) claims.push({ field, text: s });
    }
    return claims;
  }

  /**
   * 判断一个短句是否在原文中有支撑。
   * 策略：抽取短句里的实义词（2 字以上中文词 + 英文词），
   * 只要有超过一半的词在原文出现，就认为「有支撑」。
   * 这是启发式，会漏判也会误判，但足以识别「整句凭空捏造」。
   */
  function isSupported(claimText, sourceText) {
    const source = sourceText.toLowerCase();
    // 提取候选词：英文单词 + 连续中文（2-4 字，太长会切碎，太短会误判）
    const tokens = new Set();
    for (const m of claimText.matchAll(/[a-zA-Z][a-zA-Z0-9+.#-]{1,}/g)) tokens.add(m[0].toLowerCase());
    for (const m of claimText.matchAll(/[\u4e00-\u9fa5]{2,4}/g)) tokens.add(m[0]);
    // 过滤掉太泛的词（它们在任何技术对话里都出现，不构成证据）
    const stop = new Set(['用户', '使用', '偏好', '项目', '进行', '开发', '可以', '需要', '注意', '希望', '主要', '系统', '相关', '方式', '习惯', '内容', '信息', '可能', '能够', '要求', '问题', '功能', '实现', '处理', '提供', '支持', '基于', '通过', '当前', '之前', '以后', '一直', '比较', '非常', '有点', '觉得']);
    const meaningful = [...tokens].filter((t) => !stop.has(t));
    if (meaningful.length === 0) return { supported: true, matched: 0, total: 0, missing: [] };
    const missing = meaningful.filter((t) => !source.includes(t));
    const matched = meaningful.length - missing.length;
    return {
      supported: matched >= Math.ceil(meaningful.length / 2),
      matched,
      total: meaningful.length,
      missing,
    };
  }

  // 证据源 = 新对话 + 现有画像（现有画像里的信息本来就该保留，不算幻觉）
  const evidenceSource = conversation + '\n' + JSON.stringify(SAMPLE_EXISTING);
  const claims = extractClaims(profile);
  const unsupported = [];
  let checkedCount = 0;
  for (const c of claims) {
    const r = isSupported(c.text, evidenceSource);
    if (r.total === 0) continue; // 全是泛词，无法验证，跳过
    checkedCount++;
    if (!r.supported) unsupported.push({ ...c, ...r });
  }

  if (checkedCount === 0) {
    console.log('（无可验证的事实片段，跳过）');
  } else if (unsupported.length === 0) {
    console.log('✓ 所有 ' + checkedCount + ' 条事实片段都能在原文找到支撑');
  } else {
    console.log('✗ ' + unsupported.length + '/' + checkedCount + ' 条事实片段缺乏原文支撑（疑似幻觉）：');
    for (const u of unsupported) {
      console.log('  [' + u.field + '] 「' + u.text + '」');
      console.log('    未在原文出现的词: ' + u.missing.join(', '));
    }
  }
  add(
    '无幻觉（所有事实片段都有原文支撑）',
    unsupported.length === 0,
    unsupported.length ? unsupported.length + ' 条缺乏支撑' : ''
  );

  // ===== 质量自检（语义级，不是只看字段非空）=====
  //
  // 上一版自检 6/6 全过，但输出实际有三个真问题：
  //   1. engineering 退化成了嵌套对象/数组（碎片清单）
  //   2. projects 把技术栈名当成了项目路径，还记了一次性任务细节
  //   3. 字段串味：communication 里混进了提交规范
  // 所以这里检查的是「语义形状」，不是「字段有没有值」。
  console.log('\n=== 质量自检（语义级）===');

  const isPlainParagraph = (v) =>
    typeof v === 'string' && v.trim().length > 0 && !v.trim().startsWith('[') && !v.trim().startsWith('{');

  // --- 形状检查：文本字段必须是字符串段落 ---
  for (const key of ['identity', 'communication', 'engineering', 'environment', 'notes']) {
    const v = profile[key];
    if (v === undefined || v === '') continue; // 允许空（该节无信息）
    add(
      key + ' 是字符串段落（非数组/嵌套对象）',
      isPlainParagraph(v),
      !isPlainParagraph(v) ? '实际类型: ' + (Array.isArray(v) ? 'array' : typeof v) : ''
    );
  }

  // --- 语义检查：engineering 不能是对象 ---
  add(
    'engineering 不是嵌套对象（禁止碎片清单）',
    profile.engineering === undefined || typeof profile.engineering === 'string',
    typeof profile.engineering === 'object' && profile.engineering !== null
      ? '实际是对象，键: ' + Object.keys(profile.engineering).join(', ')
      : ''
  );

  // --- 语义检查：projects 的 key 必须像路径 ---
  const proj = profile.projects;
  if (proj && typeof proj === 'object' && !Array.isArray(proj)) {
    const keys = Object.keys(proj);
    const looksLikePath = (k) => k.includes('/') || k.includes('\\') || /^[a-zA-Z]:/.test(k);
    const badKeys = keys.filter((k) => !looksLikePath(k));
    add(
      'projects 的 key 是路径而非技术栈名',
      badKeys.length === 0,
      badKeys.length ? '不像路径的键: ' + badKeys.join(', ') : ''
    );
  } else {
    add('projects 是对象', false, '实际类型: ' + typeof proj);
  }

  // --- 语义检查：communication 不该混进工程规范 ---
  const comm = String(profile.communication || '');
  const engineeringLeak = /提交|commit|测试|test|框架|框架|类型|TypeScript|vitest|jest|pnpm|npm/i.test(comm);
  add(
    'communication 未混入工程规范（提交/测试/工具链）',
    !engineeringLeak,
    engineeringLeak ? '命中工程词，疑似串味' : ''
  );

  // --- 语义检查：身份里不该有一次性任务细节 ---
  const identityText = String(profile.identity || '');
  const taskLeak = /记忆功能|帮我看|这个文件|加个|改一下/.test(identityText);
  add(
    'identity 未混入一次性任务细节',
    !taskLeak,
    taskLeak ? '命中任务词，疑似串味' : ''
  );

  // --- 语义检查：notes 不该混入任务细节 ---
  const notesText = String(profile.notes || '');
  const notesTaskLeak = /修复|修改|实现|加个|改一下|这个文件|这个问题|bug/i.test(notesText);
  add(
    'notes 未混入任务细节（修复/修改/实现…）',
    !notesTaskLeak,
    notesTaskLeak ? '命中任务词，疑似把任务当长期信息' : ''
  );

  // --- 语义检查：同一信息不该跨字段重复 ---
  // 抽取每个字段里的「短语」（按标点切分），看是否在多个字段中出现
  const fields = ['identity', 'communication', 'engineering', 'environment', 'notes'];
  const phraseOwners = new Map();
  for (const f of fields) {
    const text = String(profile[f] || '');
    if (!text) continue;
    const phrases = text.split(/[，。；、,.;]/).map((s) => s.trim()).filter((s) => s.length >= 6);
    for (const p of phrases) {
      if (!phraseOwners.has(p)) phraseOwners.set(p, []);
      phraseOwners.get(p).push(f);
    }
  }
  const dupPhrases = [...phraseOwners.entries()].filter(([, owners]) => owners.length > 1);
  add(
    '同一信息未跨字段重复',
    dupPhrases.length === 0,
    dupPhrases.length ? '重复: ' + dupPhrases.map(([p, o]) => '「' + p + '」在 ' + o.join('/')).join('；') : ''
  );

  // --- 内容检查：旧信息不能丢 ---
  add(
    '保留了 notes 里的旧信息（shiqi3286-create）',
    String(profile.notes || '').includes('shiqi3286-create'),
    ''
  );

  // --- 输出结果 ---
  let passed = 0;
  for (const c of checks) {
    console.log((c.ok ? '✓' : '✗') + ' ' + c.label + (c.ok || !c.detail ? '' : '  ← ' + c.detail));
    if (c.ok) passed++;
  }
  const total = checks.length;
  const pct = Math.round((passed / total) * 100);
  console.log('\n通过 ' + passed + '/' + total + '（' + pct + '%）');

  if (passed === total) {
    console.log('\n✅ 全部通过：输出符合画像结构，可以进入实现阶段。');
  } else if (pct >= 70) {
    console.log('\n⚠️  基本可用但有瑕疵：可以继续，建议再调整 prompt 收紧。');
  } else {
    console.log('\n❌ 质量问题明显：先改 prompt / 换模型，不要急着写生产代码。');
  }
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
