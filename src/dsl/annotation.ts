/**
 * 标注与审批类型
 */

/** 审批状态 */
export type ApprovalStatus = 'draft' | 'pending_review' | 'approved' | 'rejected' | 'needs_revision';

/** 审批记录 */
export interface ApprovalHistoryEntry {
  id: string;
  status: ApprovalStatus;
  action: 'submit' | 'approve' | 'reject' | 'request_revision' | 'revise' | 'close';
  comment?: string;
  actor: string;
  timestamp: string;
}

/** 标注 */
export interface Annotation {
  id: string;
  /** 指向 node.id 或 edge.id（兼容字段：也支持 node_id） */
  target_id?: string;
  /** 新版：直接指明所属节点 ID */
  node_id?: string;
  text: string;
  /** 标注类型 */
  type?: 'comment' | 'question' | 'issue' | 'suggestion' | 'approval';
  /** 严重程度 */
  severity?: 'info' | 'warning' | 'critical';
  author?: 'human' | 'llm' | string;
  /** 创建时间 */
  created?: string;
  /** 时间戳（新增字段） */
  timestamp?: string;
  /** 是否已解决 */
  resolved?: boolean;
  /** 解决时间 */
  resolved_at?: string;
  /** 解决说明 */
  resolution_note?: string;
  /** 审批状态 */
  approval_status?: ApprovalStatus;
  /** 审批历史（审计日志） */
  approval_history?: ApprovalHistoryEntry[];
  /** 指派给谁 */
  assignee?: string;
  /** 标签（自定义分类） */
  tags?: string[];
}
