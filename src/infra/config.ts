/**
 * 全局用户配置（~/.cuckoo/config.json）
 *
 * 存储跨项目、跨窗口的用户级配置。可用 CUCKOO_HOME 覆盖（测试隔离）。
 * 首次读取文件不存在时返回默认值（不写文件）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface UserConfig {
  /** 是否启用用户记忆功能（默认 false） */
  memoriesEnabled: boolean;
  /**
   * 是否启用 read-before-edit 文件观察护栏（默认 true）。
   * 关闭后 edit/write 恢复无条件执行（旧行为），用于排除误伤或调试。
   */
  fsGuardEnabled: boolean;
}

const DEFAULT_CONFIG: UserConfig = {
  memoriesEnabled: false,
  fsGuardEnabled: true,
};

/** 用户级目录（可用 CUCKOO_HOME 覆盖，供测试隔离） */
function getUserDir(): string {
  const override = process.env.CUCKOO_HOME;
  return override ? override : path.join(os.homedir(), '.cuckoo');
}

function getConfigFile(): string {
  return path.join(getUserDir(), 'config.json');
}

/** 读取全局配置（文件不存在或损坏时返回默认值） */
function readConfig(): UserConfig {
  const file = getConfigFile();
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (raw && typeof raw === 'object') {
        return {
          memoriesEnabled: raw.memoriesEnabled === true,
          // 默认开：只有显式 false 才关闭（旧配置文件无此字段时保持启用）
          fsGuardEnabled: raw.fsGuardEnabled !== false,
        };
      }
    }
  } catch (err: any) {
    console.error('[Config] 读取失败:', err.message);
  }
  return { ...DEFAULT_CONFIG };
}

/** 写入全局配置（与现有合并后整体覆盖） */
function writeConfig(cfg: Partial<UserConfig>): boolean {
  const file = getConfigFile();
  try {
    const merged = { ...readConfig(), ...cfg };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(merged, null, 2), 'utf-8');
    return true;
  } catch (err: any) {
    console.error('[Config] 写入失败:', err.message);
    return false;
  }
}

/** 记忆功能是否启用（默认关闭） */
function isMemoriesEnabled(): boolean {
  return readConfig().memoriesEnabled === true;
}

/** 设置记忆功能开关 */
function setMemoriesEnabled(enabled: boolean): boolean {
  return writeConfig({ memoriesEnabled: enabled === true });
}

/** read-before-edit 护栏是否启用（默认启用） */
function isFsGuardEnabled(): boolean {
  return readConfig().fsGuardEnabled !== false;
}

/** 设置护栏开关 */
function setFsGuardEnabled(enabled: boolean): boolean {
  return writeConfig({ fsGuardEnabled: enabled !== false });
}

/**
 * 已启用的工具功能分组（用于注入对应的 API 契约文件 api.<feature>.d.ts）。
 * 目前仅 'memories'。
 */
function getEnabledToolFeatures(): string[] {
  const feats: string[] = [];
  if (isMemoriesEnabled()) feats.push('memories');
  return feats;
}

export {
  readConfig, writeConfig,
  isMemoriesEnabled, setMemoriesEnabled,
  isFsGuardEnabled, setFsGuardEnabled,
  getEnabledToolFeatures, getConfigFile,
};
