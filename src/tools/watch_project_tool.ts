/**
 * watch_project MCP 工具 —— 项目文件实时监听自动同步（路线图序号11，S3）
 *
 * 在 MCP 长进程内启动对目标项目目录的常驻监听，文件变更/新增/删除时：
 *   1. 增量同步到 cache.db（watch_project 核心，内部按 content_hash 增量）
 *   2. 可选 rebuild：按 feature 重建"实际 DSL"到 live/（saveLiveFeature，不覆盖设计 DSL）
 *
 * 工具是"一次性请求"，但 watcher 是常驻后台任务。因此按 project_dir 维护注册表：
 *   - action=start（默认）/ status / stop 三态，便于 LLM 启动后查询、停止
 *   - 同一 project_dir 重复 start → 幂等（返回既有句柄，不重复监听）
 *
 * 与 serve 的关系：serve 用自己的实例广播 SSE；本工具是 MCP 侧独立入口，
 * 供 LLM 在交互中直接开启"项目保鲜"，两者共享 cache.db 与 live/ 目录。
 */

import path from 'node:path';
import { getProjectCacheDb } from '../db/db.js';
import { importProject } from './import_project.js';
import { watchProject, type WatchHandle, type WatchBatchSummary, type ReconcileSummary } from './watch_project.js';

// ─────────────────────────────────────────────────────────────
// rebuild 节流器（纯逻辑，可注入 timer 测试）
// ─────────────────────────────────────────────────────────────

export interface RebuildThrottleOptions {
  /** 冷却窗口（ms）：窗口内的连续 trigger 合并为一次 rebuild */
  windowMs: number;
  /** 实际执行重建（async） */
  run: () => Promise<void>;
  /** 可注入定时器（测试假时钟）；默认 setTimeout/clearTimeout */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
}

export interface RebuildThrottler {
  /** 文件变更时调用：合并到冷却窗口末尾，窗口内多次触发只重建一次 */
  trigger(): void;
  /** 立即执行并等待完成（stop / 测试冲刷用） */
  flush(): Promise<void>;
  /** 是否有待执行的定时器或正在运行 */
  pending(): boolean;
}

/**
 * 尾随 debounce + 防并发 的 rebuild 节流器。
 *  - 连续 trigger 重设定时器 → 冷却窗口内合并为一次。
 *  - run 进行中又有 trigger → 置 pending，完成后补跑一次（不丢最新变更）。
 *  - flush 立即执行并等待本次（含排队中的一次）完成（stop 时冲刷未落库变更）。
 */
export function createRebuildThrottler(opts: RebuildThrottleOptions): RebuildThrottler {
  const setTimer = opts.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimeout ?? ((id: unknown) => clearTimeout(id as NodeJS.Timeout));
  let timer: unknown = null;
  let running = false;
  let pending = false;
  let current: Promise<void> = Promise.resolve();

  const runOnce = (): Promise<void> => {
    return opts.run().catch(() => { /* 调用方已记录 error */ });
  };

  /** 执行一次 rebuild + 循环补跑期间积累的 pending，直到静止 */
  const drain = (): Promise<void> => {
    const p = current.then(async () => {
      running = true;
      try {
        do {
          pending = false;
          await runOnce();
        } while (pending);
      } finally {
        running = false;
      }
    });
    current = p.then(() => undefined, () => undefined);
    return p;
  };

  const doRun = (): void => {
    if (running) {
      pending = true; // 运行中又触发：排队补跑
      return;
    }
    void drain();
  };

  const schedule = (): void => {
    if (running) {
      // run 进行中收到变更：标记 pending，run 完成后补跑一次（不丢最新变更）
      pending = true;
      return;
    }
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      doRun();
    }, opts.windowMs);
  };

  return {
    trigger: schedule,
    flush: async (): Promise<void> => {
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
      pending = true; // 保证至少执行一次
      await drain();
    },
    pending: (): boolean => timer !== null || running,
  };
}

// ─────────────────────────────────────────────────────────────
// 注册表（MCP 长进程内按 project_dir 复用）
// ─────────────────────────────────────────────────────────────

interface ActiveWatch {
  project_dir: string;
  feature?: string;
  rebuild: boolean;
  started_at: string;
  last_change_at?: string;
  last_rebuild_at?: string;
  last_summary?: WatchBatchSummary;
  last_reconcile?: ReconcileSummary;
  error?: string;
  handle?: WatchHandle;
  throttle?: RebuildThrottler;
}

const active = new Map<string, ActiveWatch>();

/** 归一化 project_dir 作注册表键 */
function keyOf(projectDir: string): string {
  return path.resolve(projectDir);
}

// ─────────────────────────────────────────────────────────────
// 工具入参/出参
// ─────────────────────────────────────────────────────────────

export interface WatchProjectToolInput {
  /** 被监听项目根目录（绝对路径或相对 cwd） */
  project_dir: string;
  /** start（默认）| status | stop */
  action?: 'start' | 'status' | 'stop';
  /** 提供时，变更后按该 feature 重建实际 DSL 到 live/（不覆盖设计 DSL） */
  feature?: string;
  /** 事件合并窗口（ms），默认 150 */
  debounce_ms?: number;
  /** 变更后是否重建实际 DSL（默认：给了 feature 才重建） */
  rebuild_on_change?: boolean;
  /** rebuild 节流冷却窗口（ms），默认 2000：窗口内连续变更合并为一次全量重建 */
  rebuild_window_ms?: number;
  /** 定期 reconcile 兜底间隔（ms）。>0 时周期性全量扫描补齐 fs.watch 漏事件；默认 0=关闭 */
  reconcile_interval_ms?: number;
}

export interface WatchProjectToolResult {
  action: string;
  project_dir: string;
  watching: boolean;
  running: boolean;
  feature?: string;
  rebuild: boolean;
  started_at?: string;
  last_change_at?: string;
  last_rebuild_at?: string;
  last_summary?: WatchBatchSummary;
  last_reconcile?: ReconcileSummary;
  message: string;
  error?: string;
}

// ─────────────────────────────────────────────────────────────
// 实现
// ─────────────────────────────────────────────────────────────

/** 变更回调：增量同步后，若开 rebuild 则触发节流后的实际 DSL 重建（live/，不覆盖设计 DSL） */
async function onBatchChange(entry: ActiveWatch, summary: WatchBatchSummary): Promise<void> {
  entry.last_change_at = new Date().toISOString();
  entry.last_summary = summary;
  if (!entry.rebuild || !entry.feature || !entry.throttle) return;
  entry.throttle.trigger();
}

/** 单次实际 DSL 重建（live/，不覆盖设计 DSL）；成功/失败都记录到 entry */
async function doRebuild(entry: ActiveWatch): Promise<void> {
  if (!entry.feature) return;
  try {
    const db = getProjectCacheDb(entry.project_dir);
    await importProject({ project_dir: entry.project_dir, feature: entry.feature, cache_db: db, live_only: true, live_dir: entry.project_dir });
    entry.last_rebuild_at = new Date().toISOString();
    entry.error = undefined; // 上次失败已修复
  } catch (e) {
    entry.error = (e as Error).message;
  }
}

function startWatch(input: WatchProjectToolInput): WatchProjectToolResult {
  const key = keyOf(input.project_dir);
  const feature = input.feature?.trim() || undefined;
  const rebuild = input.rebuild_on_change ?? Boolean(feature);
  const debounceMs = input.debounce_ms ?? 150;

  const existing = active.get(key);
  if (existing && existing.handle) {
    return {
      action: 'start', project_dir: path.resolve(input.project_dir),
      watching: true, running: true, feature: existing.feature, rebuild: existing.rebuild,
      started_at: existing.started_at, last_change_at: existing.last_change_at,
      last_summary: existing.last_summary,
      message: '已在监听（幂等复用既有句柄）' + (existing.error ? '；上次 rebuild 出错: ' + existing.error : ''),
      error: existing.error,
    };
  }

  const entry: ActiveWatch = {
    project_dir: path.resolve(input.project_dir),
    feature,
    rebuild,
    started_at: new Date().toISOString(),
  };

  // rebuild 节流：改到冷却窗口末尾一次全量重建，避免编辑风暴触发频繁全量重扫
  if (rebuild && feature) {
    entry.throttle = createRebuildThrottler({
      windowMs: input.rebuild_window_ms ?? 2000,
      run: () => doRebuild(entry),
    });
  }

  let handle: WatchHandle;
  try {
    const db = getProjectCacheDb(entry.project_dir);
    handle = watchProject({
      project_root: entry.project_dir,
      db,
      debounce_ms: debounceMs,
      reconcile_interval_ms: input.reconcile_interval_ms,
      onChange: (summary) => void onBatchChange(entry, summary),
      onReconcile: (summary) => { entry.last_reconcile = summary; },
      onError: (err) => { entry.error = err.message; },
    });
  } catch (e) {
    return {
      action: 'start', project_dir: entry.project_dir, watching: false, running: false,
      feature, rebuild, message: '启动监听失败: ' + (e as Error).message, error: (e as Error).message,
    };
  }

  entry.handle = handle;
  active.set(key, entry);
  return {
    action: 'start', project_dir: entry.project_dir, watching: true, running: true,
    feature, rebuild, started_at: entry.started_at,
    message: `已开始监听 ${path.resolve(input.project_dir)}` + (rebuild ? `（变更将重建 feature=${feature} 实际 DSL）` : '（仅增量同步 cache.db）'),
  };
}

function statusWatch(projectDir: string): WatchProjectToolResult {
  const key = keyOf(projectDir);
  const entry = active.get(key);
  if (!entry || !entry.handle) {
    return {
      action: 'status', project_dir: path.resolve(projectDir), watching: false, running: false,
      rebuild: false,
      message: '该项目未在监听中。', 
    };
  }
  const st = entry.handle.status();
  return {
    action: 'status', project_dir: entry.project_dir, watching: st.watching, running: st.watching,
    feature: entry.feature, rebuild: entry.rebuild, started_at: entry.started_at,
    last_change_at: entry.last_change_at, last_rebuild_at: entry.last_rebuild_at,
    last_summary: entry.last_summary, last_reconcile: entry.last_reconcile,
    message: entry.error ? '监听运行中，但最近一次 rebuild 报错: ' + entry.error : '监听运行中',
    error: entry.error,
  };
}

async function stopWatch(projectDir: string): Promise<WatchProjectToolResult> {
  const key = keyOf(projectDir);
  const entry = active.get(key);
  if (!entry || !entry.handle) {
    return {
      action: 'stop', project_dir: path.resolve(projectDir), watching: false, running: false,
      rebuild: false,
      message: '该项目本就不在监听中。',
    };
  }
  entry.handle.stop();
  // 冲刷未落库的变更（stop 时若还有排队 rebuild，立即执行一次）
  if (entry.throttle) {
    await entry.throttle.flush().catch(() => { /* flush 失败忽略 */ });
  }
  active.delete(key);
  return {
    action: 'stop', project_dir: entry.project_dir, watching: false, running: false,
    feature: entry.feature, rebuild: entry.rebuild, started_at: entry.started_at,
    last_change_at: entry.last_change_at, last_rebuild_at: entry.last_rebuild_at,
    last_summary: entry.last_summary, last_reconcile: entry.last_reconcile,
    message: '已停止监听。',
  };
}

export async function watchProjectTool(input: WatchProjectToolInput): Promise<WatchProjectToolResult> {
  const action = input.action ?? 'start';
  if (action === 'status') return statusWatch(input.project_dir);
  if (action === 'stop') return stopWatch(input.project_dir);
  return startWatch(input);
}

/** 关闭全部监听（测试隔离 / 进程退出时调用） */
export function closeAllActiveWatches(): void {
  for (const entry of active.values()) {
    if (entry.handle) {
      try { entry.handle.stop(); } catch { /* 已停止 */ }
    }
    if (entry.throttle) {
      try { void entry.throttle.flush(); } catch { /* 忽略 */ }
    }
  }
  active.clear();
}