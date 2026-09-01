/**
 * find_references —— 查找符号的所有引用（引用/调用方查询）
 *
 * 解决日常缺口：改/删一个符号前想"谁引用了它"。此前只能 grep 调用方（肌肉记忆
 * 陷阱同 rename）。本工具复用 rename_symbol 的引用图内核（expandClosure 闭包 +
 * analyzeModuleSource + resolveRel/resolveAliasedImport 边解析），只读报告，不改任何文件。
 *
 * 与 rename_symbol 的 dry_run 的关系：dry_run 是"改名视角"（old→new 编辑）；本品是
 * "引用视角"（只报文件 + import 子句/使用点行号），零编辑意图。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot, expandClosure, loadAliasConfig, resolveAliasedImport } from './project_root.js';
import { analyzeModuleSource, resolveRel, buildNoExt } from './rename_symbol.js';

export interface ReferenceSite {
  /** export/import/使用点所在的字节偏移 */
  offset: number;
  /** 1-based 行号 */
  line: number;
  /** 该处文本（旧名） */
  text: string;
  /** 语义：'definition' | 'import' | 'usage' | 'export_list' | 'reexport' */
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
  symbol: string;
  definition?: { file: string; kind: string; refs: ReferenceSite[] };
  importers?: ReferenceFile[];
  importerCount: number;
  /** 阻断/非模块级符号等理由 */
  blocked?: string[];
}

function lineOf(src: string, offset: number): number {
  return src.slice(0, offset).split('\n').length;
}

export async function findReferences(input: {
  /** 定义符号的文件（绝对路径；或相对 project_dir/cwd） */
  file: string;
  symbol: string;
  project_dir?: string;
}): Promise<FindReferencesResult> {
  const { file, symbol } = input;
  const effectiveRoot = input.project_dir ? path.resolve(String(input.project_dir)) : undefined;
  const fileAbs = path.isAbsolute(file) ? path.resolve(file) : effectiveRoot ? path.resolve(effectiveRoot, file) : path.resolve(process.cwd(), file);
  const resolvedRoot = effectiveRoot ?? resolveProjectRoot(fileAbs);
  const rootAlias = loadAliasConfig(resolvedRoot);

  const defSrc = readFileSync(fileAbs, 'utf-8');
  const def = await analyzeModuleSource(defSrc, fileAbs);
  if (!def) return { ok: false, symbol, importerCount: 0, blocked: ['定义文件解析失败'] };
  const kind = def.rootKinds.get(symbol);
  if (!kind) return { ok: false, symbol, importerCount: 0, blocked: [`"${symbol}" 不是该文件的模块级声明`] };
  if (kind === 'import' || kind === 'reexport' || kind === 'exported') {
    return { ok: false, symbol, importerCount: 0, blocked: [`"${symbol}" 在 ${path.basename(fileAbs)} 中是 import 绑定，请在定义文件上查询`] };
  }
  const declOffset = def.rootOffsets.get(symbol)!;

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
  const defRefs: ReferenceSite[] = [{ offset: declOffset, line: lineOf(defSrc, declOffset), text: symbol, kind: 'definition' }];
  for (const r of def.rootRefs) if (r.name === symbol) defRefs.push({ offset: r.offset, line: lineOf(defSrc, r.offset), text: symbol, kind: 'usage' });
  for (const r of def.exportRefs) if (r.name === symbol) defRefs.push({ offset: r.offset, line: lineOf(defSrc, r.offset), text: symbol, kind: 'export_list' });

  return {
    ok: true,
    symbol,
    definition: { file: (path.relative(resolvedRoot, fileAbs) || fileAbs).replace(/\\/g, '/'), kind, refs: defRefs },
    importers,
    importerCount: importers.length,
  };
}