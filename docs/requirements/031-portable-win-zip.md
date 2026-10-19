---
id: 031
type: feature
title: Windows 绿色版（zip 解压即用）
status: review
branch: feat/031-portable-win-zip
created: 2026-10-19
updated: 2026-10-19
---

## 背景

用户诉求："有 win 的绿色版吗？解压即用"。

此前 `build.win.target` 只有 `["nsis"]`，Releases 里只有安装包，没有免安装版本。

顺带发现一个**真 bug**：`updater.initAutoUpdater` 只判断 `app.isPackaged`，没有绿色版概念。
绿色版没有 NSIS 安装器，`autoUpdater.quitAndInstall()` 会去拉起一个不存在的安装包——
表现为"点了更新没反应/报错"，且启动 5 秒后还会自动检查一次，对绿色版用户是无效网络请求。

## 目标

1. Releases 同时产出 `cuckoo-code-win-v<version>-x64.zip`（解压即用）
2. 绿色版**跳过**自动更新，改为提示手动下载覆盖
3. 安装包与绿色版**不撞名**，CI 能各自上传发布

## 方案

### 1. 构建目标（package.json）

```json
"win": { "target": ["nsis", "zip"], "artifactName": "cuckoo-code-win-v${version}-${arch}.${ext}" }
```

命名区分靠现成的两套模板：
- 安装包走 `nsis.artifactName` → `cuckoo-code-win-v0.8.20.exe`（无 arch）
- 绿色版走 `win.artifactName` → `cuckoo-code-win-v0.8.20-x64.zip`（有 arch）

**CI 无需改动**：`release.yml` 的 upload-artifact（第 61 行）与发布 files（第 93 行）本来就包含
`dist/*.zip`——之前只是没有 zip 产物可传。

### 2. 绿色版判定（src/updater/index.ts）

新增 `isPortableBuild()`，判据：
1. 未打包 → false（开发环境）
2. `PORTABLE_EXECUTABLE_DIR` 存在 → true（electron-builder portable 目标注入）
3. 打包后 exe 同目录**没有** `Uninstall Cuckoo-Code.exe` → true（zip 解压版）

接入两处：
- `initAutoUpdater`：绿色版直接跳过启动自动检查（省掉无效请求与失败日志）
- `checkForUpdates`（手动检查）：绿色版弹说明框，给「打开下载页」按钮，说明配置在 `%APPDATA%` 不受影响

## 验收标准

- [x] `npm run build:win:local` 产出 `cuckoo-code-win-v0.8.16-x64.zip`（187.9 MB，本地实测）
- [x] zip 结构可解压即用：`Cuckoo-Code.exe` 在**根目录**；`resources/app.asar`、`app-update.yml`、
      `tools/cuckoo-tools.d.ts` 齐全
- [x] 绿色版判定 4 种情形有单测（开发/portable 环境变量/无 Uninstall/有 Uninstall）
- [x] 命名不撞名的渲染单测（安装包 `-win-v0.8.20.exe` vs 绿色版 `-win-v0.8.20-x64.zip`）
- [x] CI 上传与发布都覆盖 `dist/*.zip` 的断言
- [x] typecheck 绿；全量 95 files / 944 tests 通过
- [ ] 云端 v0.8.20 产出并发布 zip 后，实测解压即用 + 手动检查更新的提示文案

## 遗留 / 后续

- **本地构建的 zip 缺 `resources/runtime`**：本地没跑 `scripts/fetch-runtime.mjs`。CI 第 47-48 行有该步骤，
  云端产物会带。本地验证绿色版 MCP 运行时前需先 `npm run fetch-runtime`。
- 绿色版的数据仍写 `%APPDATA%\cuckoo-ai-pro-session`（与安装版共用）。若要做"真正便携"（配置随身带），
  需支持 `CUCKOO_SESSION_DIR` 指向 exe 同目录——`entry.ts:27` 已支持该环境变量，但还没有"自动检测便携位置"的逻辑，
  属独立需求。
- 本机 `build:win:local` 的 NSIS 阶段必然失败（`ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`，
  疑与 `E:\ai处理文件` 中文路径有关），所以本地只能验证 zip，安装包以云端为准。
