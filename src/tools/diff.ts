/**
 * diff_features：对比两个 feature 的差异
 */

import { getDSLByView } from '../storage.js';

export interface DiffFeaturesInput {
  feature_a: string;
  feature_b: string;
  /** feature_a 视图层级，默认 design */
  view_a?: 'design' | 'live';
  /** feature_b 视图层级，默认 design；对比"设计 vs 代码现状"时设 live */
  view_b?: 'design' | 'live';
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
  const { feature_a, feature_b, view_a = 'design', view_b = 'design' } = input;

  const dslA = getDSLByView(feature_a, view_a);
  if (!dslA) throw new Error(`feature_a "${feature_a}" 不存在（视图: ${view_a}）`);

  const dslB = getDSLByView(feature_b, view_b);
  if (!dslB) throw new Error(`feature_b "${feature_b}" 不存在（视图: ${view_b}）`);

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
  lines.push(`差异对比: ${feature_a}(${view_a}) vs ${feature_b}(${view_b})`);
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
