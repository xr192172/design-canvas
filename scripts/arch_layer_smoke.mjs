// arch_layer 冒烟验证：对 design-canvas 自身做架构分层，看归属是否符合直觉
// 用法：npm run build && node scripts/arch_layer_smoke.mjs
import path from 'node:path';
import { importProject } from '../dist/src/tools/import_project.js';
import { archLayer } from '../dist/src/tools/arch_layer.js';
import { getDSL } from '../dist/src/storage.js';
import { openDb, closeAllProjectCacheDbs } from '../dist/src/db/db.js';

const ROOT = process.cwd();
const FEATURE = 'smoke_arch';

// 1. 建 DSL（含 file 节点）——复用 importProject 写入 feature
const db = openDb(path.join(ROOT, '.design-canvas', 'cache.db'));
const imp = await importProject({ project_dir: ROOT, feature: FEATURE, cache_db: db });
db.close();

// 1.5 验证 import_project 已集成架构分层：semantic.files[].layer 应已回填
const dsl = getDSL(FEATURE);
const withLayer = (dsl.semantic?.files ?? []).filter((f) => f.layer);
console.log(`[import] semantic.files=${dsl.semantic?.files?.length} layer 回填=${withLayer.length} dsl.layers=${dsl.layers?.length ?? 0}`);
if ((dsl.semantic?.files ?? []).length > 0 && withLayer.length === 0) {
  console.error('[FAIL] import_project 未回填 semantic.files[].layer');
  process.exit(1);
}

// 2. 架构分层分析（只读）
const r = archLayer({ feature: FEATURE });
console.log(r.message);
console.log(`[stats] total_files=${r.total_files} classified=${r.classified} layers=${r.layers.length}`);
console.log('[layers]', r.layers.map((l) => `${l.name}=${l.count}`).join(' '));
console.log(`[persisted]=${r.persisted}`);

// 3. 抽几个代表性文件核对归属
const want = ['src/db/db.ts', 'src/tools/import_project.ts', 'src/renderer/html_renderer.ts', 'src/server.ts', 'src/dsl/types.ts'];
for (const a of r.assignments) {
  if (a.path && want.includes(a.path)) {
    console.log(`  assign ${a.path} -> ${a.arch_layer}`);
  }
}

closeAllProjectCacheDbs();