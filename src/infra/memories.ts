/**
 * 用户记忆（Memories）管理
 *
 * 存储：~/.cuckoo/memories.json（用户级，所有项目通用文件）
 * 可用环境变量 CUCKOO_HOME 覆盖（测试隔离）。
 *
 * 数据模型：
 *   { id, text, scope, createdAt, updatedAt }
 *
 * 作用域（scope）：
 *   - 'user'  ：全局记忆，所有项目都注入
 *   - 绝对路径：项目记忆，仅该项目注入（路径经过规范化，见 normalizeProjectPath）
 *
 * 写入采用「临时文件 + rename」原子替换：同盘 rename 是原子操作，
 * 避免崩溃/断电/磁盘满时把 memories.json 写成半截 JSON，导致下次读取全部丢失。
 *
 * 首次读取时若文件不存在，返回空数组（不写默认）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isMemoriesEnabled } from './config.js';
import { readMemoriesFile, writeMemoriesFile } from './memories-file.js';
import { readProfile } from './memory-profile.js';

/** 全局作用域的固定值 */
const SCOPE_USER = 'user';

export interface Memory {
  id: string;
  text: string;
  /** 'user' 或规范化后的项目绝对路径 */
  scope: string;
  createdAt: number;
  updatedAt: number;
}

/** 用户级目录（可用 CUCKOO_HOME 覆盖，供测试隔离） */
function getUserDir(): string {
  const override = process.env.CUCKOO_HOME;
  return override ? override : path.join(os.homedir(), '.cuckoo');
}

function getMemoriesFile(): string {
  return path.join(getUserDir(), 'memories.json');
}

/**
 * 规范化项目路径（用于 scope 匹配与持久化）。
 * - 绝对路径
 * - 统一正斜杠（避免 Windows 上 \ 与 / 混用导致匹配失败）
 * - Windows 下转小写（盘符与目录名大小写不敏感）
 */
function normalizeProjectPath(p: string): string {
  if (!p || typeof p !== 'string') return '';
  let out = path.resolve(p).replace(/\\/g, '/');
  if (process.platform === 'win32') out = out.toLowerCase();
  return out;
}

/**
 * 归一化 scope 值：
 * - 缺省 / 空 / 'user' -> 'user'
 * - 其他 -> 当作项目路径规范化
 */
function normalizeScope(raw: any): string {
  if (raw === SCOPE_USER || raw === undefined || raw === null || raw === '') return SCOPE_USER;
  const s = String(raw);
  if (s === SCOPE_USER) return SCOPE_USER;
  return normalizeProjectPath(s);
}

/** 校验并规整单条记忆 */
function normalizeMemory(raw: any): Memory | null {
  if (!raw || typeof raw !== 'object') return null;
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) return null;
  const now = Date.now();
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : 'mem-' + now + '-' + Math.random().toString(36).slice(2, 8),
    text,
    scope: normalizeScope(raw.scope),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
  };
}

/**
 * 读取全部记忆（从 v2 文件的 savedMemories 字段）。
 * v1 数组格式由 memories-file 层自动升级。
 */
function readAll(): Memory[] {
  const file = readMemoriesFile();
  return file.savedMemories.map(normalizeMemory).filter(Boolean) as Memory[];
}

/**
 * 整体覆盖写入 savedMemories（不动 profile / meta）。
 * @returns { success, dropped } —— dropped 是被丢弃的非法项数（text 为空、非对象等），
 *          让 UI 能提示「已保存 N 条，跳过 M 条无效项」，而不是静默丢数据。
 */
function saveMemories(list: any): { success: boolean; dropped: number } {
  try {
    const arr = Array.isArray(list) ? list : [];
    const clean = arr.map(normalizeMemory).filter(Boolean) as Memory[];
    const file = readMemoriesFile();
    file.savedMemories = clean;
    const w = writeMemoriesFile(file);
    if (!w.success) {
      console.error('[Memories] 写入失败:', w.error);
      return { success: false, dropped: 0 };
    }
    console.log('[Memories] 已写入 savedMemories，共', clean.length, '条');
    return { success: true, dropped: arr.length - clean.length };
  } catch (err: any) {
    console.error('[Memories] 写入失败:', err.message);
    return { success: false, dropped: 0 };
  }
}

/** 单条记忆最大字符数（超出截断，防 prompt 膨胀） */
const MAX_MEMORY_LEN = 500;
/** 注入提示词的记忆章节总长上限（字符） */
const MAX_SECTION_LEN = 4000;
/** 记忆条数上限（超出时丢弃最旧的） */
const MAX_MEMORIES = 200;

/**
 * 列出记忆。
 * @param opts.scope 若给出，只返回该作用域（'user' 或项目路径）的记忆；缺省返回全部。
 */
function listMemories(opts?: { scope?: string }): Memory[] {
  const all = readAll();
  if (!opts || !opts.scope) return all;
  const target = normalizeScope(opts.scope);
  return all.filter((m) => m.scope === target);
}

/**
 * 列出「给某项目用」的记忆：用户级 + 该项目级。
 * @param projectDir 项目目录；为空时只返回用户级
 */
function listMemoriesForProject(projectDir: string | null | undefined): Memory[] {
  const all = readAll();
  if (!projectDir) return all.filter((m) => m.scope === SCOPE_USER);
  const target = normalizeProjectPath(projectDir);
  return all.filter((m) => m.scope === SCOPE_USER || m.scope === target);
}

/**
 * 新增一条记忆。
 * @param text 内容
 * @param scope 'user'（默认）或项目路径
 * @returns 新记忆 / 已存在的同内容记忆 / null（内容为空）
 */
function addMemory(text: string, scope?: string): Memory | null {
  let t = typeof text === 'string' ? text.trim() : '';
  if (!t) return null;
  if (t.length > MAX_MEMORY_LEN) t = t.slice(0, MAX_MEMORY_LEN);
  const sc = normalizeScope(scope);

  const list = readAll();
  // 去重：同作用域 + 同内容不重复添加
  const existing = list.find((m) => m.text === t && m.scope === sc);
  if (existing) return existing;

  const now = Date.now();
  const mem: Memory = {
    id: 'mem-' + now + '-' + Math.random().toString(36).slice(2, 8),
    text: t,
    scope: sc,
    createdAt: now,
    updatedAt: now,
  };
  list.push(mem);
  // 超上限时按 createdAt 升序一次性裁剪（原先 while 循环里反复 sort 是浪费）
  if (list.length > MAX_MEMORIES) {
    list.sort((a, b) => a.createdAt - b.createdAt);
    list.splice(0, list.length - MAX_MEMORIES);
  }
  const w = saveMemories(list);
  return w.success ? mem : null;
}

/** 按 id 删除一条记忆 */
function removeMemory(id: string): boolean {
  const list = readAll();
  const next = list.filter((m) => m.id !== id);
  if (next.length === list.length) return false;
  return saveMemories(next).success;
}

/** 按 id 更新一条记忆（保留 id / createdAt / scope，更新 text 与 updatedAt） */
function updateMemory(id: string, text: string): Memory | null {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return null;
  const list = readAll();
  const idx = list.findIndex((m) => m.id === id);
  if (idx < 0) return null;
  const next = list.slice();
  next[idx] = {
    ...next[idx],
    text: t.length > MAX_MEMORY_LEN ? t.slice(0, MAX_MEMORY_LEN) : t,
    updatedAt: Date.now(),
  };
  return saveMemories(next).success ? next[idx] : null;
}

/** 画像字段的中文标题（用于注入时的分节显示） */
const PROFILE_LABELS: Array<{ key: keyof import('./memories-file.js').MemoryProfile; label: string }> = [
  { key: 'identity', label: '身份' },
  { key: 'communication', label: '沟通偏好' },
  { key: 'engineering', label: '工程习惯' },
  { key: 'environment', label: '环境' },
  { key: 'notes', label: '其他' },
];

/**
 * 构建注入提示词的「用户记忆」章节。
 *
 * 036 起注入两块内容（按优先级）：
 *   1. **画像**（LLM 重写的结构化段落）—— 信息密度高，放前面
 *   2. **硬事实**（用户/AI 明确记的 savedMemories）—— 用户原话，优先级最高
 *
 * 为什么硬事实放后面但标「务必遵循」：画像可能是推断，硬事实是用户明说的，冲突时以硬事实为准。
 *
 * @param projectDir 当前项目目录；给出时会追加该项目的记忆与项目画像
 * @returns 章节文本；无内容或功能关闭时返回空串
 */
function buildMemorySection(projectDir?: string | null): string {
  if (!isMemoriesEnabled()) return '';

  const sections: string[] = [];

  // ---- 1. 画像 ----
  let profile: any = null;
  try {
    profile = readProfile();
  } catch (err: any) {
    console.warn('[Memories] 读取画像失败:', err && err.message);
  }

  if (profile) {
    const profileLines: string[] = [];
    for (const { key, label } of PROFILE_LABELS) {
      const v = profile[key];
      if (typeof v === 'string' && v.trim()) {
        profileLines.push('- **' + label + '**：' + v.replace(/\n/g, ' '));
      }
    }
    // 项目画像：只取当前项目的
    if (projectDir && profile.projects && typeof profile.projects === 'object') {
      const norm = normalizeProjectPath(projectDir);
      for (const [k, v] of Object.entries(profile.projects)) {
        if (typeof v === 'string' && v.trim() && normalizeProjectPath(k) === norm) {
          profileLines.push('- **本项目约定**：' + v.replace(/\n/g, ' '));
        }
      }
    }
    if (profileLines.length > 0) {
      sections.push([
        '### 用户画像',
        '',
        '以下是从历史对话中归纳的画像，供理解用户背景（如与用户明说的冲突，以明说的为准）：',
        '',
        profileLines.join('\n'),
      ].join('\n'));
    }
  }

  // ---- 2. 硬事实 ----
  const list = projectDir ? listMemoriesForProject(projectDir) : readAll().filter((m) => m.scope === SCOPE_USER);
  if (list.length > 0) {
    const lines = list.map((m) => {
      const tag = m.scope === SCOPE_USER ? '' : '（本项目）';
      return '- ' + tag + m.text.replace(/\n/g, ' ');
    });

    // 按条截断（而非按字符硬切）
    const kept: string[] = [];
    let total = 0;
    let omitted = 0;
    for (const line of lines) {
      if (total + line.length + 1 > MAX_SECTION_LEN) {
        omitted += 1;
        continue;
      }
      kept.push(line);
      total += line.length + 1;
    }
    let body = kept.join('\n');
    if (omitted > 0) {
      body += '\n- ...（另有 ' + omitted + ' 条记忆未展示，可让用户到侧边栏「记忆」页查看）';
    }
    sections.push([
      '### 用户明确要求记住的事实',
      '',
      '以下条目是用户或 AI 明确要求记住的，**务必遵循**：',
      '',
      body,
    ].join('\n'));
  }

  if (sections.length === 0) return '';

  return [
    '## 用户记忆',
    '',
    sections.join('\n\n'),
  ].join('\n');
}

export {
  SCOPE_USER,
  listMemories, listMemoriesForProject, saveMemories, addMemory, removeMemory, updateMemory,
  buildMemorySection, getMemoriesFile, normalizeProjectPath,
};
