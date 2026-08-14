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

/** TS 侧 DSL 声明，与 schema definitions.DSLDecl 对齐。 */
export interface TSDLDecl {
  rule: string;
  probe?: string; // 空 = 全局声明
  expect?: string;
  constraint?: string;
}

/** TS 侧设计 DSL 文档（dsl.json）。 */
export interface TSDesignDSLDoc {
  version: number;
  updated_at: string;
  decls: TSDLDecl[];
}

/** 偏差类别，与 schema Deviation.kind 对齐。 */
export type DeviationKind = 'unobserved' | 'violated' | 'undesigned';

/** TS 侧偏差，与 schema definitions.Deviation 对齐。 */
export interface TSDeviation {
  kind: DeviationKind;
  rule?: string;
  probe?: string;
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
  compare(design: TSDesignDSLDoc, actualObs: TSProbeObs[]): TSDiffReport {
    const report: TSDiffReport = {
      generated_at: new Date().toISOString(),
      event_count: actualObs.reduce((n, p) => n + p.count, 0),
      deviations: [],
      unobserved: 0,
      violated: 0,
      undesigned: 0,
    };

    const obsEvents = new Map<string, TSEvent[]>();
    for (const p of actualObs) obsEvents.set(p.probe, p.events);

    // 1. 设计声明的覆盖 + 违反检查
    for (const d of design.decls) {
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

    // 2. 未声明探针
    for (const p of actualObs) {
      const covered = design.decls.some((d) => !d.probe || d.probe === p.probe);
      if (!covered) {
        report.undesigned++;
        report.deviations.push({
          kind: 'undesigned',
          probe: p.probe,
          detail: '观测到行为但没有对应设计声明（设计不完整/新探针）',
        });
      }
    }

    // 稳定排序：unobserved → violated → undesigned
    const rank = (k: DeviationKind) => (k === 'unobserved' ? 0 : k === 'violated' ? 1 : 2);
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
export function renderTSDiffReport(r: TSDiffReport): string {
  const lines: string[] = [
    `TS 哨兵偏差报告（actual vs design）：${r.event_count} 事件`,
    `  未观测 ${r.unobserved} · 违反 ${r.violated} · 未声明 ${r.undesigned}`,
  ];
  if (r.deviations.length === 0) {
    lines.push('  ✓ 设计声明与观测画像一致');
    return lines.join('\n');
  }
  lines.push('');
  lines.push('▎偏差明细');
  for (const d of r.deviations) {
    if (d.kind === 'unobserved') lines.push(`  [未观测] rule=${d.rule} probe=${d.probe}`);
    else if (d.kind === 'violated') lines.push(`  [违反]   rule=${d.rule} probe=${d.probe}`);
    else lines.push(`  [未声明] probe=${d.probe}`);
    lines.push(`      ${d.detail}`);
  }
  return lines.join('\n');
}

/** 导出类型别名，方便调用方使用一致的 field 类型。 */
export type { ExtraFields };