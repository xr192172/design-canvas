// 一次性：用最新渲染器重渲染 output/*.html（保留页面内嵌的 __DSL__ 状态）
import fs from 'node:fs';
import path from 'node:path';
import { renderHTML } from '../dist/src/renderer/html_renderer.js';

const outDir = path.resolve('output');
const files = process.argv[2] ? [process.argv[2]] : fs.readdirSync(outDir).filter((f) => f.endsWith('.html'));

for (const f of files) {
  const file = path.join(outDir, f);
  const html = fs.readFileSync(file, 'utf-8');
  const m = html.match(/\/\* __DSL_START__ \*\/\s*window\.__DSL__ = (\{[\s\S]*?\});\s*\/\* __DSL_END__ \*\//);
  if (!m) {
    console.log(`skip ${f}: no __DSL__ block`);
    continue;
  }
  const dsl = JSON.parse(m[1]);
  const newHtml = renderHTML(dsl);
  fs.writeFileSync(file, newHtml, 'utf-8');
  console.log(`rerendered ${f}: ${(newHtml.length / 1024).toFixed(0)}KB`);
}
