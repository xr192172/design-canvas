/**
 * design-canvas DSL 类型定义
 * 与 schema/design_dsl.schema.json 严格对齐
 */

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
  /** 职责分层：main=主干（默认显示）；error/detail=深层（默认折叠，角标展开）。缺省 main */
  layer?: NodeLayer;
  /** 深层节点的宿主主干节点 ID（角标挂载点）；缺省时仅跟随全局层开关 */
  host?: string;
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

/** 预期 API */
export interface ExpectedApi {
  /** 函数签名，如 "User.Login() (token string, err error)" */
  signature: string;
  notes?: string;
}

/** 语义层文件 */
export interface SemanticFile {
  /** 与 geometry.nodes.id 对应 */
  id: string;
  /** 目标文件相对路径 */
  path: string;
  /** 职责描述 */
  responsibility: string;
  expected_apis?: ExpectedApi[];
  /** 预期依赖路径列表 */
  expected_deps?: string[];
  /** 预期行为描述 */
  expected_behavior?: string;
  /** 文件实现状态：draft=待实现, in_progress=实现中, done=已完成 */
  status?: DiagramStatus;
  /** 从实际代码中解析出的已实现 API（代码回填时自动填充） */
  actual_apis?: ExpectedApi[];
}

/** 代码模板配置 */
export interface CodeTemplate {
  /** 模板 ID */
  id: string;
  /** 模板名称 */
  name: string;
  /** 目标语言：go/ts/py/js/vue/react */
  lang: string;
  /** 模板内容（支持占位符：{{package}}, {{imports}}, {{apis}}, {{behavior}}, {{node_id}}, {{node_label}}） */
  template: string;
  /** 文件扩展名 */
  ext: string;
}

/** scaffold 配置 */
export interface ScaffoldConfig {
  /** 自定义模板列表 */
  templates?: CodeTemplate[];
  /** 是否生成注释标记（默认 true） */
  markers?: boolean;
  /** 是否从节点内容生成 UI 骨架（默认 false） */
  generate_ui_skeleton?: boolean;
  /** UI 骨架类型：vue/react/html */
  ui_framework?: 'vue' | 'react' | 'html';
}

/** 语义层 */
export interface Semantic {
  files: SemanticFile[];
  /** 不变式规则（自然语言 + 可选代码引用），design_check 会验证 */
  multi_file_invariants?: string[];
  expected_global_behavior?: string[];
  /** scaffold 代码生成配置 */
  scaffold?: ScaffoldConfig;
}

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

/** 动画元素状态（对 node 的增量修改） */
export interface ElementState {
  /** 对应 node.id */
  id: string;
  /** 可见性 */
  visible?: boolean;
  /** 节点状态 */
  status?: string;
  /** 位置 */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** 内容覆盖 */
  content?: NodeContent;
  /** 是否高亮 */
  highlight?: boolean;
  /** 透明度 0-1 */
  opacity?: number;
  /** 标签覆盖 */
  label?: string;
  /** 样式覆盖 */
  style?: NodeStyle;
}

/** 动画阶段（时间轴快照） */
export interface AnimationStage {
  /** 阶段名称 */
  name: string;
  /** 阶段描述 */
  description?: string;
  /** 从上一阶段过渡到此阶段的时长（毫秒，默认 500） */
  duration?: number;
  /** 此阶段各元素的目标状态（只包含变化的属性） */
  elements: ElementState[];
}

/** 动画定义（旧版阶段快照式，保留向后兼容，新 DSL 请用 AnimationFlowV2） */
export interface Animation {
  /** 动画唯一 ID */
  id: string;
  /** 动画名称 */
  name: string;
  /** 动画描述 */
  description?: string;
  /** 时间轴上的阶段快照 */
  stages: AnimationStage[];
}

// ─────────────────────────────────────────────────────────────
// 动画系统 V2（分层精度 L0-L5，声明式数据流可视化）
// 详见 docs/animation-design.md
// ─────────────────────────────────────────────────────────────

/** 动画触发器：什么时候启动一个 flow */
export interface AnimationTrigger {
  /** 触发类型：
   *  - periodic：周期性触发（interval 毫秒）
   *  - event：仿真器事件触发（引用 simulation.rules[].event）
   *  - state_change：状态变化触发（watch 状态键）
   *  - manual：仅手动触发（UI 按钮）
   */
  type: 'periodic' | 'event' | 'state_change' | 'manual';
  /** periodic 时的间隔毫秒数 */
  interval?: number;
  /** event 时引用的事件名 */
  event?: string;
  /** state_change 时监听的状态键 */
  watch?: string;
}

/** 数据值的字段结构（JSON Schema 格式） */
export interface AnimationValueSchema {
  /** JSON Schema type */
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'integer' | 'null';
  /** 字段标签（显示在粒子上） */
  label?: string;
  /** object 类型的属性定义 */
  properties?: Record<string, AnimationValueSchema>;
  /** array 类型的元素类型 */
  items?: AnimationValueSchema;
  /** 是否必填 */
  required?: string[];
  /** 枚举值 */
  enum?: (string | number)[];
  /** 描述 */
  description?: string;
}

/** 流转的数据值定义 */
export interface AnimationValue {
  /** 值类型标识（如 auth_token / user_id / request_body） */
  type: string;
  /** 显示标签 */
  label?: string;
  /** 字段结构（JSON Schema） */
  fields?: AnimationValueSchema;
}

/** 函数调用的输入/输出映射 */
export interface AnimationHandlerMapping {
  /** 键为目标参数名，值为值路径（如 $value.token / $value.claims.user_id） */
  [key: string]: string;
}

/** 异常声明（L4.5） */
export interface AnimationError {
  /** 异常类型标识（如 ErrInvalidToken / panic） */
  type: string;
  /** 触发条件（JS 表达式，访问 result） */
  condition: string;
  /** 严重程度：
   *  - expected：业务异常（如 401），走红色路径，不报警
   *  - unexpected：系统 bug（如 panic），节点闪烁 + 日志标红
   */
  severity: 'expected' | 'unexpected';
  /** 异常流向的节点 ID */
  to: string;
  /** 异常携带的值 */
  value?: AnimationValue;
  /** 视觉效果（如 particle_red / node_flash_red） */
  effect?: string;
  /** 日志消息（unexpected 时写入日志面板） */
  log?: string;
}

/** 函数处理器（L4+） */
export interface AnimationHandler {
  /** 对应 semantic.files[].id */
  file_id: string;
  /** 对应 expected_apis 中的函数名 */
  api: string;
  /** 输入映射：参数名 → 值路径 */
  input_mapping?: AnimationHandlerMapping;
  /** 输出映射：值路径 → 返回值路径 */
  output_mapping?: AnimationHandlerMapping;
  /** 异常声明（L4.5） */
  errors?: AnimationError[];
  /** mock 模式固定返回值（mock_results 为空时生效；不声明则返回 { $mock: api }） */
  mock_result?: unknown;
  /** mock 模式轮换返回值（优先于 mock_result，按序轮流返回；可混入 { error } / { panic: true } 演示 L4.5 异常路径） */
  mock_results?: unknown[];
  /** L5b 动态执行：true 时真正调用代码 */
  live?: boolean;
}

/** 条件分支（L3） */
export interface AnimationBranch {
  /** 分支条件（JS 表达式，访问 value） */
  condition: string;
  /** 分支目标节点 */
  to: string;
  /** 分支携带的值 */
  value?: AnimationValue;
  /** 视觉效果 */
  effect?: string;
}

/** 动画流：数据从一个节点到另一个节点的流转 */
export interface AnimationFlow {
  /** Flow 唯一 ID */
  id: string;
  /** 触发器 */
  trigger: AnimationTrigger;
  /** 源节点 ID */
  from: string;
  /** 目标节点 ID（L2 直连；L3 用 branches 替代） */
  to?: string;
  /** 流转的数据值 */
  value?: AnimationValue;
  /** 函数处理器（L4+） */
  handler?: AnimationHandler;
  /** 条件分支（L3，与 to 互斥） */
  branches?: AnimationBranch[];
  /** L3 mock 数据源：periodic 触发时轮流播放的示例值，作为条件求值上下文 value。
   *  event 触发时优先用事件 payload，state_change 触发时优先用 simState 全量 */
  mock_values?: Record<string, unknown>[];
  /** 视觉效果（如 particle_flow / card_create / card_fold / card_evict） */
  effect?: string;
}

/** L5 运行时配置 */
export interface AnimationRuntime {
  /** 运行模式：
   *  - mock：用 mock 数据推演（L5a，零风险）
   *  - live：真正调用代码（L5b，需沙箱）
   */
  mode: 'mock' | 'live';
  /** live 模式的代码目录 */
  code_dir?: string;
  /** live 模式的入口文件 */
  entry?: string;
  /** live 模式单次调用超时（毫秒，默认 5000） */
  timeout?: number;
}

/** 动画系统 V2（顶层字段） */
export interface AnimationSystem {
  /** Schema 版本 */
  version: number;
  /** 数据流定义 */
  flows?: AnimationFlow[];
  /** L5 运行时配置 */
  runtime?: AnimationRuntime;
}

// ─────────────────────────────────────────────────────────────
// 仿真器 DSL（事件驱动状态机）
// ─────────────────────────────────────────────────────────────

/** 仿真器规则：事件触发 → 条件判断 → 执行动作 → 发射下游事件 */
export interface SimulationRule {
  /** 规则 ID */
  id: string;
  /** 规则名称 */
  name?: string;
  /** 触发事件类型 */
  event: string;
  /** 触发条件（JS 表达式，访问 state 和 payload） */
  condition?: string;
  /** 执行动作列表 */
  actions: SimulationAction[];
  /** 完成后发射的事件列表 */
  emits?: string[];
  /** 触发源节点 ID（画布上的节点，用于可视化连线） */
  from_node?: string;
  /** 目标节点 ID 列表（动作影响的节点，用于可视化连线） */
  to_nodes?: string[];
}

/** 仿真依赖边：用于可视化事件触发关系 */
export interface SimulationDepEdge {
  id: string;
  from: string;
  to: string;
  rule_id: string;
  event: string;
  label?: string;
}

/** 仿真器动作 */
export interface SimulationAction {
  /** 动作类型 */
  type: 'set_state' | 'increment' | 'decrement' | 'push' | 'pop' | 'move' | 'highlight' | 'log' | 'call';
  /** 目标状态键或节点 ID */
  target?: string;
  /** 值（set_state/push 时使用） */
  value?: unknown;
  /** 数量（increment/decrement 时使用） */
  amount?: number;
  /** 源位置 */
  from?: string;
  /** 目标位置 */
  to?: string;
  /** 日志消息 */
  message?: string;
}

/** 仿真器初始状态定义 */
export interface SimulationStateDef {
  /** 状态键 */
  key: string;
  /** 初始值 */
  value: unknown;
  /** 值类型提示 */
  type?: 'number' | 'string' | 'boolean' | 'array' | 'object';
  /** 描述 */
  description?: string;
}

/** 仿真器节点映射：哪个 state 对应画布上的哪个 node */
export interface SimulationNodeMapping {
  /** 状态键 */
  stateKey: string;
  /** 画布节点 ID */
  nodeId: string;
  /** 如何映射到节点 label */
  labelTemplate?: string;
  /** 如何映射到节点样式 */
  styleMap?: { when: string; style: NodeStyle }[];
}

/** 仿真器定义 */
export interface Simulation {
  /** 仿真器 ID */
  id: string;
  /** 名称 */
  name?: string;
  /** 描述 */
  description?: string;
  /** 初始状态定义 */
  initial_state: SimulationStateDef[];
  /** 事件触发规则 */
  rules: SimulationRule[];
  /** 状态到画布节点的映射 */
  mappings?: SimulationNodeMapping[];
  /** 触发日志（运行时填充） */
  trace?: SimulationTrace[];
}

/** 仿真器触发日志 */
export interface SimulationTrace {
  /** 步骤序号 */
  step: number;
  /** 触发事件 */
  event: string;
  /** 匹配的规则 ID */
  ruleId: string;
  /** 条件是否满足 */
  conditionMet: boolean;
  /** 执行的动作 */
  actions: SimulationAction[];
  /** 发射的下游事件 */
  emittedEvents: string[];
  /** 触发时间 */
  timestamp: string;
  /** 执行后的状态快照 */
  stateSnapshot: Record<string, unknown>;
}

/** 主题配置 */
export interface ThemeConfig {
  /** 主题 ID */
  id: string;
  /** 主题名称 */
  name: string;
  /** 主色调 */
  primary?: string;
  /** 辅助色 */
  secondary?: string;
  /** 背景色 */
  background?: string;
  /** 卡片背景 */
  cardBg?: string;
  /** 边框色 */
  border?: string;
  /** 文字颜色 */
  text?: string;
  /** 副标题颜色 */
  textSub?: string;
  /** 强调色 */
  accent?: string;
}

/** 主题 ID */
export type ThemeId = 'blue' | 'sakura' | 'forest' | 'ocean';

/** 顶层 DSL 文档 */
export interface DesignDSL {
  /** DSL ID（可选，用于全局唯一标识） */
  id?: string;
  /** DSL 类型（如 feature_diagram） */
  type?: string;
  /** feature 名，用于 get_dsl / list_features */
  feature: string;
  /** DSL 版本（语义化版本号） */
  version?: string;
  /** 人类可读标题 */
  title?: string;
  status?: DiagramStatus;
  /** 主题 ID（默认 blue） */
  theme?: ThemeId;
  /** 几何层（必填） */
  geometry: Geometry;
  /** 语义层（无则纯示意图） */
  semantic?: Semantic;
  annotations?: Annotation[];
  /** 动画序列（旧版阶段快照式，保留向后兼容） */
  animations?: Animation[];
  /** 动画系统 V2（分层精度 L0-L5，声明式数据流可视化，详见 docs/animation-design.md） */
  animations_v2?: AnimationSystem;
  /** 仿真器定义（事件驱动状态机，替代动画时间轴） */
  simulation?: Simulation;
}
