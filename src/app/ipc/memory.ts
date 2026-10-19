/**
 * IPC：用户记忆（Memories）管理
 * 壳页面通过 window.shellAPI 调用：
 *  - list-memories    ：列出全部（含 scope）
 *  - save-memories    ：整体覆盖保存（批量导入用）
 *  - add-memory       ：新增一条（支持 scope）
 *  - update-memory    ：按 id 更新文本（035 起，避免整体覆盖丢数据）
 *  - delete-memory    ：删除一条
 *  - get/set-memories-enabled：功能开关
 */
import { createRequire } from 'node:module';
import * as windowState from '../window.js';
import { listMemories, saveMemories, addMemory, removeMemory, updateMemory } from '../../infra/memories.js';
import { isMemoriesEnabled, setMemoriesEnabled } from '../../infra/config.js';

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

/** 广播给所有窗口的壳页面，让它们刷新（多窗口同步） */
function broadcastChanged(): void {
  for (const ctx of windowState.getAllContexts()) {
    try {
      if (ctx && ctx.win && !ctx.win.isDestroyed()) {
        ctx.win.webContents.send('shell-memories-changed');
      }
    } catch (_) {}
  }
}

function registerMemoryIpc(): void {
  ipcMain.handle('list-memories', async () => {
    return { success: true, memories: listMemories() };
  });

  // 整体覆盖（批量导入 / 迁移用）。日常编辑请走 update-memory，避免并发覆盖丢数据。
  ipcMain.handle('save-memories', async (_event: any, { memories }: any) => {
    const r = saveMemories(memories);
    if (r.success) broadcastChanged();
    return {
      success: r.success,
      dropped: r.dropped,
      error: r.success ? null : '保存失败',
    };
  });

  ipcMain.handle('add-memory', async (_event: any, { text, scope }: any) => {
    const m = addMemory(text, scope);
    if (m) broadcastChanged();
    return { success: !!m, memory: m, error: m ? null : '内容为空' };
  });

  ipcMain.handle('update-memory', async (_event: any, { id, text }: any) => {
    const m = updateMemory(id, text);
    if (m) broadcastChanged();
    return { success: !!m, memory: m, error: m ? null : '更新失败（id 不存在或内容为空）' };
  });

  ipcMain.handle('delete-memory', async (_event: any, { id }: any) => {
    const ok = removeMemory(id);
    if (ok) broadcastChanged();
    return { success: ok, error: ok ? null : '记忆不存在' };
  });

  // AI 正文标记 [记忆]xxx 触发（记忆功能关闭时不捕获；标记只能记为用户级）
  ipcMain.handle('create-memory-marker', async (_event: any, { text }: any) => {
    if (!isMemoriesEnabled()) return { success: false, error: '记忆功能已关闭' };
    const m = addMemory(text, 'user');
    if (m) broadcastChanged();
    return { success: !!m, memory: m, error: m ? null : '内容为空' };
  });

  // 记忆功能开关（全局配置）
  ipcMain.handle('get-memories-enabled', async () => {
    return { success: true, enabled: isMemoriesEnabled() };
  });
  ipcMain.handle('set-memories-enabled', async (_event: any, { enabled }: any) => {
    const ok = setMemoriesEnabled(enabled === true);
    return { success: ok };
  });
}

export { registerMemoryIpc };
