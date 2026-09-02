/**
 * watch_project —— 项目文件实时监听自动同步（路线图序号11）
 *
 * 监听目标项目目录，文件变更/新增/删除时实时增量同步到 cache.db：
 *   - 变更/新增 → syncFile（内部按 content_hash 增量，未变即 skipped）
 *   - 删除     → removeFile（清理 nodes/files/imports 行）
 *   - 批量收尾 → resolveCrossFileCalls（跨文件调用重解析，只处理 pending）
 *
 * 与 import_project 的关系：import_project 是"全量快照"，watch_project 是"持续保鲜"。
 * 二者共享 cache.db；watch_project 只更新缓存，不直接改 DSL（DSL 的实际/设计双文件
 * 更新由 S2 的调用方决定）。
 *
 * 过滤规则（防反馈循环 + 噪声）：
 *   - 忽略 .design-canvas/（cache.db / live / features 写入会触发 watcher，必须排除）
 *   - 忽略 node_modules/.git/vendor 等非源码目录（与 import_project 的 SKIP_DIRS 对齐）
 *   - 忽略非支持扩展名 / 测试生成物（与 import_project 的 SKIP_FILE_RE 对齐）
 *
 * 实现：Node 22 的 fs.watch({ recursive: true })。Windows/macOS 原生递归支持；
 * 若平台抛错（旧 Linux），降级为非递归 + 手动注册子目录。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Database } from '../db/db.js';
import { syncFile, removeFile, resolveCrossFileCalls, pruneDeletedFiles, toRelPath, type CrossFileResolveStats } from '../db/symbols.js';
import { isSupported } from './ts_kernel/index.js';

// ─────────────────────────────────────────────────────────────
// 过滤规则（与 import_project 对齐，另加 .design-canvas 防反馈循环）
// ─────────────────────────────────────────────────────────────

/** 忽略的目录名（任意层级命中即跳过整棵子树） */
const IGNORE_DIRS = new Set([
  '.design-canvas', 'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
  'vendor', '__pycache__', 'coverage', 'target', 'bin', 'obj',
  '.next', '.nuxt', '.venv', 'venv', '.idea', '.vscode', '.backup', 'scaffold',
  '.pytest_cache', '.mypy_cache', '.tox', 'egg-info',
]);

/** 忽略的文件名模式（测试/生成物 / 编辑器临时存取，非架构） */
const SKIP_FILE_RE = /(_test\.go$|\.test\.[tj]sx?$|\.spec\.[tj]sx?$|\.min\.js$|\.d\.ts$|\.gen\.[tj]sx?$|test_.*\.py$|.*_test\.py$|\.tmp$|\.temp$|\.crswap$|\.crdownload$|\.swp$|\.swo$|\.swx$|\.bak$|\.orig$|\.rej$|~$|^~)/;

/** 相对路径是否命中忽略目录（任一分段在 IGNORE_DIRS 即忽略） */
export function isIgnoredRel(rel: string): boolean {
  const segs = rel.split('/');
  return segs.some((s) => IGNORE_DIRS.has(s));
}

/** 文件是否应被同步（非忽略目录 + 支持扩展名 + 非测试生成物） */
export function shouldSyncRel(rel: string): boolean {
  if (isIgnoredRel(rel)) return false;
  if (!isSupported(path.posix.extname(rel))) return false;
  if (SKIP_FILE_RE.test(path.posix.basename(rel))) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────
// 单事件处理（纯逻辑，测试直接调用）
// ─────────────────────────────────────────────────────────────

export type WatchEventType = 'added' | 'changed' | 'deleted' | 'ignored';

export interface WatchEventResult {
  type: WatchEventType;
  rel: string;
  /** syncFile 的 node_count（增改时） */
  node_count?: number;
  error?: string;
}

/**
 * 处理一次文件事件。
 *  - 文件不存在 → deleted（removeFile）
 *  - 不应被同步 → ignored
 *  - 否则 syncFile 增量同步（内部 hash 未变即 skipped，仍返回 changed 但 node_count=0）
 */
export async function handleWatchEvent(
  db: Database,
  projectRoot: string,
  absPath: string,
): Promise<WatchEventResult> {
  const rel = toRelPath(projectRoot, absPath);
  if (!fs.existsSync(absPath)) {
    // 通过 existsSync 区分增改/删除：fs.watch 只给 rename/change，删除需现查
    removeFile(db, projectRoot, absPath);
    return { type: 'deleted', rel };
  }
  if (!shouldSyncRel(rel)) return { type: 'ignored', rel };
  try {
    const r = await syncFile(db, projectRoot, absPath);
    return { type: r.status === 'skipped' ? 'changed' : r.status === 'updated' ? 'changed' : 'ignored', rel, node_count: r.node_count };
  } catch (e) {
    return { type: 'ignored', rel, error: (e as Error).message };
  }
}

// ─────────────────────────────────────────────────────────────
// 批量冲刷（debounce 后合并事件）
// ─────────────────────────────────────────────────────────────

export interface WatchBatchSummary {
  changed: number;
  deleted: number;
  ignored: number;
  /** 变更/删除的文件相对路径列表 */
  files: string[];
  /** 跨文件调用重解析统计 */
  cross: { total: number; resolved: number; external: number; failed: number };
}

/** 对一批去重后的相对路径执行同步（增改=existsSync 判断），返回批量摘要 */
export async function flushBatch(
  db: Database,
  projectRoot: string,
  rels: string[],
): Promise<WatchBatchSummary> {
  const summary: WatchBatchSummary = { changed: 0, deleted: 0, ignored: 0, files: [], cross: { total: 0, resolved: 0, external: 0, failed: 0 } };
  const seen = new Set(rels.map((r) => r.split(path.sep).join('/')));
  for (const rel of seen) {
    const abs = path.join(projectRoot, rel);
    const res = await handleWatchEvent(db, projectRoot, abs);
    if (res.type === 'deleted') { summary.deleted++; summary.files.push(rel); }
    else if (res.type === 'changed') { summary.changed++; summary.files.push(rel); }
    else summary.ignored++;
  }
  // 批量收尾：跨文件调用重解析（只处理 pending，幂等）
  if (summary.changed + summary.deleted > 0) {
    summary.cross = resolveCrossFileCalls(db, projectRoot);
  }
  return summary;
}

// ─────────────────────────────────────────────────────────────
// 定期 reconcile 兜底（防 fs.watch 漏事件：目录级整树删除 / 事件合并丢失）
// ─────────────────────────────────────────────────────────────

export interface ReconcileSummary {
  /** 本次磁盘扫描到的应同步文件数 */
  scanned: number;
  /** 新增同步（磁盘有、库无，或 stat 变化） */
  changed: number;
  /** 库中已删除（磁盘消失） */
  deleted: number;
  /** 本次实际增改/删除的文件（相对项目根 posix），供下游（如 drift）按变更作用域精确算 */
  changed_files: string[];
  /** 跨文件调用重解析统计 */
  cross: CrossFileResolveStats;
}

/** 全量扫描项目目录，返回所有应同步的绝对路径（循环实现，避免深目录栈溢出） */
function scanSyncFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 目录被删/无权限，跳过
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = toRelPath(root, full);
      if (e.isDirectory()) {
        if (!isIgnoredRel(rel)) stack.push(full);
      } else if (e.isFile() && shouldSyncRel(rel)) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

/**
 * 定期兜底 reconcile：全量扫描磁盘 vs cache.db 状态，补齐 fs.watch 可能漏掉的事件。
 *   - 磁盘已消失的文件 → pruneDeletedFiles 清缓存（处理目录级整树删除）
 *   - stat（size/mtime）与库记录不一致 或 库中缺失 → sync 增量补齐（处理事件丢失）
 * 返回摘要。扫描成本 O(文件数)，仅 stat 不解析，适合低频（数十秒级）兜底。
 */
export async function reconcileProject(db: Database, projectRoot: string): Promise<ReconcileSummary> {
  const absFiles = scanSyncFiles(path.resolve(projectRoot));
  // 1. 删除：磁盘上已不存在的文件清缓存（含目录整树删除）；返回被清理的 rel 列表
  const deletedRels = pruneDeletedFiles(db, projectRoot, absFiles);

  // 2. 增改：与库记录的 stat 对比，找出磁盘上变化/新增的文件
  const rows = db.prepare('SELECT path, size, modified_at FROM files').all() as Array<{ path: string; size: number; modified_at: number }>;
  const dbStat = new Map(rows.map((r) => [r.path, { size: r.size, mtime: r.modified_at }]));
  const changedRels: string[] = [];
  for (const abs of absFiles) {
    const rel = toRelPath(projectRoot, abs);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      changedRels.push(rel); // 读不到 stat：让 flushBatch 按 existsSync 判删除
      continue;
    }
    const prev = dbStat.get(rel);
    if (!prev || prev.size !== st.size || prev.mtime !== Math.round(st.mtimeMs)) {
      changedRels.push(rel);
    }
  }

  // 3. 批量同步增改 + 跨文件重解析（复用 flushBatch 收尾）
  const batch = await flushBatch(db, projectRoot, changedRels);
  return {
    scanned: absFiles.length,
    changed: batch.changed,
    deleted: deletedRels.length,
    changed_files: [...new Set([...changedRels, ...deletedRels])],
    cross: batch.cross,
  };
}

// ─────────────────────────────────────────────────────────────
// 常驻监听（serve / CLI 用）
// ─────────────────────────────────────────────────────────────

export interface WatchProjectOptions {
  project_root: string;
  db: Database;
  /** 事件合并窗口（ms），默认 150 */
  debounce_ms?: number;
  /** 定期 reconcile 兜底间隔（ms）。>0 时周期性全量扫描，补齐 fs.watch 漏掉的事件；0=关闭 */
  reconcile_interval_ms?: number;
  /** 每批冲刷完成回调（供 serve 广播 SSE / 重建实际 DSL） */
  onChange?: (summary: WatchBatchSummary) => void;
  /** 每次 reconcile 完成回调 */
  onReconcile?: (summary: ReconcileSummary) => void;
  onError?: (err: Error) => void;
}

export interface WatchHandle {
  stop(): void;
  status(): { watching: boolean; project_root: string };
  /** 立即触发一次 reconcile 兜底（手动/测试用），返回摘要 */
  reconcileNow?(): Promise<ReconcileSummary>;
}

/**
 * 启动对项目目录的递归监听。
 * 事件先入 pending 去重，debounce 后整批 flushBatch。
 * 返回 stop() 句柄。
 */
export function watchProject(opts: WatchProjectOptions): WatchHandle {
  const root = path.resolve(opts.project_root);
  const db = opts.db;
  const debounceMs = opts.debounce_ms ?? 150;
  const reconcileMs = opts.reconcile_interval_ms ?? 0;
  const onChange = opts.onChange;
  const onReconcile = opts.onReconcile;
  const onError = opts.onError;

  const pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let reconcileTimer: NodeJS.Timeout | null = null;
  let reconciling = false;
  let reconcileAgain = false;
  let closed = false;

  const scheduleFlush = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void doFlush();
    }, debounceMs);
  };

  const doFlush = async (): Promise<void> => {
    if (closed || pending.size === 0) return;
    const rels = [...pending];
    pending.clear();
    try {
      const summary = await flushBatch(db, root, rels);
      if (onChange) onChange(summary);
    } catch (e) {
      // flushBatch 失败时将未处理的路径归还 pending，避免静默丢失文件变更事件
      for (const r of rels) pending.add(r);
      if (onError) onError(e as Error);
    }
  };

  /** 一次 reconcile：全量扫描补齐漏事件；运行中再次触发则排队补跑一次 */
  const doReconcile = async (): Promise<ReconcileSummary> => {
    if (closed || reconciling) {
      reconcileAgain = true;
      return { scanned: 0, changed: 0, deleted: 0, changed_files: [], cross: { total: 0, resolved: 0, external: 0, failed: 0 } };
    }
    reconciling = true;
    try {
      let summary = await reconcileProject(db, root);
      while (reconcileAgain) {
        reconcileAgain = false;
        summary = await reconcileProject(db, root);
      }
      if (onReconcile) onReconcile(summary);
      return summary;
    } catch (e) {
      if (onError) onError(e as Error);
      return { scanned: 0, changed: 0, deleted: 0, changed_files: [], cross: { total: 0, resolved: 0, external: 0, failed: 0 } };
    } finally {
      reconciling = false;
    }
  };

  /** 把一次 fs.watch 回调归一成相对路径并入 pending（忽略无关路径） */
  const enqueue = (filename: string | Buffer | null): void => {
    if (!filename) return;
    const rel = toRelPath(root, path.join(root, filename.toString()));
    if (!shouldSyncRel(rel)) return;
    pending.add(rel);
    scheduleFlush();
  };

  let watcher: fs.FSWatcher | null = null;
  const subWatchers: fs.FSWatcher[] = [];
  let restartTimer: NodeJS.Timeout | null = null;
  let restartDelay = 1000;
  const MAX_RESTART_DELAY = 30_000;

  /** 关闭全部 fs.watch 句柄（递归 + 非递归降级 both） */
  const tearDownWatchers = (): void => {
    if (watcher) {
      try { watcher.close(); } catch { /* 已损坏 */ }
      watcher = null;
    }
    for (const w of subWatchers) {
      try { w.close(); } catch { /* 已损坏 */ }
    }
    subWatchers.length = 0;
  };

  /**
   * fs.watch 的 'error' 处理（运行稳定性：防止 watch 崩溃以未捕获异常拖垮整个长驻 server，
   * 或 watcher 静默停摆）。做法：汇报 onError → 关掉坏句柄 → 延迟自动重建（指数退避，
   * 成功即重置；根目录长期消失时不忙转，由 reconcile 兜底保鲜）。
   */
  const handleWatcherError = (err: unknown): void => {
    if (closed) return;
    if (onError) onError(err instanceof Error ? err : new Error(String(err)));
    tearDownWatchers();
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      startWatcher();
    }, restartDelay);
    restartDelay = Math.min(restartDelay * 2, MAX_RESTART_DELAY);
  };

  /** 创建 fs.watch（recursive 首选，旧平台降级为子目录逐个监听）；每个句柄都挂 error 处理 */
  const startWatcher = (): void => {
    if (closed) return;
    try {
      const w = fs.watch(root, { recursive: true }, (_event, filename) => enqueue(filename));
      w.on('error', handleWatcherError);
      watcher = w;
      restartDelay = 1000; // 成功重建 → 退避重置
    } catch {
      // 旧平台不支持 recursive：降级为非递归 + 手动注册子目录
      watcher = null;
      for (const dir of walkDirs(root)) {
        try {
          const w = fs.watch(dir, (_event, filename) => enqueue(filename));
          w.on('error', handleWatcherError);
          subWatchers.push(w);
        } catch {
          /* 忽略不可监听目录 */
        }
      }
      restartDelay = 1000;
    }
  };
  startWatcher();

  // 定期 reconcile 兜底（低频，防漏事件）
  if (reconcileMs > 0) {
    reconcileTimer = setInterval(() => { void doReconcile(); }, reconcileMs);
  }

  return {
    stop(): void {
      closed = true;
      if (timer) clearTimeout(timer);
      if (reconcileTimer) clearInterval(reconcileTimer);
      reconcileTimer = null;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      tearDownWatchers();
    },
    status(): { watching: boolean; project_root: string } {
      return { watching: !closed, project_root: root };
    },
    reconcileNow: (): Promise<ReconcileSummary> => doReconcile(),
  };
}

/** 遍历项目子目录（非递归降级用）：返回应监听的目录绝对路径 */
function walkDirs(root: string): string[] {
  const out: string[] = [root];
  const relStack: string[] = [''];
  while (relStack.length > 0) {
    const rel = relStack.pop()!;
    const abs = path.join(root, rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (isIgnoredRel(childRel)) continue;
      out.push(path.join(root, childRel));
      relStack.push(childRel);
    }
  }
  return out;
}