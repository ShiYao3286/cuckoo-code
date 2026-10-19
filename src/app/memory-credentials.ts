/**
 * 记忆整理用的 API Key 存取（036）
 *
 * 为什么单独一个模块：Key 是敏感信息，不能写进 config.json（明文）。
 * 用 Electron 的 safeStorage 加密后存到 userData 下的独立文件：
 *   - Windows：DPAPI（与当前用户账户绑定）
 *   - macOS：Keychain
 *   - Linux：libsecret（不可用时降级为明文并警告）
 *
 * 降级策略：safeStorage.isEncryptionAvailable() 为 false 时，
 * 仍然存储（base64），但在日志里明确警告——总比"功能完全不可用"好。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** 取 safeStorage（Electron 未就绪时返回 null） */
function getSafeStorage(): any {
  try {
    const { safeStorage } = require('electron');
    return safeStorage || null;
  } catch (_) {
    return null;
  }
}

/** Key 文件路径（与 config.json 同目录，便于一起备份/迁移） */
function getKeyFilePath(): string {
  const override = process.env.CUCKOO_HOME;
  const home = override ? override : path.join(os.homedir(), '.cuckoo');
  return path.join(home, 'memory-llm-key');
}

/**
 * 保存 API Key（加密后写盘）。
 * @returns { success, error? }
 */
function saveMemoryApiKey(key: string): { success: boolean; error?: string } {
  const k = String(key || '').trim();
  if (!k) return { success: false, error: 'Key 为空' };
  const file = getKeyFilePath();
  try {
    const ss = getSafeStorage();
    let payload: string;
    if (ss && typeof ss.isEncryptionAvailable === 'function' && ss.isEncryptionAvailable()) {
      const buf = ss.encryptString(k);
      payload = 'enc:' + Buffer.from(buf).toString('base64');
    } else {
      // 降级：base64（不是加密，只是避免一眼可见）
      console.warn('[MemoryKey] safeStorage 不可用，API Key 以未加密形式存储');
      payload = 'b64:' + Buffer.from(k, 'utf-8').toString('base64');
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, payload, 'utf-8');
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * 读取 API Key。未配置或解密失败时返回 null。
 */
function getMemoryApiKey(): string | null {
  const file = getKeyFilePath();
  try {
    if (!fs.existsSync(file)) return null;
    const payload = fs.readFileSync(file, 'utf-8').trim();
    if (payload.startsWith('enc:')) {
      const ss = getSafeStorage();
      if (!ss || typeof ss.decryptString !== 'function') {
        console.error('[MemoryKey] 无法解密：safeStorage 不可用');
        return null;
      }
      const buf = Buffer.from(payload.slice(4), 'base64');
      return ss.decryptString(buf);
    }
    if (payload.startsWith('b64:')) {
      return Buffer.from(payload.slice(4), 'base64').toString('utf-8');
    }
    return null;
  } catch (err: any) {
    console.error('[MemoryKey] 读取失败:', err && err.message);
    return null;
  }
}

/** 是否已配置 Key（不返回 Key 本身） */
function hasMemoryApiKey(): boolean {
  return !!getMemoryApiKey();
}

/** 清除 Key */
function clearMemoryApiKey(): { success: boolean; error?: string } {
  const file = getKeyFilePath();
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err && err.message ? err.message : String(err) };
  }
}

/** 取 Key 文件路径（诊断用） */
function getKeyFile(): string {
  return getKeyFilePath();
}

export { saveMemoryApiKey, getMemoryApiKey, hasMemoryApiKey, clearMemoryApiKey, getKeyFile };
