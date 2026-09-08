/**
 * observe_trace —— 录制调用链的纯后端「读回放」能力（面向 LLM）。
 *
 * 从探针落盘的录制事件（JSONL）重建完整调用树（一针 = 一条完整链路，前因后果都在），
 * 并按代表性采样保留。LLM 调用本能力拿到的不是图形播放器，而是**结构化调用树**：
 * 每环节 probe / 入参 / 出参 / 耗时 / 缺帧，自行读、总结、找根因。
 *
 * 与 GUI 回放器的区别：不做人机交互那层（此项目本来就是 LLM-agent 工具栈，
 * GUI 回放器重且不契合）。本文件即核心，server_registry 的 observe_trace 工具复用。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseRunTraces, type RunTreeNode, type RunTrace } from './run_trace_replay.js';
import { sampleNeedles, type SamplingNeedle } from './snapshot_needle.js';

export interface ObserveTraceCfg {
  /** 录制事件文件（JSONL 绝对/相对路径）。缺省自动找探针 sink：DS_OBSERVE_EVENTS > os.tmpdir()/dsh_events.jsonl > cwd/runs.jsonl */
  events_path?: string;
  /** 内联事件文本（优先于 events_path；调试/测试用，避免落盘） */
  events_text?: string;
  /** 'all'=不过滤返回全部链路；'default'=采样只留代表针 */
  keep?: 'all' | 'default';
  /** 只看某条链路（trace_id）。给了就只返回它 */
  trace_id?: string;
  /** 最多返回多少针（不给 trace_id 时，控制返回上限，防上下文撑爆） */
  limit?: number;
}

export interface ObserveTraceResult {
  source: string;
  total_traces: number;
  dropped: number;
  /** 采样后保留的针（未给 trace_id 时受 limit 裁剪） */
  kept: SamplingNeedle[];
  /** 命中指定 trace_id 的那一针（给了 trace_id 才有；未命中为 undefined） */
  selected?: SamplingNeedle;
}

/** 缺省录制文件候选：env DS_OBSERVE_EVENTS > 系统临时目录 dsh_events.jsonl > cwd/runs.jsonl */
export function defaultEventsCandidates(cwd = process.cwd()): string[] {
  return [
    process.env.DS_OBSERVE_EVENTS,
    path.join(os.tmpdir(), 'dsh_events.jsonl'),
    path.join(cwd, 'runs.jsonl'),
  ].filter((p): p is string => !!p);
}

/** 读录制文本：内联 > events_path > 缺省候选。全找不到报错（带可操作提示）。 */
export function loadEventsText(cfg: ObserveTraceCfg, cwd = process.cwd()): { text: string; source: string } {
  if (typeof cfg.events_text === 'string' && cfg.events_text.trim() !== '') {
    return { text: cfg.events_text, source: 'inline' };
  }
  if (cfg.events_path) {
    if (!fs.existsSync(cfg.events_path)) throw new Error(`录制事件文件不存在：${cfg.events_path}`);
    return { text: fs.readFileSync(cfg.events_path, 'utf8'), source: cfg.events_path };
  }
  const hit = defaultEventsCandidates(cwd).find((p) => fs.existsSync(p));
  if (!hit) {
    throw new Error(
      '未提供 events_path / events_text，且未发现默认录制文件（DS_OBSERVE_EVENTS / os.tmpdir()/dsh_events.jsonl / cwd/runs.jsonl）。' +
      '请先录一发（探针插桩跑一次操作）再读回放。',
    );
  }
  return { text: fs.readFileSync(hit, 'utf8'), source: hit };
}

/** 读录制事件 → 重建调用树 → 采样（全保留/代表针）→ 裁剪返回。 */
export function loadNeedles(cfg: ObserveTraceCfg, cwd = process.cwd()): ObserveTraceResult {
  const { text, source } = loadEventsText(cfg, cwd);
  const traces = parseRunTraces(text);
  const keep = cfg.keep === 'all' ? 'all' : 'default';

  let kept: SamplingNeedle[];
  let dropped = 0;
  if (keep === 'all') {
    kept = traces.map((t): SamplingNeedle => ({
      trace_id: t.trace_id, root: t.root, frames: t.frames,
      sampled_at: t.root.start_ms, representative: true, signals: ['all'],
    }));
  } else {
    const r = sampleNeedles(traces);
    kept = r.kept;
    dropped = r.dropped;
  }

  let selected: SamplingNeedle | undefined;
  if (cfg.trace_id) {
    selected = kept.find((k) => k.trace_id === cfg.trace_id);
    kept = selected ? [selected] : [];
  }

  const limit = typeof cfg.limit === 'number' && cfg.limit > 0 ? cfg.limit : undefined;
  if (limit && kept.length > limit) kept = kept.slice(0, limit);

  return { source, total_traces: traces.length, dropped, kept, selected };
}

/** 把一针调用树摊成 LLM 好读的缩进文本（幕读取用，避免整丢 in/out）。 */
export function traceToText(t: SamplingNeedle, maxDepth = 40): string {
  const lines: string[] = [];
  const walk = (n: RunTreeNode, depth: number): void => {
    if (depth > maxDepth) { lines.push('  '.repeat(maxDepth) + '…（过深截断）'); return; }
    const dur = n.dur_ms < 1 ? `${Math.round(n.dur_ms * 1000)}µs` : `${n.dur_ms.toFixed(n.dur_ms < 100 ? 1 : 0)}ms`;
    const miss = n.missingIn && n.missingOut ? ' [缺入缺出]'
      : n.missingIn ? ' [缺入]' : n.missingOut ? ' [缺出]' : '';
    lines.push(`${'  '.repeat(depth)}· ${n.probe}  ${dur}${miss}`);
    (n.children || []).forEach((c) => walk(c, depth + 1));
  };
  walk(t.root, 0);
  return lines.join('\n');
}

/** 一针的树 → 紧凑 JSON（保留入出参，供 LLM 精算/搜索）。 */
function compactNode(n: RunTreeNode): unknown {
  return {
    probe: n.probe,
    dur_ms: n.dur_ms,
    missing: (n.missingIn ? 'in' : '') + (n.missingOut ? 'out' : ''),
    in: n.in,
    out: n.out,
    children: (n.children || []).map(compactNode),
  };
}

/** 针 → LLM 可直接消费的结构化数据（含完整调用树）。 */
export function needleToData(t: SamplingNeedle): Record<string, unknown> {
  return {
    trace_id: t.trace_id,
    frames: t.frames,
    sampled_at: t.sampled_at,
    signals: t.signals,
    root: compactNode(t.root),
  };
}

/** 面向 LLM 的一步到位的封装：读 → 采样 → 出「可读文本 + 结构化数据」。 */
export function observeTrace(cfg: ObserveTraceCfg, cwd = process.cwd()): { message: string; data: unknown } {
  const r = loadNeedles(cfg, cwd);
  const head = [
    `录制调用链回放 [${r.source}]`,
    `  链路 ${r.total_traces} 条 · 采样保留 ${r.kept.length} 针${cfg.keep === 'all' ? '' : `（非代表丢弃 ${r.dropped}）`}`,
    cfg.trace_id ? (r.selected ? `  命中链路 ${r.selected.trace_id}（${r.selected.frames} 帧）` : `  未命中链路 ${cfg.trace_id}`) : '',
  ].filter(Boolean);

  if (cfg.trace_id) {
    if (!r.selected) return { message: [...head, '  目标链路不在采样保留内；请用 keep=all 取全量。'].join('\n'), data: { selected: undefined, source: r.source, total_traces: r.total_traces } };
    const t = r.selected;
    return {
      message: [...head, '', traceToText(t)].join('\n'),
      data: { source: r.source, total_traces: r.total_traces, dropped: r.dropped, needles: [needleToData(t)] },
    };
  }

  const list = r.kept.map((k, i) =>
    `  [${i + 1}] ${k.trace_id}  ${k.frames}帧  根=${k.root.probe}  信号=${k.signals.join('/') || '—'}`,
  );
  const hint = cfg.trace_id ? ''
    : '\n要展开看某一针，用 trace_id 传入该链路 id（keep=all 可取全量未采样的）。';
  return {
    message: [...head, ...(list.length ? list : ['  （无可读链路）']), hint].join('\n'),
    data: { source: r.source, total_traces: r.total_traces, dropped: r.dropped, needles: r.kept.map(needleToData) },
  };
}

// 供工具注册引用的类型（避免未使用告警）
export type { RunTrace };