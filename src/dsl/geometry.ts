/**
 * 几何层类型：节点/边/泳道/布局
 * 与 schema/design_dsl.schema.json 严格对齐
 */

import type { DesignDSL } from './types.js';
import type { NodeShapes } from './animation.js';

/** 图纸/节点状态 */
export type DiagramStatus = 'draft' | 'in_progress' | 'done';

/**
 * 职责分层：节点/边按职责分三层，渲染时渐进披露（默认只显示 main 层）
 * - main：主干数据流转（默认显示）
 * - error：异常处理（深层，默认折叠，宿主节点 ⚠ 角标展开）
 * - detail：实现细节（深层，默认折叠，宿主节点 ▸ 角标展开）
 */
export type NodeLayer = 'main' | 'error' | 'detail';

/** 节点 CSS 样式（几何层） */
export interface NodeStyle {
  /** 形状：rect=矩形, rounded=圆角矩形, circle=圆形, diamond=菱形, freeform=自由形, parallelogram=平行四边形, hexagon=六边形, triangle=三角形 */
  shape?: 'rect' | 'rounded' | 'circle' | 'diamond' | 'freeform' | 'parallelogram' | 'hexagon' | 'triangle';
  /** 背景色 */
  bg?: string;
  /** 前景色（文字） */
  color?: string;
  /** 语义色调：error/success/warning，渲染器映射到主题变量（显式 bg 优先） */
  tone?: 'error' | 'success' | 'warning';
  /** 边框，如 "1px solid #4f8df7" */
  border?: string;
  /** 圆角半径（px） */
  borderRadius?: number;
  /** 阴影，如 "0 8px 32px rgba(0,0,0,0.3)" */
  shadow?: string;
  /** 透明度 0-1 */
  opacity?: number;
  /** 允许扩展任意 CSS 字段 */
  [key: string]: string | number | undefined;
}

/** 内容块样式 */
export interface BlockStyle {
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  align?: 'left' | 'center' | 'right';
  [key: string]: string | number | boolean | undefined;
}

/** 富文本内容块 */
export interface ContentBlock {
  /** 块类型：text=文字, image=图片, color_block=色块容器, spacer=间隔, code=代码块, list=列表, divider=分割线, badge=徽章 */
  type: 'text' | 'image' | 'color_block' | 'spacer' | 'code' | 'list' | 'divider' | 'badge';
  /** 文字内容（type=text 时） */
  value?: string;
  /** 图片 URL（type=image 时） */
  src?: string;
  /** 图片宽度（type=image 时） */
  width?: number;
  /** 图片高度（type=image 时） */
  height?: number;
  /** 背景色（type=color_block 时） */
  bg?: string;
  /** 边框（type=color_block 时） */
  border?: string;
  /** 圆角（type=color_block 时） */
  borderRadius?: number;
  /** 内边距（type=color_block 时） */
  padding?: number;
  /** 间隔高度（type=spacer 时） */
  spacerHeight?: number;
  /** 子块（type=color_block 时） */
  children?: ContentBlock[];
  /** 块样式 */
  style?: BlockStyle;
  /** 是否可见（动画控制） */
  visible?: boolean;
  /** 列表项（type=list 时） */
  items?: string[];
  /** 列表类型（type=list 时） */
  listType?: 'ul' | 'ol';
  /** 代码语言（type=code 时） */
  language?: string;
  /** 徽章颜色（type=badge 时） */
  badgeColor?: string;
}

/** 节点内容 */
export interface NodeContent {
  /** 内容类型：text=纯文字, rich=富文本块, layout=布局容器 */
  type: 'text' | 'rich' | 'layout';
  /** 富文本块列表（type=rich 或 layout 时） */
  blocks?: ContentBlock[];
}

/** 几何层节点 */
export interface Node {
  id: string;
  label?: string;
  /** 左上角 x 坐标（px），缺省由 layout 自动排版 */
  x?: number;
  /** 左上角 y 坐标（px） */
  y?: number;
  width?: number;
  height?: number;
  style?: NodeStyle;
  /** 节点内容：纯文字或富文本块（含图片、色块） */
  content?: NodeContent;
  /**
   * 子图 DSL：点击节点在新标签页打开子画布
   * 用于"功能聚合"——主图保持简洁，细节在子图里展开
   */
  sub_dsl?: DesignDSL;
  /** 节点实现状态：draft=待实现, in_progress=实现中, done=已完成 */
  status?: DiagramStatus;
  /** 所属泳道 ID（对应 geometry.swimlanes[].id） */
  swimlane?: string;
  /** 节点类型描述（如 service/module/database/api/queue/ui） */
  type?: string;
  /** 节点描述/备注 */
  description?: string;
  /** 人话主标题：LLM 生成的职责摘要（如"配置加载与校验"），渲染端优先展示，label 兜底 */
  title?: string;
  /** title 英文版（i18n：切换英文时用，缺失回退 title） */
  title_en?: string;
  /** 职责分层：main=主干（默认显示）；error/detail=深层（默认折叠，角标展开）。缺省 main */
  layer?: NodeLayer;
  /** 深层节点的宿主主干节点 ID（角标挂载点）；缺省时仅跟随全局层开关 */
  host?: string;
  /** 架构分层（L2 序号5/7）：启发式推断文件所属架构层（api/service/data/ui/...），供图层着色切换 */
  arch_layer?: string;
  /** 数据形状卡（D1）：进/出该节点的数据形状（人话版 JSON Schema 渲染，纯展示） */
  shapes?: NodeShapes;
  /**
   * 决策卡·参数表（2026-08-18）：类型化 key-value，承载设计参数（如 budget_mb: 64）。
   * 与 description 纯文本的区别：参数是字段，机器可对拍（未来 camera 参数级对拍的地基）。
   */
  attributes?: Record<string, string | number | boolean>;
  /**
   * 决策卡·决策记录（2026-08-18）：结论/理由/替代方案/后果/验收标准。
   * LLM 运化时填写，人抽查；DSL 只运化可机器执行部分，rationale 永留卡上。
   */
  decision?: NodeDecision;
  /**
   * 决策卡·版本栈（2026-08-18 语义化）：每次 update decision 自动把旧版压栈。
   * 栈底最老、栈顶最近被取代的版本；当前生效版永远是 node.decision 本身。
   */
  decision_history?: DecisionHistoryEntry[];
}

/** 节点决策记录（决策卡的核心结构） */
export interface NodeDecision {
  /** 结论：这个设计是什么（一句话） */
  summary: string;
  /** 理由：为什么这么定（含定量依据） */
  rationale?: string;
  /** 被否掉的替代方案及否决原因 */
  alternatives?: { option: string; rejected_because: string }[];
  /** 后果/风险：这么定的代价 */
  consequences?: string;
  /** 验收标准：怎么算做好了（可观测） */
  acceptance?: string;
  /** 生效状态：active=当前生效（默认）；superseded=已被新版取代（历史版不删，进 decision_history）；draft=讨论中未定稿 */
  status?: 'active' | 'superseded' | 'draft';
  /** 功能线：同类决策的聚合标签（如"内存治理"/"链路追踪"），query decisions 按此分组，相似功能线合并视图 */
  thread?: string;
  /** 自由标签：跨功能线检索（如 "blackbox" "performance"） */
  tags?: string[];
}

/** 决策版本栈条目：旧决策 + 压栈时间 + 修订说明 */
export interface DecisionHistoryEntry {
  /** 压栈时间（ISO 8601） */
  at: string;
  /** 被取代的旧决策全文 */
  decision: NodeDecision;
  /** 本次修订说明（翻案理由/变更点，可空） */
  note?: string;
}

/** 边 SVG 样式 */
export interface EdgeStyle {
  stroke?: string;
  strokeWidth?: number;
  [key: string]: string | number | undefined;
}

/** 几何层边 */
export interface Edge {
  id: string;
  /** 源节点 ID */
  from: string;
  /** 目标节点 ID */
  to: string;
  label?: string;
  style?: EdgeStyle;
  /** 边类型：直线(默认)/贝塞尔曲线/虚线 */
  type?: 'straight' | 'curve' | 'dashed';
  /** 箭头方向：正向(默认)/反向/双向/无 */
  arrow?: 'forward' | 'reverse' | 'both' | 'none';
  /** 职责分层：缺省时自动推导——任一端点为深层节点则跟随较深层（detail > error > main） */
  layer?: NodeLayer;
}

/** 泳道（横向分组） */
export interface Swimlane {
  id: string;
  /** 显示名称 */
  label?: string;
  /** 背景色（可选） */
  bg?: string;
  /** 文字颜色（可选） */
  color?: string;
  /** 垂直位置（top y），高度根据节点自动计算 */
  y?: number;
  /** 固定高度（可选，不设置则自动计算） */
  height?: number;
}

/** 几何层 */
export interface Geometry {
  /**
   * 自动排版策略：
   * - dag：拓扑排序布局（适合有向无环图）
   * - force：力导向布局（适合复杂网络图）
   * - grid：网格布局（按 columns 排列）
   * - vertical_flow：纵向流
   * - horizontal_flow：横向流
   * - free：完全用 x/y
   */
  layout?: 'dag' | 'force' | 'grid' | 'vertical_flow' | 'horizontal_flow' | 'free';
  /** 画布宽度（px） */
  width?: number;
  /** 画布高度（px） */
  height?: number;
  /** grid 布局列数 */
  columns?: number;
  /** 网格对齐大小（px），默认 20 */
  grid_size?: number;
  /** 力导向布局参数 */
  force_params?: ForceParams;
  nodes: Node[];
  edges?: Edge[];
  /** 泳道分组（可选） */
  swimlanes?: Swimlane[];
}

/** 力导向布局参数 */
export interface ForceParams {
  /** 排斥力系数（默认 1000） */
  repulsion?: number;
  /** 弹簧刚度（默认 0.1） */
  stiffness?: number;
  /** 阻尼系数（默认 0.85） */
  damping?: number;
  /** 迭代次数（默认 500） */
  iterations?: number;
  /** 节点半径（默认 50） */
  node_radius?: number;
}
