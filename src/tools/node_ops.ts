/**
 * 节点操作：add_node / update_node / delete_node
 */

import type { DesignDSL, Node, NodeStyle, NodeContent, DiagramStatus, NodeLayer, NodeShapes, NodeDecision, AnimationValueSchema } from '../dsl/types.js';
import { getDSL, saveDSL } from '../storage.js';
import type { EditResult } from './edit_result.js';

/** 形状卡轻校验：type 枚举 + properties/items 递归（防止渲染垃圾） */
function assertValidSchema(s: AnimationValueSchema, path: string): void {
  const validTypes = ['object', 'array', 'string', 'number', 'boolean', 'integer', 'null'];
  if (!s || typeof s !== 'object' || !validTypes.includes(s.type)) {
    throw new Error(`${path}.type 必须是 ${validTypes.join('/')} 之一`);
  }
  if (s.properties) {
    for (const [k, v] of Object.entries(s.properties)) {
      assertValidSchema(v, `${path}.properties.${k}`);
    }
  }
  if (s.items) assertValidSchema(s.items, `${path}.items`);
}

function assertValidShapes(shapes: NodeShapes): void {
  if (shapes.in) assertValidSchema(shapes.in, 'shapes.in');
  if (shapes.out) assertValidSchema(shapes.out, 'shapes.out');
}

// ─────────────────────────────────────────────────────────────
// add_node：添加节点
// ─────────────────────────────────────────────────────────────

export interface AddNodeInput {
  feature: string;
  node_id: string;
  label?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  bg?: string;
  color?: string;
  border?: string;
  borderRadius?: number;
  shape?: 'rect' | 'rounded' | 'circle' | 'diamond' | 'freeform';
  shadow?: string;
  opacity?: number;
  type?: string;
  description?: string;
  status?: DiagramStatus;
  swimlane?: string;
  content?: NodeContent;
  sub_dsl?: DesignDSL;
  layer?: NodeLayer;
  host?: string;
  shapes?: NodeShapes;
  /** 决策卡·参数表：类型化 key-value（如 budget_mb: 64） */
  attributes?: Record<string, string | number | boolean>;
  /** 决策卡·决策记录：结论/理由/替代方案/后果/验收 */
  decision?: NodeDecision;
}

export function addNode(input: AddNodeInput): EditResult {
  const { feature, node_id, label, x, y, width, height, bg, color, border, borderRadius, shape, shadow, opacity, type, description, status, swimlane, content, sub_dsl, layer, host, shapes, attributes, decision } = input;

  const dsl = getDSL(feature);
  if (!dsl) {
    throw new Error(`feature "${feature}" 不存在，请先使用 create_feature 创建`);
  }

  if (dsl.geometry.nodes.find(n => n.id === node_id)) {
    throw new Error(`节点 "${node_id}" 已存在，使用 update_node 修改`);
  }
  if (host && !dsl.geometry.nodes.find(n => n.id === host)) {
    throw new Error(`host 节点 "${host}" 不存在`);
  }
  if (shapes) assertValidShapes(shapes);

  const style: NodeStyle = {};
  if (bg) style.bg = bg;
  if (color) style.color = color;
  if (border) style.border = border;
  if (borderRadius !== undefined) style.borderRadius = borderRadius;
  if (shape) style.shape = shape;
  if (shadow) style.shadow = shadow;
  if (opacity !== undefined) style.opacity = opacity;

  const node: Node = {
    id: node_id,
    label: label || node_id,
    x,
    y,
    width,
    height,
    style: Object.keys(style).length > 0 ? style : undefined,
    type,
    description,
    status,
    swimlane,
    content,
    sub_dsl,
    layer,
    host,
    shapes,
    attributes,
    decision,
  };

  dsl.geometry.nodes.push(node);
  saveDSL(dsl);

  const lines = [
    `已添加节点: ${node_id}`,
    `标签: ${node.label}`,
    `位置: (${node.x ?? 'auto'}, ${node.y ?? 'auto'})`,
    `尺寸: ${node.width ?? 'auto'} × ${node.height ?? 'auto'}`,
  ];
  if (type) lines.push(`类型: ${type}`);
  if (status) lines.push(`状态: ${status}`);
  if (shape) lines.push(`形状: ${shape}`);
  if (swimlane) lines.push(`泳道: ${swimlane}`);
  if (layer && layer !== 'main') lines.push(`分层: ${layer}${host ? ` (宿主: ${host})` : ''}`);
  lines.push(`当前节点数: ${dsl.geometry.nodes.length}`);

  return { message: lines.join('\n'), feature };
}

// ─────────────────────────────────────────────────────────────
// update_node：更新节点
// ─────────────────────────────────────────────────────────────

export interface UpdateNodeInput {
  feature: string;
  node_id: string;
  label?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  bg?: string;
  color?: string;
  border?: string;
  borderRadius?: number;
  shape?: 'rect' | 'rounded' | 'circle' | 'diamond' | 'freeform';
  shadow?: string;
  opacity?: number;
  type?: string;
  description?: string;
  status?: DiagramStatus;
  swimlane?: string;
  content?: NodeContent;
  sub_dsl?: DesignDSL;
  layer?: NodeLayer | null;
  host?: string | null;
  shapes?: NodeShapes | null;
  /** 决策卡·参数表：类型化 key-value；null 清除 */
  attributes?: Record<string, string | number | boolean> | null;
  /** 决策卡·决策记录；null 清除 */
  decision?: NodeDecision | null;
}

export function updateNode(input: UpdateNodeInput): EditResult {
  const { feature, node_id, label, x, y, width, height, bg, color, border, borderRadius, shape, shadow, opacity, type, description, status, swimlane, content, sub_dsl, layer, host, shapes, attributes, decision } = input;

  const dsl = getDSL(feature);
  if (!dsl) {
    throw new Error(`feature "${feature}" 不存在`);
  }

  const node = dsl.geometry.nodes.find(n => n.id === node_id);
  if (!node) {
    throw new Error(`节点 "${node_id}" 不存在`);
  }

  if (label !== undefined) node.label = label;
  if (x !== undefined) node.x = x;
  if (y !== undefined) node.y = y;
  if (width !== undefined) node.width = width;
  if (height !== undefined) node.height = height;
  if (type !== undefined) node.type = type;
  if (description !== undefined) node.description = description;
  if (status !== undefined) node.status = status;
  if (swimlane !== undefined) node.swimlane = swimlane;
  if (content !== undefined) node.content = content;
  if (sub_dsl !== undefined) node.sub_dsl = sub_dsl;
  // layer/host：null 表示清除（回到 main 层）
  if (layer !== undefined) {
    if (layer === null) delete node.layer;
    else node.layer = layer;
  }
  if (host !== undefined) {
    if (host === null) delete node.host;
    else {
      if (!dsl.geometry.nodes.find(n => n.id === host)) {
        throw new Error(`host 节点 "${host}" 不存在`);
      }
      node.host = host;
    }
  }
  // shapes：null 表示清除形状卡
  if (shapes !== undefined) {
    if (shapes === null) delete node.shapes;
    else {
      assertValidShapes(shapes);
      node.shapes = shapes;
    }
  }
  // attributes/decision：null 表示清除（决策卡整体移除）；空对象/空 summary 允许渐进填写
  if (attributes !== undefined) {
    if (attributes === null) delete node.attributes;
    else node.attributes = attributes;
  }
  if (decision !== undefined) {
    if (decision === null) delete node.decision;
    else node.decision = decision;
  }

  if (!node.style) node.style = {};
  if (bg !== undefined) node.style.bg = bg;
  if (color !== undefined) node.style.color = color;
  if (border !== undefined) node.style.border = border;
  if (borderRadius !== undefined) node.style.borderRadius = borderRadius;
  if (shape !== undefined) node.style.shape = shape;
  if (shadow !== undefined) node.style.shadow = shadow;
  if (opacity !== undefined) node.style.opacity = opacity;

  saveDSL(dsl);

  const lines = [
    `已更新节点: ${node_id}`,
    `标签: ${node.label}`,
    `位置: (${node.x ?? 'auto'}, ${node.y ?? 'auto'})`,
    `尺寸: ${node.width ?? 'auto'} × ${node.height ?? 'auto'}`,
  ];
  if (status) lines.push(`状态: ${status}`);

  return { message: lines.join('\n'), feature };
}

// ─────────────────────────────────────────────────────────────
// delete_node：删除节点（连带相关边）
// ─────────────────────────────────────────────────────────────

export interface DeleteNodeInput {
  feature: string;
  node_id: string;
}

export function deleteNode(input: DeleteNodeInput): EditResult {
  const { feature, node_id } = input;

  const dsl = getDSL(feature);
  if (!dsl) {
    throw new Error(`feature "${feature}" 不存在`);
  }

  const nodeIdx = dsl.geometry.nodes.findIndex(n => n.id === node_id);
  if (nodeIdx === -1) {
    throw new Error(`节点 "${node_id}" 不存在`);
  }

  const removedNode = dsl.geometry.nodes[nodeIdx];
  dsl.geometry.nodes.splice(nodeIdx, 1);

  const removedEdges = (dsl.geometry.edges ?? []).filter(e => e.from === node_id || e.to === node_id);
  dsl.geometry.edges = (dsl.geometry.edges ?? []).filter(e => e.from !== node_id && e.to !== node_id);

  saveDSL(dsl);

  return {
    message: [
      `已删除节点: ${node_id} (${removedNode.label})`,
      `连带删除边: ${removedEdges.length} 条`,
      `当前节点数: ${dsl.geometry.nodes.length}`,
      `当前边数: ${dsl.geometry.edges.length}`,
    ].join('\n'),
    feature,
  };
}
