import { describe, it, expect } from 'vitest';
import { applyDecisionWrite } from '../../src/tools/node_ops.js';
import type { NodeDecision } from '../../src/dsl/types.js';

describe('applyDecisionWrite —— 决策写入纯函数（缺扣① 作者/时间线）', () => {
  const NOW = '2026-09-05T09:00:00.000Z';
  const first: NodeDecision = { summary: '初版结论' };
  const second: NodeDecision = { summary: '翻案后的结论', rationale: '有新数据' };

  it('首版（无旧版）：新决策打 updated_at；author 传入才打；不压栈', () => {
    const r = applyDecisionWrite(undefined, undefined, first, { author: 'human', now: NOW });
    expect(r.decision?.summary).toBe('初版结论');
    expect(r.decision?.updated_at).toBe(NOW);
    expect(r.decision?.author).toBe('human');
    expect(r.decision_history).toBeUndefined();
  });

  it('author 未传 → 不伪造 author，但仍打时间戳', () => {
    const r = applyDecisionWrite(undefined, undefined, first, { now: NOW });
    expect(r.decision?.author).toBeUndefined();
    expect(r.decision?.updated_at).toBe(NOW);
  });

  it('修订（有旧版）：旧版压栈带 at/note/author，新决策成为当前版', () => {
    const r = applyDecisionWrite(first, undefined, second, { author: 'human', note: '反案理由', now: NOW });
    expect(r.decision?.summary).toBe('翻案后的结论');
    expect(r.decision?.updated_at).toBe(NOW);
    expect(r.decision_history).toHaveLength(1);
    expect(r.decision_history![0].at).toBe(NOW);
    expect(r.decision_history![0].note).toBe('反案理由');
    expect(r.decision_history![0].author).toBe('human');
    expect(r.decision_history![0].decision.summary).toBe('初版结论');
  });

  it('连续修订：历史栈累积，旧版均不丢', () => {
    const r1 = applyDecisionWrite(first, undefined, second, { author: 'human', now: NOW });
    const r2 = applyDecisionWrite(second, r1.decision_history, { summary: '最终定稿' }, { author: 'llm', now: NOW });
    expect(r2.decision_history).toHaveLength(2);
    expect(r2.decision_history![0].decision.summary).toBe('初版结论');
    expect(r2.decision_history![1].decision.summary).toBe('翻案后的结论');
    expect(r2.decision_history![1].author).toBe('llm');
    expect(r2.decision?.updated_at).toBe(NOW);
  });

  it('next=null → 清除决策与历史', () => {
    const r = applyDecisionWrite(first, [{ at: NOW, decision: first }], null, { now: NOW });
    expect(r.decision).toBeUndefined();
    expect(r.decision_history).toBeUndefined();
  });

  it('next=undefined → 原样返回，不改写', () => {
    const r = applyDecisionWrite(first, undefined, undefined, { now: NOW });
    expect(r.decision).toBe(first);
    expect(r.decision_history).toBeUndefined();
  });
});