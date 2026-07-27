/**
 * 边操作：add_edge / delete_edge
 */

import type { Edge, NodeLayer } from '../dsl/types.js';
import { getDSL, saveDSL } from '../storage.js';
import type { EditResult } from './edit_result.js';

// ─────────────────────────────────────────────────────────────
// add_edge：添加边
// ─────────────────────────────────────────────────────────────

export interface AddEdgeInput {
  feature: string;
  edge_id: string;
  from: string;
  to: string;
  label?: string;
  edge_type?: 'straight' | 'curve' | 'dashed';
  arrow?: 'forward' | 'reverse' | 'both' | 'none';
  layer?: NodeLayer;
}

export function addEdge(input: AddEdgeInput): EditResult {
  const { feature, edge_id, from, to, label, edge_type, arrow, layer } = input;

  const dsl = getDSL(feature);
  if (!dsl) {
    throw new Error(`feature "${feature}" 不存在`);
  }

  if (!dsl.geometry.nodes.find(n => n.id === from)) {
    throw new Error(`源节点 "${from}" 不存在`);
  }
  if (!dsl.geometry.nodes.find(n => n.id === to)) {
    throw new Error(`目标节点 "${to}" 不存在`);
  }

  if ((dsl.geometry.edges ?? []).find(e => e.id === edge_id)) {
    throw new Error(`边 "${edge_id}" 已存在`);
  }

  const edge: Edge = {
    id: edge_id,
    from,
    to,
    label,
    ...(edge_type ? { type: edge_type } : {}),
    ...(arrow ? { arrow } : {}),
    ...(layer ? { layer } : {}),
  };

  if (!dsl.geometry.edges) dsl.geometry.edges = [];
  dsl.geometry.edges.push(edge);
  saveDSL(dsl);

  return {
    message: [
      `已添加边: ${edge_id}`,
      `方向: ${from} → ${to}`,
      `标签: ${label ?? '(无)'})`,
      `当前边数: ${dsl.geometry.edges.length}`,
    ].join('\n'),
    feature,
  };
}

// ─────────────────────────────────────────────────────────────
// delete_edge：删除边
// ─────────────────────────────────────────────────────────────

export interface DeleteEdgeInput {
  feature: string;
  edge_id: string;
}

export function deleteEdge(input: DeleteEdgeInput): EditResult {
  const { feature, edge_id } = input;

  const dsl = getDSL(feature);
  if (!dsl) {
    throw new Error(`feature "${feature}" 不存在`);
  }

  if (!dsl.geometry.edges) {
    throw new Error(`边 "${edge_id}" 不存在`);
  }

  const edgeIdx = dsl.geometry.edges.findIndex(e => e.id === edge_id);
  if (edgeIdx === -1) {
    throw new Error(`边 "${edge_id}" 不存在`);
  }

  const removedEdge = dsl.geometry.edges[edgeIdx];
  dsl.geometry.edges.splice(edgeIdx, 1);

  saveDSL(dsl);

  return {
    message: [
      `已删除边: ${edge_id}`,
      `方向: ${removedEdge.from} → ${removedEdge.to}`,
      `当前边数: ${dsl.geometry.edges.length}`,
    ].join('\n'),
    feature,
  };
}
