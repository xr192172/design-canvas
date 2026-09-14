/**
 * refs_text —— **粗层（文本级）引用反查**：不解析 AST 也能回答"谁引用了我"
 *
 * 为什么需要（2026-09-14 实测，296 文件项目）：
 *   - AST 全解析：**26.1ms/文件**（7726ms）
 *   - 文本级 import 反查：**0.02ms/文件**（6ms，0.1%）
 *   - 轻量提及扫描：**0.16ms/文件**（47ms，0.6%）
 * ⇒ "谁 import 我 / 谁提到我"根本不必付 AST 的价（便宜 500–1000 倍）。
 *   这是"双向摊开"（出边 + 入边）能成立的关键 —— 入边的信息不在本文件里，
 *   但它在**文本层**就能找到候选，再用 AST 只对候选做确认。
 *
 * ★ 精度纪律：本模块只产出**候选**（candidates），不是事实。
 *   `foo(` 可能是调用、可能是同名局部变量、可能在注释/字符串里 ⇒
 *   调用方必须标注 candidates / confirmed，**不允许把候选当命中的引用**。
 *
 * 纯文本扫描：不依赖 AST、不写任何文件。
 */

import fs from 'node:fs';
import path from 'node:path';

export interface TextRefHit {
  /** 相对项目根（posix） */
  file: string;
  /** 命中类型：importIn=文本上 import 了目标文件；mention=文本上提到了某个名字 */
  kind: 'importIn' | 'mention';
  /** 1-based 行号 */
  line: number;
  /** 命中片段（截断，供人复核） */
  snippet: string;
}

/** import/require 语句里的模块字串 */
const IMPORT_RE = /(?:from|require\s*\()\s*['"]([^'"]+)['"]/g;

/**
 * 生成"目标文件可能被写成的模块字串"的候选（不做路径解析，交给后面的 AST 确认）：
 * `src/a/b.ts` → `b`、`./b`、`../(任意级)/b`、`/b`、`b/index`、`./b/index` …
 * 命中"basename 相同"就算候选 —— 宁可多收候选，也不漏（后续按 AST 确认）。
 */
function specifierCandidates(rel: string): string[] {
  const noExt = rel.replace(/\.[a-z]+$/i, '');
  const base = path.posix.basename(noExt);
  const dir = path.posix.dirname(noExt);
  const out = new Set<string>([base, `/${base}`, `${base}/index`]);
  if (dir && dir !== '.') {
    const segs = dir.split('/');
    out.add(`${segs[segs.length - 1]}/${base}`); // 常见：同级/上一级目录名
  }
  return [...out];
}

/** 该文件是否是"值得扫的源码文件"（与 walkFiles 口径一致：跳过依赖/产物/测试夹具目录） */
const SKIP_DIR = new Set(['node_modules', 'dist', '.git', '.design-canvas', 'build', 'out', 'coverage']);
const SRC_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.go', '.py', '.java', '.rs', '.cs', '.php']);

/** 走查源码文件（相对路径，posix） */
export function walkSourceFiles(root: string, limit = 20000): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (out.length >= limit) return;
    let es: fs.Dirent[] = [];
    try {
      es = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      if (out.length >= limit) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name)) continue;
        walk(p);
      } else if (SRC_EXT.has(path.extname(e.name).toLowerCase())) {
        out.push(path.relative(root, p).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return out;
}

/**
 * ★ 一次扫描建"import 反查表"：`模块字串 basename → 谁 import 了它`。
 *
 * 为什么这样做而不是"每个目标文件扫一遍全仓"：目标文件多时后者是 O(目标×全仓) 次读；
 * 建表只读一遍（296 文件 ≈ 6–47ms），之后任意目标的入边查询都是内存查表 O(1)。
 * 这就是"粗层提及表"的最小可用形态（持久化版本见 docs/index-locality-design.md §9.3 C）。
 */
export function buildTextImportIndex(
  root: string,
  files: readonly string[],
): { importers: Map<string, string[]>; scanned: number; bytes: number } {
  const importers = new Map<string, string[]>();
  let scanned = 0;
  let bytes = 0;
  for (const rel of files) {
    let src: string;
    try {
      src = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    scanned++;
    bytes += src.length;
    if (!/from|require/.test(src)) continue;
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((m = IMPORT_RE.exec(src)) !== null) {
      const spec = m[1];
      const specBase = spec.replace(/^.*\//, '').replace(/\.(js|ts|tsx|mjs|cjs)$/i, '');
      if (seen.has(specBase)) continue;
      seen.add(specBase);
      const arr = importers.get(specBase);
      if (arr) arr.push(rel);
      else importers.set(specBase, [rel]);
    }
  }
  return { importers, scanned, bytes };
}

/** 目标文件的"模块字串 basename"候选（与 specifierCandidates 同源） */
export function importLookupKeys(targetRel: string): string[] {
  return specifierCandidates(targetRel).map((s) => s.replace(/^.*\//, ''));
}

/** 文本级反查：谁（文本上）import 了 `targetRel`？
 * @param files 待扫文件（相对路径）；调用方可用 `walkSourceFiles(root)` 全量扫（很便宜）
 */
export function scanTextImporters(
  root: string,
  targetRel: string,
  files: readonly string[],
): TextRefHit[] {
  const wanted = new Set(specifierCandidates(targetRel));
  const hits: TextRefHit[] = [];
  for (const rel of files) {
    if (rel === targetRel) continue;
    let src: string;
    try {
      src = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    if (!/from|require/.test(src)) continue; // 快速否定，省一次正则扫描
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(src)) !== null) {
      const spec = m[1];
      const specBase = spec.replace(/^.*\//, '').replace(/\.(js|ts|tsx|mjs|cjs)$/i, '');
      if (!wanted.has(specBase) && !wanted.has(spec)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      hits.push({ file: rel, kind: 'importIn', line, snippet: m[0].trim().slice(0, 120) });
      break; // 一个文件命中一次就够（候选集去重）
    }
  }
  return hits;
}

/**
 * 文本级提及扫描（更粗）：谁提到了 `name`？
 * 用于"这个符号还有哪些地方在用"的候选集；调用方必须按 AST 确认。
 */
export function scanTextMentions(
  root: string,
  name: string,
  files: readonly string[],
  opts: { limitPerFile?: number; maxFiles?: number } = {},
): TextRefHit[] {
  const limitPerFile = opts.limitPerFile ?? 3;
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  const hits: TextRefHit[] = [];
  for (const rel of files) {
    let src: string;
    try {
      src = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    if (!src.includes(name)) continue;
    const lines = src.split('\n');
    let n = 0;
    for (let i = 0; i < lines.length && n < limitPerFile; i++) {
      if (re.test(lines[i])) {
        hits.push({ file: rel, kind: 'mention', line: i + 1, snippet: lines[i].trim().slice(0, 120) });
        n++;
      }
    }
    if (opts.maxFiles && hits.length >= opts.maxFiles) break;
  }
  return hits;
}
