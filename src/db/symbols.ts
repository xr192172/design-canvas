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
  call_count?: number;
  /** 符号级 diff 计数（v3）：updated 且非首次导入时给出；undefined=无对比意义 */
  symbol_diff?: { added: number; removed: number; changed: number };
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
  /** 跨文件调用解析统计（收尾步骤，见 resolveCrossFileCalls） */
  cross?: CrossFileResolveStats;
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

// ─────────────────────────────────────────────────────────────
// 符号级 hash 与 diff（v3：符号级影响分析数据源）
// ─────────────────────────────────────────────────────────────

/** 符号状态：added=新增 / removed=删除 / changed=span hash 变（实质变更） */
export type SymbolStatus = 'added' | 'removed' | 'changed';

/** 净差异合并（链式）：同一文件连续多次编辑未消费时，把 vA→vB 与 vB→vC 合成 vA→vC */
export function mergeSymbolStatus(
  a: SymbolStatus | undefined,
  b: SymbolStatus | undefined,
): SymbolStatus | undefined {
  if (!b) return a;
  if (!a) return b;
  if (a === 'added' && b === 'removed') return undefined; // 加了又删 → 净无
  if (a === 'added' && b === 'changed') return 'added'; // 相对 vA 仍是新增
  if (a === 'removed' && b === 'added') return 'changed'; // 删了又回 → 相对 vA 是变更
  return b; // 其余组合后状态即最新状态
}

/**
 * 符号 span 归一化 hash：取 [start_line, end_line] 文本，剔纯注释行后去除全部空白，sha1。
 * 注释 / 空行 / 缩进 / 单行↔多行重排均不改变 hash → 不计为"实质变更"，改注释或格式化
 * 不再虚报波及。v1 近似：整行块注释中间行（* 开头）剔除；py 仅剔 # 注释（docstring
 * 保守保留）；行内块注释（/* ... *\/ 同行夹代码）仍会计入变更。
 */
export function symbolSpanHash(lines: string[], startLine: number, endLine: number, lang: string): string {
  const isPy = lang === 'py' || lang === 'python';
  const commentRe = isPy ? /^\s*#/ : /^\s*(\/\/|\/\*|\*)/;
  const out: string[] = [];
  for (let i = Math.max(0, startLine - 1); i < Math.min(lines.length, endLine); i++) {
    const l = lines[i].trim();
    if (!l || commentRe.test(l)) continue;
    out.push(l);
  }
  return crypto.createHash('sha1').update(out.join('').replace(/\s+/g, ''), 'utf-8').digest('hex');
}

/** qualified_name → hash 集合（文件内重名如 TS 重载合并比较） */
function hashSetsOf(rows: Array<{ qualified_name: string; sym_hash: string | null }>): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const r of rows) {
    let set = m.get(r.qualified_name);
    if (!set) {
      set = new Set();
      m.set(r.qualified_name, set);
    }
    set.add(r.sym_hash ?? ''); // NULL（理论上 v3 后不再出现）按空串参与比较 → 判 changed
  }
  return m;
}

/** 解析相对导入到项目内文件（posix relPath）；解析不到返回 null */
export function resolveImportTarget(projectRoot: string, fromRel: string, source: string): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), source));
  const baseExt = path.posix.extname(base);
  const candidates: string[] = [];
  if (IMPORT_EXTS.includes(baseExt)) {
    // source 已带扩展名：优先原样（JS 项目），再 strip 扩展名重试（TS NodeNext 用 .js 引 .ts）
    candidates.push(base);
    const bare = base.slice(0, -baseExt.length);
    for (const e of IMPORT_EXTS) candidates.push(bare + e);
    for (const f of INDEX_FILES) candidates.push(`${bare}/${f}`);
  } else {
    for (const e of IMPORT_EXTS) candidates.push(base + e);
    for (const f of INDEX_FILES) candidates.push(`${base}/${f}`);
  }
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
  const existing = db.prepare('SELECT content_hash, norm_hash FROM files WHERE path = ?').get(rel) as
    | { content_hash: string; norm_hash: string | null }
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
  const lines = content.split('\n');

  // ── 符号级 diff（v3，事务外 CPU 计算）──
  // 删旧符号前读出旧 sym_hash 对比；与未消费的历史 diff 行链式合并（同一文件
  // 一个节流窗口内多次编辑 → 净差异 vA→vNow）。首次导入（无 files 行）不产出。
  const symHashList = parsed.symbols.map((s) => symbolSpanHash(lines, s.start_line, s.end_line, ext));
  // v4：全文归一化 hash——符号提取不含顶层 const/赋值表达式，常量值变更（FLAG=true→false）
  // 符号级零差异。norm 对比兜第二道判定：符号无差异且 norm 无差异才是纯注释/格式。
  const normHash = symbolSpanHash(lines, 1, lines.length, ext);
  const symbolDiff = (() => {
    if (!existing) return undefined;
    const oldSets = hashSetsOf(
      db
        .prepare("SELECT qualified_name, sym_hash FROM nodes WHERE file_path = ? AND kind != 'file'")
        .all(rel) as Array<{ qualified_name: string; sym_hash: string | null }>,
    );
    const newSets = new Map<string, Set<string>>();
    parsed.symbols.forEach((s, i) => {
      let set = newSets.get(s.qualified_name);
      if (!set) {
        set = new Set();
        newSets.set(s.qualified_name, set);
      }
      set.add(symHashList[i]);
    });
    const cur = new Map<string, SymbolStatus>();
    for (const [qn, hs] of newSets) {
      const old = oldSets.get(qn);
      if (!old) {
        cur.set(qn, 'added');
      } else if (old.size !== hs.size || [...hs].some((h) => !old.has(h))) {
        cur.set(qn, 'changed');
      }
    }
    for (const qn of oldSets.keys()) {
      if (!newSets.has(qn)) cur.set(qn, 'removed');
    }
    // 链式合并：上一份 diff 的 to_hash == 本次旧 content_hash → 无消费直连，合成净差异
    let from = existing.content_hash;
    let normFrom = existing.norm_hash ?? ''; // null（v4 前的旧行）= 未知 → 保守视为已变
    const stored = db
      .prepare('SELECT from_hash, to_hash, added, removed, changed, norm_from, norm_to FROM symbol_diffs WHERE file_path = ?')
      .get(rel) as
      | { from_hash: string; to_hash: string; added: string; removed: string; changed: string; norm_from: string; norm_to: string }
      | undefined;
    let net = cur;
    if (stored && stored.to_hash === existing.content_hash) {
      from = stored.from_hash;
      // norm 链式：起点链到最初版本的 norm_from（终点恒为新算的 normHash）
      if (stored.norm_from) normFrom = stored.norm_from;
      const prev = new Map<string, SymbolStatus>();
      for (const qn of JSON.parse(stored.added) as string[]) prev.set(qn, 'added');
      for (const qn of JSON.parse(stored.removed) as string[]) prev.set(qn, 'removed');
      for (const qn of JSON.parse(stored.changed) as string[]) prev.set(qn, 'changed');
      net = new Map<string, SymbolStatus>();
      for (const qn of new Set([...prev.keys(), ...cur.keys()])) {
        const m = mergeSymbolStatus(prev.get(qn), cur.get(qn));
        if (m) net.set(qn, m);
      }
    }
    const by = (st: SymbolStatus) => [...net.entries()].filter(([, s]) => s === st).map(([qn]) => qn).sort();
    return { from, added: by('added'), removed: by('removed'), changed: by('changed'), normFrom, normTo: normHash };
  })();

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

    // 2. 符号节点：整批删除重插。
    //    删除会经 edges.target 的 FK ON DELETE CASCADE 清掉【指向本文件符号的入边】
    //    （其他文件调用本文件，source 在外部文件）——这些边无法由本文件重解析恢复
    //    （对端的 unresolved_refs 已是 resolved，不会重试）。先备份，重插后还原。
    const backupInEdges = db
      .prepare(
        "SELECT source, target, kind, line, col, metadata FROM edges WHERE kind IN ('call','type_ref') AND target LIKE ? AND source NOT LIKE ?",
      )
      .all(`${rel}#%`, `${rel}#%`) as Array<{ source: string; target: string; kind: string; line: number; col: number | null; metadata: string | null }>;
    db.prepare("DELETE FROM nodes WHERE file_path = ? AND kind != 'file'").run(rel);
    const insNode = db.prepare(
      `INSERT INTO nodes(id, kind, name, qualified_name, file_path, language, start_line, end_line, parent, signature, docstring, sym_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    );
    const seenIds = new Set<string>();
    parsed.symbols.forEach((s, i) => {
      let id = `${rel}#${s.qualified_name}`;
      if (seenIds.has(id)) id = `${id}:L${s.start_line}`; // 文件内重名（如 TS 重载）
      seenIds.add(id);
      insNode.run(
        id, s.kind, s.name, s.qualified_name, rel, ext,
        s.start_line, s.end_line, s.parent ?? null, s.signature ?? null, symHashList[i], now,
      );
    });

    // 2.1 符号级 diff 落库（v3）：diffImpact 的波及源数据。首次导入 symbolDiff=undefined 不写
    if (symbolDiff) {
      db.prepare(
        `INSERT OR REPLACE INTO symbol_diffs(file_path, from_hash, to_hash, added, removed, changed, norm_from, norm_to, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        rel, symbolDiff.from, hash,
        JSON.stringify(symbolDiff.added), JSON.stringify(symbolDiff.removed), JSON.stringify(symbolDiff.changed),
        symbolDiff.normFrom, symbolDiff.normTo,
        now,
      );
    }

    // 2.5 还原入边：只还原 target 仍存在的（符号被删/改名的边任其正确消失）。
    //     FK 开启下 INSERT 会校验 target 存在性，必须先过滤否则整事务回滚。
    if (backupInEdges.length > 0) {
      const currentIds = new Set(
        (db.prepare("SELECT id FROM nodes WHERE file_path = ? AND kind != 'file'").all(rel) as Array<{ id: string }>).map((r) => r.id),
      );
      const insIn = db.prepare(
        'INSERT OR IGNORE INTO edges(source, target, kind, line, col, metadata) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const e of backupInEdges) {
        if (currentIds.has(e.target)) insIn.run(e.source, e.target, e.kind, e.line, e.col, e.metadata);
      }
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
      // TS `import type` 运行时擦除——不建 import 边（依赖图/闭包不算依赖）
      if (imp.type_only) continue;
      const target = resolveImportTarget(projectRoot, rel, imp.source);
      if (!target) continue;
      ensureStub.run(target, path.posix.basename(target), target, target, now);
      insEdge.run(fileNodeId, target, 'import', imp.line);
      edgeCount++;
    }

    // 3.5 调用边（同文件函数级，kind='call'；未解析的跨文件/外部调用进 unresolved_refs）
    db.prepare("DELETE FROM edges WHERE source LIKE ? AND kind = 'call'").run(`${rel}#%`);
    db.prepare("DELETE FROM unresolved_refs WHERE from_node_id LIKE ?").run(`${rel}#%`);
    const idOf = (qn: string) => `${rel}#${qn}`;
    // FK 防御：插边前校验两端 id 已在 nodes——符号提取器与调用边提取器的 qn
    // 算法曾不一致（FOREIGN KEY 炸整文件事务、符号零写入，2026-08-20
    // NodeSqliteAdapter.prepare.run 实证）。kernel v7 已对齐 qn，此处防御性
    // 兜底：坏边跳过，不再牵连整文件事务
    const nodeIdSet = new Set(
      (db.prepare('SELECT id FROM nodes WHERE file_path = ?').all(rel) as Array<{ id: string }>).map((r) => r.id),
    );
    const insCall = db.prepare(
      'INSERT OR IGNORE INTO edges(source, target, kind, line, col, metadata) VALUES (?, ?, \'call\', ?, NULL, NULL)',
    );
    const insUnresolved = db.prepare(
      `INSERT OR IGNORE INTO unresolved_refs(from_node_id, reference_name, reference_kind, line, col, file_path, language, status, name_tail)
       VALUES (?, ?, 'call', ?, 0, ?, ?, 'pending', ?)`,
    );
    let callCount = 0;
    for (const c of parsed.calls) {
      const srcId = idOf(c.caller);
      if (!nodeIdSet.has(srcId)) continue; // qn 漂移坏边：跳过不炸事务
      if (c.resolved && c.callee_qn && nodeIdSet.has(idOf(c.callee_qn))) {
        insCall.run(srcId, idOf(c.callee_qn), c.line);
        callCount++;
      } else {
        insUnresolved.run(srcId, c.callee_expr, c.line, rel, ext, c.callee);
      }
    }

    // 3.6 类型引用边（kind='type_ref'：引用者函数/类 → 被引用 interface/type/class 符号）。
    //     波及语义：改类型定义 → 引用者受影响。跨文件引用进 unresolved_refs，
    //     收尾 resolveCrossFileCalls 沿 imports 解析（目标限定 interface/type/class）。
    db.prepare("DELETE FROM edges WHERE source LIKE ? AND kind = 'type_ref'").run(`${rel}#%`);
    db.prepare(
      "DELETE FROM unresolved_refs WHERE from_node_id LIKE ? AND reference_kind = 'type_ref'",
    ).run(`${rel}#%`);
    const insTypeRef = db.prepare(
      "INSERT OR IGNORE INTO edges(source, target, kind, line, col, metadata) VALUES (?, ?, 'type_ref', ?, NULL, NULL)",
    );
    const insUnresolvedType = db.prepare(
      `INSERT OR IGNORE INTO unresolved_refs(from_node_id, reference_name, reference_kind, line, col, file_path, language, status, name_tail)
       VALUES (?, ?, 'type_ref', ?, 0, ?, ?, 'pending', ?)`,
    );
    for (const t of parsed.type_refs) {
      const srcId = idOf(t.referrer);
      if (!nodeIdSet.has(srcId)) continue; // 同上：qn 漂移坏边防御
      if (t.resolved && t.target_qn && nodeIdSet.has(idOf(t.target_qn))) {
        insTypeRef.run(srcId, idOf(t.target_qn), t.line);
      } else {
        insUnresolvedType.run(srcId, t.type_name, t.line, rel, ext, t.type_name);
      }
    }

    // 4. 原始 import 记录（全量种类：relative + package）
    //    import_project 缓存路径靠它重建依赖边——edges 表只有已解析的相对导入，
    //    Go 包路径 / Python 点分模块的原始 source 串只存在这里
    db.prepare('DELETE FROM imports WHERE file_path = ?').run(rel);
    const insImport = db.prepare('INSERT INTO imports(file_path, line, source, kind, type_only) VALUES (?, ?, ?, ?, ?)');
    for (const imp of parsed.imports) {
      insImport.run(rel, imp.line, imp.source, imp.kind, imp.type_only ? 1 : 0);
    }

    // 5. files 行
    db.prepare(
      `INSERT OR REPLACE INTO files(path, content_hash, language, size, modified_at, indexed_at, node_count, errors, norm_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(rel, hash, ext, stat.size, Math.round(stat.mtimeMs), now, parsed.symbols.length, normHash);

    db.exec('COMMIT');
    return {
      path: rel, status: 'updated', node_count: parsed.symbols.length, edge_count: edgeCount, call_count: callCount,
      symbol_diff: symbolDiff
        ? { added: symbolDiff.added.length, removed: symbolDiff.removed.length, changed: symbolDiff.changed.length }
        : undefined,
    };
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
  // 收尾：跨文件调用解析（同文件未命中的调用沿 imports 解析到目标文件符号；幂等，只处理 pending）
  const cross = resolveCrossFileCalls(db, projectRoot);
  return {
    total: results.length,
    updated: by('updated'),
    skipped: by('skipped'),
    ignored: by('ignored'),
    failed: by('failed'),
    ms: Date.now() - t0,
    results,
    cross: {
      total: cross.total,
      resolved: cross.resolved,
      external: cross.external,
      failed: cross.failed,
    },
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

// ─────────────────────────────────────────────────────────────
// 跨文件调用解析（路线图序号 3 第二步）
// ─────────────────────────────────────────────────────────────

/** 有点调用前缀：内置对象 / 内置模块 / 全局对象（外部，非项目符号） */
const BUILTIN_PREFIXES = new Set([
  'Math', 'JSON', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Promise', 'console', 'Date',
  'Set', 'Map', 'WeakMap', 'WeakSet', 'RegExp', 'Symbol', 'BigInt', 'globalThis', 'window',
  'document', 'navigator', 'URL', 'TextEncoder', 'TextDecoder', 'Buffer', 'process', 'require',
  'module', 'exports', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'Intl', 'performance', 'structuredClone',
  'queueMicrotask', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'undefined',
  'NaN', 'Infinity', 'os', 'path', 'fs', 'http', 'https', 'net', 'zlib', 'util', 'assert',
  'stream', 'events', 'crypto', 'child_process', 'url', 'querystring', 'dns', 'tls', 'buffer',
  'node', 'String', 'Number', 'Math',
  // Python 常用
  'os', 'sys', 're', 'json', 'datetime', 'pathlib', 'collections', 'typing', 'functools',
  'itertools', 'logging', 'random', 'time', 'socket', 'subprocess', 'threading', 'asyncio',
]);

/** 无点内置函数 / 构造器（外部，非项目符号） */
const BUILTIN_CALLEES = new Set([
  'String', 'Number', 'Boolean', 'Object', 'Array', 'Promise', 'Set', 'Map', 'Date', 'Math',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'RegExp', 'Symbol',
  'BigInt', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'typeof', 'instanceof',
  // Python 内置
  'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple', 'bool',
  'type', 'isinstance', 'sum', 'min', 'max', 'sorted', 'enumerate', 'zip', 'map', 'filter',
  'open', 'repr', 'abs', 'round', 'any', 'all', 'next', 'iter', 'hasattr', 'getattr',
  'ValueError', 'KeyError', 'Exception',
]);

export interface CrossFileResolveStats {
  total: number;
  /** import 限定解析成功，已写 edges(kind=call, cross) */
  resolved: number;
  /** 内置 / 外部 / 局部变量调用，标 status='external' */
  external: number;
  /** 未匹配到目标符号，标 status='failed'（不再重试） */
  failed: number;
}

/**
 * 跨文件引用解析（call + type_ref）：把 unresolved_refs 里同文件未命中的引用解析到目标文件符号。
 * type_ref：type_name 沿 relative imports 定位目标文件的 interface/type/class 符号；
 * 内置类型（string/Record 等）→ external。其余策略同 call。
 *
 * 策略（v1，保守防误连）：
 *   - 无点调用：内置黑名单 → external；否则沿本文件 relative imports 定位目标文件，
 *     目标文件符号表含 callee → 写 edges(kind='call', metadata.cross=true)
 *   - 有点调用：前缀黑名单（内置对象/模块）→ external；其余前缀（局部变量/Go 包调用）
 *     保守标 external——v1 不做别名/包路径映射，避免误连
 *   - 找不到目标的真项目调用 → failed（不再每轮重试）
 *
 * 幂等：只处理 status='pending' 的行；syncProject 全量同步后调用（跨文件匹配需要全库符号表）。
 */
export function resolveCrossFileCalls(db: Database, projectRoot: string): CrossFileResolveStats {
  const rows = db
    .prepare(
      "SELECT id, from_node_id, reference_name, reference_kind, line FROM unresolved_refs WHERE status='pending' AND reference_kind IN ('call','type_ref')",
    )
    .all() as Array<{ id: number; from_node_id: string; reference_name: string; reference_kind: string; line: number }>;
  if (rows.length === 0) return { total: 0, resolved: 0, external: 0, failed: 0 };

  // 预加载：文件名 → 符号名集合（import 限定匹配用）
  const symbolsByFile = new Map<string, Set<string>>();
  for (const s of db.prepare("SELECT name, file_path FROM nodes WHERE kind != 'file'").all() as Array<{ name: string; file_path: string }>) {
    let set = symbolsByFile.get(s.file_path);
    if (!set) {
      set = new Set();
      symbolsByFile.set(s.file_path, set);
    }
    set.add(s.name);
  }
  // 预加载：文件 → 类型符号名集合（type_ref 目标限定 interface/type/class）
  const typeNamesByFile = new Map<string, Set<string>>();
  for (const s of db.prepare("SELECT name, file_path FROM nodes WHERE kind IN ('interface','type','class')").all() as Array<{ name: string; file_path: string }>) {
    let set = typeNamesByFile.get(s.file_path);
    if (!set) {
      set = new Set();
      typeNamesByFile.set(s.file_path, set);
    }
    set.add(s.name);
  }
  // 预加载：文件 → relative imports
  const relImportsByFile = new Map<string, Array<{ source: string; line: number }>>();
  for (const i of db.prepare("SELECT file_path, source, line FROM imports WHERE kind='relative'").all() as Array<{ file_path: string; source: string; line: number }>) {
    let arr = relImportsByFile.get(i.file_path);
    if (!arr) {
      arr = [];
      relImportsByFile.set(i.file_path, arr);
    }
    arr.push(i);
  }

  const updResolved = db.prepare("UPDATE unresolved_refs SET status='resolved' WHERE id = ?");
  const updExternal = db.prepare("UPDATE unresolved_refs SET status='external' WHERE id = ?");
  const updFailed = db.prepare("UPDATE unresolved_refs SET status='failed' WHERE id = ?");
  const insEdge = db.prepare(
    'INSERT OR IGNORE INTO edges(source, target, kind, line, col, metadata) VALUES (?, ?, ?, ?, NULL, ?)',
  );
  const CROSS_META = JSON.stringify({ cross: true });

  const stats: CrossFileResolveStats = { total: rows.length, resolved: 0, external: 0, failed: 0 };
  for (const r of rows) {
    const rel = r.from_node_id.split('#')[0];
    const expr = r.reference_name;
    const kind = r.reference_kind as 'call' | 'type_ref';

    if (kind === 'type_ref') {
      if (BUILTIN_TYPES.has(expr)) {
        updExternal.run(r.id);
        stats.external++;
        continue;
      }
      const t = findCrossFileTarget(db, relImportsByFile, projectRoot, rel, expr, typeNamesByFile);
      if (t) {
        insEdge.run(r.from_node_id, `${t.file}#${t.qn}`, 'type_ref', r.line, CROSS_META);
        updResolved.run(r.id);
        stats.resolved++;
      } else {
        updFailed.run(r.id);
        stats.failed++;
      }
      continue;
    }

    if (expr.includes('.')) {
      // 有点调用：内置前缀 external；其余（局部变量/Go 包调用）保守 external
      updExternal.run(r.id);
      stats.external++;
      continue;
    }

    if (BUILTIN_CALLEES.has(expr)) {
      updExternal.run(r.id);
      stats.external++;
      continue;
    }

    // 无点调用：沿 relative imports 定位目标文件，符号表命中即解析
    const target = findCrossFileTarget(db, relImportsByFile, projectRoot, rel, expr, symbolsByFile);
    if (target) {
      insEdge.run(r.from_node_id, `${target.file}#${target.qn}`, 'call', r.line, CROSS_META);
      updResolved.run(r.id);
      stats.resolved++;
    } else {
      updFailed.run(r.id);
      stats.failed++;
    }
  }
  return stats;
}

/** TS/JS 内置与全局常见类型（type_ref 解析黑名单，external 不建边） */
const BUILTIN_TYPES = new Set([
  'string', 'number', 'boolean', 'void', 'any', 'unknown', 'never', 'object', 'symbol', 'bigint',
  'null', 'undefined', 'readonly', 'Array', 'Record', 'Partial', 'Required', 'Readonly', 'Pick',
  'Omit', 'Exclude', 'Extract', 'NonNullable', 'ReturnType', 'Parameters', 'Awaited', 'Promise',
  'Function', 'Error', 'Date', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Iterable',
  'IterableIterator', 'Generator', 'AsyncGenerator', 'HTMLElement', 'Event', 'Node',
]);

/** 沿源文件的 relative imports 找符号对应的目标符号（首个命中）；找不到返回 null。
 *  namesByFile：候选符号名集合（call=全符号表，type_ref=仅 interface/type/class） */
function findCrossFileTarget(
  db: Database,
  relImportsByFile: Map<string, Array<{ source: string; line: number }>>,
  projectRoot: string,
  fromRel: string,
  name: string,
  namesByFile: Map<string, Set<string>>,
): { file: string; qn: string } | null {
  const imports = relImportsByFile.get(fromRel);
  if (!imports) return null;
  const seen = new Set<string>();
  for (const imp of imports) {
    const target = resolveImportTarget(projectRoot, fromRel, imp.source);
    if (!target || seen.has(target)) continue;
    seen.add(target);
    const syms = namesByFile.get(target);
    if (syms && syms.has(name)) {
      // 目标文件确有该符号 → 取 qualified_name（重名取首个，v1 近似）
      const q = db
        .prepare('SELECT qualified_name FROM nodes WHERE file_path = ? AND name = ? LIMIT 1')
        .get(target, name) as { qualified_name: string } | undefined;
      if (q) return { file: target, qn: q.qualified_name };
    }
  }
  return null;
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
  end_line: number;
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
      `SELECT kind, name, qualified_name, start_line, end_line, signature
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