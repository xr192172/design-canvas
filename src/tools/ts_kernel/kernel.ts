/**
 * Tree-sitter Kernel
 *
 * 统一接口：parseFile(path, content) → ParsedSymbol[]
 *
 * 设计原则：
 *   1. 零硬编码 import（不再有 `import Go from 'tree-sitter-go'`）
 *   2. 自动探测本地已装的语言包（probe）
 *   3. 动态加载（loader）+ 缓存
 *   4. 失败优雅降级（返回空数组，不抛）
 *   5. 可被多个工具共享（consistency / backfill / 未来的 lint/format）
 *
 * 用法：
 *   import { parseFile, listSupportedLanguages } from './ts_kernel';
 *   const symbols = await parseFile('src/app.go', goSource);
 *
 * 共享给其他项目（如 ai-base）：
 *   - 抽出为 @design-canvas/ts-kernel 包
 *   - 两边项目 npm install 后都能用
 *   - 用户只需装一次 tree-sitter-* 包
 */

import path from 'node:path';
import type Parser from 'tree-sitter';
import { findLanguageByExt, LanguageEntry } from './languages.js';
import { isLanguageInstalled, isExtSupported, listSupportedExts, probeInstalledLanguages } from './probe.js';
import { getParser, clearLoaderCache } from './loader.js';

export interface ParsedSymbol {
  name: string;
  kind: 'function' | 'method' | 'class' | 'interface' | 'type';
  start_line: number;
  end_line: number;
  qualified_name: string;
  signature: string;
  parent?: string;
}

/** import 依赖（用于 import_project 的跨文件边推导） */
export interface ParsedImport {
  /** 原始 import 路径（如 './foo/bar'、'myproject/internal/x'、'os.path'；Python 相对导入保留前导点如 '..pkg'） */
  source: string;
  /** relative = 相对路径（./ ../ 或 Python 前导点）；package = 包路径 */
  kind: 'relative' | 'package';
  line: number;
}

/** 函数级调用边（同文件内，AST 提取，路线图序号 3 的第一步） */
export interface ParsedCall {
  /** 调用者符号 qualified_name（同文件内） */
  caller: string;
  /** 被调用名（去点后的尾部标识符，如 'Process' from 'svc.Process' / 'this.method'） */
  callee: string;
  /** 完整被调用表达式（含前缀，如 'svc.Process'），未解析时写入 unresolved_refs */
  callee_expr: string;
  line: number;
  /** 同文件符号表命中（true）——false 表示外部/内置/跨文件候选 */
  resolved: boolean;
  /** resolved 时对应的同文件符号 qualified_name */
  callee_qn?: string;
}

// ─────────────────────────────────────────────────────────────
// 节点类型 → 通用 Symbol kind 映射
// ─────────────────────────────────────────────────────────────

function nodeTypeToKind(nodeType: string, parent?: string): ParsedSymbol['kind'] {
  if (nodeType.includes('class')) return 'class';
  if (nodeType.includes('interface')) return 'interface';
  if (nodeType.includes('method')) return 'method';
  if (nodeType.includes('struct') || nodeType.includes('trait') || nodeType.includes('impl')) return 'type';
  if (nodeType === 'function_definition' || nodeType === 'function_declaration' || nodeType === 'function_item' || nodeType === 'FnDecl' || nodeType === 'proc_def' || nodeType === 'method' || nodeType === 'sub' || nodeType === 'proc') {
    return parent ? 'method' : 'function';
  }
  if (nodeType.includes('type') || nodeType.includes('FnDecl') || nodeType === 'method_declaration') {
    if (parent) return 'method';
    if (nodeType.includes('declaration') || nodeType.includes('definition') || nodeType.includes('spec')) return 'type';
  }
  if (nodeType === 'method_declaration') return 'method';
  if (parent) return 'method';
  return 'function';
}

// ─────────────────────────────────────────────────────────────
// 通用遍历器
// ─────────────────────────────────────────────────────────────

interface SyntaxNodeLike {
  type: string;
  startPosition: { row: number };
  endPosition: { row: number };
  text: string;
  /** 命名节点标记（匿名关键字/标点为 false——'else'/'if' 等关键字 type 也是纯字母，\w 正则无法区分） */
  isNamed?: boolean;
  childForFieldName(name: string): SyntaxNodeLike | null;
  child(index: number): SyntaxNodeLike | null;
  childCount: number;
}

function fieldText(node: SyntaxNodeLike | null, fieldName: string): string {
  if (!node) return '';
  const child = node.childForFieldName(fieldName);
  return child ? child.text : '';
}

/** 标识符合法性：非空、长度 ≤ 64、只含字母数字下划线 $、不以数字开头 */
function isValidIdentifier(s: string): boolean {
  if (!s || s.length === 0 || s.length > 64) return false;
  if (/^\d/.test(s)) return false;
  return /^[A-Za-z_$][\w$]*$/.test(s);
}

function extractName(node: SyntaxNodeLike, fieldMap: LanguageEntry['field_map']): string {
  const direct = fieldText(node, fieldMap.name);
  if (direct && isValidIdentifier(direct)) return direct;

  // 兜底：从第一个 identifier 子节点取
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && (child.type === 'identifier' || child.type === 'property_identifier' || child.type === 'type_identifier' || child.type === 'name')) {
      const text = child.text;
      if (isValidIdentifier(text)) return text;
    }
  }
  return '';
}

function stripParens(s: string): string {
  s = s.trim();
  if (s.startsWith('(') && s.endsWith(')')) {
    s = s.slice(1, -1);
  }
  return s.trim();
}

function buildSignature(node: SyntaxNodeLike, fieldMap: LanguageEntry['field_map'], lang: LanguageEntry): string {
  const name = extractName(node, fieldMap);
  const rawParams = fieldText(node, fieldMap.parameters || '');
  const params = stripParens(rawParams);

  if (lang.name === 'go') {
    const result = fieldText(node, fieldMap.return_type || '');
    const receiver = fieldText(node, fieldMap.receiver || '');
    // receiver text 如 "(u *UserService)" 或 "u *UserService"
    const receiverClean = stripParens(receiver);
    const receiverMatch = receiverClean.match(/(?:\*\s*)?(\w+)$/);
    const receiverName = receiverMatch ? receiverMatch[1] : '';
    if (receiverName) {
      return `${receiverName}.${name}(${params})${result ? ' ' + result : ''}`;
    }
    return `${name}(${params})${result ? ' ' + result : ''}`;
  }

  if (lang.name === 'python') {
    const ret = fieldText(node, fieldMap.return_type || '');
    // 移除 self 参数
    const cleanParams = params.replace(/^self\s*,?\s*/, '').trim();
    return `${name}(${cleanParams})${ret ? ' -> ' + ret : ''}`;
  }

  if (lang.name === 'rust') {
    const ret = fieldText(node, fieldMap.return_type || '');
    return `${name}(${params})${ret ? ' -> ' + ret : ''}`;
  }

  if (lang.name === 'java' || lang.name === 'c_sharp' || lang.name === 'kotlin' || lang.name === 'swift') {
    const ret = fieldText(node, fieldMap.return_type || '');
    return `${name}(${params})${ret ? ': ' + ret : ''}`;
  }

  // TypeScript / JavaScript / C / C++ 等
  const ret = fieldText(node, fieldMap.return_type || '');
  return `${name}(${params})${ret ? ': ' + ret : ''}`;
}

// ─────────────────────────────────────────────────────────────
// 通用遍历提取符号
// ─────────────────────────────────────────────────────────────

function traverseAndExtract(
  node: SyntaxNodeLike,
  lang: LanguageEntry,
  symbols: ParsedSymbol[],
  parent: string | undefined,
  depth: number = 0
): void {
  if (depth > 100) return; // 防止无限递归

  if (lang.symbol_nodes.includes(node.type)) {
    const name = extractName(node, lang.field_map);
    if (name) {
      const kind = nodeTypeToKind(node.type, parent);
      const signature = buildSignature(node, lang.field_map, lang);
      const qn = parent ? `${parent}.${name}` : name;
      symbols.push({
        name,
        kind,
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        qualified_name: qn,
        signature,
        parent,
      });

      // 进入 body 继续提取（找方法/嵌套类）
      const body = node.childForFieldName('body') || node.childForFieldName('suite');
      if (body) {
        for (let i = 0; i < body.childCount; i++) {
          const child = body.child(i);
          if (child) traverseAndExtract(child, lang, symbols, name, depth + 1);
        }
        return;
      }
      // 兜底：直接遍历子节点（如 Python class 的 body 可能不是标准 body 字段）
      if (node.type === 'class_definition' || node.type === 'class_declaration') {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) traverseAndExtract(child, lang, symbols, name, depth + 1);
        }
        return;
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) traverseAndExtract(child, lang, symbols, parent, depth + 1);
  }
}

// ─────────────────────────────────────────────────────────────
// 调用边提取（函数级，AST 级，路线图序号 3）
// ─────────────────────────────────────────────────────────────

/** 各语言 call 节点类型 */
const CALL_NODES: Record<string, string> = {
  go: 'call_expression',
  typescript: 'call_expression',
  tsx: 'call_expression',
  javascript: 'call_expression',
  jsx: 'call_expression',
  python: 'call',
};

function isCallNode(node: SyntaxNodeLike, lang: LanguageEntry): boolean {
  return CALL_NODES[lang.name] === node.type;
}

/** 从 call 节点提取被调用名：取 function 字段文本的尾部标识符（去点、去泛型参数） */
function extractCallee(callNode: SyntaxNodeLike, langName: string): { name: string; expr: string } | null {
  const fn = callNode.childForFieldName('function');
  if (!fn) return null;
  const expr = fn.text;
  // 泛型调用 fn<T>(...)：取 < 前的基底再取尾部标识符（`svc.Process` → Process / `a.b.c` → c）
  const base = expr.split('<')[0].trim();
  const m = base.match(/([A-Za-z_$][\w$]*)\s*$/);
  if (!m) return null;
  const name = m[1];
  if (!isValidIdentifier(name)) return null;
  return { name, expr };
}

/**
 * 遍历函数体提取调用边（跳过嵌套函数声明子树——其调用归属嵌套函数自身，
 * 由 traverseAndExtractCalls 递归处理）。
 */
function extractCallsFromBody(
  node: SyntaxNodeLike,
  lang: LanguageEntry,
  callerQn: string,
  calls: ParsedCall[],
  symbols: ParsedSymbol[],
  depth: number = 0
): void {
  if (depth > 200) return;
  if (lang.symbol_nodes.includes(node.type)) return;
  if (isCallNode(node, lang)) {
    const c = extractCallee(node, lang.name);
    if (c) {
      const sym = symbols.find((s) => s.name === c.name);
      calls.push({
        caller: callerQn,
        callee: c.name,
        callee_expr: c.expr,
        line: node.startPosition.row + 1,
        resolved: !!sym,
        callee_qn: sym ? sym.qualified_name : undefined,
      });
    }
    // 继续递归子节点：参数/回调中可能嵌套调用（如 fmt.Println(hello(x)) / arr.map(fn)）
    // callee 表达式（identifier/selector）不是 call 节点，不会被误提取
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) extractCallsFromBody(child, lang, callerQn, calls, symbols, depth + 1);
  }
}

/**
 * 遍历 AST 提取调用边：调用归属 = 包含它的最近函数/方法符号（class 压栈仅为限定名，
 * 不提取调用）。与符号提取独立遍历（先符号后调用），保证 nameToQn 完整。
 */
function traverseAndExtractCalls(
  node: SyntaxNodeLike,
  lang: LanguageEntry,
  symbols: ParsedSymbol[],
  calls: ParsedCall[],
  funcStack: string[] = [],
  depth: number = 0
): void {
  if (depth > 200) return;
  if (lang.symbol_nodes.includes(node.type)) {
    const name = extractName(node, lang.field_map);
    if (name) {
      const qn = funcStack.length > 0 ? `${funcStack[funcStack.length - 1]}.${name}` : name;
      const kind = nodeTypeToKind(node.type, funcStack.length > 0 ? funcStack[funcStack.length - 1] : undefined);
      const body = node.childForFieldName('body') || node.childForFieldName('suite');
      if (body) {
        funcStack.push(qn);
        if (kind === 'function' || kind === 'method') {
          // 本函数体调用（跳过嵌套函数子树）
          for (let i = 0; i < body.childCount; i++) {
            const child = body.child(i);
            if (child) extractCallsFromBody(child, lang, qn, calls, symbols, depth + 1);
          }
        }
        // 继续递归找方法/嵌套函数
        for (let i = 0; i < body.childCount; i++) {
          const child = body.child(i);
          if (child) traverseAndExtractCalls(child, lang, symbols, calls, funcStack, depth + 1);
        }
        funcStack.pop();
      }
      return;
    }
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) traverseAndExtractCalls(child, lang, symbols, calls, funcStack, depth + 1);
  }
}

// ─────────────────────────────────────────────────────────────
// import 提取（逐语言）
// ─────────────────────────────────────────────────────────────

function stripQuotes(s: string): string {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) || (s.startsWith('`') && s.endsWith('`'))) {
    return s.slice(1, -1);
  }
  return s;
}

/** 从 import 节点提取 source 列表（一个节点可能含多个 source，如 Python `import a, b`） */
function extractImportSources(node: SyntaxNodeLike, langName: string): string[] {
  if (langName === 'go') {
    // import_spec → path 字段（interpreted_string_literal）
    const p = fieldText(node, 'path');
    return p ? [stripQuotes(p)] : [];
  }
  if (langName === 'typescript' || langName === 'tsx' || langName === 'javascript' || langName === 'jsx') {
    // import_statement → source 字段（string）
    const s = fieldText(node, 'source');
    return s ? [stripQuotes(s)] : [];
  }
  if (langName === 'python') {
    if (node.type === 'import_statement') {
      // import a, b as c, d.e —— 收集所有 dotted_name（含 aliased_import 内嵌的）
      const out: string[] = [];
      const collect = (n: SyntaxNodeLike): void => {
        for (let i = 0; i < n.childCount; i++) {
          const c = n.child(i);
          if (!c) continue;
          if (c.type === 'dotted_name') out.push(c.text);
          else if (c.type === 'aliased_import') collect(c);
        }
      };
      collect(node);
      return out;
    }
    if (node.type === 'import_from_statement') {
      // from .foo import x / from pkg.mod import y —— 用节点文本解析前导点（AST 中 relative_import 结构不稳定）
      const m = node.text.match(/^\s*from\s+(\.*)([\w.]*)\s+import/);
      if (!m) return [];
      const dots = m[1] || '';
      const mod = m[2] || '';
      if (dots) return [dots + mod];
      return mod ? [mod] : [];
    }
  }
  return [];
}

function traverseAndExtractImports(
  node: SyntaxNodeLike,
  lang: LanguageEntry,
  imports: ParsedImport[],
  depth: number = 0
): void {
  if (depth > 100 || !lang.import_nodes || lang.import_nodes.length === 0) return;
  if (lang.import_nodes.includes(node.type)) {
    const sources = extractImportSources(node, lang.name);
    for (const src of sources) {
      imports.push({
        source: src,
        kind: src.startsWith('.') ? 'relative' : 'package',
        line: node.startPosition.row + 1,
      });
    }
    return; // import 节点内部不再递归
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) traverseAndExtractImports(child, lang, imports, depth + 1);
  }
}

// ─────────────────────────────────────────────────────────────
// 公开 API
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// 大文件解析：node-tree-sitter 的 parse(string) 在内容 ≥ 32768 字符时
// 抛 "Invalid argument"（内部 UTF-16 缓冲限制）。规避方式：
// 改用 callback 输入（parse((byteOffset) => string)）。
//
// 编码语义（实测 + node_modules/tree-sitter/src/parser.cc）：
//   parser 以 UTF-16 编码读取，callback 收到的 offset 就是 UTF-16 码元索引，
//   可直接作为 JS 字符串索引（代理对占 2 码元，与 JS string 一致，天然对齐）。
// ─────────────────────────────────────────────────────────────

/** 字符串 parse 的字符数上限（node-tree-sitter 限制 2^15） */
const STRING_PARSE_LIMIT = 32768;
/** callback 每次返回的块大小（字符数，避免 O(n²) 全量返回） */
const CALLBACK_CHUNK = 8192;

interface TreeLike {
  rootNode: SyntaxNodeLike;
}
type ParserLike = { parse: (input: string | ((byteOffset: number) => string)) => TreeLike };

/** 用 callback 方式解析（规避 32KB 限制；offset 即 UTF-16 码元索引） */
function parseViaCallback(parser: ParserLike, content: string): TreeLike {
  const len = content.length;
  return parser.parse((offset: number): string => {
    const lo = Math.min(offset, len);
    if (lo >= len) return '';
    let end = Math.min(lo + CALLBACK_CHUNK, len);
    // 不在代理对中间截断（高代理结尾则少送一个字符）
    if (end < len) {
      const tail = content.charCodeAt(end - 1);
      if (tail >= 0xd800 && tail <= 0xdbff) end--;
    }
    return content.slice(lo, end);
  });
}

/** 统一 parse 入口：小文件走快速 string 路径，大文件走 callback 路径 */
function parseContent(parser: ParserLike, content: string): TreeLike {
  if (content.length < STRING_PARSE_LIMIT) {
    return parser.parse(content);
  }
  return parseViaCallback(parser, content);
}

/**
 * AST 级解析入口：供控制流（CFG）等结构化分析使用。
 * 与 parseFileFull 同一 parse 管线（含 32KB callback 规避），失败返回 null。
 */
export async function parseAstRoot(
  filePath: string,
  content: string,
): Promise<{ root: SyntaxNodeLike; langName: string } | null> {
  const ext = path.extname(filePath);
  const lang = findLanguageByExt(ext);
  if (!lang) return null;
  const parser = await getParser(ext, lang);
  if (!parser) return null;
  try {
    const tree = parseContent(parser as ParserLike, content);
    return { root: tree.rootNode, langName: lang.name };
  } catch {
    return null;
  }
}

export type { SyntaxNodeLike };

/** 单文件完整解析结果（一次 parse，符号 + import + 调用边三产出） */
export interface ParsedFile {
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  /** 函数级调用边（同文件解析；跨文件/外部为 resolved=false，见 ParsedCall） */
  calls: ParsedCall[];
  /** 解析失败原因（语言包加载失败 / parse 抛错）；成功时缺省。
   *  调用方借此区分"文件本为空"与"解析静默失败"（后者会丢依赖边）。 */
  error?: string;
}

/**
 * 解析文件的符号与 import 依赖（单次 AST parse）。
 * 返回空数组字段表示：文件类型不支持 / 解析失败 / 无对应内容。
 */
export async function parseFileFull(filePath: string, content: string): Promise<ParsedFile> {
  const empty: ParsedFile = { symbols: [], imports: [], calls: [] };
  const ext = '.' + (filePath.split('.').pop() || '');
  const lang = isExtSupported(ext);
  if (!lang) return empty;

  const parser = await getParser(ext, lang);
  if (!parser) return { ...empty, error: `语言包加载失败: ${lang}` };

  try {
    const tree = parseContent(parser as ParserLike, content);
    const symbols: ParsedSymbol[] = [];
    const imports: ParsedImport[] = [];
    const calls: ParsedCall[] = [];
    traverseAndExtract(tree.rootNode, lang, symbols, undefined);
    traverseAndExtractImports(tree.rootNode, lang, imports);
    traverseAndExtractCalls(tree.rootNode, lang, symbols, calls);
    return { symbols, imports, calls };
  } catch (e) {
    console.warn(`[ts_kernel] parse ${filePath} failed: ${(e as Error).message}`);
    return { ...empty, error: (e as Error).message };
  }
}

/**
 * 解析文件的符号。返回空数组表示：文件类型不支持 / 解析失败 / 文件为空。
 */
export async function parseFile(filePath: string, content: string): Promise<ParsedSymbol[]> {
  return (await parseFileFull(filePath, content)).symbols;
}

/** 检查扩展名是否被支持（且已安装对应语言包） */
export function isSupported(ext: string): boolean {
  return isExtSupported(ext) !== null;
}

/** 列出所有已安装并启用的语言 */
export function listSupportedLanguages(): string[] {
  return probeInstalledLanguages().map((l) => l.name);
}

/** 列出所有支持的扩展名 */
export function listSupportedExtensions(): string[] {
  return listSupportedExts();
}

/** 重置内部缓存（测试用） */
export function _reset(): void {
  clearLoaderCache();
}

export { findLanguageByExt, isLanguageInstalled };
export type { LanguageEntry };
