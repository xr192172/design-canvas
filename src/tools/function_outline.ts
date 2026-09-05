/**
 * function_outline —— 函数级大纲：从项目缓存（cache.db / import_cache_<feature>.db）汇聚
 * 「目录 → 文件 → 函数」三级函数树 + 每函数的调用/被谁调用/自递归。
 *
 * 定位：把 DSL/Archify 展示粒度扩充到函数级，像编辑器/编译器一样精确到函数。
 * 函数符号与调用边（kind='call'）已由 ts_kernel 提取并落进缓存（syncFile 写 nodes/edges，
 * resolveCrossFileCalls 做跨文件解析），本模块只做「汇聚成大纲」的纯函数，不重新解析代码。
 *
 * 缓存定位顺序（复用 overview.tryDeriveFeatureTree 同款）：
 *   import_cache_<feature>.db（dataHome） > <source_root>/.design-canvas/cache.db > cwd/.design-canvas/cache.db
 */
import path from 'node:path';
import fs from 'node:fs';
import { getStorageRoot } from '../storage.js';
import { openDb, type Database } from '../db/db.js';

export interface FuncCallRef {
  fn_id: string;
  name: string;
  file: string;
  line: number;
  cross: boolean;
}
export interface FunctionOutlineFn {
  id: string;
  name: string;
  kind: string;
  qualified_name: string;
  signature?: string;
  file: string;
  dir: string;
  start_line: number;
  end_line: number;
  calls: FuncCallRef[];
  called_by: FuncCallRef[];
  recursive: boolean;
}
export interface FunctionOutline {
  feature?: string;
  source_root?: string;
  db_file: string;
  generated_at: number;
  functions: FunctionOutlineFn[];
}

/** 节点 id → 符号名（"src/a.ts#Foo" → "Foo"） */
function symbolNameFromId(nodeId: string): string {
  const hash = nodeId.lastIndexOf('#');
  return hash === -1 ? nodeId : nodeId.slice(hash + 1);
}
/** 节点 id → 文件名（"src/a.ts#Foo" → "src/a.ts"；文件节点 id 即相对路径） */
function filePathFromId(nodeId: string): string {
  const hash = nodeId.lastIndexOf('#');
  return hash === -1 ? nodeId : nodeId.slice(0, hash);
}

/** 定位给定 feature / source_root 的缓存 db 文件（找不到返回 null）。偏好导入缓存 */
export function resolveFunctionCacheDb(feature?: string, sourceRoot?: string): string | null {
  const candidates: string[] = [
    feature ? path.join(getStorageRoot(), `import_cache_${feature}.db`) : '',
    sourceRoot ? path.join(sourceRoot, '.design-canvas', 'cache.db') : '',
    path.join(process.cwd(), '.design-canvas', 'cache.db'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}

/** 纯函数：从已打开的 db 汇聚函数级大纲。全量返回（不做函数截断——像编译器一样数据完整）。
 *  dir 可选：仅返回该目录下的函数（懒加载按目录查询，避免一次拉全量）。 */
export function queryFunctionOutline(db: Database, opts: { dir?: string } = {}): FunctionOutline {
  const dirFilter = opts.dir?.trim() ? opts.dir.trim() : undefined;

  // ① 函数/方法符号（排除局部闭包，避免契约面噪音）
  let fnRows: Array<{
    id: string; kind: string; name: string; qualified_name: string;
    file_path: string; start_line: number; end_line: number; signature: string | null;
  }>;
  try {
    // dir 过滤在 SQL 层做（目录查询只拉该目录行，省全量扫）——根目录(.) = 无斜杠的顶层文件
    // 用 ? 占位参数而非字符串拼接（SQLite 双引号当标识符，LIKE 需单引号/参数）
    const params: Array<string> = [];
    let extra = '';
    if (dirFilter === '.') { extra = " AND file_path NOT LIKE '%/%'"; }
    else if (dirFilter) { extra = ' AND file_path LIKE ?'; params.push(`${dirFilter}/%`); }
    fnRows = db
      .prepare(
        `SELECT id, kind, name, qualified_name, file_path, start_line, end_line, signature
         FROM nodes WHERE kind IN ('function','method') AND COALESCE(is_closure, 0) = 0${extra}
         ORDER BY file_path, start_line`,
      )
      .all(...params) as typeof fnRows;
  } catch {
    return { db_file: '', generated_at: Date.now(), functions: [] };
  }
  const fnIds = fnRows.map((r) => r.id);

  // ② 调用边（只取涉及这些函数符号的 call 边）
  let callRows: Array<{ source: string; target: string; line: number; metadata: string | null }> = [];
  if (fnIds.length) {
    const idset = new Set(fnIds);
    try {
      const rows = db.prepare(`SELECT source, target, line, metadata FROM edges WHERE kind = 'call'`).all() as typeof callRows;
      callRows = rows.filter((e) => idset.has(e.source) || idset.has(e.target));
    } catch {
      callRows = [];
    }
  }

  // ③ 汇聚每函数：calls（出）/ called_by（入）/ recursive
  const byId = new Map<string, FunctionOutlineFn>();
  const fnNameByFile = new Map<string, string>(); // id → name（组装 ref 用）
  const dirOf = new Map<string, string>(); // file_path → dir（posix）
  for (const r of fnRows) {
    const fp = path.posix.normalize(r.file_path.replace(/\\/g, '/'));
    dirOf.set(r.file_path, fp.includes('/') ? fp.split('/').slice(0, -1).join('/') || '.' : '.');
    fnNameByFile.set(r.id, r.name);
    byId.set(r.id, {
      id: r.id, name: r.name, kind: r.kind, qualified_name: r.qualified_name,
      signature: r.signature ?? undefined, file: fp,
      dir: dirOf.get(r.file_path) ?? '.', start_line: r.start_line, end_line: r.end_line,
      calls: [], called_by: [], recursive: false,
    });
  }

  const edgeRef = (n: string, line: number, cross: boolean): FuncCallRef => {
    const isFn = byId.has(n);
    return {
      fn_id: isFn ? n : n,
      name: isFn ? byId.get(n)!.name : symbolNameFromId(n),
      file: filePathFromId(n),
      line,
      cross,
    };
  };

  for (const e of callRows) {
    const dst = byId.get(e.target);
    const cross = e.metadata ? (JSON.parse(e.metadata) as { cross?: boolean }).cross ?? false : false;
    // target 是本函数符号 → 记入其 called_by
    if (dst) {
      const ref = edgeRef(e.source, e.line, cross);
      // 只保留"调用本函数的符号"里的调用者名（若调用者也解析到函数则用它真名）
      dst.called_by.push(ref);
    }
    // source 是本函数符号 → 记入其 calls
    const src = byId.get(e.source);
    if (src) {
      const ref = edgeRef(e.target, e.line, cross);
      src.calls.push(ref);
      if (ref.fn_id === src.id) src.recursive = true;
    }
  }

  let fns = [...byId.values()];
  if (dirFilter) fns = fns.filter((f) => (f.dir && f.dir !== '.' ? f.dir : '.') === dirFilter);

  return {
    db_file: '', // 调用方填
    generated_at: Date.now(),
    functions: fns,
  };
}

/** 目录统计：feature 下所有函数目录 + 各自文件数/函数数（懒加载首屏轻量清单，不含函数体） */
export function listFunctionDirs(feature?: string, sourceRoot?: string):
  { ok: boolean; dirs: Array<{ dir: string; files: number; fns: number }>; note?: string } {
  const res = withCacheDb(feature, sourceRoot, (db): Array<{ dir: string; files: number; fns: number }> => {
    let rows: Array<{ file_path: string }> = [];
    try {
      rows = db
        .prepare(`SELECT file_path FROM nodes WHERE kind IN ('function','method') AND COALESCE(is_closure, 0) = 0`)
        .all() as Array<{ file_path: string }>;
    } catch {
      return [];
    }
    const byDir = new Map<string, { files: Set<string>; fns: number }>();
    for (const r of rows) {
      const fp = path.posix.normalize(r.file_path.replace(/\\/g, '/'));
      const d = fp.includes('/') ? fp.split('/').slice(0, -1).join('/') : '.';
      if (!byDir.has(d)) byDir.set(d, { files: new Set(), fns: 0 });
      const b = byDir.get(d)!;
      b.files.add(fp.split('/').pop() || fp);
      b.fns += 1;
    }
    return [...byDir.entries()]
      .map(([dir, b]) => ({ dir, files: b.files.size, fns: b.fns }))
      .sort((a, b) => a.dir.localeCompare(b.dir));
  });
  if (!res.ok) return { ok: false, dirs: [], note: res.note };
  return { ok: true, dirs: res.data };
}

/** 打开缓存并执行 fn；缓存缺失/打不开时按 note 退化空结果。 */
function withCacheDb<T>(
  feature: string | undefined,
  sourceRoot: string | undefined,
  fn: (db: Database) => T,
): { ok: boolean; note?: string; data: T } {
  const dbFile = resolveFunctionCacheDb(feature, sourceRoot);
  if (!dbFile) {
    return { ok: false, note: '未找到项目缓存（cache.db / import_cache_*.db），请先运行 import_project 建立符号缓存', data: undefined as unknown as T };
  }
  let db;
  try {
    db = openDb(dbFile);
  } catch {
    return { ok: false, note: `缓存 ${dbFile} 无法打开`, data: undefined as unknown as T };
  }
  try {
    return { ok: true, data: fn(db) };
  } finally {
    try { db.close(); } catch { /* 已关 */ }
  }
}

/** 按 feature / source_root 定位缓存并输出大纲。dir 可选：懒加载只查该目录函数。 */
export function buildFunctionOutline(feature?: string, sourceRoot?: string, opts?: { dir?: string }):
  { ok: boolean; outline: FunctionOutline; note?: string } {
  const res = withCacheDb(feature, sourceRoot, (db) => {
    const outline = queryFunctionOutline(db, { dir: opts?.dir });
    return outline;
  });
  if (!res.ok) {
    return { ok: false, outline: { db_file: '', generated_at: Date.now(), functions: [] }, note: res.note };
  }
  const outline = res.data;
  const dbFile = resolveFunctionCacheDb(feature, sourceRoot);
  outline.db_file = dbFile ?? '';
  outline.feature = feature;
  outline.source_root = sourceRoot;
  return { ok: true, outline };
}