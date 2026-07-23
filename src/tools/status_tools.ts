/**
 * status_tools 工具实现
 *
 * 提供状态回填功能：
 * - update_status：手动更新节点/文件状态
 * - check_status：扫描 scaffold 生成的代码文件，根据 TODO 残留量自动推断状态
 *
 * 工作流：
 *   LLM 写完代码 → check_status 扫描文件 → 自动标记 done/in_progress/draft
 *   或者：LLM 调用 update_status 手动标记
 *   → render_dsl 重新渲染，节点颜色随状态变化
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DesignDSL, DiagramStatus } from '../dsl/types.js';
import { getDSL, saveDSL } from '../storage.js';

// ─────────────────────────────────────────────────────────────
// update_status：手动更新节点/文件状态
// ─────────────────────────────────────────────────────────────

export interface UpdateStatusInput {
  /** feature 名 */
  feature: string;
  /** 节点 ID（对应 geometry.nodes.id 和 semantic.files.id） */
  node_id: string;
  /** 新状态 */
  status: DiagramStatus;
}

export interface StatusResult {
  message: string;
  feature: string;
}

export function updateStatus(input: UpdateStatusInput): StatusResult {
  const { feature, node_id, status } = input;

  const dsl = getDSL(feature);
  if (!dsl) {
    throw new Error(`feature "${feature}" 不存在`);
  }

  let updated = false;

  // 更新节点状态
  const node = dsl.geometry.nodes.find(n => n.id === node_id);
  if (node) {
    node.status = status;
    updated = true;
  }

  // 同步更新 semantic file 状态
  const file = dsl.semantic?.files.find(f => f.id === node_id);
  if (file) {
    file.status = status;
    updated = true;
  }

  if (!updated) {
    throw new Error(`节点 "${node_id}" 在 geometry 和 semantic 中均未找到`);
  }

  // 重新计算整体状态
  recomputeFeatureStatus(dsl);
  saveDSL(dsl);

  const statusLabel = { draft: '待实现', in_progress: '实现中', done: '已完成' }[status];
  return {
    message: [
      `已更新节点状态: ${node_id} → ${statusLabel}`,
      `feature 整体状态: ${dsl.status}`,
    ].join('\n'),
    feature,
  };
}

// ─────────────────────────────────────────────────────────────
// check_status：扫描代码文件自动推断状态
// ─────────────────────────────────────────────────────────────

export interface CheckStatusInput {
  /** feature 名 */
  feature: string;
  /** scaffold 输出根目录，默认 scaffold/<feature>/ */
  scaffold_dir?: string;
}

export function checkStatus(input: CheckStatusInput): StatusResult {
  const { feature, scaffold_dir } = input;

  const dsl = getDSL(feature);
  if (!dsl) {
    throw new Error(`feature "${feature}" 不存在`);
  }

  if (!dsl.semantic || !dsl.semantic.files || dsl.semantic.files.length === 0) {
    throw new Error(`feature "${feature}" 没有 semantic.files，无法检查状态`);
  }

  const baseDir = scaffold_dir
    ? path.resolve(scaffold_dir)
    : path.join(process.cwd(), 'scaffold', feature);

  const results: { id: string; status: DiagramStatus; detail: string }[] = [];

  for (const file of dsl.semantic.files) {
    const fullPath = path.join(baseDir, file.path);

    if (!fs.existsSync(fullPath)) {
      // 文件不存在 → draft
      if (file.status !== 'draft') {
        file.status = 'draft';
        const node = dsl.geometry.nodes.find(n => n.id === file.id);
        if (node) node.status = 'draft';
      }
      results.push({ id: file.id, status: 'draft', detail: '文件未创建' });
      continue;
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    const todoCount = (content.match(/TODO/g) || []).length;
    const notImplCount = (content.match(/Not implemented|NotImplemented|raise NotImplementedError/g) || []).length;
    const totalMarkers = todoCount + notImplCount;

    let newStatus: DiagramStatus;
    let detail: string;

    if (totalMarkers === 0) {
      newStatus = 'done';
      detail = '无 TODO 残留';
    } else if (totalMarkers <= 2) {
      newStatus = 'in_progress';
      detail = `${totalMarkers} 个 TODO 残留`;
    } else {
      newStatus = 'draft';
      detail = `${totalMarkers} 个 TODO 残留`;
    }

    // 更新 DSL
    file.status = newStatus;
    const node = dsl.geometry.nodes.find(n => n.id === file.id);
    if (node) node.status = newStatus;

    results.push({ id: file.id, status: newStatus, detail });
  }

  // 重新计算整体状态
  recomputeFeatureStatus(dsl);
  saveDSL(dsl);

  const statusLabel = { draft: '待实现', in_progress: '实现中', done: '已完成' };
  const lines = results.map(r => {
    const label = statusLabel[r.status];
    return `  ${r.id}: ${label} (${r.detail})`;
  });

  return {
    message: [
      `状态检查完成：feature "${feature}"`,
      `整体状态: ${statusLabel[dsl.status!]}`,
      '',
      '各文件状态：',
      ...lines,
      '',
      '提示：调用 render_dsl 重新渲染以查看状态可视化。',
    ].join('\n'),
    feature,
  };
}

// ─────────────────────────────────────────────────────────────
// 辅助：根据各节点状态重新计算 feature 整体状态
// ─────────────────────────────────────────────────────────────

function recomputeFeatureStatus(dsl: DesignDSL): void {
  const nodes = dsl.geometry.nodes;
  if (nodes.length === 0) {
    dsl.status = 'draft';
    return;
  }

  const statuses = nodes.map(n => n.status || 'draft');
  const doneCount = statuses.filter(s => s === 'done').length;
  const inProgressCount = statuses.filter(s => s === 'in_progress').length;

  if (doneCount === nodes.length) {
    dsl.status = 'done';
  } else if (doneCount > 0 || inProgressCount > 0) {
    dsl.status = 'in_progress';
  } else {
    dsl.status = 'draft';
  }
}
