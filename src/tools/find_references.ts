/**
 * find_references —— 查找符号的所有引用（引用/调用方查询）
 *
 * 解决日常缺口：改/删一个符号前想"谁引用了它"。此前只能 grep 调用方（肌肉记忆
 * 陷阱同 rename）。本工具复用 rename_symbol 的引用图内核（expandClosure 闭包 +
 * analyzeModuleSource + resolveRel/resolveAliasedImport 边解析），只读报告，不改任何文件。
 *
 * 与 rename_symbol 的 dry_run 的关系：dry_run 是"改名视角"（old→new 编辑）；本品是
 * "引用视角"（只报文件 + import 子句/使用点行号），零编辑意图。
 *
 * 扩展 mode=field（2026-09，dogfood 驱动的结构引用缺口）：
 *   默认 mode=symbol 只报"谁 import 这个符号名"——对"加字段/改签名"这类改动不够，
 *   会漏掉同名文件内的对象字面量**构造点**与字段**读取点**。mode=field 补上：
 *     - 读取点：`obj.<field>`
 *     - 构造点：`<field>:`（对象字面量键）
 *   并**包含定义文件内部**（构造点常就在定义文件里）。这样改接口前能一次看清
 *   "谁构造、谁读取字段 F"，不再退回 grep。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot, expandClosure, loadAliasConfig, resolveAliasedImport, walkProjectFiles } from './project_root.js';
import { analyzeModuleSource, resolveRel, buildNoExt } from './rename_symbol.js';

export interface ReferenceSite {
  /** export/import/使用点所在的字节偏移 */
  offset: number;
  /** 1-based 行号 */
  line: number;
  /** 该处文本（旧名） */
  text: string;
  /** 语义：'definition' | 'import' | 'usage' | 'export_list' | 'reexport' | 'field-read' | 'field-key' */
  kind: string;
}

export interface ReferenceFile {
  /** 相对项目根的路径（POSIX 分隔符） */
  file: string;
  /** 引用点 */
  refs: ReferenceSite[];
  /** 导入子句摘要（source 字面量，便于 LLM 看懂怎么引的） */
  importSources: string[];
}

export interface FindReferencesResult {
  ok: boolean;
  /** mode=symbol 时为符号名；mode=field 时为字段名 */
  symbol: string;
  mode: 'symbol' | 'field';
  definition?: { file: string; kind: string; refs: ReferenceSite[] };
  importers?: ReferenceFile[];
  importerCount: number;
  /** mode=field 时：该字段的读取点/构造点（含定义文件内部），按文件分组 */
  fieldRefs?: ReferenceFile[];
  /** 阻断/非模块级符号等理由 */
  blocked?: string[];
}

function lineOf(src: string, offset: number): number {
  return src.slice(0, offset).split('\n').length;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** mode=field：扫描一批文件里对某字段的「读取点」(obj.field) 与「构造点」(field: 键) */
function scanFieldRefs(files: string[], field: string, resolvedRoot: string): ReferenceFile[] {
  const reDot = new RegExp(`\\.${escapeRegex(field)}\\b`, 'g');
  const reKey = new RegExp(`\\b${escapeRegex(field)}\\s*:`, 'g');
  const out: ReferenceFile[] = [];
  for (const abs of files) {
    let src: string;
    try {
      src = readFileSync(abs, 'utf-8');
    } catch {
      continue; // 二进/不可读跳过
    }
    const refs: ReferenceSite[] = [];
    let m: RegExpExecArray | null;
    reDot.lastIndex = 0;
    while ((m = reDot.exec(src))) {
      const off = m.index + 1; // `.field` 的 field 起点
      refs.push({ offset: off, line: lineOf(src, off), text: `.${field}`, kind: 'field-read' });
    }
    reKey.lastIndex = 0;
    while ((m = reKey.exec(src))) {
      refs.push({ offset: m.index, line: lineOf(src, m.index), text: `${field}:`, kind: 'field-key' });
    }
    if (refs.length > 0) {
      out.push({ file: (path.relative(resolvedRoot, abs) || path.basename(abs)).replace(/\\/g, '/'), refs, importSources: [] });
    }
  }
  return out;
}

export async function findReferences(input: {
  /** mode=symbol 必填：定义符号的文件（绝对路径；或相对 project_dir/cwd）。mode=field 可选（用于定闭包） */
  file?: string;
  /** mode=symbol 必填：符号名。mode=field 忽略 */
  symbol?: string;
  /** mode=field 必填：要查的字段名 */
  field?: string;
  /** symbol（默认，找符号的 importers/使用点）| field（找字段的读取点/构造点） */
  mode?: 'symbol' | 'field';
  project_dir?: string;
}): Promise<FindReferencesResult> {
  const mode = input.mode === 'field' ? ('field' as const) : ('symbol' as const);

  // field 模式：查字段的读取/构造点（含定义文件内部），不依赖符号解析
  if (mode === 'field') {
    const field = input.field;
    if (!field) return { ok: false, symbol: field ?? '', mode, importerCount: 0, blocked: ['mode=field 需要 field 参数'] };
    const effectiveRoot = input.project_dir ? path.resolve(String(input.project_dir)) : undefined;
    const fileAbs = input.file ? (path.isAbsolute(input.file) ? path.resolve(input.file) : effectiveRoot ? path.resolve(effectiveRoot, input.file) : path.resolve(process.cwd(), input.file)) : undefined;
    const resolvedRoot = effectiveRoot ?? (fileAbs ? resolveProjectRoot(fileAbs) : path.resolve(process.cwd()));
    const scope: string[] = [];
    if (fileAbs) {
      const closure = await expandClosure(fileAbs, resolvedRoot, loadAliasConfig(resolvedRoot));
      // 闭包含定义文件本身上游的间接引用，但字段读取可能发生在不 import 它的同仓文件里，
      // 故 field 模式以项目全量为准：闭包定位 root，再全量扫项目源文件。
      //（若 fileAbs 提供，至少确保落在项目内）
      for (const f of closure) if (path.resolve(f).startsWith(resolvedRoot)) scope.push(f);
    }
    // 全量扫项目源文件（field 名唯一性通常足够，能覆盖不 import 该类型的构造/读取点）
    const walked: string[] = [];
    walkProjectFiles(resolvedRoot, walked);
    const seen = new Set(scope.map((p) => path.resolve(p)));
    for (const w of walked) if (!seen.has(path.resolve(w))) scope.push(w);

    const fieldRefs = scanFieldRefs(scope, field, resolvedRoot);
    fieldRefs.sort((a, b) => a.file.localeCompare(b.file));
    return {
      ok: true,
      symbol: field,
      mode,
      importerCount: 0,
      fieldRefs,
      blocked: fieldRefs.length === 0 ? ['项目中未找到对该字段的读取/构造'] : undefined,
    };
  }

  // symbol 模式：既有逻辑
  const { file, symbol } = input;
  const effectiveRoot = input.project_dir ? path.resolve(String(input.project_dir)) : undefined;
  const fileAbs = path.isAbsolute(file!) ? path.resolve(file!) : effectiveRoot ? path.resolve(effectiveRoot, file!) : path.resolve(process.cwd(), file!);
  const resolvedRoot = effectiveRoot ?? resolveProjectRoot(fileAbs);
  const rootAlias = loadAliasConfig(resolvedRoot);

  const defSrc = readFileSync(fileAbs, 'utf-8');
  const def = await analyzeModuleSource(defSrc, fileAbs);
  if (!def) return { ok: false, symbol: symbol!, mode, importerCount: 0, blocked: ['定义文件解析失败'] };
  const kind = def.rootKinds.get(symbol!);
  if (!kind) return { ok: false, symbol: symbol!, mode, importerCount: 0, blocked: [`"${symbol}" 不是该文件的模块级声明`] };
  if (kind === 'import' || kind === 'reexport' || kind === 'exported') {
    return { ok: false, symbol: symbol!, mode, importerCount: 0, blocked: [`"${symbol}" 在 ${path.basename(fileAbs)} 中是 import 绑定，请在定义文件上查询`] };
  }
  const declOffset = def.rootOffsets.get(symbol!)!;

  // 闭包内引用点收集（import + usage + export_list）
  const files = await expandClosure(fileAbs, resolvedRoot, rootAlias);
  const byNoExt = buildNoExt(files);

  const aliasMemo = new Map<string, ReturnType<typeof loadAliasConfig>>();
  const aliasFor = (f: string) => {
    const d = path.dirname(f);
    if (!aliasMemo.has(d)) aliasMemo.set(d, loadAliasConfig(d));
    return aliasMemo.get(d) ?? null;
  };
  const resolveEdge = (source: string, f: string): string | null => {
    if (source.startsWith('.')) return resolveRel(source, f, byNoExt);
    const a = aliasFor(f);
    return a ? resolveAliasedImport(source, a) : null;
  };

  const importers: ReferenceFile[] = [];
  for (const f of files) {
    if (path.resolve(f) === fileAbs) continue;
    const src = readFileSync(f, 'utf-8');
    const mod = await analyzeModuleSource(src, f);
    if (!mod) continue;
    const refs: ReferenceSite[] = [];
    const importSources: string[] = [];
    for (const e of mod.imports) {
      if (!e.source) continue;
      // export * 转发不算"按名引用"
      if (e.star) continue;
      if (e.remoteName !== symbol) continue;
      const resolved = resolveEdge(e.source, f);
      if (!resolved || path.resolve(resolved) !== fileAbs) continue;
      importSources.push(e.source);
      if (e.remoteOffset !== null) refs.push({ offset: e.remoteOffset, line: lineOf(src, e.remoteOffset), text: symbol, kind: 'import' });
      // 无别名使用点（localName === symbol）
      if (e.localName === symbol) {
        for (const r of mod.rootRefs) if (r.name === symbol) refs.push({ offset: r.offset, line: lineOf(src, r.offset), text: symbol, kind: 'usage' });
      }
    }
    if (refs.length > 0 || importSources.length > 0) {
      importers.push({ file: (path.relative(resolvedRoot, f) || f).replace(/\\/g, '/'), refs, importSources });
    }
  }

  // 定义文件自身的 export/使用点
  const defRefs: ReferenceSite[] = [{ offset: declOffset, line: lineOf(defSrc, declOffset), text: symbol!, kind: 'definition' }];
  for (const r of def.rootRefs) if (r.name === symbol!) defRefs.push({ offset: r.offset, line: lineOf(defSrc, r.offset), text: symbol!, kind: 'usage' });
  for (const r of def.exportRefs) if (r.name === symbol!) defRefs.push({ offset: r.offset, line: lineOf(defSrc, r.offset), text: symbol!, kind: 'export_list' });

  return {
    ok: true,
    symbol: symbol!,
    mode,
    definition: { file: (path.relative(resolvedRoot, fileAbs) || fileAbs).replace(/\\/g, '/'), kind, refs: defRefs },
    importers,
    importerCount: importers.length,
  };
}