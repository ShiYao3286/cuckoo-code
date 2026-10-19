/**
 * json-file 工具测试：BOM 容错（035 排查发现 Windows 编辑器常见问题）。
 */
import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonFile, writeJsonFile, stripBom } from '../../src/infra/json-file.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-jsonfile-'));
let seq = 0;

function tmpFile(content, encoding) {
  const p = path.join(TMP, 'f' + (++seq) + '.json');
  fs.writeFileSync(p, content, encoding || 'utf-8');
  return p;
}

test('stripBom 剥离 UTF-8 BOM', () => {
  assert.strictEqual(stripBom('\uFEFF{}'), '{}');
  assert.strictEqual(stripBom('{}'), '{}');
});

test('readJsonFile 正常 JSON', () => {
  const p = tmpFile('{"a":1}');
  assert.deepStrictEqual(readJsonFile(p), { a: 1 });
});

test('readJsonFile 带 BOM 也能解析（关键：Windows 编辑器场景）', () => {
  // 模拟 PowerShell Set-Content -Encoding UTF8 / 记事本的输出
  const p = tmpFile('\uFEFF{"a":1,"b":true}');
  assert.deepStrictEqual(readJsonFile(p), { a: 1, b: true });
});

test('readJsonFile 真实 BOM 字节（EF BB BF）', () => {
  const p = path.join(TMP, 'bom-bytes.json');
  fs.writeFileSync(p, Buffer.concat([
    Buffer.from([0xEF, 0xBB, 0xBF]),
    Buffer.from('{"ok":true}', 'utf-8'),
  ]));
  assert.deepStrictEqual(readJsonFile(p), { ok: true });
});

test('readJsonFile 非法 JSON 抛错（由调用方处理）', () => {
  const p = tmpFile('{invalid');
  assert.throws(() => readJsonFile(p), /JSON/i);
});

test('readJsonFile 文件不存在抛错', () => {
  assert.throws(() => readJsonFile(path.join(TMP, 'nope.json')));
});

test('writeJsonFile 写入不带 BOM', () => {
  const p = path.join(TMP, 'out.json');
  writeJsonFile(p, { memoriesEnabled: true });
  const buf = fs.readFileSync(p);
  const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  assert.strictEqual(hasBom, false, '写出的文件不应带 BOM');
});

test('writeJsonFile + readJsonFile 往返一致', () => {
  const p = path.join(TMP, 'roundtrip.json');
  const data = { memoriesEnabled: true, list: [1, 2, 3], nested: { x: 'y' } };
  writeJsonFile(p, data);
  assert.deepStrictEqual(readJsonFile(p), data);
});
