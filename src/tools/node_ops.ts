/**
 * 节点操作：add_node / update_node / delete_node
 */

import type { DesignDSL, Node, NodeStyle, NodeContent, DiagramStatus, NodeLayer, NodeShapes, NodeDecision, DecisionHistoryEntry, AnimationValueSchema } from '../dsl/types.js';
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
  /** 决策卡·决策记录；null 清除。update 时旧版自动压入 decision_history */
  decision?: NodeDecision | null;
  /** 决策修订说明：随本次 decision 更新记入版本栈（翻案理由/变更点） */
  decision_note?: string;
  /** 决策作者（谁定的/谁发起的修订）：human / llm / 账号名。缺省不伪造、不主动写 */
  author?: string;
}

/**
 * 决策写入纯函数（缺口①：作者/时间线）。
 * decision 更新=版本演进：旧版自动压入 decision_history（`at` 时间戳 + 修订 note + 发起人 author），
 * 新版成为当前生效版，并打 `updated_at`（author 若有则一并打上）。首版（无旧版）不压栈。
 * return 直接可写回 node.decision / node.decision_history。
 */
export function applyDecisionWrite(
  prevDecision: NodeDecision | undefined,
  history: DecisionHistoryEntry[] | undefined,
  next: NodeDecision | null | undefined,
  opts?: { author?: string; note?: string; now?: string },
): { decision: NodeDecision | undefined; decision_history: DecisionHistoryEntry[] | undefined } {
  // 未传 decision 字段：不改
  if (next === undefined) return { decision: prevDecision, decision_history: history };
  // null ⇒ 清除
  if (next === null) return { decision: undefined, decision_history: undefined };

  const now = opts?.now ?? new Date().toISOString();
  // 新决策：时间戳恒打；author 传入才打（不伪造）
  const decision: NodeDecision = opts?.author ? { ...next, author: opts.author, updated_at: now } : { ...next, updated_at: now };

  // 旧版存在 → 压栈（首版不压）
  let decision_history = history;
  if (prevDecision) {
    decision_history = [...(history ?? []), { at: now, decision: prevDecision, note: opts?.note, author: opts?.author }];
  }
  return { decision, decision_history };
}

export function updateNode(input: UpdateNodeInput): EditResult {
  const { feature, node_id, label, x, y, width, height, bg, color, border, borderRadius, shape, shadow, opacity, type, description, status, swimlane, content, sub_dsl, layer, host, shapes, attributes, decision, decision_note, author } = input;

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
  // decision 更新=版本演进：旧版压入 decision_history，新版成为当前生效版（author/updated_at 由纯函数打）。
  if (decision !== undefined) {
    const { decision: nd, decision_history: nh } = applyDecisionWrite(node.decision, node.decision_history, decision, {
      author,
      note: decision_note,
    });
    if (nd === undefined) {
      delete node.decision;
      delete node.decision_history;
    } else {
      node.decision = nd;
      if (nh?.length) node.decision_history = nh;
    }
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
