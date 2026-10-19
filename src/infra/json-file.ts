/**
 * 健壮的 JSON 文件读取。
 *
 * 背景（035 排查发现）：Windows 上大量编辑器（记事本、VS Code 某些配置、PowerShell 的
 * `Set-Content -Encoding UTF8`）保存 UTF-8 文件时会写入 BOM（EF BB BF）。
 * 而 `JSON.parse` 遇到 BOM 会直接抛 "Unexpected token"，导致配置文件被当成损坏、
 * 静默回退默认值——表现为「明明改成了 true，重启后又变回 false」。
 *
 * 本函数在解析前剥掉 BOM。不改写文件本身（写回由调用方决定）。
 */
import fs from 'node:fs';

/** 剥掉 UTF-8 BOM（\uFEFF）。 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

/**
 * 读取并解析 JSON 文件。
 * @param file 绝对路径
 * @returns 解析后的值
 * @throws 文件不存在、读取失败或 JSON 非法时抛出（调用方自行 try/catch）
 */
function readJsonFile(file: string): any {
  return JSON.parse(stripBom(fs.readFileSync(file, 'utf-8')));
}

/**
 * 写入 JSON 文件（不带 BOM，2 空格缩进）。
 * 注意：本函数**不**做原子写——需要原子性的场景请自行用 tmp + rename。
 */
function writeJsonFile(file: string, value: any): void {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf-8');
}

export { readJsonFile, writeJsonFile, stripBom };
