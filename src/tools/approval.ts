/**
 * 人审/审批工作流工具
 *
 * - submit_approval: 提交审批
 * - review_annotation: 审批（通过/驳回/要求修改）
 * - list_approvals: 列出所有审批（支持按状态筛选）
 * - get_approval_history: 获取单条审批的完整审计日志
 */

import { getDSL, saveDSL } from '../storage.js';
import type { Annotation, ApprovalStatus, ApprovalHistoryEntry } from '../dsl/types.js';

function now(): string {
  return new Date().toISOString();
}

function uid(prefix: string = 'h'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** 确保 annotation 有 approval_history */
function ensureHistory(ann: Annotation): ApprovalHistoryEntry[] {
  if (!ann.approval_history) ann.approval_history = [];
  return ann.approval_history;
}

/** 添加一条审批历史记录 */
function addHistory(ann: Annotation, action: ApprovalHistoryEntry['action'], status: ApprovalStatus, actor: string, comment?: string): void {
  const history = ensureHistory(ann);
  history.push({
    id: uid('ah'),
    action,
    status,
    actor,
    comment,
    timestamp: now(),
  });
  ann.approval_status = status;
  // 兼容旧字段
  if (status === 'approved') {
    ann.resolved = true;
    ann.resolved_at = now();
    ann.resolution_note = comment;
  }
}

// ─────────────────────────────────────────────────────────────
// submit_approval
// ─────────────────────────────────────────────────────────────

export interface SubmitApprovalInput {
  feature: string;
  annotation_id: string;
  assignee?: string;
  submitter?: string;
  comment?: string;
}

export interface SubmitApprovalResult {
  message: string;
  feature: string;
  annotation_id: string;
  status: ApprovalStatus;
}

export function submitApproval(input: SubmitApprovalInput): SubmitApprovalResult {
  const dsl = getDSL(input.feature);
  if (!dsl) throw new Error(`feature "${input.feature}" 不存在`);
  if (!dsl.annotations) throw new Error('该 feature 没有标注');

  const ann = dsl.annotations.find(a => a.id === input.annotation_id);
  if (!ann) throw new Error(`标注 "${input.annotation_id}" 不存在`);

  if (ann.approval_status === 'pending_review') {
    throw new Error('该标注已在审批中，无法重复提交');
  }

  if (input.assignee) {
    ann.assignee = input.assignee;
  }

  addHistory(ann, 'submit', 'pending_review', input.submitter ?? 'llm', input.comment);
  saveDSL(dsl);

  return {
    message: `已提交审批：${ann.id}\n状态: pending_review\n指派人: ${ann.assignee ?? '(未指派)'}`,
    feature: input.feature,
    annotation_id: ann.id,
    status: 'pending_review',
  };
}

// ─────────────────────────────────────────────────────────────
// review_annotation
// ─────────────────────────────────────────────────────────────

export interface ReviewAnnotationInput {
  feature: string;
  annotation_id: string;
  decision: 'approve' | 'reject' | 'request_revision';
  reviewer: string;
  comment?: string;
}

export interface ReviewAnnotationResult {
  message: string;
  feature: string;
  annotation_id: string;
  status: ApprovalStatus;
}

export function reviewAnnotation(input: ReviewAnnotationInput): ReviewAnnotationResult {
  const dsl = getDSL(input.feature);
  if (!dsl) throw new Error(`feature "${input.feature}" 不存在`);
  if (!dsl.annotations) throw new Error('该 feature 没有标注');

  const ann = dsl.annotations.find(a => a.id === input.annotation_id);
  if (!ann) throw new Error(`标注 "${input.annotation_id}" 不存在`);

  if (ann.approval_status !== 'pending_review') {
    throw new Error(`当前状态为 ${ann.approval_status ?? 'draft'}，无法审批。请先提交审批。`);
  }

  let action: ApprovalHistoryEntry['action'];
  let status: ApprovalStatus;

  switch (input.decision) {
    case 'approve':
      action = 'approve';
      status = 'approved';
      break;
    case 'reject':
      action = 'reject';
      status = 'rejected';
      break;
    case 'request_revision':
      action = 'request_revision';
      status = 'needs_revision';
      break;
    default:
      throw new Error(`未知决策: ${input.decision}`);
  }

  addHistory(ann, action, status, input.reviewer, input.comment);
  saveDSL(dsl);

  const statusLabel = {
    approve: '已通过',
    reject: '已驳回',
    request_revision: '要求修改',
  }[input.decision];

  return {
    message: `审批${statusLabel}：${ann.id}\n审批人: ${input.reviewer}\n意见: ${input.comment ?? '(无)'}`,
    feature: input.feature,
    annotation_id: ann.id,
    status,
  };
}

// ─────────────────────────────────────────────────────────────
// list_approvals
// ─────────────────────────────────────────────────────────────

export interface ListApprovalsInput {
  feature: string;
  status?: ApprovalStatus;
  assignee?: string;
}

export interface ListApprovalsResult {
  message: string;
  feature: string;
  annotations: Array<{
    id: string;
    text: string;
    type?: string;
    status: ApprovalStatus | 'draft';
    assignee?: string;
    node_id?: string;
    history_count: number;
  }>;
}

export function listApprovals(input: ListApprovalsInput): ListApprovalsResult {
  const dsl = getDSL(input.feature);
  if (!dsl) throw new Error(`feature "${input.feature}" 不存在`);

  const annotations = dsl.annotations ?? [];
  let filtered = annotations;

  if (input.status) {
    filtered = filtered.filter(a => (a.approval_status ?? 'draft') === input.status);
  }
  if (input.assignee) {
    filtered = filtered.filter(a => a.assignee === input.assignee);
  }

  const result = filtered.map(a => ({
    id: a.id,
    text: a.text.slice(0, 60) + (a.text.length > 60 ? '...' : ''),
    type: a.type,
    status: a.approval_status ?? 'draft',
    assignee: a.assignee,
    node_id: a.node_id ?? a.target_id,
    history_count: a.approval_history?.length ?? 0,
  }));

  const statusLabel = input.status ? ` (状态: ${input.status})` : '';
  const assigneeLabel = input.assignee ? ` (指派人: ${input.assignee})` : '';

  const lines: string[] = [];
  lines.push(`审批列表${statusLabel}${assigneeLabel}：共 ${result.length} 条`);
  lines.push('');
  for (const a of result) {
    const icon = {
      draft: '📝',
      pending_review: '⏳',
      approved: '✅',
      rejected: '❌',
      needs_revision: '🔄',
    }[a.status] ?? '❓';
    lines.push(`  ${icon} [${a.status}] ${a.id} — ${a.text}`);
    if (a.assignee) lines.push(`     指派人: ${a.assignee}`);
    if (a.node_id) lines.push(`     节点: ${a.node_id}`);
    lines.push('');
  }

  return {
    message: lines.join('\n'),
    feature: input.feature,
    annotations: result,
  };
}

// ─────────────────────────────────────────────────────────────
// get_approval_history
// ─────────────────────────────────────────────────────────────

export interface GetApprovalHistoryInput {
  feature: string;
  annotation_id: string;
}

export interface GetApprovalHistoryResult {
  message: string;
  feature: string;
  annotation_id: string;
  current_status: ApprovalStatus | 'draft';
  history: ApprovalHistoryEntry[];
}

export function getApprovalHistory(input: GetApprovalHistoryInput): GetApprovalHistoryResult {
  const dsl = getDSL(input.feature);
  if (!dsl) throw new Error(`feature "${input.feature}" 不存在`);
  if (!dsl.annotations) throw new Error('该 feature 没有标注');

  const ann = dsl.annotations.find(a => a.id === input.annotation_id);
  if (!ann) throw new Error(`标注 "${input.annotation_id}" 不存在`);

  const history = ann.approval_history ?? [];
  const currentStatus = ann.approval_status ?? 'draft';

  const lines: string[] = [];
  lines.push(`审批历史：${ann.id}`);
  lines.push(`当前状态: ${currentStatus}`);
  lines.push(`标注内容: ${ann.text}`);
  lines.push('');
  lines.push('历史记录：');
  for (const h of history) {
    const actionLabel = {
      submit: '📤 提交',
      approve: '✅ 通过',
      reject: '❌ 驳回',
      request_revision: '🔄 要求修改',
      revise: '✏️ 修改后提交',
      close: '🔒 关闭',
    }[h.action] ?? h.action;
    lines.push(`  ${h.timestamp}`);
    lines.push(`    ${actionLabel} — ${h.actor}`);
    if (h.comment) lines.push(`    意见: ${h.comment}`);
    lines.push('');
  }

  return {
    message: lines.join('\n'),
    feature: input.feature,
    annotation_id: ann.id,
    current_status: currentStatus,
    history,
  };
}
