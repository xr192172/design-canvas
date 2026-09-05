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
  it('单分区（无 groupOf）。拓扑分列横排：同链节点不在同一坐标列，避免 star 边垂直穿节点', () => {
    // 平铺文件层：无分组，源节点扇出到多个下游 —— 旧实现单列堆叠必触发 edge-through-node
    const star: ArchifyTreeNode = {
      id: 'v', label: '文件视图', children: {
        nodes: [
          { id: 'main', label: 'main', role: 'file', file: 'main.go' },
          { id: 'a', label: 'a', role: 'file', file: 'a.go' },
          { id: 'b', label: 'b', role: 'file', file: 'b.go' },
          { id: 'c', label: 'c', role: 'file', file: 'c.go' },
        ],
        edges: [
          { from: 'main', to: 'a', kind: 'flow' },
          { from: 'main', to: 'b', kind: 'flow' },
          { from: 'main', to: 'c', kind: 'flow' },
        ],
      },
    };
    const semStar = deriveSemantics(adaptIRTree(star));
    expect(semStar.groupOf).toBeUndefined(); // 无分组 → 走拓扑分列路径
    const c = toArchitecture(semStar).ir as any;
    // 拓扑分列后，主源(main)与任一下游的 x（列）不同 → 边横向走，不垂直穿节点
    const posById = new Map(c.components.map((x: any) => [x.id, x.pos]));
    const mainX = posById.get('mod_main_0')[0];
    expect(c.components.some((x: any) => x.id !== 'mod_main_0' && posById.get(x.id)[0] !== mainX)).toBe(true);
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
  it('8 步长链跨 lane：col 单调非递减 + 同 lane 同 col 用 yOffset 错开（修 col 回绕 backward）', () => {
    const chain: ArchifyTreeNode = {
      id: 'nav:steps', label: '主程序编排', type: 'view',
      children: {
        nodes: Array.from({ length: 8 }, (_, i) => ({
          id: `s${i}`, label: `步骤${i}`, role: 'step', type: 'step',
          children: { id: `s${i}:files`, label: '实现', nodes: [{ id: `f${i}`, label: 'main.go', role: 'file', type: 'file' }], edges: [] },
        })),
        edges: Array.from({ length: 7 }, (_, i) => ({ from: `s${i}`, to: `s${i + 1}`, kind: 'flow', label: '顺序承接' })),
      },
    };
    const semChain = deriveSemantics(adaptIRTree(chain));
    const c = toWorkflow(semChain).ir as any;
    expect(c.schema_version).toBe(2);
    // 节点集：s0..s7 全部保留
    expect(c.nodes.map((n: any) => n.id).sort()).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7']);
    // 每个节点 col ∈ 0..5（schema 硬限）
    for (const n of c.nodes) { expect(n.col).toBeGreaterThanOrEqual(0); expect(n.col).toBeLessThanOrEqual(5); }
    // 主路径 col 单调非递减（to.col >= from.col），修复跨 lane 回绕 backward
    const colById = new Map(c.nodes.map((n: any) => [n.id, n.col]));
    for (let i = 0; i < c.mainPath.length - 1; i++) {
      expect(colById.get(c.mainPath[i + 1])).toBeGreaterThanOrEqual(colById.get(c.mainPath[i]));
    }
    // 同 lane 同 col 的堆叠节点必须有 yOffset 错开，避免节点重叠
    const seen = new Map<string, number>();
    for (const n of c.nodes) {
      const key = `${n.lane}:${n.col}`;
      if (seen.has(key)) expect(n.yOffset).toBeGreaterThan(0);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
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
it('长参与者标签被短化（≤8 显示单位），避免超宽触 showcase 校验', () => {
    const chain: ArchifyTreeNode = {
      id: 'v', label: '线性链', children: {
        nodes: [
          { id: 'a0', label: '客户端', role: 'step', file: 'c.go' },
          { id: 'a1', label: '安装性能记录仪', role: 'step', file: 'm.go' },
          { id: 'a2', label: '生成端到端表单', role: 'step', file: 'f.go' },
          { id: 'a3', label: '服务端', role: 'step', file: 's.go' },
        ],
        edges: [
          { from: 'a0', to: 'a1', kind: 'flow' },
          { from: 'a1', to: 'a2', kind: 'flow' },
          { from: 'a2', to: 'a3', kind: 'flow' },
        ],
      },
    };
    const c = toSequence(deriveSemantics(adaptIRTree(chain)));
    expect(c).not.toBeNull();
    const ir = c!.ir as any;
    for (const p of ir.participants) {
      // 中文算 2 单位，6 字以上标签必被截断；截断内容带省略号
      expect(p.label.length).toBeLessThanOrEqual(9);
      if (p.label.includes('性能记录仪')) expect(p.label.endsWith('…')).toBe(true);
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
  it('深度不均的长链：viewBox 高度跟随实际最深行，避免 y 越界', () => {
    // 8 步单链深度不均时某 stage 行数更高，旧版 nodeCount/stageCount 低估 → y 越界
    const chain: ArchifyTreeNode = {
      id: 'v', label: '主程序编排', children: {
        nodes: Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, label: `步骤${i}`, role: 'step' })),
        edges: Array.from({ length: 7 }, (_, i) => ({ from: `s${i}`, to: `s${i + 1}`, kind: 'flow' })),
      },
    };
    const c = toDataflow(deriveSemantics(adaptIRTree(chain)))!.ir as any;
    // 最深 row 对应的 y 必须在画布高度内：viewBox[1] 需容纳 maxRow*120 + 余量
    const maxRow = Math.max(...c.nodes.map((n: any) => n.row));
    expect(c.meta.viewBox[1]).toBeGreaterThan(maxRow * 120 + 320 - 1);
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
  it('并行扇出（一源多下游）→ 返回 null（状态机主链不适配，交 architecture 表达）', () => {
    // star：main 扇出到 3 下游 —— 旧实现会生成边横穿主轨状态触发 edge-through-node
    const star: ArchifyTreeNode = {
      id: 'v', label: '文件视图', children: {
        nodes: [
          { id: 'main', label: 'main', role: 'file', file: 'main.go' },
          { id: 'a', label: 'a', role: 'file', file: 'a.go' },
          { id: 'b', label: 'b', role: 'file', file: 'b.go' },
          { id: 'c', label: 'c', role: 'file', file: 'c.go' },
        ],
        edges: [
          { from: 'main', to: 'a', kind: 'flow' },
          { from: 'main', to: 'b', kind: 'flow' },
          { from: 'main', to: 'c', kind: 'flow' },
        ],
      },
    };
    expect(toLifecycle(deriveSemantics(adaptIRTree(star)))).toBeNull();
  });
  it('超长主链（>5 状态）→ 返回 null（线性长链交 workflow 表达）', () => {
    // 8 步单链：越轨后侧轨跨 lane 回流，官方校验「transition 过短」必失败
    const chain: ArchifyTreeNode = {
      id: 'v', label: '主程序编排', children: {
        nodes: Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, label: `步骤${i}`, role: 'step' })),
        edges: Array.from({ length: 7 }, (_, i) => ({ from: `s${i}`, to: `s${i + 1}`, kind: 'flow' })),
      },
    };
    expect(toLifecycle(deriveSemantics(adaptIRTree(chain)))).toBeNull();
  });
});

describe('DIAGRAM_TYPES', () => {
  it('包含 5 种架构图类型，与后端 manifest 对齐', () => {
    expect(DIAGRAM_TYPES).toEqual(['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle']);
  });
});