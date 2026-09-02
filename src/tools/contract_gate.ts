/**
 * contract_gate —— 契约对账闸门（重构吸后预拦 "符号失配"）
 *
 * 背景（一次重构事故归纳）："v2 提级重构"把 vault_test.go 里正确的
 * `v2.Get`（v2 = 测试局部变量）机械替换成 `agent.Get`（vault 包内不存在的符号）。
 * 该错误只藏在 *_test.go → `go build` 不编测试 → 默认构建放行 → 静默掉线。
 *
 * 本模块在"编译/测试"之外补一道**契约层闸门**：重构落盘后，扫描被改动文件，
 * 判定每个 `X.` 形式的"包/接收者引用"的裸标识符是否有定义来源
 * （本文件声明 ∪ import 别名 ∪ 本文件局部变量 ∪ TS 全局白名单）。
 * 未定义 → 记为契约失配（danger）。vault 场景 `agent` 没有任何声明来源 → 命中。
 *
 * 定位：轻量"飞刀"，只查"`.` 左侧裸标识符"这一类跨引用失配（改名/提级/move
 * 最常打断它），**不是** tsc/vet 那样完整的类型检查——它负责"改写吸后立刻给出
 * 结构化 diff 清单"，把失配显式标出来，再由 go test / tsc 权威兜底。
 *
 * 设计纪律（低误报优先）：
 *   - 只检查 `X.` 形式的接收者/包引用，不检查自由变量 → 避免作用域误报。
 *   - 定义来源采用"宁可多收不漏收"并集：声明 ∪ 别名 ∪ 局部名 ∪ 全局白名单，
 *     让 `agent` 这类"全仓从未声明"的名字突出，而普通局部变量不误报。
 *   - 声明/局部名使用文件级并集（非精确作用域）——牺牲一丝精度换取近零误报，
 *     对 vault 完美命中，且不会把闭包捕获误判。
 *   - 每种语言各接一个"定义来源"适配器，快照/diff/报告编排全复用。
 */

import fs from 'node:fs';
import path from 'node:path';

export type Lang = 'go' | 'ts' | 'py' | 'java' | 'cs' | 'c';

export interface UndefinedRef {
  /** 相对 cwd 的路径（POSIX 分隔符） */
  file: string;
  line: number;
  ident: string;
  /** 直观拼写：file:line ident */
  hint: string;
}

export interface FileScan {
  file: string;
  lang: Lang;
  undefinedRefs: UndefinedRef[];
}

export interface ContractSnapshot {
  at: string;
  files: FileScan[];
  /** 聚合去重后全部失配（便于一眼看） */
  undefinedRefs: UndefinedRef[];
}

export interface ContractDiff {
  before: ContractSnapshot;
  after: ContractSnapshot;
  /** 重构吸后**新增**的失配（before 没有的）——正是重构 break 出来的 */
  newIssues: UndefinedRef[];
}

export interface ScanContractsOptions {
  /** 项目根；返回的相对路径以它为基准 */
  cwd: string;
  /** 显式文件列表（优先于 dirs/自动扫描） */
  files?: string[];
  /** 递归扫描的目录（默认 cwd 本身）；会排除 node_modules/.git/vendor/dist/web/dist 等 */
  dirs?: string[];
  /** 强制语言；缺省按扩展名自动判定 */
  lang?: Lang | 'auto';
}

// ── 常量 ─────────────────────────────────────────────

const SRC_EXT = ['.go', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.cs', '.c', '.h'];

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', '.output', '.next', '.cache']);

/** `.` 左侧绝不可能代表"包/接收者引用"的标识符（保留字 / 关键字） */
const SKIP_LHS = new Set([
  'if', 'for', 'func', 'go', 'defer', 'range', 'return', 'switch', 'select',
  'type', 'package', 'import', 'var', 'const', 'else', 'break', 'continue',
  'fallthrough', 'default', 'case', 'chan', 'struct', 'interface', 'map',
  'append', 'int', 'int64', 'uint', 'string', 'bool', 'byte', 'rune',
  'float64', 'error', 'len', 'cap', 'new', 'make', 'delete', 'copy', 'close',
  'panic', 'recover', 'complex', 'real', 'imag', 'nil', 'true', 'false',
]);

/** TS 全局对象白名单——避免把 Math/document/process 等误判成未定义 */
const TS_GLOBALS = new Set([
  'window', 'document', 'history', 'location', 'navigator', 'localStorage', 'sessionStorage',
  'Math', 'JSON', 'console', 'process', 'Buffer', 'URL', 'URLSearchParams', 'fetch',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Intl', 'Reflect', 'Proxy',
  'Promise', 'Symbol', 'Object', 'Array', 'String', 'Number', 'Boolean', 'RegExp', 'Date',
  'Error', 'Map', 'Set', 'WeakMap', 'WeakSet', 'BigInt', 'performance', 'crypto', 'module',
  'exports', 'require', '__dirname', '__filename', 'globalThis', 'global', 'self', 'location',
]);

const GO_RESERVED = new Set([
  'if', 'for', 'func', 'go', 'defer', 'range', 'return', 'switch', 'select', 'type',
  'package', 'import', 'var', 'const', 'else', 'break', 'continue', 'fallthrough',
  'default', 'case', 'chan', 'struct', 'interface', 'map', 'nil', 'true', 'false',
]);

/** Python 关键字（`. 左侧不可能代表"对象引用"） */
const PY_RESERVED = new Set([
  'if', 'elif', 'else', 'for', 'while', 'def', 'class', 'return', 'import', 'from',
  'as', 'in', 'is', 'not', 'and', 'or', 'pass', 'break', 'continue', 'with', 'try',
  'except', 'finally', 'raise', 'yield', 'lambda', 'del', 'global', 'nonlocal',
  'assert', 'async', 'await', 'None', 'True', 'False',
]);

/** Python 常用内建（避免把 str./list./Exception 等误判成未定义对象） */
const PY_GLOBALS = new Set([
  'str', 'int', 'float', 'bool', 'list', 'dict', 'set', 'tuple', 'frozenset',
  'object', 'type', 'bytes', 'bytearray', 'complex', 'Exception', 'ValueError',
  'TypeError', 'KeyError', 'AttributeError', 'RuntimeError', 'IndexError', 'NameError',
  'print', 'len', 'range', 'enumerate', 'zip', 'map', 'filter', 'sorted', 'reversed',
  'sum', 'min', 'max', 'abs', 'round', 'pow', 'divmod', 'all', 'any', 'next', 'iter',
  'repr', 'format', 'hash', 'id', 'input', 'open', 'super', 'self', 'cls', 'isinstance',
  'issubclass', 'callable', 'hasattr', 'getattr', 'setattr', 'delattr', 'vars', 'dir',
]);

/** Java 关键字（`. 左侧不可能代表"接收者/包引用"） */
const JAVA_RESERVED = new Set([
  'if', 'for', 'while', 'switch', 'return', 'new', 'class', 'interface', 'enum',
  'extends', 'implements', 'import', 'package', 'public', 'private', 'protected',
  'static', 'final', 'abstract', 'synchronized', 'native', 'throws', 'throw',
  'try', 'catch', 'finally', 'void', 'int', 'long', 'double', 'float', 'boolean',
  'char', 'byte', 'short', 'true', 'false', 'null', 'this', 'super', 'instanceof',
]);

/** C# 关键字 */
const CS_RESERVED = new Set([
  'if', 'for', 'while', 'switch', 'return', 'new', 'class', 'interface', 'struct',
  'enum', 'namespace', 'using', 'public', 'private', 'protected', 'internal',
  'static', 'readonly', 'const', 'abstract', 'virtual', 'override', 'async',
  'await', 'void', 'int', 'long', 'double', 'float', 'bool', 'char', 'byte',
  'short', 'true', 'false', 'null', 'this', 'base', 'is', 'as', 'typeof', 'throw',
  'try', 'catch', 'finally', 'var', 'string', 'object', 'out', 'ref', 'in',
]);

/** C 关键字（`. 左侧是 struct 变量/typedef 名，关键字绝不可能） */
const C_RESERVED = new Set([
  'if', 'for', 'while', 'switch', 'return', 'break', 'continue', 'case', 'default',
  'struct', 'union', 'enum', 'typedef', 'sizeof', 'void', 'int', 'long', 'short',
  'char', 'float', 'double', 'unsigned', 'signed', 'const', 'volatile', 'static',
  'extern', 'register', 'do', 'else', 'goto', 'auto', 'NULL', 'true', 'false',
]);

// ── 语言判定 ─────────────────────────────────────────

function langOfFile(rel: string): Lang | null {
  if (rel.endsWith('.go')) return 'go';
  // JS 家族：语法是 TS 子集，走同一套 ts 分支（collectSymbols/collectReferences 的 TS 逻辑对纯 JS 兼容）
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(rel)) return 'ts';
  if (/\.(py)$/.test(rel)) return 'py';
  if (/\.(java)$/.test(rel)) return 'java';
  if (/\.(cs)$/.test(rel)) return 'cs';
  if (/\.(c|h)$/.test(rel)) return 'c';
  return null;
}

// ── 文件枚举 ─────────────────────────────────────────

function walkFiles(root: string, dirs: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const dirQueue = [...dirs];
  while (dirQueue.length) {
    const dir = dirQueue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const en of entries) {
      const abs = path.join(dir, en.name);
      if (en.isDirectory()) {
        if (EXCLUDE_DIRS.has(en.name)) continue;
        dirQueue.push(abs);
      } else if (en.isFile() && SRC_EXT.some((e) => en.name.endsWith(e))) {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (!seen.has(rel)) {
          seen.add(rel);
          out.push(abs);
        }
      }
    }
  }
  return out;
}

// ── 源码正文清洗（去注释/字符串，降低误报） ─────────────

type Cleaned = { text: string; lineOf: number[] };

/**
 * 去注释 + 去字符串，返回清洗后文本和"物理行号 → 清洗后行号"映射。
 * 规则：// 到行尾、/* *\/ 块注释（跨行折叠成空格）、"…"、'…'、`…`（Go raw / JS template）。
 */
function cleanSource(src: string, lang: Lang): Cleaned {
  const lines = src.split('\n');
  const out: string[] = [];
  const lineOf: number[] = [];
  const inBlock = { v: false };
  for (let i = 0; i < lines.length; i++) {
    const cleaned = cleanLine(lines[i], lang, inBlock);
    out.push(cleaned);
    lineOf.push(i + 1); // 物理行号
  }
  return { text: out.join('\n'), lineOf };
}

function cleanLine(raw: string, lang: Lang, inBlock: { v: boolean }): string {
  let s = raw;
  const parts: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (!inBlock.v) {
      const bc = s.indexOf('/*', i);
      const lc = s.indexOf('//', i);
      let stop = s.length;
      if (bc !== -1) stop = Math.min(stop, bc);
      if (lc !== -1) stop = Math.min(stop, lc);
      parts.push(stripStrings(s.slice(i, stop), lang));
      if (lc !== -1 && lc <= (bc === -1 ? Infinity : bc)) {
        break; // 行注释：丢弃到行尾
      }
      if (bc !== -1) {
        inBlock.v = true;
        i = bc + 2;
        continue;
      }
      i = stop;
    } else {
      const end = s.indexOf('*/', i);
      if (end === -1) {
        i = s.length; // 块注释延续到本行结束
      } else {
        inBlock.v = false;
        i = end + 2;
      }
    }
  }
  return parts.join('');
}

function stripStrings(s: string, lang: Lang): string {
  // 去单双引号与（TS）模板串；Go 另有反引号 raw string
  const out: string[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < n && s[j] !== q) {
        if (s[j] === '\\') j++;
        j++;
      }
      i = Math.min(j + 1, n);
      out.push(' ');
    } else if (c === '`') {
      let j = i + 1;
      while (j < n && s[j] !== '`') j++;
      i = Math.min(j + 1, n);
      out.push(' ');
    } else {
      out.push(c);
      i++;
    }
  }
  return out.join('');
}

// ── 单一文件符号分析 ─────────────────────────────

function langSkipSet(lang: Lang): Set<string> {
  if (lang === 'go') return GO_RESERVED;
  if (lang === 'py') return PY_RESERVED;
  if (lang === 'java') return JAVA_RESERVED;
  if (lang === 'cs') return CS_RESERVED;
  if (lang === 'c') return C_RESERVED;
  return SKIP_LHS;
}

interface FileSymbols {
  declared: Set<string>;
  aliases: Set<string>;
  locals: Set<string>;
}

function collectSymbols(text: string, lang: Lang): FileSymbols {
  const declared = new Set<string>();
  const aliases = new Set<string>();
  const locals = new Set<string>();

  const addDeclared = (m: RegExpMatchArray | null, idx = 1) => {
    if (m && m[idx]) {
      for (const g of m.slice(idx)) if (g) declared.add(g);
    }
  };

  if (lang === 'go') {
    // 顶层声明（func 支持方法接收者：func (v *Vault) Get( → 名字 Get）
    for (const m of text.matchAll(/^\s*(?:type|var|const)\s+([A-Za-z_]\w*)/gm)) declared.add(m[1]);
    for (const m of text.matchAll(/^\s*func\s+(?:\(\s*\w+\s*[*\w./]+\)\s+)?([A-Za-z_]\w*)/gm)) declared.add(m[1]);
    // import 单行/+块：显式别名 或 裸路径取末段
    for (const m of text.matchAll(/(?<=^|[;\n(])\s*([A-Za-z_]\w*)\s+"[^"]+"/gm)) aliases.add(m[1]);
    for (const m of text.matchAll(/"([^"/ \t]+)"/g)) {
      if (m[1] && /^[a-zA-Z_]/.test(m[1])) aliases.add(m[1]);
    }
    // 局部名：:= 左值、var 名、函数参数名（括号内第一个标识符/接收者）
    for (const m of text.matchAll(/([A-Za-z_]\w*)\s*:=/gm)) locals.add(m[1]);
    for (const m of text.matchAll(/\bvar\s+([A-Za-z_]\w*)/gm)) locals.add(m[1]);
    for (const m of text.matchAll(/^\s*(?:func)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/gm)) {
      const inner = m[2] ?? '';
      for (const pm of inner.matchAll(/([A-Za-z_]\w*)\s*[*\w./]*(?:,|\)|$)/g)) {
        if (pm[1] && !GO_RESERVED.has(pm[1])) locals.add(pm[1]);
      }
    }
  } else if (lang === 'py') {
    // 顶层声明：def / class / 模块级常量（^NAME = ，大写约定）
    for (const m of text.matchAll(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm)) declared.add(m[1]);
    for (const m of text.matchAll(/^\s*class\s+([A-Za-z_]\w*)/gm)) declared.add(m[1]);
    for (const m of text.matchAll(/^([A-Z][A-Z0-9_]*)\s*=/gm)) declared.add(m[1]);
    // import a.b[ as c] / from x import a[ as b]（别名取 as 右值或末段）
    for (const m of text.matchAll(/^\s*import\s+([\w.]+)(?:\s+as\s+([A-Za-z_]\w*))?/gm)) {
      aliases.add((m[2] || m[1].split('.').pop() || '').trim());
    }
    for (const m of text.matchAll(/^\s*from\s+[\w.]+\s+import\s+(?:\(([^)]*)\)|(.+))/gm)) {
      for (const nm of (m[1] || m[2] || '').split(',').map((s) => s.trim())) {
        if (!nm) continue;
        const asM = nm.match(/^([A-Za-z_]\w*)\s+as\s+([A-Za-z_]\w*)/);
        aliases.add(asM ? asM[2] : nm.replace(/[*()]/g, ''));
      }
    }
    // 局部名（文件级并集，"宁可多收不漏收"）：self/cls、赋值左值、for 变量、def 形参
    locals.add('self');
    locals.add('cls');
    for (const m of text.matchAll(/([A-Za-z_]\w*)\s*=/gm)) locals.add(m[1]);
    for (const m of text.matchAll(/\bfor\s+([A-Za-z_]\w*)/gm)) locals.add(m[1]);
    for (const m of text.matchAll(/\bwith\s+[^:]*?\bas\s+([A-Za-z_]\w*)/gm)) locals.add(m[1]);
    for (const m of text.matchAll(/^\s*(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(([^)]*)\)/gm)) {
      for (const pm of (m[1] || '').split(',')) {
        const pn = pm.trim().split(':')[0].split('=')[0].trim();
        if (/^[A-Za-z_]\w*$/.test(pn)) locals.add(pn);
      }
    }
  } else if (lang === 'java') {
    // Java 顶层类型 + 顶层方法；import 末段 = 别名；方法形参 = 局部
    for (const m of text.matchAll(/^\s*(?:public|protected|private|abstract|final|static|sealed|non-sealed|strictfp|synchronized|native|transient|volatile|default|\s)*\s*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/gm)) declared.add(m[1]);
    for (const m of text.matchAll(/^\s*import\s+static\s+([\w.]+(?:\.\*)?)\s*;/gm)) {
      const last = m[1].replace(/\.\*$/, '').split('.').pop() ?? '';
      if (last) aliases.add(last);
    }
    for (const m of text.matchAll(/^\s*import\s+([\w.]+(?:\.\*)?)\s*;/gm)) {
      const last = m[1].replace(/\.\*$/, '').split('.').pop() ?? '';
      if (last && /^[A-Za-z_]/.test(last)) aliases.add(last);
    }
    for (const m of text.matchAll(/^\s*(?:public|protected|private|static|final|synchronized|native|abstract|default|\s)*\s*[\w<>,.\[\] ]+\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:throws[^;]*)?\{/gm)) {
      locals.add(m[1]); // 方法名不入 locals 也无妨（declare 语义）
      for (const pm of (m[2] || '').split(',')) {
        const pn = pm.trim().split(/\s+/).pop()?.split('[')[0] ?? '';
        if (/^[A-Za-z_]\w*$/.test(pn)) locals.add(pn);
      }
    }
    // Java 局部变量声明：Foo f = ... / Foo f; → f 入 locals
    for (const m of text.matchAll(/^\s*[\w<>,.\[\] ]+\s+([A-Za-z_]\w*)\s*(?:=|\s*;)/gm)) {
      if (/^[A-Za-z_]\w*$/.test(m[1])) locals.add(m[1]);
    }
  } else if (lang === 'cs') {
    // C# 顶层类型；using 末段/别名；方法形参
    for (const m of text.matchAll(/^\s*(?:public|internal|private|protected|abstract|sealed|static|partial|readonly|record|\s)*\s*(?:class|interface|struct|enum|record)\s+([A-Za-z_]\w*)/gm)) declared.add(m[1]);
    for (const m of text.matchAll(/^\s*using\s+static\s+([\w.]+)\s*;/gm)) {
      const last = m[1].split('.').pop() ?? '';
      if (last) aliases.add(last);
    }
    for (const m of text.matchAll(/^\s*using\s+([\w.]+)\s*(?:=\s*([\w.]+))?\s*;/gm)) {
      const bind = m[2] || (m[1].split('.').pop() ?? '');
      if (bind && /^[A-Za-z_]/.test(bind)) aliases.add(bind);
    }
    for (const m of text.matchAll(/^\s*(?:public|internal|private|protected|static|async|virtual|override|abstract|sealed|partial|readonly|extern|unsafe|\s)*\s*[\w<>,.\[\]? ]+\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:=>|where|\{)/gm)) {
      for (const pm of (m[2] || '').split(',')) {
        let pn = pm.trim();
        pn = pn.split('=')[0].trim(); // 默认值
        pn = pn.replace(/^(out|ref|in|params|this|scoped)\s+/, '').trim();
        const p = pn.split(/\s+/).pop()?.split('[')[0] ?? '';
        if (/^[A-Za-z_]\w*$/.test(p)) locals.add(p);
      }
    }
    locals.add('this');
    locals.add('base');
  } else if (lang === 'c') {
    // C 全局函数/结构/typedef + 全局变量；形参 = 局部
    for (const m of text.matchAll(/^\s*(?:extern|static|inline)\s+[^;{}]+?\b([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:;|\{)/gm)) declared.add(m[1]);
    for (const m of text.matchAll(/^\s*(?:typedef\s+)?struct\s+([A-Za-z_]\w*)/gm)) declared.add(m[1]);
    for (const m of text.matchAll(/^\s*typedef\s+[^;{}]+?\b([A-Za-z_]\w*)\s*;/gm)) declared.add(m[1]);
    for (const m of text.matchAll(/^\s*(?:extern|static|const|volatile|unsigned|signed|register)\s+[\w\s*]+?\b([A-Za-z_]\w*)\s*(?:=|;)/gm)) declared.add(m[1]);
    for (const m of text.matchAll(/\b(?:[A-Za-z_]\w*\s*\*?\s+)?([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{/gm)) {
      for (const pm of (m[2] || '').split(',')) {
        const p = pm.trim().split(/\s+/).pop()?.replace(/^\*+/, '') ?? '';
        if (/^[A-Za-z_]\w*$/.test(p)) locals.add(p);
      }
    }
  } else {
    // TS 顶层声明
    for (const m of text.matchAll(/^\s*(?:export\s+default\s+|export\s+|default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)) {
      declared.add(m[1]);
    }
    // import {a, b as c} from / import x from / import * as x from
    for (const m of text.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g)) aliases.add(m[1]);
    for (const m of text.matchAll(/(?:import)\s+([A-Za-z_$][\w$]*)\s+from/g)) aliases.add(m[1]);
    for (const m of text.matchAll(/(?:import)\s*(?:type\s*)?\{([^}]*)\}\s*from/g)) {
      for (const nm of (m[1] || '').split(',')) {
        const clean = nm.trim();
        if (!clean) continue;
        const asM = clean.match(/(?:([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*))|(?:([A-Za-z_$][\w$]*))/);
        if (asM) aliases.add((asM[2] || asM[1] || asM[3] || '').trim());
      }
    }
    // 局部名：const/let/var
    for (const m of text.matchAll(/\b(?:const|let|var)\s+([{A-Za-z_$][\w$]*)/gm)) {
      const nm = m[1].replace(/^\s*\{/, '');
      if (/^[A-Za-z_$]/.test(nm)) locals.add(nm);
    }
  }

  return { declared, aliases, locals };
}

function collectReferences(text: string, lang: Lang): Array<{ line: number; ident: string }> {
  const skip = langSkipSet(lang);
  const out: Array<{ line: number; ident: string }> = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Java/C# 的 import/package/using 行（如 com.acme.Foo）不是"使用点"——整行跳过
    if (lang === 'java' && /^\s*(import|package)\s/.test(line)) continue;
    if (lang === 'cs' && /^\s*(using|namespace)\s/.test(line)) continue;
    for (const m of line.matchAll(/([A-Za-z_][\w]*)\s*\./g)) {
      const ident = m[1];
      if (skip.has(ident)) continue;
      out.push({ line: i + 1, ident });
    }
  }
  return out;
}

// ── 扫描快照 ─────────────────────────────────────────

function scanOne(cwd: string, abs: string, lang: Lang): FileScan {
  const file = path.relative(cwd, abs).split(path.sep).join('/') || abs;
  let src = '';
  try {
    src = fs.readFileSync(abs, 'utf-8');
  } catch {
    return { file, lang, undefinedRefs: [] };
  }
  const cleaned = cleanSource(src, lang);
  const { declared, aliases, locals } = collectSymbols(cleaned.text, lang);
  const combined = new Set<string>([...declared, ...aliases, ...locals]);
  if (lang === 'ts') for (const g of TS_GLOBALS) combined.add(g);
  if (lang === 'py') for (const g of PY_GLOBALS) combined.add(g);
  // Java/C#：内置命名空间/常用类型（System./java.* 段不会误判）；C 无内建对象引用（struct 变量已入 declared/locals）
  if (lang === 'java') for (const g of ['System', 'String', 'Math', 'Integer', 'Double', 'Boolean', 'Long', 'Object', 'Class', 'Thread', 'Runtime', 'ProcessBuilder']) combined.add(g);
  if (lang === 'cs') for (const g of ['System', 'String', 'Console', 'Math', 'Convert', 'Environment', 'DateTime', 'Guid', 'Object', 'Type', 'Exception', 'Array', 'List', 'Dictionary']) combined.add(g);

  const refs = collectReferences(cleaned.text, lang);
  const undefinedRefs: UndefinedRef[] = [];
  for (const r of refs) {
    if (!combined.has(r.ident)) {
      const line = cleaned.lineOf[Math.min(r.line - 1, cleaned.lineOf.length - 1)];
      undefinedRefs.push({ file, line, ident: r.ident, hint: `${file}:${line} ${r.ident}.` });
    }
  }
  return { file, lang, undefinedRefs };
}

export function scanContracts(opts: ScanContractsOptions): ContractSnapshot {
  const cwd = path.resolve(opts.cwd);
  const files: string[] = opts.files && opts.files.length > 0
    ? opts.files.map((f) => (path.isAbsolute(f) ? f : path.resolve(cwd, f)))
    : walkFiles(cwd, opts.dirs && opts.dirs.length > 0 ? opts.dirs.map((d) => path.resolve(cwd, d)) : [cwd]);

  const dirList: FileScan[] = [];
  const seen = new Set<string>();
  for (const abs of files) {
    const rel = path.relative(cwd, abs).split(path.sep).join('/');
    if (seen.has(rel)) continue;
    seen.add(rel);
    const l = opts.lang === 'auto' || !opts.lang ? langOfFile(rel) : opts.lang;
    if (!l) continue;
    dirList.push(scanOne(cwd, abs, l));
  }

  // 聚合去重失配
  const undefMap = new Map<string, UndefinedRef>();
  for (const f of dirList) {
    for (const r of f.undefinedRefs) {
      const key = `${r.file}:${r.line}:${r.ident}`;
      if (!undefMap.has(key)) undefMap.set(key, r);
    }
  }

  return { at: new Date().toISOString(), files: dirList, undefinedRefs: [...undefMap.values()] };
}

// ── 前后 diff ─────────────────────────────────────────

function refKey(r: UndefinedRef): string {
  return `${r.file}:${r.line}:${r.ident}`;
}

export function diffContracts(before: ContractSnapshot, after: ContractSnapshot): ContractDiff {
  const beforeKeys = new Set(before.undefinedRefs.map(refKey));
  const newIssues = after.undefinedRefs.filter((r) => !beforeKeys.has(refKey(r)));
  return { before, after, newIssues };
}

// ── 便利封装（单点场景） ─────────────────────────────

export interface ContractGateResult {
  scan: ContractSnapshot;
  ok: boolean;
  detail?: string;
}

/** 单点扫描：直接对给定 cwd/files 扫一遍并报告失配（不上 diff）。 */
export function contractGate(opts: ScanContractsOptions): ContractGateResult {
  const scan = scanContracts(opts);
  if (scan.undefinedRefs.length === 0) return { scan, ok: true };
  return {
    scan,
    ok: false,
    detail: scan.undefinedRefs.map((r) => r.hint).join('\n'),
  };
}