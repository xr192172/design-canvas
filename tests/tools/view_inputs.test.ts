import { describe, it, expect } from 'vitest';
import { adaptIRTree } from '../../src/tools/archify_project';
import { deriveSemantics } from '../../src/tools/archify_semantics';
import { deriveViewInputs } from '../../src/tools/view_inputs';
import type { ArchifyTreeNode } from '../../src/tools/archify_project';

const tree: ArchifyTreeNode = {
  id: 'root', label: '系统',
  children: {
    nodes: [
      { id: '前端层', label: '前端层', role: 'frontend', children: { nodes: [{ id: 'ui1', label: 'UI', role: 'renderer', file: 'web/ui.ts', pins: { out: ['命令'] } }], edges: [] } },
      { id: '服务层', label: '服务层', role: 'service', children: { nodes: [{ id: 'sv1', label: 'API', role: 'controller', file: 'svc/api.ts', pins: { in: ['命令'], out: ['结果'] } }], edges: [] } },
      { id: '数据层', label: '数据层', role: 'data', children: { nodes: [{ id: 'db1', label: 'store', role: 'storage', file: 'db/store.ts', pins: { in: ['结果'] } }], edges: [] } },
    ],
    edges: [
      { id: 'e1', from: '前端层', to: '服务层', label: '调用', kind: 'flow' },
      { id: 'e2', from: '服务层', to: '数据层', label: '读写', kind: 'flow' },
    ],
  },
};

describe('deriveViewInputs 解耦层', () => {
  it('从真实语义派生 5 份中性渲染输入，且与 Archify 无关', () => {
    const sem = deriveSemantics(adaptIRTree(tree));
    const views = deriveViewInputs(sem);
    for (const t of ['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle'] as const) {
      expect(views[t].nodes.length).toBe(sem.nodes.length);
      expect(views[t].edges.length).toBe(sem.edges.length);
    }
    // architecture 首节点带 role（通用语义，非 archify 专属字段）
    expect(views.architecture.nodes[0].role).toBeTruthy();
    // dataflow 节点带依赖深度 stage
    expect(typeof views.dataflow.nodes[0].stage).toBe('number');
    // lifecycle 主路径首态=start
    const start = views.lifecycle.nodes.find((n) => n.stateRole === 'start');
    expect(start?.id).toBe(sem.mainPath[0]);
  });
});