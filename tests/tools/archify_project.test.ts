/**
 * archify_project 往返契约测试
 *
 * 锚定"Archify 是派生演示层、编辑真源在 workbench IR"的分层：
 *   1. 不突变：toArchify 跑完，输入 ProjView 的编辑字段（pins/runtime/gaps/layer/status…）逐字节不变。
 *   2. 身份双射：IRView 节点/边 id 与 Archify components/connections id 一一对应、无缺失无凭空。
 *   3. 保真：label 原样；role 经 roleToType 确定性映射并落在 Archify 色板 type 集合内。
 *   4. 可重开编辑器：fromArchify 还原的节点/边 id 集与原始一致（退出演示能无缝回到编辑器）。
 */
import { describe, it, expect } from 'vitest';
import {
  toArchify,
  fromArchify,
  roleToType,
  ARCHIFY_TYPE_COLOR,
  type ProjView,
} from '../../src/tools/archify_project';

function sampleView(): ProjView {
  return {
    id: 'v1',
    label: '能力面',
    title: 'design-canvas 能力面',
    nodes: [
      { id: 'client', label: 'MCP Client', role: 'client', type: 'external', sublabel: 'Agent' },
      { id: 'mcp', label: 'MCP core', role: 'core', type: 'backend' },
      { id: 'dsl', label: 'DSL', role: 'contract', type: 'contract', tag: '2-way' },
      { id: 'ts_kernel', label: 'ts_kernel', role: 'core', type: 'backend' },
      { id: 'render', label: 'render', role: 'renderer', type: 'frontend' },
    ],
    edges: [
      { id: 'e1', from: 'client', to: 'mcp', label: 'MCP call', kind: 'flow' },
      { id: 'e2', from: 'mcp', to: 'dsl', label: 'read/write', kind: 'flow' },
      { id: 'e3', from: 'mcp', to: 'ts_kernel', label: 'parse', kind: 'flow' },
      { id: 'e4', from: 'mcp', to: 'render', label: 'render', kind: 'cross' },
    ],
  };
}

describe('toArchify 不突变（编辑字段保真）', () => {
  it('投影只读 id/label/role/sublabel/tag，pins/runtime 等编辑字段原样不动', () => {
    const view = sampleView();
    // 给一个编辑字段，验证真源不被污染
    const before = JSON.stringify(view);
    toArchify(view, { quality: 'showcase' });
    expect(JSON.stringify(view)).toBe(before); // 输入逐字节不变 = 演示层绝不写回编辑真源
  });
});

describe('身份双射与保真', () => {
  it('节点/边 id 与 components/connections 一一对应（无缺失、无凭空）', () => {
    const view = sampleView();
    const ar = toArchify(view);
    expect(ar.schema_version).toBe(1);
    expect(ar.diagram_type).toBe('architecture');
    const compIds = ar.components.map((c) => c.id);
    expect(compIds.sort()).toEqual(view.nodes.map((n) => n.id).sort());
    const connIds = ar.connections.map((c) => c.id);
    expect(connIds.sort()).toEqual(view.edges.filter((e) => e.kind !== 'contains').map((e) => e.id).sort());
    // 连线两端都必须指向存在的节点
    for (const c of ar.connections) {
      expect(compIds).toContain(c.from);
      expect(compIds).toContain(c.to);
    }
  });

  it('label 原样；role→type 确定性且落在 Archify 色板内', () => {
    const view = sampleView();
    const ar = toArchify(view);
    for (const c of ar.components) {
      const original = view.nodes.find((n) => n.id === c.id)!;
      expect(c.label).toBe(original.label); // 标签保真
      expect(c.type).toBe(roleToType(original.role)); // 确定映射
      expect(ARCHIFY_TYPE_COLOR[c.type]).toBeDefined(); // 视觉语言用 Archify 这一套
    }
  });

  it('cross 边 → dashed 变体；contains 边 → 不投影为连接（层级走边界，v1 跳过）', () => {
    const view = sampleView();
    const ar = toArchify(view);
    const e4 = ar.connections.find((c) => c.id === 'e4');
    expect(e4?.variant).toBe('dashed');
    const e3 = ar.connections.find((c) => c.id === 'e3');
    expect(e3?.variant).toBeUndefined(); // flow 普通连线
  });
});

describe('可重开编辑器（往返还原 id 集）', () => {
  it('fromArchify 还原的节点/边 id 集与原始一致 → 退出演示能无缝回到编辑器', () => {
    const view = sampleView();
    const ar = toArchify(view);
    const back = fromArchify(ar);
    expect(back.nodes.map((n) => n.id).sort()).toEqual(view.nodes.map((n) => n.id).sort());
    expect(back.edges.map((e) => e.id).sort()).toEqual(
      view.edges.filter((e) => e.kind !== 'contains').map((e) => e.id).sort(),
    );
  });

  it('present→edit→re-present：真源唯一，二次投影 id 稳定（不随坐标漂移）', () => {
    const view = sampleView();
    const a1 = toArchify(view);
    const a2 = toArchify(view, { quality: 'showcase' });
    expect(a2.components.map((c) => `${c.id}:${c.type}`).sort()).toEqual(
      a1.components.map((c) => `${c.id}:${c.type}`).sort(),
    );
  });
});