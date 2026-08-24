/**
 * remove_dead_imports —— 移除死 import 执行器（积木瘦身的"剪刀"辅助）
 *
 * 与 dead_deps 配套：dead_deps 负责"只报告偏差、绝不自动改写"（Camera 宪法），
 * 产出 DeadDepCandidate[]（source + 导入它的文件）；本模块负责"人拍板后
 * 执行改写"，把闭包内指向死三方源（third_party 且被判定死候选）的
 * import/require/re-export 语句从文件里删掉。
 *
 * 分层：
 *   1. 纯函数 removeImportsFromSource(src, target, lang)：单文件、单源，返回新源码。
 *      → 便于单测覆盖 Go/TS 各 import 形态，且默认保守（识别不出 → 不动 = 安全）。
 *   2. 执行器 removeDeadImports：聚合 dead 清单 → 按文件分组 → 逐源串联删除 →
 *      原子落盘（预读全部源文件，任一失败即中止、一个都不写）。
 *
 * 保守规则（宁漏删不误删）：
 *   - 只删"整条 import/require/re-export 语句"，语句内的符号选择性删除不做
 *     （如 import { a } from 'x' 里 a 死、b 活 → 本工具整条留着，交给更细的剪枝）。
 *   - 语法形态识别失败 / 不认识的形态 → 该语句不动。
 *   - Go 块导入删成员后若块变空（无其余成员/注释）才删 `import (`...`)` 壳，
 *     否则保留壳（含注释）。
 *   - 动态 import('x') / 函数内 require 调用等"使用点"一律不碰。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DeadDepCandidate } from './dead_deps.js';

// ─────────────────────────────────────────────
// 纯函数：单文件删除指向 target 的 import 语句
// ─────────────────────────────────────────────
export interface RemoveImportsResult {
  /** 删除的 import 语句/成员条数 */
  removed: number;
  /** 源码是否发生变化 */
  changed: boolean;
  /** 删除后的新源码（未变时与入参相同） */
  output: string;
}

function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Go import 形态：
 *   单声明 import "p" / import alias "p"（整行删）；
 *   块 import ( ... \t"p" \talias "p" ... )（删成员行；空块删壳）。 */
function removeGoImports(src: string, target: string): RemoveImportsResult {
  const body = src.replace(/\r\n/g, '\n');
  const lines = body.split('\n');
  const esc = escRe(target);
  // 单声明或块成员行：头部可带 import 前缀 / alias（含 `.` 点导入、`_` 空导入）；
  // 路径字符串后允许行尾注释
  const re = new RegExp(`^[\\t ]*(?:import\\s+)?(?:(?:\\w+|\\.)\\s+)?["']${esc}["']\\s*(?://.*)?$`);

  const stack: number[] = [];
  const blockStart = new Array<number>(lines.length).fill(-1);
  const remove = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    if (stack.length) blockStart[i] = stack[stack.length - 1];
    const t = lines[i].trim().replace(/\/\/.*$/, '');
    if (/^import\s*\(/.test(t)) {
      stack.push(i);
      continue;
    }
    if (/^\)/.test(t)) {
      stack.pop();
      continue;
    }
    // 注释行 / 空行跳过（块内注释需保留壳，稍后判定）
    if (!t || /^\*/.test(t)) continue;
    if (re.test(lines[i])) remove.add(i);
  }

  // 块壳折叠：删除运作了的块，若余下无非注释非空成员 → 连 `import (`、`)` 一起删
  if (remove.size) {
    const byBlock = new Map<number, number[]>();
    for (const i of remove) {
      const b = blockStart[i];
      if (b < 0) continue;
      if (!byBlock.has(b)) byBlock.set(b, []);
      byBlock.get(b)!.push(i);
    }
    for (const [b] of byBlock) {
      let depth = 0;
      let close = -1;
      for (let i = b; i < lines.length; i++) {
        const t = lines[i].trim().replace(/\/\/.*$/, '');
        if (/^import\s*\(/.test(t)) depth++;
        else if (/^\)/.test(t)) {
          depth--;
          if (depth === 0) {
            close = i;
            break;
          }
        }
      }
      if (close < 0) continue;
      let empty = true;
      for (let i = b + 1; i < close; i++) {
        if (remove.has(i)) continue;
        const t = lines[i].trim().replace(/\/\/.*$/, '');
        if (t && !/^\*/.test(t)) {
          empty = false;
          break;
        }
      }
      if (empty) {
        remove.add(b);
        remove.add(close);
      }
    }
  }

  const out = lines.filter((_, i) => !remove.has(i));
  const changed = out.length !== lines.length;
  return { removed: remove.size, changed, output: out.join('\n') };
}

/** TS/JS import 形态（语句级删除，s 标志支持跨行）：
 *   具名/混合/命名空间/默认 import、type import、副作用 import、
 *   re-export（export * / export {…} from）、CommonJS require。 */
function removeTsImports(src: string, target: string): RemoveImportsResult {
  const esc = escRe(target);
  const T = `["']${esc}["']`;
  const forms: RegExp[] = [
    // import def, { a, b } / import { a } / import * as ns  from 'T'
    new RegExp(`import\\s+(?:(?:type\\s+)?[\\w$]+(?:\\s*,\\s*)?)?(?:\\{[^}]*\\}|\\*\\s+as\\s+[\\w$]+)(?:\\s*,\\s*\\{[^}]*\\})?\\s*from\\s*${T}\\s*;?`, 'gs'),
    // import type { T } from 'x'
    new RegExp(`import\\s+type\\s*\\{[^}]*\\}\\s*from\\s*${T}\\s*;?`, 'gs'),
    // import type X from 'x'
    new RegExp(`import\\s+type\\s+[\\w$]+\\s+from\\s*${T}\\s*;?`, 'gs'),
    // import X from 'x'（纯默认）
    new RegExp(`import\\s+[\\w$]+\\s+from\\s*${T}\\s*;?`, 'gs'),
    // import 'x' / import type 'x'（副作用）
    new RegExp(`import(?:\\s+type)?\\s+${T}\\s*;?`, 'gs'),
    // export * from 'x'
    new RegExp(`export\\s+\\*\\s+from\\s*${T}\\s*;?`, 'gs'),
    // export { … } from 'x'
    new RegExp(`export\\s*\\{[^}]*\\}\\s*from\\s*${T}\\s*;?`, 'gs'),
    // const x = require('x') / const { a } = require('x')
    new RegExp(`(?:const|let|var)\\s+(?:\\{[^}]*\\}|[\\w$]+)\\s*=\\s*require\\s*\\(\\s*${T}\\s*\\)[^;]*;?`, 'gs'),
  ];

  const ranges: Array<[number, number]> = [];
  for (const re of forms) {
    re.lastIndex = 0;
    for (let m = re.exec(src); m !== null; m = re.exec(src)) {
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  // 合并重叠 / 相邻区间（同一语句被多个形态命中只删一次）
  const merged: Array<[number, number]> = [];
  for (const [s, e] of ranges) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1] + 1) {
      if (e > last[1]) last[1] = e;
    } else {
      merged.push([s, e]);
    }
  }

  const removed = merged.length;
  if (removed === 0) return { removed: 0, changed: false, output: src };

  let out = '';
  let last = 0;
  for (const [s, e] of merged) {
    out += src.slice(last, s);
    last = e;
  }
  out += src.slice(last);
  return { removed, changed: out !== src, output: out };
}

/** 单文件、单目标源的 import 删除。lang 由文件扩展名决定（executor 传入）。 */
export function removeImportsFromSource(src: string, target: string, lang: 'go' | 'ts'): RemoveImportsResult {
  return lang === 'go' ? removeGoImports(src, target) : removeTsImports(src, target);
}

// ─────────────────────────────────────────────
// 执行器：聚合 dead 清单 → 按文件分组 → 原子落盘
// ─────────────────────────────────────────────
export interface DeadImportRemoval {
  source: string;
  removed: number;
  changed: boolean;
}

export interface FileRemoval {
  file: string;
  lang: 'go' | 'ts';
  removals: DeadImportRemoval[];
  changed: boolean;
}

export interface RemoveDeadImportResult {
  files: FileRemoval[];
  files_changed: number;
  statements_removed: number;
}

function langOfFile(rel: string): 'go' | 'ts' | null {
  if (rel.endsWith('.go')) return 'go';
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(rel)) return 'ts';
  return null;
}

export function removeDeadImports(opts: {
  project_dir: string;
  dead: DeadDepCandidate[];
}): RemoveDeadImportResult {
  const proj = path.resolve(opts.project_dir);
  const toAbs = (f: string): string => (path.isAbsolute(f) ? path.resolve(f) : path.resolve(proj, f));

  // fileAbs → { lang, sources }
  const fileEntry = new Map<string, { lang: 'go' | 'ts'; sources: string[] }>();
  for (const d of opts.dead ?? []) {
    for (const f of d.files ?? []) {
      const lang = langOfFile(f);
      if (!lang) continue;
      const abs = toAbs(f);
      let en = fileEntry.get(abs);
      if (!en) {
        en = { lang, sources: [] };
        fileEntry.set(abs, en);
      }
      if (!en.sources.includes(d.source)) en.sources.push(d.source);
    }
  }

  // 原子性：预读全部源文件，任一读取失败 → 中止、一个都不写
  const sources = new Map<string, string>();
  for (const abs of fileEntry.keys()) {
    try {
      sources.set(abs, fs.readFileSync(abs, 'utf-8'));
    } catch (e) {
      throw new Error(`读取文件失败（原子性：未写任何文件）：${abs} — ${(e as Error).message}`);
    }
  }

  const filesOut: FileRemoval[] = [];
  let filesChanged = 0;
  let statementsRemoved = 0;

  for (const [abs, en] of fileEntry) {
    let src = sources.get(abs)!;
    const results: DeadImportRemoval[] = [];
    for (const source of en.sources) {
      const res = removeImportsFromSource(src, source, en.lang);
      results.push({ source, removed: res.removed, changed: res.changed });
      src = res.output;
    }
    const changed = results.some((r) => r.changed);
    if (changed) {
      fs.writeFileSync(abs, src, 'utf-8');
      filesChanged++;
    }
    for (const r of results) statementsRemoved += r.removed;
    filesOut.push({
      file: path.relative(proj, abs) || abs,
      lang: en.lang,
      removals: results,
      changed,
    });
  }

  return { files: filesOut, files_changed: filesChanged, statements_removed: statementsRemoved };
}