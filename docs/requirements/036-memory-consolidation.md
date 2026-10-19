---
id: 036
type: feature
title: 用户画像自动整理（LLM 合成）
status: review
branch: feat/036-memory-consolidation
created: 2026-10-19
updated: 2026-10-19
---

## 背景

035 把记忆做成了「扁平事实清单」：`[{text, scope}]`。它能用，但有三个结构性局限：

1. **碎片化**：每条独立、无关联，越积越多（上限 200 条纯属无奈）
2. **只增不减**：没有淘汰机制，矛盾的旧记忆会一直留着
3. **信息密度低**：占提示词空间，但传达的「用户是谁」很模糊

GPT 的 Dreaming V3 给出了另一种答案：**用 LLM 把历史对话合成为「结构化画像」，每次重写而非追加**。
官方数据显示事实检索准确率从 41.5% 提升到 82.8%，偏好遵循率从 31.4% 到 71.3%。

## 目标

- 用户画像 = 结构化段落（identity / communication / engineering / environment / projects / notes）
- 整理 = 「现有画像 + 新对话」→ LLM 重写 → 完整新画像
- 质量保障 = **预览 diff + 用户确认 + 可回滚**（自动化质检不可靠，见验证结论）
- 保持项目「零 Token 成本」定位：默认用免费模型

## 验证结论（已完成）

详见 `docs/memory-consolidation-prompt.md`。核心发现：

| 模型 | identity 输出 | 判定 | 耗时 | 成本 |
|---|---|---|---|---|
| 智谱 `glm-4-flash` | 「前端开发者，熟悉 JavaScript」 | ❌ 原文零依据 | 6.4s | 免费 |
| 智谱 `glm-4-plus` | 空 | ✅ 最克制 | 1.3s | ¥0.0012 |
| `deepseek-v4.1-flash-free` | 「…千余个用例」 | ⚠️ 过度推断 | 5.0s | 免费 |
| **`nemotron-3-super-120b`** | 空 | ✅ 好 | 43.5s | 免费 |

三条结论：
1. **幻觉是模型能力，prompt 救不了**——同一 prompt，plus/nemotron 正确留空，flash 编造三次
2. **「正确的克制」比「丰富的输出」更值钱**——好模型的特征是原文没有就留空
3. **自动化质检不可靠**——关键词匹配误报率极高，必须人工预览兜底

## 方案

### 1. 数据结构（memories.json v2）

```jsonc
{
  "version": 2,
  "profile": {
    "identity": "…",
    "communication": "…",
    "engineering": "…",
    "environment": "…",
    "projects": { "E:/proj/foo": "该项目专属约定" },
    "notes": "…"
  },
  "savedMemories": [ /* 035 的显式清单保留，作为"硬事实" */ ],
  "meta": {
    "lastConsolidatedMessageId": 12345,
    "lastConsolidatedAt": 1234567890,
    "model": "nemotron-3-super-120b"
  }
}
```

- `profile`：LLM 重写的画像
- `savedMemories`：保留 035 的显式记忆（用户/AI 明确记的硬事实，不参与重写）
- `meta.lastConsolidatedMessageId`：增量游标

### 2. 整理管道

```
触发（手动按钮 / 每日一次）
    ↓
读 IDB：取 lastConsolidatedMessageId 之后的新对话
    ↓
调 LLM：现有画像 + 新对话 → 重写后的完整画像
    ↓
预览：UI 展示 diff（旧画像 vs 新画像）
    ↓
用户确认 → 原子写入 + 备份上一版
```

### 3. 质量保障（三层）

| 层 | 机制 | 目的 |
|---|---|---|
| 1 | **预览 diff** | 用户能看见 LLM 改了什么，不像就拒绝 |
| 2 | **确认后落盘** | 不自动写入，避免污染 |
| 3 | **保留 `.bak`** | 一键回滚 |

### 4. 模型配置

- 默认：`nemotron-3-super-120b`（免费，质量已验证）
- 可选：用户自配 OpenAI 兼容端点 + 模型名
- Key 存 `safeStorage`，不落明文

## 前置条件（必须先解决）

| # | 缺口 | 位置 | 工作量 |
|---|---|---|---|
| 1 | 读不到对话正文 | `compaction.ts` 的 `getMessagesFromIndexedDB` 只取了 3 个字段 | 小 |
| 2 | 不知道 `content` 在 IDB 里的确切结构 | 已探明 store/key，**字段名待确认**（见下） | 小 |
| 3 | 没有增量游标 | `memories.json` 加字段 | 小 |

### IDB 探针结论（2026-10-19）

已在真实数据上验证（复制 LevelDB 文件 + 读 MANIFEST）：

| 项 | 结论 |
|---|---|
| 库名 | `deepseek-chat` |
| store 名 | **`history-message`**（MANIFEST 里确认） |
| key | **sessionId（UUID）**，如 `c336c9ec-b38f-441f-9e64-2f63648afa40` |
| value 结构 | `{ data: { chat_messages: [...], chat_session: { current_message_id } } }`（现有代码已在使用） |
| 单个消息已知字段 | `message_id`（number）、`role`（string）、`parent_id` |
| **待确认** | 消息正文的字段名（`content`? `text`? 嵌套结构?） |

**注意**：LevelDB 数据块经 **Snappy 压缩**，直接读 `.ldb` 文件搜不到明文。
必须通过浏览器运行时（`indexedDB` API）读取，不能离线解析文件。

**为什么这次没能直接确认 content 字段**：新开窗口共享 partition 后跳转到了 `/sign_in`，
该页面上下文里 `deepseek-chat` 库的 store 未初始化（`objectStoreNames` 为空）。
需要在**已登录且已进入会话页**的主窗口里执行才能读到。

**下一步**：实现时先加一个临时探针——在 bridge 层读一条消息并 `console.log(Object.keys(m))`，
从应用日志确认字段名，再写正式解析逻辑。这是 5 分钟的活。

## 验收标准

- [x] 能读出指定会话的完整对话正文（三层兜底：content / fragments / 最长字符串）
- [x] 整理后画像的 6 个字段结构正确（normalizeProfile 归一化）
- [x] 预览 diff 能正确显示字段级变化
- [x] 用户拒绝时原画像不变
- [x] 用户确认后原子写入，且生成 `.bak`
- [x] 回滚功能可用
- [x] 增量整理：第二次整理只读新对话（meta.lastConsolidatedMessageId）
- [ ] **免费模型端到端跑通（待真机验证）**
- [x] typecheck / 全量测试绿（107 files / 1081 tests）

## 实现清单（2026-10-19）

| 模块 | 文件 | 说明 |
|---|---|---|
| 文件层 | `infra/memories-file.ts` | v1 数组自动升级 v2；原子写 |
| 画像 | `infra/memory-profile.ts` | profile 与 savedMemories 分离读写 |
| 整理器 | `infra/memory-consolidator.ts` | 调 LLM；JSON 提取容错；超时/降级 |
| 读正文 | `session/conversation-reader.ts` | 页面内注入执行；三层提取 |
| 编排 | `session/memory-consolidation.ts` | 增量游标；格式化；预览 |
| 凭据 | `app/memory-credentials.ts` | safeStorage 加密 |
| IPC | `app/ipc/memory-consolidation.ts` | 8 个通道 |
| UI | `ui/shell/.../memories.*` | 配置折叠区 + 整理按钮 + 画像展示 |

## 待真机验证的关键点

1. **正文能否读到**：`chat_messages` 的实际字段名未确认。已做三层兜底 + 诊断输出，
   若失败会直接显示字段名列表。
2. **LLM 端到端**：用 nemotron-3-super-120b（免费）跑通整理 → 预览 → 落盘。
3. **注入效果**：重新初始化项目后，提示词里应出现「用户画像」章节。

## 遗留 / 后续

- **43 秒延迟**：nemotron 较慢。若用户抱怨，可提供「快速模式」切智谱 plus（¥0.0012/次）
- **画像字段可扩展**：未来可能加 `goals`（长期目标）等，需版本化 `profile` schema
- **与 savedMemories 的关系**：硬事实（用户明确说的）优先于画像推断，注入时硬事实在前
