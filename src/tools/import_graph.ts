/**
 * import_graph —— 文件级依赖图共享构建器
 *
 * 从 cache.db 构建文件级 import 邻接表，供 harvest_closure（拎取闭包）与
 * extract_contracts（契约提取 role 判定）共用，保证两工具看到同一张依赖图。
 *
 * 数据源并集（与 harvest_closure v2 相同）：
 *   a) edges 表 kind='import'：已解析的 TS 相对导入边
 *   b) imports 表原始记录经 resolveImport 权威解析（Go 包路径 / Python 点分模块
 *      不进 edges 表，必须重走与 import_project 相同的解析规则）
 */

import path from 'node:path';
import type { Database } from '../db/db.js';
import { resolveImport, readGoModules, buildIndex, type FileEntry } from './import_project.js';
import type { ParsedImport } from './ts_kernel/kernel.js';

export interface ImportGraph {
  /** 导入方 → 被导入文件（拎取方向：根须） */
  importeeOf: Map<string, Array<{ to: string; line: number | null }>>;
  /** 被导入文件 → 导入方（波及方向：调用方） */
  importerOf: Map<string, Array<{ to: string; line: number | null }>>;
  /** 全部已索引文件 */
  files: FileEntry[];
  /** 原始 package 导入是否解析到项目内（`${file_path}:${line}` → true=内部） */
  packageResolved: Map<string, boolean>;
}

export function buildImportGraph(db: Database, root: string): ImportGraph {
  const importeeOf = new Map<string, Array<{ to: string; line: number | null }>>();
  const importerOf = new Map<string, Array<{ to: string; line: number | null }>>();
  const addEdge = (src: string, dst: string, line: number | null): void => {
    let ie = importeeOf.get(src);
    if (!ie) importeeOf.set(src, (ie = []));
    if (!ie.some((x) => x.to === dst)) ie.push({ to: dst, line });
    let im = importerOf.get(dst);
    if (!im) importerOf.set(dst, (im = []));
    if (!im.some((x) => x.to === src)) im.push({ to: src, line });
  };

  // a) edges 表已解析边
  const edgeRows = db
    .prepare("SELECT source, target, line FROM edges WHERE kind = 'import'")
    .all() as Array<{ source: string; target: string; line: number | null }>;
  for (const e of edgeRows) addEdge(e.source, e.target, e.line);

  // b) 原始 imports 权威解析
  const allFileRows = db.prepare('SELECT path FROM files').all() as Array<{ path: string }>;
  const files: FileEntry[] = allFileRows.map((r) => ({
    rel: r.path,
    abs: path.join(root, r.path),
    ext: path.posix.extname(r.path),
    dir: path.posix.dirname(r.path),
  }));
  const index = buildIndex(files);
  const goModules = readGoModules(root);
  const packageResolved = new Map<string, boolean>();
  const stmt = db.prepare('SELECT source, line, kind FROM imports WHERE file_path = ?');
  for (const f of files) {
    const rows = stmt.all(f.rel) as Array<{ source: string; line: number; kind: string }>;
    for (const r of rows) {
      const imp: ParsedImport = { source: r.source, kind: r.kind as ParsedImport['kind'], line: r.line };
      const targets = resolveImport(imp, f, index, goModules);
      packageResolved.set(`${f.rel}:${r.line}`, targets.length > 0);
      for (const t of targets) addEdge(f.rel, t.rel, r.line);
    }
  }

  return { importeeOf, importerOf, files, packageResolved };
}
