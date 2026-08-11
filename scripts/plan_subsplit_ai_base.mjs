/**
 * 生成 ai-base 拆分规划报告（只读，不写真实项目）。
 *
 * 在 agent-shell 的临时副本上建索引 → analyze_monolith 圈出可再拆社区 →
 * 按 runSubSplit 的命名规则推导每个 owner/文件单元的目标新文件与将抽取的方法清单，
 * 输出一份 PM 可审阅的 markdown 报告到 docs/split-plan-ai-base.md。
 *
 * 运行: node scripts/plan_subsplit_ai_base.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { openDb } from '../dist/src/db/db.js';
import { importProject } from '../dist/src/tools/import_project.js';
import { analyzeMonolith } from '../dist/src/tools/analyze_monolith.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const agentShell = path.resolve(here, '..', '..', 'ai-base', 'agent-shell');
const outPath = path.resolve(here, '..', 'docs', 'split-plan-ai-base.md');

/** 临时副本，跳过大/无关目录 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'as_split_plan_'));
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

const db = openDb(path.join(tmp, '.design-canvas', 'cache.db'));
const imp = await importProject({ project_dir: tmp, feature: '_plan', max_files: 400, cache_db: db, live_only: true, live_dir: tmp });
try { db.close(); } catch {}

const r = analyzeMonolith({ project_dir: tmp, warn_lines: 300, crit_lines: 600 });
const splittable = r.community_subsplit.filter((s) => s.splittable && s.groups.length >= 2);

/** 每个 owner 的方法按文件分组 → 推导目标新文件 */
function planUnit(owner, methods) {
  const byFile = new Map();
  for (const m of methods) {
    const arr = byFile.get(m.file) ?? [];
    arr.push(m.name);
    byFile.set(m.file, arr);
  }
  return [...byFile.entries()].map(([file, names]) => {
    const base = path.posix.basename(file).replace(/\.[^.]+$/, '');
    const ext = path.extname(file);
    const newFile = path.posix.join(path.posix.dirname(file), `${base}_${owner}${ext}`);
    return { file, newFile, names };
  });
}

const lines = [];
lines.push('# ai-base 拆分规划报告');
lines.push('');
lines.push(`> 生成时间：${new Date().toLocaleString('zh-CN')} · 只读分析（临时副本，未改真实项目）`);
lines.push(`> 索引：${imp.files_parsed} 文件 / ${imp.symbols_found} 符号 / ${imp.dep_edges} 依赖边 · 建议再拆社区 ${splittable.length} 个 · 计划拆分单元 ${splittable.reduce((a, s) => a + s.groups.reduce((b, g) => b + planUnit(g.owner, g.methods).length, 0), 0)} 个`);
lines.push('');
lines.push('> 说明：每个"单元"= 一个 owner 在**一个文件**里的一组方法，将抽到同目录新文件 `${basename}_${owner}${ext}`。');
lines.push('> 是否执行取决于你确认；确认后由 derive_split 落盘 + 编译/测试级验收，失败自动回滚。');
lines.push('');

if (splittable.length === 0) {
  lines.push('无可再拆社区。');
} else {
  let idx = 0;
  for (const s of splittable) {
    lines.push(`## 社区 ${s.community_id}：${s.community_name}`);
    lines.push('');
    lines.push(`> ${s.note}`);
    lines.push('');
    for (const g of s.groups) {
      const units = planUnit(g.owner, g.methods);
      lines.push(`### ${g.owner}（${g.symbols.length} 方法 / 约 ${g.est_lines} 行）`);
      lines.push('');
      for (const u of units) {
        idx++;
        lines.push(`- **单元 ${idx}**：${u.file} → ${u.newFile}`);
        lines.push(`  - 抽取 ${u.names.length} 个方法：${u.names.join(', ')}`);
      }
      lines.push('');
    }
  }
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
console.log(`报告已生成: ${outPath}`);
console.log(`建议再拆社区 ${splittable.length} 个，计划拆分单元 ${lines.filter((l) => l.startsWith('- **单元')).length} 个`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}