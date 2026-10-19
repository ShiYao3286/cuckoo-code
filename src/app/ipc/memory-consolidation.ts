/**
 * IPC：记忆整理（036）
 *
 * 通道：
 *   - memory-consolidation-status   查状态（是否可用 / 有没有 Key / 上次整理时间）
 *   - memory-consolidation-preview  触发整理，返回预览（不写盘）
 *   - memory-consolidation-apply    用户确认后落盘
 *   - memory-consolidation-rollback 回滚到整理前（从 .bak）
 *   - memory-set-llm-config         设置 LLM 端点 / 模型
 *   - memory-set-api-key            保存 API Key（加密）
 *   - memory-clear-api-key          清除 API Key
 *   - memory-get-profile            读当前画像
 */
import { createRequire } from 'node:module';
import { previewConsolidation } from '../../session/memory-consolidation.js';
import { readProfile, writeProfile, clearProfile } from '../../infra/memory-profile.js';
import { readMeta } from '../../infra/memory-profile.js';
import { isMemoryConsolidationEnabled, getMemoryLlmConfig, writeConfig, readConfig } from '../../infra/config.js';
import { saveMemoryApiKey, hasMemoryApiKey, clearMemoryApiKey } from '../memory-credentials.js';
import { getMemoriesFilePath } from '../../infra/memories-file.js';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

/** 整理前的备份路径 */
function backupPath(): string {
  return getMemoriesFilePath() + '.bak';
}

/** 落盘前备份当前 memories.json */
function backupCurrent(): { success: boolean; error?: string } {
  try {
    const src = getMemoriesFilePath();
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, backupPath());
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err && err.message ? err.message : String(err) };
  }
}

function registerMemoryConsolidationIpc(): void {
  // 状态查询
  ipcMain.handle('memory-consolidation-status', async () => {
    const cfg = readConfig();
    const meta = readMeta();
    return {
      success: true,
      enabled: isMemoryConsolidationEnabled(),
      llmConfigured: !!getMemoryLlmConfig(),
      hasApiKey: hasMemoryApiKey(),
      baseUrl: cfg.memoryLlmBaseUrl,
      model: cfg.memoryLlmModel,
      lastConsolidatedAt: meta.lastConsolidatedAt,
      lastConsolidatedMessageId: meta.lastConsolidatedMessageId,
      lastModel: meta.model,
    };
  });

  // 触发整理（预览，不写盘）
  ipcMain.handle('memory-consolidation-preview', async () => {
    return await previewConsolidation();
  });

  // 用户确认后落盘
  ipcMain.handle('memory-consolidation-apply', async (_e: any, { profile, maxMessageId, model }: any) => {
    const backup = backupCurrent();
    if (!backup.success) {
      return { success: false, error: '备份失败: ' + backup.error };
    }
    const w = writeProfile(profile, {
      lastConsolidatedMessageId: typeof maxMessageId === 'number' ? maxMessageId : 0,
      lastConsolidatedAt: Date.now(),
      model: typeof model === 'string' ? model : '',
    });
    return w;
  });

  // 回滚
  ipcMain.handle('memory-consolidation-rollback', async () => {
    try {
      const bak = backupPath();
      if (!fs.existsSync(bak)) {
        return { success: false, error: '没有可回滚的备份' };
      }
      fs.copyFileSync(bak, getMemoriesFilePath());
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  });

  // 读当前画像
  ipcMain.handle('memory-get-profile', async () => {
    return { success: true, profile: readProfile() };
  });

  // 清空画像
  ipcMain.handle('memory-clear-profile', async () => {
    const backup = backupCurrent();
    if (!backup.success) return { success: false, error: '备份失败: ' + backup.error };
    return clearProfile();
  });

  // 设置 LLM 端点 / 模型 / 开关
  ipcMain.handle('memory-set-llm-config', async (_e: any, { baseUrl, model, enabled }: any) => {
    const ok = writeConfig({
      memoryLlmBaseUrl: typeof baseUrl === 'string' ? baseUrl.trim() : '',
      memoryLlmModel: typeof model === 'string' ? model.trim() : '',
      memoryConsolidationEnabled: enabled === true,
    });
    return { success: ok };
  });

  // 保存 API Key
  ipcMain.handle('memory-set-api-key', async (_e: any, { key }: any) => {
    return saveMemoryApiKey(String(key || ''));
  });

  // 清除 API Key
  ipcMain.handle('memory-clear-api-key', async () => {
    return clearMemoryApiKey();
  });
}

export { registerMemoryConsolidationIpc };
