/**
 * view_inputs —— 5 种图的「渲染输入」轻量结构（与任何具体渲染器解耦）
 *
 * 数据层只产「中性的图内容」，渲染器（当前是 Archify）只负责把它画出来。
 * 将来换渲染器，只需新写一个映射，数据层不动。
 *
 * 5 份输入都从同一份真实语义（模块/子系统 + semantic.actual_deps 真实依赖 + 职责/分层/状态）
 * 派生，不再为渲染器造数据。差异只是"看图的视角"：
 *   - architecture：子系统 + 分区边界 + 依赖边
 *   - workflow    ：沿依赖顺序的泳道流程
 *   - sequence    ：主路径参与者之间的调用/消息序
 *   - dataflow    ：按依赖深度的阶段流转
 *   - lifecycle   ：主路径 + 终态的状态迁移
 */
import type { SemanticSurface, SemanticNode, SemanticEdge } from './archify_semantics.js';

/** 统一节点：含分区/角色/层/规模等"图无关"投影字段，映射层据此选具体 schema 字段 */
export interface ViewNode {
  id: string;
  label: string;
  /** 通用语义角色（backend/frontend/database/… 由 roleToType 确定性映射，渲染器用它配视觉） */
  role?: string;
  /** 顶层功能分区（边界/泳道分组用） */
  group?: string;
  /** 依赖序（workflow 列 / sequence 序 / lifecycle 主轨） */
  order?: number;
  /** 依赖深度（dataflow 阶段位） */
  stage?: number;
  /** 生命周期角色（lifecycle 用，如 start/active/success/failure） */
  stateRole?: 'start' | 'active' | 'decision' | 'success' | 'waiting' | 'failure';
  /** 规模（文件数） */
  size?: number;
  /** 职责/分层/状态细节 */
  detail?: { resp?: string; layer?: string; status?: string };
}
export interface ViewEdge {
  from: string;
  to: string;
  /** 流转的数据名（真实语义） */
  data?: string;
}
export interface ViewGroup {
  id: string;
  label: string;
  nodeIds: string[];
}
export interface ViewDiagram {
  id: string;
  title: string;
  nodes: ViewNode[];
  edges: ViewEdge[];
  groups?: ViewGroup[];
  mainPath?: string[];
}
/** 5 类图的中性渲染输入 */
export interface RenderViews {
  architecture: ViewDiagram;
  workflow: ViewDiagram;
  sequence: ViewDiagram;
  dataflow: ViewDiagram;
  lifecycle: ViewDiagram;
}

/** 依赖深度（dataflow 阶段 / lifecycle 主轨序），环有界 */
function dependencyDepth(nodes: SemanticNode[], edges: SemanticEdge[]): Map<string, number> {
  const depth = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (let it = 0; it < nodes.length + 1; it += 1) {
    let changed = false;
    for (const e of edges) {
      if (!depth.has(e.from) || !depth.has(e.to)) continue;
      if ((depth.get(e.from) ?? 0) + 1 > (depth.get(e.to) ?? 0)) {
        depth.set(e.to, (depth.get(e.from) ?? 0) + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return depth;
}

/** 从真实语义面派生 5 份中性渲染输入 */
export function deriveViewInputs(sem: SemanticSurface): RenderViews {
  const depth = dependencyDepth(sem.nodes, sem.edges);
  const nodeMap = new Map(sem.nodes.map((n) => [n.id, n]));
  const toV = (n: SemanticNode): ViewNode => ({
    id: n.id,
    label: n.label,
    role: n.type,
    group: sem.groupOf?.get(n.id),
    size: n.files.length,
    detail: n.tag ? { layer: n.tag } : undefined,
  });
  const edges: ViewEdge[] = sem.edges.map((e) => ({ from: e.from, to: e.to, data: e.data || undefined }));
  const mainPath = sem.mainPath;
  const byGroup = new Map<string, string[]>();
  for (const [id, g] of sem.groupOf || []) {
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(id);
  }
  const groups: ViewGroup[] | undefined = byGroup.size
    ? [...byGroup.entries()].map(([label, nodeIds]) => ({ id: `g_${label}`, label, nodeIds }))
    : undefined;

  const architecture: ViewDiagram = { id: sem.id, title: sem.label, nodes: sem.nodes.map(toV), edges, groups, mainPath };
  const workflow: ViewDiagram = {
    id: sem.id, title: sem.label,
    nodes: sem.nodes.map((n) => ({ ...toV(n), order: sem.colOrder.get(n.id) })),
    edges, mainPath,
  };
  const sequence: ViewDiagram = { ...workflow, nodes: workflow.nodes.map((n) => ({ ...n, role: n.role ?? 'backend' })) };
  const dataflow: ViewDiagram = {
    id: sem.id, title: sem.label,
    nodes: sem.nodes.map((n) => ({ ...toV(n), stage: depth.get(n.id) ?? 0 })),
    edges, mainPath,
  };
  const lifecycle: ViewDiagram = {
    id: sem.id, title: sem.label,
    nodes: sem.nodes.map((n, i) => ({
      ...toV(n),
      order: sem.colOrder.get(n.id),
      stateRole: stateRoleAt(sem, nodeMap, n.id, i),
    })),
    edges, mainPath,
  };

  return { architecture, workflow, sequence, dataflow, lifecycle };
}

/** lifecycle 状态角色：主路径首=start、末=success；有出边但非主路径=active；无出边=success/failure 兜底 */
function stateRoleAt(sem: SemanticSurface, nodeMap: Map<string, SemanticNode>, want: string, _i: number): NonNullable<ViewNode['stateRole']> | undefined {
  const idx = sem.mainPath.indexOf(want);
  if (idx === 0) return 'start';
  if (idx === sem.mainPath.length - 1) return 'success';
  if (sem.mainPath.includes(want)) return 'active';
  if (!sem.mainPath.includes(want)) {
    const hasOut = nodeMap.get(want)?.id ? sem.edges.some((e) => e.from === want) : false;
    return hasOut ? 'active' : 'failure';
  }
  return undefined;
}