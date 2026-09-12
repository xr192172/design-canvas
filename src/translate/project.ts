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
import { fillUnitsWithRetry, fillUnitsBatched } from './fill.js';
import { createPooledBatchTranslator } from './llm.js';
import { applyDeterministicFixers } from './fixers.js';
import type { SkippedDecl } from './go_extractor.js';
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
  /** 萃取期被跳过的项（A1 失败清单：空结构/空接口/不可求值 const） */
  skipped: SkippedDecl[];
  /** 该模块 LLM 填孔失败：unit.id → 原因（A1 失败清单：llm_retry_fail） */
  fillFailures: Map<string, string>;
}

/** A1 显式失败清单条目：每个单元/跳过项一条，定位到 Go 源行 */
export interface ReportEntry {
  file: string;
  id: string;
  kind: string;
  line: number;
  status: 'ok' | 'skeleton' | 'llm_retry_fail' | 'skipped';
  reason?: string;
}

export interface ProjectResult {
  modules: ProjectModule[];
  /** 冲突 / stdlib 未定义等诊断（不阻断） */
  diagnostics: string[];
  /** A1 显式失败清单：逐单元状态，降级不再被静默吞掉 */
  report: ReportEntry[];
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
  /** 项目内一批函数一次 LLM 调用（内置 key 池走批量，注入 translator 时忽略）。默认 5 */
  batchSize?: number;
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

/** 组装模块内容：import 头 + Channel 垫片（如需） + 各单元骨架；随后跑 C1 确定性 fixer 去未用 import/合 import。 */
function assembleModule(m: ProjectModule): void {
  const body = m.units.map((u) => u.skeleton).join('\n\n') + (m.units.length ? '\n' : '');
  const shim = body.includes('Channel<') ? channelShimSource() : '';
  m.ts = applyDeterministicFixers([m.imports.join('\n'), shim, body].filter((s) => s !== '').join('\n'));
}

/**
 * A1 显式失败清单：把每模块的单元 + 萃取跳过项 → 扁平报告。
 * 状态判定：
 *   - id 在 fillFailures → 'llm_retry_fail'（LLM 填孔重试耗尽）
 *   - bodyHole 且未填过（fill 未 request）→ 'skeleton'（留孔）
 *   - 其它（type/const 或已填 ok 的 func）→ 'ok'
 *   - 萃取期跳过项 → 'skipped'
 * 每条带 Go 源行，供"一键定位到源码"。
 */
function buildReport(modules: ProjectModule[], fillRequested: boolean): ReportEntry[] {
  const out: ReportEntry[] = [];
  for (const m of modules) {
    for (const u of m.units) {
      const failReason = m.fillFailures.get(u.id);
      let status: ReportEntry['status'];
      let reason: string | undefined;
      if (failReason) {
        status = 'llm_retry_fail';
        reason = failReason;
      } else if (u.bodyHole && !fillRequested) {
        status = 'skeleton';
        reason = '函数体留孔（未请求 LLM 填充）';
      } else {
        status = 'ok';
      }
      out.push({ file: m.rel, id: u.id, kind: u.kind, line: u.srcLine ?? 0, status, reason });
    }
    for (const s of m.skipped) {
      out.push({ file: m.rel, id: s.name, kind: s.kind, line: s.line, status: 'skipped', reason: s.reason });
    }
  }
  return out;
}

/** 落 A1 报告：translation-report.jsonl（逐行 JSON）+ translation-report.md（分组汇总） */
function writeReport(outDir: string, report: ReportEntry[]): void {
  const jsonl = report.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const byStatus = new Map<string, number>();
  for (const r of report) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  const lines: string[] = [
    '# Go→TS 翻译报告',
    '',
    `共 ${report.length} 条`,
    '',
    ...['ok', 'skeleton', 'llm_retry_fail', 'skipped'].map((s) => `- ${s}: ${byStatus.get(s) ?? 0}`),
    '',
    '## 明细',
    '',
  ];
  for (const r of report) {
    lines.push(`- [${r.status}] ${r.file}:${r.line} ${r.id}${r.reason ? ` — ${r.reason}` : ''}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'translation-report.jsonl'), jsonl, 'utf-8');
  fs.writeFileSync(path.join(outDir, 'translation-report.md'), lines.join('\n'), 'utf-8');
}

/**
 * 项目级调用约定 note，注入该模块每个孔（函数体）的 LLM prompt：
 *   - 本模块可直接调用的自由函数（本地定义 + 已 import 的跨文件 free func）；
 *   - receiver 方法须译成 `T_method(recv, ...)` 自由函数调用（勿写 recv.method()）。
 * 让 LLM 填出的函数体引用对名，从而配合 #1 import 使门禁在填后也能过。
 * A2 增强：ctx 提供全局函数签名 + 类型字段表，把"跨文件语义上下文"（兄弟函数签名、
 * 被引类型的字段词表，如 Address.broadcast）注入单孔 prompt，让 LLM 保留语义（单播/广播）而非脑补。
 */
export interface ProjectCallContext {
  /** 全局函数名 → 首行签名（含符号语义）；跨文件兄弟函数给 LLM 看形状 */
  funcSkel: Map<string, string>;
  /** 全局类型名 → interface 字段表（给 LLM 看字段语义，如 broadcast/excludeRoles） */
  typeSkel: Map<string, string>;
}
export function buildProjectCallNote(m: ProjectModule, defined: Map<string, SymbolDef>, ctx?: ProjectCallContext): string {
  const local = m.units.filter((u) => u.kind === 'func').map((u) => u.name);
  const imported: string[] = [];
  for (const name of m.callRefsRaw) {
    const def = defined.get(name);
    if (def && def.isFunc && def.file !== '__multi__' && def.file !== m.rel && !local.includes(name)) imported.push(name);
  }
  const funcs = [...new Set([...local, ...imported])].sort();
  const lines: string[] = ['【项目级调用约定】'];
  if (funcs.length) lines.push(...funcs.map((n) => `- 可直接调用函数：${n}`));
  if (lines.length === 1) lines.push('- （无）');
  // A2：兄弟/跨文件函数签名（形状语义）
  if (ctx && funcs.length) {
    const sigLines = [];
    for (const n of funcs) {
      const sig = ctx.funcSkel.get(n);
      if (sig) sigLines.push(`- ${n} ${sig}`);
    }
    if (sigLines.length) lines.push('【可直接调用函数的签名（调用约定看形状）】', ...sigLines);
  }
  // A2：本模块引用的类型及其字段（字段语义，如 Address.broadcast 决定单播/广播）
  if (ctx) {
    const refTypes = new Set<string>();
    for (const u of m.units) for (const ref of collectExternalTypeRefs(u)) refTypes.add(ref);
    const fieldLines: string[] = [];
    for (const name of [...refTypes].sort()) {
      const sk = ctx.typeSkel.get(name);
      if (sk) fieldLines.push(`- ${name} ${sk}`);
    }
    if (fieldLines.length) lines.push('【本模块引用到的类型字段（保留其语义，勿丢）】', ...fieldLines);
  }
  if (local.some((n) => /_\w/.test(n))) {
    lines.push('- receiver 方法调用请译成自由函数，形如 user_GetName(recv, ...)，不要写成 recv.GetName(...)');
  }
  return lines.join('\n');
}

/** C2 tsc 错误根因聚类：一个簇 = 同一 code + 归一化消息（标识符/数字泛化） */
export interface TscCluster {
  label: string;
  count: number;
  sample: string;
}

/** TS diagnostics code → 可读类别名（未收录用 TS<code>） */
const TS_CODE_LABEL: Record<number, string> = {
  2304: '未定义的名字/类型', 2307: '找不到模块', 2503: '找不到命名空间', 2339: '对象上不存在属性',
  2322: '赋值类型不兼容', 2345: '实参类型不兼容', 2554: '实参数目不匹配', 7006: '隐式 any 参数',
  2709: '隐式 any 返回', 2540: '对只读属性赋值', 7030: '非全部代码路径返回', 6133: '声明未使用',
};

/** 根因键：code + 消息里把具体标识符/数字泛化的归一形式（同类不同名归并） */
function clusterKeyFor(code: number, msg: string): string {
  const norm = msg.replace(/[A-Za-z_$][\w$]*/g, '<id>').replace(/\b\d+(\.\d+)?\b/g, '<num>');
  return code + '::' + norm;
}

/**
 * 全工程 tsc 门禁：用 TS compiler API 对「内存模块树」跑 preEmit。
 * 非 strict + 跳 .d.ts，只为抓真实的类型/引用/import 解析错误。
 * 特例：TS 2355（显式非空返回类型却缺 return）是骨架"函数体留孔"固有的，
 * 每颗孔都有——不属于翻译错误，跳过。
 * 纯工程应 0 错；错误按**根因聚类**返回（看类数下降，而非逐条条数）。
 */
function verifyProjectTree(modules: ProjectModule[]): TscCluster[] {
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
  const clusters = new Map<string, TscCluster>();
  for (const d of ts.getPreEmitDiagnostics(program)) {
    if (!d.file) continue;
    if (SKIP_CODES.has(d.code)) continue;
    const f = d.file.fileName.replace(/^\/p\//, '');
    const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ').replace(/\s+/g, ' ').trim();
    let loc = f;
    if (d.start !== undefined) {
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
      loc = `${f}:${line + 1}:${character + 1}`;
    }
    const key = clusterKeyFor(d.code, msg);
    const hit = clusters.get(key);
    if (hit) hit.count++;
    else clusters.set(key, { label: TS_CODE_LABEL[d.code] ?? `TS${d.code}`, count: 1, sample: `${loc} ${msg}` });
  }
  return [...clusters.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * 项目级翻译：枚举 .go → 逐个翻译为 TS 模块 → 跨文件 import 落定 → 组装（可选落盘 / LLM 填）。
 */
export async function translateGoProject(projectDir: string, opts: ProjectOptions = {}): Promise<ProjectResult> {
  const root = path.resolve(projectDir);
  const files = walkGoFiles(root);
  // 内置 key 池 → 批量填（省共享 prompt 常量）；显式注入 translator → 单孔路径（测试桩 / 自建 provider）
  const singleTranslator = opts.fill && opts.translator ? opts.translator : null;
  const useBatch = opts.fill && !opts.translator;
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
    modules.push({ fileAbs, rel, tsRel: rel.replace(/\.go$/, '.ts'), ts: '', imports: [], callRefsRaw, units: r.units, issues: r.issues, skipped: r.skipped ?? [], fillFailures: new Map() });
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

  // A2 语义上下文：全局函数签名 + 类型字段表，注入 fill 让 LLM 保留跨文件语义
  const pctx: ProjectCallContext = { funcSkel: new Map(), typeSkel: new Map() };
  for (const mm of modules) {
    for (const u of mm.units) {
      if (u.kind === 'func' && u.skeleton && !pctx.funcSkel.has(u.name)) {
        pctx.funcSkel.set(u.name, u.skeleton.split('\n')[0].replace(/\{\s*$/, '').trim());
      } else if (u.kind === 'type' && u.skeleton && !pctx.typeSkel.has(u.name)) {
        pctx.typeSkel.set(u.name, u.skeleton.replace(/\s+/g, ' ').trim());
      }
    }
  }

  // 第三遍（fill）：在 import 已算定的前提下逐模块注入「项目级调用约定」再填孔，
  // 让函数体引用对名；填完重建每个模块的 m.ts（门禁在填后输出上跑 = 填后 release gate）。
  if (opts.fill) {
    for (const m of modules) {
      const note = buildProjectCallNote(m, defined, pctx) || undefined;
      let filled: Awaited<ReturnType<typeof fillUnitsWithRetry>>;
      if (useBatch) {
        filled = await fillUnitsBatched(m.units, createPooledBatchTranslator(), {
          batchSize: opts.batchSize ?? 5,
          maxRetries: opts.maxRetries ?? 2,
          projectNote: note,
        });
      } else if (singleTranslator) {
        filled = await fillUnitsWithRetry(m.units, singleTranslator, opts.maxRetries ?? 2, note);
      } else {
        continue;
      }
      const byId = new Map(filled.map((f) => [f.unit.id, f]));
      for (const u of m.units) {
        const f = byId.get(u.id);
        if (f?.ok) u.skeleton = f.filledSource;
      }
      const failed = filled.filter((f) => !f.ok);
      for (const f of failed) {
        m.fillFailures.set(f.unit.id, f.error ?? f.issues.map((i) => i.detail).join('；'));
      }
      if (failed.length) {
        const firstErr = failed[0].error ?? failed[0].issues.map((i) => i.detail).join('；');
        diagnostics.push(`${m.rel}: LLM 填孔失败 ${failed.length}/${filled.length}：${firstErr}`);
      }
    }
  }
  for (const m of modules) assembleModule(m);

  // A1 显式失败清单：降级不再静默吞掉
  const report = buildReport(modules, opts.fill === true);
  if (opts.outDir) writeReport(path.resolve(opts.outDir), report);

  // 全工程 tsc 门禁：对内存模块树跑 TS preEmit，错误按根因聚类并入诊断（不阻断）
  if (opts.verify && modules.length) {
    const clusters = verifyProjectTree(modules);
    if (clusters.length) {
      const total = clusters.reduce((s, c) => s + c.count, 0);
      diagnostics.push(
        `全工程 tsc 检查未通过：${clusters.length} 类 / ${total} 条\n${clusters.map((c) => `  • [${c.label}] ×${c.count}  例: ${c.sample}`).join('\n')}`,
      );
    }
  }

  // 落盘：镜像相对结构
  if (opts.outDir) {
    for (const m of modules) {
      const outAbs = path.join(path.resolve(opts.outDir), m.tsRel);
      fs.mkdirSync(path.dirname(outAbs), { recursive: true });
      fs.writeFileSync(outAbs, m.ts, 'utf-8');
    }
  }

  return { modules, diagnostics, report, ok: modules.every((m) => m.issues.length === 0) };
}