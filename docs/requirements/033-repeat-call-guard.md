---
id: 033
type: feature
title: 重复工具调用检测与提醒（移植 DSH repeat-tool-reminder）
status: review
branch: feat/033-repeat-call-guard
created: 2026-10-19
updated: 2026-10-19
---

## 背景

模型卡住时最常见的失败模式是**反复发同一个调用**——同一个 read、同一条 bash、同一个失败的 edit。
每次都是一次完整的网页往返：零 token 成本只是名义上的，实际烧的是网页额度与等待时间。

现状：只有 harness 前端的 goal 驱动有"输出文本连续相同 → 提醒"的粗粒度检测
（029 加的 `noProgress`），工具层完全没有。模型在**非 goal 模式**下反复重发同一调用无人管。

DSH 用独立插件 `dsh-repeat-tool-reminder`（69.9KB）做这件事。Cuckoo 没有那条事件总线，
改为在 JsRunner 的 hostBridge 里记账。

## 目标

1. 同一会话内**连续**相同工具调用达到阈值 → 把"换策略"提醒拼进模型每轮必读的工具结果
2. 只提醒不阻断（轮询/等待是合法重复）
3. 不污染沙箱内工具返回值契约

## 方案

### 新模块 `src/tools/runtime/repeat-guard.ts`

- 签名 = `工具名 + 稳定序列化参数`（对象键排序；数组保持顺序——轮询 offset 变化不算重复；
  超长字符串截断防大内容驻留；循环引用安全）
- 按会话隔离，**连续**相同才累计（中间夹别的调用即清零——"连续"才说明卡住）
- 默认阈值 3，提醒最多 2 次（不刷屏）；会话数上限 200，超出按插入序淘汰
- 阈值 ≤0 = 关闭（配置项语义）

### 接线 `JsRunner.hostBridge`

- **失败结果**：提醒追加到 `error` 文本（error 本就是给模型看的自由文本）
- **成功结果**：**绝不改 `result.data`**——它是沙箱里工具函数的返回值
  （`deleteFile` 返回 `{message,path}`，改了会破坏 AI 代码 `r.path` 的字段访问契约）。
  提醒收进 `repeatHints[]`，脚本结束时拼到 output **开头**（与规则注入同一通道，
  截断切尾所以开头必保留）

### 配置

`~/.cuckoo/config.json` 新增 `repeatCallThreshold`（默认 3，≤0 关闭），
`getRepeatCallThreshold()/setRepeatCallThreshold()` 走 032 的 mtime+size 缓存。

## 验收标准

- [x] 前两次不提醒、第三次起提醒；措辞区分"调用/失败调用"（13 个单测）
- [x] 键顺序不同的同参数调用判为相同；数组顺序敏感；超长参数截断；循环引用不抛错
- [x] 夹一次别的调用即清零；会话隔离；resetSession 生效；提醒上限 2 次
- [x] E2E：JsRunner 连发 3 次相同脚本 → 第三次 output 开头含提醒
- [x] E2E：沙箱内 `String(返回值)` 不含提醒（契约不污染），同时提醒确实出现在 output
- [x] E2E：read 换 offset 轮询 4 次不触发提醒
- [x] typecheck 绿；全量测试通过（见下）

## 遗留 / 后续

- 检测是**跨脚本、按会话**的，但"新任务开始"没有显式清零：用户发新消息后旧 streak 仍在。
  影响很小（提醒最多 2 次且新调用签名通常不同），暂不加钩子。
- 同参数但**磁盘状态已变**的调用（如轮询同一文件）也会计数。当前靠"轮询提醒文案"引导；
  若实测误报明显，可把 read/grep 的 offset/limit 排除出签名。
- plan 模式只读强制 → 034。
