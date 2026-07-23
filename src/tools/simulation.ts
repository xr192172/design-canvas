/**
 * 仿真器 MCP 工具
 *
 * 让 LLM 能够通过 MCP 调用仿真器，验证设计改动：
 * - run_simulation: 批量传入事件，返回最终状态 + 触发日志
 * - get_simulation_state: 读取当前状态
 * - reset_simulation: 重置到初始状态
 */

import { getDSL } from '../storage.js';
import { SimulationEngine } from '../renderer/simulation_engine.js';
import type { Simulation, SimulationTrace } from '../dsl/types.js';

// 引擎缓存：feature → engine 实例（保持状态跨调用）
const engineCache = new Map<string, SimulationEngine>();

/** 获取或创建引擎实例 */
function getEngine(feature: string): SimulationEngine {
  let engine = engineCache.get(feature);
  if (engine) return engine;

  const dsl = getDSL(feature);
  if (!dsl) throw new Error(`feature "${feature}" 不存在`);
  if (!dsl.simulation) throw new Error(`feature "${feature}" 没有定义 simulation`);

  engine = new SimulationEngine(dsl.simulation as Simulation);
  engineCache.set(feature, engine);
  return engine;
}

export interface RunSimulationInput {
  feature: string;
  events: Array<{ event: string; payload?: Record<string, unknown> }>;
  reset_before_run?: boolean;
}

export interface RunSimulationResult {
  message: string;
  feature: string;
  finalState: Record<string, unknown>;
  trace: SimulationTrace[];
  nodeUpdates: Array<{ id: string; label?: string; style?: Record<string, unknown>; highlight?: boolean }>;
}

/** 批量运行事件，返回最终状态和触发日志 */
export function runSimulation(input: RunSimulationInput): RunSimulationResult {
  const engine = getEngine(input.feature);

  if (input.reset_before_run) {
    engine.reset();
  }

  const updates = engine.run(input.events);
  const state = engine.getState();
  const trace = engine.getTrace();

  const lines: string[] = [];
  lines.push(`仿真器：已处理 ${input.events.length} 个事件，触发 ${trace.length} 条规则`);
  lines.push('');
  lines.push('最终状态：');
  for (const [key, val] of Object.entries(state)) {
    if (Array.isArray(val)) {
      lines.push(`  ${key}: [${val.length} 项]`);
    } else if (typeof val === 'object' && val !== null) {
      lines.push(`  ${key}: {对象}`);
    } else {
      lines.push(`  ${key}: ${val}`);
    }
  }
  lines.push('');
  lines.push('触发链：');
  for (const t of trace) {
    const status = t.conditionMet ? '✓' : '✗';
    const emits = t.emittedEvents.length > 0 ? ` → 发射: ${t.emittedEvents.join(', ')}` : '';
    lines.push(`  #${t.step} [${status}] ${t.event} (${t.ruleId})${emits}`);
  }

  return {
    message: lines.join('\n'),
    feature: input.feature,
    finalState: state,
    trace,
    nodeUpdates: updates,
  };
}

export interface GetSimulationStateInput {
  feature: string;
}

export interface GetSimulationStateResult {
  message: string;
  feature: string;
  state: Record<string, unknown>;
  traceCount: number;
}

/** 读取当前仿真器状态 */
export function getSimulationState(input: GetSimulationStateInput): GetSimulationStateResult {
  const engine = getEngine(input.feature);
  const state = engine.getState();
  const trace = engine.getTrace();

  const lines: string[] = [];
  lines.push(`仿真器状态（feature: ${input.feature}）：`);
  lines.push(`已触发 ${trace.length} 条规则`);
  lines.push('');
  lines.push('当前状态：');
  for (const [key, val] of Object.entries(state)) {
    if (Array.isArray(val)) {
      const activeCount = val.filter ? val.filter((s: { status?: string }) => s.status === 'active').length : 0;
      const tokenSum = val.reduce ? val.reduce((sum: number, s: { tokens?: number }) => sum + (s.tokens || 0), 0) : 0;
      if (activeCount > 0 || tokenSum > 0) {
        lines.push(`  ${key}: [${val.length} 项] active=${activeCount} tokens=${tokenSum}`);
      } else {
        lines.push(`  ${key}: [${val.length} 项]`);
      }
    } else if (typeof val === 'object' && val !== null) {
      lines.push(`  ${key}: ${JSON.stringify(val)}`);
    } else {
      lines.push(`  ${key}: ${val}`);
    }
  }

  if (trace.length > 0) {
    lines.push('');
    lines.push('最近 5 条触发记录：');
    const recent = trace.slice(-5);
    for (const t of recent) {
      const status = t.conditionMet ? '✓' : '✗';
      lines.push(`  #${t.step} [${status}] ${t.event} (${t.ruleId})`);
    }
  }

  return {
    message: lines.join('\n'),
    feature: input.feature,
    state,
    traceCount: trace.length,
  };
}

export interface ResetSimulationInput {
  feature: string;
}

export interface ResetSimulationResult {
  message: string;
  feature: string;
  state: Record<string, unknown>;
}

/** 重置仿真器到初始状态 */
export function resetSimulation(input: ResetSimulationInput): ResetSimulationResult {
  const engine = getEngine(input.feature);
  engine.reset();
  const state = engine.getState();

  const lines: string[] = [];
  lines.push(`仿真器已重置（feature: ${input.feature}）`);
  lines.push('');
  lines.push('初始状态：');
  for (const [key, val] of Object.entries(state)) {
    if (Array.isArray(val)) {
      lines.push(`  ${key}: [${val.length} 项]`);
    } else {
      lines.push(`  ${key}: ${val}`);
    }
  }

  return {
    message: lines.join('\n'),
    feature: input.feature,
    state,
  };
}

/** 清除引擎缓存（测试用） */
export function clearEngineCache(): void {
  engineCache.clear();
}
