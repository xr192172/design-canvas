#!/usr/bin/env node
/**
 * rebuild_feature.mjs —— 权威重建命令（修复 feature 导图污染 + 恢复功能聚类的正式入口）
 *
 * 背景：design-canvas 曾因 getDataHome() 裸依赖 process.cwd()，当 MCP server /
 * serve / daemon 由工作区根等任意 cwd 拉起时，会把其它项目的 go-* 文件并进
 * 本 feature 的 DSL 与导图（"146 条 flows 污染"）。storage.ts 已修复为自省包根
 * 锚定；本命令提供配套的一键全链重建入口。
 *
 * 聚类的原理：结构导图是否按功能模块分组，取决于 DSL 里有没有 feature_tree。
 * feature_tree 由 derive_feature_tree 基于 cache.db（analyze_monolith）计算；
 * 所以必须先建 import_cache_<feature>.db（importProject 写符号缓存），再跑
 * deriveFeatureTree 写回 dsl.feature_tree，最后 deriveMindMap 才不平铺。
 *
 * 流程：
 *   1. openDb(import_cache_<feature>.db)   → 建/复用符号缓存库（增量解析）
 *   2. importProject(src, cache_db)        → 重建干净 features 存档 + DSL + cache.db
 *   3. deriveFeatureTree                    → 计算功能树并写回 dsl.feature_tree（LLM 有则归并命名，否则规则目录归并）
 *   4. deriveMindMap(teach)                → 重建科普教学导图 JSON
 *   5. deriveMindMap(structure)            → 重建结构导图 JSON + 自包含 HTML（浏览器验收用）
 *
 * 用法：
 *   node scripts/rebuild_feature.mjs [feature] [--src=<路径>]
 *   默认 feature=design-canvas，src=design-canvas 包根/src
 */
import path from 'node:path';
import { importProject } from '../dist/src/tools/import_project.js';
import { deriveMindMap } from '../dist/src/tools/derive_mind_map.js';
import { deriveFeatureTree } from '../dist/src/tools/derive_feature_tree.js';
import { openDb } from '../dist/src/db/db.js';
import { getPackageRoot, getStorageRoot } from '../dist/src/storage.js';

const args = process.argv.slice(2);
const feature = args.find((a) => !a.startsWith('--')) || 'design-canvas';
const srcArg = args.find((a) => a.startsWith('--src='));
const pkgRoot = getPackageRoot();
const src = srcArg ? srcArg.slice('--src='.length) : path.join(pkgRoot, 'src');

console.log(`=== rebuild_feature: ${feature} ===`);
console.log(`包根=${pkgRoot} 源码=${src}`);

const dbFile = path.join(getStorageRoot(), `import_cache_${feature}.db`);
let db;
try {
  db = openDb(dbFile);
  console.log(`缓存库=${dbFile}`);
} catch (e) {
  console.error(`打开缓存库失败: ${e.message}`);
  process.exit(1);
}

try {
  const imp = await importProject({ project_dir: src, feature, cache_db: db });
  console.log(`① importProject: ${imp.message.split('\n')[0]} | files=${imp.files_parsed} deps=${imp.dep_edges} cache=${imp.cache ? `${imp.cache.hits}hit/${imp.cache.reparsed}rep` : '-'}`);
} catch (e) {
  console.error(`importProject 失败: ${e.message}`);
  process.exit(1);
}

try {
  const ft = await deriveFeatureTree({ project_dir: src, feature, db, gen_names: true });
  console.log(`② deriveFeatureTree: ${ft.features.length} 个功能 · ${ft.file_count} 文件归属 · unassigned=${ft.unassigned_count}`);
  console.log(`   功能名: ${ft.features.map((f) => f.name).join(' | ') || '(无)'}`);
  if (ft.message) console.log(`   ${ft.message}`);
} catch (e) {
  console.error(`deriveFeatureTree 失败: ${e.message}`);
}

for (const view of ['structure']) {
  try {
    const r = await deriveMindMap({ feature, view });
    const files = (r.mind_map.root?.children ?? []).length;
    const flows = (r.mind_map.flows ?? []).length;
    console.log(`③ deriveMindMap(${view}): mode=${r.mode} topLevel=${files} flows=${flows}`);
    if (r.htmlFile) console.log(`   → HTML: ${r.htmlFile}`);
  } catch (e) {
    console.error(`deriveMindMap(${view}) 失败: ${e.message}`);
  }
}
console.log('=== 重建完成 ===');