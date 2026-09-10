/**
 * symbol_move —— 跨文件模块级符号移动（语义重构第一棒）
 *
 * 从「单文件符号编辑」（edit_code / symbol_edit）升级到「依赖图感知的结构变换」：
 * 把一个模块级符号从文件 A 挪到文件 B，并自动把闭包内所有 import 它（仅引入它）的文件
 * 的 import【目标】从 A 改到 B。区别于 rename_symbol（改远程名）：move 不改符号名，
 * 只改 import 的 source 字符串，故本地名 / 使用点 / 别名一律不动。
 *
 * 模型：**多文件原子写**（源删 + 目标加 + 每个 importer 改 source），任一阻断 → 整体不落盘。
 * 与 edit_code 的单文件事务模型不同，故独立成文件，与 rename_symbol.ts（重构族）同族。
 *
 * 2026-09：复用 rename_symbol 的模块作用域分析 + project_root 的闭包边界（只扩工作区、
 * 外部 import 记为 externalRef 不追外）。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  analyzeModuleSource,
  resolveRel,
  buildNoExt,
  type ModuleAnalysis,
} from './rename_symbol.js';
import {
  resolveProjectRoot,
  expandClosureDetailed,
  loadAliasConfig,
  resolveAliasedImport,
  type AliasConfig,
  type ExternalRef,
} from './project_root.js';
import { parseAstRoot } from './ts_kernel/index.js';
import { syncFile } from '../db/symbols.js';
import { getProjectCacheDb } from '../db/db.js';
import { splitKeepEnds, detectEol, isBlankLine } from './line_utils.js';

// ─────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────

export interface MoveSymbolInput {
  /** 目标项目根目录；缺省自动定位（git 根→manifest→文件目录） */
  project_dir?: string;
  /** 定义符号的文件（相对 project_dir 或绝对路径） */
  file: string;
  /** 要移动的模块级符号名 */
  symbol: string;
  /** 目标文件（相对 project_dir 或绝对路径；不存在则创建） */
  to_file: string;
  /** 可选：移动后改名。v1 只移动不改名——传入则置 toSymbolDeferred 提示走 rename_symbols */
  to_symbol?: string;
  /** true=只出结构化预览不落盘 */
  dry_run?: boolean;
}

export interface MoveRedirect {
  /** importer 文件相对路径 */
  file: string;
  /** 旧 import source（如 './a'） */
  oldSource: string;
  /** 新 import source（如 '../shared/c'） */
  newSource: string;
  /** 被定位/重定向的符号 */
  symbol: string;
}

export interface MoveSymbolResult {
  ok: boolean;
  symbol: string;
  to_file: string;
  filesWritten: number;
  dryRun?: boolean;
  /** 源文件删除信息 */
  source?: { file: string; removed: string[]; startLine: number; endLine: number };
  /** 目标文件插入信息 */
  target?: { file: string; created: boolean; symbol: string };
  /** 每个被重定向 importer 的旧→新 import source */
  redirects?: MoveRedirect[];
  /** 实际将落盘/已落盘文件（source + target + 每个 importer） */
  affectedFiles?: string[];
  blocked?: string[];
  externalRefs?: ExternalRef[];
  /** 传了 to_symbol 但 v1 未启用改名 */
  toSymbolDeferred?: boolean;
}

// ─────────────────────────────────────────────
// 本地小工具（在 rename_symbol / edit_code 中为私有，此处按需复制/对齐）
// ─────────────────────────────────────────────

const TS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);

interface Edit {
  pos: number;
  len: number;
  text: string;
}

function stripQuotes(s: string): string {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) || (s.startsWith('`') && s.endsWith('`'))) return s.slice(1, -1);
  return s;
}

/** 逆序应用编辑（偏移互不影响） */
function applyEdits(src: string, edits: Edit[]): string {
  if (edits.length === 0) return src;
  const sorted = [...edits].sort((a, b) => b.pos - a.pos);
  let out = src;
  for (const e of sorted) out = out.slice(0, e.pos) + e.text + out.slice(e.pos + e.len);
  return out;
}

/** 压缩连续 ≥2 空行为 1 空行（源删除后清理） */
function squeezeBlankRuns(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (isBlankLine(l) && out.length > 0 && isBlankLine(out[out.length - 1])) continue;
    out.push(l);
  }
  return out;
}

/** 计算 fromAbs → toAbs 的相对 import 路径（去扩展名；'./x' 形） */
function relImportPath(fromAbs: string, toAbs: string): string {
  const fromDir = path.posix.dirname(fromAbs.replace(/\\/g, '/'));
  let rel = path.posix.relative(fromDir, toAbs.replace(/\\/g, '/'));
  rel = rel.replace(/\.[^.]+$/, '');
  return rel.startsWith('.') ? rel : './' + rel;
}

const IDENT_LIKE = new Set(['identifier', 'type_identifier', 'property_identifier', 'shorthand_property_identifier']);

function isDeclNodeType(t: string): boolean {
  return (
    t === 'function_declaration' ||
    t === 'generator_function_declaration' ||
    t === 'class_declaration' ||
    t === 'abstract_class_declaration' ||
    t === 'interface_declaration' ||
    t === 'type_alias_declaration' ||
    t === 'enum_declaration' ||
    t === 'lexical_declaration' ||
    t === 'variable_declaration'
  );
}

/** 取声明节点的名字（lexical/variable_declaration 取单 declarator 的 name） */
function declName(node: { type: string; childForFieldName(f: string): unknown }): string | null {
  const n = node.childForFieldName('name');
  if (n && IDENT_LIKE.has((n as { type: string }).type)) return (n as { text: string }).text;
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    for (let i = 0; i < (node as unknown as { childCount: number }).childCount; i++) {
      const c = ((node as unknown as { child(i: number): unknown }).child(i)) as { type: string; childForFieldName(f: string): unknown } | null;
      if (c && c.type === 'variable_declarator') {
        const nm = c.childForFieldName('name');
        if (nm && IDENT_LIKE.has((nm as { type: string }).type)) return (nm as { text: string }).text;
      }
    }
  }
  return null;
}

/** 在 export_statement 内递归找匹配 symbol 的声明节点 */
function findNamedDeclInExport(stmt: { type: string; childCount: number; child(i: number): unknown }, symbol: string): unknown | null {
  const stack: Array<unknown> = [stmt];
  while (stack.length) {
    const n = stack.pop() as { type: string; childForFieldName(f: string): unknown; childCount: number; child(i: number): unknown };
    if (n !== stmt && isDeclNodeType(n.type)) {
      if (declName(n) === symbol) return n;
      continue; // 发深处的非匹配声明不再下钻
    }
    if (n.type === 'export_specifier' || n.type === 'export_clause') continue;
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) stack.push(c);
    }
  }
  return null;
}

/**
 * 取 module 顶层定义块的完整字节区间（含 export 前缀与体；不含上方 /** 注释）。
 * 遍历 program 直接子节点（顶层 statement）；命中即返回 startIndex..endIndex。
 */
async function findTopLevelDeclRange(
  src: string,
  filePath: string,
  symbol: string,
): Promise<{ startIndex: number; endIndex: number } | null> {
  const ast = await parseAstRoot(filePath, src);
  if (!ast?.root) return null;
  const root = ast.root as unknown as {
    childCount: number;
    child(i: number): unknown;
  };
  for (let i = 0; i < root.childCount; i++) {
    const n = root.child(i) as unknown as {
      type: string;
      startIndex: number;
      endIndex: number;
      childCount: number;
      child(i: number): unknown;
      childForFieldName(f: string): unknown;
    };
    if (!n) continue;
    if (n.type === 'export_statement') {
      if (findNamedDeclInExport(n, symbol)) return { startIndex: n.startIndex, endIndex: n.endIndex };
      continue;
    }
    if (isDeclNodeType(n.type) && declName(n) === symbol) {
      return { startIndex: n.startIndex, endIndex: n.endIndex };
    }
  }
  return null;
}

// ─────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────

export async function moveSymbol(input: MoveSymbolInput): Promise<MoveSymbolResult> {
  const blocked: string[] = [];
  const dryRun = input.dry_run === true;

  // 0. 路径/根/alias 解析
  const effectiveRoot = input.project_dir ? path.resolve(String(input.project_dir)) : undefined;
  const sourceAbs = path.isAbsolute(input.file)
    ? path.resolve(input.file)
    : effectiveRoot
      ? path.resolve(effectiveRoot, input.file)
      : path.resolve(process.cwd(), input.file);
  const resolvedRoot = effectiveRoot ?? resolveProjectRoot(sourceAbs);
  const aliasCfg = loadAliasConfig(resolvedRoot);
  const toAbs = path.isAbsolute(input.to_file)
    ? path.resolve(input.to_file)
    : effectiveRoot
      ? path.resolve(effectiveRoot, input.to_file)
      : path.resolve(process.cwd(), input.to_file);

  // 1. 基础校验
  const defExt = path.extname(sourceAbs);
  if (!TS_EXTS.has(defExt)) return { ok: false, symbol: input.symbol, to_file: input.to_file, filesWritten: 0, blocked: [`move 暂只支持 TS/JS 模块级符号（${defExt}）`] };
  if (!fs.existsSync(sourceAbs)) return { ok: false, symbol: input.symbol, to_file: input.to_file, filesWritten: 0, blocked: [`源文件不存在: ${sourceAbs}`] };
  if (path.resolve(toAbs) === path.resolve(sourceAbs)) return { ok: false, symbol: input.symbol, to_file: input.to_file, filesWritten: 0, blocked: ['目标文件与源文件相同，无需移动'] };

  const src = fs.readFileSync(sourceAbs, 'utf-8');
  const def = await analyzeModuleSource(src, sourceAbs);
  if (!def) return { ok: false, symbol: input.symbol, to_file: input.to_file, filesWritten: 0, blocked: ['源文件解析失败'] };
  const kind = def.rootKinds.get(input.symbol);
  if (!kind) return { ok: false, symbol: input.symbol, to_file: input.to_file, filesWritten: 0, blocked: [`"${input.symbol}" 不是 ${path.basename(sourceAbs)} 的模块级声明`] };
  if (kind === 'import' || kind === 'reexport' || kind === 'exported') {
    return { ok: false, symbol: input.symbol, to_file: input.to_file, filesWritten: 0, blocked: [`"${input.symbol}" 在 ${path.basename(sourceAbs)} 中是 import/再导出绑定而非声明，请在其定义文件上发起 move`] };
  }

  const toSymbolDeferred = input.to_symbol !== undefined && input.to_symbol !== input.symbol;

  // 2. 定义块区间 → 删除文本
  const range = await findTopLevelDeclRange(src, sourceAbs, input.symbol);
  if (!range) return { ok: false, symbol: input.symbol, to_file: input.to_file, filesWritten: 0, blocked: [`未定位到 "${input.symbol}" 的模块级定义块`] };
  const eol = detectEol(src);
  const definition = src.slice(range.startIndex, range.endIndex);
  const startLine = src.slice(0, range.startIndex).split('\n').length;
  const endLine = src.slice(0, range.endIndex).split('\n').length;
  const removedLines = src.slice(range.startIndex, range.endIndex).split(/\r?\n/);
  const newSourceText = squeezeBlankRuns(splitKeepEnds(src.slice(0, range.startIndex) + src.slice(range.endIndex))).join('');
  const finalSource = newSourceText && !newSourceText.endsWith(eol) ? newSourceText + eol : newSourceText;

  // 3. 目标文件防护 + 准备目标文本
  const targetExists = fs.existsSync(toAbs);
  let targetText: string;
  let created = false;
  if (targetExists) {
    const toSrc = fs.readFileSync(toAbs, 'utf-8');
    const tmod = await analyzeModuleSource(toSrc, toAbs);
    if (tmod?.rootKinds.has(input.symbol)) {
      return { ok: false, symbol: input.symbol, to_file: input.to_file, filesWritten: 0, blocked: [`目标文件已存在同名模块级符号 "${input.symbol}"`] };
    }
    // 追加到顶层末：前面补空行分隔
    const sep = !toSrc.endsWith('\n') ? '\n' : '';
    const lastLine = (toSrc.split('\n').pop() ?? '');
    const blank = lastLine.trim() !== '' ? '\n' : '';
    targetText = toSrc + sep + blank + definition;
  } else {
    created = true;
    targetText = definition.endsWith('\n') ? definition : definition + '\n';
  }

  // 4. 闭包（只扩工作区，外部仅反馈）
  const closure = await expandClosureDetailed(sourceAbs, resolvedRoot, aliasCfg);
  const files = closure.files;
  const externalRefs = closure.externalRefs;
  const byNoExt = buildNoExt(files);

  const aliasMemo = new Map<string, AliasConfig | null>();
  const aliasFor = (fAbs: string): AliasConfig | null => {
    const d = path.dirname(fAbs);
    if (!aliasMemo.has(d)) aliasMemo.set(d, loadAliasConfig(d));
    return aliasMemo.get(d) ?? null;
  };
  const resolveEdge = (fAbs: string, source: string): string | null => {
    if (source.startsWith('.')) return resolveRel(source, fAbs, byNoExt);
    const a = aliasFor(fAbs);
    return a ? resolveAliasedImport(source, a) : null;
  };

  // 5. 收集 importer 重定向（只改 source 字符串）
  const redirects: MoveRedirect[] = [];
  const importerEdits: Map<string, { edits: Edit[]; src: string }> = new Map();
  for (const fAbs of files) {
    if (path.resolve(fAbs) === sourceAbs) continue;
    const ext = path.extname(fAbs);
    if (!TS_EXTS.has(ext)) continue;
    let fmod: ModuleAnalysis | null;
    let fsrc: string;
    try {
      fsrc = fs.readFileSync(fAbs, 'utf-8');
      fmod = await analyzeModuleSource(fsrc, fAbs);
    } catch {
      continue;
    }
    if (!fmod) continue;

    // 5a. 用 analyze 判定：指向源文件的 import 边，按其 source 字符串聚合，是否只引入 symbol
    //     （namespace / 星号 / 混入其它符号 → 阻断）
    const bySrc = new Map<string, Array<(typeof fmod.imports)[number]>>();
    for (const e of fmod.imports) {
      if (!e.source) continue;
      const resolved = resolveEdge(fAbs, e.source);
      if (!resolved || path.resolve(resolved) !== sourceAbs) continue;
      let arr = bySrc.get(e.source);
      if (!arr) {
        arr = [];
        bySrc.set(e.source, arr);
      }
      arr.push(e);
    }
    const sourcesToRedirect: string[] = [];
    for (const [s, edges] of bySrc) {
      // 星号转发（export * from './source'）
      if (edges.some((e) => e.star)) {
        blocked.push(`${path.basename(fAbs)} 用 export * 从源文件转发，无法按名重定向 import 目标`);
        continue;
      }
      // namespace / default import（import * as ns / import ns from）：无具名远程名，
      // 会把源文件全部导出/默认值拉走，无法按名重定向 import 目标
      if (edges.some((e) => e.remoteName === null && !e.isReexport && !e.star)) {
        blocked.push(`${path.basename(fAbs)} 用 namespace/default import 引入源文件，符号移出后语义断裂；请改为具名 import 后重试`);
        continue;
      }
      // 该 source 引入的所有远程名必须恰好是符号名
      const names = new Set(edges.map((e) => e.remoteName ?? '').filter(Boolean));
      if (names.size !== 1 || !names.has(input.symbol)) {
        blocked.push(`${path.basename(fAbs)} 的一条 import 语句从源文件同时引入其它符号（${[...names].join(', ')}），无法整条重定向 import 目标；请手动拆分后重试`);
        continue;
      }
      sourcesToRedirect.push(s);
    }
    if (sourcesToRedirect.length === 0) continue;

    // 5b. 用 parseAstRoot 应用字节重定向（source 节点 → 新相对路径）
    const ast = await parseAstRoot(fAbs, fsrc);
    if (!ast?.root) continue;
    const root = ast.root as unknown as { childCount: number; child(i: number): unknown };
    const edits: Edit[] = [];
    const walkTop = (n: unknown): void => {
      const node = n as { type: string; childCount: number; child(i: number): unknown; childForFieldName(f: string): unknown };
      if (node.type === 'import_statement' || node.type === 'export_statement') {
        const sourceNode = node.childForFieldName('source') as { text: string; startIndex: number; endIndex: number } | null;
        if (sourceNode) {
          const s = stripQuotes(sourceNode.text);
          if (sourcesToRedirect.includes(s)) {
            const newSource = relImportPath(fAbs, toAbs);
            const q = sourceNode.text[0];
            const openLen = q === '"' || q === "'" || q === '`' ? 1 : 0;
            edits.push({ pos: sourceNode.startIndex + openLen, len: s.length, text: newSource });
            redirects.push({ file: (path.relative(resolvedRoot, fAbs) || fAbs).replace(/\\/g, '/'), oldSource: s, newSource, symbol: input.symbol });
          }
        }
        return; // 不深入 import/export 内部其它 source
      }
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c) walkTop(c);
      }
    };
    walkTop(root);
    if (edits.length > 0) importerEdits.set(fAbs, { edits, src: fsrc });
  }

  // 6. 原子门
  if (blocked.length > 0) {
    return { ok: false, symbol: input.symbol, to_file: input.to_file, filesWritten: 0, blocked };
  }

  const affectedFiles = [sourceAbs, toAbs, ...importerEdits.keys()];

  // 7. dry_run / 落盘
  if (dryRun) {
    return {
      ok: true,
      symbol: input.symbol,
      to_file: (path.relative(resolvedRoot, toAbs) || toAbs).replace(/\\/g, '/'),
      dryRun: true,
      filesWritten: 0,
      source: { file: (path.relative(resolvedRoot, sourceAbs) || sourceAbs).replace(/\\/g, '/'), removed: removedLines, startLine, endLine },
      target: { file: (path.relative(resolvedRoot, toAbs) || toAbs).replace(/\\/g, '/'), created, symbol: input.symbol },
      redirects,
      affectedFiles: affectedFiles.map((f) => (path.relative(resolvedRoot, f) || f).replace(/\\/g, '/')),
      externalRefs,
      ...(toSymbolDeferred ? { toSymbolDeferred: true } : {}),
    };
  }

  // 落盘：源删除 → 目标插入 → importer source 重定向
  fs.writeFileSync(sourceAbs, finalSource, 'utf-8');
  if (created) fs.mkdirSync(path.dirname(toAbs), { recursive: true });
  fs.writeFileSync(toAbs, targetText, 'utf-8');
  for (const [fAbs, entry] of importerEdits) {
    const out = applyEdits(entry.src, entry.edits);
    if (out !== entry.src) fs.writeFileSync(fAbs, out, 'utf-8');
  }

  // 索引重建（新鲜度闭环）
  const db = getProjectCacheDb(resolvedRoot);
  for (const f of [sourceAbs, toAbs, ...importerEdits.keys()]) {
    try {
      await syncFile(db, resolvedRoot, f);
    } catch {
      /* 索引非致命 */
    }
  }

  return {
    ok: true,
    symbol: input.symbol,
    to_file: (path.relative(resolvedRoot, toAbs) || toAbs).replace(/\\/g, '/'),
    filesWritten: affectedFiles.length,
    source: { file: (path.relative(resolvedRoot, sourceAbs) || sourceAbs).replace(/\\/g, '/'), removed: removedLines, startLine, endLine },
    target: { file: (path.relative(resolvedRoot, toAbs) || toAbs).replace(/\\/g, '/'), created, symbol: input.symbol },
    redirects,
    affectedFiles: affectedFiles.map((f) => (path.relative(resolvedRoot, f) || f).replace(/\\/g, '/')),
    externalRefs,
    ...(toSymbolDeferred ? { toSymbolDeferred: true } : {}),
  };
}