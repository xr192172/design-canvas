/**
 * index_backfill —— **后台续建**：前台按需建块之后，空闲时把剩下的拼图补全
 *
 * 用户意图（2026-09-14）：「读是为了冷启动。选定好读了之后，**没有其他任务的时候就持续跑这个补件**。
 * 首次读主要是为了**防止出现读不到** —— 读不到会打击 LLM 的使用感受。」
 *
 * 分工：
 *   - **前台**（`ensureIndexAround`）：只建"选中文件 + 直接协作者"那一块（有预算/时长封顶），
 *     保证**第一次读立刻有东西**，绝不长时间空转；
 *   - **后台**（本模块）：第一块建完后，分小批、可中断地把整个项目补齐；
 *     每批之间让出事件循环（不阻塞 MCP 请求），并有单飞锁防重复起循环。
 *
 * 诚实纪律：**补齐前不许声称完整** —— 进度由 `backfillState()` 如实暴露
 * （running / done / total / finishedAt / lastError）。
 *
 * 纯本地：只读源码、写自己的 `<projectRoot>/.design-canvas/cache.db`。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getProjectCacheDb, type Database } from '../db/db.js';
import { syncFile, resolveCrossFileCalls } from '../db/symbols.js';
import { walkSourceFiles } from './refs_text.js';

export interface BackfillState {
  running: boolean;
  root: string;
  /** 走查到的源码文件总数（口径 = tools/refs_text.walkSourceFiles） */
  total: number;
  /** 已索引（含此前就已索引的） */
  done: number;
  /** 本轮新建/更新的文件数 */
  synced: number;
  failed: number;
  rounds: number;
  startedAt: number;
  finishedAt?: number;
  /** 最近一次错误（不吞：如实暴露） */
  lastError?: string;
}

export interface BackfillOptions {
  /** 每批同步多少个文件（默认 20；每批后让出事件循环） */
  batch?: number;
  /** 两批之间等多久（默认 200ms；让前台请求优先） */
  intervalMs?: number;
  /** 整个后台任务最多同步多少个文件（默认不限；设了就是个安全阀） */
  maxFiles?: number;
  /** 每隔几批做一次跨文件引用解析（默认 5） */
  resolveEvery?: number;
}

const states = new Map<string, BackfillState>();
const timers = new Map<string, NodeJS.Timeout>();

/** 查后台续建进度（未起过 → null） */
export function backfillState(root: string): BackfillState | null {
  return states.get(path.resolve(root)) ?? null;
}

/** 停掉某个项目的后台续建（幂等） */
export function stopBackfill(root: string): void {
  const key = path.resolve(root);
  const t = timers.get(key);
  if (t) clearTimeout(t);
  timers.delete(key);
  const s = states.get(key);
  if (s) s.running = false;
}

/** 已索引文件数（相对项目根） */
function indexedSet(db: Database): Set<string> {
  return new Set((db.prepare('SELECT path FROM files').all() as Array<{ path: string }>).map((r) => r.path));
}

/**
 * 同步一批：返回本批结果与剩余量（纯前台可用的"手动补一批"，也是后台循环的步进函数）。
 */
export async function backfillChunk(
  db: Database,
  root: string,
  opts: { batch?: number } = {},
): Promise<{ synced: number; failed: number; remaining: number; total: number }> {
  const absRoot = path.resolve(root);
  const batch = opts.batch ?? 20;
  const all = walkSourceFiles(absRoot);
  const indexed = indexedSet(db);
  const todo = all.filter((r) => !indexed.has(r));
  const take = todo.slice(0, batch);
  let synced = 0;
  let failed = 0;
  for (const rel of take) {
    try {
      const r = await syncFile(db, absRoot, path.join(absRoot, rel));
      if (r.status === 'updated') synced++;
      else if (r.status === 'failed') failed++;
    } catch {
      failed++;
    }
  }
  if (synced > 0) {
    try {
      resolveCrossFileCalls(db, absRoot);
    } catch {
      /* 收尾失败不影响下一批 */
    }
  }
  return { synced, failed, remaining: Math.max(0, todo.length - take.length), total: all.length };
}

/**
 * 起后台续建（幂等：同一项目只会有一个循环在跑）。
 * 用 `setTimeout` 串行步进 + `unref()`（不阻止进程退出）；每批之间让出事件循环，
 * 所以它**不会**把 MCP 请求卡住。
 */
export function scheduleBackfill(root: string, opts: BackfillOptions = {}): BackfillState {
  const absRoot = path.resolve(root);
  const existing = states.get(absRoot);
  if (existing?.running) return existing; // 单飞

  const db = getProjectCacheDb(absRoot);
  const state: BackfillState = {
    running: true,
    root: absRoot,
    total: 0,
    done: 0,
    synced: 0,
    failed: 0,
    rounds: 0,
    startedAt: Date.now(),
    ...(existing ? { synced: existing.synced, failed: existing.failed, rounds: existing.rounds } : {}),
  };
  states.set(absRoot, state);

  const batch = opts.batch ?? 20;
  const intervalMs = opts.intervalMs ?? 200;
  const maxFiles = opts.maxFiles ?? Number.POSITIVE_INFINITY;
  const resolveEvery = opts.resolveEvery ?? 5;

  const step = async (): Promise<void> => {
    if (!state.running) return;
    state.rounds++;
    try {
      // 每轮重扫一次剩余（文件可能被增删；成本 ~几毫秒）
      const all = walkSourceFiles(absRoot);
      state.total = all.length;
      const indexed = indexedSet(db);
      state.done = [...indexed].filter((p) => all.includes(p)).length || indexed.size;
      const todo = all.filter((r) => !indexed.has(r));
      if (!todo.length || state.synced >= maxFiles) {
        state.running = false;
        state.finishedAt = Date.now();
        timers.delete(absRoot);
        return;
      }
      const take = todo.slice(0, batch);
      for (const rel of take) {
        try {
          const r = await syncFile(db, absRoot, path.join(absRoot, rel));
          if (r.status === 'updated') state.synced++;
          else if (r.status === 'failed') state.failed++;
        } catch {
          state.failed++;
        }
        // 让出事件循环：前台请求（MCP）优先
        await new Promise((r2) => setImmediate(r2));
      }
      if (state.rounds % resolveEvery === 0) {
        try {
          resolveCrossFileCalls(db, absRoot);
        } catch {
          /* 收尾失败不影响下一批 */
        }
      }
      state.done = indexedSet(db).size;
    } catch (e) {
      state.lastError = (e as Error).message;
    }
    const t = setTimeout(() => void step(), intervalMs);
    (t as unknown as { unref?: () => void }).unref?.();
    timers.set(absRoot, t);
  };

  // 稍等一拍再开工，保证"首次读"先拿到结果
  const first = setTimeout(() => void step(), intervalMs);
  (first as unknown as { unref?: () => void }).unref?.();
  timers.set(absRoot, first);
  return state;
}

/** 人读进度串（供工具结果/诊断用） */
export function backfillSummary(state: BackfillState | null): string {
  if (!state) return '后台续建：未启动';
  if (state.running) {
    return `后台续建：进行中 ${state.done}/${state.total}（本轮新建 ${state.synced}${state.failed ? `，失败 ${state.failed}` : ''}）`;
  }
  const secs = state.finishedAt ? ((state.finishedAt - state.startedAt) / 1000).toFixed(1) : '?';
  return `后台续建：已完成 ${state.done}/${state.total}（本轮新建 ${state.synced}${state.failed ? `，失败 ${state.failed}` : ''}，${secs}s）${state.lastError ? `｜lastError: ${state.lastError}` : ''}`;
}
