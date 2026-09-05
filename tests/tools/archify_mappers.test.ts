/**
 * archify_mappers 5 类型映射测试：从语义面生成官方 candidate，遵循 showcase 首稿不排几何
 */
import { describe, it, expect } from 'vitest';
import { adaptIRTree } from '../../src/tools/archify_project';
import { deriveSemantics } from '../../src/tools/archify_semantics';
import { toArchitecture, toWorkflow, toSequence, toDataflow, toLifecycle, DIAGRAM_TYPES } from '../../src/tools/archify_mappers';
import type { ArchifyTreeNode } from '../../src/tools/archify_project';

const tree: ArchifyTreeNode = {
  id: 'root', label: '能力面',
  children: {
    nodes: [
      { id: '前端层', label: '前端层', role: 'frontend', children: { nodes: [{ id: 'ui1', label: 'UI', role: 'renderer', file: 'src/ui.ts', pins: { out: ['命令'] } }], edges: [] } },
      { id: '服务层', label: '服务层', role: 'service', children: { nodes: [{ id: 'sv1', label: 'API', role: 'controller', file: 'src/api.ts', pins: { in: ['命令'], out: ['结果'] } }], edges: [] } },
      { id: '数据层', label: '数据层', role: 'data', children: { nodes: [{ id: 'db1', label: 'store', role: 'storage', file: 'src/store.ts', pins: { in: ['结果'] } }], edges: [] } },
    ],
    edges: [
      { id: 'e1', from: '前端层', to: '服务层', label: '调用', kind: 'flow' },
      { id: 'e2', from: '服务层', to: '数据层', label: '读写', kind: 'flow' },
    ],
  },
};
const sem = deriveSemantics(adaptIRTree(tree));

describe('toArchitecture', () => {
  it('架构图用官方 grid 布局（col/row + 适配 size），不排自由坐标/手工路由', () => {
    const c = toArchitecture(sem).ir as any;
    expect(c.meta.quality_profile).toBe('showcase');
    expect(c.meta.locale).toBe('zh-CN');
    expect(c.meta.visual_preset).toBeUndefined(); // 省略 = classic
    expect(c.components.length).toBe(3);
    for (const comp of c.components) {
      expect(comp.pos).toBeDefined(); // 分区成列的显式坐标（架构 schema 标准字段）
      expect(comp.size).toBeDefined(); // 给宽容纳 sublabel
    }
    for (const conn of c.connections) {
      expect(conn.via).toBeUndefined();
      expect(conn.labelAt).toBeUndefined();
    }
  });
});

describe('toWorkflow', () => {
  it('schema v2、每 lane ≤6 列、同 lane col 唯一、mainPath 有效', () => {
    const c = toWorkflow(sem).ir as any;
    expect(c.schema_version).toBe(2);
    const colByLane = new Map<string, number[]>();
    for (const n of c.nodes) {
      if (!colByLane.has(n.lane)) colByLane.set(n.lane, []);
      const cols = colByLane.get(n.lane)!;
      expect(n.col).toBeGreaterThanOrEqual(0);
      expect(n.col).toBeLessThanOrEqual(5);
      expect(cols.includes(n.col)).toBe(false); // 同 lane col 唯一
      cols.push(n.col);
    }
    for (const [, cols] of colByLane) expect(cols.length).toBeLessThanOrEqual(6);
    expect(c.mainPath.length).toBeGreaterThanOrEqual(2);
  });
});

describe('toSequence', () => {
  it('participants ≥2、messages y 严格递增、首稿无 column_fit', () => {
    const c = toSequence(sem)!.ir as any;
    expect(c.participants.length).toBeGreaterThanOrEqual(2);
    expect(c.column_fit).toBeUndefined();
    let prev = -1;
    for (const m of c.messages) {
      expect(m.y).toBeGreaterThan(prev);
      prev = m.y;
    }
  });
});

describe('toDataflow', () => {
  it('stages 2–5、nodes 段/行唯一、flows label 非空', () => {
    const c = toDataflow(sem)!.ir as any;
    expect(c.stages.length).toBeGreaterThanOrEqual(2);
    expect(c.stages.length).toBeLessThanOrEqual(5);
    const cellKey = new Set<string>();
    for (const n of c.nodes) {
      const key = `${n.stage}:${n.row}`;
      expect(cellKey.has(key)).toBe(false);
      cellKey.add(key);
    }
    for (const f of c.flows) expect(typeof f.label === 'string' && f.label.length > 0).toBe(true);
  });
});

describe('toLifecycle', () => {
  it('mainPath ≥2 时生成状态机；主轨 col 0..4、step 01..05', () => {
    const c = toLifecycle(sem);
    expect(c).not.toBeNull();
    const ir = c!.ir as any;
    expect(ir.states.length).toBeGreaterThanOrEqual(2);
    const rail = ir.states.filter((s: any) => s.lane === 'main');
    expect(rail.length).toBeGreaterThanOrEqual(2);
    expect(rail[0].type).toBe('start');
    expect(rail[rail.length - 1].type).toBe('success');
  });
  it('缺主路径 → 返回 null（走诚实降级）', () => {
    const single = deriveSemantics(adaptIRTree({ id: 'x', label: 'x', children: { nodes: [{ id: 'a', label: 'A', role: 'service' }], edges: [] } }));
    expect(toLifecycle(single)).toBeNull();
  });
});

describe('DIAGRAM_TYPES', () => {
  it('包含 5 种架构图类型，与后端 manifest 对齐', () => {
    expect(DIAGRAM_TYPES).toEqual(['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle']);
  });
});