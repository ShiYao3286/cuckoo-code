---
id: 034
type: feature
title: 计划模式只读强制（草稿/待确认期拒绝副作用工具）
status: review
branch: feat/034-plan-read-only-guard
created: 2026-10-19
updated: 2026-10-19
---

## 背景

`/plan` 的设计是三段闸门：`draft`（模型列计划）→ `confirm`（等用户确认）→ `exec`（执行）。
029 在纪律文档里写了"草稿期只读"，但**工具层完全没有强制**——grep 全仓 `planMode|planState`
在主进程零命中：plan 状态只活在 harness 渲染进程的 localStorage 里，主进程拿不到。

也就是说模型在草稿期照样能 `write`/`deleteFile`/跑 `bash`，"闸门"是纸糊的。
这正是 030 之后反复确认的那类问题：**提示词说了、代码不管**。

## 目标

草稿/待确认阶段，任何有副作用的工具调用在**执行前**被拒绝，并告诉模型正确动作（列计划）。

## 方案

### 1. 主进程镜像 `src/infra/plan-mode.ts`（新增）

harness 的 `planState.phase` 上报到主进程，按会话存内存 Map。

- **放 infra 的原因**：依赖铁律 `infra ← providers ← tools ← bridge ← session ← app`。
  写方是 app 层（harness IPC），读方是 tools 层（registry），infra 是唯一合法交点。
- **键**：`sessionStore.state.currentSessionId`。写入方（ipc/harness 用 `findContext(sender).sessionStore`）
  与读取方（ipc/tool 传给工具的 `settings.sessionId`）取的是**同一个 store**，
  且都源自同一个 `provider.extractSessionId(url)`（entry.ts:384-387 与 store.ts:258 同源）→ 键必然一致。
- 空 sid（平台首页/新会话）与 `null` 都归一到 `(default)`，两侧一致。
- 非法 phase 忽略（防渲染进程异常数据污染）；会话数上限 200 按插入序淘汰。

### 2. 上报通道

- `harness-preload.ts`：`reportPlanPhase(phase)` → `ipcRenderer.send('harness-plan-phase')`
- `ipc/harness.ts`：收到后 `setPlanPhase(sid, phase)`
- `harness.html`：`savePlanState()` 里上报（所有阶段变化都经过它）；
  **`loadPlanState()` 里也上报一次**——镜像是内存态，页面重载/切换会话后必须重新同步

### 3. 拦截点：`ToolRegistry.execute()`

**关键结构修正**：原先 `JsRunner.hostBridge` 直接调 `tool.execute()`，绕过 registry。
若把护栏放 registry，AI 主路径（execute-js）根本不会经过——等于没做。
现改为 hostBridge 统一走 `this.registry.execute()`，两条 IPC 路径（execute-js / execute-tool）
在同一处收口，护栏只写一遍。

副作用：未知工具的文案从"未知工具: x"变成 registry 的"未找到工具: x"（语义等价，测试只断言失败）。

### 4. 黑名单而非白名单

拦：`write edit deleteFile bash pwsh mysql injectJS mcpCall runAgent`

- `mcpCall`/`injectJS` 能力等同 bash，必须拦
- **`runAgent` 必须拦**：子代理在**另一个会话**里执行，那边的镜像是 off——
  不拦等于留一条"草稿期借子代理偷跑写操作"的绕过通道（写测试时发现的）
- `todoWrite` **不拦**：草稿期的正确动作恰恰是列计划。用白名单会把它也拦死
- 读类工具（read/grep/glob/webFetch/mcpGetTools…）不拦

拒绝文本带下一步指令（模型每轮必读），并返回新错误码 `PLAN_READ_ONLY`。

### 5. 纪律文档同步（顺带修 032 的两处过时）

- 第 7 条改为"工具层会强制拦截 + PLAN_READ_ONLY"
- 第 2 条补 `删除`（032 给 deleteFile 加了护栏，文档当时没跟上）
- 第 5 条改为"落盘 + 首尾 + 路径"（032 已改行为，文档还写着旧的"末尾留下截断标记"）
- 错误码表补 `PLAN_READ_ONLY`

## 验收标准

- [x] draft/confirm 只读，exec/done/blocked/off 放行（含非法值忽略、会话隔离、clearSession）
- [x] 黑名单含 runAgent（子代理绕过通道）；todoWrite/读工具不拦
- [x] registry.execute 层 E2E：draft 期 write/bash 被拒且不执行；todoWrite/read 放行；exec 期恢复
- [x] 无 sessionId 的直连/插件调用归 (default)，不误伤
- [x] harness 接线顺序安全（api 定义在前；loadPlanState 重载后重新同步镜像）
- [x] harness.html 内联脚本 node --check 通过
- [x] typecheck 绿；全量测试通过（见下）
- [ ] 真机验证：开 /plan，看模型在草稿期是否老实列计划；故意让它想改文件时是否被拦并转向

## 遗留 / 后续

- **镜像只在 harness 打开时准确**：plan 状态源自 harness 页面，纯网页模式下没有上报（那里本来也没有 plan UI），
  所以不影响——但"网页模式手动发 /plan"这类边缘路径未覆盖。
- 上报是 fire-and-forget：harness 崩溃/未上报时镜像停留在旧值。影响可控（最多误拦一次，重读即恢复）。
- 未做：每轮纪律注入的通用通道（现在只有规则注入 + 重复提醒 + 错误码三个具体用途）。
- 未做：`goal` 模式的阶段强制（goalBlocked 已有，但"目标期不许乱删"这类没有码）。
