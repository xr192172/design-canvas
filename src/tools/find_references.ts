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
import { resolveProjectRoot, expandClosure, loadAliasConfig, resolveAliasedImport, resolveLangImport } from './project_root.js';
import { analyzeModuleSource, resolveRel, buildNoExt } from './rename_symbol.js';
import { collectFieldRefs, collectTypeConstructCandidates, type FieldRefFile, type TypeConstructCandidate } from './field_refs.js';
import { parseFileFull } from './ts_kernel/index.js';

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
  /** mode=symbol 时为符号名；mode=field 时为字段名；mode=type 时为类型名 */
  symbol: string;
  mode: 'symbol' | 'field' | 'type';
  definition?: { file: string; kind: string; refs: ReferenceSite[] };
  importers?: ReferenceFile[];
  importerCount: number;
  /** mode=field 时：该字段的读取/构造/解构/声明点（含定义文件内部），按文件分组，含行内上下文 */
  fieldRefs?: FieldRefFile[];
  /** mode=type 时：类型声明的成员字段集 */
  typeMembers?: string[];
  /** mode=type 时：与类型成员交叠 ≥ min_hit 的对象字面量候选构造点 */
  typeCandidates?: TypeConstructCandidate[];
  /** 阻断/非模块级符号等理由 */
  blocked?: string[];
}

function lineOf(src: string, offset: number): number {
  return src.slice(0, offset).split('\n').length;
}

const FIELD_KIND_LABEL: Record<string, string> = {
  'field-read': '读',
  'field-key': '构',
  'field-destructure': '解',
  'field-decl': '声明',
};

export async function findReferences(input: {
  /** mode=symbol 必填：定义符号的文件（绝对路径；或相对 project_dir/cwd）。mode=field/type 可选（用于定 scope） */
  file?: string;
  /** mode=symbol 必填：符号名。mode=field 忽略 */
  symbol?: string;
  /** mode=field 必填：要查的字段名 */
  field?: string;
  /** symbol（默认，找符号的 importers/使用点）| field（字段读取/构造/解构/声明点）| type（形如某类型的对象字面量构造候选） */
  mode?: 'symbol' | 'field' | 'type';
  /** field/type 模式：closure（默认，给 file 时按 import 闭包）| all（全项目扫） */
  scope?: 'closure' | 'all';
  /** type 模式：与类型成员交叠 ≥ 该值才判为候选构造点（默认 2） */
  min_hit?: number;
  project_dir?: string;
}): Promise<FindReferencesResult> {
  const effectiveRoot = input.project_dir ? path.resolve(String(input.project_dir)) : undefined;
  const projectDir = effectiveRoot ?? path.resolve(process.cwd());

  // type 模式：形如某类型的对象字面量构造候选（启发式，找成员交叠 ≥ min_hit）
  if (input.mode === 'type') {
    if (!input.file || !input.symbol) return { ok: false, symbol: input.symbol ?? '', mode: 'type', importerCount: 0, blocked: ['mode=type 需要 file + symbol（类型名）'] };
    const { members, candidates } = await collectTypeConstructCandidates({
      project_dir: projectDir,
      file: input.file,
      symbol: input.symbol,
      scope: input.scope === 'all' ? 'all' : 'closure',
      min_hit: input.min_hit,
    });
    return {
      ok: true,
      symbol: input.symbol,
      mode: 'type',
      importerCount: 0,
      typeMembers: members,
      typeCandidates: candidates,
      blocked: members.length === 0 ? ['未从声明中解出成员字段（认 interface/type { ... }）'] : candidates.length === 0 ? ['未找到交叠 ≥ min_hit 的对象字面量候选'] : undefined,
    };
  }

  // field 模式：字段的结构引用点（AST 分类：读/构/解/声明，含定义文件内部）
  if (input.mode === 'field') {
    const field = input.field;
    if (!field) return { ok: false, symbol: field ?? '', mode: 'field', importerCount: 0, blocked: ['mode=field 需要 field 参数'] };
    const fieldRefs = await collectFieldRefs({
      project_dir: projectDir,
      field,
      file: input.file,
      scope: input.scope === 'all' ? 'all' : 'closure',
    });
    return {
      ok: true,
      symbol: field,
      mode: 'field',
      importerCount: 0,
      fieldRefs,
      blocked: fieldRefs.length === 0 ? ['项目中未找到对该字段的引用'] : undefined,
    };
  }

  // symbol 模式：既有逻辑
  const mode = 'symbol' as const;
  const { file, symbol } = input;
  const symRoot = input.project_dir ? path.resolve(String(input.project_dir)) : undefined;
  const fileAbs = path.isAbsolute(file!) ? path.resolve(file!) : symRoot ? path.resolve(symRoot, file!) : path.resolve(process.cwd(), file!);
  const resolvedRoot = symRoot ?? resolveProjectRoot(fileAbs);
  const rootAlias = loadAliasConfig(resolvedRoot);

  const defSrc = readFileSync(fileAbs, 'utf-8');
  const def = await analyzeModuleSource(defSrc, fileAbs);
  const isTsDef = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i.test(fileAbs);
  if (!isTsDef) {
    // 非 TS target（跨语言，如 Java）：语言内核确认符号定义于此文件（类/方法/函数均可，不做"模块级声明"约束）
    const pf = await parseFileFull(path.basename(fileAbs), defSrc);
    if (!pf || !pf.symbols.some((s) => s.name === symbol!)) {
      return { ok: false, symbol: symbol!, mode, importerCount: 0, blocked: [`"${symbol}" 未在 ${path.basename(fileAbs)} 中找到定义`] };
    }
  }
  const kind = def?.rootKinds.get(symbol!);
  if (isTsDef) {
    if (!def) return { ok: false, symbol: symbol!, mode, importerCount: 0, blocked: ['定义文件解析失败'] };
    if (!kind) return { ok: false, symbol: symbol!, mode, importerCount: 0, blocked: [`"${symbol}" 不是该文件的模块级声明`] };
    if (kind === 'import' || kind === 'reexport' || kind === 'exported') {
      return { ok: false, symbol: symbol!, mode, importerCount: 0, blocked: [`"${symbol}" 在 ${path.basename(fileAbs)} 中是 import 绑定，请在定义文件上查询`] };
    }
  }
  const declOffset = (isTsDef && def ? def.rootOffsets.get(symbol!) ?? 0 : 0);

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
  const TS_FILE_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i;
  for (const f of files) {
    if (path.resolve(f) === fileAbs) continue;
    const src = readFileSync(f, 'utf-8');
    if (!TS_FILE_RE.test(f)) {
      // 跨语言引用 + is-target：对「pkg.Symbol」限定引用做精准门槛——`pkg` 必须经某 import 连到 target
      // 定义模块才报高信任(cross-call)，前缀属于其它包则剔除（降误报）；裸引用无法确认也不可剔除 → 保留为
      // cross-usage 疑似（异构同名场景的真实召回手段，不因无法联证而误删）。
      const needle = symbol!;
      const lines = src.split('\n');
      let running = 0;
      const lineOffsets: number[] = [];
      for (const ln of lines) { lineOffsets.push(running); running += ln.length + 1; }
      const crossRefs: ReferenceSite[] = [];
      let anyAstHit = false; // 该 symbol 在本文件是否有 AST 踪迹（含被 is-target 剔除的）——有则不再文本兜底
      const reportAt = (line: number, kind: ReferenceSite['kind'], text = needle) =>
        crossRefs.push({ offset: lineOffsets[line - 1] ?? 0, line, text, kind });
      // targetBindings：连到 target 定义模块（同文件/同目录）的 import 所引入的本地名
      const targetBindings = new Set<string>();
      let parsed: Awaited<ReturnType<typeof parseFileFull>> | null = null;
      try {
        parsed = await parseFileFull(f, src);
        for (const imp of parsed.imports) {
          if (!imp.bindings) continue;
          let connects = false;
          try {
            const resolved = resolveLangImport(f, imp, { root: resolvedRoot, goModules: [] });
            const ra = resolved ? path.resolve(resolved) : null;
            if (ra && (ra === fileAbs || path.dirname(ra) === path.dirname(fileAbs))) connects = true;
          } catch { /* resolve 失败视为不连 */ }
          if (connects) for (const b of imp.bindings) targetBindings.add(b);
        }
        for (const c of parsed.calls) {
          if (c.callee !== needle) continue;
          anyAstHit = true;
          const expr = c.callee_expr || needle;
          const dot = expr.indexOf('.');
          if (dot >= 0) {
            // 限定引用 pkg.Symbol：只报「pkg 连到 target」；其它包前缀 → 剔除误报
            const pkg = expr.slice(0, dot);
            if (targetBindings.has(pkg)) reportAt(c.line, 'cross-call', expr);
          } else {
            reportAt(c.line, 'cross-usage'); // 裸引用：疑似保留
          }
        }
        for (const t of parsed.type_refs) {
          if (t.type_name !== needle) continue;
          anyAstHit = true;
          reportAt(t.line, 'cross-usage');
        }
      } catch { /* AST 解析失败则走兜底 */ }
      // 兜底词边界探针（仅当该 symbol 在 AST 完全无踪迹时跑，跳过注释/字符串样式行，保异构召回）。
      // is-target 也在此做文本级判定：限定式 `pkg.compute` 的前缀若非「连到 target 的 import binding」→ 剔除误报；
      // 裸 `compute`（无前缀）无法确认 → 保留为疑似。
      if (!anyAstHit) {
        const qualifiedRe = new RegExp(`([A-Za-z_][\\w.]*)\\.\\b${needle}\\b`);
        const bareRe = new RegExp(`\\b${needle}\\b`);
        for (let i = 0; i < lines.length; i++) {
          const raw = lines[i];
          const trim = raw.trim();
          if (!trim || trim.startsWith('//') || trim.startsWith('#') || trim.startsWith('/*') || trim.startsWith('*')) continue;
          const qm = raw.match(qualifiedRe);
          if (qm) {
            // 限定引用：仅当前缀是连到 target 的 import binding 才报，否则剔除
            if (targetBindings.has(qm[1])) {
              crossRefs.push({ offset: (lineOffsets[i] ?? 0) + raw.search(qualifiedRe), line: i + 1, text: needle, kind: 'cross-usage' });
            }
            continue;
          }
          const idx = raw.search(bareRe);
          if (idx >= 0) crossRefs.push({ offset: (lineOffsets[i] ?? 0) + idx, line: i + 1, text: needle, kind: 'cross-usage' });
        }
      }
      if (crossRefs.length > 0) {
        importers.push({ file: (path.relative(resolvedRoot, f) || f).replace(/\\/g, '/'), refs: crossRefs, importSources: [] });
      }
      continue;
    }
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
  for (const r of def?.rootRefs ?? []) if (r.name === symbol!) defRefs.push({ offset: r.offset, line: lineOf(defSrc, r.offset), text: symbol!, kind: 'usage' });
  for (const r of def?.exportRefs ?? []) if (r.name === symbol!) defRefs.push({ offset: r.offset, line: lineOf(defSrc, r.offset), text: symbol!, kind: 'export_list' });

  return {
    ok: true,
    symbol: symbol!,
    mode,
    definition: { file: (path.relative(resolvedRoot, fileAbs) || fileAbs).replace(/\\/g, '/'), kind: kind ?? 'module', refs: defRefs },
    importers,
    importerCount: importers.length,
  };
}