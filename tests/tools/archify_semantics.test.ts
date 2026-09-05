/**
 * archify_semantics 语义面测试：从编辑 IR 树收敛成 ≤12 主节点 + 主路径 + 稀疏语义边 + 中文标签
 */
import { describe, it, expect } from 'vitest';
import { adaptIRTree } from '../../src/tools/archify_project';
import { deriveSemantics, legalNodeId } from '../../src/tools/archify_semantics';
import type { ArchifyTreeNode } from '../../src/tools/archify_project';

const tree: ArchifyTreeNode = {
  id: 'root',
  label: '能力面',
  children: {
    nodes: [
      { id: '前端层', label: '前端层', role: 'frontend', children: { nodes: [{ id: 'ui1', label: 'UI', role: 'renderer', file: 'src/ui.ts' }], edges: [] } },
      { id: '服务层', label: '服务层', role: 'service', children: { nodes: [{ id: 'sv1', label: 'API', role: 'controller', file: 'src/api.ts' }], edges: [] } },
      { id: '数据层', label: '数据层', role: 'data', children: { nodes: [{ id: 'db1', label: 'store', role: 'storage', file: 'src/store.ts' }], edges: [] } },
    ],
    edges: [
      { id: 'e1', from: '前端层', to: '服务层', label: '调用', kind: 'flow' },
      { id: 'e2', from: '服务层', to: '数据层', label: '读写', kind: 'flow' },
    ],
  },
};

describe('deriveSemantics', () => {
  it('收敛出 ≤12 主节点、id 合法化、中文 label 保留', () => {
    const sem = deriveSemantics(adaptIRTree(tree));
    expect(sem.nodes).toHaveLength(3);
    for (const n of sem.nodes) {
      expect(/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(n.id)).toBe(true);
      expect(n.label).toBeTruthy();
    }
    // 非法 id "前端层" → 合法转义 n0，label 仍是中文
    const first = sem.nodes[0];
    expect(first.id).toMatch(/^n\d+$/);
    expect(first.label).toBe('前端层');
    expect(first.type).toBe('frontend');
  });

  it('主路径：沿边的一条拓扑单调链', () => {
    const sem = deriveSemantics(adaptIRTree(tree));
    expect(sem.mainPath.length).toBeGreaterThanOrEqual(3);
    // 主路径相邻节点必须在 edges 里有同一方向边
    for (let i = 0; i < sem.mainPath.length - 1; i += 1) {
      expect(sem.edges.some((e) => e.from === sem.mainPath[i] && e.to === sem.mainPath[i + 1])).toBe(true);
    }
  });

  it('边两端都指向存在的主节点', () => {
    const sem = deriveSemantics(adaptIRTree(tree));
    const ids = new Set(sem.nodes.map((n) => n.id));
    for (const e of sem.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });
});

describe('legalNodeId', () => {
  it('合法 id 保留、非法 id 稳定转义 n{i}', () => {
    expect(legalNodeId('hello', 3)).toBe('hello');
    expect(legalNodeId('前端层', 0)).toBe('n0');
    expect(legalNodeId('a.b', 5)).toBe('n5');
    expect(legalNodeId('_x', 1)).toBe('n1');
  });
});