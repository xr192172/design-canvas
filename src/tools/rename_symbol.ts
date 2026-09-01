/**
 * rename_symbol —— 跨文件符号级改名（重构套件 · 全局符号改名）
 *
 * 把"改一个模块级导出符号"从单文件局部变量升级为跨文件安全改名：
 * 改定义文件里的声明名 + 同文件内对该符号的所有引用（含 export 列表），
 * 并把所有 import 该符号的文件里的 import 子句 + 使用点一并改掉。
 *
 * 范围（本版）：
 *   - TS 系模块级符号：function / const / let / var、class、interface、type alias、enum。
 *     go/.py/java 等跨文件改名留待后版（契约/包改名语义差异大，不混做）。
 *   - 只认直连相对 import（'./x' / '../x'）；经 `export * from` 星号转发的一律阻断
 *     （星号无法按名追改下游，宁漏不误）。
 *
 * 正确性机制（关键）：
 *   - 模块级作用域解析：遍历 AST 建「作用域栈」，根作用域 = 全部模块绑定（声明 + import 说明符），
 *     每个 identifier/type_identifier 沿栈解析到最近的同名绑定；命中根作用域 → 是“模块符号的引用”，
 *     命中非根作用域 → 被局部遮蔽 → 不改（列级安全，与 ast_rename 同哲学）。
 *   - 通过 import/export 说明符的「本地名」与「远程名」区分：无别名才改写使用点；有别名只改 import 子句
 *     里的远程名，使用点（本地别名）不动。
 *   - 值符号（function/const）只改 identifier；类型符号（interface/type）只改 type_identifier；
 *     class/enum 值类型双栖，identifier 与 type_identifier 都改。
 *   - 原子性：任一阻断（新名撞名、星号转发、目标不是模块级符号）→ 全部不落盘，返回理由。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getParser } from './ts_kernel/loader.js';
import { findLanguageByExt } from './ts_kernel/languages.js';
import { parseContent } from './ts_kernel/kernel.js';
import { renameFile } from './rename_file.js';
import { resolveProjectRoot, expandClosure, loadAliasConfig, resolveAliasedImport, type AliasConfig } from './project_root.js';

// ─────────────────────────────────────────────
// 最小 tree-sitter 节点面（同 Kernel）
// ─────────────────────────────────────────────
interface N {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  childCount: number;
  child(i: number): N | null;
  childForFieldName(f: string): N | null;
}

const TS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const TS_LANG_NAMES = new Set(['typescript', 'tsx', 'javascript', 'jsx']);

type ScopeMap = Map<string, number>;

/** 值/类型引用区分 */
type NodeType = 'value' | 'type';

/** import / re-export 边（跨文件依赖 + 改名定位共用） */
export interface ImportEdge {
  /** 原始 import 路径（如 './foo'、'../bar'；相对路径才可能落到项目内） */
  source: string;
  /** 远程名（被引入/被再导出的名字）；星号为 null */
  remoteName: string | null;
  /** 远程名节点字节偏移（跨文件改名要改这里） */
  remoteOffset: number | null;
  /** 本地名（import 说明符的别名或原名；re-export 为 null） */
  localName: string | null;
  /** 是否 `import type`（类型直连，引用只可能是 type_identifier） */
  typeOnly: boolean;
  /** 星号转发 `export * from` / `export * as ns from`：不可按名追踪 → 阻断 */
  star: boolean;
  /** 是否带 source 的 re-export（`export { a } from 'x'`） */
  isReexport: boolean;
}

export interface ModuleRef {
  name: string;
  offset: number;
  nodeType: NodeType;
}

export interface ModuleAnalysis {
  /** 模块级绑定：名字 → 声明处字节偏移（import 本地名也在内） */
  rootOffsets: Map<string, number>;
  /** 模块级绑定：名字 → 符号种类 */
  rootKinds: Map<string, string>;
  /** 解析到根作用域的引用 */
  rootRefs: ModuleRef[];
  /** export 列表里的说明符本地名（`export { a }` 的 a；re-export 同） */
  exportRefs: ModuleRef[];
  /** import / re-export 边 */
  imports: ImportEdge[];
}

// ─────────────────────────────────────────────
// 模块级作用域解析（构建全局符号引用地图的地基）
// ─────────────────────────────────────────────

const FN_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'generator_function',
  'arrow_function',
  'method_definition',
]);
const CLASS_TYPES = new Set(['class_declaration', 'abstract_class_declaration']);
const VAR_TYPES = new Set(['lexical_declaration', 'variable_declaration', 'module']);
const FOR_TYPES = new Set(['for_statement', 'for_in_statement', 'for_of_statement']);
const TYPE_SYMBOL_TYPES = new Set(['interface_declaration', 'type_alias_declaration', 'enum_declaration']);

function isRefType(t: string): NodeType | null {
  if (t === 'identifier' || t === 'shorthand_property_identifier' || t === 'shorthand_property_identifier_pattern') return 'value';
  if (t === 'type_identifier') return 'type';
  return null;
}

function fieldText(n: N | null, f: string): string {
  const c = n ? n.childForFieldName(f) : null;
  return c ? c.text : '';
}

/** 结合符（field 'name'，兜底首 identifier）返回 { text, offset } 或无 */
function nameInfo(n: N): { text: string; offset: number } | null {
  const dir = n.childForFieldName('name');
  if (dir && (dir.type === 'identifier' || dir.type === 'type_identifier' || dir.type === 'property_identifier')) return { text: dir.text, offset: dir.startIndex };
  for (let i = 0; i < n.childCount; i++) {
    const c = n.child(i);
    if (c && (c.type === 'identifier' || c.type === 'type_identifier')) return { text: c.text, offset: c.startIndex };
  }
  return null;
}

function isFakePatternName(t: string): boolean {
  return t === 'object_pattern' || t === 'array_pattern';
}

function stripQuotes(s: string): string {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) || (s.startsWith('`') && s.endsWith('`'))) return s.slice(1, -1);
  return s;
}

/** 单文件模块级作用域解析（一次遍历） */
export async function analyzeModuleSource(src: string, filePath = 'file.ts'): Promise<ModuleAnalysis | null> {
  const ext = path.extname(filePath);
  if (!TS_EXTS.has(ext)) return null;
  const lang = findLanguageByExt(ext);
  if (!lang || !TS_LANG_NAMES.has(lang.name)) return null;
  const parser = await getParser(ext, lang);
  if (!parser) return null;
  let root: N;
  try {
    root = (parseContent(parser as Parameters<typeof parseContent>[0], src) as unknown as { rootNode: N }).rootNode;
  } catch {
    return null;
  }

  const rootOffsets = new Map<string, number>();
  const rootKinds = new Map<string, string>();
  const rootRefs: ModuleRef[] = [];
  const exportRefs: ModuleRef[] = [];
  const imports: ImportEdge[] = [];

  const rootScope: ScopeMap = rootOffsets as ScopeMap;
  const stack: ScopeMap[] = [rootScope];

  const declare = (scope: ScopeMap, name: string, offset: number, kind: string): void => {
    if (!scope.has(name)) scope.set(name, offset);
    if (scope === rootScope && !rootKinds.has(name)) rootKinds.set(name, kind);
  };

  const lookupIsRoot = (name: string): boolean => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].has(name)) return i === 0;
    }
    return false;
  };

  const handleImport = (node: N): void => {
    const source = stripQuotes(fieldText(node, 'source'));
    const typeOnly = /^\s*import\s+type\b/.test(node.text);
    const pushEdge = (e: Omit<ImportEdge, 'typeOnly'>) => imports.push({ ...e, typeOnly });
    // 遍历 import 子句（import_clause / namespace_import / named_imports / default）
    const walkClause = (n: N, depth = 0): void => {
      if (depth > 20) return;
      if (n.type === 'import_specifier') {
        const rm = n.childForFieldName('name');
        const al = n.childForFieldName('alias');
        const remote = rm && (rm.type === 'identifier' || rm.type === 'type_identifier') ? { text: rm.text, offset: rm.startIndex } : null;
        const local = al ? { text: al.text, offset: al.startIndex } : remote;
        if (local) declare(rootScope, local.text, local.offset, 'import');
        if (remote) pushEdge({ source, remoteName: remote.text, remoteOffset: remote.offset, localName: local ? local.text : null, star: false, isReexport: false });
        else pushEdge({ source, remoteName: null, remoteOffset: null, localName: local ? local.text : null, star: false, isReexport: false });
        return;
      }
      if (n.type === 'namespace_import') {
        const al = n.childForFieldName('alias');
        if (al) declare(rootScope, al.text, al.startIndex, 'import');
        pushEdge({ source, remoteName: null, remoteOffset: null, localName: al ? al.text : null, star: false, isReexport: false });
        return;
      }
      for (let i = 0; i < n.childCount; i++) {
        const c = n.child(i);
        if (c && c.type !== 'source') walkClause(c, depth + 1);
      }
    };
    walkClause(node);
  };

  const handleExport = (node: N): void => {
    // 递归收集该 export 子树的全部 export_specifier（嵌在 export_clause 里，非直接子节点）
    const collectSpecs = (n: N, out: N[]): void => {
      for (let i = 0; i < n.childCount; i++) {
        const c = n.child(i);
        if (!c) continue;
        if (c.type === 'export_specifier') out.push(c);
        else if (c.type !== 'source') collectSpecs(c, out);
      }
    };

    const sourceNode = node.childForFieldName('source');
    // 带 source 的 re-export（`export { a } from 'x'` / `export * from 'x'`）
    if (sourceNode) {
      const source = stripQuotes(sourceNode.text);
      const isStar = /^\s*export\s+\*(?: as [\w$]+)?\s+from/.test(node.text);
      if (isStar) {
        imports.push({ source, remoteName: null, remoteOffset: null, localName: null, typeOnly: false, star: true, isReexport: true });
        return; // 星号后面没有可追踪的说明符
      }
      const specs: N[] = [];
      collectSpecs(node, specs);
      for (const c of specs) {
        const ni = nameInfo(c);
        if (ni) {
          declare(rootScope, ni.text, ni.offset, 'reexport');
          exportRefs.push({ name: ni.text, offset: ni.offset, nodeType: 'value' });
          imports.push({ source, remoteName: ni.text, remoteOffset: ni.offset, localName: null, typeOnly: false, star: false, isReexport: true });
        }
      }
      return;
    }
    // 无 source 的 export：可能是 `export function/class/const/interface ...`（声明会被后续递归）
    // 或 `export { a }`（裸 export 列表 = 本地名引用 → exportRefs）
    const specs: N[] = [];
    collectSpecs(node, specs);
    for (const c of specs) {
      const ni = nameInfo(c);
      if (ni) {
        declare(rootScope, ni.text, ni.offset, 'exported');
        exportRefs.push({ name: ni.text, offset: ni.offset, nodeType: 'value' });
      }
    }
    // 声明类子节点交给通用递归（function_declaration 等会绑定根作用域）
  };

  const walk = (node: N, depth = 0): void => {
    if (depth > 1000) return;
    const t = node.type;

    const refType = isRefType(t);
    if (refType) {
      if (lookupIsRoot(node.text)) rootRefs.push({ name: node.text, offset: node.startIndex, nodeType: refType! });
      return;
    }

    if (t === 'import_statement') {
      handleImport(node);
      return;
    }
    if (t === 'export_statement') {
      handleExport(node);
      // 继续递归：里面可能是 function/class/interface 声明，需要绑定根作用域
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c && c.type !== 'export_specifier' && c.type !== 'export_clause' && c.type !== 'source') walk(c, depth + 1);
      }
      return;
    }
    if (t === 'import_clause' || t === 'named_imports' || t === 'namespace_import') {
      return; // import 说明符已由 handleImport 消费
    }
    if (t === 'export_specifier') {
      return; // 已由 handleExport 消费
    }

    // 声明节点：绑定名字到当前作用域，只递归其值/体，不把名字当引用
    if (FN_TYPES.has(t)) {
      const ni = nameInfo(node);
      if (ni && (t === 'function_declaration' || t === 'generator_function_declaration') && !node.text.startsWith('export default')) {
        declare(stack[stack.length - 1], ni.text, ni.offset, 'function');
      }
      // 函数体=新作用域：参数 + 体内局部
      const fnScope: ScopeMap = new Map();
      stack.push(fnScope);
      const params = node.childForFieldName('parameters');
      if (params) {
        for (let i = 0; i < params.childCount; i++) {
          const p = params.child(i);
          if (!p) continue;
          if (p.type === 'identifier') {
            // 裸标识符参数（无类型注解/解构）
            declare(fnScope, p.text, p.startIndex, 'param');
          } else {
            // 具类型参数 `p: T` / 解构：先绑定其中的参数标识符，再整段 walk 收集类型引用
            for (let j = 0; j < p.childCount; j++) {
              const idn = p.child(j);
              if (idn && idn.type === 'identifier') declare(fnScope, idn.text, idn.startIndex, 'param');
            }
            walk(p, depth + 1);
          }
        }
      }
      const body = node.childForFieldName('body') || node.childForFieldName('suite');
      if (body) walk(body, depth + 1);
      stack.pop();
      return;
    }
    if (CLASS_TYPES.has(t)) {
      const ni = nameInfo(node);
      if (ni) declare(stack[stack.length - 1], ni.text, ni.offset, 'class');
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c && c.type !== 'class_name') walk(c, depth + 1);
      }
      return;
    }
    if (t === 'interface_declaration' || t === 'type_alias_declaration') {
      const ni = nameInfo(node);
      if (ni) declare(stack[stack.length - 1], ni.text, ni.offset, t === 'interface_declaration' ? 'interface' : 'type');
      return; // 类型体内部是类型引用，交给 type_identifier 的通用处理？保守：不进入体（避免误当引用）
    }
    if (t === 'enum_declaration') {
      const ni = nameInfo(node);
      if (ni) declare(stack[stack.length - 1], ni.text, ni.offset, 'enum');
      // 枚举成员是值也是类型；此处简单跳过体（成员引用极少撞目标名，宁漏不误）
      return;
    }
    if (VAR_TYPES.has(t)) {
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (!c) continue;
        if (c.type === 'variable_declarator') {
          const nm = c.childForFieldName('name');
          const val = c.childForFieldName('value');
          const ty = c.childForFieldName('type');
          if (nm && nm.type === 'identifier') declare(stack[stack.length - 1], nm.text, nm.startIndex, 'const');
          else if (nm && isFakePatternName(nm.type)) {
            // 解构：绑定每个标识符，跳过名字子树
            for (let j = 0; j < nm.childCount; j++) {
              const idn = nm.child(j);
              if (idn && (idn.type === 'identifier' || idn.type === 'shorthand_property_identifier_pattern')) declare(stack[stack.length - 1], idn.text, idn.startIndex, 'const');
            }
          }
          // 类型注解 `: T` 也要 walk（收 type_identifier 引用）
          if (ty) walk(ty, depth + 1);
          if (val) walk(val, depth + 1);
        }
      }
      return;
    }
    if (t === 'statement_block') {
      const blockScope: ScopeMap = new Map();
      stack.push(blockScope);
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c) walk(c, depth + 1);
      }
      stack.pop();
      return;
    }
    if (FOR_TYPES.has(t)) {
      const fScope: ScopeMap = new Map();
      stack.push(fScope);
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (!c) continue;
        if (c.type === 'lexical_declaration' || c.type === 'variable_declaration') {
          for (let j = 0; j < c.childCount; j++) {
            const dec = c.child(j);
            if (dec && dec.type === 'variable_declarator') {
              const nm = dec.childForFieldName('name');
              if (nm && nm.type === 'identifier') declare(fScope, nm.text, nm.startIndex, 'const');
            }
          }
          continue;
        }
        walk(c, depth + 1);
      }
      stack.pop();
      return;
    }
    if (t === 'catch_clause') {
      const cScope: ScopeMap = new Map();
      stack.push(cScope);
      const param = node.childForFieldName('parameter');
      if (param) {
        for (let i = 0; i < param.childCount; i++) {
          const idn = param.child(i);
          if (idn && idn.type === 'identifier') declare(cScope, idn.text, idn.startIndex, 'catch');
        }
      }
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c && c.type !== 'parameter') walk(c, depth + 1);
      }
      stack.pop();
      return;
    }

    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c) walk(c, depth + 1);
    }
  };

  walk(root, 0);
  return { rootOffsets, rootKinds, rootRefs, exportRefs, imports };
}

// ─────────────────────────────────────────────
// 符号种类 → 需改写的引用节点类型
// ─────────────────────────────────────────────
function kindNodeTypes(kind: string): Set<NodeType> {
  switch (kind) {
    case 'class':
    case 'enum':
      return new Set(['value', 'type']);
    case 'interface':
    case 'type':
      return new Set(['type']);
    case 'function':
    case 'const':
    default:
      return new Set(['value']);
  }
}

// ─────────────────────────────────────────────
// 相对 import 解析（项目内文件集合来自 project_root.expandClosure）
// ─────────────────────────────────────────────
export function resolveRel(source: string, importerAbs: string, byNoExt: Map<string, string>): string | null {
  if (!source.startsWith('.')) return null; // 包导入 / 外部 → 不是项目内相对引用
  const impRelDir = path.posix.dirname(importerAbs.replace(/\\/g, '/')).replace(/\/$/, '');
  const target = path.posix.join(impRelDir, source);
  const hit = byNoExt.get(target);
  if (hit) return hit;
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']) {
    const key = target.endsWith(ext) ? target.slice(0, -ext.length) : target;
    const h = byNoExt.get(key);
    // import './x.js' 在 TS 中可指向 x.ts（allowJs/emit 产物）；命中任一 TS 系源码即接受，
    // 否则带扩展名 import（续改写产物）会漏掉 .ts/.tsx 源码目标
    if (h && (h.endsWith(ext) || TS_EXTS.has(path.extname(h)))) return h;
  }
  // 目录形式（./dir → ./dir/index.ts）
  const dirKey = target.replace(/\/+$/, '');
  for (const f of byNoExt.values()) {
    if (f.startsWith(dirKey + '/') && /(^|\/)index\.[^.]+$/.test(f)) return f;
  }
  return null;
}

export function buildNoExt(files: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of files) {
    const rel = f.replace(/\\/g, '/');
    // 去掉扩展名（含 /index）
    const noExt = rel.replace(/\.[^.]+$/, '');
    m.set(noExt, f);
    // 目录索引：./dir → ./dir/index.ts
    const base = path.posix.basename(noExt);
    if (base === 'index' || base === 'mod') m.set(path.posix.dirname(noExt), f);
  }
  return m;
}

// ─────────────────────────────────────────────
// 应用编辑（逆序，避免偏移互相影响）
// ─────────────────────────────────────────────
interface Edit {
  pos: number;
  len: number;
  text: string;
}
function applyEdits(src: string, edits: Edit[]): string {
  if (edits.length === 0) return src;
  const sorted = [...edits].sort((a, b) => b.pos - a.pos);
  let out = src;
  for (const e of sorted) out = out.slice(0, e.pos) + e.text + out.slice(e.pos + e.len);
  return out;
}

/** 结构化编辑操作：一次"旧 → 新"替换（供 LLM 直接验证，不只给计数） */
export interface RenameEditOp {
  /** 字节偏移（在源文件中） */
  pos: number;
  /** 被替换的字节数 */
  len: number;
  /** 被替换的旧文本 */
  old: string;
  /** 替换成的新文本 */
  new: string;
}

function toOps(src: string, edits: Edit[]): RenameEditOp[] {
  return edits.map((e) => ({ pos: e.pos, len: e.len, old: src.slice(e.pos, e.pos + e.len), new: e.text }));
}

// ─────────────────────────────────────────────
// 跨文件符号改名执行器
// ─────────────────────────────────────────────
export interface RenameSymbolInput {
  /** 目标项目根目录（解析 file 为绝对路径）；缺省时自动定位（git 根→manifest→file 目录） */
  project_dir?: string;
  /** 定义符号的文件（相对 project_dir 或绝对路径） */
  file: string;
  /** 旧符号名（模块级声明名/被 import 的远程名） */
  symbol: string;
  /** 新符号名（必须为合法标识符） */
  to: string;
  /** true=当符号是文件主导出（文件名=符号名）时，联动把文件也改名为 to（增量，默认 false 不改） */
  rename_file_if_matching?: boolean;
  /** true=只算结构化 diff 不落盘（dry-run 预览）；默认 false 直接改写文件 */
  dry_run?: boolean;
}

export interface RenameSymbolFileInfo {
  file: string;
  /** 实际替换的字节数 */
  edits: number;
  /** 结构化编辑操作（old→new，供 LLM 验证；dry_run 或成功后均返回） */
  ops?: RenameEditOp[];
  /** 说明（'定义+同文件引用' / 'import+引用' / 'import 子句（别名）' / 're-export'） */
  note: string;
}

export interface RenameSymbolResult {
  ok: boolean;
  symbol: string;
  to: string;
  definition?: RenameSymbolFileInfo;
  importers?: RenameSymbolFileInfo[];
  filesWritten: number;
  /** 是否 dry-run（true=未落盘，只出 diff 预览） */
  dryRun?: boolean;
  /** 联动文件名（rename_file_if_matching 且文件名=符号名时，被同步改名的新路径） */
  fileRenamed?: string;
  /** 文件联动阻断理由（符号已改名成功，仅文件联动失败时给出） */
  fileRenameBlocked?: string[];
  /** 阻断理由（ok=false 时给出全部） */
  blocked?: string[];
}

export async function renameSymbol(input: RenameSymbolInput): Promise<RenameSymbolResult> {
  const { file, symbol, to } = input;
  const renameFileIfMatching = !!input.rename_file_if_matching;
  const dryRun = input.dry_run === true;
  const blocked: string[] = [];

  // 基础校验
  if (!/^[A-Za-z_$][\w$]*$/.test(to)) return { ok: false, symbol, to, filesWritten: 0, blocked: ['新名非法：' + to] };
  if (symbol === to) return { ok: false, symbol, to, filesWritten: 0, blocked: ['新名与旧名相同：' + symbol] };

  const effectiveRoot = input.project_dir ? path.resolve(String(input.project_dir)) : undefined;
  // file 解析：绝对路径直接用；相对路径优先相对项目根（若显式给），否则相对 cwd
  const fileAbs = path.isAbsolute(file)
    ? path.resolve(file)
    : effectiveRoot
      ? path.resolve(effectiveRoot, String(file))
      : path.resolve(process.cwd(), String(file));
  const defAbs = fileAbs;
  // 项目根：显式传则用；否则自动定位（git 根→manifest→file 目录），消除"必须先知 project_dir"的摩擦
  const resolvedRoot = effectiveRoot ?? resolveProjectRoot(fileAbs);
  // tsconfig 路径别名（@/ 等）：闭包扩展与 importer 匹配共用同一份，保证"拉进闭包"与"命中改名"一致
  const aliasCfg = loadAliasConfig(resolvedRoot);

  const defExt = path.extname(defAbs);
  if (!TS_EXTS.has(defExt)) return { ok: false, symbol, to, filesWritten: 0, blocked: [`文件非 TS 系（${defExt}），跨文件改名暂只支持 TS/JS 模块级符号`] };

  const defSrc = readFileSync(defAbs, 'utf-8');
  const def = await analyzeModuleSource(defSrc, defAbs);
  if (!def) return { ok: false, symbol, to, filesWritten: 0, blocked: ['定义文件解析失败'] };
  const kind = def.rootKinds.get(symbol);
  if (!kind) return { ok: false, symbol, to, filesWritten: 0, blocked: [`"${symbol}" 不是该文件的模块级声明`] };
  if (kind === 'import' || kind === 'reexport' || kind === 'exported') {
    // 目标名是 import 绑定而非声明 → 说明该符号在本文件只是被引入/再导出，改名应从真正定义文件发起
    return { ok: false, symbol, to, filesWritten: 0, blocked: [`"${symbol}" 在 ${path.basename(defAbs)} 中是 import 绑定而非声明，请在它的定义文件上发起改名`] };
  }
  const declOffset = def.rootOffsets.get(symbol)!;
  if (def.rootKinds.has(to)) return { ok: false, symbol, to, filesWritten: 0, blocked: [`定义文件已存在同名模块级符号 "${to}"`] };

  // 定义文件编辑
  const defEditSet = new Set<number>([declOffset]);
  const defNodeTypes = kindNodeTypes(kind);
  for (const r of def.rootRefs) if (r.name === symbol && defNodeTypes.has(r.nodeType)) defEditSet.add(r.offset);
  for (const r of def.exportRefs) if (r.name === symbol) defEditSet.add(r.offset);
  const defEditList: Edit[] = [...defEditSet].map((pos) => ({ pos, len: symbol.length, text: to }));

  // 收集自包含闭包源文件（项目根内全部 + 沿 import 边/别名边扩展边界外本地文件），构建相对解析表
  const files = await expandClosure(defAbs, resolvedRoot, aliasCfg);
  const byNoExt = buildNoExt(files);

  // 解析 importer 文件
  const importerEdits: Map<string, { edits: Edit[]; note: string; src: string }> = new Map();
  // 按 importer 文件所属项目取 alias（邻域 importer 在兄弟项目里可能用各自别名；
  // memo 缓存目录→alias，避免每个文件重复读 tsconfig）
  const aliasMemo = new Map<string, AliasConfig | null>();
  const aliasFor = (fAbs: string): AliasConfig | null => {
    const d = path.dirname(fAbs);
    if (!aliasMemo.has(d)) aliasMemo.set(d, loadAliasConfig(d));
    return aliasMemo.get(d) ?? null;
  };
  for (const f of files) {
    if (path.resolve(f) === defAbs) continue;
    const ext = path.extname(f);
    if (!TS_EXTS.has(ext)) continue;
    // 导入源 → 本地文件：相对走 byNoExt 表；别名走该 importer 所在项目的 tsconfig 解析
    const fAlias = aliasFor(f);
    const resolveEdge = (source: string): string | null =>
      source.startsWith('.') ? resolveRel(source, f, byNoExt) : fAlias ? resolveAliasedImport(source, fAlias) : null;
    let fmod: ModuleAnalysis | null;
    let src: string;
    try {
      src = readFileSync(f, 'utf-8');
      fmod = await analyzeModuleSource(src, f);
    } catch {
      fmod = null;
      src = '';
    }
    if (!fmod) continue;

    let fileEdits: Edit[] = [];
    let touched = false;
    let note = '';

    for (const e of fmod.imports) {
      if (e.star) {
        // 星号转发：若指向目标文件 → 阻断
        if (e.remoteName === null) {
          const resolved = resolveEdge(e.source);
          if (resolved && path.resolve(resolved) === defAbs) blocked.push(`${path.basename(f)} 用 export * 转发自定义文件，无法按名追改下游引用`);
        }
        continue;
      }
      if (e.remoteName !== symbol) continue;
      const resolved = resolveEdge(e.source);
      if (!resolved || path.resolve(resolved) !== defAbs) continue;

      // 命中 importer。先做撞名检查（原子性：任一 importer 撞名 → 全阻断）
      if (e.remoteOffset !== null) {
        const clash = fmod.imports.some((o) => o.remoteName === to || o.localName === to);
        if (clash) blocked.push(`${path.basename(f)} 已 import 名为 "${to}" 的符号`);
      }

      // import 子句远程名 → to
      if (e.remoteOffset !== null) {
        fileEdits.push({ pos: e.remoteOffset, len: symbol.length, text: to });
        touched = true;
      }

      // 无别名 import（localName===symbol）：使用点也改
      if (!e.isReexport && e.localName === symbol) {
        const iKind = e.typeOnly ? 'type' : kind;
        const iNodeTypes = kindNodeTypes(iKind);
        for (const r of fmod.rootRefs) if (r.name === symbol && iNodeTypes.has(r.nodeType)) fileEdits.push({ pos: r.offset, len: symbol.length, text: to });
        note = e.typeOnly ? 'import+类型引用' : 'import+引用';
      } else if (e.isReexport) {
        note = 're-export';
      } else {
        note = `import 子句（别名 ${e.localName}）`;
      }
    }

    if (touched) importerEdits.set(f, { edits: fileEdits, note: note || 'import', src });
  }

  // 原子性：任一阻断 → 全部不落盘
  if (blocked.length > 0) return { ok: false, symbol, to, filesWritten: 0, blocked };

  // 落盘（dry_run=true 时只算 diff 不写文件；filesWritten 始终=实际落盘数）
  let filesWritten = 0;
  const importers: RenameSymbolFileInfo[] = [];
  if (defEditList.length > 0) {
    const out = applyEdits(defSrc, defEditList);
    if (out !== defSrc && !dryRun) {
      writeFileSync(defAbs, out, 'utf-8');
      filesWritten++;
    }
  }
  for (const [f, { edits, note, src }] of importerEdits) {
    const out = applyEdits(src, edits);
    if (out !== src && !dryRun) {
      writeFileSync(f, out, 'utf-8');
      filesWritten++;
    }
    importers.push({ file: (path.relative(resolvedRoot, f) || f).replace(/\\/g, '/'), edits: edits.filter((e) => e.len > 0).length, note, ops: toOps(src, edits) });
  }

  // 联动改名文件：当符号是文件主导出（文件名=符号名）且开启 rename_file_if_matching 时，
  // 符号已改名成功，把文件路径也同步为 to（保持"文件名=主导出"约定）。
  // 文件联动是增量增强：失败不阻断符号改名，仅记录理由。
  let fileRenamed: string | undefined;
  let fileRenameBlocked: string[] | undefined;
  if (renameFileIfMatching) {
    const defBase = path.basename(defAbs, defExt);
    if (defBase === symbol) {
      const newPath = path.join(path.dirname(defAbs), to + defExt);
      const relNew = (path.relative(resolvedRoot, newPath) || newPath).replace(/\\/g, '/');
      if (dryRun) {
        // dry-run：只出计划中的文件名，不做真实迁移
        fileRenamed = relNew;
      } else {
        const fr = await renameFile({ project_dir: resolvedRoot, from: defAbs, to: newPath, dry_run: false });
        if (fr.ok && fr.moved) {
          fileRenamed = relNew;
        } else {
          fileRenameBlocked = fr.blocked?.length ? fr.blocked : ['文件联动未执行（rename_file 返回未移动）'];
        }
      }
    }
  }

  return {
    ok: true,
    symbol,
    to,
    dryRun: dryRun || undefined,
    definition: { file: (path.relative(resolvedRoot, defAbs) || defAbs).replace(/\\/g, '/'), edits: defEditList.length, note: '定义+同文件引用', ops: toOps(defSrc, defEditList) },
    importers,
    filesWritten,
    ...(fileRenamed !== undefined ? { fileRenamed } : {}),
    ...(fileRenameBlocked !== undefined ? { fileRenameBlocked } : {}),
  };
}