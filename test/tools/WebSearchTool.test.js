'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import { parseSearchArgs, parseResults, resolveRealUrl } from '../../src/tools/impl/web-search.js';

test('parseSearchArgs 拒绝空 query', () => {
  assert.throws(() => parseSearchArgs('', undefined), /query must be a non-empty string/);
  assert.throws(() => parseSearchArgs('   ', undefined), /query must be a non-empty string/);
  assert.throws(() => parseSearchArgs(123, undefined), /query must be a non-empty string/);
});

test('parseSearchArgs 默认 8 条，上限 20', () => {
  assert.strictEqual(parseSearchArgs('x', undefined).maxResults, 8);
  assert.strictEqual(parseSearchArgs('x', 3).maxResults, 3);
  assert.strictEqual(parseSearchArgs('x', 100).maxResults, 20);
  assert.strictEqual(parseSearchArgs('  x  ', undefined).query, 'x');
});

test('parseSearchArgs 拒绝非法 maxResults', () => {
  assert.throws(() => parseSearchArgs('x', 0), /positive integer/);
  assert.throws(() => parseSearchArgs('x', -1), /positive integer/);
  assert.throws(() => parseSearchArgs('x', 1.5), /positive integer/);
  assert.throws(() => parseSearchArgs('x', 'abc'), /positive integer/);
});

test('resolveRealUrl 解 DuckDuckGo 跳转链接', () => {
  const href = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage%3Fa%3D1&rut=abc';
  assert.strictEqual(resolveRealUrl(href), 'https://example.com/page?a=1');
});

test('resolveRealUrl 保留普通链接', () => {
  assert.strictEqual(resolveRealUrl('https://example.com/x'), 'https://example.com/x');
  assert.strictEqual(resolveRealUrl('//example.com/y'), 'https://example.com/y');
});

test('resolveRealUrl 解码 HTML 实体', () => {
  assert.strictEqual(
    resolveRealUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1%26c%3D2&amp;rut=x'),
    'https://example.com/a?b=1&c=2'
  );
});

test('parseResults 解析单条结果（href 在前）', () => {
  const html = `<tr>
    <td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F&rut=x" class='result-link'>Example Domain</a></td>
    <td class='result-snippet'>This domain is for use in examples.</td>
  </tr>`;
  const items = parseResults(html, 10);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].title, 'Example Domain');
  assert.strictEqual(items[0].url, 'https://example.com/');
  assert.ok(items[0].snippet.includes('examples'));
});

test('parseResults 解析多条结果', () => {
  const html = `<tr>
    <td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com%2F&rut=1" class='result-link'>A</a></td>
    <td class='result-snippet'>A desc</td>
  </tr>
  <tr>
    <td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fb.com%2F&rut=2" class='result-link'>B</a></td>
    <td class='result-snippet'>B desc</td>
  </tr>`;
  const items = parseResults(html, 10);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].title, 'A');
  assert.strictEqual(items[1].title, 'B');
});

test('parseResults 跳过广告块', () => {
  const html = `<tr class="result-sponsored">
    <td><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fads.com%2F" class='result-link'>Ad</a></td>
  </tr>
  <tr>
    <td><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.com%2F" class='result-link'>Real</a></td>
  </tr>`;
  const items = parseResults(html, 10);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].title, 'Real');
});

test('parseResults 遵守 maxResults 上限', () => {
  const rows = [];
  for (let i = 0; i < 15; i++) {
    rows.push(`<tr><td><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fs${i}.com%2F" class='result-link'>S${i}</a></td></tr>`);
  }
  const items = parseResults(rows.join(''), 5);
  assert.strictEqual(items.length, 5);
});

test('parseResults 对相同 URL 去重', () => {
  const html = `<tr><td><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.com%2F" class='result-link'>X1</a></td></tr>
  <tr><td><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.com%2F" class='result-link'>X2</a></td></tr>`;
  const items = parseResults(html, 10);
  assert.strictEqual(items.length, 1);
});

test('parseResults 空 HTML 返回空数组', () => {
  assert.deepStrictEqual(parseResults('', 10), []);
  assert.deepStrictEqual(parseResults('<html><body>no results</body></html>', 10), []);
});
