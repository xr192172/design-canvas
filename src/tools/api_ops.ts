/**
 * 预期 API 操作：add_expected_api / update_expected_api / delete_expected_api / set_node_semantic
 */

import { getDSL, saveDSL } from '../storage.js';
import type { EditResult } from './edit_result.js';

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
