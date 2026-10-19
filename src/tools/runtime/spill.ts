/**
 * 长输出落盘（移植 DSH 的 spill 思路）
 *
 * 背景：JsRunner 原来对超过 20000 字符的输出直接 `slice` 截断，模型永远看不到被切掉的部分，
 * 只能凭开头猜——实测这是"改完结果不对"的高频来源之一。
 *
 * 现在的策略：超限时把**完整输出落盘**，回传给模型的文本保持"首部 + 尾部 + 路径提示"：
 *  - 开头保留（模型最依赖的上下文入口）
 *  - 结尾保留（错误信息、[exit code]、汇总通常在这里）
 *  - 明确告诉模型文件路径，教它用 grep/read(offset) 精读，而不是猜
 *
 * 落盘位置：`~/.cuckoo/spill/<session>-<ts>.log`
 * 为什么不放项目目录：那是用户仓库，不该被工具日志污染；`~/.cuckoo` 已是应用数据目录。
 * 注意：`protected-paths.ts` 只保护 `~/.cuckoo/snapshots/` 与 `memories.json`，
 * spill 目录不在保护范围，模型可以正常 read。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 回传文本保留的开头字符数 */
const HEAD_CHARS = 12000;
/** 回传文本保留的结尾字符数 */
const TAIL_CHARS = 4000;
/** 保留的文件数上限（超过后按 mtime 淘汰最旧） */
const MAX_FILES = 50;

function getSpillDir(): string {
  const override = process.env.CUCKOO_HOME;
  const home = override ? override : path.join(os.homedir(), '.cuckoo');
  return path.join(home, 'spill');
}

/** 安全的会话名片段（防路径注入：sessionId 可能来自 URL，含特殊字符） */
function safeSessionTag(sessionId: any): string {
  const s = typeof sessionId === 'string' && sessionId ? sessionId : 'default';
  return s.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40);
}

/** 清理超量旧文件（best-effort，失败不影响主流程） */
function pruneOldFiles(dir: string): void {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => {
        const p = path.join(dir, f);
        try { return { p, m: fs.statSync(p).mtimeMs }; } catch { return null; }
      })
      .filter(Boolean) as Array<{ p: string; m: number }>;
    if (files.length <= MAX_FILES) return;
    files.sort((a, b) => a.m - b.m);
    for (const f of files.slice(0, files.length - MAX_FILES)) {
      try { fs.unlinkSync(f.p); } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }
}

/**
 * 把完整输出写到 spill 目录。
 * @returns 写入后的绝对路径；失败返回 null（调用方退回纯截断）
 */
function spillToFile(fullOutput: string, sessionId: any): string | null {
  try {
    const dir = getSpillDir();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, safeSessionTag(sessionId) + '-' + stamp + '.log');
    fs.writeFileSync(file, fullOutput, 'utf-8');
    pruneOldFiles(dir);
    return file;
  } catch (_) {
    return null;
  }
}

/**
 * 生成"超长输出"的回传文本。
 * 落盘成功 → 首尾 + 路径与读法；落盘失败 → 退回原来的纯截断（不丢功能）。
 * @param fullOutput 完整输出
 * @param limit 触发阈值（与 OUTPUT_LIMIT 一致）
 * @param sessionId 会话 id（用于文件命名与隔离）
 */
function buildTruncatedOutput(fullOutput: string, limit: number, sessionId: any): string {
  // 未超限：原样返回，不做任何包装（函数自带守卫，调用方无需自己判断）
  if (fullOutput.length <= limit) return fullOutput;
  const spilled = spillToFile(fullOutput, sessionId);
  if (!spilled) {
    return fullOutput.slice(0, limit) + '\n...[输出过长已截断]...';
  }
  const head = fullOutput.slice(0, HEAD_CHARS);
  const tail = fullOutput.slice(Math.max(HEAD_CHARS, fullOutput.length - TAIL_CHARS));
  const omitted = fullOutput.length - head.length - tail.length;
  const lines = fullOutput.split('\n').length;
  return head
    + '\n\n...[中间省略约 ' + omitted.toLocaleString() + ' 字符]...\n'
    + '【完整输出已落盘】' + spilled + '\n'
    + '（共 ' + fullOutput.length.toLocaleString() + ' 字符 / ' + lines + ' 行。'
    + '不要凭上面首尾猜中间内容：用 grep(pattern, { path: "' + spilled + '" }) 定位行号，'
    + '再 read("' + spilled + '", { offset, limit }) 精读那一段。）\n\n'
    + tail;
}

export { spillToFile, buildTruncatedOutput, getSpillDir, HEAD_CHARS, TAIL_CHARS };
