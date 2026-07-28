/**
 * 动画系统类型：旧版阶段快照 + V2 声明式数据流（L0-L5）
 * 详见 docs/animation-design.md
 */

import type { NodeContent, NodeStyle } from './geometry.js';

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

/** 节点数据形状卡（D1）：进料口/出料口各一份 AnimationValueSchema */
export interface NodeShapes {
  /** 进：进入该节点/步骤的数据形状 */
  in?: AnimationValueSchema;
  /** 出：离开该节点/步骤的数据形状 */
  out?: AnimationValueSchema;
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
