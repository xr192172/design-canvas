/**
 * P3 端到端验证：在真实项目 agent-shell（ai-base 的 Go 主干）上，
 * 把 analyze_monolith 的 community_subsplit 评估结果接到 derive_split，
 * 自动执行社区内二次拆分（dry_run=true，只出草稿不落盘）。
 *
 * 目的：验证"评估结果 → 自动拆"链路在真实 Go 项目上运行正确，
 * 且拆分草稿语法/编译可通过（不污染真实项目代码）。
 *
 * 运行: node scripts/verify_subsplit_e2e.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { openDb } from '../dist/src/db/db.js';
import { importProject } from '../dist/src/tools/import_project.js';
import { analyzeMonolith } from '../dist/src/tools/analyze_monolith.js';
import { deriveSplit } from '../dist/src/tools/derive_split.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const agentShell = path.resolve(here, '..', '..', 'ai-base', 'agent-shell');

console.log('=== 1. 建立 agent-shell 索引（cache.db，project_dir=模块根） ===');
fs.mkdirSync(path.join(agentShell, '.design-canvas'), { recursive: true });
const db = openDb(path.join(agentShell, '.design-canvas', 'cache.db'));
db.exec('DELETE FROM nodes; DELETE FROM edges; DELETE FROM files;');
const imp = await importProject({
  project_dir: agentShell,
  feature: '_verify',
  max_files: 400,
  cache_db: db,
  live_only: true,
  live_dir: agentShell,
});
console.log(`  收录 ${imp.files_parsed} 文件，符号 ${imp.symbols_found}，依赖边 ${imp.dep_edges}` +
  (imp.cache ? `，缓存 hits=${imp.cache.hits} reparsed=${imp.cache.reparsed} failed=${imp.cache.failed}` : ''));
try { db.close(); } catch {}

console.log('\n=== 2. analyze_monolith 社区分析 + 社区内子拆分评估 ===');
const r = analyzeMonolith({ project_dir: agentShell, warn_lines: 300, crit_lines: 600 });
console.log(`社区 ${r.community_count} 个，符号 ${r.symbol_count}，拆分候选 ${r.split_candidates.length} 个`);

const splittable = r.community_subsplit.filter((s) => s.splittable && s.groups.length >= 2);
console.log(`\n建议再拆社区 ${splittable.length} 个：`);
for (const s of splittable) {
  console.log(`  [${s.community_id}] ${s.community_name} · ${s.note}`);
  for (const g of s.groups) console.log(`      · ${g.owner}: ${g.symbols.length} 方法 / ~${g.est_lines} 行 / ${g.files.join(', ')}`);
}

console.log('\n=== 3. derive_split 消费 community_subsplit，自动二次拆分（dry_run） ===');
let total = 0;
let ok = 0;
for (const s of splittable) {
  console.log(`\n--- 社区 ${s.community_name} ---`);
  const dr = await deriveSplit({
    project_dir: agentShell,
    target_file: '',
    symbols: [],
    subsplit: [s],
    dry_run: true,
  });
  for (const item of dr.subsplit ?? []) {
    total++;
    if (item.ok) ok++;
    console.log(`  [${item.community_name}] ${item.owner}（${item.method_count} 方法）→ ${item.new_file}：${item.ok ? 'OK' : 'FAILED · ' + item.note}`);
  }
}
console.log(`\n=== 汇总：${total} 次自动拆分，成功 ${ok}，失败 ${total - ok}（dry_run，未落盘） ===`);