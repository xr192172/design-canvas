// diff_impact 冒烟验证 D1：对 design-canvas 自身改 db.ts，看受影响范围是否符合直觉
// 用法：npm run build && node scripts/diff_impact_smoke.mjs
import fs from 'node:fs';
import path from 'node:path';
import { importProject } from '../dist/src/tools/import_project.js';
import { diffImpact } from '../dist/src/tools/diff_impact.js';
import { openDb, closeAllProjectCacheDbs } from '../dist/src/db/db.js';

const ROOT = process.cwd();
const FEATURE = 'smoke_diff';
const CACHE = path.join(ROOT, '.design-canvas', 'cache.db');

// 1. 建符号缓存（含调用边）
const db = openDb(CACHE);
const imp = await importProject({ project_dir: ROOT, feature: FEATURE, cache_db: db });
db.close();
console.log(`[build-cache] files=${imp.files_parsed} symbols=${imp.symbols_found} dep_edges=${imp.dep_edges} cache=${JSON.stringify(imp.cache)}`);

// 2. 变更影响分析：改 db.ts（谁 import 了它 / 谁调用了它的符号）
for (const changed of [
  ['src/db/db.ts'],
  ['src/db/db.ts', 'src/db/schema.ts'],
]) {
  console.log(`\n########## changed = ${changed.join(', ')} ##########`);
  const r = diffImpact({ feature: FEATURE, project_dir: ROOT, changed, direction: 'callers', max_depth: 3 });
  console.log(r.message);
  console.log(`[stats] call_edges=${r.has_call_edges} impacted_files=${r.impacted_files.length} symbols=${r.impacted_symbols.length}`);
}

closeAllProjectCacheDbs();