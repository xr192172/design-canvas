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
import { diffImpact } from './diff_impact.js';
import { runImpactReport, readImpactReport, listImpactReports } from './impact_report.js';
import {
  appendDeclaration, markConsumed, recoverPending, resolveViolation, listLedger, countOpenViolations,
  type LedgerEntry,
} from './impact_ledger_store.js';
import { pushAlert } from './alert_inbox.js';
import { captureProbe, TSProbeCapture, setGlobalProbeSink, hasGlobalProbeSink } from '../observe/probe.js';
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

/** 改前预告声明（Impact Ledger）：LLM 动手前登记"我打算改这些文件"，被匹配的影响报告消费 */
interface ImpactDeclaration {
  /** 对应 ledger.json 落盘条目 id（证据链锚点：resolve/审计都指向它） */
  entry_id: string;
  /** 登记的打算修改文件（相对项目根 posix） */
  declared_files: string[];
  /** 预期波及面（declared + diffImpact both 两跳的全部文件，相对项目根 posix） */
  expected_files: Set<string>;
  created_at: string;
}

interface ActiveWatch {
  project_dir: string;
  feature?: string;
  rebuild: boolean;
  diff_on_change: boolean;
  /** 变更后自动生成影响报告（Step 2）：摘要行入 alerts 队列，全文落盘 impact/ 目录 */
  impact_on_change: boolean;
  /**
   * 未消费的改前预告声明队列（Impact Ledger）。多条并存（并行任务的预告互不覆盖），
   * doWork 按声明的 declared_files ∩ 本次变更文件 匹配消费（可多条并集对比）；
   * 无匹配时回退消费最旧一条（保持会话级对比语义：改了没预告的文件也要报警）。
   */
  declarations: ImpactDeclaration[];
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

// ─────────────────────────────────────────────────────────────
// daemon 事件钩子（方向 E）：watch 进程内关键节点向宿主（daemon）发通知
// ─────────────────────────────────────────────────────────────

/** watch 工具对外播报的事件（daemon 借此触发 loop 回流 / SSE 广播） */
export type WatchToolEvent =
  | {
      /** Impact Ledger 消费定损出现 violated（计划外扩散）——daemon 触发 observe-dsl loop 的信号 */
      type: 'ledger-violated';
      project_dir: string;
      entry_ids: string[];
      unexpected_files: string[];
      seq: number;
    };

let watchToolEventListener: ((e: WatchToolEvent) => void) | null = null;

/** 注册 watch 工具事件监听器（daemon 启动时挂；传 null 注销） */
export function setWatchToolEventListener(fn: ((e: WatchToolEvent) => void) | null): void {
  watchToolEventListener = fn;
}

/** 活跃监听注册表只读视图（daemon /api/health 汇总用） */
export function listActiveWatches(): Array<{
  project_dir: string;
  feature?: string;
  rebuild: boolean;
  impact_on_change: boolean;
  started_at: string;
  last_change_at?: string;
  last_impact_seq?: number;
  pending_declarations: number;
}> {
  return [...active.values()].map((e) => ({
    project_dir: e.project_dir,
    feature: e.feature,
    rebuild: e.rebuild,
    impact_on_change: e.impact_on_change,
    started_at: e.started_at,
    last_change_at: e.last_change_at,
    last_impact_seq: e.last_impact_seq,
    pending_declarations: e.declarations.length,
  }));
}

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
  /** start（默认）| status | stop | impact（读影响报告全文）| declare（改前预告登记）| ledger（预告台账查询/违规处理） */
  action?: 'start' | 'status' | 'stop' | 'impact' | 'declare' | 'ledger';
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
  /** action=declare 时必填：打算修改的文件（相对项目根或绝对路径）。登记后下一次影响报告自动对比，计划外波及报警 */
  files?: string[];
  /** action=ledger 时筛选条目状态：缺省=待办视角（pending+violated）；all=全部 */
  ledger_status?: 'pending' | 'ok' | 'violated' | 'resolved' | 'expired' | 'all';
  /** action=ledger 时处理违规：要 resolve 的 ledger 条目 id（与 reason 搭配） */
  resolve_id?: string;
  /** action=ledger resolve 时的过门说明（必填）：计划外扩散的原因与处理方式 */
  reason?: string;
  /** action=ledger resolve 时的处理人标识，默认 llm */
  reviewer?: string;
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
  /** 未消费的改前预告条数（Impact Ledger 队列深度；>1 表示多条并行任务预告并存） */
  pending_declarations?: number;
  /** 未处理违规数（violated 未 resolve；verification gate 债务，status 持续播报） */
  unresolved_violations?: number;
  /** declare 返回的 ledger 条目 id（resolve/审计的证据链锚点） */
  ledger_entry_id?: string;
  /** action=ledger 返回的条目清单（新→旧） */
  ledger_entries?: LedgerEntry[];
  message: string;
  error?: string;
}

// ─────────────────────────────────────────────────────────────
// 实现
// ─────────────────────────────────────────────────────────────

/**
 * impact 事件入 Observe 流的 lazy sink（Step 3 合流）：
 * MCP stdio 进程默认无全局 sink（captureProbe 是 no-op，事件会丢）——首次注入前
 * 按项目落盘 <projectRoot>/.design-canvas/observe/events.jsonl。
 * 已有 sink（serve 设 OBSERVE_EVENTS_FILE / 先前 watch 已建）则复用不覆盖。
 * 注：全局 sink 只有一个，多项目同进程 watch 时共用首个项目的流（可接受：serve
 * 场景本来就走全局单文件）。
 */
function ensureObserveSink(projectRoot: string): void {
  if (process.env.OBSERVE_EVENTS_FILE) return; // serve/哨兵已配置，复用全局
  if (hasGlobalProbeSink()) return;
  const eventsPath = TSProbeCapture.pathFor(path.join(projectRoot, '.design-canvas', 'observe'));
  setGlobalProbeSink(new TSProbeCapture(eventsPath));
}

/** 相对项目根归一化为 posix 路径（接受相对/绝对；与 diffImpact 的 toRel 同语义） */
function relOf(root: string, p: string): string {
  const abs = path.isAbsolute(p) ? p : path.join(root, p);
  return path.relative(root, abs).split(path.sep).join('/');
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
  //    + 注入 Observe 事件流（Step 3 合流：serve SSE 即时播报 / observe_log 事后查 /
  //      observe_judge 判定爆炸半径 design:impact-blast-radius）
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
      // 响应注入通道：任何 MCP 工具的下一次响应自动附带此提醒（一次投递即消费）
      pushAlert({ project_dir: entry.project_dir, seq: s.seq, line: s.summary_line, created_at: s.created_at });
      ensureObserveSink(entry.project_dir); // 先建 sink，下方 spread/report 事件才能落流

      // Impact Ledger 对比：未消费预告按变更文件匹配消费（可多条并集），无匹配回退消费最旧
      if (entry.declarations.length > 0) {
        const changedSet = new Set(files.map((f) => relOf(entry.project_dir, f)));
        let consumed = entry.declarations.filter((d) => d.declared_files.some((f) => changedSet.has(f)));
        if (consumed.length === 0) {
          // 回退：变更文件未命中任何预告 → 消费最旧一条对比（"改了没预告的文件"也要报警）
          consumed = [entry.declarations[0]];
        }
        entry.declarations = entry.declarations.filter((d) => !consumed.includes(d));
        const decl = {
          declared_files: [...new Set(consumed.flatMap((d) => d.declared_files))],
          expected_files: new Set(consumed.flatMap((d) => [...d.expected_files])),
        };
        const actual = new Set<string>([...changedSet, ...s.impacted_file_paths]);
        const unexpected = [...actual].filter((f) => !decl.expected_files.has(f));
        // 逐条定损落盘（每条预告面对比实际波及，各自 ok/violated + 证据 seq）
        const verdicts = consumed.map((d) => {
          const unexpectedForEntry = [...actual].filter((f) => !d.expected_files.has(f));
          return {
            id: d.entry_id,
            status: unexpectedForEntry.length > 0 ? ('violated' as const) : ('ok' as const),
            unexpected: unexpectedForEntry,
            actual: [...actual].sort(),
            seq: s.seq,
          };
        });
        markConsumed(entry.project_dir, verdicts);
        // daemon 事件钩子（方向 E）：出现 violated → daemon 防抖触发 observe-dsl loop 回流
        const violatedIds = verdicts.filter((v) => v.status === 'violated').map((v) => v.id);
        if (violatedIds.length > 0 && watchToolEventListener) {
          try {
            watchToolEventListener({
              type: 'ledger-violated',
              project_dir: entry.project_dir,
              entry_ids: violatedIds,
              unexpected_files: unexpected,
              seq: s.seq,
            });
          } catch {
            /* 监听器故障不影响 doWork */
          }
        }
        const spreadLine = `[计划外扩散#${s.seq}] 预告 ${decl.expected_files.size} 文件，实际波及 ${actual.size}，未预告 ${unexpected.length}${unexpected.length > 0 ? '：' + unexpected.join(', ') : ''}${unexpected.length > 0 ? ' · 待处理(watch action=ledger)' : ''}`;
        entry.alerts.unshift({ seq: s.seq, created_at: s.created_at, line: spreadLine });
        if (entry.alerts.length > ALERTS_CAP) entry.alerts.length = ALERTS_CAP;
        captureProbe(
          'impact.spread',
          {
            file: files[0],
            op: 'impact-ledger',
            err: '',
            level: 'event',
            seq: s.seq,
            declared_files: decl.declared_files,
            expected_count: decl.expected_files.size,
            actual_count: actual.size,
            unexpected_files: unexpected,
            ledger_entry_ids: consumed.map((d) => d.entry_id),
            summary: spreadLine,
          },
          'runtime-invariant',
        );
        if (unexpected.length > 0) {
          // 计划外扩散是高优先级信号：直接入响应注入收件箱（judge 判 deviation，serve SSE 同步报警）
          pushAlert({ project_dir: entry.project_dir, seq: s.seq, line: spreadLine, created_at: s.created_at });
        }
      }

      // 成功事件：err 空 + 波及统计。radius 超阈值时被 impactBlastRadius 判 deviation
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
      ensureObserveSink(entry.project_dir);
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
    declarations: [],
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

  // 跨会话恢复（Ledger 持久化的另一半）：磁盘上 TTL 内的 pending 预告回填内存，
  // 重启前 declare 的任务在新会话里仍受"改后对比"保护
  let recovered = 0;
  if (impactOnChange) {
    const rec = recoverPending(entry.project_dir, new Set());
    for (const le of rec.entries) {
      entry.declarations.push({
        entry_id: le.id, declared_files: le.declared_files,
        expected_files: new Set(le.expected_files), created_at: le.created_at,
      });
    }
    recovered = rec.entries.length;
  }

  return {
    action: 'start', project_dir: entry.project_dir, watching: true, running: true,
    feature, rebuild, diff_on_change: diffOnChange, impact_on_change: impactOnChange,
    pending_declarations: entry.declarations.length,
    started_at: entry.started_at,
    message: `已开始监听 ${path.resolve(input.project_dir)}`
      + (rebuild && feature ? `（变更将重建 feature=${feature} 实际 DSL）` : '（仅增量同步 cache.db）')
      + (diffOnChange ? '，变更后自动 diff 对比' : '')
      + (impactOnChange ? '，变更后自动影响报告（status 取摘要，action=impact 取全文）' : '')
      + (recovered > 0 ? `；已恢复 ${recovered} 条跨会话改前预告` : ''),
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
  const declNote =
    entry.declarations.length > 0
      ? `；${entry.declarations.length} 条改前预告待验证（声明文件: ${entry.declarations.map((d) => d.declared_files.join('+')).join(' | ')}）`
      : '';
  // 违规债务（verification gate）：未 resolve 的 violated entry 持续播报直到过门
  const openViolations = countOpenViolations(entry.project_dir);
  const violationNote = openViolations > 0 ? `；⚠ ${openViolations} 条计划外扩散待处理（watch action=ledger）` : '';
  return {
    action: 'status', project_dir: entry.project_dir, watching: st.watching, running: st.watching,
    feature: entry.feature, rebuild: entry.rebuild, diff_on_change: entry.diff_on_change,
    impact_on_change: entry.impact_on_change,
    pending_declarations: entry.declarations.length,
    unresolved_violations: openViolations,
    started_at: entry.started_at, last_change_at: entry.last_change_at,
    last_rebuild_at: entry.last_rebuild_at, last_diff_at: entry.last_diff_at,
    last_summary: entry.last_summary, last_reconcile: entry.last_reconcile,
    diff_alert: diffAlert, has_diff_changes: hasDiffChanges,
    alerts: alerts.length > 0 ? alerts : undefined,
    last_impact_seq: entry.last_impact_seq,
    message: diffAlert
      ? `监听运行中，${diffAlert}` + alertNote + declNote + violationNote + (entry.error ? '；最近报错: ' + entry.error : '')
      : '监听运行中' + alertNote + declNote + violationNote + (entry.error ? '，但最近一次工作报错: ' + entry.error : ''),
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

/**
 * action=declare（Impact Ledger 改前预告）：登记"我打算改这些文件"，立刻返回预期
 * 波及面（改前预告）。声明双写：内存队列（消费匹配）+ ledger.json（持久化审计），
 * 多条并行并存（不覆盖既有预告）；声明的文件出现在变更里 → 该条被消费定损：
 * 实际波及 ⊆ 预告 → ok；计划外扩散 → violated（证据 matched_seq → rp 全文）+
 * impact.spread 事件报警。变更未命中任何预告时消费最旧一条（"改了没预告的文件"
 * 也触发对比）。violated 需 action=ledger resolve 过门（reviewer + reason 留痕）。
 *
 * 语义保障：声明前置条件是"改完有人对比"——未监听自动 start（impact_on_change
 * 强制开），已监听但影响报告关着则顺手打开。跨会话：TTL（24h）内的 pending 声明
 * 在新会话 start/declare 时自动恢复回填内存；超时 expired（陈旧预告不产噪音）。
 */
async function declareWatch(input: WatchProjectToolInput): Promise<WatchProjectToolResult> {
  const files = (input.files ?? []).map((f) => f.trim()).filter(Boolean);
  if (files.length === 0) {
    return {
      action: 'declare', project_dir: path.resolve(input.project_dir), watching: false, running: false,
      rebuild: false, diff_on_change: false,
      message: '缺少 files 参数：declare 需要登记打算修改的文件（相对项目根或绝对路径）。',
      error: 'files 为空',
    };
  }

  // 确保监听 + 影响报告在跑（无 watch 自动 start；有但 impact 关则打开）
  const start = await watchProjectTool({ project_dir: input.project_dir, action: 'start', impact_on_change: true, feature: input.feature });
  if (!start.watching) return start; // 启动失败原样上抛
  const entry = active.get(keyOf(input.project_dir));
  if (!entry) {
    return { ...start, action: 'declare', message: '内部错误：监听已启动但注册表缺项。', error: 'registry miss' };
  }
  entry.impact_on_change = true;
  if (!entry.throttle) {
    // 复用既有 watch 且当初未建节流器（rebuild/impact 都没开）→ 补上（doWork 由它驱动）
    entry.throttle = createRebuildThrottler({ windowMs: input.rebuild_window_ms ?? 2000, run: () => doWork(entry) });
  }

  // 预期波及面：declared 本身 + diffImpact both 两跳
  const declared = files.map((f) => relOf(entry.project_dir, f));
  let expected = new Set(declared);
  let previewLine = '';
  try {
    const r = diffImpact({ project_dir: entry.project_dir, feature: entry.feature, changed: declared, direction: 'both', max_depth: 2 });
    expected = new Set([...declared, ...r.impacted_files.map((f) => f.path)]);
    previewLine = `预期波及 ${expected.size} 文件（直接 ${r.impacted_files.filter((f) => f.direct).length} + 间接 ${r.impacted_files.filter((f) => !f.direct).length}）：${[...expected].join(', ')}`;
  } catch (e) {
    previewLine = `波及面计算失败（${(e as Error).message}）——仅登记声明文件本身为预告面。`;
  }

  // 恢复磁盘上未消费的孤儿预告（本进程重启/其他会话 declare 的），排除内存已有防重复
  const have = new Set(entry.declarations.map((d) => d.entry_id));
  const rec = recoverPending(entry.project_dir, have);
  for (const le of rec.entries) {
    entry.declarations.push({
      entry_id: le.id, declared_files: le.declared_files,
      expected_files: new Set(le.expected_files), created_at: le.created_at,
    });
  }

  // 双写：内存队列（消费匹配用）+ ledger.json（持久化/审计/跨会话恢复）
  const ledgerEntry = appendDeclaration(entry.project_dir, declared, [...expected]);
  entry.declarations.push({
    entry_id: ledgerEntry.id, declared_files: declared, expected_files: expected, created_at: ledgerEntry.created_at,
  });
  ensureObserveSink(entry.project_dir);
  captureProbe(
    'impact.declare',
    {
      file: declared[0],
      op: 'impact-ledger',
      err: '',
      level: 'event',
      declared_files: declared,
      expected_count: expected.size,
      pending_count: entry.declarations.length,
      ledger_entry_id: ledgerEntry.id,
      summary: `预告改 ${declared.length} 文件，预期波及 ${expected.size} 文件（队列 ${entry.declarations.length} 条）`,
    },
    'runtime-invariant',
  );

  const queueNote =
    entry.declarations.length > 1
      ? `当前共 ${entry.declarations.length} 条未验证预告并存（各自等自己声明的文件变更后对比）。`
      : '';
  const recoveredNote = rec.entries.length > 0 ? `已恢复 ${rec.entries.length} 条此前会话的未验证预告。` : '';
  return {
    action: 'declare', project_dir: entry.project_dir, watching: true, running: true,
    feature: entry.feature, rebuild: entry.rebuild, diff_on_change: entry.diff_on_change,
    impact_on_change: true,
    pending_declarations: entry.declarations.length,
    ledger_entry_id: ledgerEntry.id,
    started_at: entry.started_at,
    message: `已登记改前预告（${ledgerEntry.id}，声明的文件变更后自动对比，计划外波及将报警）。${previewLine}${recoveredNote}${queueNote}`,
  };
}

/**
 * action=ledger（Impact Ledger 台账）：查询预告生命周期条目 + 违规过门。
 *   - 缺省列出待办视角（pending + violated）；ledger_status 可筛选或 all
 *   - resolve_id + reason：violated → resolved（verification gate 过门，reviewer 留痕）
 * 纯磁盘查询，watch 停止后仍可查（post-mortem 审计）。
 */
function ledgerWatch(input: WatchProjectToolInput): WatchProjectToolResult {
  const root = path.resolve(input.project_dir);
  const entry = active.get(keyOf(input.project_dir));
  const base = {
    action: 'ledger', project_dir: root, watching: entry?.handle ? true : false, running: false,
    rebuild: entry?.rebuild ?? false, diff_on_change: entry?.diff_on_change ?? false,
    impact_on_change: entry?.impact_on_change ?? false,
  };

  // resolve 分支：violated → resolved（reason 必填，store 内校验）
  if (input.resolve_id) {
    try {
      const resolved = resolveViolation(root, input.resolve_id, input.reviewer ?? 'llm', input.reason ?? '');
      return {
        ...base,
        ledger_entries: [resolved],
        unresolved_violations: countOpenViolations(root),
        message: `已处理违规 ${resolved.id}：${resolved.declared_files.join(', ')} 的改动曾计划外扩散 ${resolved.unexpected_files?.length ?? 0} 文件` +
          `（证据 rp-#${resolved.matched_seq}）。处理人 ${resolved.resolution?.reviewer}，剩余待处理 ${countOpenViolations(root)} 条。`,
      };
    } catch (e) {
      return { ...base, message: (e as Error).message, error: (e as Error).message };
    }
  }

  const entries = listLedger(root, input.ledger_status);
  const openViolations = countOpenViolations(root);
  const icon: Record<string, string> = { pending: '⏳', ok: '✅', violated: '⚠', resolved: '🔒', expired: '⌛' };
  const lines: string[] = [];
  lines.push(`Impact Ledger（待验证 ${entries.filter((e) => e.status === 'pending').length} · 违规未处理 ${openViolations} · 本清单 ${entries.length} 条）`);
  if (entries.length === 0) {
    lines.push('  （空——action=declare 登记改前预告后出现）');
  }
  for (const e of entries) {
    const head = `  ${icon[e.status] ?? '·'} [${e.status}] ${e.id} 声明 ${e.declared_files.join('+')}`;
    if (e.status === 'violated') {
      lines.push(`${head} → 计划外扩散：${e.unexpected_files?.join(', ')} · 证据 watch action=impact seq=${e.matched_seq} · resolve 需 reason`);
    } else if (e.status === 'resolved') {
      lines.push(`${head} · 已过门：${e.resolution?.reviewer}「${e.resolution?.reason}」`);
    } else if (e.status === 'pending') {
      lines.push(`${head} · 预告面 ${e.expected_files.length} 文件`);
    } else {
      lines.push(`${head} · 消费于 rp-#${e.matched_seq}`);
    }
  }
  return {
    ...base,
    ledger_entries: entries,
    unresolved_violations: openViolations,
    pending_declarations: entry?.declarations.length,
    message: lines.join('\n'),
  };
}

export async function watchProjectTool(input: WatchProjectToolInput): Promise<WatchProjectToolResult> {
  const action = input.action ?? 'start';
  if (action === 'status') return statusWatch(input.project_dir);
  if (action === 'stop') return stopWatch(input.project_dir);
  if (action === 'impact') return impactWatch(input);
  if (action === 'ledger') return ledgerWatch(input);
  if (action === 'declare') return declareWatch(input);
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