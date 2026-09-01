#!/usr/bin/env node
/**
 * check_contract_docs —— 契约变更闸门（方向二）
 *
 * 纪律：**契约变更才跟文档**（AGENTS「文档同步纪律」）。
 * 本脚本把这条从"人自觉"变成"提交前强制"：
 *   对比 HEAD 与工作区的 `src/server_registry.ts` 里注册工具名，
 *   若**新增**了对外 MCP 工具名，但它在任何文档（README / AGENTS / skill / docs）都未被提及
 *   → 判定"新增契约未同步文档"，阻断提交，附 `--no-verify` 逃生口。
 *
 * 用法：
 *   node scripts/check_contract_docs.mjs     # exit 0=通过；1=有未同步的契约（阻断）
 *   环境变量 SKIP_CONTRACT_CHECK=1 可强制跳过（紧急逃生）。
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

if (process.env.SKIP_CONTRACT_CHECK === '1') process.exit(0);

const root = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
function read(p) {
  try {
    return readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
}

/** 提取 server_registry 里的工具注册名（`name: 'xxx'` 或 `name: "xxx"`） */
const NAME_RE = /name:\s*['"]([a-z][a-z0-9_]*)['"]/g;
function toolNamesOf(src) {
  const set = new Set();
  let m;
  while ((m = NAME_RE.exec(src))) set.add(m[1]);
  return set;
}

const cur = toolNamesOf(read(path.join(root, 'src', 'server_registry.ts')));

// 对比 HEAD：拿不到(如首次提交无该文件) → 无法对比，直接放行
let prev = null;
try {
  prev = toolNamesOf(execSync('git show HEAD:src/server_registry.ts', { encoding: 'utf-8', cwd: root }));
} catch {
  process.exit(0);
}
if (!prev) process.exit(0);

const newNames = [...cur].filter((n) => !prev.has(n));
if (newNames.length === 0) process.exit(0);

// 收集所有"文档类"路径（README / AGENTS / CONTRIBUTING / skill / docs）
const docPaths = [];
const addDoc = (p) => {
  if (existsSync(p) && statSync(p).isFile()) docPaths.push(p);
};
for (const rel of ['README.md', 'README.en.md', 'AGENTS.md', 'CONTRIBUTING.md']) addDoc(path.join(root, rel));
const walk = (dir) => {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.md')) docPaths.push(p);
  }
};
walk(path.join(root, '.trae', 'skills'));
walk(path.join(root, 'docs'));

// 新工具名若在任一文档被提及 → 视为已同步；完全隐形(零提及) → 未同步，阻断
const missing = newNames.filter((name) => !docPaths.some((p) => read(p).includes(name)));

if (missing.length === 0) process.exit(0);

console.error('\n⚠️ 契约变更未同步文档（按「契约变更才跟文档」纪律阻断）：');
for (const n of missing) console.error(`  - 新增 MCP 工具名 "${n}" 未在任何文档（README/AGENTS/skill/docs）提及`);
console.error('请先在 AGENTS 触发点总表 / README / skill 路由补充该工具的入口；');
console.error('  - 若确实不需对外文档化，请用 `git commit --no-verify` 强制跳过，');
console.error('  - 或设置 `SKIP_CONTRACT_CHECK=1` 批量逃生。\n');
process.exit(1);