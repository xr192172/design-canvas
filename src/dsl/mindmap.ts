/**
 * L3 思维导图层类型：把 L2 设计图层（feature_tree 功能树 + semantic 语义文件）
 * 提炼成普通人能看懂的逐级思维导图。
 *
 * 三层架构：
 *   L1 实际代码层（live/）——代码实时快照
 *   L2 设计/图层（design-canvas.json）——几何 + 语义 DSL
 *   L3 总结层（本文件）——内置 LLM 将 L2 提炼为思维导图，修改可回写 L2
 *
 * 锚点约定：每个 L3 节点 id 尽力与 L2/L1 共享（如文件节点 id = file_xxx），
 * 保证"思维导图 → 设计图 → 实际代码"可追溯；无法精确对齐时用 l2_ref 显式引用。
 */

/** 思维导图节点类型 */
export type MindMapKind = 'root' | 'feature' | 'community' | 'file' | 'note';

/** 思维导图节点 */
export interface MindMapNode {
  /** 锚点 id，尽力与 L2/L1 共享（文件节点 = file_xxx） */
  id: string;
  /** 节点标题（中文，普通人可读） */
  label: string;
  /** 一句话说明（人话，解释这个模块/文件是干嘛的） */
  description: string;
  /** 节点类型 */
  kind: MindMapKind;
  /** 指标（可选） */
  meta?: {
    /** 下层文件数（root/feature/community 聚合） */
    files?: number;
    /** 估算行数（community） */
    lines?: number;
    /** 符号数 */
    symbols?: number;
    /** 指向 L2 设计图层节点的显式引用（无法用 id 对齐时） */
    l2_ref?: string;
  };
  /** 子节点 */
  children?: MindMapNode[];
}

/** L3 思维导图 */
export interface MindMap {
  /** feature 名 */
  feature: string;
  /** 生成方式：llm=LLM 提炼；rule=规则骨架（未配置 LLM 或失败降级） */
  mode: 'llm' | 'rule';
  /** 根节点 */
  root: MindMapNode;
  /** 生成时间 */
  generated_at: string;
  /** 说明（生成方式/降级原因） */
  note?: string;
}