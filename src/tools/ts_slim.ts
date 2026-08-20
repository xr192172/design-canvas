/**
 * ts_slim —— TS/JS 瘦身剪刀（Brick Harvest Phase 7）
 *
 * 与 go-slim 同族但进程内运行：go-slim 因 go/ast 必须 Go 子进程，TS 剪刀
 * 复用索引器同一套 tree-sitter-typescript（dependencies 已含，生产可用；
 * 且 parser 同源 → 符号行号口径与 dead_deps 的 live 档案零漂移）。
 *
 * 剪法（白名单剪枝——只剪明确判定为死的已知声明形态，其余一律保留）：
 *   - 顶层 function/class/interface/type alias/enum：名字 ∈ keep 才留
 *     （类还看 method_definition：任一方法 ∈ keep → 整类留——防"方法活
 *     而类符号未被激活"的误剪；dead_deps 方法挂靠只有类型→方法单向）
 *   - 引用救活兜底（1.5 遍，不动点）：被剪声明名字出现在保留代码的
 *     标识符引用集 → 复活——type alias/enum 不在 dead_deps 符号宇宙、
 *     类型位置引用未必建边，此网兜住 live 档案一切缺口（只多保不误剪）
 *   - 顶层 const/let/var（lexical_declaration）：名字 ∈ keep 才留——与
 *     dead_deps「值可达文件的 const 恒活」同口径（值可达 = 运行时真加载，
 *     模块级代码恒执行；type 边拉进闭包的纯类型文件 const 判死）。
 *     解构形态（const {x} = o）无法逐名判定，保守保留
 *   - import：先剪声明，再按"保留代码里的标识符引用集"过滤绑定；副作用
 *     导入（import 'm'）恒留；全死整条删，部分死重组语句文本
 *   - export：内嵌声明按声明判；export { a, b }（无 from）按名单过滤；
 *     export ... from 'm'（re-export 连接器）恒留原文（保守）
 *   - 其余顶层节点（表达式语句/注释/namespace/declare…）：一律保留
 *
 * 产物 = 原文切片拼接（不用 printer 重排）：保留声明的管辖区间
 * [前一兄弟 endIndex, 本声明 endIndex] 原样切出——前导注释随声明走，
 * 格式零重排。文件头（首语句前）与文件尾（末语句后）原文附加。
 *
 * 全空文件（无任何保留内容）返回 out=null，由编排层终判：剪后产物无人
 * import 它才整文件剔除（有人副作用 import 的空模块不能删路径）。
 */

import { getParser } from './ts_kernel/loader.js';
import { findLanguageByExt, type LanguageEntry } from './ts_kernel/languages.js';
import { parseContent } from './ts_kernel/kernel.js';

/** tree-sitter SyntaxNode（kernel 的 SyntaxNodeLike 未导出，这里最小面） */
interface NodeLike {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  childCount: number;
  child(i: number): NodeLike | null;
  childForFieldName(f: string): NodeLike | null;
}

export interface TsSlimResult {
  /** 剪后源码；null = 无保留内容（候选整文件剔除） */
  out: string | null;
  /** 保留的顶层声明名（函数/类/接口/类型别名/枚举） */
  kept_decls: string[];
  /** 剪除的顶层声明名 */
  dropped_decls: string[];
  /** 保留的 import module specifier（含副作用导入；引号原文） */
  kept_imports: string[];
  /** kept_imports 中无绑定子句的副作用导入（编排层空壳终判依据；引号原文） */
  side_effect_imports: string[];
  /** 剪除的 import module specifier（整条死 or 全部绑定死） */
  dropped_imports: string[];
  /** 保留的 import 绑定明细（编排层需求闭包用）：module 去引号 + 形态 +
   *  named 的导出名（alias 前）。default/namespace 导入目标文件的全部导出
   *  面被需要——编排层遇此类需求时目标回滚原文（保守） */
  kept_import_bindings: Array<{
    module: string;
    kind: 'named' | 'default' | 'namespace';
    names: string[];
  }>;
}

/** 声明类节点 → 名字（childForFieldName('name')，无 name 字段返回 null） */
function declName(node: NodeLike): string | null {
  const n = node.childForFieldName('name');
  if (n && n.type !== 'constructor_type') return n.text;
  return null;
}

/** lexical_declaration 的全部声明符名（const a = 1, b = 2 → ['a','b']）。
 *  解构形态（const {x} = o / const [x] = arr——name 是 pattern 不是
 *  identifier）无法逐名判定 → 返回 null，调用方走保守保留分支 */
function declaratorNames(node: NodeLike): string[] | null {
  const names: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c || c.type !== 'variable_declarator') continue;
    const n = c.childForFieldName('name');
    if (!n || n.type !== 'identifier') return null;
    names.push(n.text);
  }
  return names.length > 0 ? names : null;
}

/** 声明节点（含 lexical_declaration）→ 名字数组；null = 无法判名（保守保留） */
function declNames(node: NodeLike): string[] | null {
  if (node.type === 'lexical_declaration') return declaratorNames(node);
  const n = declName(node);
  return n === null ? null : [n];
}

/** 类的任一方法名 ∈ keep（方法活则类必须留：方法定义在类体内） */
function classHasLiveMethod(cls: NodeLike, keep: Set<string>): boolean {
  const body = cls.childForFieldName('body');
  if (!body) return false;
  for (let i = 0; i < body.childCount; i++) {
    const m = body.child(i);
    if (!m || m.type !== 'method_definition') continue;
    const n = m.childForFieldName('name');
    if (n && keep.has(n.text)) return true;
  }
  return false;
}

/** 词边界标识符引用集（正则近似：误方向=多保 import，安全） */
function collectRefs(text: string): Set<string> {
  const refs = new Set<string>();
  for (const m of text.matchAll(/(?<![\w$])[A-Za-z_$][\w$]*/g)) refs.add(m[0]);
  return refs;
}

/** import_statement → module specifier（最后一个 string 子节点，带引号原文） */
function importModule(node: NodeLike): string {
  let mod = '';
  for (let i = node.childCount - 1; i >= 0; i--) {
    const c = node.child(i);
    if (c && c.type === 'string') {
      mod = c.text;
      break;
    }
  }
  return mod;
}

/** 剪 TS/JS 单文件。keep = 该文件存活符号名集合（live_symbols_by_file） */
export async function slimTsFile(
  src: string,
  keep: string[],
  ext = '.ts',
): Promise<TsSlimResult> {
  const lang: LanguageEntry | undefined = findLanguageByExt(ext);
  const parser = lang ? await getParser(ext, lang) : null;
  if (!parser) {
    throw new Error(`tree-sitter 语言包不可用（${ext}）——TS 剪刀需要 tree-sitter-typescript`);
  }
  // kernel 同源 parse 入口：大文件（≥2^15 字符）自动走 callback 分块，
  // 规避 node-tree-sitter 的 string 上限（EINVAL，directory.ts 37K 实证）
  const tree = parseContent(
    parser as unknown as Parameters<typeof parseContent>[0],
    src,
  ) as unknown as { rootNode: NodeLike };
  const root = tree.rootNode;
  const keepSet = new Set(keep);

  // ── 第一遍：顶层语句分类与存活判定 ──
  interface Slot {
    node: NodeLike;
    /** true=保留原文切片；false=剪除；'rewrite-import'=重组 import；'rewrite-export'=重组 export 名单 */
    action: 'keep' | 'drop' | 'rewrite-import' | 'rewrite-export';
    rewritten?: string;
  }
  const slots: Slot[] = [];
  const keptDecls: string[] = [];
  const droppedDecls: string[] = [];
  const keptImports: string[] = [];
  const sideEffectImports: string[] = [];
  const droppedImports: string[] = [];
  const keptBindings: TsSlimResult['kept_import_bindings'] = [];

  const DECL_TYPES = new Set([
    'function_declaration',
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
    'type_alias_declaration',
    'enum_declaration',
  ]);

  for (let i = 0; i < root.childCount; i++) {
    const node = root.child(i);
    if (!node) continue;
    // 纯空白/分号 child：保留（切片边界零件）
    if (/^[\s;]*$/.test(node.text)) {
      slots.push({ node, action: 'keep' });
      continue;
    }
    if (node.type === 'import_statement') {
      // 副作用导入恒留；其余先占位（第二遍按引用集定夺）
      slots.push({ node, action: 'keep' });
      continue;
    }
    if (node.type === 'export_statement') {
      const decl = node.childForFieldName('declaration');
      const source = node.childForFieldName('source');
      if (source) {
        // re-export 连接器：恒留原文（指向的模块活性由 dead_deps/文件活性管）
        slots.push({ node, action: 'keep' });
        continue;
      }
      if (decl) {
        const names = declNames(decl);
        if (names === null) {
          // export default … / export declare … / export const {x} = … 等形态：保守保留
          slots.push({ node, action: 'keep' });
          continue;
        }
        const live =
          names.some((n) => keepSet.has(n)) ||
          ((decl.type === 'class_declaration' || decl.type === 'abstract_class_declaration') &&
            classHasLiveMethod(decl, keepSet));
        slots.push({ node, action: live ? 'keep' : 'drop' });
        if (live) keptDecls.push(...names);
        else droppedDecls.push(...names);
        continue;
      }
      // export { a, b }（本地名单）：第二遍按 keep 过滤
      slots.push({ node, action: 'rewrite-export' });
      continue;
    }
    if (DECL_TYPES.has(node.type)) {
      const name = declName(node);
      if (name === null) {
        slots.push({ node, action: 'keep' });
        continue;
      }
      const live =
        keepSet.has(name) ||
        ((node.type === 'class_declaration' || node.type === 'abstract_class_declaration') &&
          classHasLiveMethod(node, keepSet));
      slots.push({ node, action: live ? 'keep' : 'drop' });
      if (live) keptDecls.push(name);
      else droppedDecls.push(name);
      continue;
    }
    if (node.type === 'lexical_declaration') {
      // 顶层 const/let/var 按名字判活（与 dead_deps 值可达 const 同口径）：
      // 值可达文件的 const 在 live 根集（模块加载即执行）；type 边拉进闭包
      // 的纯类型文件（configs 全家）运行时不加载——const 判死剪掉，其
      // import 随第二遍引用过滤脱落。解构/无声明符形态保守保留
      const names = declaratorNames(node);
      if (names === null) {
        slots.push({ node, action: 'keep' });
        continue;
      }
      const live = names.some((n) => keepSet.has(n));
      slots.push({ node, action: live ? 'keep' : 'drop' });
      if (live) keptDecls.push(...names);
      else droppedDecls.push(...names);
      continue;
    }
    // 表达式语句 + 注释 + 未知形态：保守保留（表达式语句有副作用风险）
    slots.push({ node, action: 'keep' });
  }

  // ── 1.5 声明引用救活（不动点）──
  // live 档案缺口的兜底网：type alias/enum 不在 ts_kernel symbol_nodes
  // （dead_deps 符号宇宙无它们），类型位置的引用（`id: PresetId`）也未必
  // 建边——被剪声明被保留代码引用（词法扫描）则复活；复活声明正文又可能
  // 引用其他被剪声明 → 迭代至不动点。误方向 = 多保（宁漏报死，不误剪），
  // 与贫困编译验证层互为守门（ua_theme_engine 实证：PresetId/HeadingFont
  // 被剪导致 TS2304）。引用集口径与第二遍一致：只看保留的非 import 语句。
  for (;;) {
    const rescueRefs = collectRefs(
      slots
        .filter((s) => s.action === 'keep' && s.node.type !== 'import_statement')
        .map((s) => s.node.text)
        .join('\n'),
    );
    let changed = false;
    for (const slot of slots) {
      if (slot.action !== 'drop') continue;
      // 此刻 drop 态只会是顶层/export 内嵌声明（import 与 export 名单尚未判）
      const decl =
        slot.node.type === 'export_statement'
          ? slot.node.childForFieldName('declaration')
          : slot.node;
      const names = decl ? declNames(decl) : null;
      if (names === null || !names.some((n) => rescueRefs.has(n))) continue;
      slot.action = 'keep';
      for (const n of names) {
        const i = droppedDecls.indexOf(n);
        if (i >= 0) droppedDecls.splice(i, 1);
        keptDecls.push(n);
      }
      changed = true;
    }
    if (!changed) break;
  }

  // ── 第二遍：import 绑定过滤（引用集只来自【保留】的非 import 语句——
  // 被剪语句与 export 名单语句自身的标识符不得反向保活）──
  const nonImportText = slots
    .filter((s) => s.action === 'keep' && s.node.type !== 'import_statement')
    .map((s) => s.node.text)
    .join('\n');
  const refs = collectRefs(nonImportText);

  for (const slot of slots) {
    if (slot.node.type !== 'import_statement') continue;
    const node = slot.node;
    const mod = importModule(node);
    if (!mod) {
      // 解析不出模块串（异常形态）：保守保留
      continue;
    }
    // import_clause：default(identifier) / namespace(* as ns) / named({…})
    let defaultName: string | null = null;
    let nsName: string | null = null;
    const named: Array<{ label: string; exportName: string }> = []; // label = 引用名（alias 优先）；exportName = 导出名（alias 前）
    let hasClause = false;
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (!c) continue;
      if (c.type === 'import_clause') {
        hasClause = true;
        for (let j = 0; j < c.childCount; j++) {
          const p = c.child(j);
          if (!p) continue;
          if (p.type === 'identifier' && p.childForFieldName('name') === null) defaultName = p.text;
          else if (p.type === 'namespace_import') {
            for (let k = 0; k < p.childCount; k++) {
              const q = p.child(k);
              if (q && q.type === 'identifier') nsName = q.text;
            }
          } else if (p.type === 'named_imports') {
            for (let k = 0; k < p.childCount; k++) {
              const spec = p.child(k);
              if (!spec || spec.type !== 'import_specifier') continue;
              const alias = spec.childForFieldName('alias');
              const base = spec.childForFieldName('name');
              const refName = alias?.text ?? base?.text ?? '';
              if (refName) {
                named.push({
                  label: alias && base ? `${base.text} as ${alias.text}` : refName,
                  exportName: base?.text ?? refName,
                });
              }
            }
          }
        }
      }
    }
    if (!hasClause) {
      // 副作用导入：恒留
      keptImports.push(mod);
      sideEffectImports.push(mod);
      continue;
    }
    const keepDefault = defaultName !== null && refs.has(defaultName);
    const keepNs = nsName !== null && refs.has(nsName);
    const keepNamed = named.filter((n) => refs.has(n.label.split(' as ').pop()!));
    if (!keepDefault && !keepNs && keepNamed.length === 0) {
      slot.action = 'drop';
      droppedImports.push(mod);
      continue;
    }
    keptImports.push(mod);
    // 保留的绑定明细（编排层需求闭包：目标文件必须提供这些导出）
    const modRaw = mod.replace(/^['"]|['"]$/g, '');
    if (keepDefault) keptBindings.push({ module: modRaw, kind: 'default', names: [] });
    if (keepNs) keptBindings.push({ module: modRaw, kind: 'namespace', names: [] });
    if (keepNamed.length > 0) {
      keptBindings.push({ module: modRaw, kind: 'named', names: keepNamed.map((n) => n.exportName) });
    }
    if (keepDefault && !keepNs && keepNamed.length === 0 && defaultName) {
      continue; // 原文即净（单 default 且活）
    }
    if (keepNs && !keepDefault && keepNamed.length === 0 && nsName) {
      continue; // 原文即净（单 namespace 且活）
    }
    // 需要重组：import [type] x, * as ns, { a, b as c } from 'mod';
    // `import type` 修饰符必须保留——丢了会把编译期依赖变运行时值导入
    const parts: string[] = [];
    if (keepDefault && defaultName) parts.push(defaultName);
    if (keepNs && nsName) parts.push(`* as ${nsName}`);
    if (keepNamed.length > 0) parts.push(`{ ${keepNamed.map((n) => n.label).join(', ')} }`);
    slot.action = 'rewrite-import';
    const typeKw = /^import\s+type\b/.test(node.text) ? 'type ' : '';
    slot.rewritten = `import ${typeKw}${parts.join(', ')} from ${mod};`;
  }

  // ── export { a, b } 本地名单过滤 ──
  // 注：export_clause 是 named child 但无 field 名（实测 tree-sitter-typescript），
  // 须按类型遍历而非 childForFieldName
  for (const slot of slots) {
    if (slot.action !== 'rewrite-export') continue;
    let clause: NodeLike | null = null;
    for (let i = 0; i < slot.node.childCount; i++) {
      const c = slot.node.child(i);
      if (c && c.type === 'export_clause') {
        clause = c;
        break;
      }
    }
    if (!clause) {
      slot.action = 'keep';
      continue;
    }
    const survivors: string[] = [];
    for (let i = 0; i < clause.childCount; i++) {
      const spec = clause.child(i);
      if (!spec || spec.type !== 'export_specifier') continue;
      const alias = spec.childForFieldName('alias');
      const base = spec.childForFieldName('name');
      const refName = alias?.text ?? base?.text ?? '';
      if (refName && (keepSet.has(refName) || refs.has(refName))) {
        survivors.push(alias && base ? `${base.text} as ${alias.text}` : refName);
      }
    }
    if (survivors.length === 0) {
      slot.action = 'drop';
    } else {
      slot.rewritten = `export { ${survivors.join(', ')} };`;
    }
  }

  // ── 切片拼装（保留节点管辖区间 = [前一兄弟 endIndex, 本节点 endIndex]） ──
  const segs: string[] = [];
  let boundary = 0;
  let anyKept = false;
  for (const slot of slots) {
    if (slot.action === 'drop') {
      // 整个管辖区（前导注释 + 声明正文）随声明消亡——boundary 直接跳到
      // 声明末尾，下一条保留语句的切片不含死声明任何字节
      boundary = slot.node.endIndex;
      continue;
    }
    anyKept = true;
    if (slot.action === 'rewrite-import' || slot.action === 'rewrite-export') {
      const prefix = src.slice(boundary, slot.node.startIndex);
      segs.push(prefix + (slot.rewritten ?? ''));
    } else {
      segs.push(src.slice(boundary, slot.node.endIndex));
    }
    boundary = slot.node.endIndex;
  }
  if (!anyKept) return { out: null, kept_decls: keptDecls, dropped_decls: droppedDecls, kept_imports: keptImports, side_effect_imports: sideEffectImports, dropped_imports: droppedImports, kept_import_bindings: keptBindings };
  // 文件尾（末语句之后的注释/空白）原样附加
  segs.push(src.slice(boundary));
  const out = segs.join('').replace(/\n{3,}$/g, '\n');
  if (!out.trim()) {
    return { out: null, kept_decls: keptDecls, dropped_decls: droppedDecls, kept_imports: keptImports, side_effect_imports: sideEffectImports, dropped_imports: droppedImports, kept_import_bindings: keptBindings };
  }
  return { out, kept_decls: keptDecls, dropped_decls: droppedDecls, kept_imports: keptImports, side_effect_imports: sideEffectImports, dropped_imports: droppedImports, kept_import_bindings: keptBindings };
}
