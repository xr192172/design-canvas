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
import { translateGoToTs } from './pairs.js';
import { channelShimSource } from './ts_codegen.js';
import { collectExternalTypeRefs } from './referenced.js';
import { fillUnitsWithRetry } from './fill.js';
import { createPooledHoleTranslator } from './llm.js';
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
 * 项目级翻译：枚举 .go → 逐个翻译为 TS 模块 → 跨文件 import 落定 → 组装（可选落盘 / LLM 填）。
 */
export async function translateGoProject(projectDir: string, opts: ProjectOptions = {}): Promise<ProjectResult> {
  const root = path.resolve(projectDir);
  const files = walkGoFiles(root);
  const translator = opts.fill ? createPooledHoleTranslator() : null;
  const diagnostics: string[] = [];

  // 第一遍：翻译每个文件，收集"名字 → 定义文件"
  const modules: ProjectModule[] = [];
  const defined = new Map<string, string>(); // name → fileRel（同名跨文件 → '__multi__'）
  for (const fileAbs of files) {
    const rel = toPosix(path.relative(root, fileAbs));
    const src = fs.readFileSync(fileAbs, 'utf-8');
    const r = await translateGoToTs(fileAbs, src);
    if (r.error) {
      diagnostics.push(`${rel}: 翻译失败 ${r.error}`);
      continue;
    }
    if (r.units.length === 0) continue; // 无顶层可译单元则跳过
    if (opts.fill && r.units.some((u) => u.bodyHole)) {
      const filled = await fillUnitsWithRetry(r.units, translator!, opts.maxRetries ?? 2);
      const byId = new Map(filled.map((f) => [f.unit.id, f]));
      for (const u of r.units) {
        const f = byId.get(u.id);
        if (f?.ok) u.skeleton = f.filledSource;
      }
    }
    // 同名冲突标记
    for (const u of r.units) {
      const ex = defined.get(u.name);
      if (ex === undefined) defined.set(u.name, rel);
      else if (ex !== rel) defined.set(u.name, '__multi__');
    }
    modules.push({ fileAbs, rel, tsRel: rel.replace(/\.go$/, '.ts'), ts: '', imports: [], units: r.units, issues: r.issues });
  }

  // 第二遍：为每个模块算跨文件 import（类型引用落地）
  const stdlibUndefined = new Set<string>();
  const conflicted = new Set<string>();
  for (const m of modules) {
    const refs = new Set<string>();
    for (const u of m.units) for (const ref of collectExternalTypeRefs(u)) refs.add(ref);
    const byPath = new Map<string, string[]>();
    for (const name of refs) {
      const def = defined.get(name);
      if (!def) {
        if (/^[A-Z]/.test(name)) stdlibUndefined.add(name); // Go 导出名未定义 → stdlib/外部
        continue;
      }
      if (def === '__multi__') {
        conflicted.add(name); // 同名多文件定义 → 不 import
        continue;
      }
      if (def === m.rel) continue; // 同文件自解
      const arr = byPath.get(def) ?? [];
      arr.push(name);
      byPath.set(def, arr);
    }
    const imports = [...byPath.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([rel, names]) => `import { ${names.sort().join(', ')} } from '${relImportPath(m.rel, rel)}';`);
    m.imports = imports;

    const body = m.units.map((u) => u.skeleton).join('\n\n') + (m.units.length ? '\n' : '');
    const shim = body.includes('Channel<') ? channelShimSource() : '';
    m.ts = [imports.join('\n'), shim, body].filter((s) => s !== '').join('\n');
  }
  if (stdlibUndefined.size) diagnostics.push(`项目内未定义的导出类型（Go stdlib/外部，需 LLM/人工）：${[...stdlibUndefined].sort().join(', ')}`);
  if (conflicted.size) diagnostics.push(`同名顶层符号多文件冲突（未 import，需人工消歧）：${[...conflicted].sort().join(', ')}`);

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