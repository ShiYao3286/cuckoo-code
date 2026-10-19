/**
 * T4：流式读取 readFileWindow 与内存版 buildWindow 的等价性测试。
 * 以"唯一真相"的 buildWindow 为基准，覆盖空文件/末尾换行/CRLF/多字节/跨块/窗口/预算/越界。
 */
import { test, afterAll } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWindow, readFileWindow, READ_CHUNK_BYTES } from '../../src/tools/impl/read.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-read-stream-'));
let seq = 0;
function writeTemp(content, encoding) {
  const p = path.join(tmpDir, 'f' + (++seq) + '.txt');
  fs.writeFileSync(p, content, encoding || 'utf-8');
  return p;
}

/** 用同样的请求分别跑内存版与流式版，返回两者结果 */
function both(content, request) {
  const p = writeTemp(content);
  return {
    mem: buildWindow(content, request, 'f.txt'),
    stream: readFileWindow(p, request, 'f.txt'),
  };
}

const BASE = { offset: 1, limit: 100, maxLineLength: 1000, maxBytes: 1_000_000 };

test('等价性：空文件', () => {
  const { mem, stream } = both('', BASE);
  assert.deepStrictEqual(stream, mem);
});

test('等价性：单行无换行', () => {
  const { mem, stream } = both('abc', BASE);
  assert.deepStrictEqual(stream, mem);
});

test('等价性：末尾换行产生尾部空行', () => {
  const { mem, stream } = both('a\nb\n', BASE);
  assert.deepStrictEqual(stream, mem);
  assert.strictEqual(stream.totalLines, 3);
});

test('等价性：CRLF', () => {
  const { mem, stream } = both('a\r\nb\r\n', BASE);
  assert.deepStrictEqual(stream, mem);
  assert.strictEqual(stream.lines[0].text, 'a');
});

test('等价性：多字节字符', () => {
  const content = '你好\n世界\n🙂 emoji\n';
  const { mem, stream } = both(content, BASE);
  assert.deepStrictEqual(stream, mem);
});

test('等价性：offset/limit 分段', () => {
  const content = 'a\nb\nc\nd\ne';
  const req = Object.assign({}, BASE, { offset: 2, limit: 2 });
  const { mem, stream } = both(content, req);
  assert.deepStrictEqual(stream, mem);
});

test('等价性：超长行截断', () => {
  const content = 'x'.repeat(50);
  const req = Object.assign({}, BASE, { maxLineLength: 10 });
  const { mem, stream } = both(content, req);
  assert.deepStrictEqual(stream, mem);
});

test('等价性：字节上限截断', () => {
  const content = 'hello\nworld\n!';
  const req = Object.assign({}, BASE, { maxBytes: 10 });
  const { mem, stream } = both(content, req);
  assert.deepStrictEqual(stream, mem);
  assert.strictEqual(stream.truncatedByBytes, true);
});

test('等价性：offset 越界都抛错', () => {
  const content = 'a\nb\nc';
  const req = Object.assign({}, BASE, { offset: 5 });
  const p = writeTemp(content);
  assert.throws(() => buildWindow(content, req, 'f.txt'), /out of range/);
  assert.throws(() => readFileWindow(p, req, 'f.txt'), /out of range/);
});

test('等价性：跨块边界（行被块切开）', () => {
  // 构造一个 > 2 块、且每块边界都落在行中间的文本
  const line = 'y'.repeat(97) + '\n'; // 98 字节，与块大小不整除
  const content = line.repeat(Math.ceil((READ_CHUNK_BYTES * 2.5) / line.length));
  const req = Object.assign({}, BASE, { limit: 5000 });
  const { mem, stream } = both(content, req);
  assert.deepStrictEqual(stream, mem);
  assert.ok(stream.totalLines > 1000);
});

test('等价性：大文件只取头部窗口（totalLines 仍精确）', () => {
  const line = 'z'.repeat(63) + '\n'; // 64 字节
  const total = 5000;
  const content = line.repeat(total);
  const req = Object.assign({}, BASE, { limit: 10 });
  const { mem, stream } = both(content, req);
  assert.deepStrictEqual(stream, mem);
  assert.strictEqual(stream.totalLines, total + 1); // 末尾换行 → +1
  assert.strictEqual(stream.lines.length, 10);
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
});
