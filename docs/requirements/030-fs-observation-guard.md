---
id: 030
type: feature
title: read-before-edit 护栏 + 工具错误码 + 纪律改造（移植 DSH 机制）
status: doing
branch: feat/030-fs-observation-guard
created: 2026-10-19
updated: 2026-10-19
---

## 背景

029 只改了提示词，真机验证"感觉没啥改变"。原因是可查证的：

1. 系统提示词**只在初始化时作为一条聊天消息发一次**（`project-context.ts:162-175`），不是真 system 字段；
2. 组装后约 16KB（≈7400 token），纪律段只有 1.1KB、占 6.9%，对话一长即被稀释；
3. 029 的可见改动基本只在 `/goal` 模式。

结论：**软提示词有天花板**。DSH 之所以咬得住，是因为它的纪律由**代码强制**（`fs-observation-policy`
直接拒绝未读就改的编辑），且错误信息本身就在每一轮的工具结果里。

同一轮还实测了"直接安装官方 DSH 工具"这条路——**不可行**：
`@deepseek-ai/dsh-tool-fs` 装进 cuckoo 后 `apply(ctx, {})` 因 `readLimit` 缺失直接抛错（Cordis 本该用
`Config.parse()` 填默认值）；手动补上配置后注册成功，但 `read` 报 `ctx.fs.stat is not a function`、
`edit`/`write` 报 `import_dsh_sandbox.validateEscalationArgs is not a function`。
更危险的是它注册的 `read`/`write`/`edit` 与内置同名，而 `ToolRegistry.register` 是**静默覆盖**——
真装进应用会把三个可用工具换成三个必崩的。

故本需求改为「移植机制」，不引任何 stub 依赖。

## 目标

1. 移植 DSH `fs-observation-policy` 语义：**未读不允许改**（NOT_OBSERVED）、**读后变了不允许改**（STALE_VERSION）
2. 工具失败带**稳定错误码**，并渲染进回传文本（`[error code: X]`），让模型按码分流而非猜中文
3. 纪律文档补「失败分流」表，把错误码与下一步动作绑定
4. 全程可关（配置开关），默认开启

## 方案

### 1. 观察台账 `src/tools/runtime/fs-observation.ts`（新增）

DSH 用三个瀑布事件（`fs/write-intent` / `fs/edit-intent` / `fs/observed`）实现；cuckoo 没有那条事件总线
（grep `edit-intent|write-intent|fs/observed` 全项目零命中），故改为工具直接调用的等价接口：

- `observe(sessionId, absPath, version)` — read/readLines 成功后登记
- `guardEdit(...)` — 未观察 → `NOT_OBSERVED`；版本不符 → `STALE_VERSION`
- `guardWrite(...)` — 目标**已存在**且未观察 → `NOT_OBSERVED`；新建放行
- 版本代理：`mtimeMs:size:ino`（不哈希内容——护栏目标是"凭记忆盲改"和"外部改动后仍按旧内容改"，
  时间戳足以覆盖；同毫秒等长原地修改会漏判，不在目标场景内）
- 台账为**主进程内存**，与 `rules/injection.ts` 同款；按 sessionId 隔离，容量上限 2000 条按时间淘汰

### 2. 错误码 `src/tools/core/ToolResult.ts`

`ToolResult` 增可选 `code` 字段（`error(err, code?)` 向后兼容，现有单参调用不受影响）。
`ToolErrorCode`：`NOT_OBSERVED` / `STALE_VERSION` / `NO_MATCH` / `AMBIGUOUS_MATCH` /
`PROTECTED_PATH` / `NOT_FOUND` / `INVALID_ARGS`。

`JsRunner` 在把结果回传给模型前渲染：`[error code: X] 原文…`。

### 3. 接线

| 文件 | 改动 |
|---|---|
| `impl/read.ts` | 读成功后 `observe` |
| `impl/read-lines.ts` | **同样登记**——否则用 readLines 读完后 edit 会被误拦（实现中途发现的坑） |
| `impl/edit.ts` | 读内容前先 `guardEdit`；改为每类失败带码 |
| `impl/write.ts` | 覆盖已存在文件前 `guardWrite`；成功/新建后登记 |
| `infra/config.ts` | `fsGuardEnabled`（默认 true；旧配置无此字段视为启用） |
| `app/ipc/tool.ts` | `execute-tool` 路径补传 `sessionId`（`execute-js` 原本就有） |

关键设计：**自改即已观察**——edit/write 成功后更新台账，所以连续编辑同一文件不需每次重读。
否则模型会被迫 read→edit→read→edit，白白多花网页额度。

### 4. 纪律文档

`src/prompt/discipline.md` 新增第 2 条「改文件前先读」与第 3 条「失败按错误码分流」表，
原 9 条重排；错误码表与 `ToolErrorCode` 一一对应。

## 验收标准

- [x] 未 read 就 edit → 拒绝、码 `NOT_OBSERVED`、文件**未被改动**、给出 `read("路径")` 指令
- [x] read 后 edit 成功；read 后文件被外部改动 → `STALE_VERSION`，文件保持外部改动后的样子
- [x] 重读后可再次编辑；自改后连续编辑无需重读
- [x] 会话隔离：A 会话读过不替 B 会话放行
- [x] write：覆盖未读的已存在文件被拒；新建不受影响；read 后覆盖放行
- [x] dry-run 也受护栏（否则给出误导性预览）
- [x] `fsGuardEnabled=false` 恢复旧行为
- [x] `NO_MATCH` / `AMBIGUOUS_MATCH` 等既有失败也带上码
- [x] 全量测试 94 files / 937 tests 通过（基线 93/924，新增 13 个护栏用例）
- [x] typecheck 绿
- [ ] 真机验证：跑一个"改多个文件"的任务，观察是否出现 NOT_OBSERVED → 模型是否自动先 read 再重试

## 遗留 / 后续

- **每轮纪律注入**（上一轮讨论的 A 项）未做：通道是现成的（`JsRunner.ts:313-318` 规则注入，
  "拼在输出开头"），内容是"连续同名同参调用 → 提醒换策略"。本次先做硬护栏，因为它不依赖提示词服从。
- 长输出 spill 落盘（DSH `dsh-spill`）未做：`OUTPUT_LIMIT=20000` 仍直接截断。
- 版本代理用 mtime 而非内容哈希：同毫秒内等长原地修改会漏判。
- 台账不落盘：应用重启后模型第一次编辑需重新 read（符合预期，但可视需要加持久化）。
- `JsRunner` 的"同一脚本内重复调用检测"可复用它已有的 `toolFailures` 收集做，留待 A 项。
- **cuckoo DSH 兼容层的三个真 bug**（本轮实测发现）→ ✅ 已于 2026-10-19 修复（NEXT-PLAN T1）：
  1. `loader.ts:251` 传 `plugin.apply(ctx, {})` → 改为 `resolvePluginConfig()` 解析插件导出的 `Config.parse()` 填默认值（parse 抛错时回退 `{}`）
  2. 简化 `ctx.fs` 缺 `stat` → 补 `stat()`（type/size/mtimeMs/mtime/isFile/isDirectory/path/key）与 `exists()`
  3. （安全）插件工具与内置工具同名时 `ToolRegistry.register` 静默覆盖 → 默认**拒绝**覆盖（抛错），确需覆盖须显式 `allowOverride: true`；插件加载处逐工具 try/catch，冲突的跳过并警告
