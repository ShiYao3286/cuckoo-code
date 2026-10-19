/**
 * memories.json 的统一文件访问层（036 v2）
 *
 * 为什么需要这一层：
 *   v1 的文件是纯数组 `[{id, text, scope, ...}]`；
 *   v2 变成对象 `{ version, profile, savedMemories, meta }`。
 *   若 memories.ts（管 savedMemories）和 memory-profile.ts（管 profile）各自读写整个文件，
 *   会互相覆盖——所以把「读整个文件 / 写整个文件」收口到这里，双方只改自己那一块。
 *
 * 向后兼容：
 *   - 读：文件是数组 → 视为 v1，自动升级为 v2 结构（savedMemories = 原数组，profile 为空）
 *   - 写：永远写 v2 对象形式
 *   - 原子写：tmp + rename（沿用 035 的做法）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readJsonFile } from './json-file.js';

/** 画像的六个字段（都是字符串，projects 是对象） */
interface MemoryProfile {
  identity: string;
  communication: string;
  engineering: string;
  environment: string;
  /** 项目路径 → 该项目专属约定 */
  projects: Record<string, string>;
  notes: string;
}

/** 整理元信息（增量游标 + 上次整理时间） */
interface MemoryMeta {
  /** 上次整理覆盖到的最大 messageId；0 表示从未整理 */
  lastConsolidatedMessageId: number;
  /** 上次整理时间戳（ms）；0 表示从未整理 */
  lastConsolidatedAt: number;
  /** 上次用的模型名（排查用） */
  model: string;
}

/** memories.json 的完整结构（v2） */
interface MemoriesFile {
  version: 2;
  profile: MemoryProfile;
  savedMemories: any[];
  meta: MemoryMeta;
}

/** 空画像 */
function emptyProfile(): MemoryProfile {
  return {
    identity: '',
    communication: '',
    engineering: '',
    environment: '',
    projects: {},
    notes: '',
  };
}

/** 空元信息 */
function emptyMeta(): MemoryMeta {
  return { lastConsolidatedMessageId: 0, lastConsolidatedAt: 0, model: '' };
}

/** 用户级目录（可用 CUCKOO_HOME 覆盖，供测试隔离） */
function getUserDir(): string {
  const override = process.env.CUCKOO_HOME;
  return override ? override : path.join(os.homedir(), '.cuckoo');
}

function getMemoriesFilePath(): string {
  return path.join(getUserDir(), 'memories.json');
}

/**
 * 归一化画像：确保六个字段类型正确。
 * 容忍 LLM 输出不规范（如 projects 是数组、某字段缺失）。
 */
function normalizeProfile(raw: any): MemoryProfile {
  const base = emptyProfile();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const str = (v: any) => (typeof v === 'string' ? v : '');
  const projects: Record<string, string> = {};
  if (raw.projects && typeof raw.projects === 'object' && !Array.isArray(raw.projects)) {
    for (const k of Object.keys(raw.projects)) {
      const v = raw.projects[k];
      if (typeof k === 'string' && k && typeof v === 'string') projects[k] = v;
    }
  }
  return {
    identity: str(raw.identity),
    communication: str(raw.communication),
    engineering: str(raw.engineering),
    environment: str(raw.environment),
    projects,
    notes: str(raw.notes),
  };
}

/** 归一化元信息 */
function normalizeMeta(raw: any): MemoryMeta {
  const base = emptyMeta();
  if (!raw || typeof raw !== 'object') return base;
  return {
    lastConsolidatedMessageId: typeof raw.lastConsolidatedMessageId === 'number' ? raw.lastConsolidatedMessageId : 0,
    lastConsolidatedAt: typeof raw.lastConsolidatedAt === 'number' ? raw.lastConsolidatedAt : 0,
    model: typeof raw.model === 'string' ? raw.model : '',
  };
}

/**
 * 读整个文件（自动处理 v1 数组格式）。
 * 文件不存在 / 损坏时返回空结构（不抛异常，与 035 行为一致）。
 */
function readMemoriesFile(): MemoriesFile {
  const file = getMemoriesFilePath();
  try {
    if (!fs.existsSync(file)) {
      return { version: 2, profile: emptyProfile(), savedMemories: [], meta: emptyMeta() };
    }
    const raw = readJsonFile(file);
    // v1：纯数组 → 升级
    if (Array.isArray(raw)) {
      return { version: 2, profile: emptyProfile(), savedMemories: raw, meta: emptyMeta() };
    }
    // v2：对象
    if (raw && typeof raw === 'object') {
      return {
        version: 2,
        profile: normalizeProfile(raw.profile),
        savedMemories: Array.isArray(raw.savedMemories) ? raw.savedMemories : [],
        meta: normalizeMeta(raw.meta),
      };
    }
  } catch (err: any) {
    console.error('[MemoriesFile] 读取失败:', err.message);
  }
  return { version: 2, profile: emptyProfile(), savedMemories: [], meta: emptyMeta() };
}

/**
 * 写整个文件（原子写）。
 * @returns { success, error? }
 */
function writeMemoriesFile(data: MemoriesFile): { success: boolean; error?: string } {
  const file = getMemoriesFilePath();
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  try {
    const payload = {
      version: 2,
      profile: data.profile,
      savedMemories: data.savedMemories,
      meta: data.meta,
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    return { success: true };
  } catch (err: any) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return { success: false, error: err.message };
  }
}

export {
  readMemoriesFile, writeMemoriesFile, getMemoriesFilePath,
  emptyProfile, emptyMeta, normalizeProfile, normalizeMeta,
};
export type { MemoryProfile, MemoryMeta, MemoriesFile };
