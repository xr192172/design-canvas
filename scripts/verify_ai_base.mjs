/**
 * analyze_monolith 在真实异项目（ai-base，Go 主导）上的验证脚本
 *
 * 目的：脱离 design-canvas 自举，验证"跨文件功能社区圈定"在别人的 Go/Python 项目上
 * 输出的社区、锚点、拆分候选是否符合直觉。跑完后人工核对 main.go 等代码。
 *
 * 流程：
 *   1. openDb(ai-base/.design-canvas/cache.db) 建缓存
 *   2. importProject({ cache_db, live_only:true, live_dir:ai-base 根 }) 建索引（call 边）
 *      —— live 归位到 ai-base/.design-canvas/live/，不覆盖任何设计画布
 *   3. analyzeMonolith({ project_dir: ai-base }) 圈社区
 *
 * 运行: node scripts/verify_ai_base.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../dist/src/db/db.js';
import { importProject } from '../dist/src/tools/import_project.js';
import { analyzeMonolith } from '../dist/src/tools/analyze_monolith.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const aiBase = path.resolve(here, '..', '..', 'ai-base');

console.log('=== 1. 建立 ai-base 索引（cache.db） ===');
const db = openDb(path.join(aiBase, '.design-canvas', 'cache.db'));
// 清空缓存表，强制全量重解析（保证每次验证用最新 parser/kernel 自举）
db.exec('DELETE FROM nodes; DELETE FROM edges; DELETE FROM files;');
const imp = await importProject({
  project_dir: aiBase,
  feature: '_verify',
  max_files: 300,
  cache_db: db,
  live_only: true,
  live_dir: aiBase,
});
console.log(`  收录 ${imp.files_parsed} 文件，符号 ${imp.symbols_found}，依赖边 ${imp.dep_edges}` +
  (imp.cache ? `，缓存 hits=${imp.cache.hits} reparsed=${imp.cache.reparsed} failed=${imp.cache.failed}` : ''));
for (const s of imp.skipped.slice(0, 10)) console.log(`  skip: ${s}`);
try { db.close(); } catch {}

console.log('\n=== 2. analyze_monolith 跨文件社区圈定 ===');
const r = analyzeMonolith({ project_dir: aiBase, warn_lines: 300, crit_lines: 600 });
console.log(r.message);

console.log('\n=== 3. 结构化摘要（供人工核对） ===');
for (const c of r.communities) {
  const anchors = c.anchors.map((a) => a.split('#').pop()).join(', ');
  console.log(`社区[${c.id}] ${c.name} · ${c.symbol_count}符号/~${c.est_lines}行/${c.files.length}文件 · 锚点=${anchors || '-'}`);
  if (c.files.length > 1) console.log(`   跨文件: ${c.files.join(', ')}`);
}
console.log(`\n拆分候选 ${r.split_candidates.length} 个:`);
for (const f of r.split_candidates) console.log(`  → ${f}`);