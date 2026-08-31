/**
 * Observe 链路重建 · TypeScript 实现（对齐 go-observe/probe/chain.go，P2）
 *
 * 从事件流的 trace 三元组（trace_id/frame_id/parent_id）重建跨函数调用链，
 * 供 TSComparator 做链路级偏差分析（chain-broken）。与 Go 侧语义逐条对齐：
 *   1. 按 trace_id 分组（无 trace_id 的 v1 事件不参与——无链路语义）
 *   2. 链内按 frame_id 聚帧，帧探针名去掉 scope 后缀（.enter/.exit/.catch），
 *      帧起始时间 = 该帧最早事件时间
 *   3. 帧按起始时间排序 → 调用序列（并发链路由子序列语义兜底）
 *   4. 有 trace 无 frame 的事件（v1 式手动传 trace）按原序补进序列尾
 *   5. 预算封顶（c1 精神）：链数 512 / 总帧 4096 / 单链导出 128，超限丢弃计数
 *
 * 链路契约（DSLDecl.chain）用子序列语义：声明的调用序必须是某条实测链的
 * 子序列。未声明的中间帧不算偏差（哑固体可只部分插桩，严格相等会假偏差风暴）。
 */

import type { TSEvent } from './probe.js';

/** scope API 产生的事件探针名后缀。 */
const SCOPE_EVENT_SUFFIXES = ['.enter', '.exit', '.catch'];

/** 去掉 scope 事件后缀返回帧的基础探针名："svc.Handle.enter" → "svc.Handle"。 */
export function baseProbeName(probe: string): string {
  for (const sfx of SCOPE_EVENT_SUFFIXES) {
    if (probe.endsWith(sfx)) return probe.slice(0, -sfx.length);
  }
  return probe;
}

/** 一条调用链的观测画像（与 Go ChainObs 对齐）。 */
export interface TSChainObs {
  trace_id: string;
  /** 基础探针名调用序列（按帧起始时间）。 */
  sequence: string[];
  /** 链上非空 err 的事件数。 */
  errs?: number;
  /** 链内事件总数（证据规模）。 */
  events: number;
}

/** 链路画像封顶：实际观测文件必须内存有界（c1）。 */
export const MAX_CHAINS = 512;
export const MAX_CHAIN_FRAMES = 4096;
export const MAX_SEQUENCE_EXPORT = 128;

/**
 * 从事件流重建调用链画像（按链内首事件出现序排列）。
 * 超预算的链被丢弃（计数在返回值第二参）。
 */
export function rebuildChains(events: TSEvent[]): { chains: TSChainObs[]; dropped: number } {
  interface ChainFrame {
    id: number;
    probe: string;
    start: number; // 最早事件时间（Date.parse 毫秒；NaN 按 0 处理保持稳定序）
    errs: number;
    eventsN: number;
  }
  interface ChainAcc {
    traceID: string;
    frames: Map<number, ChainFrame>;
    order: number[]; // 首见 frame id 序（稳定去重）
    anon: TSEvent[]; // 有 trace 无 frame id 的事件
  }

  const byTrace = new Map<string, ChainAcc>();
  const traceOrder: string[] = [];
  for (const ev of events) {
    if (!ev.trace_id) continue; // v1 事件无链路语义
    let acc = byTrace.get(ev.trace_id);
    if (!acc) {
      acc = { traceID: ev.trace_id, frames: new Map(), order: [], anon: [] };
      byTrace.set(ev.trace_id, acc);
      traceOrder.push(ev.trace_id);
    }
    if (!ev.frame_id) {
      acc.anon.push(ev);
      continue;
    }
    let f = acc.frames.get(ev.frame_id);
    if (!f) {
      const t = Date.parse(ev.time);
      f = { id: ev.frame_id, probe: baseProbeName(ev.probe), start: Number.isNaN(t) ? 0 : t, errs: 0, eventsN: 0 };
      acc.frames.set(ev.frame_id, f);
      acc.order.push(ev.frame_id);
    }
    f.eventsN++;
    if (typeof ev.fields['err'] === 'string' && ev.fields['err'] !== '') f.errs++;
  }

  const chains: TSChainObs[] = [];
  let dropped = 0;
  let frameBudget = MAX_CHAIN_FRAMES;
  for (const tid of traceOrder) {
    const acc = byTrace.get(tid)!;
    if (chains.length >= MAX_CHAINS || frameBudget <= 0) {
      dropped++;
      continue;
    }
    // 帧按起始时间排序；同刻按 frame id（首见序）——与 Go sort.SliceStable 语义一致
    const frs = acc.order
      .map((fid) => acc.frames.get(fid)!)
      .sort((a, b) => (a.start !== b.start ? a.start - b.start : a.id - b.id));

    const obs: TSChainObs = { trace_id: tid, sequence: [], errs: 0, events: 0 };
    for (const f of frs) {
      obs.sequence.push(f.probe);
      obs.errs! += f.errs;
      obs.events += f.eventsN;
    }
    for (const ev of acc.anon) {
      obs.sequence.push(ev.probe); // 无 frame id 的事件按原序补进序列尾
      obs.events++;
      if (typeof ev.fields['err'] === 'string' && ev.fields['err'] !== '') obs.errs!++;
    }
    if (obs.sequence.length > MAX_SEQUENCE_EXPORT) {
      obs.sequence = [...obs.sequence.slice(0, MAX_SEQUENCE_EXPORT), '…(truncated)'];
    }
    frameBudget -= frs.length + acc.anon.length;
    chains.push(obs);
  }
  return { chains, dropped };
}

/** 报告 want 是否为 seq 的子序列（按序出现，允许中间插其他元素）。 */
export function isSubsequence(want: string[], seq: string[]): boolean {
  return subsequencePrefixLen(want, seq) === want.length;
}

/** 一条实测链对链路契约的匹配结果。 */
export interface TSChainMatch {
  chain: TSChainObs;
  /** 子序列匹配到的最长前缀长度（诊断用：越大越接近满足）。 */
  matched: number;
  ok: boolean;
}

/**
 * 在实测链集合上评估链路契约。
 * 返回：satisfied（存在链满足子序列）、best（最接近的链，未满足时用于报告）。
 * 根探针未出现的链与该契约无关（跳过）。
 */
export function matchChainDecl(want: string[], chains: TSChainObs[]): { satisfied: boolean; best: TSChainMatch | null } {
  const root = want[0];
  let best: TSChainMatch | null = null;
  for (const ch of chains) {
    if (!ch.sequence.some((p) => p === root)) continue;
    const m = subsequencePrefixLen(want, ch.sequence);
    if (m === want.length) return { satisfied: true, best: { chain: ch, matched: m, ok: true } };
    if (!best || m > best.matched) best = { chain: ch, matched: m, ok: false };
  }
  return { satisfied: false, best };
}

/** 计算 want 能在 seq 中按序匹配的最长前缀长度。 */
export function subsequencePrefixLen(want: string[], seq: string[]): number {
  let i = 0;
  for (const s of seq) {
    if (i < want.length && s === want[i]) i++;
  }
  return i;
}
