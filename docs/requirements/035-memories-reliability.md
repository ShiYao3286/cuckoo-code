---
id: 035
type: fix
title: 记忆可靠性——作用域 / 原子写入 / 可查询删除
status: review
branch: feat/035-memories-scope-atomic
created: 2026-10-19
updated: 2026-10-19
---

## 背景

记忆功能（027/028）落地后有三处硬伤：

1. **AI 删不掉既有记忆**：`forgetMemory(id)` 需要 id，但工具面**没有 listMemories**——
   跨会话时 AI 根本拿不到 id。而 `memories.json` 又被 `protected-paths` 保护，不能绕道 read/bash。
   结果：AI 记错的记忆会永久污染每次对话的提示词，只有用户能在 UI 里手动清理。
2. **写入非原子**：`fs.writeFileSync` 直接覆盖。写到一半崩溃/断电 → 半截 JSON →
   下次读取 catch 掉返回 `[]` → 再写一次就把全部记忆覆盖掉。**一次崩溃丢光所有记忆。**
3. **无作用域**：全部记忆都是用户级。「这个仓库用 pnpm」会在所有项目注入，成为噪音。

## 目标

- AI 能列出并删除既有记忆（补 `listMemories` 工具）
- 记忆写入原子化（崩溃不丢数据）
- 记忆支持作用域：`user`（全局）/ 项目路径（仅该项目）
- UI 能展示作用域、编辑不丢数据

## 方案

### 1. 存储层 `src/infra/memories.ts`

- `Memory` 加 `scope` 字段：`'user'` 或规范化项目绝对路径
- `normalizeProjectPath()`：绝对路径 + 统一正斜杠 + Windows 转小写（匹配用）
- **旧数据向后兼容**：无 `scope` 字段时归一为 `'user'`
- **原子写入** `writeAtomic()`：写 `.tmp-<pid>-<ts>` → `rename`。同盘 rename 是原子操作
- `saveMemories` 返回 `{ success, dropped }`——静默丢非法项的旧行为改为可观测
- `listMemories({ scope })` / `listMemoriesForProject(dir)` 支持按作用域过滤
- `buildMemorySection(projectDir?)` 只注入「用户级 + 该项目」，项目记忆带「（本项目）」标记
- 章节截断改为**按条**（而非按字符硬切），并提示「另有 N 条未展示」
- 新增 `updateMemory(id, text)`：保留 id/scope/createdAt，只改 text 与 updatedAt
- 淘汰策略：一次性排序 + splice（原先 while 循环里反复 sort）

### 2. 工具层 `src/tools/impl/remember.ts`

- **新增 `listMemories(options?)` 工具**（`scope: 'all'|'user'|'project'`，默认 all）
  - 返回的 `scope` 是标签（`user`/`project`），**不暴露绝对路径**
- `remember(text, scope?)` 加 scope 参数：`'user'`（默认）/`'project'`/绝对路径
- `forgetMemory` 失败时提示「可用 listMemories() 查看现有记忆的 id」
- **不提供 `getProjectDir()`**：项目目录每窗口不同，而 store 是全局单例；
  改为从 `params.projectDir` 取（JsRunner 每次调用都带），避免全局状态串味

### 3. 接线

| 文件 | 改动 |
|---|---|
| `tools/index.ts` | 注册 `ListMemoriesTool` |
| `app/entry.ts` | `injectMemoryStore` 的 add/list 补 scope |
| `session/prompt-builder.ts` | `buildMemorySection(selectedDir)` 按项目过滤 |
| `app/ipc/memory.ts` | 新增 `update-memory`；`save-memories` 返回 dropped；标记固定写 user |
| `app/shell-preload.ts` + `shell-api.ts` | 暴露 `updateMemory`，`addMemory` 加 scope |
| `ui/.../memories.ts` | 显示作用域徽标；编辑改增量 `updateMemory`（避免整体覆盖丢数据）；新建可选作用域 |
| `ui/.../components.css` | 作用域徽标样式 |
| `ui/.../memories.html` | 说明文字更新 |

## 验收标准

- [x] AI 能 `listMemories()` 拿到 id，再用 `forgetMemory(id)` 删除
- [x] `listMemories` 默认只返回「用户级 + 当前项目」，不泄露其他项目记忆
- [x] `remember(scope: 'project')` 写入项目路径；无项目上下文时拒绝
- [x] 写入原子：不留 tmp 文件；崩溃不会产生半截 JSON
- [x] 旧数据（无 scope 字段）读出来自动归为 user
- [x] `buildMemorySection(projectDir)` 只注入 user + 该项目
- [x] 章节超长按条截断，提示「另有 N 条未展示」
- [x] UI 编辑走增量更新，不覆盖整个数组
- [x] typecheck / 全量测试（101 files / 1031 tests）全绿

## 遗留 / 后续

- **真机验证受阻**：项目路径含中文（`E:\ai处理文件`），Electron 开发模式启动失败
  （退出码 0x80000003）。需构建正式安装包后再验。
- 作用域目前只有 user / 项目两级。若将来要「工作区组」等更细粒度，需扩展 scope 编码。
- `updateMemory` 尚未在 AI 工具面暴露（只有 UI 用）。若要 AI 能改记忆内容，加个 `updateMemory` 工具即可。
