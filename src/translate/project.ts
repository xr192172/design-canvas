/**
 * project —— 项目级 Go→TS 翻译（`translateGoProject`）
 *
 * 把一个 Go 项目目录变成一棵 TS 模块树：枚举所有 .go，逐个译成 TS 模块，
 * 用"项目符号名 → 定义文件"映射为每个模块生成跨文件 import（类型引用落地，
 * 签名才不悬空）。复用单文件 translateGoToTs / 骨架 / 验证闸，零前置。

 * 诚实边界：只给类型引用做跨文件 import；函数体里的跨文件函数调用归 LLM；
 * Go stdlib / 外部类型不硬解、同名冲突不 import，均记 diagnostic。
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { translateGoToTs } from './pairs.js';
import { channelShimSource } from './ts_codegen.js';
import { collectExternalTypeRefs } from './referenced.js';
import { fillUnitsWithRetry } from './fill.js';
import { createPooledHoleTranslator } from './llm.js';
import { parseFileFull } from '../tools/ts_kernel/index.js';
import type { TransUnit } from './unit.js';
import type { VerifyIssue } from './verify.js';

/** 项目内跳过的噪声目录（不进 .go 扫描） */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'vendor', 'target', 'venv', '.venv', '__pycache__', '.design-canvas']);

/** 递归收集 .go 源文件（跳过 _test.go 与噪声目录） */
export function walkGoFiles(dir: string): string[] {
  const out: string[] = [];
  const stack = [path.resolve(dir)];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(p);
      } else if (e.isFile() && e.name.endsWith('.go') && !e.name.endsWith('_test.go')) {
        out.push(p);
      }
    }
  }
  return out.sort();
}

export interface ProjectModule {
  /** 源 .go 绝对路径 */
  fileAbs: string;
  /** 相对 projectDir 的相对路径（正斜杠，.go） */
  rel: string;
  /** 输出相对路径（.ts） */
  tsRel: string;
  /** 组装后的模块内容（imports + 可能的 Channel 垫片 + 模块体） */
  ts: string;
  /** 生成的跨文件 import 语句 */
  imports: string[];
  /** 本文件内部的裸调用、未在同一文件解析、导出名的被调用函数名（跨文件函数调用候选） */
  callRefsRaw: string[];
  units: TransUnit[];
  issues: VerifyIssue[];
}

export interface ProjectResult {
  modules: ProjectModule[];
  /** 冲突 / stdlib 未定义等诊断（不阻断） */
  diagnostics: string[];
  ok: boolean;
}

export interface ProjectOptions {
  /** 落盘根（不传则不写盘） */
  outDir?: string;
  /** 用 AGNES key 池 LLM 填函数体 */
  fill?: boolean;
  maxRetries?: number;
  /** 全工程 tsc 门禁：对内存模块树跑 TS preEmit，错误并入 diagnostics（纯工程应 0 错；stdlib 未解析会如实列出） */
  verify?: boolean;
  /** 注入翻译器（默认 createPooledHoleTranslator）——测试桩/自建 provider 用，便于确定性实证 */
  translator?: import('./fill.js').HoleTranslator | null;
}

function toPosix(abs: string): string {
  return abs.split(path.sep).join('/');
}

function relImportPath(fromGoRel: string, toGoRel: string): string {
  const fromDir = path.posix.dirname(fromGoRel);
  const toNoExt = toGoRel.replace(/\.go$/, '');
  const r = path.posix.relative(fromDir || '.', toNoExt);
  return r.startsWith('.') ? r : './' + r;
}

/**
 * 跨文件"自由函数调用"候选名收集：用 parseFileFull 的调用边（Go call_expression），
 * 只取 `resolved=false`（未在本文件符号表解析）的调用：
 *   - 裸调用 `Foo(...)` → Foo 为候选（同包跨文件 / dot-import / 内置）；
 *   - 包限定 `pkg.Foo(...)` → 仅当 `pkg` 是本文件某个 Go import 的绑定别名时候选
 *     （排除方法调用 `u.GetName()` 这类 receiver 前缀——其前缀不是 import 别名）。
 * 候选名最终只补「项目内定义为 free func 的」，内置 / stdlib 天然被过滤。
 */
async function collectCallRefs(fileAbs: string, src: string): Promise<string[]> {
  const parsed = await parseFileFull(fileAbs, src);
  if (parsed.error || !parsed.calls) return [];
  const pkgAliases = new Set<string>();
  for (const imp of parsed.imports) {
    for (const b of imp.bindings ?? []) {
      if (b && b !== '_' && b !== '.') pkgAliases.add(b);
    }
  }
  const names = new Set<string>();
  for (const c of parsed.calls) {
    if (c.resolved) continue; // 同文件已解析
    const prefix = c.callee_expr.match(/^([A-Za-z_$][\w$]*)\./)?.[1];
    if (prefix && !pkgAliases.has(prefix)) continue; // 方法/未知前缀调用不盲补
    names.add(c.callee);
  }
  return [...names].sort();
}

/** 符号→定义位置（跨文件 import 判定用）。file='__multi__' 表示同名多文件冲突。 */
export interface SymbolDef {
  file: string;
  isFunc: boolean;
}

/** 组装模块内容：import 头 + Channel 垫片（如需） + 各单元骨架。 */
function assembleModule(m: ProjectModule): void {
  const body = m.units.map((u) => u.skeleton).join('\n\n') + (m.units.length ? '\n' : '');
  const shim = body.includes('Channel<') ? channelShimSource() : '';
  m.ts = [m.imports.join('\n'), shim, body].filter((s) => s !== '').join('\n');
}

/**
 * 项目级调用约定 note，注入该模块每个孔（函数体）的 LLM prompt：
 *   - 本模块可直接调用的自由函数（本地定义 + 已 import 的跨文件 free func）；
 *   - receiver 方法须译成 `T_method(recv, ...)` 自由函数调用（勿写 recv.method()）。
 * 让 LLM 填出的函数体引用对名，从而配合 #1 import 使门禁在填后也能过。
 */
export function buildProjectCallNote(m: ProjectModule, defined: Map<string, SymbolDef>): string {
  const local = m.units.filter((u) => u.kind === 'func').map((u) => u.name);
  const imported: string[] = [];
  for (const name of m.callRefsRaw) {
    const def = defined.get(name);
    if (def && def.isFunc && def.file !== '__multi__' && def.file !== m.rel && !local.includes(name)) imported.push(name);
  }
  const funcs = [...new Set([...local, ...imported])].sort();
  if (funcs.length === 0) return '';
  const lines: string[] = ['【项目级调用约定】', ...funcs.map((n) => `- 可直接调用函数：${n}`)];
  if (local.some((n) => /_\w/.test(n))) {
    lines.push('- receiver 方法调用请译成自由函数，形如 user_GetName(recv, ...)，不要写成 recv.GetName(...)');
  }
  return lines.join('\n');
}

/**
 * 全工程 tsc 门禁：用 TS compiler API 对「内存模块树」跑 preEmit。
 * 非 strict + 跳 .d.ts，只为抓真实的类型/引用/import 解析错误。
 * 特例：TS 2355（显式非空返回类型却缺 return）是骨架"函数体留孔"固有的，
 * 每颗孔都有——不属于翻译错误，跳过。
 * 纯工程应 0 错；stdlib/外部类型未定义会如实列出。返回诊断行（[tsc] 前缀）。
 */
function verifyProjectTree(modules: ProjectModule[]): string[] {
  // TS 2355 = 显式非空返回类型缺 return（骨架留孔固有，非翻译错误）
  const SKIP_CODES = new Set([2355]);
  const source = new Map<string, string>();
  for (const m of modules) source.set('/p/' + m.tsRel, m.ts);
  const rootNames = [...source.keys()];
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    skipLibCheck: true,
    noEmit: true,
    strict: false,
    types: [],
  };
  const host = ts.createCompilerHost(options, true);
  const origFileExists = host.fileExists.bind(host);
  const origReadFile = host.readFile.bind(host);
  const origDirectoryExists = host.directoryExists?.bind(host);
  host.fileExists = (f) => source.has(f) || origFileExists(f);
  host.readFile = (f) => source.get(f) ?? origReadFile(f);
  host.directoryExists = (d) => (d.startsWith('/p/') || d === '/p') || (origDirectoryExists ? origDirectoryExists(d) : false);

  const program = ts.createProgram({ rootNames, options, host });
  const out: string[] = [];
  for (const d of ts.getPreEmitDiagnostics(program)) {
    if (!d.file) continue;
    if (SKIP_CODES.has(d.code)) continue;
    const f = d.file.fileName.replace(/^\/p\//, '');
    const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ').replace(/\s+/g, ' ').trim();
    if (d.start !== undefined && d.file) {
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
      out.push(`[tsc] ${f}:${line + 1}:${character + 1} ${msg}`);
    } else {
      out.push(`[tsc] ${f}: ${msg}`);
    }
  }
  return out;
}

/**
 * 项目级翻译：枚举 .go → 逐个翻译为 TS 模块 → 跨文件 import 落定 → 组装（可选落盘 / LLM 填）。
 */
export async function translateGoProject(projectDir: string, opts: ProjectOptions = {}): Promise<ProjectResult> {
  const root = path.resolve(projectDir);
  const files = walkGoFiles(root);
  const translator = opts.fill ? (opts.translator ?? createPooledHoleTranslator()) : null;
  const diagnostics: string[] = [];

  // 第一遍：翻译每个文件，收集"名字 → 定义位置"（含类型/函数区分）与调用候选
  const modules: ProjectModule[] = [];
  const defined = new Map<string, SymbolDef>(); // name → { file, isFunc }（同名跨文件 → file='__multi__'）
  for (const fileAbs of files) {
    const rel = toPosix(path.relative(root, fileAbs));
    const src = fs.readFileSync(fileAbs, 'utf-8');
    const r = await translateGoToTs(fileAbs, src);
    if (r.error) {
      diagnostics.push(`${rel}: 翻译失败 ${r.error}`);
      continue;
    }
    if (r.units.length === 0) continue; // 无顶层可译单元则跳过
    const callRefsRaw = await collectCallRefs(fileAbs, src);
    // 同名冲突标记（保留 isFunc，跨文件同名 func 不盲补）
    for (const u of r.units) {
      const ex = defined.get(u.name);
      if (!ex) defined.set(u.name, { file: rel, isFunc: u.kind === 'func' });
      else if (ex.file !== rel) defined.set(u.name, { file: '__multi__', isFunc: ex.isFunc || u.kind === 'func' });
    }
    modules.push({ fileAbs, rel, tsRel: rel.replace(/\.go$/, '.ts'), ts: '', imports: [], callRefsRaw, units: r.units, issues: r.issues });
  }

  // 第二遍：为每个模块算跨文件 import（类型引用 + 自由函数调用）。
  const stdlibUndefined = new Set<string>();
  const conflicted = new Set<string>();
  for (const m of modules) {
    const byPath = new Map<string, Set<string>>();
    const addToPath = (name: string, targetRel: string): void => {
      const s = byPath.get(targetRel) ?? new Set<string>();
      s.add(name);
      byPath.set(targetRel, s);
    };
    const markConflict = (name: string): void => {
      if (!conflicted.has(name)) conflicted.add(name);
    };
    // 类型引用落地（沿用：导出名未定义 → stdlib/外部诊断；同名冲突 → 不 import）
    for (const name of new Set(m.units.flatMap((u) => collectExternalTypeRefs(u)))) {
      const def = defined.get(name);
      if (!def) {
        if (/^[A-Z]/.test(name)) stdlibUndefined.add(name);
        continue;
      }
      if (def.file === '__multi__') {
        markConflict(name);
        continue;
      }
      if (def.file === m.rel) continue; // 同文件自解
      addToPath(name, def.file);
    }
    // 自由函数调用落地：只在项目内定义为 free func 且在不同文件时补 import
    for (const name of m.callRefsRaw) {
      const def = defined.get(name);
      if (!def || !def.isFunc) continue; // 项目内未定义（内置/stdlib）或非函数 → 不补
      if (def.file === '__multi__') {
        markConflict(name);
        continue;
      }
      if (def.file === m.rel) continue; // 同文件
      addToPath(name, def.file);
    }
    const imports = [...byPath.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([rel, names]) => `import { ${[...names].sort().join(', ')} } from '${relImportPath(m.rel, rel)}';`);
    m.imports = imports;
  }
  if (stdlibUndefined.size) diagnostics.push(`项目内未定义的导出类型（Go stdlib/外部，需 LLM/人工）：${[...stdlibUndefined].sort().join(', ')}`);
  if (conflicted.size) diagnostics.push(`同名顶层符号多文件冲突（未 import，需人工消歧）：${[...conflicted].sort().join(', ')}`);

  // 第三遍（fill）：在 import 已算定的前提下逐模块注入「项目级调用约定」再填孔，
  // 让函数体引用对名；填完重建每个模块的 m.ts（门禁在填后输出上跑 = 填后 release gate）。
  if (opts.fill && translator) {
    for (const m of modules) {
      const note = buildProjectCallNote(m, defined);
      const filled = await fillUnitsWithRetry(m.units, translator, opts.maxRetries ?? 2, note || undefined);
      const byId = new Map(filled.map((f) => [f.unit.id, f]));
      for (const u of m.units) {
        const f = byId.get(u.id);
        if (f?.ok) u.skeleton = f.filledSource;
      }
    }
  }
  for (const m of modules) assembleModule(m);

  // 全工程 tsc 门禁：对内存模块树跑 TS preEmit，错误并入诊断（不阻断）
  if (opts.verify && modules.length) {
    const tscDiags = verifyProjectTree(modules);
    if (tscDiags.length) diagnostics.push(`全工程 tsc 检查未通过：\n${tscDiags.map((d) => '  ' + d).join('\n')}`);
  }

  // 落盘：镜像相对结构
  if (opts.outDir) {
    for (const m of modules) {
      const outAbs = path.join(path.resolve(opts.outDir), m.tsRel);
      fs.mkdirSync(path.dirname(outAbs), { recursive: true });
      fs.writeFileSync(outAbs, m.ts, 'utf-8');
    }
  }

  return { modules, diagnostics, ok: modules.every((m) => m.issues.length === 0) };
}