/**
 * 数据流追踪核心逻辑测试（L5a 静态推演）
 *
 * 覆盖：
 * - mockValue：各类型 schema → 示例值（string/number/integer/boolean/array/object/null）
 * - buildDataTrace：detail 子图（链边 + 跳边）→ 步骤序列 + in/out 值传递 + 分流标注
 * - 无调用链 / 环路防御
 */

import { describe, it, expect } from 'vitest';
import { mockValue, buildDataTrace, collectJudgements } from '../../src/renderer/dataflow_core';

// ─────────────────────────────────────────────────────────────
// mockValue
// ─────────────────────────────────────────────────────────────

describe('mockValue - schema → 示例值', () => {
  it('基本类型', () => {
    expect(mockValue({ type: 'string' })).toBe('示例文本');
    expect(mockValue({ type: 'string', label: '令牌' })).toBe('示例令牌');
    expect(mockValue({ type: 'number' })).toBe(42.5);
    expect(mockValue({ type: 'integer' })).toBe(7);
    expect(mockValue({ type: 'boolean' })).toBe(true);
    expect(mockValue({ type: 'null' })).toBeNull();
  });

  it('array：递归生成两个示例项', () => {
    expect(mockValue({ type: 'array', items: { type: 'integer' } })).toEqual([7, 7]);
    expect(mockValue({ type: 'array' })).toEqual([null, null]);
  });

  it('object：properties 逐字段递归', () => {
    const v = mockValue({
      type: 'object',
      properties: { id: { type: 'integer' }, name: { type: 'string' } },
    });
    expect(v).toEqual({ id: 7, name: '示例文本' });
  });

  it('object 无 properties：label 兜底', () => {
    expect(mockValue({ type: 'object', label: 'Composition' })).toEqual({ Composition: '值' });
    expect(mockValue({ type: 'object' })).toEqual({ 示例: '值' });
  });

  it('非法/缺省 → null', () => {
    expect(mockValue(null)).toBeNull();
    expect(mockValue(undefined)).toBeNull();
    expect(mockValue({ type: 'unknown_xyz' })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// buildDataTrace
// ─────────────────────────────────────────────────────────────

function fixtureNodes() {
  return [
    {
      id: 'host__s1_Entry',
      label: '① Entry',
      layer: 'detail',
      host: 'host',
      shapes: {
        in: { type: 'object', properties: { token: { type: 'string' } } },
        out: { type: 'string' },
      },
    },
    {
      id: 'host__s2_stepA',
      label: '② stepA',
      layer: 'detail',
      host: 'host',
      shapes: { in: { type: 'string' }, out: { type: 'integer' } },
    },
    {
      id: 'host__s3_stepB',
      label: '③ stepB',
      layer: 'detail',
      host: 'host',
      shapes: { in: { type: 'integer' }, out: { type: 'boolean' } },
    },
  ];
}

function fixtureEdges() {
  return [
    { id: 'host__chain_1', from: 'host__s1_Entry', to: 'host__s2_stepA' },
    { id: 'host__chain_2', from: 'host__s2_stepA', to: 'host__s3_stepB' },
    { id: 'host__branch_j1', from: 'host__s1_Entry', to: 'host__s3_stepB', label: '分支', type: 'dashed' },
  ];
}

// ─────────────────────────────────────────────────────────────
// collectJudgements - CFG 判定提取
// ─────────────────────────────────────────────────────────────

function cfgFixture() {
  const nodes = [
    { id: 'host__alg_n1', label: '▶ Compose', style: { shape: 'circle' }, description: 'entry · 源码第 1 行' },
    { id: 'host__alg_n2', label: '检查预算', style: { shape: 'diamond' }, description: 'branch · 源码第 8 行\n条件：over == true' },
    { id: 'host__alg_n3', label: '返回错误', style: { shape: 'rounded' } },
    { id: 'host__alg_n4', label: '组装', style: { shape: 'rounded' } },
    { id: 'host__alg_n5', label: '遍历 sections', style: { shape: 'hexagon' }, description: 'loop · 源码第 12 行\n条件：i < len(sections)' },
    { id: 'host__alg_n6', label: '结束', style: { shape: 'circle' } },
  ];
  const edges = [
    { id: 'host__alge_0', from: 'host__alg_n1', to: 'host__alg_n2' },
    { id: 'host__alge_1', from: 'host__alg_n2', to: 'host__alg_n3', label: '是' },
    { id: 'host__alge_2', from: 'host__alg_n2', to: 'host__alg_n4', label: '否' },
    { id: 'host__alge_3', from: 'host__alg_n4', to: 'host__alg_n5' },
    { id: 'host__alge_4', from: 'host__alg_n5', to: 'host__alg_n6', label: '重复' },
  ];
  return { nodes, edges };
}

describe('collectJudgements - CFG 判定精确化', () => {
  it('按 entry ▶函数名 关联，收集 branch/loop 的条件与走向', () => {
    const { nodes, edges } = cfgFixture();
    const js = collectJudgements(nodes, edges, 'host', 'Compose');

    expect(js).toHaveLength(2);
    // branch：条件原文 + 是/否走向
    expect(js[0].cond).toBe('over == true');
    expect(js[0].branches).toEqual([
      { via: '是', to: '返回错误' },
      { via: '否', to: '组装' },
    ]);
    // loop：嵌套判定也收集（BFS 深入）
    expect(js[1].cond).toBe('i < len(sections)');
    expect(js[1].branches[0].via).toBe('重复');
  });

  it('无 CFG（宿主无 __alg_ 节点）→ 空', () => {
    expect(collectJudgements([], [], 'host', 'Compose')).toEqual([]);
    expect(collectJudgements(cfgFixture().nodes, [], 'host', 'Compose')).toEqual([]);
  });

  it('entry 不存在（函数名不匹配）→ 空', () => {
    const { nodes, edges } = cfgFixture();
    expect(collectJudgements(nodes, edges, 'host', 'Ghost')).toEqual([]);
  });

  it('无 host/funcName → 空', () => {
    const { nodes, edges } = cfgFixture();
    expect(collectJudgements(nodes, edges, '', 'Compose')).toEqual([]);
    expect(collectJudgements(nodes, edges, 'host', '')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// buildDataTrace
// ─────────────────────────────────────────────────────────────

describe('buildDataTrace - 沿调用链推演', () => {
  it('链式传递：上一步 out → 下一步 in；跳边标注分流', () => {
    const trace = buildDataTrace(fixtureNodes(), fixtureEdges(), 'host__s1_Entry', { token: 'abc' });

    expect(trace.steps.map((s) => s.nodeId)).toEqual(['host__s1_Entry', 'host__s2_stepA', 'host__s3_stepB']);
    // 第一步：用户注入值 → 入口 in；out = mock(shapes.out=string)
    expect(trace.steps[0].inValue).toEqual({ token: 'abc' });
    expect(trace.steps[0].outValue).toBe('示例文本');
    // 分流标注：Entry 有跳边 → stepB
    expect(trace.steps[0].note).toContain('数据分流');
    expect(trace.steps[0].note).toContain('stepB');
    // 第二步：in = 上一步 out；out = mock(integer)
    expect(trace.steps[1].inValue).toBe('示例文本');
    expect(trace.steps[1].outValue).toBe(7);
    // 第三步
    expect(trace.steps[2].inValue).toBe(7);
    expect(trace.steps[2].outValue).toBe(true);
    // 跳边高亮列表
    expect(trace.branchEdgeIds).toEqual(['host__branch_j1']);
  });

  it('节点无 shapes.out → out 继承 in（透传）', () => {
    const nodes = [
      { id: 'h__s1_A', label: 'A', layer: 'detail', host: 'h' },
      { id: 'h__s2_B', label: 'B', layer: 'detail', host: 'h', shapes: { out: { type: 'integer' } } },
    ];
    const edges = [{ id: 'h__chain_1', from: 'h__s1_A', to: 'h__s2_B' }];
    const trace = buildDataTrace(nodes, edges, 'h__s1_A', 99);
    expect(trace.steps[0].outValue).toBe(99); // 无 out schema → 继承 in
    expect(trace.steps[1].inValue).toBe(99);
    expect(trace.steps[1].outValue).toBe(7);
  });

  it('入口不存在 → 空轨迹', () => {
    expect(buildDataTrace(fixtureNodes(), fixtureEdges(), 'ghost', 1).steps).toEqual([]);
  });

  it('无调用链（单节点无链边）→ 只含入口一步', () => {
    const nodes = [{ id: 'h__s1_A', label: 'A', layer: 'detail', host: 'h' }];
    const trace = buildDataTrace(nodes, [], 'h__s1_A', { x: 1 });
    expect(trace.steps).toHaveLength(1);
    expect(trace.branchEdgeIds).toEqual([]);
  });

  it('环路防御：异常数据不死循环', () => {
    // 人为构造环（derive 正常不会生成，防御测试）
    const nodes = [
      { id: 'h__s1_A', label: 'A', layer: 'detail', host: 'h' },
      { id: 'h__s2_B', label: 'B', layer: 'detail', host: 'h' },
    ];
    const edges = [
      { id: 'h__chain_1', from: 'h__s1_A', to: 'h__s2_B' },
      { id: 'h__chain_2', from: 'h__s2_B', to: 'h__s1_A' },
    ];
    const trace = buildDataTrace(nodes, edges, 'h__s1_A', 1);
    expect(trace.steps).toHaveLength(2); // A → B 后终止（visited）
  });

  it('main 层节点无 detail 链 → 只有入口一步（无链可追）', () => {
    const nodes = [
      { id: 'n1', label: 'N1' },
      { id: 'n2', label: 'N2' },
    ];
    const edges = [{ id: 'e1', from: 'n1', to: 'n2' }];
    const trace = buildDataTrace(nodes, edges, 'n1', 1);
    expect(trace.steps).toHaveLength(1);
    expect(trace.steps[0].nodeId).toBe('n1');
    expect(trace.branchEdgeIds).toEqual([]);
  });
});
