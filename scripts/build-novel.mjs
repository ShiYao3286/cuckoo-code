/**
 * 构建写作台前端脚本（需求 041）
 *
 * 写作台逻辑在 src/ui/novel.ts，经 esbuild 打包成自包含 IIFE，
 * 输出到 src/ui/novel.js，由 novel.html 以 <script src="./novel.js"> 引用。
 *
 * 为什么输出到 src/ui/ 而不是 out/：
 *   resolveSrc() 解析的是 APP_ROOT/src/<rel>（见 src/infra/paths.ts），
 *   novel.html 从 src/ui/ 加载，同目录的 novel.js 也必须在那。
 *
 * 为什么用 esbuild 而不靠 tsc：
 *   tsc 按模块编译且产出 ESM，file:// 下多文件模块加载不稳；
 *   esbuild 打成单文件 IIFE 最稳。novel.ts 已从 tsconfig 排除，避免双份产物。
 *
 * 为什么独立成文件而不塞进 html：
 *   harness.html 已 2760 行，再复制一个巨型单文件难维护。
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'ui', 'novel.ts');
const OUT = path.join(ROOT, 'src', 'ui', 'novel.js');

// 让 .js 后缀的 import 解析到 .ts 源文件（与 build-hooks 保持一致）
const tsJsResolve = {
  name: 'ts-js-resolve',
  setup(b) {
    b.onResolve({ filter: /\.js$/ }, (args) => {
      const p = path.resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts'));
      if (fs.existsSync(p)) return { path: p };
      return null;
    });
  },
};

if (!fs.existsSync(ENTRY)) {
  console.error('[build-novel] 找不到入口: ' + ENTRY);
  process.exit(1);
}

const result = await build({
  entryPoints: [ENTRY],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
  plugins: [tsJsResolve],
});

const code = result.outputFiles[0].text;
fs.writeFileSync(OUT, code, 'utf8');
const kb = (Buffer.byteLength(code, 'utf-8') / 1024).toFixed(1);
console.log('[build-novel] 生成 src/ui/novel.js（' + kb + ' KB）');
