/**
 * 语义文件操作：add_file / update_file / delete_file
 */

import type { DiagramStatus, SemanticFile, ExpectedApi } from '../dsl/types.js';
import { getDSL, saveDSL } from '../storage.js';
import type { EditResult } from './edit_result.js';

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
