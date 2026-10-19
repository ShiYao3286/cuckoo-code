/**
 * Cuckoo Code 自动更新模块
 * 使用 electron-updater + generic provider（GitHub Releases）检查并下载更新。
 * 职责：检查更新、下载进度提示、下载完成提醒、网络错误友好提示。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import updaterPkg from 'electron-updater';

// electron 特殊：其 index.js 导出字符串，须用 createRequire（见 P3a 手册 1.5）
const require = createRequire(import.meta.url);
const { app, dialog, Notification } = require('electron');
const { autoUpdater } = updaterPkg;

// ========== 日志配置 ==========
// 打包版禁用文件日志持久化：不加载 electron-log，也不写文件
if (app.isPackaged) {
  autoUpdater.logger = console;
} else {
  const { default: log } = await import('electron-log');
  autoUpdater.logger = log;
  (autoUpdater.logger as any).transports.file.level = 'info';
}
autoUpdater.autoDownload = false; // 检测到更新后不自动下载，等用户确认
autoUpdater.autoInstallOnAppQuit = true; // 退出时自动安装（支持 NSIS）

// ========== 状态标志 ==========
let updateChecked = false;       // 是否已执行过检查
let updateDownloaded = false;    // 是否已下载完成
let isManualCheck = false;       // 是否是用户手动触发的检查
let mainWindowRef: any = null;   // 主窗口引用（用于弹出对话框）

/** 设置主窗口引用，用于对话框定位 */
function setMainWindow(win: any): void {
  mainWindowRef = win;
}

/** 判断错误是否为网络连接类问题 */
function isNetworkError(error: any): boolean {
  const msg = String(error && (error.message || error.stack) || '').toLowerCase();
  const networkKeywords = [
    'net::err',
    'err_connection',
    'err_name_not_resolved',
    'err_internet_disconnected',
    'err_network_changed',
    'err_proxy_connection_failed',
    'err_tunnel_connection_failed',
    'enotfound',
    'etimedout',
    'econnrefused',
    'econnreset',
    'cert_authority_invalid',
    'cert_common_name_invalid',
    'cert_date_invalid',
    'unable to resolve',
    'connect timeout',
    'network is unreachable',
    'socket hang up',
    'tls handshake',
  ];
  return networkKeywords.some((kw) => msg.includes(kw));
}

/** 判断错误是否为 GitHub 访问受限类问题 */
function isGitHubAccessError(error: any): boolean {
  const msg = String(error && (error.message || error.stack) || '').toLowerCase();
  const githubKeywords = [
    '403',
    '404',
    'rate limit',
    'api.github.com',
    'github',
    'forbidden',
    'unauthorized',
  ];
  return githubKeywords.some((kw) => msg.includes(kw));
}

/** 显示系统通知（不打断用户） */
function showNotification(title: string, body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

/** 弹出更新失败对话框，提供重试/取消选项 */
async function showUpdateErrorDialog(error: any, isManual: boolean): Promise<boolean> {
  // 自动检查失败时，静默提示即可，不弹对话框打扰用户
  if (!isManual) {
    const detail = isNetworkError(error) || isGitHubAccessError(error)
      ? '无法连接到更新服务器（GitHub），请检查网络连接。'
      : '发生未知错误，请稍后重试。';
    showNotification('检查更新失败', detail);
    return false; // 自动检查失败不弹对话框
  }

  // 手动检查失败时，弹出对话框并给出详细原因
  let message = '检查更新失败';
  let detail = '';
  if (isNetworkError(error)) {
    message = '无法连接到更新服务器';
    detail = '请检查网络连接。更新服务器位于 GitHub，可能需要代理或 VPN 才能访问。\n\n错误信息：' + (error.message || '');
  } else if (isGitHubAccessError(error)) {
    message = '无法访问 GitHub 更新服务器';
    detail = 'GitHub 访问受限或更新资源不存在。请确认仓库名称和发布版本正确。\n\n错误信息：' + (error.message || '');
  } else {
    detail = '发生未知错误。\n\n错误信息：' + (error.message || '');
  }

  const options: any = {
    type: 'error',
    title: '更新失败',
    message,
    detail,
    buttons: ['重试', '取消'],
    defaultId: 0,
    cancelId: 1,
  };
  const parent = mainWindowRef && !mainWindowRef.isDestroyed() ? mainWindowRef : null;
  // dialog.showMessageBox 在 macOS 上必须使用 parent 参数，否则弹窗可能被隐藏

  const result = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return result.response === 0; // 返回 true 表示用户点击了"重试"
}

/**
 * 是否为"绿色版/便携版"（zip 解压即用，没有 NSIS 安装器）。
 *
 * 判据：打包后运行，且没有安装标记文件——electron-builder 打包 NSIS 时会在
 * resources 旁写 `app-update.yml` 供更新器使用；更可靠的信号是安装版才有 uninstall 程序。
 * 这里用最稳的一条：**存在 `resources\app-update.yml` 且进程可执行文件旁有 Uninstall 程序**才算安装版；
 * 否则视为便携版。
 *
 * 便携版必须跳过自动更新：它没有安装器，quitAndInstall() 会去拉起一个不存在的 NSIS 包，
 * 表现为"点了更新没反应/报错"。绿色版更新方式应是重新下载 zip 覆盖。
 */
function isPortableBuild(): boolean {
  if (!app.isPackaged) return false;
  try {
    // electron-builder 的 "portable" 目标会注入该环境变量；zip 解压版没有
    if (process.env.PORTABLE_EXECUTABLE_DIR) return true;
    const exeDir = path.dirname(process.execPath);
    // 安装版在 exe 同目录有 Uninstall <ProductName>.exe；绿色版没有
    const hasUninstall = fs.existsSync(path.join(exeDir, 'Uninstall Cuckoo-Code.exe'));
    return !hasUninstall;
  } catch (_) {
    return false;
  }
}

/** 手动检查更新入口 */
async function checkForUpdates(): Promise<void> {
  if (isPortableBuild()) {
    const options = {
      type: 'info',
      title: '绿色版不支持自动更新',
      message: '当前是绿色版（解压即用）',
      detail: '绿色版没有安装器，无法自动覆盖更新。\n请到 Releases 页面下载新版 zip，解压后替换整个目录即可（配置文件在 %APPDATA%，不受影响）。',
      buttons: ['打开下载页', '知道了'],
      defaultId: 0,
      cancelId: 1,
    };
    const parent = mainWindowRef && !mainWindowRef.isDestroyed() ? mainWindowRef : null;
    const result = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    if (result.response === 0) {
      const { shell } = require('electron');
      try { shell.openExternal('https://github.com/ShiYao3286/cuckoo-code/releases/latest'); } catch (_) { /* ignore */ }
    }
    return;
  }

  if (updateDownloaded) {
    // 已有下载完成的更新，直接提示安装
    const options = {
      type: 'info',
      title: '更新已就绪',
      message: '新版本已下载完成',
      detail: '是否立即重启应用并安装更新？',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
    };
    const parent = mainWindowRef && !mainWindowRef.isDestroyed() ? mainWindowRef : null;
    const result = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
    return;
  }

  isManualCheck = true;
  updateChecked = false;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error: any) {
    console.error('[Updater] 检查更新异常:', error);
    await showUpdateErrorDialog(error, true);
  }
}

// ========== 注册 autoUpdater 事件 ==========

autoUpdater.on('checking-for-update', () => {
  console.log('[Updater] 正在检查更新...');
  if (isManualCheck) {
    showNotification('检查更新', '正在检查是否有新版本...');
  }
});

autoUpdater.on('update-available', async (info: any) => {
  console.log('[Updater] 发现新版本:', info.version);
  const options = {
    type: 'info',
    title: '发现新版本',
    message: '发现新版本 v' + info.version,
    detail: '是否现在下载更新？下载完成后可在退出时自动安装。',
    buttons: ['立即下载', '暂不下载'],
    defaultId: 0,
    cancelId: 1,
  };
  const parent = mainWindowRef && !mainWindowRef.isDestroyed() ? mainWindowRef : null;
  const result = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  if (result.response === 0) {
    showNotification('开始下载', '正在下载 v' + info.version + '...');
    autoUpdater.downloadUpdate().catch((err) => {
      console.error('[Updater] 下载失败:', err);
    });
  } else {
    isManualCheck = false;
  }
});

autoUpdater.on('update-not-available', () => {
  console.log('[Updater] 已是最新版本');
  if (isManualCheck) {
    showNotification('已是最新版本', '当前已是最新版本。');
  }
  isManualCheck = false;
});

autoUpdater.on('download-progress', (progressObj: any) => {
  const percent = Math.round(progressObj.percent);
  console.log('[Updater] 下载进度:', percent + '%');
  // 仅在手动检查时显示进度通知
  if (isManualCheck && percent % 10 === 0) {
    showNotification('下载更新中', '已下载 ' + percent + '%');
  }
});

autoUpdater.on('update-downloaded', (info: any) => {
  updateDownloaded = true;
  console.log('[Updater] 新版本已下载:', info.version);

  // 弹窗询问是否立即安装
  const options = {
    type: 'info',
    title: '更新已就绪',
    message: '新版本 v' + info.version + ' 已下载完成',
    detail: '是否立即重启应用并安装更新？',
    buttons: ['立即重启', '稍后'],
    defaultId: 0,
    cancelId: 1,
  };
  const parent = mainWindowRef && !mainWindowRef.isDestroyed() ? mainWindowRef : null;

  const dialogPromise = parent
    ? dialog.showMessageBox(parent, options)
    : dialog.showMessageBox(options);

  dialogPromise.then((result: any) => {
    isManualCheck = false;
    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });
});

autoUpdater.on('error', async (error: any) => {
  console.error('[Updater] 更新错误:', error);
  const shouldRetry = await showUpdateErrorDialog(error, isManualCheck);
  if (shouldRetry) {
    // 用户点击重试
    isManualCheck = true;
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        console.error('[Updater] 重试检查更新失败:', err);
        isManualCheck = false;
      });
    }, 1000);
  } else {
    isManualCheck = false;
  }
});

// ========== 启动时自动检查 ==========
function initAutoUpdater(win: any): void {
  setMainWindow(win);

  // 仅在生产环境（打包后）才检查更新
  if (!app.isPackaged) {
    console.log('[Updater] 开发环境，跳过自动检查更新');
    return;
  }

  // 绿色版（zip 解压即用）没有安装器，自动更新会失败；跳过并留给手动检查时的说明
  if (isPortableBuild()) {
    console.log('[Updater] 检测到绿色版，跳过自动更新（请手动下载新版 zip 覆盖）');
    return;
  }

  // 应用启动后延迟 5 秒检查，避免影响启动速度
  setTimeout(() => {
    console.log('[Updater] 启动自动检查更新');
    autoUpdater.checkForUpdates().catch((error: any) => {
      console.error('[Updater] 启动检查更新失败:', error);
    });
  }, 5000);
}

export {
  initAutoUpdater,
  checkForUpdates,
  setMainWindow,
  isNetworkError,
  isGitHubAccessError,
  isPortableBuild,
};
