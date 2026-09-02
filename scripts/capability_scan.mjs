#!/usr/bin/env node
/**
 * capability_scan —— 能力「语言指纹」扫描 + 声明漂移闸门
 *
 * 定位：能力矩阵的声明（register_capabilities.ts）是手写的，会与实现漂移。
 * 本脚本做**纯确定性扫描**（零 LLM），把"实现里到底在哪几门语言上、怎么实现的"
 * 变成机器可读的事实，并对比手写声明，输出**语义缺口提示**——
 * 语义判断（full/partial 覆盖度、要不要补）留给 LLM/人在迭代该功能时做。
 *
 * 三条机器可定的语法证据（按实现文件递归扫描 src/ 下 .ts）：
 *   A. `new Set(['typescript','tsx',...])`     语言名单载体（TS_FAMILY 等）
 *   B. `lang === 'go'` / `ext === '.py'`       显式语言分支
 *   C. `{ go: [...], typescript: [...] }`      语言 key 数组（COMPLEXITY_BRANCH_NODES 等）
 *   AST 判定：是否触达 parseAstRoot/parseFileFull/childForFieldName/walk
 *   onlyGeneric：无任何显式语言分支 → 全语言通用（parseFileFull 全语言），声明常写窄
 *
 * 两种模式：
 *   node scripts/capability_scan.mjs              # 常规：打印指纹 + 缺口提示（exit 0）
 *   node scripts/capability_scan.mjs --check      # CI 闸门：有缺口提示即 exit 1
 *   node scripts/capability_scan.mjs code_health  # 只扫指定 id
 *   SKIP_CAPABILITY_SCAN=1                        # 紧急跳过
 * 导出 scanFeature/scanFile/capDecl 供测试 import（root 参数由调用方传入）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const isMain =
  process.argv[1] && /capability_scan\.mjs$/.test(process.argv[1].replace(/\\/g, '/'));

/** 仓库根（直接执行时取 git 顶层） */
function repoRoot() {
  return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
}

// ── 功能 id → 实现位置（文件或目录；约定 id 与工程结构对应） ──
export const FEATURE_FILES = {
  ast_parse_skeleton: ['src/tools/ts_kernel'],
  package_migration: ['src/tools/package_migration.ts'],
  rename_symbol: ['src/tools/rename_symbol.ts'],
  contract_gate: ['src/tools/contract_gate.ts'],
  extract_contracts: ['src/tools/extract_contracts.ts'],
  version_upgrade_detection: ['src/version_upgrade'],
  impact_analysis: ['src/impact'],
  cross_repo_symbol_index: ['src/cross_repo'],
  hybrid_precheck: ['src/hybrid'],
  behavior_baseline: ['src/behavior'],
  code_health: ['src/health'],
};

// ── 语言名别名 → LANGUAGES.name 归一 ──
const LANG_ALIAS = {
  go: 'go', python: 'python', py: 'python',
  typescript: 'typescript', ts: 'typescript',
  tsx: 'tsx', javascript: 'javascript', js: 'javascript', jsx: 'jsx',
  java: 'java', php: 'php', rust: 'rust', c_sharp: 'c_sharp',
};

const AST_RE = /parseAstRoot|parseFileFull|childForFieldName|\.walk\(|walk\(ast/;
const REGEX_RE = /function\s+\w+Regex|\b\w+Regex\(/;
// 全语言解析 API：显式"对所有已装语言建解析/收集"→ 该功能实际对所有已装语言生效
const GENERIC_API_RE = /listSupportedExtensions|listSupported|LANGUAGES|parseFileFull|probeInstalled|installedLanguages/;

/** 递归收集目录下全部 .ts 相对路径；单文件原样返回 */
export function resolveFeatureFiles(rel, root) {
  const abs = path.join(root, rel);
  if (!statSync(abs).isDirectory()) return [rel];
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(path.relative(root, full).replace(/\\/g, '/'));
    }
  };
  walk(abs);
  return out;
}

/** 单个实现文件的语言指纹 */
export function scanFile(rel, root) {
  const src = readFileSync(path.join(root, rel), 'utf-8');
  const langs = new Set();
  const add = (raw) => {
    const n = LANG_ALIAS[String(raw).trim().replace(/^[.]/, '').toLowerCase()];
    if (n) langs.add(n);
  };
  // A. `new Set([...])` 语言名单
  for (const m of src.matchAll(/new\s+Set\(\[\s*((?:['"][^'"]+['"]\s*(?:,\s*)?)+)\]\)/g)) {
    for (const t of m[1].matchAll(/['"]([a-z_]+)['"]/g)) add(t[1]);
  }
  // B. `lang === 'go'` / `ext === '.py'`
  for (const m of src.matchAll(/(?:langName|lang|extension|ext)\s*[!=]==?\s*['"]([A-Za-z0-9_.]+)['"]/g)) {
    add(m[1]);
  }
  // C. `{ go: [...], typescript: [...] }` 语言 key 数组（COMPLEXITY_BRANCH_NODES 等）
  //    直接抓全文件所有 `key: [` 对，避开对象边界正则的停早问题
  for (const m of src.matchAll(/(?:[{,]\s*)['"]?([a-z_][a-z0-9_]*)['"]?\s*:\s*\[/g)) {
    add(m[1]);
  }
  return {
    path: rel,
    langs: [...langs].sort(),
    isAst: AST_RE.test(src),
    hasRegex: REGEX_RE.test(src),
    isGeneric: GENERIC_API_RE.test(src), // 显式调全语言解析 API → 对所有已装语言生效
  };
}

/** 从 register_capabilities.ts 提取某 id 的声明（文本正则，不 import TS） */
export function capDecl(id, root) {
  const reg = readFileSync(path.join(root, 'src/tools/register_capabilities.ts'), 'utf-8');
  const start = reg.indexOf(`id: '${id}'`);
  if (start < 0) return null;
  const block = reg.slice(start, start + 1600);
  return {
    def: /default:\s*'([^']+)'/.exec(block)?.[1] ?? null,
    overrides: new Map(
      [...block.matchAll(/([a-z_]+)\s*:\s*'(full_ast|partial_ast|regex_fallback)'/g)].map(
        (m) => [m[1], m[2]],
      ),
    ),
  };
}

/** 扫描一个功能：合并多实现文件 → 对比声明 → 缺口提示
 * @param id    功能 id（须在 FEATURE_FILES 或有 filesMap）
 * @param root  仓库根
 * @param filesMap 可选注入：覆盖 FEATURE_FILES（测试用），key=id → 相对路径数组
 */
export function scanFeature(id, root, filesMap = null) {
  const targets = filesMap?.[id] ?? FEATURE_FILES[id];
  const files = resolveFeatureFilesList(targets, root);
  const decl = capDecl(id, root);

  // 合并触及的语言（任一支实现触达即算）＋ 是否显式全语言解析
  const touched = new Set();
  let anyAst = false;
  const scans = files.map((rel) => {
    const s = scanFile(rel, root);
    for (const l of s.langs) touched.add(l);
    if (s.isAst) anyAst = true;
    return s;
  });
  const genericFile = scans.find((s) => s.isGeneric)?.path ?? null;

  const hints = [];
  if (decl) {
    for (const lang of touched) {
      const level = decl.overrides.get(lang) ?? decl.def;
      if (level !== 'full_ast' && level !== 'partial_ast') {
        // 实现已触达该语言（有 AST 分支），但声明连 partial 都没有 → 确定漏登记应阻断
        hints.push({ level: 'warn', text: `【${lang}】实现有分支而声明=${level}（漏登记，请校正为 full_ast / partial_ast）` });
      }
    }
    // 物证式全语言解析：声明可能低估（对所有已装语言生效但只列部分）→ 语义待决，仅提示
    if (genericFile && decl.overrides.size > 0 && decl.def !== 'full_ast') {
      hints.push({ level: 'info', text: `实现含全语言解析 API（见 ${genericFile}）→ 对所有已装语言生效；声明只覆盖 ${[...decl.overrides.keys()].join('/')}，请确认是否写窄` });
    }
  } else {
    hints.push({ level: 'warn', text: `未找到手写声明（capDecl 无此 id）` });
  }

  return { id, files, scans, decl, touched: [...touched].sort(), genericFile, anyAst, hints };
}

function resolveFeatureFilesList(targets, root) {
  if (!targets) return [];
  return targets.flatMap((t) => resolveFeatureFiles(t, root));
}

/** 人类可读文本（默认出口） */
export function renderScan(r) {
  const lines = [`=== ${r.id} ===`];
  lines.push(`实现文件: ${(r.files ?? []).length} 个${r.scans.length ? '' : '（未映射）'}`);
  for (const s of r.scans) {
    const langStr = s.isGeneric
      ? `（含全语言解析 API → 对所有已装语言生效）`
      : s.langs.map((l) => `${l}(AST)`).join(' ');
    lines.push(`  ${s.path}: ${langStr}  AST=${s.isAst} regexFallback=${s.hasRegex}`);
  }
  if (r.decl) {
    const ov = [...r.decl.overrides.entries()].map(([k, v]) => `${k}:${v}`).join(' ');
    lines.push(`声明 default=${r.decl.def} overrides=${ov || '(无)'}`);
  }
  if (r.hints.length) {
    lines.push(`缺口提示（warn=应阻断 / info=仅提示需语义确认）:`);
    for (const h of r.hints) lines.push(`  [${h.level}] → ${h.text}`);
  }
  return lines.join('\n');
}

// 直接执行才跑
if (isMain) {
  if (process.env.SKIP_CAPABILITY_SCAN === '1') process.exit(0);
  const root = repoRoot();
  const check = process.argv.includes('--check');
  const targets = process.argv.slice(2).filter((a) => a !== '--check');
  const ids = targets.length ? targets : Object.keys(FEATURE_FILES);
  const allHints = [];
  for (const id of ids) {
    if (!FEATURE_FILES[id]) {
      console.error(`未知功能 id: ${id}（可选：${Object.keys(FEATURE_FILES).join(', ')}）`);
      process.exitCode = 1;
      continue;
    }
    const r = scanFeature(id, root);
    console.log(renderScan(r));
    for (const h of r.hints) allHints.push({ id, level: h.level, text: h.text });
  }
  const blockers = allHints.filter((h) => h.level === 'warn' || h.level === 'error');
  if (check && blockers.length > 0) {
    console.error(`\n[capability_scan] 发现 ${blockers.length} 条确定漏登记（--check，阻断）：`);
    for (const h of blockers) console.error(`  · ${h.id}: ${h.text}`);
    console.error('人工校验：是声明写窄/低估 → 校正 register_capabilities.ts；实现更改 → 据此补实现或纠声明。');
    process.exit(1);
  }
  const infos = allHints.filter((h) => h.level === 'info');
  if (check && infos.length > 0) {
    console.error(`\n[capability_scan] ${infos.length} 条语义待决提示（不阻断，建议人工确认）：`);
    for (const h of infos) console.error(`  · ${h.id}: ${h.text}`);
  }
  console.log('\n[capability_scan] 完成（--check 时：无 `发现 N 条确定漏登记` 即通过）。');
}