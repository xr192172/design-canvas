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

/** 科普分镜步骤（teach 模式 feature 节点专用，像科普视频的镜头脚本） */
export interface TeachStep {
  /** 步骤标题（≤12 字，动宾结构，如「接收用户输入」「写入结果缓存」） */
  title: string;
  /** 一步人话讲解：这步发生什么、数据从哪来到哪去（1-2 句） */
  detail: string;
  /** 这步涉及的关键文件/模块（技术锚点，供下钻追溯，可选） */
  involves?: string[];
}

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
  /** 实现原理分镜（teach 模式功能节点：像科普视频一步步讲"这是怎么实现的"） */
  steps?: TeachStep[];
  /** 子节点 */
  children?: MindMapNode[];
}

/** 功能间依赖（叠加层）：树管归属（is-part-of），线管依赖（depends-on），两种正交关系不互相挤占 */
export interface FeatureDep {
  /** 依赖方功能名（它踩着别人） */
  from: string;
  /** 被依赖功能名（底座，别人踩着它） */
  to: string;
  /** 跨功能调用次数（真实调用边聚合） */
  weight: number;
  /** 依赖主要打向的目标文件（top3，带次数）：功能粒度会失真——
   * 调用方可能只用了被依赖功能里的一小块（如 ts_kernel 内核），文件证据揭示"踩的到底是哪块地板" */
  via_files?: string[];
}

/** 共享能力文件：被多个功能真实调用的"隐形地板"（如 storage、dictionary、watch 工具）——
 * 聚类会把它们吸进某个大功能里变得不可见，这里按跨功能调用证据显式挖出来 */
export interface SharedCapability {
  /** 文件路径 */
  file: string;
  /** 它是干嘛的（人话一句话：语义层职责描述，或 LLM 按调用方+API 证据生成） */
  desc?: string;
  /** 被哪些功能调用（调用方功能 + 次数） */
  used_by: Array<{ feature: string; count: number }>;
  /** 跨功能被调总次数 */
  total: number;
}

/** L3 思维导图 */
export interface MindMap {
  /** feature 名 */
  feature: string;
  /** 生成方式：llm=LLM 提炼；rule=规则骨架（未配置 LLM 或失败降级） */
  mode: 'llm' | 'rule';
  /** 视图形态：structure=结构树（功能→社区→文件）；teach=科普教学（功能+实现原理分镜） */
  view?: 'structure' | 'teach';
  /** 根节点 */
  root: MindMapNode;
  /** 功能间依赖叠加层（teach：从 cache.db 真实调用边聚合；画布渲染为虚线弧） */
  deps?: FeatureDep[];
  /** 底座功能名列表（被 ≥2 个功能调用且几乎不调用别人的基建，树内排首位 + 🧱 徽章） */
  foundations?: string[];
  /** 共享能力文件（跨功能被调 ≥3 次的"隐形地板"，树内 🧰 分支，排在功能之前） */
  shared?: SharedCapability[];
  /** 生成时间 */
  generated_at: string;
  /** 说明（生成方式/降级原因） */
  note?: string;
}