/**
 * snapshot_needle —— "一整针"世界快照采样器。
 *
 * 用户语义：按频率(stop-the-world)对运行中的世界打**一针**，每针 = 一次采样的
 * **完整全局快照**（整条调用链 + 中间状态 + 前因后果，不是单个结果）。对**整针**
 * 做代表性判定：命中的针 → **整针完整落盘** + 触发警告(信号)；未命中的针 → **整针丢弃**。
 *
 * 与 parseRunTraces 的关系：parseRunTraces 把录制帧重建为一根 RunTrace（一次操作的
 * 完整调用树）；本模块把每根 RunTrace 视为"一针"，套上代表性判定与整针保留/丢弃，
 * 不丢针内任何帧（前因后果完整）。
 */

import type { RunTreeNode, RunTrace } from './run_trace_replay.js';

export interface NeedleSignals {
  /** 是否代表性（决定整针落盘与否） */
  representative: boolean;
  /** 命中的代表性信号（触发警告 / 标注落盘原因） */
  signals: string[];
}

/** 代表性判定器：给定一针（整条调用树），判断是否代表性、因何代表性。可注入定制。 */
export type RepresentativeJudge = (needle: RunTrace) => NeedleSignals;

export interface SamplingNeedle {
  trace_id: string;
  /** 整针 = 一次采样的完整调用树（前因后果全在，不裁剪） */
  root: RunTreeNode;
  frames: number;
  sampled_at: number;
  representative: boolean;
  signals: string[];
}

const NEEDLE_MARKER = /\[\[KEEP\]\]|\[\[keep\]\]/;
const ERROR_SIGNAL = /error|失败|exception|panic|超时/i;

/** 递归收集一针里所有字段值文本，供默认判定扫描（前因后果都参与判定）。 */
function collectTexts(n: RunTreeNode, out: string[]): void {
  for (const v of [n.in, n.out]) {
    if (v !== undefined && v !== null) {
      if (typeof v === 'string') out.push(v);
      else if (typeof v === 'object') {
        try { out.push(JSON.stringify(v)); } catch { /* ignore */ }
      }
    }
  }
  if (n.children) n.children.forEach((c) => collectTexts(c, out));
}

const defaultSignalsFor = (t: RunTrace): string[] => {
  const sig: string[] = [];
  const texts: string[] = [];
  collectTexts(t.root, texts);
  // 1) 命中保留标记 [[KEEP]] → 代表"该事实值得留"
  if (texts.some((s) => NEEDLE_MARKER.test(s))) sig.push('kept-fact');
  // 2) 出现错误/异常类文本 → 代表"有风险值得盯"
  if (texts.some((s) => ERROR_SIGNAL.test(s))) sig.push('signal-error');
  return sig;
};

/** 默认代表性判定：命中保留标记 或 错误信号即代表性。 */
function defaultJudge(t: RunTrace): NeedleSignals {
  const signals = defaultSignalsFor(t);
  return { representative: signals.length > 0, signals };
}

/**
 * 把一系列采样（RunTrace[]，各自一针）套上代表性判定：
 *  - 代表性针 → 保留为完整 SamplingNeedle（root 为整棵调用树，含前因后果）
 *  - 非代表性针 → 整针丢弃（不出现在 returned.kept）
 * 返回 kept（仅代表性、且完整的针集合）+ dropped 计数。
 */
export function sampleNeedles(
  traces: RunTrace[],
  judge: RepresentativeJudge = defaultJudge,
): { kept: SamplingNeedle[]; dropped: number } {
  const kept: SamplingNeedle[] = [];
  let dropped = 0;
  for (const t of traces) {
    const v = judge(t);
    if (!v.representative) { dropped++; continue; }
    kept.push({
      trace_id: t.trace_id,
      root: t.root,
      frames: t.frames,
      sampled_at: t.root.start_ms,
      representative: true,
      signals: v.signals,
    });
  }
  return { kept, dropped };
}