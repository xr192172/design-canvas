/**
 * candidate_locator —— 候选定位（诊断流水线第 2 步）
 *
 * 拿 symptom_parser 的结构化产物去 cache.db 定位候选符号，按置信度分级：
 *   exact   = 符号名 / qualified_name 精确命中（最可信）
 *   file    = 报错位置 文件:行 定位到该文件的"所在符号"（栈顶最近一层）
 *   anchor  = 用户提供的线索（文件路径或符号名）
 *   fts     = FTS5 全文检索兜底（符号名/keywords 子串）
 *
 * 路径归一化：症状里的位置可能是绝对路径（含盘符）或相对路径；统一先解析成
 * 相对 project_dir 的 posix 路径，再按 精确 → 去 src/ 前缀 → 尾段 探测缓存命中。
 *
 * 只读 cache.db，不解析源码；缓存缺失时如实返回 warnings（由调用方决定降级）。
 */

import path from 'node:path';
import type { Database } from '../db/db.js';
import { searchSymbols } from '../db/symbols.js';
import type { Candidate, SymptomParsed } from './contract.js';

export interface LocateInput {
  project_dir: string;
  parsed: SymptomParsed;
  /** 用户已知线索：文件路径（相对/绝对）或符号名 */
  anchor?: string;
}

export interface LocateResult {
  candidates: Candidate[];
  warnings: string[];
}

const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|go|py|java|rs|rb|vue|svelte|css|scss|json)$/i;

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
}

// ─────────────────────────────────────────────────────────────
// 路径归一化
// ─────────────────────────────────────────────────────────────

/** 绝对路径 → 相对 project_dir；相对路径按原样（默认已相对项目根） */
function toCacheRel(root: string, file: string): string {
  if (path.isAbsolute(file)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    return rel.startsWith('..') ? file.split(path.sep).join('/') : rel;
  }
  return file.split(path.sep).join('/').replace(/^\.\//, '');
}

/** 多形态探测：精确 → 去 src/ 前缀 → 尾段；命中返回缓存中的 file_path */
function probeCachePath(db: Database, root: string, file: string): string | undefined {
  const rel = toCacheRel(root, file);
  const candidates = [rel, rel.replace(/^src\//, ''), rel.split('/').pop()].filter(Boolean) as string[];
  for (const c of candidates) {
    const hit = db.prepare('SELECT 1 FROM files WHERE path = ? LIMIT 1').get(c);
    if (hit) return c;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────
// 候选查询
// ─────────────────────────────────────────────────────────────

/** 按符号名精确查（先 qualified_name，再短名；取前 limit） */
function exactBySymbol(db: Database, name: string, limit = 5): NodeRow[] {
  return db
    .prepare(
      `SELECT id, kind, name, qualified_name, file_path, start_line
       FROM nodes WHERE (name = ? OR qualified_name = ?) AND kind != 'file'
       ORDER BY start_line, id LIMIT ?`,
    )
    .all(name, name, limit) as unknown as NodeRow[];
}

/** 定位 文件:行 的"所在符号"（start_line <= line 的最近一层；无行号取文件首个符号） */
function symbolAtLine(db: Database, cachePath: string, line?: number): NodeRow | undefined {
  const hit = db
    .prepare(
      "SELECT id, kind, name, qualified_name, file_path, start_line FROM nodes WHERE file_path = ? AND kind != 'file' ORDER BY start_line, id LIMIT 1",
    )
    .get(cachePath) as NodeRow | undefined;
  if (!hit) return undefined;
  if (line === undefined) return hit;
  const rows = db
    .prepare(
      `SELECT id, kind, name, qualified_name, file_path, start_line
       FROM nodes WHERE file_path = ? AND kind != 'file' AND start_line <= ?
       ORDER BY start_line DESC LIMIT 1`,
    )
    .all(cachePath, line) as unknown as NodeRow[];
  return rows[0];
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────

export function locateCandidates(db: Database, input: LocateInput): LocateResult {
  const { project_dir, parsed, anchor } = input;
  const root = path.resolve(project_dir);
  const warnings: string[] = [];
  const out = new Map<string, Candidate>();
  const upsert = (c: Candidate): void => {
    const key = `${c.qualified_name}@${c.file_path}:${c.start_line}`;
    const prev = out.get(key);
    if (!prev || c.score > prev.score) out.set(key, c);
  };

  // 0. 缓存是否可用的总闸（无缓存 = 无符号可定位，直接给警告）
  let cacheAlive = false;
  try {
    cacheAlive = (db.prepare('SELECT COUNT(*) c FROM nodes').get() as { c: number }).c > 0;
  } catch {
    cacheAlive = false;
  }
  if (!cacheAlive) {
    warnings.push(
      `目标项目尚未建立符号缓存（${root}/.design-canvas/cache.db）。请先对该项目运行 import_project 建立缓存，诊断定位才能精确到符号。`,
    );
    return { candidates: [], warnings };
  }

  // 1. 符号精确命中（优先：症状里提取的符号）
  for (const sym of parsed.symbols) {
    const base = sym.split('.').pop() as string;
    for (const r of exactBySymbol(db, base, 5)) {
      upsert({
        symbol: r.name,
        qualified_name: r.qualified_name,
        file_path: r.file_path,
        start_line: r.start_line,
        kind: r.kind,
        score: 1.0,
        source: 'exact',
      });
    }
  }

  // 2. FTS5 兜底检索（符号列表不足时用关键词）
  const ftsQueries = [...new Set([...parsed.symbols.map((s) => s.split('.').pop() as string), ...parsed.keywords])];
  for (const q of ftsQueries) {
    if (q.length < 3) continue;
    const hits = searchSymbols(db, q, 5);
    for (const h of hits) {
      upsert({
        symbol: h.name,
        qualified_name: h.qualified_name,
        file_path: h.file_path,
        start_line: h.start_line,
        kind: h.kind,
        score: h.name.toLowerCase() === q.toLowerCase() ? 0.8 : 0.5,
        source: 'fts',
      });
    }
  }

  // 3. 报错位置 文件:行 → 所在符号
  for (const loc of parsed.locations) {
    const cachePath = probeCachePath(db, root, loc.file);
    if (!cachePath) continue;
    const sym = symbolAtLine(db, cachePath, loc.line);
    upsert({
      symbol: sym?.name ?? path.posix.basename(cachePath),
      qualified_name: sym?.qualified_name ?? path.posix.basename(cachePath),
      file_path: cachePath,
      start_line: sym?.start_line ?? loc.line ?? 1,
      kind: sym?.kind ?? 'file',
      score: sym ? 0.9 : 0.7,
      source: 'file',
    });
  }

  // 4. 用户线索 anchor
  if (anchor) {
    const a = anchor.trim();
    if (SOURCE_EXT_RE.test(a)) {
      const cachePath = probeCachePath(db, root, a);
      if (cachePath) {
        upsert({
          symbol: path.posix.basename(cachePath),
          qualified_name: path.posix.basename(cachePath),
          file_path: cachePath,
          start_line: 1,
          kind: 'file',
          score: 0.75,
          source: 'anchor',
        });
      }
    } else {
      for (const r of exactBySymbol(db, a.split('.').pop() as string, 3)) {
        upsert({
          symbol: r.name,
          qualified_name: r.qualified_name,
          file_path: r.file_path,
          start_line: r.start_line,
          kind: r.kind,
          score: 0.85,
          source: 'anchor',
        });
      }
    }
  }

  const candidates = [...out.values()].sort(
    (a, b) => b.score - a.score || a.file_path.localeCompare(b.file_path) || a.start_line - b.start_line,
  );
  return { candidates, warnings };
}
