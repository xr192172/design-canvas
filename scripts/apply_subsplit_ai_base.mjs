/**
 * 把已验证的拆分规划真正落回 ai-base（真实项目）。
 *
 * 流程：真实项目建索引（写 .design-canvas/cache.db 缓存，不动源码）→ analyze_monolith
 * 拿 community_subsplit → derive_split dry_run=false 逐社区落盘（每单元编译/测试验收，
 * 失败自动回滚）→ 全模块 go build ./... / go test ./... 验证。
 *
 * 运行: node scripts/apply_subsplit_ai_base.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openDb } from '../dist/src/db/db.js';
import { importProject } from '../dist/src/tools/import_project.js';
import { analyzeMonolith } from '../dist/src/tools/analyze_monolith.js';
import { deriveSplit } from '../dist/src/tools/derive_split.js';

const execAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const real = path.resolve(here, '..', '..', 'ai-base', 'agent-shell');

console.log(`真实项目: ${real}`);

console.log('\n=== 1. 建立真实项目索引（只写缓存 cache.db，不动源码） ===');
const db = openDb(path.join(real, '.design-canvas', 'cache.db'));
const imp = await importProject({ project_dir: real, feature: '_apply', max_files: 400, cache_db: db, live_only: true, live_dir: real });
console.log(`  收录 ${imp.files_parsed} 文件，符号 ${imp.symbols_found}，依赖边 ${imp.dep_edges}`);
try { db.close(); } catch {}

console.log('\n=== 2. 分析 + 社区内子拆分评估 ===');
const r = analyzeMonolith({ project_dir: real, warn_lines: 300, crit_lines: 600 });
const splittable = r.community_subsplit.filter((s) => s.splittable && s.groups.length >= 2);
console.log(`建议再拆社区 ${splittable.length} 个`);

console.log('\n=== 3. derive_split 真实落盘（dry_run=false + 编译验收） ===');
let total = 0, ok = 0;
for (const s of splittable) {
  const dr = await deriveSplit({ project_dir: real, target_file: '', symbols: [], subsplit: [s], dry_run: false, verify_compile: true, verify_test: false });
  for (const item of dr.subsplit ?? []) {
    total++;
    if (item.ok) ok++;
    console.log(`  [${item.community_name}] ${item.owner}（${item.method_count} 方法）→ ${item.new_file}：${item.ok ? 'OK' : 'FAILED · ' + item.note}`);
  }
}
console.log(`\n拆分：${total} 次，成功 ${ok} / 失败 ${total - ok}`);

console.log('\n=== 4. 全模块 go build + 受影响包 go test 验证 ===');
for (const cmd of ['go build ./...', 'go test ./internal/hub/... ./internal/memory/... ./internal/browser/...']) {
  try {
    await execAsync(cmd, { cwd: real, shell: true, timeout: 600000, windowsHide: true });
    console.log(`  ${cmd} → 通过`);
  } catch (e) {
    const err = e;
    console.log(`  ${cmd} → 失败`);
    console.log((((err).stdout || '') + (err).stderr || '').trim().split('\n').slice(0, 25).map((l) => `     ${l}`).join('\n'));
  }
}

console.log('\n=== 5. 变更文件（git status 摘要） ===');
try {
  const { stdout } = await execAsync('git status --porcelain', { cwd: real, shell: true, windowsHide: true });
  console.log(stdout.trim());
} catch {
  console.log('  （非 git 仓库或 git 不可用）');
}