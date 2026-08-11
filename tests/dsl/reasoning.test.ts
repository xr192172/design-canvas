import { describe, it, expect } from 'vitest';
import { validateDSL } from '../../src/dsl/validator';
import type { DesignDSL } from '../../src/dsl/types';

/** 构造一个带 reasoning 的最小合法 DSL */
function makeWithReasoning(): DesignDSL {
  return {
    id: 'agent_demo',
    type: 'feature_diagram',
    feature: 'agent',
    geometry: {
      layout: 'free',
      nodes: [
        { id: 'node_entry', x: 0, y: 0, width: 120, height: 40, label: '入口' },
        { id: 'node_l0', x: 0, y: 60, width: 120, height: 40, label: 'L0' },
        { id: 'node_retrieve', x: 0, y: 120, width: 120, height: 40, label: 'Retrieve' },
        { id: 'node_fold', x: 0, y: 180, width: 120, height: 40, label: '折叠' },
      ],
      edges: [
        { id: 'e1', from: 'node_entry', to: 'node_l0' },
        { id: 'e2', from: 'node_l0', to: 'node_retrieve' },
      ],
    },
    reasoning: {
      version: 1,
      entry: { label: '用户输入: 分析依赖', node: 'node_entry' },
      budget: { max_tokens: 8000, fold_at: 0.8 },
      steps: [
        {
          id: 's1',
          node: 'node_l0',
          kind: 'think',
          tokens: 300,
          reasoning: '读取系统身份与工具清单',
          output: '身份就绪',
        },
        {
          id: 's2',
          node: 'node_retrieve',
          kind: 'tool',
          tokens: 1200,
          reasoning: '调用 memory_retrieve 检索',
          output: '召回 3 段知识',
          api: 'Retrieve',
        },
      ],
      folds: [
        {
          at_step: 2,
          node: 'node_fold',
          kind: 'summarize',
          summary: '前 2 步已总结为摘要',
          folded: ['s1', 's2'],
        },
      ],
    },
  };
}

describe('validateDSL - reasoning 合法', () => {
  it('带 reasoning 的最小 DSL 通过校验', () => {
    const result = validateDSL(makeWithReasoning());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('无 folds 的 reasoning 通过校验', () => {
    const dsl = makeWithReasoning();
    delete dsl.reasoning!.folds;
    const result = validateDSL(dsl);
    expect(result.valid).toBe(true);
  });

  it('无 budget 的 reasoning 通过校验', () => {
    const dsl = makeWithReasoning();
    delete dsl.reasoning!.budget;
    const result = validateDSL(dsl);
    expect(result.valid).toBe(true);
  });
});

describe('validateDSL - reasoning 引用完整性', () => {
  it('entry.node 在 nodes 中找不到报错', () => {
    const dsl = makeWithReasoning();
    dsl.reasoning!.entry.node = 'ghost_entry';
    const result = validateDSL(dsl);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('reasoning_entry_broken'))).toBe(true);
  });

  it('step.node 在 nodes 中找不到报错', () => {
    const dsl = makeWithReasoning();
    dsl.reasoning!.steps[0].node = 'ghost_step';
    const result = validateDSL(dsl);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('reasoning_step_node_broken'))).toBe(true);
  });

  it('steps.id 重复报错', () => {
    const dsl = makeWithReasoning();
    dsl.reasoning!.steps[1].id = 's1';
    const result = validateDSL(dsl);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('reasoning_dup_step'))).toBe(true);
  });

  it('folds.at_step 超出范围报错', () => {
    const dsl = makeWithReasoning();
    dsl.reasoning!.folds![0].at_step = 99;
    const result = validateDSL(dsl);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('reasoning_fold_range'))).toBe(true);
  });

  it('folds.node 在 nodes 中找不到报错', () => {
    const dsl = makeWithReasoning();
    dsl.reasoning!.folds![0].node = 'ghost_fold';
    const result = validateDSL(dsl);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('reasoning_fold_node_broken'))).toBe(true);
  });

  it('folds.folded 引用不存在的 step 报错', () => {
    const dsl = makeWithReasoning();
    dsl.reasoning!.folds![0].folded = ['s1', 'no_such_step'];
    const result = validateDSL(dsl);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('reasoning_fold_step_broken'))).toBe(true);
  });
});

describe('validateDSL - reasoning schema 校验', () => {
  it('缺 entry 报错', () => {
    const dsl = makeWithReasoning();
    delete dsl.reasoning!.entry;
    const result = validateDSL(dsl);
    expect(result.valid).toBe(false);
  });

  it('缺 steps 报错', () => {
    const dsl = makeWithReasoning();
    delete dsl.reasoning!.steps;
    const result = validateDSL(dsl);
    expect(result.valid).toBe(false);
  });

  it('step 缺 tokens 报错', () => {
    const dsl = makeWithReasoning();
    delete (dsl.reasoning!.steps[0] as Partial<{ tokens: number }>).tokens;
    const result = validateDSL(dsl);
    expect(result.valid).toBe(false);
  });

  it('step.kind 非法值报错', () => {
    const dsl = makeWithReasoning();
    (dsl.reasoning!.steps[0] as { kind: string }).kind = 'invalid_kind';
    const result = validateDSL(dsl);
    expect(result.valid).toBe(false);
  });
});