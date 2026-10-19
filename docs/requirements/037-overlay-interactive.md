# 小说工作台 · 第 0 步技术验证结论

> 结论时间：2026-10-20
> 验证方式：探针插件 `novel-probe` + CDP 实测
> 运行版本：Cuckoo **v0.8.31**（含需求 037 的交互模式修复）

---

## 总结论：**可行** ✅

overlay 覆盖层可以承载中文写作界面。三项核心能力全部实测通过，
中文输入法在真实系统 IME 下工作正常。

| 验证项 | 结果 | 关键证据 |
|---|---|---|
| **T1 覆盖层 / 全屏** | ✅ 通过 | 1491×749 铺满视口；31 个 `dshp` 交互元素被 preload 识别；z-index 2147483000 |
| **T2 中文输入法（IME）** | ✅ **通过** | `compositionstart` → 6 次 `compositionupdate`（n→ni→nih→niha→nihao→你好）→ `compositionend`，落字「你好」 |
| **T3 键盘焦点** | ✅ 通过 | 连按 5 次键焦点稳定在 `TEXTAREA#probeEditor`；`focusin` 正常 |
| **T4 AI 流式事件** | ⏳ 待验证 | 订阅已建立，需在 AI 对话发一句触发 |

---

## 关键发现：overlay 原本不可交互（已修复）

### 问题

`src/app/entry.ts` 创建 overlay 窗口时：

```js
new BrowserWindow({
  focusable: false,                                    // 不抢焦点（为桌宠设计）
  ...
});
ow.setIgnoreMouseEvents(true, { forward: true });       // 鼠标全穿透
```

该配置下实测（CDP 验证）：

| 指标 | 实测值 |
|---|---|
| `document.hasFocus()` | **false**（恒为假） |
| `focus` 事件 | **0 次** |
| 合成事件（`dispatchEvent`） | 能到达 —— 说明监听器正常，是系统层没给焦点 |
| `activeElement` | 能被 JS 设为 textarea，但真实按键进不来 |

**结论**：任何需要输入/点击的插件 UI（表单、编辑器、写作台）**在旧版本上做不了**。
这个限制不在 `docs/plugin-system.md` 里，是读源码才发现的。

### 修复（需求 037）

新增 `ctx.ui.overlay.setInteractive(boolean)`：

```
开（true）
  ├─ setFocusable(true)          窗口可激活 → 键盘/IME 才能进来
  ├─ setIgnoreMouseEvents(false) 鼠标不穿透 → 点击落到插件 UI
  └─ focus()                     主动抢焦点（否则要点一下才开始）

关（false）
  ├─ setFocusable(false)         恢复桌宠语义
  ├─ setIgnoreMouseEvents(true)
  └─ 焦点交还主窗口
```

三处必要的联动（否则修不好）：

1. **穿透轮询必须让路** —— `plugin.ts` 每 200ms 的轮询在交互模式下要直接 return，
   否则它会把 `setIgnoreMouseEvents` 改回 `true`，把输入抢走
2. **页面重载后重新抢焦点** —— `did-finish-load` 在交互模式下用 `show()+focus()`，
   不能用 `showInactive()`（不激活窗口，刷新一次输入就断）
3. **默认行为不变** —— 创建时仍 `focusable: false`，桌宠等现有插件不受影响

修复后实测：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| `document.hasFocus()` | false | **true** |
| 真实键盘输入 | 进不来 | CDP 发 `abc` → 编辑器 value = `"abc"` |
| 真实中文 IME 输入 | 不可用 | **落字「你好」** ✅ |

---

## 对小说工作台的实现建议

### 架构约束（已验证）

| 约束 | 说明 |
|---|---|
| **必须调 `setInteractive(true)`** | 否则界面只能看不能点 |
| 元素要有 `dshp` 前缀 class | preload 靠这个扫描并上报鼠标可交互区（每 120ms） |
| **不要 `document.body.innerHTML = ''`** | 会删掉宿主的 `__ck_overlay_root`；应往 root 里写或保留它 |
| 覆盖层无网络、无 base URL | 资源走 `cuckooOverlay.readAsset(pluginId, relPath)` |
| 覆盖层是独立页面 | 模块作用域的变量进不来；页面代码须自包含字符串 |

### 建议的数据布局

```
<项目根>/novel/
├── 章节/第001章-标题.md
├── 设定/人物-xxx.md
├── 设定/世界观.md
├── 大纲.md
└── 摘要/第001章.md
```

放项目目录（不放插件私有存储）的理由：AI 本来就能直接读写这些文件，
插件只是**可视化层**。这样"AI 干活"和"你手动改"看到的是同一份真相。

### 功能分层（按优先级）

| 层 | 内容 | 依赖 |
|---|---|---|
| L1 | 单文件编辑 + 保存 + 选中即润色 | L1 已验证（本文件） |
| L2 | 章节树 + 设定集面板 + AI 流式写回光标 | 需验证 T4 |
| L3 | 上下文分层：章节摘要链 / 伏笔台账 / rules 按需注入 | 设计为主 |
| L4 | 一致性检查（注册 AI 工具扫设定冲突） | L2 之后 |

### 长篇上下文方案

一章 5000 字、30 章 = 15 万字，远超模型窗口。建议分层：
- 当前章 + 上一章尾部（窗口内）
- 设定集按需检索注入（复用 `rules` 的 paths 匹配机制）
- 每章 100 字摘要链
- 伏笔台账（显式记录"埋了什么/在哪回收"）

---

## 复现方式

```powershell
# 1. 探针插件位置
C:\Users\<you>\.cuckoo\plugins\novel-probe\
  ├── plugin.json
  └── ui\index.js

# 2. 确保启用
# ~/.cuckoo/plugins-state.json 里 "novel-probe": { "enabled": true }

# 3. 需要 Cuckoo >= v0.8.31（含交互模式）

# 4. 带调试端口启动可远程查状态
Cuckoo-Code.exe --remote-debugging-port=9222
```

CDP 查状态：
```js
// 连 overlay 页面（url 以 data:text/html 开头）
JSON.stringify({
  hasFocus: document.hasFocus(),
  dshpCount: document.querySelectorAll('[class*="dshp"]').length,
  activeEl: document.activeElement && document.activeElement.id
})
```

---

## 遗留

- **T4 未验证**：需在 AI 对话发一句话触发 `agent/assistant-stream`
- 探针未测试大文件、长文本滚动的性能
- 未测试 overlay 与 AI 页面同时可见时的鼠标行为（交互模式下 AI 页面暂时不可点，是否可接受待定）
- 未测试多窗口场景（每个窗口一个 overlay？）
