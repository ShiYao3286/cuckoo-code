/**
 * 全局用户配置（~/.cuckoo/config.json）
 *
 * 存储跨项目、跨窗口的用户级配置。可用 CUCKOO_HOME 覆盖（测试隔离）。
 * 首次读取文件不存在时返回默认值（不写文件）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readJsonFile } from './json-file.js';

export interface UserConfig {
  /** 是否启用用户记忆功能（默认 false） */
  memoriesEnabled: boolean;
  /**
   * 是否启用 read-before-edit 文件观察护栏（默认 true）。
   * 关闭后 edit/write 恢复无条件执行（旧行为），用于排除误伤或调试。
   */
  fsGuardEnabled: boolean;
  /**
   * 连续多少次相同工具调用后给"别重复"提醒（默认 3）。
   * 0 或负数 = 关闭提醒。
   */
  repeatCallThreshold: number;
  /**
   * 记忆整理用的 LLM 端点（036）。空串 = 未配置，整理功能不可用。
   * OpenAI 兼容格式，如 "https://open.bigmodel.cn/api/paas/v4"。
   */
  memoryLlmBaseUrl: string;
  /** 记忆整理用的模型名，如 "glm-4-plus"。 */
  memoryLlmModel: string;
  /**
   * 是否启用记忆整理（默认 false）。
   * 需要先配好 memoryLlmBaseUrl + memoryLlmModel + API Key（Key 存 safeStorage，不在此文件）。
   */
  memoryConsolidationEnabled: boolean;
}

const DEFAULT_CONFIG: UserConfig = {
  memoriesEnabled: false,
  fsGuardEnabled: true,
  repeatCallThreshold: 3,
  memoryLlmBaseUrl: '',
  memoryLlmModel: '',
  memoryConsolidationEnabled: false,
};

/** 用户级目录（可用 CUCKOO_HOME 覆盖，供测试隔离） */
function getUserDir(): string {
  const override = process.env.CUCKOO_HOME;
  return override ? override : path.join(os.homedir(), '.cuckoo');
}

function getConfigFile(): string {
  return path.join(getUserDir(), 'config.json');
}

/**
 * 配置缓存：按 (mtimeMs, size) 失效。
 * 为什么需要：edit/write 每次调用都要判断护栏是否启用，而 readConfig 是同步读盘 + JSON.parse。
 * 一个脚本里连续改 N 个文件就是 N 次读盘（Windows 上还有杀软扫描开销），纯属浪费。
 *
 * 为什么同时看 size：实测本机 200 次快速连写中有 2% 的 mtime 完全相同（文件系统时钟粒度），
 * 只靠 mtime 会漏判。带上 size 后，长度变了的改动必然失效；等长改动的漏判概率极低，
 * 且配置项都是布尔开关，`true`/`false` 长度不同，实际不会漏。
 * writeConfig 自身也会强制清缓存，保证本进程写入立即可见。
 */
let configCache: { mtimeMs: number; size: number; file: string; value: UserConfig } | null = null;

/** 读取全局配置（文件不存在或损坏时返回默认值；带 mtime+size 缓存） */
function readConfig(): UserConfig {
  const file = getConfigFile();
  try {
    if (fs.existsSync(file)) {
      const st = fs.statSync(file);
      if (configCache && configCache.file === file
        && configCache.mtimeMs === st.mtimeMs && configCache.size === st.size) {
        return configCache.value;
      }
      // readJsonFile 会剥掉 UTF-8 BOM（Windows 编辑器常见，否则 JSON.parse 直接失败）
      const raw = readJsonFile(file);
      if (raw && typeof raw === 'object') {
        const value: UserConfig = {
          memoriesEnabled: raw.memoriesEnabled === true,
          // 默认开：只有显式 false 才关闭（旧配置文件无此字段时保持启用）
          fsGuardEnabled: raw.fsGuardEnabled !== false,
          repeatCallThreshold: Number.isFinite(raw.repeatCallThreshold)
            ? Math.round(raw.repeatCallThreshold)
            : DEFAULT_CONFIG.repeatCallThreshold,
          memoryLlmBaseUrl: typeof raw.memoryLlmBaseUrl === 'string' ? raw.memoryLlmBaseUrl : '',
          memoryLlmModel: typeof raw.memoryLlmModel === 'string' ? raw.memoryLlmModel : '',
          memoryConsolidationEnabled: raw.memoryConsolidationEnabled === true,
        };
        configCache = { mtimeMs: st.mtimeMs, size: st.size, file, value };
        return value;
      }
    }
    configCache = null;
  } catch (err: any) {
    console.error('[Config] 读取失败:', err.message);
    configCache = null;
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
    configCache = null; // 写后失效，避免读到旧值
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
 * 重复调用提醒阈值（连续 N 次相同调用后提醒）。
 * <=0 表示关闭提醒。
 */
function getRepeatCallThreshold(): number {
  const v = readConfig().repeatCallThreshold;
  return Number.isFinite(v) ? v : 3;
}

/** 设置重复调用提醒阈值 */
function setRepeatCallThreshold(n: number): boolean {
  const v = Number.isFinite(n) ? Math.round(n) : 3;
  return writeConfig({ repeatCallThreshold: v });
}

/**
 * 记忆整理是否可用（036）。
 * 三个条件缺一不可：功能开关打开 + 配了 baseUrl + 配了 model。
 * API Key 不在 config.json 里（存 safeStorage），由调用方另行检查。
 */
function isMemoryConsolidationEnabled(): boolean {
  const c = readConfig();
  return c.memoryConsolidationEnabled === true
    && !!c.memoryLlmBaseUrl
    && !!c.memoryLlmModel;
}

/** 取记忆整理的 LLM 配置（未配全时返回 null） */
function getMemoryLlmConfig(): { baseUrl: string; model: string } | null {
  const c = readConfig();
  if (!c.memoryLlmBaseUrl || !c.memoryLlmModel) return null;
  return { baseUrl: c.memoryLlmBaseUrl, model: c.memoryLlmModel };
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
  getRepeatCallThreshold, setRepeatCallThreshold,
  getEnabledToolFeatures, getConfigFile,
  isMemoryConsolidationEnabled, getMemoryLlmConfig,
};
