/**
 * health —— 代码健康度（死代码 / 复杂度 / 分层违规）
 *
 * 守护"积木 / 契约 / 胶水"三分层哲学，是项目杂交"选材体检"的评分依据：
 *   1. 死代码   ：未使用导出（复用调用边/类型引用边反查）+ 未使用 import + 孤儿文件
 *   2. 复杂度   ：顶层函数/方法圈复杂度启发式（阈值默认 10）
 *   3. 分层违规 ：依赖方向向上（低层 import 高层）→ 破坏分层
 *
 * 分层语义（依赖应自上而下流动，违规 = 向上依赖）：
 *   胶水层(2) → 积木层(1) → 契约层(0)
 *     · 胶水 → 积木 / 胶水 → 契约 / 积木 → 契约   正常
 *     · 契约 → 积木 / 契约 → 胶水 / 积木 → 胶水   违规（低层反向依赖高层）
 *   分类启发式：路径命中契约/胶水特征即归类，其余默认积木。
 *
 * 复用：collectSourceFiles + ts_kernel parseFileFull（与 impact 同一解析路径）；
 * 跨文件符号引用按"导出名唯一"匹配（沿用 impact 保守语义：重名不建边，避免误报）。
 *
 * v1 边界（诚实标注）：
 *   - 未使用导出/孤儿文件：项目内不可见引用即报，但"外部消费者"（包边界公共 API）
 *     看不见 → 一律标 potential（info），不自动删。
 *   - 未使用 import：tree-sitter AST 提取本地绑定名（TS/JS 家族 + Python），与全文件
 *     标识符/类型标识符使用集比对；Go 不提取（Go 未用 import 本就是编译错）。
 *   - 复杂度：tree-sitter AST 树遍历按分支节点计数（if/elif/for/while/switch-case/
 *     catch/except/三元/&&/||），注释/字符串天然不进 AST 不再污染计数（原正则启发式已废弃）。
 *   - 未使用导出只查函数/类/接口/类型等可调用符号；顶层 const 跳过（模块级常量被函数/
 *     模块读取是常态，且解析器不提取"变量读"边，反查永远查不到 → 直接不报，避免噪音）。
 *   - 解析器只建"函数体内"的调用边，模块级引用（入口文件底部 `main();` / 模块级 IIFE）不建边；
 *     unused_export 用"同文件文本存在性"兜底：符号名出现在定义行之外即视为被引用（保守方向，
 *     宁漏不误报；跨文件的模块级调用仍会漏——报 info 级仅提示，不自动删）。
 */

import path from 'node:path';
import { parseFileFull, parseAstRoot, listSupportedExtensions, type ParsedSymbol, type SyntaxNodeLike } from '../tools/ts_kernel/index.js';
import { collectSourceFiles } from '../version_upgrade/detect.js';

// ── 对外类型 ─────────────────────────────────────────────────

export type Layer = 'contract' | 'brick' | 'glue';

export type HealthKind =
  | 'unused_export'
  | 'unused_import'
  | 'orphan_file'
  | 'high_complexity'
  | 'layer_violation';

export type HealthSeverity = 'error' | 'warn' | 'info';

export interface HealthIssue {
  kind: HealthKind;
  severity: HealthSeverity;
  /** 相对 root */
  file: string;
  line?: number;
  symbol?: string;
  message: string;
  /** 额外证据（如复杂度分数 / 被 import 的高层文件 / 未用 import 的模块） */
  evidence?: string;
}

export interface ComplexityEntry {
  file: string;
  symbol: string;
  line: number;
  complexity: number;
}

export interface HealthReport {
  root: string;
  fileCount: number;
  issues: HealthIssue[];
  counts: Record<HealthKind, number>;
  /** 超阈值函数（按复杂度降序，最多 top 个） */
  complexity: ComplexityEntry[];
  layers: { contract: number; brick: number; glue: number; violations: number };
  /** 0-100 健康分 + 等级 */
  score: number;
  grade: 'A' | 'B' | 'C' | 'D';
  summary: string;
}

export interface HealthOptions {
  /** 复杂度阈值（默认 10） */
  complexityThreshold?: number;
  /** 复杂度清单最多列多少个（默认 10） */
  top?: number;
}

// ── 分层分类 ─────────────────────────────────────────────────

const CONTRACT_HINTS: RegExp[] = [
  /\/contracts?\//,
  /\/types\//,
  /\/interfaces?\//,
  /\/dto\//,
  /(^|\/)types\.(ts|tsx|js|mjs)$/,
  /\.types\./,
  /_types\./,
  /\.d\.ts$/,
];

const GLUE_HINTS: RegExp[] = [
  /\/glue\//,
  /\/routes?\//,
  /\/middleware\//,
  /\/config\//,
  /\/entry\//,
  /(^|\/)main\.(ts|tsx|js|jsx|mjs)$/,
  /(^|\/)app\.(ts|tsx|js|jsx)$/,
  /(^|\/)server(\.|$)/,
  /_cli\.(ts|js|mjs)$/,
  /server_registry\./,
  /hub\.mjs$/,
];

const LAYER_ORDER: Record<Layer, number> = { contract: 0, brick: 1, glue: 2 };

/** 按路径启发式给文件分层（未命中特征默认积木层） */
export function classifyLayer(rel: string): Layer {
  if (CONTRACT_HINTS.some((re) => re.test(rel))) return 'contract';
  if (GLUE_HINTS.some((re) => re.test(rel))) return 'glue';
  return 'brick';
}

// ── 复杂度（tree-sitter AST 遍历计数）────────────────────────

/** TS/JS 家族语言名（共享同一套 AST 节点结构） */
const TS_FAMILY = new Set(['typescript', 'tsx', 'javascript', 'jsx']);

/**
 * 各语言"分支/决策"节点类型（每个 +1）——节点名实测（_dbg_ast*.mjs）：
 *   · TS/JS：if/for/for-in/while/do/switch(+case)/catch/三元
 *   · Go：if/for/switch(+case)/select（default 不计——圈复杂度按 case 分支数）
 *   · Python：if/for/while/match(+case)/except/三元（conditional_expression）
 * else if / elif 在 AST 里是嵌套 if_statement（或 elif_clause 挂在 if 下），
 * 计数与原正则"每个 if 关键字 +1"语义一致；注释/字符串天然不进 AST 不再污染。
 */
const COMPLEXITY_BRANCH_NODES: Record<string, string[]> = {
  typescript: ['if_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement', 'switch_statement', 'switch_case', 'catch_clause', 'ternary_expression'],
  tsx: ['if_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement', 'switch_statement', 'switch_case', 'catch_clause', 'ternary_expression'],
  javascript: ['if_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement', 'switch_statement', 'switch_case', 'catch_clause', 'ternary_expression'],
  jsx: ['if_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement', 'switch_statement', 'switch_case', 'catch_clause', 'ternary_expression'],
  go: ['if_statement', 'for_statement', 'expression_switch_statement', 'type_switch_statement', 'select_statement', 'expression_case', 'type_case'],
  python: ['if_statement', 'for_statement', 'while_statement', 'match_statement', 'case_clause', 'except_clause', 'conditional_expression'],
};

/** 各语言"逻辑短路"运算符节点（operator 为 &&/|| 或 and/or 时 +1） */
const COMPLEXITY_LOGIC_NODES: Record<string, string[]> = {
  typescript: ['binary_expression'],
  tsx: ['binary_expression'],
  javascript: ['binary_expression'],
  jsx: ['binary_expression'],
  go: ['binary_expression'],
  python: ['boolean_operator'],
};

/**
 * 圈复杂度：tree-sitter AST 树遍历按分支节点计数（见 COMPLEXITY_BRANCH_NODES），
 * 运算符只认 &&/||（and/or）——注释/字符串不进 AST 不再污染计数。
 * 语言无解析器（未装包/不支持）时回退正则启发式（estimateComplexityRegex）。
 */
export async function estimateComplexity(filePath: string, body: string): Promise<number> {
  const ast = await parseAstRoot(filePath, body);
  if (!ast) return estimateComplexityRegex(body);
  const branch = new Set(COMPLEXITY_BRANCH_NODES[ast.langName] ?? []);
  const logic = new Set(COMPLEXITY_LOGIC_NODES[ast.langName] ?? []);
  if (branch.size === 0 && logic.size === 0) return estimateComplexityRegex(body);
  let c = 1;
  const walk = (n: SyntaxNodeLike): void => {
    if (branch.has(n.type)) c += 1;
    if (logic.has(n.type)) {
      const op = n.childForFieldName('operator');
      const t = op ? op.text : '';
      if (t === '&&' || t === '||' || t === 'and' || t === 'or') c += 1;
    }
    for (let i = 0; i < n.childCount; i++) {
      const child = n.child(i);
      if (child) walk(child);
    }
  };
  walk(ast.root);
  return c;
}

/** 正则回退：剥注释（行/块 + python #）后再数分支关键词 → 圈复杂度估计 */
export function estimateComplexityRegex(body: string): number {
  const src = body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\n)[ \t]*\/\/[^\n]*/g, '\n')
    .replace(/(^|\n)[ \t]*#[^\n]*/g, '\n');
  let c = 1;
  for (const re of [/\bif\b/g, /\belif\b/g, /\bfor\b/g, /\bwhile\b/g, /\bcase\b/g, /\bcatch\b/g, /\bexcept\b/g]) {
    c += (src.match(re) ?? []).length;
  }
  c += (src.match(/&&/g) ?? []).length;
  c += (src.match(/\|\|/g) ?? []).length;
  c += (src.match(/\b(and|or)\b/g) ?? []).length;
  c += (src.match(/\s\?\s/g) ?? []).length; // 三元（带空格，避开可选链/类型 ?）
  return c;
}

// ── 未使用 import 提取（tree-sitter AST）────────────────────

export interface NamedImportRef {
  line: number;
  module: string;
  name: string;
}

/** AST 提取的绑定（额外带声明 identifier 的字节偏移，供"排除绑定自身"使用） */
interface AstImportBind extends NamedImportRef {
  /** 绑定 identifier 的 startIndex（tree-sitter 字节偏移） */
  startIndex: number;
}

function stripQuotes(s: string): string {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) || (s.startsWith('`') && s.endsWith('`'))) {
    return s.slice(1, -1);
  }
  return s;
}

function isValidBindName(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name);
}

/**
 * 从 AST 提取命名 import 绑定（TS/JS 家族 named+default+namespace+CJS require；Python from/import）。
 * Go 不提取（Go 未用 import 是编译错，编译器兜底）；其余语言返回空 → 走正则回退。
 * 结构实测（_dbg_ast*.mjs）：
 *   · TS：import_statement → import_clause → identifier(default) / named_imports → import_specifier(name/alias) / namespace_import → identifier
 *   · CJS：variable_declarator 且 value 为 require(...) 调用 → 绑定名 = 声明 identifier
 *   · Python：import_from_statement 的 module_name 字段 + 其后的 dotted_name / aliased_import(name/alias)；
 *     import_statement 的每个 dotted_name（import os.path → 绑定名 os）
 */
function collectImportBinds(root: SyntaxNodeLike, lang: string): AstImportBind[] {
  const binds: AstImportBind[] = [];
  const push = (line: number, module: string, nameNode: SyntaxNodeLike): void => {
    const name = nameNode.text;
    if (isValidBindName(name)) binds.push({ line, module, name, startIndex: nameNode.startIndex ?? 0 });
  };

  if (TS_FAMILY.has(lang)) {
    const walk = (n: SyntaxNodeLike): void => {
      if (n.type === 'import_statement') {
        // import type {...} → 类型专用导入，v1 跳过（常作 re-export，避免噪音）
        if (/^\s*import\s+type\b/.test(n.text)) return;
        const srcNode = n.childForFieldName('source');
        const module = srcNode ? stripQuotes(srcNode.text) : '';
        const line = n.startPosition.row + 1;
        const sub = (m: SyntaxNodeLike): void => {
          for (let i = 0; i < m.childCount; i++) {
            const c = m.child(i);
            if (!c) continue;
            if (c.type === 'import_specifier') {
              const b = c.childForFieldName('alias') ?? c.childForFieldName('name');
              if (b) push(line, module, b);
            } else if (c.type === 'namespace_import') {
              for (let j = 0; j < c.childCount; j++) {
                const k = c.child(j);
                if (k && k.type === 'identifier') push(line, module, k);
              }
            } else if (c.type === 'identifier') {
              push(line, module, c);
            } else if (c.isNamed) {
              sub(c);
            }
          }
        };
        sub(n);
        return;
      }
      // CJS: const x = require('m')
      if (n.type === 'variable_declarator') {
        const nameNode = n.childForFieldName('name');
        const value = n.childForFieldName('value');
        if (nameNode && nameNode.type === 'identifier' && value && value.type === 'call_expression') {
          const fn = value.childForFieldName('function');
          if (fn && fn.text === 'require') {
            const m = value.text.match(/['"]([^'"]+)['"]/);
            push(n.startPosition.row + 1, m ? m[1] : '', nameNode);
          }
        }
        // 不 return——继续递归（声明内部无嵌套 import）
      }
      for (let i = 0; i < n.childCount; i++) {
        const c = n.child(i);
        if (c) walk(c);
      }
    };
    walk(root);
  } else if (lang === 'python') {
    const walk = (n: SyntaxNodeLike): void => {
      if (n.type === 'import_from_statement') {
        const line = n.startPosition.row + 1;
        const modNode = n.childForFieldName('module_name');
        const module = modNode ? modNode.text : '';
        for (let i = 0; i < n.childCount; i++) {
          const c = n.child(i);
          if (!c || c === modNode) continue;
          if (c.type === 'aliased_import') {
            const b = c.childForFieldName('alias') ?? c.childForFieldName('name');
            if (b) push(line, module, b);
          } else if (c.type === 'dotted_name') {
            push(line, module, c);
          }
        }
        return;
      }
      if (n.type === 'import_statement') {
        const line = n.startPosition.row + 1;
        for (let i = 0; i < n.childCount; i++) {
          const c = n.child(i);
          if (c && c.type === 'dotted_name') {
            // import os.path → 绑定名 os（module 记录完整 dotted 名）
            const name = c.text.split('.')[0];
            if (isValidBindName(name)) binds.push({ line, module: c.text, name, startIndex: c.startIndex ?? 0 });
          }
        }
        return;
      }
      for (let i = 0; i < n.childCount; i++) {
        const c = n.child(i);
        if (c) walk(c);
      }
    };
    walk(root);
  }
  return binds;
}

/** 提取"命名 import"（AST；语言无解析器时回退正则） */
export async function extractNamedImports(filePath: string, source: string): Promise<NamedImportRef[]> {
  const ast = await parseAstRoot(filePath, source);
  if (!ast) return extractNamedImportsRegex(source);
  return collectImportBinds(ast.root, ast.langName).map((b) => ({ line: b.line, module: b.module, name: b.name }));
}

/**
 * 文件里未被使用的命名 import。
 * AST 版：收集全文件 identifier/type_identifier 使用集（排除 import 绑定声明自身的字节偏移），
 * 绑定名不在使用集即未使用。比正则回退更准：字符串/注释里的同名文本不算引用；
 * re-export（export { X }）的 X 是 identifier 会进使用集 → 正确不报。
 */
export async function unusedImportsIn(filePath: string, source: string): Promise<NamedImportRef[]> {
  const ast = await parseAstRoot(filePath, source);
  if (!ast) return unusedImportsInRegex(source);
  const binds = collectImportBinds(ast.root, ast.langName);
  if (binds.length === 0) return [];
  const bindingRanges = new Set(binds.map((b) => b.startIndex));
  const used = new Set<string>();
  const walk = (n: SyntaxNodeLike): void => {
    if (n.type === 'identifier' || n.type === 'type_identifier') {
      if (!bindingRanges.has(n.startIndex ?? -1)) used.add(n.text);
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walk(c);
    }
  };
  walk(ast.root);
  return binds.filter((b) => !used.has(b.name)).map((b) => ({ line: b.line, module: b.module, name: b.name }));
}

/** 正则回退：逐行提取命名 import（TS/JS/Python/Java 各形态） */
export function extractNamedImportsRegex(source: string): NamedImportRef[] {
  const out: NamedImportRef[] = [];
  const push = (line: number, module: string, names: string[]): void => {
    for (const n of names) {
      const name = n.trim().replace(/\s+as\s+([A-Za-z_]\w*).*/, '$1').trim();
      if (name && /^[A-Za-z_]\w*$/.test(name)) out.push({ line, module, name });
    }
  };
  source.split('\n').forEach((raw, i) => {
    const line = i + 1;
    const t = raw.trim();
    if (!t || t.startsWith('#')) return;
    // TS/JS: import type {...} → 类型专用导入，v1 跳过（常作 re-export，避免噪音）
    if (/^import\s+type\b/.test(t)) return;
    let m: RegExpMatchArray | null;

    // import def, { a, b as c } from 'm'
    m = t.match(/^import\s+(\w+)\s*,\s*\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
    if (m) {
      push(line, m[3], [m[1], ...m[2].split(',')]);
      return;
    }
    // import { a, b } from 'm'
    m = t.match(/^import\s*\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
    if (m) {
      push(line, m[2], m[1].split(','));
      return;
    }
    // import def from 'm'
    m = t.match(/^import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (m) {
      push(line, m[2], [m[1]]);
      return;
    }
    // const x = require('m')
    m = t.match(/^const\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\)/);
    if (m) {
      push(line, m[2], [m[1]]);
      return;
    }
    // from m import a, b as c
    m = t.match(/^from\s+(\S+)\s+import\s+(.+)$/);
    if (m) {
      push(line, m[1], m[2].split(','));
      return;
    }
    // import os, sys / import os.path
    m = t.match(/^import\s+(\S+(?:\s*,\s*\S+)*)$/);
    if (m) {
      push(line, m[1], m[1].split(',').map((x) => x.trim().split('.')[0]));
      return;
    }
    // Java: import a.b.C; / import static a.b.C.method;
    m = t.match(/^import\s+(?:static\s+)?[\w.]+\.([A-Za-z_]\w*)\s*;/);
    if (m) {
      push(line, t, [m[1]]);
      return;
    }
  });
  return out;
}

/** 正则回退：删掉 import 行后搜不到标识符 → 未使用 */
function unusedImportsInRegex(source: string): NamedImportRef[] {
  const refs = extractNamedImportsRegex(source);
  if (refs.length === 0) return [];
  const importLines = new Set(refs.map((r) => r.line));
  const body = source
    .split('\n')
    .filter((_, i) => !importLines.has(i + 1))
    .join('\n');
  return refs.filter((r) => !new RegExp(`\\b${r.name}\\b`).test(body));
}

// ── 主分析 ───────────────────────────────────────────────────

const TYPE_KINDS = new Set<ParsedSymbol['kind']>(['interface', 'type', 'class']);

/** 解析相对 import 到项目内文件（包导入/逃出项目根返回 null；与 impact 同语义） */
function resolveImportFile(fromRel: string, source: string, rels: Set<string>, exts: string[]): string | null {
  if (!source.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), source));
  if (base.startsWith('..')) return null;
  if (rels.has(base)) return base;
  for (const ext of exts) {
    if (rels.has(base + ext)) return base + ext;
  }
  for (const ext of exts) {
    if (rels.has(path.posix.join(base, 'index') + ext)) return path.posix.join(base, 'index') + ext;
  }
  return null;
}

export async function analyzeHealth(root: string, options: HealthOptions = {}): Promise<HealthReport> {
  const threshold = options.complexityThreshold ?? 10;
  const top = options.top ?? 10;
  const exts = listSupportedExtensions();
  const files = collectSourceFiles(root, exts);
  const rels = new Set(files.map((f) => f.rel));
  const parses = await Promise.all(
    files.map(async (f) => ({ rel: f.rel, parsed: await parseFileFull(f.rel, f.content) })),
  );

  // 顶层符号索引（name → [文件,符号]）+ 每文件"内部引用"集合（同文件 call/type_ref 命中）
  const symIndex = new Map<string, Array<{ rel: string; sym: ParsedSymbol }>>();
  const internalRefs = new Map<string, Set<string>>();
  for (const p of parses) {
    const refs = new Set<string>();
    for (const c of p.parsed.calls) if (c.callee_qn) refs.add(c.callee_qn);
    for (const t of p.parsed.type_refs) if (t.target_qn) refs.add(t.target_qn);
    internalRefs.set(p.rel, refs);
    for (const s of p.parsed.symbols) {
      if (s.parent) continue;
      const arr = symIndex.get(s.name) ?? [];
      arr.push({ rel: p.rel, sym: s });
      symIndex.set(s.name, arr);
    }
  }

  // 跨文件引用（导出名唯一匹配 → 目标符号 qualified_name 入 provider 的 crossRefs）
  const crossRefs = new Map<string, Set<string>>();
  const layerImports = new Map<string, Map<string, number>>(); // file → importedRel → 首个引用行
  const reverseConsumers = new Map<string, Set<string>>(); // provider → consumers（import 级）
  for (const p of parses) {
    for (const imp of p.parsed.imports) {
      const target = resolveImportFile(p.rel, imp.source, rels, exts);
      if (!target) continue;
      let m = layerImports.get(p.rel);
      if (!m) {
        m = new Map();
        layerImports.set(p.rel, m);
      }
      if (!m.has(target)) m.set(target, imp.line);
      let s = reverseConsumers.get(target);
      if (!s) {
        s = new Set();
        reverseConsumers.set(target, s);
      }
      s.add(p.rel);
    }
    for (const c of p.parsed.calls) {
      if (c.resolved) continue;
      const cands = (symIndex.get(c.callee) ?? []).filter((x) => x.rel !== p.rel);
      if (cands.length !== 1) continue;
      let s = crossRefs.get(cands[0].rel);
      if (!s) {
        s = new Set();
        crossRefs.set(cands[0].rel, s);
      }
      s.add(cands[0].sym.qualified_name);
    }
    for (const t of p.parsed.type_refs) {
      if (t.resolved) continue;
      const cands = (symIndex.get(t.type_name) ?? []).filter((x) => x.rel !== p.rel && TYPE_KINDS.has(x.sym.kind));
      if (cands.length !== 1) continue;
      let s = crossRefs.get(cands[0].rel);
      if (!s) {
        s = new Set();
        crossRefs.set(cands[0].rel, s);
      }
      s.add(cands[0].sym.qualified_name);
    }
  }

  // 内容快照（复杂度/未用 import 需要源码）
  const contentByRel = new Map(files.map((f) => [f.rel, f.content]));

  const issues: HealthIssue[] = [];
  const complexityEntries: ComplexityEntry[] = [];
  const layers: { contract: number; brick: number; glue: number; violations: number } = { contract: 0, brick: 0, glue: 0, violations: 0 };

  for (const p of parses) {
    const layer = classifyLayer(p.rel);
    layers[layer] += 1;
    const content = contentByRel.get(p.rel) ?? '';
    const contentLines = content.split('\n');
    const internal = internalRefs.get(p.rel) ?? new Set();
    const external = crossRefs.get(p.rel) ?? new Set();
    const consumers = reverseConsumers.get(p.rel) ?? new Set();

    // ── 维度1a：未使用导出（项目内无任何引用 → potential dead；外部消费者不可见）──
    for (const s of p.parsed.symbols) {
      if (s.parent) continue;
      // 顶层 const：被函数/模块读取是常态，解析器不提取变量读边 → 反查不到，跳过避免噪音
      if (s.kind === 'const') continue;
      let used = internal.has(s.qualified_name) || external.has(s.qualified_name);
      // 兜底：同文件文本存在性——解析器只建函数体内调用边，模块级引用（入口底部 `main();`）
      // 会漏；符号名出现在定义行之外即视为被引用（保守方向，宁漏不误报）
      if (!used) {
        const rest = [
          ...contentLines.slice(0, s.start_line - 1),
          ...contentLines.slice(s.end_line),
        ].join('\n');
        used = new RegExp(`\\b${s.name}\\b`).test(rest);
      }
      if (!used) {
        issues.push({
          kind: 'unused_export',
          severity: 'info',
          file: p.rel,
          line: s.start_line,
          symbol: s.name,
          message: `顶层符号 ${s.name} 项目内无引用（外部消费者不可见，删除前请确认非公共 API）`,
        });
      }
    }

    // ── 维度1b：未使用 import（AST 提取 + 使用集比对）──
    const unusedImports = await unusedImportsIn(p.rel, content);
    for (const u of unusedImports) {
      issues.push({
        kind: 'unused_import',
        severity: 'warn',
        file: p.rel,
        line: u.line,
        symbol: u.name,
        message: `import 了 ${u.module} 的 ${u.name} 但文件内未使用`,
        evidence: u.module,
      });
    }

    // ── 维度1c：孤儿文件（无任何项目内消费者 + 非胶水层）──
    if (consumers.size === 0 && layer !== 'glue') {
      issues.push({
        kind: 'orphan_file',
        severity: 'info',
        file: p.rel,
        message: `整文件无项目内消费者（孤立模块，可能是待清理的 dead code）`,
      });
    }

    // ── 维度2：复杂度（AST 分支节点计数）──
    for (const s of p.parsed.symbols) {
      if (s.parent) continue;
      const slice = content.split('\n').slice(s.start_line - 1, s.end_line).join('\n');
      const c = await estimateComplexity(p.rel, slice);
      complexityEntries.push({ file: p.rel, symbol: s.name, line: s.start_line, complexity: c });
      if (c > threshold) {
        issues.push({
          kind: 'high_complexity',
          severity: 'warn',
          file: p.rel,
          line: s.start_line,
          symbol: s.name,
          message: `${s.name} 圈复杂度 ${c} 超过阈值 ${threshold}，建议拆分`,
          evidence: String(c),
        });
      }
    }

    // ── 维度3：分层违规（import 的目标层 > 自身层 = 向上依赖）──
    for (const [targetRel, line] of layerImports.get(p.rel) ?? []) {
      const targetLayer = classifyLayer(targetRel);
      if (LAYER_ORDER[targetLayer] > LAYER_ORDER[layer]) {
        layers.violations += 1;
        issues.push({
          kind: 'layer_violation',
          severity: 'error',
          file: p.rel,
          line,
          message: `分层违规：${layer} 层依赖高层 ${targetLayer} 层（${targetRel}）`,
          evidence: targetRel,
        });
      }
    }
  }

  complexityEntries.sort((a, b) => b.complexity - a.complexity);
  const counts: Record<HealthKind, number> = {
    unused_export: 0, unused_import: 0, orphan_file: 0, high_complexity: 0, layer_violation: 0,
  };
  for (const i of issues) counts[i.kind] += 1;

  // 健康评分（0-100）
  let score = 100;
  score -= counts.layer_violation * 20;
  score -= counts.high_complexity * 5;
  score -= counts.orphan_file * 8;
  score -= counts.unused_export * 3;
  score -= counts.unused_import * 2;
  score = Math.max(0, Math.min(100, score));
  const grade: HealthReport['grade'] = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D';

  const summary =
    `健康度 ${score} 分（${grade}）：${counts.layer_violation} 分层违规 / ` +
    `${counts.high_complexity} 高复杂度 / ${counts.unused_export} 未使用导出 / ` +
    `${counts.unused_import} 未使用 import / ${counts.orphan_file} 孤儿文件`;

  return {
    root,
    fileCount: files.length,
    issues,
    counts,
    complexity: complexityEntries.slice(0, top),
    layers,
    score,
    grade,
    summary,
  };
}
