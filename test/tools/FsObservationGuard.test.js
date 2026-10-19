'use strict';
import { test, describe, beforeEach } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { ReadTool } from '../../src/tools/impl/read.js';
import { EditTool } from '../../src/tools/impl/edit.js';
import { WriteTool } from '../../src/tools/impl/write.js';
import { clearAll, size, getObservation } from '../../src/tools/runtime/fs-observation.js';
import { writeConfig } from '../../src/infra/config.js';

const tmpRoot = path.join(process.cwd(), 'test', 'tmp', 'fs-guard');

/**
 * 每个用例独立会话 id：台账按会话隔离，避免用例间互相"放行"。
 */
let sid;
let seq = 0;

function setup() {
  clearAll();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  sid = 'sess-' + (++seq);
  // 确保护栏处于默认开启状态（其他用例可能写过 config）
  writeConfig({ fsGuardEnabled: true });
}

beforeEach(setup);

function write(name, content) {
  fs.writeFileSync(path.join(tmpRoot, name), content);
}

/** 把 mtime 往后拨 2 秒，制造"读后又被改"的确定差异（不依赖耗时） */
function bumpMtime(name, deltaMs = 2000) {
  const p = path.join(tmpRoot, name);
  const st = fs.statSync(p);
  const t = new Date(st.mtimeMs + deltaMs);
  fs.utimesSync(p, t, t);
}

describe('read-before-edit 护栏：edit', () => {
  test('未 read 就 edit → 拒绝，码为 NOT_OBSERVED 且给出下一步指令', async () => {
    write('a.txt', 'hello world');
    const r = await new EditTool().execute({
      filePath: 'a.txt', oldString: 'world', newString: 'cuckoo', projectDir: tmpRoot, sessionId: sid,
    });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.code, 'NOT_OBSERVED');
    assert.match(String(r.error), /尚未读过/);
    assert.match(String(r.error), /read\("a.txt"\)/);
    // 关键：文件绝不能被改动
    assert.strictEqual(fs.readFileSync(path.join(tmpRoot, 'a.txt'), 'utf8'), 'hello world');
  });

  test('read 之后 edit 成功', async () => {
    write('b.txt', 'hello world');
    const read = await new ReadTool().execute({ filePath: 'b.txt', projectDir: tmpRoot, sessionId: sid });
    assert.strictEqual(read.success, true);
    const r = await new EditTool().execute({
      filePath: 'b.txt', oldString: 'world', newString: 'cuckoo', projectDir: tmpRoot, sessionId: sid,
    });
    assert.strictEqual(r.success, true);
    assert.strictEqual(fs.readFileSync(path.join(tmpRoot, 'b.txt'), 'utf8'), 'hello cuckoo');
  });

  test('read 后文件被外部改动 → STALE_VERSION，要求重读', async () => {
    write('c.txt', 'hello world');
    await new ReadTool().execute({ filePath: 'c.txt', projectDir: tmpRoot, sessionId: sid });
    // 模拟外部改动（命令行/用户/其他工具）
    fs.writeFileSync(path.join(tmpRoot, 'c.txt'), 'hello world!');
    bumpMtime('c.txt');

    const r = await new EditTool().execute({
      filePath: 'c.txt', oldString: 'world', newString: 'cuckoo', projectDir: tmpRoot, sessionId: sid,
    });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.code, 'STALE_VERSION');
    assert.match(String(r.error), /已被改动/);
    // 文件保持外部改动后的样子，没有被"基于旧内容"覆盖
    assert.strictEqual(fs.readFileSync(path.join(tmpRoot, 'c.txt'), 'utf8'), 'hello world!');
  });

  test('重读后同一会话可再次编辑', async () => {
    write('d.txt', 'hello world');
    await new ReadTool().execute({ filePath: 'd.txt', projectDir: tmpRoot, sessionId: sid });
    fs.writeFileSync(path.join(tmpRoot, 'd.txt'), 'hello world!');
    bumpMtime('d.txt');
    const blocked = await new EditTool().execute({
      filePath: 'd.txt', oldString: 'world', newString: 'x', projectDir: tmpRoot, sessionId: sid,
    });
    assert.strictEqual(blocked.code, 'STALE_VERSION');
    // 重读
    await new ReadTool().execute({ filePath: 'd.txt', projectDir: tmpRoot, sessionId: sid });
    const ok = await new EditTool().execute({
      filePath: 'd.txt', oldString: 'world!', newString: 'there', projectDir: tmpRoot, sessionId: sid,
    });
    assert.strictEqual(ok.success, true);
    assert.strictEqual(fs.readFileSync(path.join(tmpRoot, 'd.txt'), 'utf8'), 'hello there');
  });

  test('连续 edit 无需每次重读（自己改过的文件视为已观察）', async () => {
    write('e.txt', 'a b c');
    await new ReadTool().execute({ filePath: 'e.txt', projectDir: tmpRoot, sessionId: sid });
    const r1 = await new EditTool().execute({ filePath: 'e.txt', oldString: 'a', newString: 'A', projectDir: tmpRoot, sessionId: sid });
    assert.strictEqual(r1.success, true);
    // 第二次 edit 前没有重读，但应该放行（上一轮 edit 更新了观察版本）
    const r2 = await new EditTool().execute({ filePath: 'e.txt', oldString: 'b', newString: 'B', projectDir: tmpRoot, sessionId: sid });
    assert.strictEqual(r2.success, true, '自己改过之后应允许连续编辑');
    assert.strictEqual(fs.readFileSync(path.join(tmpRoot, 'e.txt'), 'utf8'), 'A B c');
  });

  test('会话隔离：A 会话读过，不替 B 会话放行', async () => {
    write('f.txt', 'hello');
    await new ReadTool().execute({ filePath: 'f.txt', projectDir: tmpRoot, sessionId: 'session-A' });
    const r = await new EditTool().execute({
      filePath: 'f.txt', oldString: 'hello', newString: 'bye', projectDir: tmpRoot, sessionId: 'session-B',
    });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.code, 'NOT_OBSERVED');
  });

  test('dry-run 也受护栏约束（否则会给出误导性预览）', async () => {
    write('g.txt', 'hello');
    const r = await new EditTool().execute({
      filePath: 'g.txt', oldString: 'hello', newString: 'bye', dryRun: true, projectDir: tmpRoot, sessionId: sid,
    });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.code, 'NOT_OBSERVED');
  });
});

describe('read-before-edit 护栏：write', () => {
  test('覆盖已存在但未读过的文件 → 拒绝', async () => {
    write('h.txt', 'original');
    const r = await new WriteTool().execute({ filePath: 'h.txt', content: 'new', projectDir: tmpRoot, sessionId: sid });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.code, 'NOT_OBSERVED');
    assert.strictEqual(fs.readFileSync(path.join(tmpRoot, 'h.txt'), 'utf8'), 'original');
  });

  test('新建文件不受影响', async () => {
    const r = await new WriteTool().execute({ filePath: 'new.txt', content: 'hi', projectDir: tmpRoot, sessionId: sid });
    assert.strictEqual(r.success, true);
    assert.strictEqual(fs.readFileSync(path.join(tmpRoot, 'new.txt'), 'utf8'), 'hi');
  });

  test('read 后覆盖已存在文件 → 允许', async () => {
    write('i.txt', 'original');
    await new ReadTool().execute({ filePath: 'i.txt', projectDir: tmpRoot, sessionId: sid });
    const r = await new WriteTool().execute({ filePath: 'i.txt', content: 'replaced', projectDir: tmpRoot, sessionId: sid });
    assert.strictEqual(r.success, true);
    assert.strictEqual(fs.readFileSync(path.join(tmpRoot, 'i.txt'), 'utf8'), 'replaced');
  });

  test('write 新建后可直接再 write（自己创建的文件已登记）', async () => {
    const w = new WriteTool();
    await w.execute({ filePath: 'j.txt', content: 'v1', projectDir: tmpRoot, sessionId: sid });
    const r = await w.execute({ filePath: 'j.txt', content: 'v2', projectDir: tmpRoot, sessionId: sid });
    assert.strictEqual(r.success, true);
  });
});

describe('护栏开关与台账', () => {
  test('fsGuardEnabled=false 时恢复旧行为（未读也能改）', async () => {
    writeConfig({ fsGuardEnabled: false });
    try {
      write('k.txt', 'hello');
      const r = await new EditTool().execute({
        filePath: 'k.txt', oldString: 'hello', newString: 'bye', projectDir: tmpRoot, sessionId: sid,
      });
      assert.strictEqual(r.success, true, '关闭护栏后应放行');
    } finally {
      writeConfig({ fsGuardEnabled: true });
    }
  });

  test('read 会登记台账，clearAll 清空', async () => {
    write('l.txt', 'x');
    await new ReadTool().execute({ filePath: 'l.txt', projectDir: tmpRoot, sessionId: sid });
    assert.strictEqual(size(), 1);
    assert.ok(getObservation(sid, path.join(tmpRoot, 'l.txt')));
    clearAll();
    assert.strictEqual(size(), 0);
  });
});
