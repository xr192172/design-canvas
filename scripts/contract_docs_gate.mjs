#!/usr/bin/env node
/**
 * check_contract_docs —— 契约变更闸门（方向二：新增 + 改名残留）
 *
 * 纪律：**契约变更才跟文档**（AGENTS「文档同步纪律」）。
 * 本脚本把这条从"人自觉"变成"提交前强制"：
 *   ① 新增契约未同步：对比 HEAD 与工作区 server_registry 注册工具名，若**新增**了对外
 *      MCP 工具名，但它在任何文档（README / AGENTS / skill / docs 非历史）都零提及
 *      → 判定"新增契约未同步文档"，阻断提交。
 *   ② 改名残留未清：工具名**消失**了（改名/删除），但旧名仍残留在「可同步」文档
 *      （docs 非历史、README、AGENTS、skill、测试断言、错误提示串）里 → 判定"改名残留
 *      未同步"，阻断提交。与 AGENTS「文档同步纪律」呼应：改契约必须同步文档，残留=说谎。
 *
 * 语义边界（低误报优先）：
 *   - **历史记录不拦**：docs/tool-convergence.md 等的历史决策/核验记录是事实，保留旧名
 *     属正确原貌，不算残留（对应 report_literals 的 history kind 同理不拦）。
 *   - 只拦「可同步」处的残留：非历史 docs、README/AGENTS/skill、测试断言、源码错误串。
 *
 * 用法：
 *   node scripts/contract_docs_gate.mjs     # exit 0=通过；1=有未同步的契约/残留（阻断）
 *   环境变量 SKIP_CONTRACT_CHECK=1 可强制跳过（紧急逃生）。--fix 仅提示不拦（调试）。
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { parseAstRoot } from '../dist/src/tools/ts_kernel/kernel.js';

// ── 常量/工具（顶层，供导出函数与 CLI 共用） ──
const NAME_RE = /name:\s*['"]([a-z][a-z0-9_]*)['"]/g;
const READ_RE = /\.(ts|tsx)$/;
const HISTORY_RE = /([\\/])tool-convergence(\.md|$)|([\\/])plans[\\/]/;

function read(p) {
  try {
    return readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
}

/** 提取 server_registry 里的工具注册名（`name: 'xxx'` 或 `name: "xxx"`） */
export function toolNamesOf(src) {
  const set = new Set();
  let m;
  while ((m = NAME_RE.exec(src))) set.add(m[1]);
  return set;
}

const isHistory = (rel) => HISTORY_RE.test(rel.replace(/\\/g, '/'));

/** 收集「可同步文本」集合：文档(md/skill)+代码(ts/tsx)，代码用 AST 走字符串/注释文案 */
async function collectSyncSet(root) {
  const syncSet = []; // { path, label }
  const seenPath = new Set();
  const addSync = (p, rel) => {
    if (!seenPath.has(p)) {
      seenPath.add(p);
      syncSet.push({ path: p, label: rel });
    }
  };
  // 顶层文档
  for (const rel of ['README.md', 'README.en.md', 'AGENTS.md', 'CONTRIBUTING.md']) addSync(path.join(root, rel), rel);
  // skill + docs 递归 .md
  const collectMd = (dir, into) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) collectMd(path.join(dir, e.name), into);
      else if (e.name.endsWith('.md')) into.push({ path: path.join(dir, e.name), label: path.relative(root, path.join(dir, e.name)).split(path.sep).join('/') });
    }
  };
  const skillDocs = [];
  const docDocs = [];
  collectMd(path.join(root, '.trae', 'skills'), skillDocs);
  collectMd(path.join(root, 'docs'), docDocs);
  for (const d of skillDocs) addSync(d.path, d.label);
  for (const d of docDocs) if (!isHistory(d.label)) addSync(d.path, d.label); // 历史不列入可同步
  // src/tests 代码文件
  const walkCode = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walkCode(path.join(dir, e.name));
      else if (READ_RE.test(e.name)) addSync(path.join(dir, e.name), path.relative(root, path.join(dir, e.name)).split(path.sep).join('/'));
    }
  };
  walkCode(path.join(root, 'src'));
  walkCode(path.join(root, 'tests'));

  // 代码文件文案缓存（AST 字符串/注释）
  const codeCache = new Map();
  const codeTextsOf = async (p) => {
    if (codeCache.has(p)) return codeCache.get(p);
    let texts = [];
    try {
      const content = readFileSync(p, 'utf-8');
      const ast = await parseAstRoot(p, content);
      if (ast) {
        const frags = [];
        const walk = (n) => {
          const t = n.type || '';
          if (t === 'string_fragment' || t === 'comment') frags.push(n.text);
          for (let i = 0; i < n.childCount; i++) { const c = n.child(i); if (c) walk(c); }
        };
        walk(ast.root);
        texts = frags;
      } else {
        texts = content.split('\n'); // AST 不可用 → 退化整行（保守）
      }
    } catch {
      texts = [];
    }
    codeCache.set(p, texts);
    return texts;
  };
  // 判定命中：文档直接 includes；代码用 AST 文案
  const mentions = async (d, name) => (READ_RE.test(d.path) ? (await codeTextsOf(d.path)).some((t) => t.includes(name)) : read(d.path).includes(name));
  return { syncSet, mentions };
}

/**
 * 契约闸门核心：给定新增/消失的工具名，判断是否「契约变更未同步文档」。
 * @param root 项目根
 * @param newNames 新增工具名（相对 HEAD）
 * @param goneNames 消失工具名（改名/删除，旧名）
 * @returns { ok, missingNew, residueList }
 */
export async function runContractGate(root, newNames, goneNames) {
  if ((newNames?.length ?? 0) === 0 && (goneNames?.length ?? 0) === 0) return { ok: true, missingNew: [], residueList: [] };
  const { syncSet, mentions } = await collectSyncSet(root);
  const missingNew = [];
  for (const name of newNames) {
    let ok = false;
    for (const d of syncSet) if (await mentions(d, name)) { ok = true; break; }
    if (!ok) missingNew.push(name);
  }
  const residueList = [];
  for (const name of goneNames) {
    for (const d of syncSet) if (await mentions(d, name)) residueList.push({ name, file: d.label });
  }
  return { ok: missingNew.length === 0 && residueList.length === 0, missingNew, residueList };
}

// ── CLI 入口（仅作为脚本直接执行时跑） ──
const isEntry = process.argv[1] && /contract_docs_gate\.(js|mjs)$/.test(process.argv[1].replace(/\\/g, '/'));
if (isEntry) {
  if (process.env.SKIP_CONTRACT_CHECK === '1') process.exit(0);
  const root = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  const cur = toolNamesOf(read(path.join(root, 'src', 'server_registry.ts')));
  // 对比 HEAD：拿不到(如首次提交/文件不在) → 放行
  let prev = null;
  try {
    prev = toolNamesOf(execSync('git show HEAD:src/server_registry.ts', { encoding: 'utf-8', cwd: root }));
  } catch {
    process.exit(0);
  }
  if (!prev) process.exit(0);
  const newNames = [...cur].filter((n) => !prev.has(n));
  const goneNames = [...prev].filter((n) => !cur.has(n));
  const { ok, missingNew, residueList } = await runContractGate(root, newNames, goneNames);
  if (ok) process.exit(0);
  console.error('\n⚠️ 契约变更未同步文档（按「契约变更才跟文档」纪律阻断）：');
  for (const n of missingNew) {
    console.error(`  - 新增 MCP 工具名 "${n}" 未在任何同步文本（README/AGENTS/skill/docs非历史/测试/错误串）提及`);
  }
  for (const r of residueList) {
    console.error(`  - 改名前旧名 "${r.name}" 仍残留在 ${r.file}`);
  }
  console.error('请先同步文档：新增工具 → 补 AGENTS 触发点总表 / README / skill 路由；改名残留 → 定位并更新到新名。');
  console.error('  - 历史决策记录（docs/tool-convergence.md / docs/plans/*）保留旧名属事实，不在此列；');
  console.error('  - 若确实不需对外文档化，请用 `git commit --no-verify` 强制跳过，');
  console.error('  - 或设置 `SKIP_CONTRACT_CHECK=1` 批量逃生。\n');
  process.exit(1);
}