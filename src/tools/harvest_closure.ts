/**
 * harvest_closure —— 积木拎取闭包（Brick Harvest Phase 1）
 *
 * 给定一组种子文件，沿 import 边计算"把这块积木拎走必须连根带走的全部东西"：
 *   - internal：项目内传递闭包（importee 方向——积木依赖什么；不是谁在用它）
 *   - external：闭包全体文件的 package 级原始 import 三分类
 *       stdlib（语言标准库）/ third_party（三方库）/ unresolved（无法归类）
 *   - evidence：每个内部文件被谁、哪一行、哪条 import 语句带入（积木的"根须图"）
 *
 * 与 diff_impact（波及分析，importer 方向）正交：
 *   diff_impact 回答"改这里波及谁"，本工具回答"拎走它需要什么"。
 *
 * 数据源：<project_dir>/.design-canvas/cache.db（import_project 建立）
 *   - edges(kind='import')：已解析的文件级导入边（source=导入方，target=被导入方，
 *     节点 id = 缓存基准相对路径）
 *   - imports(kind='package')：未解析的原始包导入（Go 包路径 / npm 包 / Python 模块）
 *
 * include_callers=true 时把 importer 方向也纳入闭包（"连功能带生态一起端走"，
 * 拎服务层连它的调用方一起搬）；默认 false——纯积木只需要根须不需要用户。
 */

import path from 'node:path';
import { getDSL } from '../storage.js';
import { getProjectCacheDb, type Database } from '../db/db.js';
import { buildImportGraph } from './import_graph.js';

export interface HarvestClosureInput {
  /** 被分析项目的根目录（其下 .design-canvas/cache.db 是符号缓存） */
  project_dir: string;
  /** 种子文件（相对项目根或缓存基准的路径，或绝对路径） */
  files: string[];
  /** 可选：提供时用于 DSL 文件节点 id 映射（dsl_node_id） */
  feature?: string;
  /** true=importer 方向也纳入闭包（拎积木连调用方一起端走），默认 false */
  include_callers?: boolean;
  /** BFS 深度上限（默认 30；传递闭包天然有界，此参数防环与失控） */
  max_depth?: number;
}

export interface ClosureFile {
  /** 缓存基准相对路径 */
  path: string;
  /** 0=种子；n=经 n 跳 import 到达 */
  depth: number;
  /** 首达路径上的导入方（种子与 callers 侧文件可缺省） */
  imported_by?: string;
  /** 带入该文件的原始 import 语句（来自 imports 表） */
  import_source?: string;
  language: string;
  size_bytes: number;
  symbol_count: number;
  /** DSL 文件节点 id（提供 feature 且命中语义层时） */
  dsl_node_id?: string;
}

export interface ExternalDep {
  /** 原始 import source 串（如 "github.com/foo/bar" / "react" / "fmt"） */
  source: string;
  class: 'stdlib' | 'third_party' | 'unresolved';
  /** 闭包中有几个文件导入它 */
  imported_by_files: number;
}

export interface HarvestClosureResult {
  project_dir: string;
  seeds: string[];
  include_callers: boolean;
  /** 种子不在缓存中时提示（闭包仍按其余种子计算） */
  warnings: string[];
  /** 项目内传递闭包（含种子），按 depth 升序、path 字典序稳定排序 */
  internal_files: ClosureFile[];
  /** 闭包全体文件的 package 级依赖（去重，按 class+source 排序） */
  external: ExternalDep[];
  stats: {
    seed_count: number;
    internal_count: number;
    max_depth_reached: number;
    stdlib_count: number;
    third_party_count: number;
    unresolved_count: number;
  };
  message: string;
}

// ── 标准库判定表 ──────────────────────────────────────────────
// Go：首段含 "." 即三方（github.com / golang.org / gopkg.in …），否则标准库（fmt、strings…）。
// TS/JS：node: 前缀或 Node 内置模块名 → 标准库；其余（含 @scope/name）→ npm 三方。
// Python：常见标准库清单（尽力而为，未收录且无点号的按三方处理——宁可报三方也不吞依赖）。

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http',
  'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'timers',
  'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

const PY_STDLIB = new Set([
  'abc', 'argparse', 'asyncio', 'base64', 'bisect', 'calendar', 'cmath', 'collections',
  'configparser', 'contextlib', 'copy', 'csv', 'dataclasses', 'datetime', 'decimal',
  'difflib', 'email', 'enum', 'fractions', 'functools', 'glob', 'gzip', 'hashlib', 'heapq',
  'html', 'http', 'inspect', 'io', 'itertools', 'json', 'logging', 'math', 'mimetypes',
  'multiprocessing', 'os', 'pathlib', 'pickle', 'platform', 'pprint', 'queue', 'random',
  're', 'secrets', 'select', 'shutil', 'signal', 'socket', 'socketserver', 'sqlite3',
  'ssl', 'statistics', 'string', 'struct', 'subprocess', 'sys', 'tarfile', 'tempfile',
  'textwrap', 'threading', 'time', 'traceback', 'typing', 'unicodedata', 'urllib',
  'uuid', 'warnings', 'weakref', 'xml', 'zipfile', 'zoneinfo',
]);

function classifyPackageImport(source: string, language: string): ExternalDep['class'] {
  const s = source.trim();
  if (!s) return 'unresolved';
  const first = s.split('/')[0];
  if (language === 'go') {
    if (s === 'C') return 'stdlib'; // cgo 伪包
    return first.includes('.') ? 'third_party' : 'stdlib';
  }
  if (language === 'ts' || language === 'js' || language === 'tsx' || language === 'jsx') {
    if (s.startsWith('node:')) return 'stdlib';
    if (NODE_BUILTINS.has(first)) return 'stdlib';
    return 'third_party';
  }
  if (language === 'py' || language === 'python') {
    if (PY_STDLIB.has(first)) return 'stdlib';
    return 'third_party';
  }
  return 'unresolved';
}

/** 相对项目根归一化（接受相对或绝对路径，统一成 posix rel）——与 diff_impact 同规 */
function toRel(root: string, p: string): string {
  const abs = path.isAbsolute(p) ? p : path.join(root, p);
  return path.relative(root, abs).split(path.sep).join('/');
}

export function harvestClosure(input: HarvestClosureInput): HarvestClosureResult {
  const { project_dir, files, feature, include_callers = false, max_depth = 30 } = input;
  const root = path.resolve(project_dir);
  const warnings: string[] = [];

  // DSL 语义层映射（可选）：语义 path → DSL 文件节点 id
  const dsl = feature ? getDSL(feature) : undefined;
  if (feature && !dsl) {
    throw new Error(`feature "${feature}" 不存在`);
  }
  const semanticPathToNodeId = new Map<string, string>();
  for (const f of dsl?.semantic?.files ?? []) {
    if (f.path) semanticPathToNodeId.set(f.path, f.id);
  }

  let db: Database;
  try {
    db = getProjectCacheDb(root);
  } catch (e) {
    throw new Error(
      `无法打开缓存 ${path.join(root, '.design-canvas', 'cache.db')}：${(e as Error).message}。` +
        '请先对该项目运行 import_project 建立符号缓存。',
    );
  }

  // ── 种子路径解析：精确 → 去 src/ 前缀 → files 表多形式探测（与 diff_impact 同规）──
  const probeCachePath = (rel: string): string | undefined => {
    const candidates = rel.startsWith('src/') ? [rel, rel.slice(4)] : [rel];
    for (const c of candidates) {
      const hit = db.prepare('SELECT 1 FROM files WHERE path = ? LIMIT 1').get(c);
      if (hit) return c;
    }
    return undefined;
  };
  const seedRels = [...new Set(files.map((f) => toRel(root, f)))];
  const seedCachePaths: string[] = [];
  for (const rel of seedRels) {
    const hit = probeCachePath(rel);
    if (hit) seedCachePaths.push(hit);
    else warnings.push(`种子文件 ${rel} 不在缓存中（可能未同步或非受支持语言），已跳过。`);
  }

  // ── 文件级 import 邻接表（与 extract_contracts 共用 buildImportGraph，单一真相源）──
  // edges 表已解析边 ∪ 原始 imports 权威解析（Go 包路径/Python 模块不进 edges 表）
  const { importeeOf, importerOf, packageResolved } = buildImportGraph(db, root);

  // ── 闭包 BFS：importee 方向必走；include_callers 时 importer 方向也走 ──
  // 首达信息（depth / imported_by / import line）记 importee 侧；callers 侧只标 depth。
  interface Reach { depth: number; imported_by?: string; line?: number | null }
  const reached = new Map<string, Reach>();
  for (const s of seedCachePaths) reached.set(s, { depth: 0 });
  let frontier = [...seedCachePaths];
  for (let depth = 1; depth <= max_depth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const f of frontier) {
      const expand = (adj: Map<string, Array<{ to: string; line: number | null }>>, asCaller: boolean) => {
        for (const t of adj.get(f) || []) {
          if (reached.has(t.to)) continue;
          // importee 侧：记带入者（根须证据）；importer 侧：它是"使用者"而非"根须"，只标深度
          reached.set(t.to, asCaller ? { depth } : { depth, imported_by: f, line: t.line });
          next.push(t.to);
        }
      };
      expand(importeeOf, false);
      if (include_callers) expand(importerOf, true);
    }
    frontier = next;
  }

  // ── 文件元信息 + 符号数 ──
  const closurePaths = [...reached.keys()];
  const fileInfo = new Map<string, { language: string; size: number; symbol_count: number }>();
  const stmtFile = db.prepare('SELECT language, size FROM files WHERE path = ?');
  const stmtSym = db.prepare("SELECT COUNT(*) c FROM nodes WHERE file_path = ? AND kind != 'file'");
  for (const p of closurePaths) {
    const row = stmtFile.get(p) as { language: string; size: number } | undefined;
    const sym = stmtSym.get(p) as { c: number };
    fileInfo.set(p, { language: row?.language ?? 'unknown', size: row?.size ?? 0, symbol_count: sym.c });
  }

  // ── 原始 import 语句：闭包全体文件的 package 级依赖 + 内部文件的带入证据 ──
  const stmtImports = db.prepare('SELECT source, line, kind FROM imports WHERE file_path = ?');
  // 内部文件带入证据：imported_by + 该 import 行的原始 source 串
  const evidenceSource = new Map<string, Map<number, string>>(); // file → line → source
  const externalAgg = new Map<string, ExternalDep>();
  for (const p of closurePaths) {
    const rows = stmtImports.all(p) as Array<{ source: string; line: number; kind: string }>;
    let perFile = evidenceSource.get(p);
    if (!perFile) evidenceSource.set(p, (perFile = new Map()));
    for (const r of rows) {
      perFile.set(r.line, r.source);
      if (r.kind !== 'package') continue; // relative 已解析为内部闭包
      // 权威判定：该 package 导入若解析到项目内文件（Go 内部包 / Python 同包 sibling）
      // → 属内部闭包，不算外部依赖；解析不到才是真正的外部
      if (packageResolved.get(`${p}:${r.line}`)) continue;
      const lang = fileInfo.get(p)?.language ?? 'unknown';
      const cls = classifyPackageImport(r.source, lang);
      const cur = externalAgg.get(r.source);
      if (cur) cur.imported_by_files += 1;
      else externalAgg.set(r.source, { source: r.source, class: cls, imported_by_files: 1 });
    }
  }

  // ── 组装内部闭包清单 ──
  const internal_files: ClosureFile[] = closurePaths
    .map((p) => {
      const info = fileInfo.get(p)!;
      const reach = reached.get(p)!;
      const import_source =
        reach.imported_by !== undefined && reach.line != null
          ? evidenceSource.get(reach.imported_by)?.get(reach.line)
          : undefined;
      const cf: ClosureFile = {
        path: p,
        depth: reach.depth,
        language: info.language,
        size_bytes: info.size,
        symbol_count: info.symbol_count,
      };
      if (reach.depth > 0) {
        cf.imported_by = reach.imported_by;
        if (import_source) cf.import_source = import_source;
      }
      const dslId = semanticPathToNodeId.get(p);
      if (dslId) cf.dsl_node_id = dslId;
      return cf;
    })
    .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));

  const external = [...externalAgg.values()].sort(
    (a, b) => a.class.localeCompare(b.class) || a.source.localeCompare(b.source),
  );
  const stdlib = external.filter((e) => e.class === 'stdlib');
  const third = external.filter((e) => e.class === 'third_party');
  const unresolved = external.filter((e) => e.class === 'unresolved');
  const maxDepthReached = internal_files.reduce((m, f) => Math.max(m, f.depth), 0);

  const tpList = third.slice(0, 8).map((e) => e.source).join('、');
  const message =
    `拎取闭包：种子 ${seedCachePaths.length} 个 → 项目内 ${closurePaths.length} 个文件` +
    `（最深层 ${maxDepthReached}）+ 外部依赖 ${external.length} 项` +
    `（标准库 ${stdlib.length} / 三方 ${third.length} / 未归类 ${unresolved.length}）。` +
    (third.length > 0 ? `三方依赖：${tpList}${third.length > 8 ? ' 等' : ''}。` : '') +
    (warnings.length > 0 ? `注意：${warnings.join(' ')}` : '');

  return {
    project_dir: root,
    seeds: seedCachePaths,
    include_callers,
    warnings,
    internal_files,
    external,
    stats: {
      seed_count: seedCachePaths.length,
      internal_count: closurePaths.length,
      max_depth_reached: maxDepthReached,
      stdlib_count: stdlib.length,
      third_party_count: third.length,
      unresolved_count: unresolved.length,
    },
    message,
  };
}
