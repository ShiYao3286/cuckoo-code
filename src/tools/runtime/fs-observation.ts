/**
 * 文件观察台账（read-before-edit 护栏的真相源）
 *
 * 移植自 DSH 的 @deepseek-ai/dsh-fs-observation-policy：
 * 该策略包不是工具，而是三个瀑布事件（fs/write-intent / fs/edit-intent / fs/observed）的监听器，
 * 记录"某会话最近权威观察到的文件版本"，并据此决定：
 *   - edit：未观察到 → 拒绝（NOT_OBSERVED）；版本已变 → 拒绝（STALE_VERSION）
 *   - write：未观察到但文件已存在 → 拒绝（NOT_OBSERVED，防盲覆盖）
 *
 * Cuckoo 没有 DSH 的事件总线（tools 层不发瀑布事件），故改为工具直接调用本模块的显式接口，
 * 语义等价。台账为**主进程内存**（与 rules/injection.ts 同款做法）：应用重启即清空，够用——
 * 重启后模型第一次编辑会被要求先 read，这正是我们想要的行为。
 *
 * 版本代理：mtimeMs + size + ino。不用内容哈希是权衡后的选择：
 * 护栏要挡的是"模型凭记忆盲改"和"外部改动后仍按旧内容改"，时间戳足以覆盖这两类；
 * 同毫秒内的等长原地修改会被漏判，但那不是本护栏的目标场景。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

/** 一次权威观察：文件在那一刻的版本 */
interface Observation {
  /** 版本代理串（mtimeMs:size:ino） */
  version: string;
  /** 记录时间（诊断用） */
  at: number;
}

/** 内容指纹取样长度：取首尾各 4KB 拼 size，覆盖绝大多数"等长原地改写" */
const FINGERPRINT_BYTES = 4096;

/**
 * 计算内容指纹（首 4KB + 尾 4KB + size 的 sha1 前 12 位）。
 * 为什么不能只用 mtime：实测同一毫秒内、等长的内容替换，mtime/size/ino 三者完全不变
 * （`AAAA` → `BBBB`，4 字节 → 4 字节），只靠 stat 会漏判。
 * 只读首尾是权衡：护栏目标是挡住"外部改动后仍按旧内容写"，不需要密码学强度，
 * 也不必为一个 50MB 的文件算全量哈希。
 */
function contentFingerprint(absPath: string, size: number): string {
  try {
    const len = Math.min(FINGERPRINT_BYTES, size);
    const parts: Buffer[] = [];
    if (len > 0) {
      const head = Buffer.alloc(len);
      const fd = fs.openSync(absPath, 'r');
      fs.readSync(fd, head, 0, len, 0);
      parts.push(head);
      const tailStart = Math.max(0, size - FINGERPRINT_BYTES);
      if (tailStart >= len) {
        const tail = Buffer.alloc(size - tailStart);
        fs.readSync(fd, tail, 0, size - tailStart, tailStart);
        parts.push(tail);
      }
      fs.closeSync(fd);
    }
    return crypto.createHash('sha1').update(Buffer.concat(parts)).digest('hex').slice(0, 12);
  } catch (_) {
    // 读不到内容时降级为仅 stat（宁可少判一次陈旧，也不要让工具整体不可用）
    return '';
  }
}

/**
 * 计算文件的版本代理串。
 * 组成：`mtimeMs:size:ino:指纹`。指纹为空时退化为仅 stat。
 * 文件不存在/不可 stat 时返回 null，调用方据此判定"不存在"。
 */
function statVersion(absPath: string): string | null {
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile()) return null;
    const fp = contentFingerprint(absPath, st.size);
    return Math.round(st.mtimeMs) + ':' + st.size + ':' + st.ino + ':' + fp;
  } catch (_) {
    return null;
  }
}

/** sessionId -> (绝对路径 -> 观察记录) */
const ledger = new Map<string, Map<string, Observation>>();

/** 台账容量上限（防长会话无限增长）；超限时按记录时间淘汰最旧的一批 */
const MAX_ENTRIES = 2000;

/** 规范化会话键：无 sessionId 时归入 default（与 rules/injection.ts 一致） */
function sessionKey(sessionId: any): string {
  return typeof sessionId === 'string' && sessionId ? sessionId : '(default)';
}

/** 记录一次权威观察（read 成功、或本会话自己 write/edit 成功后调用） */
function observe(sessionId: any, absPath: string, version: string): void {
  if (!absPath || !version) return;
  const key = sessionKey(sessionId);
  let byPath = ledger.get(key);
  if (!byPath) {
    byPath = new Map<string, Observation>();
    ledger.set(key, byPath);
  }
  byPath.set(absPath, { version, at: Date.now() });
  // 简单容量控制：全局条目超限时，逐会话淘汰最旧记录
  let total = 0;
  for (const m of ledger.values()) total += m.size;
  if (total > MAX_ENTRIES) evictOldest(total - MAX_ENTRIES);
}

/** 淘汰 n 条最旧记录（跨会话，按 at 升序） */
function evictOldest(n: number): void {
  const all: Array<{ sk: string; p: string; at: number }> = [];
  for (const [sk, m] of ledger) {
    for (const [p, o] of m) all.push({ sk, p, at: o.at });
  }
  all.sort((a, b) => a.at - b.at);
  for (let i = 0; i < n && i < all.length; i++) {
    const { sk, p } = all[i];
    const m = ledger.get(sk);
    if (m) {
      m.delete(p);
      if (m.size === 0) ledger.delete(sk);
    }
  }
}

/** 取某会话对某路径的观察记录；未观察到返回 undefined */
function getObservation(sessionId: any, absPath: string): Observation | undefined {
  const byPath = ledger.get(sessionKey(sessionId));
  return byPath ? byPath.get(absPath) : undefined;
}

/** 护栏判定结果 */
interface GuardDecision {
  ok: boolean;
  /** NOT_OBSERVED | STALE_VERSION（拒绝时给出） */
  code?: string;
  /** 面向模型的下一步指令 */
  hint?: string;
}

/**
 * edit 护栏：必须已观察，且版本未变。
 * @param currentVersion 本次读到的文件当前版本
 */
function guardEdit(sessionId: any, absPath: string, displayPath: string, currentVersion: string): GuardDecision {
  const prior = getObservation(sessionId, absPath);
  if (!prior) {
    return {
      ok: false,
      code: 'NOT_OBSERVED',
      hint: '先 read("' + displayPath + '") 拿到当前原文，再基于原文逐字写 oldString。' +
        '不要凭前几轮的叙述或记忆构造待匹配文本。',
    };
  }
  if (prior.version !== currentVersion) {
    return {
      ok: false,
      code: 'STALE_VERSION',
      hint: '你上次读它之后文件已经变了（可能被你自己上一轮的 edit/write 改过，或被命令、用户改过）。' +
        '重新 read("' + displayPath + '") 后再改，不要沿用旧内容。',
    };
  }
  return { ok: true };
}

/**
 * write 护栏：目标已存在但从未观察 → 拒绝（防盲覆盖整份文件）。
 * 目标不存在（新建）时放行。
 *
 * 与 edit 的一致性：观察到版本不同同样拒绝（STALE_VERSION）。
 * 否则会出现漏网场景——read 过之后文件被 bash/用户改掉，edit 会拦、write 却整份覆盖。
 * @param currentVersion 目标文件当前版本（不存在时传 null）
 */
function guardWrite(
  sessionId: any,
  absPath: string,
  displayPath: string,
  exists: boolean,
  currentVersion: string | null = null
): GuardDecision {
  if (!exists) return { ok: true };
  const prior = getObservation(sessionId, absPath);
  if (!prior) {
    return {
      ok: false,
      code: 'NOT_OBSERVED',
      hint: '该文件已存在但本会话从未读过它。write 会整份覆盖——先 read("' + displayPath +
        '") 确认内容，或改用 edit 做局部替换。',
    };
  }
  if (currentVersion && prior.version !== currentVersion) {
    return {
      ok: false,
      code: 'STALE_VERSION',
      hint: '你上次读它之后文件已经变了（可能被命令、用户或你自己改过）。' +
        '重新 read("' + displayPath + '") 确认当前内容后再决定是否整份覆盖。',
    };
  }
  return { ok: true };
}

/** 会话切换/清理时移除（与 rules/injection.ts 的 clearSession 对齐） */
function clearSession(sessionId: any): void {
  ledger.delete(sessionKey(sessionId));
}

/** 清空全部台账（仅测试用） */
function clearAll(): void {
  ledger.clear();
}

/** 当前台账条目总数（仅测试/诊断用） */
function size(): number {
  let n = 0;
  for (const m of ledger.values()) n += m.size;
  return n;
}

export { statVersion, observe, getObservation, guardEdit, guardWrite, clearSession, clearAll, size };
export type { Observation, GuardDecision };
