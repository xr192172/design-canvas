/**
 * watch_project MCP 工具 —— 项目文件实时监听自动同步（路线图序号11，S3）
 *
 * 在 MCP 长进程内启动对目标项目目录的常驻监听，文件变更/新增/删除时：
 *   1. 增量同步到 cache.db（watch_project 核心，内部按 content_hash 增量）
 *   2. 可选 rebuild：按 feature 重建"实际 DSL"到 live/（saveLiveFeature，不覆盖设计 DSL）
 *   3. 可选 diff：rebuild 后自动对比设计视图 vs live 视图，生成 diff 告警
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
import { diffViews, type DiffViewsResult } from './diff_views.js';
import { runImpactReport, readImpactReport, listImpactReports } from './impact_report.js';
import { captureProbe, TSProbeCapture, setGlobalProbeSink, hasGlobalProbeSink } from '../camera/probe.js';
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
  diff_on_change: boolean;
  /** 变更后自动生成影响报告（Step 2）：摘要行入 alerts 队列，全文落盘 impact/ 目录 */
  impact_on_change: boolean;
  started_at: string;
  last_change_at?: string;
  last_rebuild_at?: string;
  last_diff_at?: string;
  last_summary?: WatchBatchSummary;
  last_reconcile?: ReconcileSummary;
  /** rebuild 后自动 diff 的结果（仅 diff_on_change=true 时有） */
  last_diff?: DiffViewsResult;
  /** 冷却窗口内积累的待分析变更文件（相对项目根），doWork 时取走清空 */
  pending_files: Set<string>;
  /** 未读影响提醒（一行摘要 × 报告序号），新→旧，cap 20；watch status 时 piggyback 带回 */
  alerts: { seq: number; created_at: string; line: string }[];
  last_impact_seq?: number;
  error?: string;
  handle?: WatchHandle;
  throttle?: RebuildThrottler;
}

const active = new Map<string, ActiveWatch>();

/** alerts 队列上限：超出丢最旧（全文已落盘，摘要行只是提醒） */
const ALERTS_CAP = 20;

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
  /** start（默认）| status | stop | impact（读影响报告全文） */
  action?: 'start' | 'status' | 'stop' | 'impact';
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
  /**
   * rebuild 后是否自动 diff 对比设计视图 vs live 视图（需要已存在设计 DSL）。
   * 默认 false。开启后每次 rebuild 都会自动调用 diff_views 生成对比结果，
   * 可通过 status 查询 last_diff 查看。
   */
  diff_on_change?: boolean;
  /**
   * 变更后是否自动生成影响报告（Step 2，默认 false）。
   * 开启后每次变更（节流合并）自动跑 diffImpact：一行摘要入 alerts 队列
   * （watch status 时带回），全文落盘 .design-canvas/impact/rp-<seq>.json，
   * action=impact 按序号取全文。feature 可选（缺省纯缓存分析）。
   */
  impact_on_change?: boolean;
  /** action=impact 时指定报告序号；缺省取最近一份 */
  seq?: number;
}

export interface WatchProjectToolResult {
  action: string;
  project_dir: string;
  watching: boolean;
  running: boolean;
  feature?: string;
  rebuild: boolean;
  diff_on_change: boolean;
  started_at?: string;
  last_change_at?: string;
  last_rebuild_at?: string;
  last_diff_at?: string;
  last_summary?: WatchBatchSummary;
  last_reconcile?: ReconcileSummary;
  /** rebuild 后自动 diff 对比结果摘要（仅首次 diff_on_change=true 且完成 diff 后） */
  diff_alert?: string;
  /** diff 有无变更（true = 有变更，false = 无变更或尚未 diff） */
  has_diff_changes?: boolean;
  /** 影响报告是否开启 */
  impact_on_change?: boolean;
  /** 未读影响提醒（一行摘要，新→旧，最多 10 条；全文用 action=impact 取） */
  alerts?: string[];
  /** 最近一份影响报告序号 */
  last_impact_seq?: number;
  message: string;
  error?: string;
}

// ─────────────────────────────────────────────────────────────
// 实现
// ─────────────────────────────────────────────────────────────

/**
 * impact 事件入 Camera 流的 lazy sink（Step 3 合流）：
 * MCP stdio 进程默认无全局 sink（captureProbe 是 no-op，事件会丢）——首次注入前
 * 按项目落盘 <projectRoot>/.design-canvas/camera/events.jsonl。
 * 已有 sink（serve 设 CAMERA_EVENTS_FILE / 先前 watch 已建）则复用不覆盖。
 * 注：全局 sink 只有一个，多项目同进程 watch 时共用首个项目的流（可接受：serve
 * 场景本来就走全局单文件）。
 */
function ensureCameraSink(projectRoot: string): void {
  if (process.env.CAMERA_EVENTS_FILE) return; // serve/哨兵已配置，复用全局
  if (hasGlobalProbeSink()) return;
  const eventsPath = TSProbeCapture.pathFor(path.join(projectRoot, '.design-canvas', 'camera'));
  setGlobalProbeSink(new TSProbeCapture(eventsPath));
}

/** 变更回调：增量同步后积累待分析文件，触发节流后的 doWork（rebuild + 影响报告） */
async function onBatchChange(entry: ActiveWatch, summary: WatchBatchSummary): Promise<void> {
  entry.last_change_at = new Date().toISOString();
  entry.last_summary = summary;
  if (entry.impact_on_change) {
    for (const f of summary.files) entry.pending_files.add(f);
  }
  if (!entry.throttle) return;
  if (!entry.rebuild && !entry.impact_on_change) return;
  entry.throttle.trigger();
}

/**
 * 节流后的单次工作：① rebuild 实际 DSL（可选）② 影响报告（可选）。
 * 两阶段独立成败：rebuild 失败不影响 impact（缓存已在 watch 增量同步过）。
 */
async function doWork(entry: ActiveWatch): Promise<void> {
  // ① rebuild（live/，不覆盖设计 DSL）
  if (entry.rebuild && entry.feature) {
    try {
      const db = getProjectCacheDb(entry.project_dir);
      await importProject({ project_dir: entry.project_dir, feature: entry.feature, cache_db: db, live_only: true, live_dir: entry.project_dir });
      entry.last_rebuild_at = new Date().toISOString();
      entry.error = undefined; // 上次失败已修复

      // rebuild 后若有 diff_on_change 标记，自动对比设计视图 vs live 视图
      if (entry.diff_on_change) {
        try {
          const diffResult = diffViews({ feature: entry.feature, live_dir: entry.project_dir });
          entry.last_diff = diffResult;
          entry.last_diff_at = new Date().toISOString();
        } catch (diffErr) {
          // diff 失败不阻塞 watch，仅记录
          entry.error = 'diff 失败: ' + (diffErr as Error).message;
        }
      }
    } catch (e) {
      entry.error = (e as Error).message;
    }
  }

  // ② 影响报告：取走冷却窗口内积累的变更文件，全文落盘 + 摘要入 alerts
  //    + 注入 Camera 事件流（Step 3 合流：serve SSE 即时播报 / camera_log 事后查 /
  //      camera_judge 判定爆炸半径 design:impact-blast-radius）
  if (entry.impact_on_change && entry.pending_files.size > 0) {
    const files = [...entry.pending_files];
    entry.pending_files.clear();
    try {
      const s = runImpactReport({
        project_dir: entry.project_dir,
        feature: entry.feature,
        changed: files,
        direction: 'both',
        max_depth: 2,
      });
      entry.alerts.unshift({ seq: s.seq, created_at: s.created_at, line: s.summary_line });
      if (entry.alerts.length > ALERTS_CAP) entry.alerts.length = ALERTS_CAP;
      entry.last_impact_seq = s.seq;
      // 成功事件：err 空 + 波及统计。radius 超阈值时被 impactBlastRadius 判 deviation
      ensureCameraSink(entry.project_dir);
      captureProbe(
        'impact.report',
        {
          file: files[0],
          op: 'impact-report',
          err: '',
          level: 'event',
          changed_files: files,
          seq: s.seq,
          direct_files: s.direct_files,
          direct_symbols: s.direct_symbols,
          indirect_files: s.indirect_files,
          indirect_symbols: s.indirect_symbols,
          summary: s.summary_line,
        },
        'runtime-invariant',
      );
    } catch (e) {
      // 影响报告失败不阻断监听（如 cache 未建），记录到 error + 注入失败事件
      // （err 非空 → silentErrorDiscard 判 deviation → serve SSE 即时报警）
      entry.error = '影响报告失败: ' + (e as Error).message;
      ensureCameraSink(entry.project_dir);
      captureProbe(
        'impact.report',
        { file: files[0], op: 'impact-report', err: (e as Error).message, level: 'event', changed_files: files },
        'runtime-invariant',
      );
    }
  }
}

function startWatch(input: WatchProjectToolInput): WatchProjectToolResult {
  const key = keyOf(input.project_dir);
  const feature = input.feature?.trim() || undefined;
  const rebuild = input.rebuild_on_change ?? Boolean(feature);
  const diffOnChange = input.diff_on_change ?? false;
  const impactOnChange = input.impact_on_change ?? false;
  const debounceMs = input.debounce_ms ?? 150;

  const existing = active.get(key);
  if (existing && existing.handle) {
    return {
      action: 'start', project_dir: path.resolve(input.project_dir),
      watching: true, running: true, feature: existing.feature, rebuild: existing.rebuild,
      diff_on_change: existing.diff_on_change, impact_on_change: existing.impact_on_change,
      started_at: existing.started_at, last_change_at: existing.last_change_at,
      last_summary: existing.last_summary, last_impact_seq: existing.last_impact_seq,
      message: '已在监听（幂等复用既有句柄）' + (existing.error ? '；上次出错: ' + existing.error : ''),
      error: existing.error,
    };
  }

  const entry: ActiveWatch = {
    project_dir: path.resolve(input.project_dir),
    feature,
    rebuild,
    diff_on_change: diffOnChange,
    impact_on_change: impactOnChange,
    started_at: new Date().toISOString(),
    pending_files: new Set(),
    alerts: [],
  };

  // 节流：rebuild 或影响报告任一开启即建（冷却窗口内编辑风暴合并为一次工作）
  if ((rebuild && feature) || impactOnChange) {
    entry.throttle = createRebuildThrottler({
      windowMs: input.rebuild_window_ms ?? 2000,
      run: () => doWork(entry),
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
      feature, rebuild, diff_on_change: diffOnChange,
      message: '启动监听失败: ' + (e as Error).message, error: (e as Error).message,
    };
  }

  entry.handle = handle;
  active.set(key, entry);
  return {
    action: 'start', project_dir: entry.project_dir, watching: true, running: true,
    feature, rebuild, diff_on_change: diffOnChange, impact_on_change: impactOnChange,
    started_at: entry.started_at,
    message: `已开始监听 ${path.resolve(input.project_dir)}`
      + (rebuild && feature ? `（变更将重建 feature=${feature} 实际 DSL）` : '（仅增量同步 cache.db）')
      + (diffOnChange ? '，变更后自动 diff 对比' : '')
      + (impactOnChange ? '，变更后自动影响报告（status 取摘要，action=impact 取全文）' : ''),
  };
}

function statusWatch(projectDir: string): WatchProjectToolResult {
  const key = keyOf(projectDir);
  const entry = active.get(key);
  if (!entry || !entry.handle) {
    return {
      action: 'status', project_dir: path.resolve(projectDir), watching: false, running: false,
      rebuild: false, diff_on_change: false,
      message: '该项目未在监听中。',
    };
  }
  const st = entry.handle.status();

  // 构建 diff_alert 摘要
  let diffAlert: string | undefined;
  let hasDiffChanges = false;
  if (entry.last_diff) {
    const s = entry.last_diff.data.summary;
    const changedFiles = s.added_files + s.removed_files + s.modified_files;
    if (changedFiles > 0) {
      hasDiffChanges = true;
      diffAlert = `设计视图 vs 实际代码有 ${changedFiles} 个文件差异（+${s.added_files} -${s.removed_files} ~${s.modified_files}），` +
        `符号: ${s.design_symbols}→${s.live_symbols}，API: ${s.design_apis}→${s.live_apis}`;
    } else {
      diffAlert = '设计视图与实际代码一致，无差异';
    }
  }

  const alerts = entry.alerts.slice(0, 10).map((a) => a.line);
  const alertNote = alerts.length > 0 ? `；${alerts.length} 条未读影响提醒（最新: ${alerts[0]}）` : '';
  return {
    action: 'status', project_dir: entry.project_dir, watching: st.watching, running: st.watching,
    feature: entry.feature, rebuild: entry.rebuild, diff_on_change: entry.diff_on_change,
    impact_on_change: entry.impact_on_change,
    started_at: entry.started_at, last_change_at: entry.last_change_at,
    last_rebuild_at: entry.last_rebuild_at, last_diff_at: entry.last_diff_at,
    last_summary: entry.last_summary, last_reconcile: entry.last_reconcile,
    diff_alert: diffAlert, has_diff_changes: hasDiffChanges,
    alerts: alerts.length > 0 ? alerts : undefined,
    last_impact_seq: entry.last_impact_seq,
    message: diffAlert
      ? `监听运行中，${diffAlert}` + alertNote + (entry.error ? '；最近报错: ' + entry.error : '')
      : '监听运行中' + alertNote + (entry.error ? '，但最近一次工作报错: ' + entry.error : ''),
    error: entry.error,
  };
}

async function stopWatch(projectDir: string): Promise<WatchProjectToolResult> {
  const key = keyOf(projectDir);
  const entry = active.get(key);
  if (!entry || !entry.handle) {
    return {
      action: 'stop', project_dir: path.resolve(projectDir), watching: false, running: false,
      rebuild: false, diff_on_change: false,
      message: '该项目本就不在监听中。',
    };
  }
  entry.handle.stop();
  // 冲刷未落库的变更（stop 时若还有排队 rebuild/影响报告，立即执行一次）
  if (entry.throttle) {
    await entry.throttle.flush().catch(() => { /* flush 失败忽略 */ });
  }
  const alerts = entry.alerts.slice(0, 10).map((a) => a.line);
  active.delete(key);
  return {
    action: 'stop', project_dir: entry.project_dir, watching: false, running: false,
    feature: entry.feature, rebuild: entry.rebuild, diff_on_change: entry.diff_on_change,
    impact_on_change: entry.impact_on_change,
    started_at: entry.started_at, last_change_at: entry.last_change_at,
    last_rebuild_at: entry.last_rebuild_at, last_diff_at: entry.last_diff_at,
    last_summary: entry.last_summary, last_reconcile: entry.last_reconcile,
    alerts: alerts.length > 0 ? alerts : undefined,
    last_impact_seq: entry.last_impact_seq,
    diff_alert: entry.last_diff
      ? `设计 vs 实际差异: +${entry.last_diff.data.summary.added_files} -${entry.last_diff.data.summary.removed_files} ~${entry.last_diff.data.summary.modified_files} 文件`
      : undefined,
    has_diff_changes: entry.last_diff
      ? (entry.last_diff.data.summary.added_files + entry.last_diff.data.summary.removed_files + entry.last_diff.data.summary.modified_files) > 0
      : false,
    message: '已停止监听。',
  };
}

/** action=impact：按序号读影响报告全文。报告落盘持久，监听停止后仍可读 */
function impactWatch(input: WatchProjectToolInput): WatchProjectToolResult {
  const root = path.resolve(input.project_dir);
  const entry = active.get(keyOf(input.project_dir));
  // 序号解析：显式 seq > 活跃监听最近一份 > 磁盘最新一份
  const seq = input.seq ?? entry?.last_impact_seq ?? listImpactReports(root, 1)[0]?.seq;
  if (!seq) {
    return {
      action: 'impact', project_dir: root, watching: entry?.handle ? true : false, running: false,
      rebuild: entry?.rebuild ?? false, diff_on_change: entry?.diff_on_change ?? false,
      impact_on_change: entry?.impact_on_change ?? false,
      message: '暂无影响报告。开启 impact_on_change=true 监听并修改文件后自动生成。',
    };
  }
  try {
    const report = readImpactReport(root, seq);
    return {
      action: 'impact', project_dir: root, watching: entry?.handle ? true : false, running: false,
      rebuild: entry?.rebuild ?? false, diff_on_change: entry?.diff_on_change ?? false,
      impact_on_change: entry?.impact_on_change ?? false,
      last_impact_seq: seq,
      alerts: [report.summary.summary_line],
      message: report.message,
    };
  } catch (e) {
    return {
      action: 'impact', project_dir: root, watching: entry?.handle ? true : false, running: false,
      rebuild: entry?.rebuild ?? false, diff_on_change: entry?.diff_on_change ?? false,
      message: (e as Error).message, error: (e as Error).message,
    };
  }
}

export async function watchProjectTool(input: WatchProjectToolInput): Promise<WatchProjectToolResult> {
  const action = input.action ?? 'start';
  if (action === 'status') return statusWatch(input.project_dir);
  if (action === 'stop') return stopWatch(input.project_dir);
  if (action === 'impact') return impactWatch(input);
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