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

export type Lang = 'go' | 'ts';

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

const SRC_EXT = ['.go', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

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

// ── 语言判定 ─────────────────────────────────────────

function langOfFile(rel: string): Lang | null {
  if (rel.endsWith('.go')) return 'go';
  // JS 家族：语法是 TS 子集，走同一套 ts 分支（collectSymbols/collectReferences 的 TS 逻辑对纯 JS 兼容）
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(rel)) return 'ts';
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
  return lang === 'go' ? GO_RESERVED : SKIP_LHS;
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