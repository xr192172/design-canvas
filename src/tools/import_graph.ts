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
  /** 导入方 → 被导入文件（拎取方向：根须）——全视图（值边 + type-only 相对边）。
   *  编译期语义：积木自包含要求类型文件随闭包走（tsc 需要） */
  importeeOf: Map<string, Array<{ to: string; line: number | null }>>;
  /** 值视图：只含值 import 边（运行时真实加载的模块集）。TS `import type`
   *  编译期擦除后运行时不存在——值可达 BFS 用这张图（ua_ignore_filter
   *  闭包 3→51 爆炸根因：type 边把 configs 全家拉进闭包后其值边继续展开，
   *  而这些模块运行时根本不加载） */
  importeeOfValue: Map<string, Array<{ to: string; line: number | null }>>;
  /** 被导入文件 → 导入方（波及方向：调用方） */
  importerOf: Map<string, Array<{ to: string; line: number | null }>>;
  /** 全部已索引文件 */
  files: FileEntry[];
  /** 原始 package 导入是否解析到项目内（`${file_path}:${line}` → true=内部） */
  packageResolved: Map<string, boolean>;
}

export function buildImportGraph(db: Database, root: string): ImportGraph {
  const importeeOf = new Map<string, Array<{ to: string; line: number | null }>>();
  const importeeOfValue = new Map<string, Array<{ to: string; line: number | null }>>();
  const importerOf = new Map<string, Array<{ to: string; line: number | null }>>();
  const addEdge = (src: string, dst: string, line: number | null, valueEdge: boolean): void => {
    let ie = importeeOf.get(src);
    if (!ie) importeeOf.set(src, (ie = []));
    if (!ie.some((x) => x.to === dst)) ie.push({ to: dst, line });
    if (valueEdge) {
      let ve = importeeOfValue.get(src);
      if (!ve) importeeOfValue.set(src, (ve = []));
      if (!ve.some((x) => x.to === dst)) ve.push({ to: dst, line });
    }
    let im = importerOf.get(dst);
    if (!im) importerOf.set(dst, (im = []));
    if (!im.some((x) => x.to === src)) im.push({ to: src, line });
  };

  // a) edges 表已解析边（import_project 写表时 type_only 已跳过——全是值边）
  const edgeRows = db
    .prepare("SELECT source, target, line FROM edges WHERE kind = 'import'")
    .all() as Array<{ source: string; target: string; line: number | null }>;
  for (const e of edgeRows) addEdge(e.source, e.target, e.line, true);

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
  const stmt = db.prepare('SELECT source, line, kind, type_only FROM imports WHERE file_path = ?');
  for (const f of files) {
    const rows = stmt.all(f.rel) as Array<{ source: string; line: number; kind: string; type_only: number }>;
    for (const r of rows) {
      // TS `import type` 语义分层（Phase 7 贫困编译验证 TS2307 实证修订）：
      //   运行时擦除——package 级不进外部依赖三分类（packageResolved 记 false，
      //   harvest_closure/dead_deps 的 type_only 跳过维持不变）
      //   编译期真实——相对导入仍建边：积木自包含要求类型文件随闭包走，
      //   否则 tsc 报 TS2307、拼装区缺类型
      if (r.type_only === 1) {
        packageResolved.set(`${f.rel}:${r.line}`, false);
        if (r.kind !== 'relative') continue; // 三方类型导入：不建边（运行时无依赖）
      }
      const imp: ParsedImport = { source: r.source, kind: r.kind as ParsedImport['kind'], line: r.line };
      const targets = resolveImport(imp, f, index, goModules);
      if (r.type_only !== 1) packageResolved.set(`${f.rel}:${r.line}`, targets.length > 0);
      for (const t of targets) addEdge(f.rel, t.rel, r.line, r.type_only !== 1);
    }
  }

  return { importeeOf, importeeOfValue, importerOf, files, packageResolved };
}
