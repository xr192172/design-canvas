/**
 * python_refactor/dead_imports —— Python 文件级死 import 检测 + 移除（纯计算）
 *
 * 与 src/tools/detect_dead_imports.ts（TS/Go）同构：对一个文件，某 import 源的全部
 * 本地绑定在"剥离 import 语句自身"的源码里零出现 → 该源是死 import。
 * 不需要 DB、不需要闭包、不需要种子，任何 Python 项目都能直接扫。
 *
 * 保守规则（宁多报活/漏报死，不误删——检测信任优先，删除还过验证闭环）：
 *   - 只处理"单目标"import 行：`import a.b` / `import a.b as x` / `from m import c` /
 *     `from m import c as x`。多目标行（`import a, b` / `from m import a, b` / 括号续写）、
 *     `(from m import *)`、相对导入 `from . / from ..`、`__future__` 指令 → 一律恒活（跳过），
 *     因为"整条线删除"语义不允许只摘其中一个目标。
 *   - `import a.b` 绑定根名 `a`；别名 `as` 绑定别名。零引用扫描 = 无任何绑定名在剥离
 *     后的源码出现。注释/字符串中的同名出现不剥离 → 只会多活，安全向。
 */

import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['venv', '.venv', '__pycache__', 'node_modules', '.git', 'dist']);

export interface PyDeadImportCandidate {
  /** 死源（模块说明符；`import foo.bar` 记 `foo.bar`，`from foo.bar import c` 记 `foo.bar`） */
  source: string;
  /** 导入该源且文件内零引用的文件（相对 project_dir） */
  files: string[];
  reason: 'no_reference';
}

export interface DetectPyDeadImportsResult {
  dead: PyDeadImportCandidate[];
  /** 参与扫描的 .py 文件数 */
  scanned: number;
  limitations: string[];
}

/** 递归收集项目内 .py 源文件（跳过 venv/__pycache__ 等）。 */
export function scanPySourceFiles(project_dir: string, files?: string[]): string[] {
  const proj = path.resolve(project_dir);
  const toAbs = (f: string): string => (path.isAbsolute(f) ? path.resolve(f) : path.resolve(proj, f));
  const targets: string[] = [];
  if (files && files.length > 0) {
    for (const f of files) {
      const a = toAbs(f);
      if (fs.existsSync(a) && fs.statSync(a).isFile() && a.endsWith('.py')) targets.push(a);
    }
    return targets;
  }
  const walkDir = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walkDir(p);
      else if (ent.name.endsWith('.py')) targets.push(p);
    }
  };
  walkDir(proj);
  return targets;
}

export interface PyImportRef {
  /** 模块说明符（用于删除匹配的 key，与移除器同一 key） */
  source: string;
  /** 绑定名（`import a.b`→a；`import a as x`→x；`from m import c`→c） */
  bind: string;
}

export interface PyImportAnalysis {
  /** 单目标安全行的绑定对（可作移除候选） */
  candidates: PyImportRef[];
  /** 出现在"不安全行"（多目标/星号/括号续写/相对/未来导）里的模块 key → 整源保活 */
  unsafe: string[];
}

/**
 * 解析一个文件的所有 import/from 行。核心保守规则：
 * 一个 source 只要在任一"不安全行"出现，就必须进 unsafe —— 因为只能整条删、不能只摘
 * 其中一个目标；若照删会误伤同行的活绑定（如 `from m import a, b` 只删 a 会连 b 一起丢）。
 */
export function analyzePyImports(src: string): PyImportAnalysis {
  const candidates: PyImportRef[] = [];
  const unsafe = new Set<string>();
  const addUnsafeDotted = (t: string): void => {
    // `import a, b` / `import a.b, c`：逐个目标模块 key 记 unsafe
    for (const part of t.split(',')) {
      const root = part.trim().split(/\s+as\s+/)[0];
      if (root && /^[\w.]+$/.test(root)) unsafe.add(root);
    }
  };

  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;

    const imp = /^import\s+(.+)$/.exec(line);
    if (imp) {
      const target = imp[1].trim();
      if (target.includes(',') || target.includes('(')) {
        addUnsafeDotted(target); // 多目标 / 括号续写 → 相关模块整源保活
        continue;
      }
      const m = /^([\w.]+?)(?:\s+as\s+(\w+))?$/.exec(target);
      if (!m) continue; // 语法不认识 → 活
      candidates.push({ source: m[1], bind: m[2] ?? m[1].split('.')[0] });
      continue;
    }

    const from = /^from\s+([\w.]+|\.[\w.]*)\s+import\s+(.+)$/.exec(line);
    const fromParen = /^from\s+([\w.]+)\s+import\s*\(/.exec(line);
    if (fromParen) {
      unsafe.add(fromParen[1]); // 括号续写多 lines → 整模块保活
      continue;
    }
    if (from) {
      const mod = from[1];
      if (mod.startsWith('.')) continue; // 相对导入 → 活
      if (mod.startsWith('__future__')) continue; // future 指令 → 活
      const what = from[2].trim();
      if (what.includes('*') || what.startsWith('(') || what.includes(',')) {
        unsafe.add(mod); // 星号 / 多目标 → 整源保活
        continue;
      }
      const m = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(what);
      if (!m) continue;
      candidates.push({ source: mod, bind: m[2] ?? m[1] });
    }
  }

  return { candidates, unsafe: [...unsafe] };
}

/** 单目标安全行的绑定对（旧接口，供测试/调用方取候选）。 */
export function enumeratePyImports(src: string): PyImportRef[] {
  return analyzePyImports(src).candidates;
}

/** 剥掉所有 import/from 行 → 供"零引用"扫描（避免 import 行自身含绑定名假"出现"）。 */
function stripPyImports(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(import|from|__future__)\s/.test(l))
    .join('\n');
}

const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 文件级死 import 检测：扫描项目 .py 源，聚合出死候选（source → files）。 */
export function detectDeadPyImports(opts: { project_dir: string; files?: string[] }): DetectPyDeadImportsResult {
  const proj = path.resolve(opts.project_dir);
  const absFiles = scanPySourceFiles(proj, opts.files);
  const agg = new Map<string, { files: string[]; seen: Set<string> }>();

  for (const abs of absFiles) {
    let src: string;
    try {
      src = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    const { candidates, unsafe } = analyzePyImports(src);
    const unsafeSet = new Set(unsafe);
    if (unsafeSet.size === 0 && candidates.length === 0) continue;
    // 按 source 聚合本文件的绑定名（排除 unsafe —— 整源保活）
    const perSource = new Map<string, string[]>();
    for (const r of candidates) {
      if (unsafeSet.has(r.source)) continue;
      const list = perSource.get(r.source) ?? [];
      list.push(r.bind);
      perSource.set(r.source, list);
    }
    const scan = stripPyImports(src);
    for (const [source, binds] of perSource) {
      const dead = !binds.some((b) => new RegExp(`\\b${escRe(b)}\\b`).test(scan));
      if (!dead) continue;
      let a = agg.get(source);
      if (!a) {
        a = { files: [], seen: new Set() };
        agg.set(source, a);
      }
      const rel = path.relative(proj, abs) || abs;
      if (!a.seen.has(rel)) {
        a.seen.add(rel);
        a.files.push(rel);
      }
    }
  }

  const dead: PyDeadImportCandidate[] = [];
  for (const [source, a] of agg) {
    if (a.files.length === 0) continue;
    dead.push({ source, files: a.files.sort(), reason: 'no_reference' });
  }
  dead.sort((x, y) => (x.source < y.source ? -1 : 1));

  return {
    dead,
    scanned: absFiles.length,
    limitations: [
      'py 保守：仅单目标 import/from-import 参与判定；同一模块只要出现过不安全行（多目标、括号续写、星号导入）即整源保活，不误删；相对导入、__future__ 指令恒活',
      '文件级自洽判定：某 import 的全部绑定在文件内零引用即报死；注释/字符串中的同名出现未剥离只会多活，安全向',
      '判定仅见文件内部，未做跨文件可达性——保守漏报多于误报；删除前请先过验证闭环（compileall + pytest）',
    ],
  };
}

/** 逐行整条删除目标 source 的单目标 import/from-import 语句。返回新源码与原样比对。 */
export function removePyImportsFromSource(src: string, source: string): { removed: number; output: string } {
  const esc = escRe(source);
  const reImport = new RegExp(`^[ \\t]*import[ \\t]+${esc}([ \\t]|$)`, 'm');
  const reFrom = new RegExp(`^[ \\t]*from[ \\t]+${esc}[ \\t]+import[ \\t]`, 'm');
  let removed = 0;
  const lines = src.split('\n').map((l) => {
    if (reImport.test(l) || reFrom.test(l)) {
      removed++;
      return null;
    }
    return l;
  });
  return { removed, output: lines.filter((l): l is string => l !== null).join('\n') };
}