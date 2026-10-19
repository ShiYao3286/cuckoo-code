---
id: 032
type: fix
title: 护栏加固（write 版本比对 / 内容指纹 / 删除护栏 / 长输出落盘 / config 缓存）
status: review
branch: fix/032-guard-hardening
created: 2026-10-19
updated: 2026-10-19
---

## 背景

030 落地 read-before-edit 护栏后，复查发现三类问题：**我自己引入的漏洞**、**精度不足**、**未覆盖的操作**。

## 问题与修复

### ① write 护栏只查"读过没"，不比对版本（真漏洞）

`guardWrite()` 原先只看观察记录存在与否。导致：

```
read a.txt → bash/用户改了 a.txt → write a.txt "整份新内容"  ← 直接放行，覆盖别人的改动
```

同样的场景 `edit` 会拦（STALE_VERSION），两者行为不一致。

**修复**：`guardWrite` 增加 `currentVersion` 参数，观察到版本不同同样返回 `STALE_VERSION`。

### ② 版本代理精度不足（实测复现）

原版本串 `mtimeMs:size:ino`。实测同毫秒内 4 字节→4 字节内容替换（`AAAA`→`BBBB`），
三者**完全不变** → 漏判，外部改动被当作"未变"放行。

**修复**：版本串追加内容指纹 `sha1(首4KB + 尾4KB + size).slice(0,12)`。
只取首尾是权衡：护栏目标是挡"外部改动后仍按旧内容写"，不需要密码学强度；
不为 50MB 文件算全量哈希。读不到内容时指纹为空、退化为仅 stat（宁可少判一次，不让工具不可用）。

**踩坑**：改完 `statVersion` 后 `read`/`readLines` 仍在**手拼旧格式**版本串，导致护栏永久误判 STALE。
这暴露了"单一真相源被绕过"的问题——已改为统一调用 `statVersion()`，并在两处加注释说明不要手拼。

### ③ deleteFile 完全没有护栏（不可逆操作）

删除是整个工具集里唯一不可逆的操作（edit 写错还能再改）。原先只做 `isProtectedPath`。

**修复**：本会话未读过该文件 → 拒绝，`NOT_OBSERVED`，提示先 read 确认，或改用 write 清空。
受同一开关 `fsGuardEnabled` 控制。

### ④ 长输出仍硬截断

`JsRunner` 对 >20000 字符直接 `slice` + `...[输出过长已截断]...`，模型看不到中间，只能凭开头猜。

**修复**：新增 `src/tools/runtime/spill.ts`。超限时**先落盘**再到回传文本给"首 12000 + 尾 4000 + 路径与读法"：

```
【完整输出已落盘】C:\Users\...\.cuckoo\spill\<session>-<ts>.log
（不要凭上面首尾猜中间内容：用 grep(pattern, { path: "..." }) 定位行号，
  再 read("...", { offset, limit }) 精读那一段。）
```

- 落 `~/.cuckoo/spill/`（不在 `protected-paths` 保护范围，模型可读）
- sessionId 做路径清理（防 `../` 逃逸），实测清理后仍落在 spill 目录内
- 保留 50 个文件，按 mtime 淘汰
- 落盘失败 → 退回原纯截断，不丢功能
- 函数自带阈值守卫（未超限直接原样返回）

### ⑤ config 每次读取都同步读盘

`isFsGuardEnabled()` 在每次 edit/write 调用时触发 `readConfig()` = `existsSync` + `readFileSync` + `JSON.parse`。
一个脚本连续改 N 个文件就是 N 次读盘。

**修复**：加 (mtimeMs, size) 缓存；`writeConfig` 强制清缓存保证本进程写入立即可见。

**为什么带 size**：实测本机 200 次快速连写中有 **4 次（2%）mtime 完全相同**（文件系统时钟粒度），
只靠 mtime 会漏判。配置项都是布尔开关，`true`/`false` 长度不同，实际不会漏。

## 验收标准

- [x] read 后外部改动 → `write` 拒绝 `STALE_VERSION`，外部改动保留
- [x] read 后未变 → `write` 正常覆盖；自写后连续 write 允许
- [x] 同毫秒等长内容替换：版本串能区分；edit 被 `STALE_VERSION` 拦住
- [x] `deleteFile`：未读过拒绝（`NOT_OBSERVED`，文件仍在）；read 后可删；关开关后可删
- [x] 长输出：落盘内容与原文完全一致；回传文本含路径与 grep/read 指引；未超限原样返回；
      恶意 sessionId 不逃逸目录
- [x] 全量测试 96 files / 955 tests 通过（基线 95/944，新增 11 用例）
- [x] typecheck 绿
- [ ] 真机验证：长命令输出被截断时，模型是否按指引去 grep/read 落盘文件，而不是猜

## 遗留 / 后续

- **测试污染真实配置**：`GuardHardening.test.js` 最初直接写用户 `~/.cuckoo/config.json`，
  用例间互相干扰。已改为每个用例设 `CUCKOO_HOME` 到 `test/tmp/` 隔离 + `afterEach` 还原。
  其他既有测试若也用 `writeConfig`，同样隐患（本次只修了自己新增的）。
- 未做：plan 模式"只读"强制、重复工具调用检测、每轮纪律注入（属另一批）。
- 未做：`read` 仍全量读文件（`readFileSync`）后才切窗口，大文件有浪费。
- 未做：台账不落盘，重启后首次编辑需重新 read（符合预期）。
