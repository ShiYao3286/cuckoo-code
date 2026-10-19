/**
 * 用户画像（036）
 *
 * 画像是一个结构化段落集合，由 LLM 从对话历史里「重写」得出（非追加）。
 * 与 savedMemories 的区别：
 *   - savedMemories：用户/AI 明确说「记住这个」的硬事实，逐条追加
 *   - profile：LLM 归纳出的连贯画像，每次整理整体重写
 *
 * 本模块只负责「读写画像」，不负责调 LLM（那是 consolidator 的事）。
 */
import {
  readMemoriesFile, writeMemoriesFile,
  emptyProfile, emptyMeta, normalizeProfile,
} from './memories-file.js';
import type { MemoryProfile, MemoryMeta } from './memories-file.js';

/** 读取当前画像（无则返回空画像） */
function readProfile(): MemoryProfile {
  return readMemoriesFile().profile;
}

/** 读取整理元信息 */
function readMeta(): MemoryMeta {
  return readMemoriesFile().meta;
}

/**
 * 整体覆盖画像（不动 savedMemories）。
 * 这是整理管道写回的唯一入口。
 * @param profile 新画像（会被归一化，容忍不规范字段）
 * @param meta 可选的元信息更新（如新的增量游标）
 */
function writeProfile(profile: any, meta?: Partial<MemoryMeta>): { success: boolean; error?: string } {
  const file = readMemoriesFile();
  file.profile = normalizeProfile(profile);
  if (meta) {
    file.meta = {
      lastConsolidatedMessageId: typeof meta.lastConsolidatedMessageId === 'number'
        ? meta.lastConsolidatedMessageId : file.meta.lastConsolidatedMessageId,
      // 整理成功即记录时间：未显式传入时自动填当前时间
      lastConsolidatedAt: typeof meta.lastConsolidatedAt === 'number'
        ? meta.lastConsolidatedAt : Date.now(),
      model: typeof meta.model === 'string' ? meta.model : file.meta.model,
    };
  }
  return writeMemoriesFile(file);
}

/** 清空画像（保留 savedMemories） */
function clearProfile(): { success: boolean; error?: string } {
  const file = readMemoriesFile();
  file.profile = emptyProfile();
  file.meta = emptyMeta();
  return writeMemoriesFile(file);
}

/** 是否有实质内容（六个字段里任一非空） */
function hasProfileContent(profile?: MemoryProfile): boolean {
  const p = profile || readProfile();
  if (p.identity || p.communication || p.engineering || p.environment || p.notes) return true;
  return Object.keys(p.projects || {}).length > 0;
}

export {
  readProfile, readMeta, writeProfile, clearProfile, hasProfileContent,
};
