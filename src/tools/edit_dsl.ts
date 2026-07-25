/**
 * edit_dsl 工具实现
 *
 * 提供增量编辑功能，让 LLM 能逐步完善设计，而不是每次重写整个 JSON。
 *
 * 常用工作流：
 *   create_feature → add_node × N → add_edge × M → render_dsl
 *   或者：get_dsl → add_node → update_node → render_dsl
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DesignDSL, Node, Edge, NodeStyle, NodeContent, DiagramStatus, SemanticFile, ExpectedApi, NodeLayer } from '../dsl/types.js';
import { getDSL, saveDSL } from '../storage.js';

// ─────────────────────────────────────────────────────────────
// create_feature：创建新 feature
// ─────────────────────────────────────────────────────────────

export interface CreateFeatureInput {
  feature: string;
  title?: string;
  description?: string;
}

export interface EditResult {
  message: string;
  feature: string;
}

export function createFeature(input: CreateFeatureInput): EditResult {
  const { feature, title, description } = input;

  if (!/^[a-zA-Z0-9_-]+$/.test(feature)) {
    throw new Error(`非法 feature 名: "${feature}"，必须匹配 ^[a-zA-Z0-9_-]+$`);
  }

  const existing = getDSL(feature);
  if (existing) {
    throw new Error(`feature "${feature}" 已存在，使用 update_node 或 add_node 进行修改`);
  }

  const dsl: DesignDSL = {
    id: `feature_${feature}`,
    type: 'feature_diagram',
    feature,
    version: '1.0.0',
    title: title || feature,
    status: 'draft',
    geometry: {
      layout: 'vertical_flow',
      width: 800,
      height: 600,
      nodes: [],
      edges: [],
    },
    semantic: {
      files: [],
      multi_file_invariants: [],
    },
    annotations: [],
  };

  const file = saveDSL(dsl);

  return {
    message: [
      `已创建 feature: ${feature}`,
      `标题: ${dsl.title}`,
      `状态: draft`,
      `文件: ${file}`,
    ].join('\n'),
    feature,
  };
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
}

export function addNode(input: AddNodeInput): EditResult {
  const { feature, node_id, label, x, y, width, height, bg, color, border, borderRadius, shape, shadow, opacity, type, description, status, swimlane, content, sub_dsl, layer, host } = input;

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
}

export function updateNode(input: UpdateNodeInput): EditResult {
  const { feature, node_id, label, x, y, width, height, bg, color, border, borderRadius, shape, shadow, opacity, type, description, status, swimlane, content, sub_dsl, layer, host } = input;

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

// ─────────────────────────────────────────────────────────────
// add_file：添加语义文件
// ─────────────────────────────────────────────────────────────

export interface AddFileInput {
  feature: string;
  file_id: string;
  path: string;
  responsibility: string;
  expected_apis?: ExpectedApi[];
  expected_deps?: string[];
  expected_behavior?: string;
  status?: DiagramStatus;
}

export function addFile(input: AddFileInput): EditResult {
  const { feature, file_id, path, responsibility, expected_apis, expected_deps, expected_behavior, status } = input;

  const dsl = getDSL(feature);
  if (!dsl) throw new Error(`feature "${feature}" 不存在`);
  if (!dsl.semantic) dsl.semantic = { files: [] };

  if (dsl.semantic.files.find(f => f.id === file_id)) {
    throw new Error(`文件 "${file_id}" 已存在，使用 update_file 修改`);
  }

  const file: SemanticFile = {
    id: file_id,
    path,
    responsibility,
    expected_apis,
    expected_deps,
    expected_behavior,
    status,
  };

  dsl.semantic.files.push(file);
  saveDSL(dsl);

  return {
    message: [
      `已添加文件: ${file_id}`,
      `路径: ${path}`,
      `职责: ${responsibility}`,
      `API 数: ${expected_apis?.length ?? 0}`,
      `当前文件数: ${dsl.semantic.files.length}`,
    ].join('\n'),
    feature,
  };
}

// ─────────────────────────────────────────────────────────────
// update_file：更新语义文件
// ─────────────────────────────────────────────────────────────

export interface UpdateFileInput {
  feature: string;
  file_id: string;
  path?: string;
  responsibility?: string;
  expected_deps?: string[];
  expected_behavior?: string;
  status?: DiagramStatus;
}

export function updateFile(input: UpdateFileInput): EditResult {
  const { feature, file_id, path, responsibility, expected_deps, expected_behavior, status } = input;

  const dsl = getDSL(feature);
  if (!dsl || !dsl.semantic) throw new Error(`feature "${feature}" 不存在或没有 semantic 层`);

  const file = dsl.semantic.files.find(f => f.id === file_id);
  if (!file) throw new Error(`文件 "${file_id}" 不存在`);

  if (path !== undefined) file.path = path;
  if (responsibility !== undefined) file.responsibility = responsibility;
  if (expected_deps !== undefined) file.expected_deps = expected_deps;
  if (expected_behavior !== undefined) file.expected_behavior = expected_behavior;
  if (status !== undefined) file.status = status;

  saveDSL(dsl);

  return {
    message: `已更新文件: ${file_id}\n路径: ${file.path}\n职责: ${file.responsibility}`,
    feature,
  };
}

// ─────────────────────────────────────────────────────────────
// delete_file：删除语义文件
// ─────────────────────────────────────────────────────────────

export interface DeleteFileInput {
  feature: string;
  file_id: string;
}

export function deleteFile(input: DeleteFileInput): EditResult {
  const { feature, file_id } = input;

  const dsl = getDSL(feature);
  if (!dsl || !dsl.semantic) throw new Error(`feature "${feature}" 不存在或没有 semantic 层`);

  const idx = dsl.semantic.files.findIndex(f => f.id === file_id);
  if (idx === -1) throw new Error(`文件 "${file_id}" 不存在`);

  const removed = dsl.semantic.files[idx];
  dsl.semantic.files.splice(idx, 1);
  saveDSL(dsl);

  return {
    message: `已删除文件: ${file_id} (${removed.path})\n剩余文件数: ${dsl.semantic.files.length}`,
    feature,
  };
}

// ─────────────────────────────────────────────────────────────
// add_expected_api：添加预期 API
// ─────────────────────────────────────────────────────────────

export interface AddExpectedApiInput {
  feature: string;
  file_id: string;
  signature: string;
  notes?: string;
}

export function addExpectedApi(input: AddExpectedApiInput): EditResult {
  const { feature, file_id, signature, notes } = input;

  const dsl = getDSL(feature);
  if (!dsl || !dsl.semantic) throw new Error(`feature "${feature}" 不存在或没有 semantic 层`);

  const file = dsl.semantic.files.find(f => f.id === file_id);
  if (!file) throw new Error(`文件 "${file_id}" 不存在`);

  if (!file.expected_apis) file.expected_apis = [];
  file.expected_apis.push({ signature, notes });
  saveDSL(dsl);

  return {
    message: `已添加 API: ${signature}\n文件: ${file_id}\n当前 API 数: ${file.expected_apis.length}`,
    feature,
  };
}

// ─────────────────────────────────────────────────────────────
// update_expected_api：更新预期 API（按签名匹配）
// ─────────────────────────────────────────────────────────────

export interface UpdateExpectedApiInput {
  feature: string;
  file_id: string;
  signature: string;
  new_signature?: string;
  notes?: string;
}

export function updateExpectedApi(input: UpdateExpectedApiInput): EditResult {
  const { feature, file_id, signature, new_signature, notes } = input;

  const dsl = getDSL(feature);
  if (!dsl || !dsl.semantic) throw new Error(`feature "${feature}" 不存在或没有 semantic 层`);

  const file = dsl.semantic.files.find(f => f.id === file_id);
  if (!file) throw new Error(`文件 "${file_id}" 不存在`);

  const api = file.expected_apis?.find(a => a.signature === signature);
  if (!api) throw new Error(`API "${signature}" 不存在于文件 "${file_id}"`);

  if (new_signature !== undefined) api.signature = new_signature;
  if (notes !== undefined) api.notes = notes;
  saveDSL(dsl);

  return { message: `已更新 API: ${api.signature}`, feature };
}

// ─────────────────────────────────────────────────────────────
// delete_expected_api：删除预期 API
// ─────────────────────────────────────────────────────────────

export interface DeleteExpectedApiInput {
  feature: string;
  file_id: string;
  signature: string;
}

export function deleteExpectedApi(input: DeleteExpectedApiInput): EditResult {
  const { feature, file_id, signature } = input;

  const dsl = getDSL(feature);
  if (!dsl || !dsl.semantic) throw new Error(`feature "${feature}" 不存在或没有 semantic 层`);

  const file = dsl.semantic.files.find(f => f.id === file_id);
  if (!file) throw new Error(`文件 "${file_id}" 不存在`);

  const idx = file.expected_apis?.findIndex(a => a.signature === signature) ?? -1;
  if (idx === -1) throw new Error(`API "${signature}" 不存在`);

  file.expected_apis!.splice(idx, 1);
  saveDSL(dsl);

  return {
    message: `已删除 API: ${signature}\n剩余 API 数: ${file.expected_apis!.length}`,
    feature,
  };
}

// ─────────────────────────────────────────────────────────────
// set_node_semantic：绑定节点与语义文件（自动同步状态）
// ─────────────────────────────────────────────────────────────

export interface SetNodeSemanticInput {
  feature: string;
  node_id: string;
  file_id: string;
  sync_status?: boolean;
}

export function setNodeSemantic(input: SetNodeSemanticInput): EditResult {
  const { feature, node_id, file_id, sync_status = true } = input;

  const dsl = getDSL(feature);
  if (!dsl) throw new Error(`feature "${feature}" 不存在`);

  const node = dsl.geometry.nodes.find(n => n.id === node_id);
  if (!node) throw new Error(`节点 "${node_id}" 不存在`);

  const file = dsl.semantic?.files.find(f => f.id === file_id);
  if (!file) throw new Error(`文件 "${file_id}" 不存在`);

  if (sync_status) {
    const targetStatus = file.status || node.status || 'draft';
    node.status = targetStatus;
    file.status = targetStatus;
  }

  saveDSL(dsl);

  return {
    message: [
      `已绑定节点 "${node_id}" 与文件 "${file_id}"`,
      `节点标签: ${node.label}`,
      `文件路径: ${file.path}`,
      sync_status ? `状态同步: ${node.status}` : '状态不同步',
    ].join('\n'),
    feature,
  };
}

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

// ─────────────────────────────────────────────────────────────
// clone_feature：克隆一个 feature 为新的 feature
// ─────────────────────────────────────────────────────────────

export interface CloneFeatureInput {
  source_feature: string;
  target_feature: string;
  title?: string;
}

export interface CloneFeatureResult {
  message: string;
  source_feature: string;
  target_feature: string;
  nodes_copied: number;
  edges_copied: number;
}

export function cloneFeature(input: CloneFeatureInput): CloneFeatureResult {
  const { source_feature, target_feature, title } = input;

  if (!/^[a-zA-Z0-9_-]+$/.test(target_feature)) {
    throw new Error(`非法 target_feature 名: "${target_feature}"，必须匹配 ^[a-zA-Z0-9_-]+$`);
  }

  const source = getDSL(source_feature);
  if (!source) throw new Error(`source_feature "${source_feature}" 不存在`);

  const existing = getDSL(target_feature);
  if (existing) throw new Error(`target_feature "${target_feature}" 已存在`);

  const cloned: DesignDSL = JSON.parse(JSON.stringify(source));
  cloned.feature = target_feature;
  cloned.id = 'feature_' + target_feature;
  if (title) cloned.title = title;
  else if (cloned.title) cloned.title = cloned.title + ' (副本)';

  const nodeCount = cloned.geometry.nodes.length;
  const edgeCount = (cloned.geometry.edges ?? []).length;

  saveDSL(cloned);

  return {
    message: [
      `已克隆 feature: ${source_feature} → ${target_feature}`,
      `节点: ${nodeCount} 个`,
      `边: ${edgeCount} 条`,
      `标题: ${cloned.title}`,
    ].join('\n'),
    source_feature,
    target_feature,
    nodes_copied: nodeCount,
    edges_copied: edgeCount,
  };
}

// ─────────────────────────────────────────────────────────────
// diff_features：对比两个 feature 的差异
// ─────────────────────────────────────────────────────────────

export interface DiffFeaturesInput {
  feature_a: string;
  feature_b: string;
}

export interface DiffItem {
  type: 'added' | 'removed' | 'modified';
  category: 'node' | 'edge' | 'semantic' | 'annotation' | 'meta';
  id?: string;
  field?: string;
  old_value?: unknown;
  new_value?: unknown;
  description: string;
}

export interface DiffFeaturesResult {
  message: string;
  feature_a: string;
  feature_b: string;
  diffs: DiffItem[];
  summary: {
    added: number;
    removed: number;
    modified: number;
  };
}

export function diffFeatures(input: DiffFeaturesInput): DiffFeaturesResult {
  const { feature_a, feature_b } = input;

  const dslA = getDSL(feature_a);
  if (!dslA) throw new Error(`feature_a "${feature_a}" 不存在`);

  const dslB = getDSL(feature_b);
  if (!dslB) throw new Error(`feature_b "${feature_b}" 不存在`);

  const diffs: DiffItem[] = [];

  // 节点对比
  const nodesA = new Map(dslA.geometry.nodes.map(n => [n.id, n]));
  const nodesB = new Map(dslB.geometry.nodes.map(n => [n.id, n]));

  for (const [id, nodeA] of nodesA) {
    if (!nodesB.has(id)) {
      diffs.push({
        type: 'removed',
        category: 'node',
        id,
        description: `节点已删除: ${nodeA.label || id}`,
      });
    } else {
      const nodeB = nodesB.get(id)!;
      if (nodeA.label !== nodeB.label) {
        diffs.push({
          type: 'modified',
          category: 'node',
          id,
          field: 'label',
          old_value: nodeA.label,
          new_value: nodeB.label,
          description: `节点标签变更: ${nodeA.label || id} → ${nodeB.label || id}`,
        });
      }
      if (nodeA.type !== nodeB.type) {
        diffs.push({
          type: 'modified',
          category: 'node',
          id,
          field: 'type',
          old_value: nodeA.type,
          new_value: nodeB.type,
          description: `节点类型变更: ${id}`,
        });
      }
    }
  }

  for (const [id, nodeB] of nodesB) {
    if (!nodesA.has(id)) {
      diffs.push({
        type: 'added',
        category: 'node',
        id,
        description: `新增节点: ${nodeB.label || id}`,
      });
    }
  }

  // 边对比
  const edgesA = new Map((dslA.geometry.edges ?? []).map(e => [e.id, e]));
  const edgesB = new Map((dslB.geometry.edges ?? []).map(e => [e.id, e]));

  for (const [id, edgeA] of edgesA) {
    if (!edgesB.has(id)) {
      diffs.push({
        type: 'removed',
        category: 'edge',
        id,
        description: `边已删除: ${edgeA.from} → ${edgeA.to}`,
      });
    }
  }

  for (const [id, edgeB] of edgesB) {
    if (!edgesA.has(id)) {
      diffs.push({
        type: 'added',
        category: 'edge',
        id,
        description: `新增边: ${edgeB.from} → ${edgeB.to}`,
      });
    }
  }

  // 语义层对比
  const filesA = new Map((dslA.semantic?.files ?? []).map(f => [f.id, f]));
  const filesB = new Map((dslB.semantic?.files ?? []).map(f => [f.id, f]));

  for (const [id, fileA] of filesA) {
    if (!filesB.has(id)) {
      diffs.push({
        type: 'removed',
        category: 'semantic',
        id,
        description: `语义文件已删除: ${fileA.path}`,
      });
    } else {
      const fileB = filesB.get(id)!;
      const apisA = new Set((fileA.expected_apis ?? []).map(a => a.signature));
      const apisB = new Set((fileB.expected_apis ?? []).map(a => a.signature));
      for (const api of apisA) {
        if (!apisB.has(api)) {
          diffs.push({
            type: 'removed',
            category: 'semantic',
            id: id + ':' + api,
            description: `API 已删除: ${fileA.path} - ${api}`,
          });
        }
      }
      for (const api of apisB) {
        if (!apisA.has(api)) {
          diffs.push({
            type: 'added',
            category: 'semantic',
            id: id + ':' + api,
            description: `新增 API: ${fileB.path} - ${api}`,
          });
        }
      }
    }
  }

  for (const [id, fileB] of filesB) {
    if (!filesA.has(id)) {
      diffs.push({
        type: 'added',
        category: 'semantic',
        id,
        description: `新增语义文件: ${fileB.path}`,
      });
    }
  }

  // 状态对比
  if (dslA.status !== dslB.status) {
    diffs.push({
      type: 'modified',
      category: 'meta',
      field: 'status',
      old_value: dslA.status,
      new_value: dslB.status,
      description: `状态变更: ${dslA.status} → ${dslB.status}`,
    });
  }

  // 统计
  const added = diffs.filter(d => d.type === 'added').length;
  const removed = diffs.filter(d => d.type === 'removed').length;
  const modified = diffs.filter(d => d.type === 'modified').length;

  const lines: string[] = [];
  lines.push(`差异对比: ${feature_a} vs ${feature_b}`);
  lines.push('');
  lines.push(`总计: +${added} 新增, -${removed} 删除, ~${modified} 修改`);
  lines.push('');
  if (diffs.length === 0) {
    lines.push('两个 feature 完全相同');
  } else {
    const categories = ['node', 'edge', 'semantic', 'meta'] as const;
    for (const cat of categories) {
      const catDiffs = diffs.filter(d => d.category === cat);
      if (catDiffs.length === 0) continue;
      lines.push(`【${cat}】`);
      for (const d of catDiffs.slice(0, 10)) {
        const prefix = d.type === 'added' ? '+' : d.type === 'removed' ? '-' : '~';
        lines.push(`  ${prefix} ${d.description}`);
      }
      if (catDiffs.length > 10) {
        lines.push(`  ... 还有 ${catDiffs.length - 10} 项`);
      }
      lines.push('');
    }
  }

  return {
    message: lines.join('\n'),
    feature_a,
    feature_b,
    diffs,
    summary: { added, removed, modified },
  };
}
