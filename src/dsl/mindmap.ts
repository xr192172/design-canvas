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

import type { NarrScene } from './narration.js';

/** 思维导图节点类型 */
export type MindMapKind =
  | 'root'
  | 'feature'
  | 'community'
  | 'file'
  | 'note'
  | 'stepgroup'
  | 'step'
  | 'shared'
  | 'proposal'
  /** 积木黑盒卡（拼装区折叠资产）：契约投影自出生证明，内部不进导图 */
  | 'brick'
  /** 能力支柱（"这个项目能干嘛"的业务能力，LLM 把细功能归并成支柱后出现在根下） */
  | 'capability';

/** 科普分镜步骤（teach 模式 feature 节点专用，像科普视频的镜头脚本） */
export interface TeachStep {
  /** 步骤标题（≤12 字，动宾结构，如「接收用户输入」「写入结果缓存」） */
  title: string;
  /** 一步人话讲解：这步发生什么、数据从哪来到哪去（1-2 句） */
  detail: string;
  /** 这步涉及的关键文件/模块（技术锚点，供下钻追溯，可选） */
  involves?: string[];
  /**
   * 产线针脚·数据形态投影（契约投影自 actual_apis 签名，非 LLM 编造）。
   * in/out 的数量与方向即代码事实——控制类（ctx/error）不投影，集合类提质为单针脚。
   * 供工厂产线视图在工序盒左右边缘渲染入/出针脚；无投影时前端回落到按步骤顺序推导。
   */
  inputs?: TeachPin[];
  outputs?: TeachPin[];
}

/** 产线针脚：一个数据形态（n=人话名，t=来源类型简写） */
export interface TeachPin {
  n: string;
  t: string;
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
    /** 该步涉及的关键文件（step 节点挂载，供面板展示技术锚点） */
    involves?: string[];
    /** 产线针脚·数据形态（step 节点挂载，契约投影自 actual_apis 签名，非 LLM 编造） */
    inputs?: TeachPin[];
    outputs?: TeachPin[];
    /** 叙事分镜（step 节点挂载：进料口→工序→出料口，facts 逐条来自契约投影，前端点开工序盒折叠面板展示） */
    narration?: NarrScene[];
    /** 暴露接口签名清单（brick 节点挂载：契约投影自盒内 manifest） */
    apis?: string[];
    /** 分镜权威标记（feature 节点挂载）：done=已有≥3步有效 LLM 分镜；pending=占位（AI 分镜暂不可用/材料不足）。最终产物=分镜，pending 绝不冒充成品 */
    storyboard?: 'done' | 'pending';
    /** 分镜是否占位（stepgroup 节点挂载）：即 feature.storyboard==='pending' 的冗余投影，前端渲染待生成态 */
    pending?: boolean;
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

/** 用户构想的新功能：主人在根节点写"我要加个 XXX"，LLM 定位归属并补全介绍/分镜/预判依赖 */
export interface ProposalFeature {
  /** 锚点 = 对应 user_node id（跨再生成稳定） */
  id: string;
  /** 原始构想文本（主人原话） */
  raw: string;
  /** LLM 起的功能名（无 LLM 时截取原文） */
  title: string;
  /** 人话介绍：这是什么、解决什么问题 */
  desc: string;
  /** 挂靠的现有功能名（空 = 根下独立分支） */
  parent?: string;
  /** 预判实现分镜（可选） */
  steps?: TeachStep[];
  /** 预判依赖的现有功能名（画虚线弧） */
  depends_on?: string[];
  /** 定位方式：llm=LLM 定位；rule=未配置 LLM 直挂根 */
  mode: 'llm' | 'rule';
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
  /** 文件间流转链（设计视图 geometry.edges 的投影，file→file）：
   *  思维导图按此给盒内卡片排出 1→2→3 业务顺序并画连线（顺序来自设计事实，不按字母序） */
  flows?: Array<{ from: string; to: string; label?: string }>;
  /** 底座功能名列表（被 ≥2 个功能调用且几乎不调用别人的基建，树内排首位 + 🧱 徽章） */
  foundations?: string[];
  /** 共享能力文件（跨功能被调 ≥3 次的"隐形地板"，树内 🧰 分支，排在功能之前） */
  shared?: SharedCapability[];

  /** 社区名中文缓存：英文原名 → LLM 译中文名（重建复用，避免重复调用） */
  community_zh?: Record<string, string>;

  /** 节点专属描述缓存（teach 视图社区/文件层）：
   * key 为稳定锚点（"c:<社区原名>" / "f:<文件路径>"）→ LLM 生成的人话描述。
   * 重建时命中直接复用，不再重复调用；避免"X 个文件约 Y 行"这类通用模板解释 */
  desc_cache?: Record<string, string>;

  /** 用户的新功能构想（根级 user_nodes 经 LLM 定位融入）：🔮 虚线分支，与已实现功能区分 */
  proposals?: ProposalFeature[];

  /** 产线视图确认表（key = 功能 label → 是否已由主人确认为"管线型产线视图"）：
   * 仅写入保留 JSON（teach 文件），重建不重算、不覆盖。默认缺省 = 不产线（保持社区视图） */
  pipeline_like?: Record<string, boolean>;

  /** LLM 分镜生成时顺带输出的产线提议（key = 功能 label → 一句话依据，如"数据沿调用链单向流动"）：
   * 仅展示给主人确认用，确认前不影响渲染。机器不代主人拍板 */
  pipeline_like_proposals?: Record<string, string>;

  /** 生成时间 */
  generated_at: string;
  /** 说明（生成方式/降级原因） */
  note?: string;
}