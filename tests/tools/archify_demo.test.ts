/**
 * archify_pipeline 生产管线测试：一份语义面 → 5 类 showcase 图（各一张）
 *
 * 诚实降级锚定：
 *   1. ARCHIFY_ROOT 未装配 → 5 项均 delivered:false、note 如实说明（不假装成功）；
 *   2. 输入逐字节不变（派生只读，绝不写回编辑真源）；
 *   3. candidate 含官方 schema 必填字段（validate 可跑的第一步）；
 *   4. 输入不适配某类型（缺主路径/终态）→ 该类型返回"不适配"说明，不影响其余类型。
 */
import { describe, it, expect } from 'vitest';
import { runArchifyPipeline } from '../../src/tools/archify_pipeline';
import type { ArchifyTreeNode } from '../../src/tools/archify_project';

const tree: ArchifyTreeNode = {
  id: 'v1',
  label: 'design-canvas 能力面',
  children: {
    nodes: [
      {
        id: 'mcp', label: 'MCP 入口', role: 'service',
        children: { nodes: [{ id: 'mcp_s', label: '注册工具', role: 'step', pins: { in: ['请求'], out: ['工具集'] }, file: 'src/server.ts' }], edges: [] },
      },
      {
        id: 'dsl', label: '双层 DSL', role: 'contract',
        children: { nodes: [{ id: 'dsl_s', label: '校验锚定', role: 'step', pins: { in: ['DSL'], out: ['合法DSL'] }, file: 'src/dsl/validator.ts' }], edges: [] },
      },
      {
        id: 'ai', label: 'AI 分析', role: 'backend',
        children: { nodes: [{ id: 'ai_s', label: '语义搜索', role: 'step', pins: { in: ['符号表'], out: ['命中'] }, file: 'src/tools/semantic_search.ts' }], edges: [] },
      },
    ],
    edges: [
      { id: 'e1', from: 'mcp', to: 'dsl', label: '调用', kind: 'flow' },
      { id: 'e2', from: 'dsl', to: 'ai', label: '读语义', kind: 'flow' },
    ],
  },
};

describe('runArchifyPipeline 诚实降级（未装配）', () => {
  it('ARCHIFY_ROOT 未配置 → 5 类型均 delivered:false，note 如实说明', () => {
    const before = JSON.stringify(tree);
    const r = runArchifyPipeline({ ir: tree, archifyRoot: '' });
    expect(r.manifest).toHaveLength(5);
    expect(r.manifest.every((m) => m.delivered === false)).toBe(true);
    for (const m of r.manifest) {
      expect(m.note).toContain('ARCHIFY_ROOT 未配置');
    }
    expect(r.delivered).toBe(false);
    // 输入逐字节不变（派生只读）
    expect(JSON.stringify(tree)).toBe(before);
  });

  it('每类 candidate 含官方 schema 必填字段（可 validate 的第一步）', () => {
    const r = runArchifyPipeline({ ir: tree, archifyRoot: '' });
    const arc = r.manifest.find((m) => m.type === 'architecture')!.candidate as any;
    expect(arc.diagram_type).toBe('architecture');
    expect(Array.isArray(arc.components)).toBe(true);
    expect(arc.components.length).toBeGreaterThanOrEqual(1);
    expect(arc.meta.quality_profile).toBe('showcase');
    const wf = r.manifest.find((m) => m.type === 'workflow')!.candidate as any;
    expect(wf.diagram_type).toBe('workflow');
    expect(wf.schema_version).toBe(2);
    expect(Array.isArray(wf.lanes) && Array.isArray(wf.nodes) && Array.isArray(wf.edges)).toBe(true);
  });

  it('主路径：语义面收敛出 3 节点 + 一条沿边主路径', () => {
    const r = runArchifyPipeline({ ir: tree, archifyRoot: '' });
    const arc = r.manifest.find((m) => m.type === 'architecture')!.candidate as any;
    const ids = arc.components.map((c: any) => c.id);
    expect(ids.sort()).toEqual(['ai', 'dsl', 'mcp'].sort());
    const wf = r.manifest.find((m) => m.type === 'workflow')!.candidate as any;
    expect(wf.mainPath).toEqual(['mcp', 'dsl', 'ai']);
  });
});

describe('runArchifyPipeline 不适配降级', () => {
  it('单节点输入：sequence/dataflow/lifecycle 返回"不适配"，architecture/workflow 仍出 candidate', () => {
    const single: ArchifyTreeNode = { id: 'x', label: '孤立节点', children: { nodes: [{ id: 'n0', label: '唯一', role: 'service', pins: { out: ['x'] } }], edges: [] } };
    const r = runArchifyPipeline({ ir: single, archifyRoot: '' });
    for (const t of ['sequence', 'dataflow', 'lifecycle'] as const) {
      const m = r.manifest.find((x) => x.type === t)!;
      expect(m.note).toContain('不适配');
    }
    for (const t of ['architecture', 'workflow'] as const) {
      const m = r.manifest.find((x) => x.type === t)!;
      expect(m.candidate).toBeTruthy();
    }
  });
});