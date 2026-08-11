/**
 * P3 端到端真实执行验证：在 agent-shell（ai-base Go 主干）的临时副本上，
 * 消费 community_subsplit，用 derive_split 真正落盘拆分（dry_run=false），
 * 并跑 go build / go test 验证拆分后模块仍编译通过、测试通过。
 *
 * 在临时副本上执行，不污染真实 ai-base 项目。
 *
 * 运行: node scripts/verify_subsplit_e2e_exec.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openDb } from '../dist/src/db/db.js';
import { importProject } from '../dist/src/tools/import_project.js';
import { analyzeMonolith } from '../dist/src/tools/analyze_monolith.js';
import { deriveSplit } from '../dist/src/tools/derive_split.js';

const execAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const agentShell = path.resolve(here, '..', '..', 'ai-base', 'agent-shell');

/** 临时副本，跳过大/无关目录 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'as_e2e_exec_'));
const copyExclude = new Set(['.git', '_archive', '.project-index', '.project-index.cache', '.design-canvas', 'shots', 'docs']);
fs.cpSync(agentShell, tmp, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(agentShell, src);
    const seg = rel.split(path.sep)[0];
    if (seg && copyExclude.has(seg)) return false;
    return true;
  },
});
console.log(`临时副本: ${tmp}`);

console.log('\n=== 1. 建立副本索引 ===');
const db = openDb(path.join(tmp, '.design-canvas', 'cache.db'));
const imp = await importProject({ project_dir: tmp, feature: '_verify', max_files: 400, cache_db: db, live_only: true, live_dir: tmp });
console.log(`  收录 ${imp.files_parsed} 文件，符号 ${imp.symbols_found}，依赖边 ${imp.dep_edges}`);
try { db.close(); } catch {}

console.log('\n=== 2. 分析 + 社区内子拆分评估 ===');
const r = analyzeMonolith({ project_dir: tmp, warn_lines: 300, crit_lines: 600 });
const splittable = r.community_subsplit.filter((s) => s.splittable && s.groups.length >= 2);
console.log(`建议再拆社区 ${splittable.length} 个`);

console.log('\n=== 3. derive_split 真实落盘二次拆分（dry_run=false + 编译/测试验收） ===');
let total = 0, ok = 0;
for (const s of splittable) {
  const dr = await deriveSplit({ project_dir: tmp, target_file: '', symbols: [], subsplit: [s], dry_run: false });
  for (const item of dr.subsplit ?? []) {
    total++;
    if (item.ok) ok++;
    console.log(`  [${item.community_name}] ${item.owner}（${item.method_count} 方法）→ ${item.new_file}：${item.ok ? 'OK' : 'FAILED · ' + item.note}`);
  }
}
console.log(`\n拆分：${total} 次，成功 ${ok} / 失败 ${total - ok}`);

console.log('\n=== 4. 全模块 go build + go test `go vet` 级验证 ===');
for (const cmd of ['go build ./...', 'go test ./...']) {
  try {
    await execAsync(cmd, { cwd: tmp, shell: true, timeout: 600000, windowsHide: true });
    console.log(`  ${cmd} → 通过`);
  } catch (e) {
    const err = e;
    console.log(`  ${cmd} → 失败`);
    console.log((((err).stdout || '') + (err).stderr || '').trim().split('\n').slice(0, 25).map((l) => `     ${l}`).join('\n'));
  }
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`\n临时副本已清理: ${tmp}`);