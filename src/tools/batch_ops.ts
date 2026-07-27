/**
 * 批量节点操作：batch_move_nodes / batch_update_style / batch_delete_nodes
 */

import type { DiagramStatus } from '../dsl/types.js';
import { getDSL, saveDSL } from '../storage.js';
import type { EditResult } from './edit_result.js';

// ─────────────────────────────────────────────────────────────
// batch_move_nodes：批量移动节点
// ─────────────────────────────────────────────────────────────

export interface BatchMoveInput {
  feature: string;
  node_ids: string[];
  dx: number;
  dy: number;
}

export function batchMoveNodes(input: BatchMoveInput): EditResult {
  const { feature, node_ids, dx, dy } = input;

  const dsl = getDSL(feature);
  if (!dsl) throw new Error(`feature "${feature}" 不存在`);

  let moved = 0;
  for (const id of node_ids) {
    const node = dsl.geometry.nodes.find(n => n.id === id);
    if (node) {
      node.x = (node.x ?? 0) + dx;
      node.y = (node.y ?? 0) + dy;
      moved++;
    }
  }

  saveDSL(dsl);
  return { message: `已移动 ${moved}/${node_ids.length} 个节点 (dx=${dx}, dy=${dy})`, feature };
}

// ─────────────────────────────────────────────────────────────
// batch_update_style：批量更新节点样式
// ─────────────────────────────────────────────────────────────

export interface BatchStyleInput {
  feature: string;
  node_ids: string[];
  bg?: string;
  color?: string;
  border?: string;
  borderRadius?: number;
  shape?: 'rect' | 'rounded' | 'circle' | 'diamond' | 'freeform';
  status?: DiagramStatus;
}

export function batchUpdateStyle(input: BatchStyleInput): EditResult {
  const { feature, node_ids, bg, color, border, borderRadius, shape, status } = input;

  const dsl = getDSL(feature);
  if (!dsl) throw new Error(`feature "${feature}" 不存在`);

  let updated = 0;
  for (const id of node_ids) {
    const node = dsl.geometry.nodes.find(n => n.id === id);
    if (!node) continue;
    if (!node.style) node.style = {};
    if (bg !== undefined) node.style.bg = bg;
    if (color !== undefined) node.style.color = color;
    if (border !== undefined) node.style.border = border;
    if (borderRadius !== undefined) node.style.borderRadius = borderRadius;
    if (shape !== undefined) node.style.shape = shape;
    if (status !== undefined) node.status = status;
    updated++;
  }

  saveDSL(dsl);
  return { message: `已更新 ${updated}/${node_ids.length} 个节点的样式`, feature };
}

// ─────────────────────────────────────────────────────────────
// batch_delete_nodes：批量删除节点
// ─────────────────────────────────────────────────────────────

export interface BatchDeleteInput {
  feature: string;
  node_ids: string[];
}

export function batchDeleteNodes(input: BatchDeleteInput): EditResult {
  const { feature, node_ids } = input;

  const dsl = getDSL(feature);
  if (!dsl) throw new Error(`feature "${feature}" 不存在`);

  const idSet = new Set(node_ids);
  const before = dsl.geometry.nodes.length;
  dsl.geometry.nodes = dsl.geometry.nodes.filter(n => !idSet.has(n.id));
  dsl.geometry.edges = (dsl.geometry.edges ?? []).filter(e => !idSet.has(e.from) && !idSet.has(e.to));
  const removed = before - dsl.geometry.nodes.length;

  saveDSL(dsl);
  return { message: `已删除 ${removed}/${node_ids.length} 个节点及关联边`, feature };
}
