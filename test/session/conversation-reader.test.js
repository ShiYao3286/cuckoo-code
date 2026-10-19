/**
 * 会话正文提取测试（036）
 *
 * readConversationInPage 在页面上下文执行，无法直接单测。
 * 这里测的是它的等价逻辑：三层正文抽取策略。
 * （把策略抽出来测，避免为了可测性把页面函数改得不像自己）
 */
import { test } from 'vitest';
import assert from 'node:assert';

/**
 * 与 conversation-reader.ts 里 extractContent 同构的实现。
 * 之所以复制一份而不导出：那个函数在页面里 toString() 执行，导出会引入外部引用。
 * 两份实现的一致性由「真机验证」兜底——若页面里行为不符，会直接暴露。
 */
function extractContent(m) {
  if (typeof m.content === 'string' && m.content) {
    return { content: m.content, source: 'content', rawKeys: [] };
  }
  if (Array.isArray(m.fragments) && m.fragments.length > 0) {
    let s = '';
    for (const f of m.fragments) {
      if (!f) continue;
      if (typeof f.content === 'string') s += f.content;
      else if (typeof f.text === 'string') s += f.text;
    }
    if (s) return { content: s, source: 'fragments', rawKeys: [] };
  }
  for (const wrapKey of ['message', 'data', 'payload', 'body']) {
    const inner = m[wrapKey];
    if (inner && typeof inner === 'object') {
      if (typeof inner.content === 'string' && inner.content) {
        return { content: inner.content, source: 'auto:' + wrapKey + '.content', rawKeys: [] };
      }
      if (typeof inner.text === 'string' && inner.text) {
        return { content: inner.text, source: 'auto:' + wrapKey + '.text', rawKeys: [] };
      }
    }
  }
  const skip = new Set(['role', 'id', 'message_id', 'parent_id', 'status', 'model', 'type', 'created_at', 'updated_at', 'inserted_at']);
  const isIsoTimestamp = (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s);
  let bestKey = '';
  let bestVal = '';
  for (const k of Object.keys(m)) {
    if (skip.has(k)) continue;
    const v = m[k];
    if (typeof v !== 'string') continue;
    if (isIsoTimestamp(v)) continue;
    if (v.length > bestVal.length) {
      bestKey = k;
      bestVal = v;
    }
  }
  if (bestVal.length >= 2) {
    return { content: bestVal, source: 'auto:' + bestKey, rawKeys: [] };
  }
  const debugKeys = Object.keys(m).map((k) => k + '(' + typeof m[k] + ')');
  return { content: '', source: 'unknown', rawKeys: debugKeys };
}

test('第 1 层：m.content 字符串', () => {
  const r = extractContent({ message_id: 1, role: 'USER', content: '你好' });
  assert.strictEqual(r.content, '你好');
  assert.strictEqual(r.source, 'content');
});

test('第 1 层：m.fragments 数组（content 字段）', () => {
  const r = extractContent({ message_id: 1, role: 'ASSISTANT', fragments: [{ content: 'A' }, { content: 'B' }] });
  assert.strictEqual(r.content, 'AB');
  assert.strictEqual(r.source, 'fragments');
});

test('第 1 层：m.fragments 数组（text 字段）', () => {
  const r = extractContent({ message_id: 1, role: 'ASSISTANT', fragments: [{ text: 'X' }, { text: 'Y' }] });
  assert.strictEqual(r.content, 'XY');
});

test('第 1 层：m.fragments 混合 content/text', () => {
  const r = extractContent({ fragments: [{ content: 'a' }, { text: 'b' }] });
  assert.strictEqual(r.content, 'ab');
});

test('第 1 层：fragments 里有 null/空项不崩', () => {
  const r = extractContent({ fragments: [null, { content: 'x' }, {}, undefined] });
  assert.strictEqual(r.content, 'x');
});

test('第 2 层：m.message.content', () => {
  const r = extractContent({ message: { content: '嵌套正文' } });
  assert.strictEqual(r.content, '嵌套正文');
  assert.strictEqual(r.source, 'auto:message.content');
});

test('第 2 层：m.data.text', () => {
  const r = extractContent({ data: { text: 'data 里的正文' } });
  assert.strictEqual(r.content, 'data 里的正文');
  assert.strictEqual(r.source, 'auto:data.text');
});

test('第 3 层：兜底取最长字符串字段', () => {
  const r = extractContent({
    message_id: 5,
    role: 'USER',
    unknown_field: '这是真正的正文内容',
    short_tag: 'x',
  });
  assert.strictEqual(r.content, '这是真正的正文内容');
  assert.strictEqual(r.source, 'auto:unknown_field');
});

test('第 3 层：排除 id/时间戳等字段', () => {
  const r = extractContent({
    message_id: 1,
    role: 'USER',
    created_at: '2026-10-19T12:00:00Z',  // 比正文还长，但应被排除
    body_text: '正文',
  });
  assert.strictEqual(r.content, '正文');
  assert.strictEqual(r.source, 'auto:body_text');
});

test('全都没命中：返回 unknown + 字段诊断', () => {
  const r = extractContent({ message_id: 1, role: 'USER', flag: true, n: 5 });
  assert.strictEqual(r.content, '');
  assert.strictEqual(r.source, 'unknown');
  assert.ok(r.rawKeys.length > 0);
  assert.ok(r.rawKeys.some((k) => k.startsWith('flag')));
});

test('单字符不误判为正文（长度阈值 2）', () => {
  const r = extractContent({ message_id: 1, role: 'USER', tiny: 'a' });
  assert.strictEqual(r.content, '');
  assert.strictEqual(r.source, 'unknown');
});

test('ISO 时间戳即使更长也不被当成正文', () => {
  const r = extractContent({
    message_id: 1,
    role: 'USER',
    ts: '2026-10-19T12:00:00.000Z',
    body: '短正文',
  });
  assert.strictEqual(r.content, '短正文');
  assert.strictEqual(r.source, 'auto:body');
});
