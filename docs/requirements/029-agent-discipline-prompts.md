---
id: 029
type: feature
title: Agent 工作纪律提示词 + goal 受阻/防重复（DSH 经验移植）
status: doing
branch: feat/029-agent-discipline-prompts
created: 2026-10-19
updated: 2026-10-19
---

## 背景

Cuckoo 的 agent 能力靠"提示词 + 网页 hook"驱动。对比 DeepSeek Harness（DSH）后确认：
**内核不换（算力仍来自网页账号），但 DSH 一部分 agent 能力本质是提示词文本与循环纪律，可以移植。**

移植前先修一处会拖垮一切的**模板自相矛盾**：

四份平台模板（`src/prompt/{deepseek,default,claude,chatgpt}.md`）命令
「代码块外不要有任何文字」「不要在代码块外输出任何自然语言」「其他内容不需要回复」，
而 `goalDone` 自己的提示词段（`goal-done.ts`）要求「调用前先在正文给出完成情况总结」。
模型要么违反基座提示词、要么丢掉目标总结——纯净模式里目标完成时看不到交付说明即由此而来。

并且 [#L127] 让模型「见 systemPrompt.md 末尾的工具类型定义」：
`src/prompt/*.md` 在打包白名单里，但 `systemPrompt.md` **根本不存在于安装包**，模型也读不到——一句永远无法兑现的指路。

## 关键约束（代码核实，非推测）

- `extractJsToolBlocks`（`bridge/parser/js-detector.ts`）对 **`cuckoo` 围栏一律视为工具脚本**，
  与块外是否有正文**无关**；`hasOnlyFences` 只约束 `js`/`javascript` 围栏。
  → 因此"代码块外必须无文字"对 cuckoo 块**不提供任何解析保护**，只是白白禁掉了正文。
- `edit` 工具**没有**"必须先读"的硬护栏（不像 DSH 的 `fs-observation-policy` 会抛 `FS_NOT_OBSERVED`）。
  → 纪律只能写成**行为规范**，绝不能谎称存在 `NOT_OBSERVED` 这类错误码。
- `GrepOptions.path` 接受**单个文件**（"搜索起始文件或目录"）→ 截断后"grep 定位再 read 精读"的建议成立。
- 各工具 `getPromptSection()` 已覆盖 `oldString` 唯一性 / `replaceAll` / `dryRun` / "先 read"
  （见 `impl/edit.ts:200-213`）→ 纪律段**不得重复**这些，否则每轮白烧 token。

## 目标

1. 消除四份模板的自相矛盾与坏引用（统一放宽为"作用域限制"而非绝对禁令）
2. 建立**单一真相源**的「工作纪律」章节，四平台共用，避免各改各的分叉
3. `goal` 自动推进吸收 DSH `goal-round-driver` 的提示结构：每轮点明目标原文 + 轮次预算 + "以现场为准" + "完成要有证据"
4. 新增 `goalBlocked(reason)` 工具：受阻成为模型的**显式声明**，取代靠正则猜"是否在索要信息"
5. 重复输出**先提醒再停**（旧版第 3 次直接静默停止，模型与用户都不知道为何中断）

## 方案

### 1. 纪律单一真相源

新增 `src/prompt/discipline.md`，由 `prompt-builder.ts` 的 `readWorkDiscipline()` 读入，
经新占位符 `{{WORK_DISCIPLINE_SECTION}}` 注入四份模板（与既有 `{{MCP_SECTION}}` 等同构）。

七条纪律（不含工具段已覆盖内容）：状态以现场为准 / 做完就验证 / 输出截断后如何精读 /
`/goal` 完成证据与阻塞判据 / `/plan` 草稿期只读 / `runAgent` 委派自包含 / 受保护路径别绕道硬改。

### 2. goalBlocked 工具（镜像 goalDone）

`impl/goal-blocked.ts`：`apiMetas` order 20、category 任务管理；
提示词段 order **116**（goalDone 115 / nameConversation 114，不撞号），
关键语义是**反向约束**——"还没做完 / 有点难 / 不太确定都不是阻塞"，防止模型过早停手。

依赖铁律照旧：tools 不 import app，`entry.ts` 注入 `pushGoalBlocked`（与 `injectGoalDonePusher` 同处）。
`app/goal.ts` 推送 `{ type: 'goal-blocked', reason }` 到 harness 视图。

### 3. harness 目标状态机

- 进度计数从闭包变量 `goalNoProgress` 迁到 `goal.noProgress`
  （旧版**刷新即清零**，等于防死循环上限每刷新一次就重置）；
  `loadGoalState` 对旧存档补默认值，向后兼容。
- 新状态 `goal.blocked`：`goalBlocked` 工具触发 → 暂停自动推进、状态灯显示「受阻」、
  保留目标与轮次，用户处理后点「继续」即解除。
- 轮内重复输出：第 2 次重复发一条"换策略"提示（`overrideText`，走同一个发送出口，不复制粘贴逻辑），
  第 4 次才硬停。
- 启发式兜底：`asksForUserInput` 原先只服务 plan；现也用于 goal，但**要求连续两轮命中**才暂停
  （正则有已知误报，单轮命中不足以停掉整个目标），文案标「疑似」。
- `buildGoalSendText` / `nudgeSendText` 补回"必须写成 cuckoo 块"提醒——否则 `goalDone()` 可能被当正文输出而永不生效。

### 4. 重新生成契约

`api.d.ts` 与 `bootstrap.generated.ts` 是入库生成物，跑 `npm run compile` 重生成
（`build-tool-api.mjs` 从 `out/src/tools/impl/*.js` 汇总 `apiMetas` + `bootstrap`）。
重建顺带改了 4 个生成文件的**行尾**而内容零差异（`git diff --numstat` 为空），已 `git checkout` 复原，保持改动聚焦。

## 验收标准

- [x] 四份模板不再含绝对化禁令、不再引用不存在的 `systemPrompt.md`（`prompt-builder.test.js` 断言）
- [x] `{{WORK_DISCIPLINE_SECTION}}` 在四份模板均存在，且被替换、纪律正文只出现一次（不重复拼接）
- [x] `goalBlocked` 注册、schema（reason 必填）、推送、空 reason 拒绝、无窗口/无视图报错（8 个用例）
- [x] `bootstrap-consistency`：注入的 `goalBlocked` 有同名注册工具
- [x] `harness.html` 内联脚本 `node --check` 通过（UTF-8 读取；曾因误用 GBK 解码产生假语法错误）
- [x] `npm run typecheck` 绿；改动文件 lint 无新增 error（仓库 D22 阶段 ESLint 只检 .js）
- [ ] 真机验证：/goal 跑一个多轮任务，观察 `<goal_round>` 续跑、goalBlocked 暂停、重复提醒是否生效

## 遗留 / 后续

- **read-before-edit 仍是纪律，不是护栏**。DSH `fs-observation-policy` 的服务端强制（未读→`FS_NOT_OBSERVED`，
  读到版本→CAS）没做，需要改 `edit.ts`/`write.ts` + `ToolResult` 错误码 + 配置开关，属独立需求。
- 工具结果错误码（`ToolResult` 加 `code`，输出 `[error code: X]`）未做——`observer.ts` 目前仍靠正则判"代码不完整"。
- 长输出 spill 落盘（DSH `dsh-spill`）未做：`JsRunner` 的 `OUTPUT_LIMIT=20000` 仍直接截断，纪律只能教模型"别猜、去 grep"。
- `goalNoProgress>=4` / `asksStreak>=2` 阈值待真机调参。
- 模板里的 `{{TOOLS_LIST}}` 与 `{{TOOL_API_TYPES}}` 信息重叠（约 15KB d.ts 每轮重发），
  可按 DSH "按需披露"改为短索引 + 指向 `resources/tools/cuckoo-tools.d.ts` 的 read；本次未动以免扩大面。
