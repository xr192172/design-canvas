/**
 * design-canvas DSL 类型定义（根模块）
 * 与 schema/design_dsl.schema.json 严格对齐
 *
 * 领域拆分：几何层 ./geometry / 语义层 ./semantic / 标注 ./annotation
 *          动画 ./animation / 仿真 ./simulation
 * 本文件保留根类型（DesignDSL/ThemeConfig/ThemeId）并统一再导出全部领域类型，
 * 外部消费者继续从 dsl/types.js 单一入口获取类型。
 */

import type { DiagramStatus, Geometry } from './geometry.js';
import type { Semantic } from './semantic.js';
import type { Annotation } from './annotation.js';
import type { Animation, AnimationSystem } from './animation.js';
import type { Simulation } from './simulation.js';

export type {
  DiagramStatus,
  NodeLayer,
  NodeStyle,
  BlockStyle,
  ContentBlock,
  NodeContent,
  Node,
  EdgeStyle,
  Edge,
  Swimlane,
  Geometry,
  ForceParams,
} from './geometry.js';

export type {
  ExpectedApi,
  SemanticFile,
  CodeTemplate,
  ScaffoldConfig,
  Semantic,
} from './semantic.js';

export type {
  ApprovalStatus,
  ApprovalHistoryEntry,
  Annotation,
} from './annotation.js';

export type {
  ElementState,
  AnimationStage,
  Animation,
  AnimationTrigger,
  AnimationValueSchema,
  NodeShapes,
  AnimationValue,
  AnimationHandlerMapping,
  AnimationError,
  AnimationHandler,
  AnimationBranch,
  AnimationFlow,
  AnimationRuntime,
  AnimationSystem,
} from './animation.js';

export type {
  SimulationRule,
  SimulationDepEdge,
  SimulationAction,
  SimulationStateDef,
  SimulationNodeMapping,
  Simulation,
  SimulationTrace,
} from './simulation.js';

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
