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
 * 共享给其他项目：
 *   - 抽出为 @design-canvas/ts-kernel 包
 *   - 各项目 npm install 后都能用
 *   - 用户只需装一次 tree-sitter-* 包
 */

import path from 'node:path';
import type Parser from 'tree-sitter';
import { findLanguageByExt, LanguageEntry } from './languages.js';
import { isLanguageInstalled, isExtSupported, listSupportedExts, probeInstalledLanguages } from './probe.js';
import { getParser, clearLoaderCache } from './loader.js';

export interface ParsedSymbol {
  name: string;
  kind: 'function' | 'method' | 'class' | 'interface' | 'type' | 'const';
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
  /**
   * TS 系 `import type { X } from ...`——整条语句运行时擦除（零运行时依赖）。
   * 闭包/依赖方向/外部依赖三分类均不算边；shapes 消费（类型引用）另论。
   * `import { type X }`（混合语句单说明符）不算——语句仍保留，保守不标。
   */
  type_only?: boolean;
  /**
   * 该 import 绑定的「本地可用名字」（Go/Python 提取；TS 系走 ImportEdge.remoteName/localName 精确，不填）。
   * 用途：符号级跨语言引用判定——给定使用点 token（如 `pkg.Symbol` 的 `pkg`、`from x import n` 的 `n`，
   * 判定它源自哪个 import 边，从而验证是否连向 target 定义模块。
   */
  bindings?: string[];
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

/** 类型引用边（同文件内）：函数/类签名或体内引用了 interface/type/class 符号。
 *  波及语义：改类型定义 → 所有引用者受影响（call 图对此不可见） */
export interface ParsedTypeRef {
  /** 引用者符号 qualified_name（归属包含它的最近符号） */
  referrer: string;
  /** 被引用类型名 */
  type_name: string;
  line: number;
  /** 同文件符号表命中（interface/type/class） */
  resolved: boolean;
  /** resolved 时对应的同文件类型符号 qualified_name */
  target_qn?: string;
}

// ─────────────────────────────────────────────────────────────
// 节点类型 → 通用 Symbol kind 映射
// ─────────────────────────────────────────────────────────────

function nodeTypeToKind(nodeType: string, parent?: string): ParsedSymbol['kind'] {
  if (nodeType.includes('class')) return 'class';
  if (nodeType.includes('interface')) return 'interface';
  // enum 是类型也是值：映射 'type' 才能被跨文件 type_ref 解析命中
  // （resolveCrossFileCalls 的 typeNamesByFile 只认 interface/type/class；
  // 落到末尾的 'function' 会漏——v7 清库重解析后生效）
  if (nodeType.includes('enum')) return 'type';
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
  /** 字符级字节偏移（tree-sitter 节点原生支持，供文本注入/插桩使用） */
  startIndex?: number;
  endIndex?: number;
  /** 命名节点标记（匿名关键字/标点为 false——'else'/'if' 等关键字 type 也是纯字母，\w 正则无法区分） */
  isNamed?: boolean;
  /** 子树含 ERROR/MISSING 节点（tree-sitter 容错解析不抛错，靠此标记识别语法破坏） */
  hasError?: boolean;
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

  // 顶层 const/let/var（TS/JS）：具名值绑定也算符号——handler 形态
  // （const xxxHandler = wrap(...)）是 server_registry 等文件的主体结构。
  // 只索引顶层（parent===undefined）：局部 const 同名多、噪音大且定位价值低；
  // 解构（object_pattern）与多声明器跳过（符号名无法稳定表达）。不进 body 递归
  // ——初始化器内的局部 function 不提升为顶层符号（闭包私有，本就不该独立可见）。
  if (
    parent === undefined &&
    (node.type === 'lexical_declaration' || node.type === 'variable_declaration')
  ) {
    const declarators: SyntaxNodeLike[] = [];
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c && c.type === 'variable_declarator') declarators.push(c);
    }
    if (declarators.length === 1) {
      const nameNode = declarators[0].childForFieldName('name');
      if (nameNode && nameNode.type === 'identifier' && isValidIdentifier(nameNode.text)) {
        const valueNode = declarators[0].childForFieldName('value');
        // 值摘要（≤60 字符，单行化）：wrap(async (a) => {...}) → “wrap(async (a) => {…”
        const rawValue = (valueNode?.text ?? '').replace(/\s+/g, ' ');
        const valueBrief = rawValue.length > 60 ? rawValue.slice(0, 57) + '…' : rawValue;
        symbols.push({
          name: nameNode.text,
          kind: 'const',
          start_line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1,
          qualified_name: nameNode.text,
          signature: `const ${nameNode.text} = ${valueBrief}`,
          parent: undefined,
        });
      }
    }
    return;
  }

  if (lang.symbol_nodes.includes(node.type)) {
    const name = extractName(node, lang.field_map);
    if (name) {
      const kind = nodeTypeToKind(node.type, parent);
      const signature = buildSignature(node, lang.field_map, lang);
      // Go 方法：receiver 类型即“所属类型”。只填 parent（供社区按类型聚合），
      // 不改 qualified_name（保留 "Method" 短名，避免破坏既有调用边解析契约）。
      let symbolParent = parent;
      if (lang.name === 'go' && !symbolParent) {
        const receiver = fieldText(node, lang.field_map.receiver || '');
        const receiverMatch = stripParens(receiver).match(/(?:\*\s*)?(\w+)$/);
        if (receiverMatch) symbolParent = receiverMatch[1];
      }
      const qn = parent ? `${parent}.${name}` : name;
      symbols.push({
        name,
        kind,
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        qualified_name: qn,
        signature,
        parent: symbolParent,
      });

      // 进入 body 继续提取（找方法/嵌套类）
      const body = node.childForFieldName('body') || node.childForFieldName('suite');
      if (body) {
        for (let i = 0; i < body.childCount; i++) {
          const child = body.child(i);
          if (child) traverseAndExtract(child, lang, symbols, qn, depth + 1);
        }
        return;
      }
      // 兜底：直接遍历子节点（如 Python class 的 body 可能不是标准 body 字段）
      if (node.type === 'class_definition' || node.type === 'class_declaration') {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) traverseAndExtract(child, lang, symbols, qn, depth + 1);
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

/** 语言适配器注册表：深适配语言 = 一条记录（callNode + import/binding 提取 + 顶层调用）。加语言 = 加一行，kernel 消费查此 map。 */
interface LangImportAdapter {
  callNode?: string | string[];
  topLevelCall?: boolean;
  extractImportSources?: (node: SyntaxNodeLike) => string[];
  extractImportBindings?: (node: SyntaxNodeLike, paths: string[]) => string[];
}
export const LANG_ADAPTERS: Record<string, LangImportAdapter> = {
  go: {
    callNode: 'call_expression',
    extractImportSources(node) {
      const p = fieldText(node, 'path');
      return p ? [stripQuotes(p)] : [];
    },
    extractImportBindings(node, paths) {
      const m = node.text.match(/^\s*([A-Za-z_][\w.]*)\s*(?:"[^"]*"|`[^`]*`)/);
      if (m) return [m[1]];
      const base = paths[0]?.split('/').pop();
      return base ? [base] : [];
    },
  },
  python: {
    callNode: 'call',
    topLevelCall: true,
    extractImportSources(node) {
      if (node.type === 'import_statement') {
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
        const m = node.text.match(/^\s*from\s+(\.*)([\w.]*)\s+import/);
        if (!m) return [];
        const dots = m[1] || '';
        const mod = m[2] || '';
        if (dots) return [dots + mod];
        return mod ? [mod] : [];
      }
      return [];
    },
    extractImportBindings(node) {
      if (node.type === 'import_from_statement') {
        const m = node.text.match(/^from\s+[\w.]*\s+import\s+(.+)$/);
        if (!m) return [];
        return m[1].split(',').map((s) => s.trim()).map((s) => (s.match(/as\s+([A-Za-z_]\w*)/i) || [])[1] || s.replace(/[()]/g, '')).filter((s) => s && !s.startsWith('('));
      }
      if (node.type === 'import_statement') {
        const out: string[] = [];
        const walk = (n: SyntaxNodeLike): void => {
          for (let i = 0; i < n.childCount; i++) {
            const c = n.child(i);
            if (!c) continue;
            if (c.type === 'dotted_name') out.push(c.text.split('.').pop() || c.text);
            else if (c.type === 'aliased_import') {
              const as = c.text.match(/as\s+([A-Za-z_]\w*)/i);
              out.push(as ? as[1] : (c.text.split('.').pop() || c.text));
            } else walk(c);
          }
        };
        walk(node);
        return out;
      }
      return [];
    },
  },
  java: {
    callNode: 'method_invocation',
    extractImportSources(node) {
      const m = node.text.replace(/^\s*import\s+static\s+/, 'import ').match(/^\s*import\s+([\w.]+)(?:\.\*)?\s*;/);
      return m ? [m[1]] : [];
    },
    extractImportBindings(node) {
      const m = node.text.replace(/^\s*import\s+static\s+/, 'import ').match(/^\s*import\s+([\w.]+)(?:\.\*)?\s*;/);
      if (!m) return [];
      const segs = m[1].split('.');
      return segs.length > 0 ? [segs[segs.length - 1]] : [];
    },
  },
  rust: {
    callNode: 'call_expression',
    extractImportSources(node) {
      const t = node.text.replace(/^\s*use\s+/, '').replace(/;?\s*$/, '').trim();
      const brace = t.indexOf('{');
      const head = (brace >= 0 ? t.slice(0, brace) : t).trim().replace(/::$/, '');
      const src = head.replace(/^crate::/, '').replace(/^::/, '').replace(/^super::/, '');
      return src ? [src] : [];
    },
    extractImportBindings(node) {
      const t = node.text.replace(/^\s*use\s+/, '').replace(/;?\s*$/, '').trim();
      const brace = t.indexOf('{');
      if (brace >= 0) {
        const inner = t.slice(brace + 1, t.lastIndexOf('}'));
        return inner.split(',').map((s) => s.trim()).filter(Boolean).map((s) => (s.match(/as\s+([A-Za-z_]\w*)/) || [])[1] || s.split('::').pop() || s);
      }
      const asM = t.match(/as\s+([A-Za-z_]\w*)/);
      if (asM) return [asM[1]];
      const last = t.split('::').pop();
      return last && !last.includes('{') ? [last.trim()] : [];
    },
  },
  c_sharp: {
    callNode: 'invocation_expression',
    // `using System;` / `using static System.Math;` / `using Alias = System.Console;`
    // source = 命名空间全名（别名形式取 RHS，静态 using 去 static）
    extractImportSources(node) {
      let t = node.text.replace(/^\s*using\s+/, '').replace(/;\s*$/, '').trim();
      t = t.replace(/^static\s+/, '');
      const eq = t.indexOf('=');
      if (eq >= 0) t = t.slice(eq + 1).trim(); // using Alias = X; → X
      return t ? [t] : [];
    },
    // binding = 命名空间末段（当前命名空间内可直接引用该段而非全限定名）
    extractImportBindings(node) {
      let t = node.text.replace(/^\s*using\s+/, '').replace(/;\s*$/, '').trim();
      t = t.replace(/^static\s+/, '');
      const eq = t.indexOf('=');
      if (eq >= 0) t = t.slice(eq + 1).trim(); // using Alias = X; → 绑定 Alias
      else t = t.split('.').pop() || t; // using System.X → X
      return t ? [t.replace(/[\s]/g, '')] : [];
    },
  },
  php: {
    // PHP 调用形式多样：自由函数 foo()=function_call_expression；静态 Class::m()=scoped_call_expression；实例 $o->m()=member_call_expression
    callNode: ['function_call_expression', 'scoped_call_expression', 'member_call_expression'],
    // `use Foo\Bar<;>` / `use Foo\Bar as Baz;` / `use Foo\{Bar, Baz};` / `use function Foo\bar;`
    extractImportSources(node) {
      let t = node.text.replace(/^\s*use\s+/, '').replace(/;\s*$/, '').trim();
      t = t.replace(/^function\s+/, '').replace(/^const\s+/, '');
      const brace = t.indexOf('{');
      if (brace >= 0) {
        const head = t.slice(0, brace).trim().replace(/\\$/, '');
        return head ? [head] : []; // 分组形式：主命名空间作为 source（成员 binding 已各自提取）
      }
      // 单条：Foo\Bar [/as Baz]
      const base = t.split(/\s+as\s+|\s+/, 1)[0] || t;
      return base ? [base] : [];
    },
    // binding：`use Foo\Bar as Baz → Baz`；否则末段 `Bar`；分组形式取每个成员末段
    extractImportBindings(node) {
      let t = node.text.replace(/^\s*use\s+/, '').replace(/;\s*$/, '').trim();
      t = t.replace(/^function\s+/, '').replace(/^const\s+/, '');
      const brace = t.indexOf('{');
      if (brace >= 0) {
        const inner = t.slice(brace + 1, t.lastIndexOf('}'));
        return inner.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
          const asM = s.match(/as\s+([A-Za-z_\x80-\xff]\w*)/);
          if (asM) return [asM[1]];
          const seg = s.trim().split('\\').pop()?.trim() || '';
          return seg ? [seg] : [];
        }).flat();
      }
      const asM = t.match(/\s+as\s+([A-Za-z_\x80-\xff]\w*)\s*$/);
      if (asM) return [asM[1]];
      const last = t.split('\\').pop()?.trim();
      return last ? [last] : [];
    },
  },
  typescript: { callNode: 'call_expression' },
  tsx: { callNode: 'call_expression' },
  javascript: { callNode: 'call_expression' },
  jsx: { callNode: 'call_expression' },
};

/** 取某语言 import 的 source 列表（深适配查注册表，否则 TS/flutter 通用） */
function extractImportSources(node: SyntaxNodeLike, langName: string): string[] {
  const a = LANG_ADAPTERS[langName];
  if (a?.extractImportSources) return a.extractImportSources(node);
  if (langName === 'typescript' || langName === 'tsx' || langName === 'javascript' || langName === 'jsx') {
    const s = fieldText(node, 'source');
    return s ? [stripQuotes(s)] : [];
  }
  return [];
}

/** 取某语言 import 的本地绑定名（深适配查注册表；无则空） */
function extractImportBindings(node: SyntaxNodeLike, langName: string, paths: string[]): string[] {
  const a = LANG_ADAPTERS[langName];
  return a?.extractImportBindings ? a.extractImportBindings(node, paths) : [];
}

function isCallNode(node: SyntaxNodeLike, lang: LanguageEntry): boolean {
  return LANG_ADAPTERS[lang.name]?.callNode === node.type || (Array.isArray(LANG_ADAPTERS[lang.name]?.callNode) && (LANG_ADAPTERS[lang.name]!.callNode as string[]).includes(node.type));
}

/** 从 call 节点提取被调用名：取 function 字段文本的尾部标识符（去点、去泛型参数） */
function extractCallee(callNode: SyntaxNodeLike, langName: string): { name: string; expr: string } | null {
  // TS/Go/C/Rust 用 function 字段；Java method_invocation 用 name(+object) 字段
  const fn = callNode.childForFieldName('function') || callNode.childForFieldName('name');
  if (!fn) return null;
  // Java 中对象与方法名分离（object='Bar'、name='run'）→ 拼回 qualified 前缀供 is-target 用
  const obj = langName === 'java' ? callNode.childForFieldName('object') : null;
  const expr = obj && obj.text ? `${obj.text}.${fn.text}` : fn.text;
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
    if (!child) continue;
    // 模块顶层调用（Python 等）：无包裹函数，调用归属 <module>；只在不进函数体内时提取（函数内由 extractCallsFromBody 处理）
    if (LANG_ADAPTERS[lang.name]?.topLevelCall && funcStack.length === 0 && isCallNode(child, lang)) {
      const c = extractCallee(child, lang.name);
      if (c) {
        const sym = symbols.find((s) => s.name === c.name);
        calls.push({ caller: '<module>', callee: c.name, callee_expr: c.expr, line: child.startPosition.row + 1, resolved: !!sym, callee_qn: sym ? sym.qualified_name : undefined });
      }
    }
    if (child) traverseAndExtractCalls(child, lang, symbols, calls, funcStack, depth + 1);
  }
}

// ─────────────────────────────────────────────────────────────
// 类型引用提取（TS 系 v1：type_identifier 节点 = 类型位置标识符）
// ─────────────────────────────────────────────────────────────

const TYPE_KINDS = new Set(['interface', 'type', 'class']);

/**
 * 遍历 AST 提取类型引用：TS 语法里类型位置的标识符是 type_identifier 节点
 * （参数注解 `: Foo`、泛型 `Array<Foo>`、`implements Bar`、`extends Baz`）。
 * 归属 = 包含它的最近符号（函数/方法/类）；定义处自身名字跳过（同行同名判定，
 * tree-sitter 绑定的节点对象身份不稳定，不能靠引用相等）。
 * Go/Python 的类型引用 AST 结构不同（qualified_type/identifier 混用），v1 不提取（返回空）。
 */
function traverseAndExtractTypeRefs(
  node: SyntaxNodeLike,
  lang: LanguageEntry,
  symbols: ParsedSymbol[],
  typeRefs: ParsedTypeRef[],
  stack: Array<{ qn: string; defName: string; defRow: number }> = [],
  depth: number = 0,
): void {
  if (depth > 200) return;
  if (lang.symbol_nodes.includes(node.type)) {
    const name = extractName(node, lang.field_map);
    if (name) {
      const parent = stack.length > 0 ? stack[stack.length - 1].qn : undefined;
      const qn = parent ? `${parent}.${name}` : name;
      stack.push({ qn, defName: name, defRow: node.startPosition.row });
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) traverseAndExtractTypeRefs(child, lang, symbols, typeRefs, stack, depth + 1);
      }
      stack.pop();
      return;
    }
  }
  if (node.type === 'type_identifier' && stack.length > 0) {
    const top = stack[stack.length - 1];
    const text = node.text;
    const row = node.startPosition.row;
    // 跳过定义处：栈顶符号定义行上的同名标识符（如 `interface Foo {` 的 Foo）
    const isDefName = text === top.defName && row === top.defRow;
    if (!isDefName && isValidIdentifier(text)) {
      const sym = symbols.find((s) => s.name === text && TYPE_KINDS.has(s.kind));
      typeRefs.push({
        referrer: top.qn,
        type_name: text,
        line: row + 1,
        resolved: !!sym,
        target_qn: sym ? sym.qualified_name : undefined,
      });
    }
    return; // type_identifier 是叶子
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) traverseAndExtractTypeRefs(child, lang, symbols, typeRefs, stack, depth + 1);
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

function traverseAndExtractImports(
  node: SyntaxNodeLike,
  lang: LanguageEntry,
  imports: ParsedImport[],
  depth: number = 0
): void {
  if (depth > 100 || !lang.import_nodes || lang.import_nodes.length === 0) return;
  if (lang.import_nodes.includes(node.type)) {
    const sources = extractImportSources(node, lang.name);
    // TS 系 `import type` 整条语句运行时擦除——标记 type_only，依赖图/闭包不算边
    const isTs = lang.name === 'typescript' || lang.name === 'tsx' || lang.name === 'javascript' || lang.name === 'jsx';
    const typeOnly = isTs && /^\s*import\s+type\b/.test(node.text);
    const bindings = extractImportBindings(node, lang.name, sources);
    for (const src of sources) {
      imports.push({
        source: src,
        kind: src.startsWith('.') ? 'relative' : 'package',
        line: node.startPosition.row + 1,
        ...(typeOnly ? { type_only: true } : {}),
        ...(bindings.length > 0 ? { bindings } : {}),
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

/** 统一 parse 入口：小文件走快速 string 路径，大文件走 callback 路径。
 *  导出供 ts_slim 等工具复用——剪刀直接 parser.parse(string) 会踩
 *  node-tree-sitter 的 2^15 字符上限（EINVAL，directory.ts 37K 实证）。 */
export function parseContent(parser: ParserLike, content: string): TreeLike {
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

/** 单文件完整解析结果（一次 parse，符号 + import + 调用边 + 类型引用四产出） */
export interface ParsedFile {
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  /** 函数级调用边（同文件解析；跨文件/外部为 resolved=false，见 ParsedCall） */
  calls: ParsedCall[];
  /** 类型引用边（同文件解析，TS 系 v1；跨文件引用 resolved=false） */
  type_refs: ParsedTypeRef[];
  /** 解析失败原因（语言包加载失败 / parse 抛错）；成功时缺省。
   *  调用方借此区分"文件本为空"与"解析静默失败"（后者会丢依赖边）。 */
  error?: string;
}

/**
 * 解析文件的符号与 import 依赖（单次 AST parse）。
 * 返回空数组字段表示：文件类型不支持 / 解析失败 / 无对应内容。
 */
export async function parseFileFull(filePath: string, content: string): Promise<ParsedFile> {
  const empty: ParsedFile = { symbols: [], imports: [], calls: [], type_refs: [] };
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
    const typeRefs: ParsedTypeRef[] = [];
    traverseAndExtract(tree.rootNode, lang, symbols, undefined);
    traverseAndExtractImports(tree.rootNode, lang, imports);
    traverseAndExtractCalls(tree.rootNode, lang, symbols, calls);
    traverseAndExtractTypeRefs(tree.rootNode, lang, symbols, typeRefs);
    return { symbols, imports, calls, type_refs: typeRefs };
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
