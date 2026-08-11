import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDSL } from '../dist/src/storage.js';
import { renderHTML } from '../dist/src/renderer/html_renderer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsl = getDSL('self_analyze');
if (!dsl) { console.log('✗ no dsl'); process.exit(1); }
const html = renderHTML(dsl);
fs.writeFileSync(path.join(__dirname, '..', 'output', 'lc_verify.html'), html, 'utf-8');
console.log('renderHTML ok, len:', html.length);
const checks = {
  'lc-chip 样式': html.includes('.lc-chip'),
  'lc-block 徽章块': html.includes('lc-block'),
  'loadLanguageConcepts 获取': html.includes('loadLanguageConcepts'),
  'LC_EXPLAIN 解释常量': html.includes('LC_EXPLAIN'),
  'api/language-concepts 请求': html.includes('/api/language-concepts'),
  'lcTooltipHtml 渲染': html.includes('lcTooltipHtml'),
};
let ok = true;
for (const [name, hit] of Object.entries(checks)) {
  console.log(`${hit ? '✓' : '✗'} ${name}`);
  if (!hit) ok = false;
}
console.log(ok ? '\n渲染产物验证通过 ✓' : '\n渲染产物验证未通过 ✗');
process.exit(ok ? 0 : 1);