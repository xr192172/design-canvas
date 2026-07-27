/**
 * feature 级操作：create_feature / clone_feature
 */

import type { DesignDSL } from '../dsl/types.js';
import { getDSL, saveDSL } from '../storage.js';
import type { EditResult } from './edit_result.js';

// ─────────────────────────────────────────────────────────────
// create_feature：创建新 feature
// ─────────────────────────────────────────────────────────────

export interface CreateFeatureInput {
  feature: string;
  title?: string;
  description?: string;
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
