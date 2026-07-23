/**
 * annotation_tools 工具实现
 *
 * 人审流程：人类在浏览器中给节点添加标注（双击节点），
 * LLM 通过这些工具读取标注，并据此迭代修改设计。
 *
 * 工作流：
 *   1. 人类在浏览器双击节点 → 弹窗输入标注
 *   2. 标注自动保存到 dsl.annotations[] + localStorage
 *   3. LLM 调用 list_annotations 读取所有标注
 *   4. LLM 修改设计以解决标注中的问题
 *   5. LLM 调用 resolve_annotation 关闭已解决的标注
 */

import type { DesignDSL } from '../dsl/types.js';
import { getDSL, saveDSL } from '../storage.js';

// ─────────────────────────────────────────────────────────────
// list_annotations：列出所有标注
// ─────────────────────────────────────────────────────────────

export interface ListAnnotationsInput {
  feature: string;
  /** 可选，按节点 ID 过滤 */
  node_id?: string;
  /** 可选，按严重程度过滤 */
  severity?: 'info' | 'warning' | 'critical';
  /** 可选，只显示未解决的 */
  unresolved_only?: boolean;
}

export interface AnnotationView {
  id: string;
  node_id?: string;
  text: string;
  type: string;
  severity: string;
  author?: string;
  timestamp?: string;
  resolved: boolean;
}

export function listAnnotations(input: ListAnnotationsInput): { message: string; annotations: AnnotationView[] } {
  const { feature, node_id, severity, unresolved_only } = input;

  const dsl = getDSL(feature);
  if (!dsl) {
    throw new Error(`feature "${feature}" 不存在`);
  }

  let annotations = dsl.annotations || [];

  if (node_id) {
    annotations = annotations.filter(a => a.node_id === node_id);
  }
  if (severity) {
    annotations = annotations.filter(a => a.severity === severity);
  }
  if (unresolved_only) {
    annotations = annotations.filter(a => !a.resolved);
  }

  const views: AnnotationView[] = annotations.map(a => ({
    id: a.id,
    node_id: a.node_id,
    text: a.text,
    type: a.type || 'comment',
    severity: a.severity || 'info',
    author: a.author,
    timestamp: a.timestamp,
    resolved: !!a.resolved,
  }));

  const lines = views.length === 0
    ? ['暂无标注。']
    : views.map((a, i) => {
      const typeLabel = { question: '❓', issue: '⚠️', suggestion: '💡', approval: '✅', comment: '📌' }[a.type] || '📌';
      const status = a.resolved ? '✓ 已解决' : '○ 未解决';
      return `${i + 1}. [${typeLabel} ${a.severity}] ${status} ${a.node_id || '通用'}\n   ${a.text}\n   — ${a.author || 'unknown'} · ${a.timestamp || ''} · id=${a.id}`;
    });

  return {
    message: [
      `feature "${feature}" 共有 ${views.length} 条标注${unresolved_only ? '（未解决）' : ''}：`,
      '',
      ...lines,
    ].join('\n'),
    annotations: views,
  };
}

// ─────────────────────────────────────────────────────────────
// resolve_annotation：标记标注已解决
// ─────────────────────────────────────────────────────────────

export interface ResolveAnnotationInput {
  feature: string;
  annotation_id: string;
  /** 解决说明（可选） */
  resolution_note?: string;
}

export function resolveAnnotation(input: ResolveAnnotationInput): { message: string } {
  const { feature, annotation_id, resolution_note } = input;

  const dsl = getDSL(feature);
  if (!dsl) {
    throw new Error(`feature "${feature}" 不存在`);
  }

  if (!dsl.annotations) {
    throw new Error(`feature "${feature}" 没有标注`);
  }

  const anno = dsl.annotations.find(a => a.id === annotation_id);
  if (!anno) {
    throw new Error(`标注 "${annotation_id}" 不存在`);
  }

  anno.resolved = true;
  anno.resolved_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
  if (resolution_note) {
    anno.resolution_note = resolution_note;
  }

  saveDSL(dsl);

  return {
    message: `已标记标注 ${annotation_id} 为已解决${resolution_note ? '\n说明: ' + resolution_note : ''}`,
  };
}

// ─────────────────────────────────────────────────────────────
// add_annotation：LLM 主动添加标注
// ─────────────────────────────────────────────────────────────

export interface AddAnnotationInput {
  feature: string;
  text: string;
  node_id?: string;
  type?: 'comment' | 'question' | 'issue' | 'suggestion' | 'approval';
  severity?: 'info' | 'warning' | 'critical';
  author?: string;
}

export function addAnnotationByTool(input: AddAnnotationInput): { message: string; annotation_id: string } {
  const { feature, text, node_id, type, severity, author } = input;

  const dsl = getDSL(feature);
  if (!dsl) {
    throw new Error(`feature "${feature}" 不存在`);
  }

  const id = 'anno_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

  if (!dsl.annotations) dsl.annotations = [];

  dsl.annotations.push({
    id,
    node_id,
    text,
    type: type || 'comment',
    severity: severity || 'info',
    author: author || 'llm',
    timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
    resolved: false,
  });

  saveDSL(dsl);

  return {
    message: `已添加标注 ${id} (${type || 'comment'}/${severity || 'info'}) ${node_id || '通用'}: ${text}`,
    annotation_id: id,
  };
}
