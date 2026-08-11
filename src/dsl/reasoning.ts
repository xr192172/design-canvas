/**
 * Agent 推理演示 DSL 类型：脚本式回放
 *
 * 描述一个 LLM Agent 的思考过程：输入入口 → 逐层推理（steps）→
 * token 累积超量时触发上下文折叠（folds），复用动画引擎的
 * card_fold / card_evict 动效与 ƒ 函数浮层。
 *
 * 与 animations_v2 / simulation 的区别：
 *  - animations_v2 + simulation：反应式数据流仿真（规则触发）
 *  - reasoning：脚本式叙事回放（预设的推理序列 + 折叠点）
 */

/** 推理步骤类型 */
export type ReasoningStepKind = 'think' | 'tool' | 'respond' | 'fold';

/** 折叠方式 */
export type ReasoningFoldKind = 'summarize' | 'evict';

/** 单个推理步骤 */
export interface ReasoningStep {
  /** 步骤 ID（唯一，供 folds.folded 引用） */
  id: string;
  /** 步骤所在节点 id（引用 geometry.nodes[].id） */
  node: string;
  /** 步骤类型 */
  kind: ReasoningStepKind;
  /** 该步占用/消耗的 token 数（用于累积超量判断与占用条展示） */
  tokens: number;
  /** 该步输入上下文描述 */
  input?: string;
  /** LLM 推理内容（回放时浮层显示） */
  reasoning: string;
  /** 该步输出 */
  output?: string;
  /** 可选：该步绑定的函数名（L4 浮层 ƒ api） */
  api?: string;

  // ── 真实调用树字段（来自 Go 编译期插桩 trace，脚本式回放时可选扩展）──
  /** 父步骤序号（0=根，来自插桩 trace 的 parent 链） */
  parent?: number;
  /** 调用深度（根=0） */
  depth?: number;
  /** 全局单调调用序号（来自 trace 的 order） */
  order?: number;
  /** 该步聚合的函数被调用的次数（>1 表示多次调用合并为一步） */
  calls?: number;
  /** 所属轮次/阶段序号（从 1 起；0=初始化阶段） */
  round?: number;
  /** 真实入参 recap（来自 trace args） */
  args?: string;
  /** 真实出参 recap（来自 trace result，void 为 undefined） */
  result?: string;
}

/** 折叠点（token 超量时触发） */
export interface ReasoningFold {
  /** 在哪一步之后触发（steps 索引，从 1 起） */
  at_step: number;
  /** 折叠目标节点 id（演示折叠动画的落点） */
  node: string;
  /** 折叠方式：summarize = 压缩成摘要；evict = FIFO 淘汰 */
  kind: ReasoningFoldKind;
  /** 折叠后生成的摘要文本 */
  summary: string;
  /** 被折叠的步骤 id 列表（渲染时折叠这些步骤对应的卡片） */
  folded: string[];
}

/** token 预算 */
export interface ReasoningBudget {
  /** 上下文窗口 token 上限 */
  max_tokens: number;
  /** 触发折叠的阈值比例（0~1，默认 0.8） */
  fold_at?: number;
}

/** 输入入口 */
export interface ReasoningEntry {
  /** 入口标签（如 "用户输入: ..."） */
  label: string;
  /** 入口节点 id */
  node: string;
}

/** Agent 推理演示（顶层字段 ReasoningSystem） */
export interface ReasoningSystem {
  /** schema 版本 */
  version: number;
  /** 输入入口 */
  entry: ReasoningEntry;
  /** token 预算 */
  budget?: ReasoningBudget;
  /** 逐层推理步骤（有序） */
  steps: ReasoningStep[];
  /** 折叠点（token 超量时触发） */
  folds?: ReasoningFold[];
}