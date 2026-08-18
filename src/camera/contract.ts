/**
 * Camera 多语言契约 · TypeScript 判定哨兵（Comparator）
 *
 * 对应 docs/camera-abstract.md §3.4。目的：证明判定逻辑语言无关——TS 侧用同一
 * 份 dsl.json（权威真相源）+ events.jsonl（观测）即可独立产出三类偏差报告，
 * 与 Go 装配层的 Comparator 语义一致。
 *
 * 契约语义对齐（与 Go contract.go SilentErrorDiscard 完全一致）：
 *   - remove/remove-tmp/cleanup：仅显式标记 benign 为良性。
 *   - writefile/save/mkdirall：任何 err 都非良性（数据未持久化）。默认分支。
 */

import fs from 'node:fs';
import type { TSEvent, ExtraFields } from './probe.js';
import { matchChainDecl, type TSChainObs } from './chain.js';

/** TS 侧 DSL 声明，与 schema definitions.DSLDecl 对齐。 */
export interface TSDLDecl {
  rule: string;
  probe?: string; // 空 = 全局声明
  expect?: string;
  constraint?: string;
  /** 链路契约（P2）：声明的调用序（探针名）。非空时走链路判定——声明的
   * 调用序必须是某条实测链的子序列（未声明的中间帧不算偏差）。 */
  chain?: string[];
}

/** TS 侧设计 DSL 文档（dsl.json）。 */
export interface TSDesignDSLDoc {
  version: number;
  updated_at: string;
  decls: TSDLDecl[];
}

/** 偏差类别，与 schema Deviation.kind 对齐（chain-broken 为 P2 链路契约断裂）。 */
export type DeviationKind = 'unobserved' | 'violated' | 'undesigned' | 'chain-broken';

/** TS 侧偏差，与 schema definitions.Deviation 对齐。 */
export interface TSDeviation {
  kind: DeviationKind;
  rule?: string;
  probe?: string;
  /** 链路级偏差：关联的实测链 trace id。 */
  trace_id?: string;
  /** 链路级偏差：实测链调用序列窗口。 */
  window?: string[];
  detail: string;
}

/** TS 侧偏差报告，与 schema definitions.DiffReport 对齐。 */
export interface TSDiffReport {
  generated_at: string;
  event_count: number;
  deviations: TSDeviation[];
  unobserved: number;
  violated: number;
  undesigned: number;
  /** 链路契约断裂数（P2）。 */
  chain_broken: number;
}

/** 违反判定谓词：event → {result, reason}。 */
export type RulePredicate = (ev: TSEvent) => { result: 'ok' | 'deviation'; reason: string };

/** 单探针观测画像（与 Go ProbeObs 对齐）。 */
export interface TSProbeObs {
  probe: string;
  count: number;
  errs: number;
  benigns: number;
  ops: string[];
  events: TSEvent[];
}

/** TS 判定哨兵：design(权威) vs actual(观测) → 三类偏差。 */
export class TSComparator {
  private preds = new Map<string, RulePredicate>();

  registerPredicate(rule: string, pred: RulePredicate): this {
    this.preds.set(rule, pred);
    return this;
  }

  registerDefaultPredicates(): this {
    this.preds.set('design:silent-error-discard', silentErrorDiscardTS);
    return this;
  }

  /** 读 dsl.json（权威设计 DSL）。文件不存在返回 null。 */
  static loadDesign(path: string): TSDesignDSLDoc | null {
    if (!fs.existsSync(path)) return null;
    return JSON.parse(fs.readFileSync(path, 'utf8')) as TSDesignDSLDoc;
  }

  /** 聚合观测事件为探针画像（与 Go Aggregator 对齐）。 */
  static aggregate(events: TSEvent[]): TSProbeObs[] {
    const byProbe = new Map<string, TSEvent[]>();
    for (const ev of events) {
      const list = byProbe.get(ev.probe) ?? [];
      list.push(ev);
      byProbe.set(ev.probe, list);
    }
    const probes: TSProbeObs[] = [];
    for (const [probe, evs] of [...byProbe.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      let errs = 0;
      let benigns = 0;
      const opSet = new Set<string>();
      for (const ev of evs) {
        if (typeof ev.fields['err'] === 'string' && ev.fields['err'] !== '') errs++;
        if (ev.fields['benign'] === true) benigns++;
        if (typeof ev.fields['op'] === 'string' && ev.fields['op'] !== '') opSet.add(ev.fields['op'] as string);
      }
      probes.push({ probe, count: evs.length, errs, benigns, ops: [...opSet], events: evs });
    }
    return probes;
  }

  /** 对比 design vs actual，产出三类偏差。语义与 Go Comparator 对齐。 */
/** 对比 design vs actual，产出四类偏差（含链路契约）。语义与 Go Comparator 逐段对齐。
   * chains：rebuildChains 重建的实测调用链（链路契约判定用；缺省 [] = 无链可判）。 */
  compare(design: TSDesignDSLDoc, actualObs: TSProbeObs[], chains: TSChainObs[] = []): TSDiffReport {
    const report: TSDiffReport = {
      generated_at: new Date().toISOString(),
      event_count: actualObs.reduce((n, p) => n + p.count, 0),
      deviations: [],
      unobserved: 0,
      violated: 0,
      undesigned: 0,
      chain_broken: 0,
    };

    const obsEvents = new Map<string, TSEvent[]>();
    for (const p of actualObs) obsEvents.set(p.probe, p.events);

    // 1. 设计声明的覆盖 + 违反检查
    for (const d of design.decls) {
      if (d.chain && d.chain.length > 0) continue; // 链路契约走第 3 段，不参与探针级判定
      const matched: TSEvent[] = [];
      if (!d.probe) {
        for (const evs of obsEvents.values()) matched.push(...evs);
      } else {
        matched.push(...(obsEvents.get(d.probe) ?? []));
      }
      if (matched.length === 0) {
        report.unobserved++;
        report.deviations.push({
          kind: 'unobserved',
          rule: d.rule,
          probe: d.probe,
          detail: '设计声明从未被观测到（该探针未触发/未覆盖）',
        });
        continue;
      }
      const pred = this.preds.get(d.rule);
      if (!pred) continue; // 无确定性谓词 → 不臆造违反（交 LLM 复核）
      for (const ev of matched) {
        const { result, reason } = pred(ev);
        if (result === 'deviation') {
          report.violated++;
          report.deviations.push({ kind: 'violated', rule: d.rule, probe: ev.probe, detail: reason });
        }
      }
    }

    // 2. 未声明探针（链路声明也算覆盖——根探针被声明即非末声明行为）
    for (const p of actualObs) {
      const covered = design.decls.some(
        (d) => !d.probe || d.probe === p.probe || (d.chain && d.chain.includes(p.probe)),
      );
      if (!covered) {
        report.undesigned++;
        report.deviations.push({
          kind: 'undesigned',
          probe: p.probe,
          detail: '观测到行为但没有对应设计声明（设计不完整/新探针）',
        });
      }
    }

    // 3. 链路契约（decl.chain 非空）：声明的调用序必须是某条实测链的子序列。
    //    根探针从未出现在任何链上 → 未观测；出现但序列不满足 → 链路断裂。
    for (const d of design.decls) {
      if (!d.chain || d.chain.length === 0) continue;
      const { satisfied, best } = matchChainDecl(d.chain, chains);
      if (satisfied) continue;
      if (!best) {
        report.unobserved++;
        report.deviations.push({
          kind: 'unobserved',
          rule: d.rule,
          probe: d.chain[0],
          detail: '链路契约的根探针从未在任何调用链上被观测到（该链路无任何调用）',
        });
        continue;
      }
      const missing = d.chain[best.matched];
      report.chain_broken++;
      report.deviations.push({
        kind: 'chain-broken',
        rule: d.rule,
        probe: d.chain[0],
        trace_id: best.chain.trace_id,
        window: best.chain.sequence,
        detail: `链路断裂：声明序 [${d.chain.join(' → ')}] 未被满足，自 "${missing}" 起缺失/乱序（前缀匹配 ${best.matched}/${d.chain.length}）`,
      });
    }

    // 稳定排序：未观测 → 违反/链路断裂 → 未声明（与 Go deviationRank 一致）
    const rank = (k: DeviationKind) => (k === 'unobserved' ? 0 : k === 'undesigned' ? 2 : 1);
    report.deviations.sort((a, b) => rank(a.kind) - rank(b.kind));
    return report;
  }
}

/** silent-error-discard 谓词的 TS 实现（与 Go 语义逐条对齐）。 */
export function silentErrorDiscardTS(ev: TSEvent): { result: 'ok' | 'deviation'; reason: string } {
  const errStr = ev.fields['err'];
  if (typeof errStr !== 'string' || errStr === '') {
    return { result: 'ok', reason: 'err is nil — nothing was discarded' };
  }
  const op = typeof ev.fields['op'] === 'string' ? (ev.fields['op'] as string) : '';
  switch (op) {
    case 'remove':
    case 'remove-tmp':
    case 'cleanup':
      if (ev.fields['benign'] === true) {
        return { result: 'ok', reason: 'benign: os.IsNotExist on cleanup — nothing to clean' };
      }
      return { result: 'deviation', reason: `cleanup error silently discarded: "${errStr}"` };
    default: // writefile / save / mkdirall — no error is benign
      return {
        result: 'deviation',
        reason: `non-benign error silently discarded (op=${op || '<none>'}): "${errStr}"`,
      };
  }
}

/** 渲染人类可读的偏差报告（与 Go RenderDiffReport 对齐）。 */
/** 渲染人类可读的偏差报告（与 Go RenderDiffReport 对齐，含链路断裂段）。 */
export function renderTSDiffReport(r: TSDiffReport): string {
  const lines: string[] = [
    `TS 哨兵偏差报告（actual vs design）：${r.event_count} 事件`,
    `  未观测 ${r.unobserved} · 违反 ${r.violated} · 未声明 ${r.undesigned} · 链路断裂 ${r.chain_broken}`,
  ];
  if (r.deviations.length === 0) {
    lines.push('  ✓ 设计声明与观测画像一致');
    return lines.join('\n');
  }
  lines.push('');
  lines.push('▎偏差明细');
  for (const d of r.deviations) {
    if (d.kind === 'unobserved') lines.push(`  [未观测]   rule=${d.rule} probe=${d.probe}`);
    else if (d.kind === 'violated') lines.push(`  [违反]     rule=${d.rule} probe=${d.probe}`);
    else if (d.kind === 'chain-broken') lines.push(`  [链路断裂] rule=${d.rule} 根=${d.probe} trace=${d.trace_id}`);
    else lines.push(`  [未声明]   probe=${d.probe}`);
    lines.push(`      ${d.detail}`);
    if (d.kind === 'chain-broken' && d.window && d.window.length > 0) {
      lines.push(`      实测链窗口: ${d.window.join(' → ')}`);
    }
  }
  return lines.join('\n');
}

/** 导出类型别名，方便调用方使用一致的 field 类型。 */
export type { ExtraFields };