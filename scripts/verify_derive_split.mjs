/**
 * derive_split 自举验证：对 design-canvas 自身一个 TS 文件做 dry-run 拆分（不落盘）
 * 运行: node scripts/verify_derive_split.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveSplit } from '../dist/src/tools/derive_split.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, '..');

const r = await deriveSplit({
  project_dir: projectDir,
  target_file: 'src/tools/derive_split.ts',
  // 抽取纯工具函数 mergeRanges / removeLineRanges / sliceLineRanges（顶层函数，无互引需补 import）
  symbols: ['mergeRanges', 'removeLineRanges', 'sliceLineRanges'],
  dry_run: true,
});

console.log(r.message);
console.log('\n=== 新文件草稿（前 25 行） ===');
console.log(r.new_content.split('\n').slice(0, 25).join('\n'));
console.log('\n=== 原文件草稿（前 20 行） ===');
console.log(r.original_content.split('\n').slice(0, 20).join('\n'));