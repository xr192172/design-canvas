/**
 * 布局工具实现
 *
 * 支持多种布局算法：
 *   1. DAG 拓扑排序布局：基于 Kahn 算法，适合有向无环图
 *   2. 力导向布局（Force-Directed）：基于弹簧模型，适合复杂网络图
 *   3. 网格对齐：将节点吸附到网格点
 *
 * 解决"连线混乱"问题：手动拖拽可能让连线交叉，调用此工具一键整理。
 */

import type { DesignDSL, ForceParams } from '../dsl/types.js';
import { getDSL, saveDSL } from '../storage.js';

export interface DagLayoutInput {
  feature: string;
  /** 布局方向：水平（从左到右）或垂直（从上到下） */
  direction?: 'horizontal' | 'vertical';
  /** 节点间水平间距（px） */
  h_gap?: number;
  /** 层级间垂直间距（px） */
  v_gap?: number;
  /** 画布宽度（可选，默认 1000） */
  width?: number;
  /** 是否尊重已分配的 swimlane（按泳道布局） */
  respect_swimlanes?: boolean;
}

export interface ForceLayoutInput {
  feature: string;
  /** 排斥力系数（默认 1000） */
  repulsion?: number;
  /** 弹簧刚度（默认 0.1） */
  stiffness?: number;
  /** 阻尼系数（默认 0.85） */
  damping?: number;
  /** 迭代次数（默认 500） */
  iterations?: number;
  /** 节点半径（默认 50） */
  node_radius?: number;
  /** 画布宽度（可选） */
  width?: number;
  /** 画布高度（可选） */
  height?: number;
}

export function dagLayout(input: DagLayoutInput): { message: string; rank_count: number; edge_crossings: number } {
  const {
    feature,
    direction = 'horizontal',
    h_gap = 200,
    v_gap = 100,
    width = 1000,
    respect_swimlanes = true,
  } = input;

  const dsl = getDSL(feature);
  if (!dsl) {
    throw new Error(`feature "${feature}" 不存在`);
  }

  if (!dsl.geometry.nodes || dsl.geometry.nodes.length === 0) {
    return { message: '画布为空，无需布局', rank_count: 0, edge_crossings: 0 };
  }

  // 1. 拓扑排序计算每个节点的 rank
  const nodes = dsl.geometry.nodes;
  const edges = dsl.geometry.edges || [];
  const inDegree = new Map<string, number>();
  const outEdges = new Map<string, string[]>();
  const inEdges = new Map<string, string[]>();

  nodes.forEach(n => {
    inDegree.set(n.id, 0);
    outEdges.set(n.id, []);
    inEdges.set(n.id, []);
  });

  edges.forEach(e => {
    // 跳过 contains 边（不参与层级计算）
    if (e.label === 'contains') return;
    if (inDegree.has(e.to) && outEdges.has(e.from)) {
      inDegree.set(e.to, (inDegree.get(e.to) || 0) + 1);
      outEdges.get(e.from)!.push(e.to);
      inEdges.get(e.to)!.push(e.from);
    }
  });

  // Kahn 算法
  const rank = new Map<string, number>();
  const queue: string[] = [];
  const tempInDegree = new Map(inDegree);

  // 找出所有入度为 0 的节点
  for (const [id, deg] of tempInDegree) {
    if (deg === 0) {
      queue.push(id);
      rank.set(id, 0);
    }
  }

  // 处理无依赖的孤立节点：放在 rank 0
  nodes.forEach(n => {
    if (!rank.has(n.id)) {
      rank.set(n.id, 0);
    }
  });

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentRank = rank.get(current) || 0;

    for (const next of outEdges.get(current) || []) {
      const newRank = Math.max(rank.get(next) || 0, currentRank + 1);
      rank.set(next, newRank);

      tempInDegree.set(next, (tempInDegree.get(next) || 0) - 1);
      if (tempInDegree.get(next) === 0) {
        queue.push(next);
      }
    }
  }

  // 2. 按 swimlane 分组（如果开启）
  const lanes: Map<string, string[]> = new Map();
  if (respect_swimlanes && dsl.geometry.swimlanes) {
    dsl.geometry.swimlanes.forEach(sl => lanes.set(sl.id, []));
    lanes.set('__unassigned__', []);

    nodes.forEach(n => {
      const laneId = n.swimlane || '__unassigned__';
      if (!lanes.has(laneId)) lanes.set(laneId, []);
      lanes.get(laneId)!.push(n.id);
    });
  } else {
    lanes.set('__main__', nodes.map(n => n.id));
  }

  // 3. 在每个泳道内按 rank 分组
  const RANK_GAP_Y = 80; // 同一 rank 内节点之间的垂直间距
  const LANE_GAP_Y = 100; // 泳道之间的间距

  // 收集所有 rank
  const allRanks = new Set<number>();
  rank.forEach(r => allRanks.add(r));
  const sortedRanks = Array.from(allRanks).sort((a, b) => a - b);

  // 每个 rank 在每个 lane 内的位置
  const positions = new Map<string, { rank: number; orderInRank: number }>();

  let currentY = 40;
  const sortedLanes = Array.from(lanes.entries()).filter(([, ids]) => ids.length > 0);

  sortedLanes.forEach(([laneId, nodeIds], laneIndex) => {
    // 按 rank 分组
    const byRank = new Map<number, string[]>();
    nodeIds.forEach(id => {
      const r = rank.get(id) || 0;
      if (!byRank.has(r)) byRank.set(r, []);
      byRank.get(r)!.push(id);
    });

    // 每个 rank 内的节点：按"虚拟中心"排序
    const maxRank = Math.max(...Array.from(byRank.keys()));

    for (let r = 0; r <= maxRank; r++) {
      const idsInRank = byRank.get(r) || [];
      if (idsInRank.length === 0) continue;

      // 计算虚拟中心（减少交叉）
      const withCenter = idsInRank.map(id => {
        const parents = inEdges.get(id) || [];
        const parentCenter = parents.length === 0
          ? 0
          : parents.reduce((sum, p) => {
            const idx = positions.get(p)?.orderInRank ?? 0;
            return sum + idx;
          }, 0) / parents.length;
        return { id, center: parentCenter };
      });

      withCenter.sort((a, b) => a.center - b.center);

      withCenter.forEach((item, i) => {
        positions.set(item.id, { rank: r, orderInRank: i });
      });
    }
  });

  // 4. 分配最终坐标
  const HEIGHT_PER_NODE = 60;
  const WIDTH_PER_NODE = 140;
  const RANK_GAP_X = 40;

  // 找出每个 rank 的最大节点数（用于决定画布高度）
  const maxCountInRank = new Map<number, number>();
  positions.forEach(({ rank: r, orderInRank }) => {
    maxCountInRank.set(r, Math.max(maxCountInRank.get(r) || 0, orderInRank + 1));
  });

  const maxNodesInAnyRank = Math.max(...Array.from(maxCountInRank.values()), 1);
  const totalHeight = maxNodesInAnyRank * (HEIGHT_PER_NODE + RANK_GAP_Y) + 100;
  const totalWidth = (sortedRanks.length + 1) * (WIDTH_PER_NODE + h_gap);

  dsl.geometry.width = Math.max(width, totalWidth);
  dsl.geometry.height = totalHeight;

  // 按泳道布局
  let currentLaneY = 40;

  sortedLanes.forEach(([laneId, nodeIds]) => {
    const byRank = new Map<number, string[]>();
    nodeIds.forEach(id => {
      const r = rank.get(id) || 0;
      if (!byRank.has(r)) byRank.set(r, []);
      byRank.get(r)!.push(id);
    });

    const sortedRanksInLane = Array.from(byRank.keys()).sort((a, b) => a - b);

    sortedRanksInLane.forEach(r => {
      const ids = byRank.get(r) || [];
      const x = 40 + r * (WIDTH_PER_NODE + h_gap);
      ids.forEach((id, i) => {
        const node = dsl.geometry.nodes.find(n => n.id === id);
        if (!node) return;
        node.x = x;
        node.y = currentLaneY + i * (HEIGHT_PER_NODE + RANK_GAP_Y);
        if (!node.width) node.width = WIDTH_PER_NODE;
        if (!node.height) node.height = HEIGHT_PER_NODE;
      });
    });

    // 计算泳道的实际占用高度
    const laneHeight = (Math.max(...Array.from(byRank.values()).map(arr => arr.length), 0) + 1) * (HEIGHT_PER_NODE + RANK_GAP_Y);
    if (dsl.geometry.swimlanes) {
      const sl = dsl.geometry.swimlanes.find(s => s.id === laneId);
      if (sl) {
        sl.y = currentLaneY - 20;
        sl.height = laneHeight + 40;
      }
    }
    currentLaneY += laneHeight + LANE_GAP_Y;
  });

  saveDSL(dsl);

  // 简单计算边交叉数
  const edgeCrossings = countEdgeCrossings(dsl);

  return {
    message: [
      `已自动布局 "${feature}"`,
      `方向: ${direction}`,
      `层级数: ${sortedRanks.length}`,
      `泳道数: ${sortedLanes.length}`,
      `边交叉数: ${edgeCrossings}`,
      `画布: ${dsl.geometry.width} × ${dsl.geometry.height}`,
      '',
      '调用 render_dsl 查看新布局。',
    ].join('\n'),
    rank_count: sortedRanks.length,
    edge_crossings: edgeCrossings,
  };
}

/** 计算边的交叉数（简化版） */
function countEdgeCrossings(dsl: DesignDSL): number {
  const edges = dsl.geometry.edges || [];
  const nodeById = new Map(dsl.geometry.nodes.map(n => [n.id, n]));
  let crossings = 0;

  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const e1 = edges[i];
      const e2 = edges[j];
      // 共享端点不算交叉
      if (e1.from === e2.from || e1.from === e2.to || e1.to === e2.from || e1.to === e2.to) continue;

      const n1 = nodeById.get(e1.from);
      const n2 = nodeById.get(e1.to);
      const n3 = nodeById.get(e2.from);
      const n4 = nodeById.get(e2.to);
      if (!n1 || !n2 || !n3 || !n4) continue;

      const x1 = (n1.x ?? 0) + (n1.width ?? 100) / 2;
      const y1 = (n1.y ?? 0) + (n1.height ?? 50) / 2;
      const x2 = (n2.x ?? 0) + (n2.width ?? 100) / 2;
      const y2 = (n2.y ?? 0) + (n2.height ?? 50) / 2;
      const x3 = (n3.x ?? 0) + (n3.width ?? 100) / 2;
      const y3 = (n3.y ?? 0) + (n3.height ?? 50) / 2;
      const x4 = (n4.x ?? 0) + (n4.width ?? 100) / 2;
      const y4 = (n4.y ?? 0) + (n4.height ?? 50) / 2;

      if (segmentsIntersect(x1, y1, x2, y2, x3, y3, x4, y4)) {
        crossings++;
      }
    }
  }
  return crossings;
}

function segmentsIntersect(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, x4: number, y4: number): boolean {
  const d1 = direction(x3, y3, x4, y4, x1, y1);
  const d2 = direction(x3, y3, x4, y4, x2, y2);
  const d3 = direction(x1, y1, x2, y2, x3, y3);
  const d4 = direction(x1, y1, x2, y2, x4, y4);

  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && onSegment(x3, y3, x4, y4, x1, y1)) return true;
  if (d2 === 0 && onSegment(x3, y3, x4, y4, x2, y2)) return true;
  if (d3 === 0 && onSegment(x1, y1, x2, y2, x3, y3)) return true;
  if (d4 === 0 && onSegment(x1, y1, x2, y2, x4, y4)) return true;
  return false;
}

function direction(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): number {
  return (x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1);
}

function onSegment(x1: number, y1: number, x2: number, y2: number, x: number, y: number): boolean {
  return Math.min(x1, x2) <= x && x <= Math.max(x1, x2) && Math.min(y1, y2) <= y && y <= Math.max(y1, y2);
}

/** ==== 力导向布局算法 ==== */
interface ForceNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed?: boolean;
}

export function forceLayout(input: ForceLayoutInput): { message: string; iterations: number; edge_crossings: number } {
  const {
    feature,
    repulsion = 1000,
    stiffness = 0.1,
    damping = 0.85,
    iterations = 500,
    node_radius = 50,
    width = 800,
    height = 600,
  } = input;

  const dsl = getDSL(feature);
  if (!dsl) {
    throw new Error(`feature "${feature}" 不存在`);
  }

  if (!dsl.geometry.nodes || dsl.geometry.nodes.length === 0) {
    return { message: '画布为空，无需布局', iterations: 0, edge_crossings: 0 };
  }

  const nodes = dsl.geometry.nodes;
  const edges = dsl.geometry.edges || [];

  const forceNodes: Map<string, ForceNode> = new Map();
  const centerX = width / 2;
  const centerY = height / 2;

  nodes.forEach(n => {
    const x = n.x ?? centerX + (Math.random() - 0.5) * 200;
    const y = n.y ?? centerY + (Math.random() - 0.5) * 200;
    forceNodes.set(n.id, { id: n.id, x, y, vx: 0, vy: 0 });
  });

  for (let iter = 0; iter < iterations; iter++) {
    for (const fn of forceNodes.values()) {
      if (fn.fixed) continue;
      fn.vx = 0;
      fn.vy = 0;
    }

    // 1. 节点间排斥力（平方反比）
    const fnList = Array.from(forceNodes.values());
    for (let i = 0; i < fnList.length; i++) {
      for (let j = i + 1; j < fnList.length; j++) {
        const n1 = fnList[i];
        const n2 = fnList[j];
        if (n1.fixed && n2.fixed) continue;

        const dx = n2.x - n1.x;
        const dy = n2.y - n1.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;

        if (dist < node_radius * 2) {
          const force = repulsion / (dist * dist);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;

          if (!n1.fixed) { n1.vx -= fx; n1.vy -= fy; }
          if (!n2.fixed) { n2.vx += fx; n2.vy += fy; }
        }
      }
    }

    // 2. 边的弹簧力（线性）
    edges.forEach(e => {
      const n1 = forceNodes.get(e.from);
      const n2 = forceNodes.get(e.to);
      if (!n1 || !n2) return;
      if (n1.fixed && n2.fixed) return;

      const dx = n2.x - n1.x;
      const dy = n2.y - n1.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const idealLength = node_radius * 3;
      const displacement = dist - idealLength;

      const force = stiffness * displacement;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;

      if (!n1.fixed) { n1.vx += fx; n1.vy += fy; }
      if (!n2.fixed) { n2.vx -= fx; n2.vy -= fy; }
    });

    // 3. 边界约束（防止节点跑出画布）
    fnList.forEach(fn => {
      if (fn.fixed) return;

      const margin = node_radius;
      if (fn.x < margin) fn.vx += (margin - fn.x) * 0.5;
      if (fn.x > width - margin) fn.vx += (width - margin - fn.x) * 0.5;
      if (fn.y < margin) fn.vy += (margin - fn.y) * 0.5;
      if (fn.y > height - margin) fn.vy += (height - margin - fn.y) * 0.5;

      // 阻尼
      fn.vx *= damping;
      fn.vy *= damping;

      // 更新位置
      fn.x += fn.vx;
      fn.y += fn.vy;
    });
  }

  // 更新 DSL 节点坐标
  nodes.forEach(n => {
    const fn = forceNodes.get(n.id);
    if (fn) {
      n.x = Math.round(fn.x);
      n.y = Math.round(fn.y);
      if (!n.width) n.width = 120;
      if (!n.height) n.height = 60;
    }
  });

  dsl.geometry.width = width;
  dsl.geometry.height = height;
  saveDSL(dsl);

  const edgeCrossings = countEdgeCrossings(dsl);

  return {
    message: [
      `已力导向布局 "${feature}"`,
      `迭代次数: ${iterations}`,
      `排斥力: ${repulsion}`,
      `刚度: ${stiffness}`,
      `阻尼: ${damping}`,
      `边交叉数: ${edgeCrossings}`,
      `画布: ${width} × ${height}`,
      '',
      '调用 render_dsl 查看新布局。',
    ].join('\n'),
    iterations,
    edge_crossings: edgeCrossings,
  };
}

/** ==== 网格对齐 ==== */
export interface GridAlignInput {
  feature: string;
  /** 网格大小（px），默认 20 */
  grid_size?: number;
}

export function gridAlign(input: GridAlignInput): { message: string; grid_size: number; aligned_count: number } {
  const { feature, grid_size = 20 } = input;

  const dsl = getDSL(feature);
  if (!dsl) {
    throw new Error(`feature "${feature}" 不存在`);
  }

  if (!dsl.geometry.nodes || dsl.geometry.nodes.length === 0) {
    return { message: '画布为空，无需对齐', grid_size, aligned_count: 0 };
  }

  let alignedCount = 0;
  dsl.geometry.nodes.forEach(n => {
    const oldX = n.x;
    const oldY = n.y;
    n.x = Math.round((n.x ?? 0) / grid_size) * grid_size;
    n.y = Math.round((n.y ?? 0) / grid_size) * grid_size;
    if (oldX !== n.x || oldY !== n.y) alignedCount++;
  });

  dsl.geometry.grid_size = grid_size;
  saveDSL(dsl);

  return {
    message: [
      `已对齐网格 "${feature}"`,
      `网格大小: ${grid_size}px`,
      `对齐节点数: ${alignedCount}`,
      '',
      '调用 render_dsl 查看效果。',
    ].join('\n'),
    grid_size,
    aligned_count: alignedCount,
  };
}
