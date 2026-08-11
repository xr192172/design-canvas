/**
 * analyze_monolith 自举验证：对 design-canvas 自己的 cache.db 做跨文件功能社区圈定
 * 运行: node scripts/verify_analyze_monolith.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeMonolith } from '../dist/src/tools/analyze_monolith.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, '..');

const r = analyzeMonolith({
  project_dir: projectDir,
  warn_lines: 300,
  crit_lines: 600,
});
console.log(r.message);

console.log('\n--- 结构化摘要 ---');
for (const c of r.communities) {
  console.log(`社区[${c.id}] ${c.name}: ${c.symbol_count}符号 / ~${c.est_lines}行 / ${c.files.length}文件 / 锚点=${c.anchors.length}`);
}
console.log(`\n拆分候选 ${r.split_candidates.length} 个:`);
for (const f of r.split_candidates) console.log(`  → ${f}`);