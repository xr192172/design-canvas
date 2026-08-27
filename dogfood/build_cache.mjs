/**
 * dogfood: 为 design-canvas 自身构建符号缓存（.design-canvas/cache.db）
 *
 * 供诊断工具 self-diagnosis 使用：缓存 src/ 与 tests/ 的符号/调用边，
 * 之后 diagnose_cli --project <repo> 就能定位到符号级。
 *
 * 用法：node dogfood/build_cache.mjs [repoRoot]
 *   repoRoot 缺省 = 本脚本所在仓库根（design-canvas/）。
 *
 * 注意：isSupported() 接收的是【扩展名】（如 '.ts'），不是文件路径——
 * 传全路径会永远匹配不上，导致缓存 0 文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 从 dist 引入（tsc 产物，含 tree-sitter 解析器）
import { getProjectCacheDb, closeAllProjectCacheDbs } from '../dist/src/db/db.js';
import { syncProject } from '../dist/src/db/symbols.js';
import { isSupported } from '../dist/src/tools/ts_kernel/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] || path.join(here, '..'));

const skipDirs = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'output',
  'vendor', '__pycache__', '.design-canvas', 'coverage', 'target', 'bin', 'obj',
  '.next', '.nuxt', '.venv', 'venv', '.idea', '.vscode', '.backup', 'scaffold',
  '.pytest_cache', '.mypy_cache', '.tox', 'egg-info', '.trae',
]);

/** 收集 dir 下所有受支持文件（isSupported 吃扩展名！） */
function collect(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!skipDirs.has(e.name)) walk(p);
      } else if (isSupported(path.extname(p))) {
        files.push(p);
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return files;
}

// 覆盖 src（生产代码）+ tests（测试代码，诊断测试失败用）
const files = [...collect(path.join(root, 'src')), ...collect(path.join(root, 'tests'))];

const db = getProjectCacheDb(root);
const res = await syncProject(db, root, files);
closeAllProjectCacheDbs();

console.log(`[dogfood] 缓存 ${files.length} 个文件 -> ${path.join(root, '.design-canvas', 'cache.db')}`);
console.log(`[dogfood] updated=${res.updated} skipped=${res.skipped} ignored=${res.ignored} failed=${res.failed} ms=${res.ms}`);
console.log(`[dogfood] 跨文件调用: total=${res.cross?.total} resolved=${res.cross?.resolved} external=${res.cross?.external} failed=${res.cross?.failed}`);
if (res.failed > 0) {
  console.log('  解析失败文件:');
  for (const r of res.results.filter((x) => x.status === 'failed')) console.log(`    - ${r.path}: ${r.error}`);
}
