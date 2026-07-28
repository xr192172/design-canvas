/**
 * 仿真器类型：事件驱动状态机
 */

import type { NodeStyle } from './geometry.js';

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
