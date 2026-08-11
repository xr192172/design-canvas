// 伪维基词典 P2 渲染产物静态校验：确认真实页面嵌入了词典渲染代码与样式
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDSL } from '../dist/src/storage.js';
import { renderHTML } from '../dist/src/renderer/html_renderer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsl = getDSL('self_analyze');
if (!dsl) { console.log('✗ no dsl'); process.exit(1); }
const html = renderHTML(dsl);
fs.writeFileSync(path.join(__dirname, '..', 'output', 'dict_verify_real.html'), html, 'utf-8');
console.log('renderHTML ok, len:', html.length);

const checks = {
  'dictHighlightHtml(高亮拆分)': html.includes('dictHighlightHtml'),
  'showDictCard(词卡弹出)': html.includes('showDictCard'),
  'renderDictCard(词卡渲染)': html.includes('renderDictCard'),
  'loadDict(词典加载)': html.includes('loadDict'),
  'dict-view 点击委托': html.includes('data-dict'),
  'dict-card 样式': html.includes('.dict-card'),
  'dict-term 高亮样式': html.includes('.dict-term'),
  '三档 dc-tab': html.includes('data-dictlevel'),
  '互链跳转 dict-link': html.includes('dict-link'),
  '/api/dict/query 请求': html.includes('/api/dict/query'),
  // P3 收录面板
  'dict-open 按钮': html.includes('dict-open'),
  '收录面板 dict-panel': html.includes('dict-panel'),
  '生成预览 dp-preview': html.includes('dp-preview'),
  '确认收录 dp-save': html.includes('dp-save'),
  'dry_run 预览请求': html.includes('dry_run'),
  '收录后加载 loadDict': html.includes('dictLoaded = false'),
};
let ok = true;
for (const [name, hit] of Object.entries(checks)) {
  console.log(`${hit ? '✓' : '✗'} ${name}`);
  if (!hit) ok = false;
}
console.log(ok ? '\n[P2 真实页面嵌入校验] 通过 ✓' : '\n[P2 真实页面嵌入校验] 未通过 ✗');
process.exit(ok ? 0 : 1);