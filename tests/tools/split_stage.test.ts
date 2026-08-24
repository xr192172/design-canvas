/**
 * split_stage 拆分执行器测试（signal_review 的最后一棒）
 *
 * 核心覆盖：
 * - collectAdoptedPlans：把 brickify 信号 + signal_review 复核结论，按下标对齐映射成
 *   "采纳簇 → 要抽取的符号"执行计划（review.reviews[i].adopt ↔ signal.clusters[i]）。
 * - 护栏：max_symbols 拦截超大簇（防误拆巨型工具簇）。
 * - 计划 file 的 source_root 前缀解析。
 */

import { describe, it, expect } from 'vitest';
import { collectAdoptedPlans, type SplitStagePlan } from '../../src/tools/split_stage';
import type { MixedFileSignal } from '../../src/tools/brickify';
import type { SignalReview } from '../../src/tools/signal_review';

const signals: MixedFileSignal[] = [
  {
    file: 'a/x.ts',
    clusters: [
      ['CONST_A'],
      ['FunB', 'TypeB'],
      ['Gate'],
    ],
    reason: 'x',
  },
  {
    file: 'a/y.ts',
    clusters: [['LegacyType', 'LegacyStage'], ['V2System']],
    reason: 'y',
  },
];

const reviews: SignalReview[] = [
  {
    file: 'a/x.ts',
    actionable: true,
    reviews: [
      { cluster: '常量A', adopt: false, feature: '', reason: 'r', evidence: 'e' },
      { cluster: '核心B', adopt: false, feature: '', reason: 'r', evidence: 'e' },
      { cluster: '限流门控', adopt: true, feature: 'ExportGate', reason: '独立演进', evidence: 'e' },
    ],
  },
  {
    file: 'a/y.ts',
    actionable: true,
    reviews: [
      { cluster: '旧版类型', adopt: true, feature: 'legacy-types', reason: '文档明言旧版', evidence: 'e' },
      { cluster: 'V2系统', adopt: false, feature: '', reason: 'r', evidence: 'e' },
    ],
  },
];

describe('collectAdoptedPlans', () => {
  it('把复核采纳簇按与信号簇同一下标对齐，映射出可抽取符号计划', () => {
    const plans: SplitStagePlan[] = collectAdoptedPlans(signals, reviews);
    expect(plans).toHaveLength(2);
    expect(plans[0]).toMatchObject({ file: 'a/x.ts', feature: 'ExportGate', symbols: ['Gate'] });
    expect(plans[1]).toMatchObject({ file: 'a/y.ts', feature: 'legacy-types', symbols: ['LegacyType', 'LegacyStage'] });
  });

  it('采纳簇无 feature 时按默认 __split 命名（由 planNewFile 兜底）', () => {
    const r2: SignalReview = {
      file: 'a/y.ts',
      actionable: true,
      reviews: [
        { cluster: '旧版类型', adopt: true, feature: '', reason: 'r', evidence: 'e' },
        { cluster: 'V2', adopt: false, feature: '', reason: 'r', evidence: 'e' },
      ],
    };
    const plans = collectAdoptedPlans([signals[1]], [r2]);
    expect(plans[0].feature).toBe('');
  });

  it('max_symbols 护栏拦截超大簇（防误拆巨型工具簇）', () => {
    const plans = collectAdoptedPlans(signals, reviews, 1);
    // ExportGate(1符号) 通过；LegacyType+LegacyStage(2符号) 被拦截
    expect(plans).toHaveLength(1);
    expect(plans[0].file).toBe('a/x.ts');
  });

  it('复核失败/未复核的信号（下标不齐）不产生计划', () => {
    // review.reviews 长度与 signal.clusters 不一致 → 该文件整体跳过
    const badReview: SignalReview = { file: 'a/x.ts', actionable: true, reviews: [] };
    const plans = collectAdoptedPlans([signals[0]], [badReview]);
    expect(plans).toHaveLength(0);
  });
});