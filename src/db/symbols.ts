/**
 * 符号索引写入路径：ts_kernel 解析结果 → cache.db（增量）
 *
 * 增量语义：
 *   - files.content_hash（sha1）未变 → 整个文件跳过（status='skipped'）
 *   - 解析失败不写 files 行 → 下次运行自动重试
 *   - 文件节点 UPSERT 不删除（保护指向它的 import 边），符号节点整批重插
 *
 * import 边：仅解析相对导入（'./foo' '../bar' → 项目内文件）；
 * 包导入（npm 包 / Go 包路径 / Python 包）v1 不建边。
 * 目标文件尚未同步时先建桩节点（INSERT OR IGNORE），其正式同步时
 * ON CONFLICT 更新回填——与同步顺序无关。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Database } from './db.js';
import { parseFileFull, isSupported } from '../tools/ts_kernel/index.js';

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

export type SyncStatus = 'updated' | 'skipped' | 'ignored' | 'failed';

export interface SyncFileResult {
  path: string;
  status: SyncStatus;
  node_count: number;
  edge_count: number;
  error?: string;
}

export interface SyncProjectResult {
  total: number;
  updated: number;
  skipped: number;
  ignored: number;
  failed: number;
  ms: number;
  results: SyncFileResult[];
}

export interface SymbolHit {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
}

export interface IndexStats {
  files: number;
  nodes: number;
  edges: number;
  last_indexed_at: number | null;
}

/** 相对导入解析时尝试的扩展名（TS/JS 风格省略扩展名） */
const IMPORT_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];

// ─────────────────────────────────────────────────────────────
// 路径与 hash
// ─────────────────────────────────────────────────────────────

/** 绝对路径 → 相对 projectRoot 的 posix 路径（节点/文件表的统一键） */
export function toRelPath(projectRoot: string, absPath: string): string {
  return path.relative(projectRoot, absPath).split(path.sep).join('/');
}

function contentHash(content: string): string {
  return crypto.createHash('sha1').update(content, 'utf-8').digest('hex');
}

function countLinesOf(content: string): number {
  let n = 1;
  for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) n++;
  return content.endsWith('\n') ? n - 1 : n;
}

/** 解析相对导入到项目内文件（posix relPath）；解析不到返回 null */
export function resolveImportTarget(projectRoot: string, fromRel: string, source: string): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), source));
  const candidates = [
    ...IMPORT_EXTS.map((e) => base + e),
    ...INDEX_FILES.map((f) => `${base}/${f}`),
  ];
  for (const c of candidates) {
    if (c.startsWith('..')) continue; // 不允许逃逸项目根
    if (fs.existsSync(path.join(projectRoot, c))) return c;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 单文件同步
// ─────────────────────────────────────────────────────────────

export async function syncFile(db: Database, projectRoot: string, absPath: string): Promise<SyncFileResult> {
  const rel = toRelPath(projectRoot, absPath);
  const fail = (error: string): SyncFileResult => ({ path: rel, status: 'failed', node_count: 0, edge_count: 0, error });

  let content: string;
  let stat: fs.Stats;
  try {
    content = fs.readFileSync(absPath, 'utf-8');
    stat = fs.statSync(absPath);
  } catch (e) {
    return fail((e as Error).message);
  }

  const hash = contentHash(content);
  const existing = db.prepare('SELECT content_hash FROM files WHERE path = ?').get(rel) as
    | { content_hash: string }
    | undefined;
  if (existing && existing.content_hash === hash) {
    return { path: rel, status: 'skipped', node_count: 0, edge_count: 0 };
  }

  const ext = path.extname(rel).slice(1).toLowerCase();
  const parsed = await parseFileFull(absPath, content);
  if (parsed.error) {
    // 不写 files 行：下次运行 hash 比对不到记录，自动重试
    return fail(parsed.error);
  }

  const now = Date.now();
  const lineCount = countLinesOf(content);
  const fileNodeId = rel;

  db.exec('BEGIN');
  try {
    // 1. 文件节点：UPSERT 不删除（保护指向它的 import 边不被级联带走）
    db.prepare(
      `INSERT INTO nodes(id, kind, name, qualified_name, file_path, language, start_line, end_line, parent, signature, docstring, updated_at)
       VALUES (?, 'file', ?, ?, ?, ?, 1, ?, NULL, NULL, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = 'file', name = excluded.name, language = excluded.language,
         start_line = 1, end_line = excluded.end_line, updated_at = excluded.updated_at`,
    ).run(fileNodeId, path.posix.basename(rel), rel, rel, ext, lineCount, now);

    // 2. 符号节点：整批删除重插
    db.prepare("DELETE FROM nodes WHERE file_path = ? AND kind != 'file'").run(rel);
    const insNode = db.prepare(
      `INSERT INTO nodes(id, kind, name, qualified_name, file_path, language, start_line, end_line, parent, signature, docstring, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    );
    const seenIds = new Set<string>();
    for (const s of parsed.symbols) {
      let id = `${rel}#${s.qualified_name}`;
      if (seenIds.has(id)) id = `${id}:L${s.start_line}`; // 文件内重名（如 TS 重载）
      seenIds.add(id);
      insNode.run(
        id, s.kind, s.name, s.qualified_name, rel, ext,
        s.start_line, s.end_line, s.parent ?? null, s.signature ?? null, now,
      );
    }

    // 3. import 边：按 source 整批重插；目标未同步时建桩节点
    db.prepare("DELETE FROM edges WHERE source = ? AND kind = 'import'").run(fileNodeId);
    const ensureStub = db.prepare(
      `INSERT OR IGNORE INTO nodes(id, kind, name, qualified_name, file_path, language, start_line, end_line, updated_at)
       VALUES (?, 'file', ?, ?, ?, '', 0, 0, ?)`,
    );
    const insEdge = db.prepare(
      'INSERT OR IGNORE INTO edges(source, target, kind, line, col, metadata) VALUES (?, ?, ?, ?, NULL, NULL)',
    );
    let edgeCount = 0;
    for (const imp of parsed.imports) {
      if (imp.kind !== 'relative') continue;
      const target = resolveImportTarget(projectRoot, rel, imp.source);
      if (!target) continue;
      ensureStub.run(target, path.posix.basename(target), target, target, now);
      insEdge.run(fileNodeId, target, 'import', imp.line);
      edgeCount++;
    }

    // 4. 原始 import 记录（全量种类：relative + package）
    //    import_project 缓存路径靠它重建依赖边——edges 表只有已解析的相对导入，
    //    Go 包路径 / Python 点分模块的原始 source 串只存在这里
    db.prepare('DELETE FROM imports WHERE file_path = ?').run(rel);
    const insImport = db.prepare('INSERT INTO imports(file_path, line, source, kind) VALUES (?, ?, ?, ?)');
    for (const imp of parsed.imports) {
      insImport.run(rel, imp.line, imp.source, imp.kind);
    }

    // 5. files 行
    db.prepare(
      `INSERT OR REPLACE INTO files(path, content_hash, language, size, modified_at, indexed_at, node_count, errors)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(rel, hash, ext, stat.size, Math.round(stat.mtimeMs), now, parsed.symbols.length);

    db.exec('COMMIT');
    return { path: rel, status: 'updated', node_count: parsed.symbols.length, edge_count: edgeCount };
  } catch (e) {
    db.exec('ROLLBACK');
    return fail((e as Error).message);
  }
}

// ─────────────────────────────────────────────────────────────
// 项目级批量同步 / 移除
// ─────────────────────────────────────────────────────────────

/** 顺序同步一组文件（解析是 CPU 活，v1 串行即可；规模大了再加并发池） */
export async function syncProject(
  db: Database,
  projectRoot: string,
  absPaths: string[],
): Promise<SyncProjectResult> {
  const t0 = Date.now();
  const results: SyncFileResult[] = [];
  for (const p of absPaths) {
    results.push(await syncFile(db, projectRoot, p));
  }
  const by = (s: SyncStatus) => results.filter((r) => r.status === s).length;
  return {
    total: results.length,
    updated: by('updated'),
    skipped: by('skipped'),
    ignored: by('ignored'),
    failed: by('failed'),
    ms: Date.now() - t0,
    results,
  };
}

/** 按相对路径删除一个文件的全部缓存行（nodes 级联清边与 FTS） */
function removeFileRel(db: Database, rel: string): void {
  db.prepare('DELETE FROM nodes WHERE file_path = ?').run(rel);
  db.prepare('DELETE FROM files WHERE path = ?').run(rel);
  db.prepare('DELETE FROM imports WHERE file_path = ?').run(rel);
}

/** 文件从项目删除时调用：清节点（级联清边与 FTS）+ files 行 + 原始 import 记录 */
export function removeFile(db: Database, projectRoot: string, absPath: string): void {
  removeFileRel(db, toRelPath(projectRoot, absPath));
}

/**
 * 删除侦测（轻量形态）：比对 files 表与本次全量扫描列表，
 * 清掉磁盘上已不存在的文件的缓存行。在每次 sync 时顺带做，
 * 不做 fs 监听（监听属序号 11，届时换 removeFile 实时触发）。
 *
 * absPaths 必须是【完整】扫描列表（max_files 截断之前），否则误删。
 * 只 prune 受支持扩展名的文件（与 sync 同域）——.md 等其他工具写入的
 * files 行不受 import_project 扫描列表影响，避免多工具共享缓存时互踩。
 * 返回被清理的相对路径列表。
 */
export function pruneDeletedFiles(db: Database, projectRoot: string, absPaths: string[]): string[] {
  const alive = new Set(absPaths.map((p) => toRelPath(projectRoot, p)));
  const rows = db.prepare('SELECT path FROM files').all() as Array<{ path: string }>;
  const dead = rows
    .map((r) => r.path)
    .filter((rel) => isSupported(path.posix.extname(rel)) && !alive.has(rel));
  if (dead.length === 0) return [];
  db.exec('BEGIN');
  try {
    for (const rel of dead) removeFileRel(db, rel);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return dead;
}

// ─────────────────────────────────────────────────────────────
// 查询
// ─────────────────────────────────────────────────────────────

export interface CachedSymbol {
  kind: string;
  name: string;
  qualified_name: string;
  start_line: number;
  signature: string | null;
}

export interface CachedImport {
  line: number;
  source: string;
  kind: 'relative' | 'package';
}

export interface CachedFileParse {
  line_count: number;
  symbols: CachedSymbol[];
  imports: CachedImport[];
}

/**
 * 读取单文件的缓存解析结果（import_project 缓存路径用）。
 * 文件未索引（未同步过 / 上次解析失败）返回 null。
 * 符号按 start_line 排序，与 kernel 文档序一致，保证 50 上限截断行为与全量解析相同。
 */
export function getFileParse(db: Database, relPath: string): CachedFileParse | null {
  const indexed = db.prepare('SELECT 1 x FROM files WHERE path = ?').get(relPath);
  if (!indexed) return null;
  const fileNode = db.prepare("SELECT end_line FROM nodes WHERE id = ? AND kind = 'file'").get(relPath) as
    | { end_line: number }
    | undefined;
  if (!fileNode) return null;
  const symbols = db
    .prepare(
      `SELECT kind, name, qualified_name, start_line, signature
       FROM nodes WHERE file_path = ? AND kind != 'file'
       ORDER BY start_line, id`,
    )
    .all(relPath) as unknown as CachedSymbol[];
  const imports = db
    .prepare('SELECT line, source, kind FROM imports WHERE file_path = ? ORDER BY line, source')
    .all(relPath) as unknown as CachedImport[];
  return { line_count: fileNode.end_line, symbols, imports };
}


/** FTS5 全文检索符号（trigram：中文/标识符子串均可；<3 字符直接返回空） */
export function searchSymbols(db: Database, query: string, limit = 20): SymbolHit[] {
  const q = query.trim();
  if (q.length < 3) return [];
  const phrase = `"${q.replace(/"/g, '""')}"`;
  const rows = db
    .prepare(
      `SELECT n.id, n.kind, n.name, n.qualified_name, n.file_path, n.start_line
       FROM nodes_fts f JOIN nodes n ON n.rowid = f.rowid
       WHERE nodes_fts MATCH ? AND n.kind != 'file'
       ORDER BY rank LIMIT ?`,
    )
    .all(phrase, limit) as unknown as SymbolHit[];
  return rows;
}

/** 索引概况（状态报告 / Hub 展示用） */
export function getIndexStats(db: Database): IndexStats {
  const files = db.prepare('SELECT COUNT(*) c FROM files').get() as { c: number };
  const nodes = db.prepare('SELECT COUNT(*) c FROM nodes').get() as { c: number };
  const edges = db.prepare('SELECT COUNT(*) c FROM edges').get() as { c: number };
  const last = db.prepare('SELECT MAX(indexed_at) m FROM files').get() as { m: number | null };
  return { files: files.c, nodes: nodes.c, edges: edges.c, last_indexed_at: last.m };
}
