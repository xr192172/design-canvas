#!/usr/bin/env node
/**
 * 批量导入开发环境核心项目 → design-canvas，并逐一生成 teach 科普导图。
 * 策略：
 *   - 只挑结构真实、规模适中的项目（超大/异常项目跳过，防宕机）
 *   - 每个项目 max_files 截断，避免巨型项目拖垮
 *   - 单个失败不中断，最后输出汇总表
 */
const path = require('path');
const fs = require('fs');
const { importProject } = require('../dist/src/tools/import_project.js');
const { deriveMindMap } = require('../dist/src/tools/derive_mind_map.js');
const { deriveFeatureTree } = require('../dist/src/tools/derive_feature_tree.js');
const { getDSL } = require('../dist/src/storage.js');
const { getProjectCacheDb } = require('../dist/src/db/db.js');

const ROOT = 'D:\\project_develop';

// 候选清单：{ 项目名, feature名(须 ^[a-zA-Z0-9_-]+$), max_files }
// 规模依据 scan_projects 实测；超大(>~2000文件)或多个异常大文件的项目不在此列
const CANDIDATES = [
  { name: 'mcp-file-intake',          max_files: 120 },
  { name: 'wet-mcp',                  max_files: 200 },
  { name: 'cross-border-scout',       max_files: 200 },
  { name: 'reasonix',                 max_files: 200 },
  { name: 'project-index',            max_files: 120 },
  { name: 'character-forge',          max_files: 120 },
];

function openCache(pdir) {
  const f = path.join(pdir, '.design-canvas', 'cache.db');
  try { if (fs.existsSync(f)) return getProjectCacheDb(pdir); } catch { /* 只读等跳过 */ }
  return undefined;
}

(async () => {
  const results = [];
  for (const c of CANDIDATES) {
    const pdir = path.join(ROOT, c.name);
    const feat = c.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const t0 = Date.now();
    try {
      const cacheDb = getProjectCacheDb(pdir);
      const imp = await importProject({
        feature: feat,
        title: c.name,
        project_dir: pdir,
        max_files: c.max_files,
        include_tests: false,
        cache_db: cacheDb,
      });
      const ft = await deriveFeatureTree({ feature: feat, project_dir: pdir, db: cacheDb, gen_names: true });
      console.log(`   ${c.name} 功能树: ${ft.message}`);
      // 生成 teach 导图（含专属描述/社区中文化/共享能力）—— 复用主项目同一套逻辑
      const mm = await deriveMindMap({ feature: feat, view: 'teach' });
      const dsl = getDSL(feat);
      const nFiles = dsl?.semantic?.files?.length ?? 0;
      const nFeat = mm.mind_map?.root?.children?.length ?? 0;
      results.push({ name: c.name, ok: true, files: nFiles, features: nFeat, mode: mm.mind_map?.mode, ms: Date.now() - t0 });
      console.log(`✓ ${c.name}: ${nFiles} 文件 / ${nFeat} 功能层, mode=${mm.mind_map?.mode}, 耗时 ${Date.now()-t0}ms`);
    } catch (e) {
      results.push({ name: c.name, ok: false, err: e.message, ms: Date.now() - t0 });
      console.log(`✗ ${c.name}: ${e.message}`);
    }
  }
  console.log('\n════ 汇总 ════');
  for (const r of results) {
    if (r.ok) console.log(`✓ ${r.name.padEnd(20)} ${r.files}文件/功能层${r.features} ${r.mode} ${r.ms}ms`);
    else console.log(`✗ ${r.name.padEnd(20)} 失败：${r.err}`);
  }
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n成功 ${ok}/${results.length}`);
})().catch((e) => { console.error('致命:', e); process.exit(1); });