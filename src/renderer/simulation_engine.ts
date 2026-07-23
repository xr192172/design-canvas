/**
 * SimulationEngine — 事件驱动状态机仿真器
 *
 * 核心能力：
 * - 接收初始状态定义和事件触发规则
 * - 处理外部事件，按规则链式触发下游事件
 * - 记录完整的触发日志（trace）
 * - 将状态变化映射为画布节点属性更新
 *
 * 不是"动画播放器"，是"真实数据流入 → 真实规则触发 → 真实状态变化"
 */

import type {
  Simulation,
  SimulationRule,
  SimulationAction,
  SimulationTrace,
  SimulationNodeMapping,
  Node,
} from '../dsl/types.js';

export interface EngineState {
  [key: string]: unknown;
}

export interface NodeUpdate {
  id: string;
  label?: string;
  style?: { bg?: string; color?: string; border?: string; opacity?: number };
  status?: string;
  highlight?: boolean;
}

export class SimulationEngine {
  private sim: Simulation;
  private state: EngineState = {};
  private trace: SimulationTrace[] = [];
  private step = 0;
  private listeners: Array<(updates: NodeUpdate[], trace: SimulationTrace) => void> = [];

  constructor(simulation: Simulation) {
    this.sim = simulation;
    this.reset();
  }

  /** 重置到初始状态 */
  reset(): void {
    this.state = {};
    for (const def of this.sim.initial_state) {
      this.state[def.key] = this.clone(def.value);
    }
    this.trace = [];
    this.step = 0;
  }

  /** 获取当前状态 */
  getState(): EngineState {
    return this.clone(this.state);
  }

  /** 获取触发日志 */
  getTrace(): SimulationTrace[] {
    return this.trace.slice();
  }

  /** 注册状态变化监听器（画布更新用） */
  onUpdate(fn: (updates: NodeUpdate[], trace: SimulationTrace) => void): void {
    this.listeners.push(fn);
  }

  /** 处理单个事件，返回触发的所有更新 */
  processEvent(event: string, payload?: Record<string, unknown>): NodeUpdate[] {
    const updates: NodeUpdate[] = [];
    const matchedRules = this.sim.rules.filter((r) => r.event === event);

    for (const rule of matchedRules) {
      const conditionMet = this.evaluateCondition(rule.condition, payload);
      if (!conditionMet) {
        this.recordTrace(event, rule, false, [], [], payload);
        continue;
      }

      const ruleUpdates: NodeUpdate[] = [];
      for (const action of rule.actions) {
        const actionUpdates = this.executeAction(action);
        ruleUpdates.push(...actionUpdates);
      }

      updates.push(...ruleUpdates);

      // 发射下游事件
      const emitted = rule.emits ?? [];
      this.recordTrace(event, rule, true, rule.actions, emitted, payload);

      // 级联处理下游事件
      for (const emittedEvent of emitted) {
        const cascadeUpdates = this.processEvent(emittedEvent, payload);
        updates.push(...cascadeUpdates);
      }
    }

    if (updates.length > 0) {
      const lastTrace = this.trace[this.trace.length - 1];
      if (lastTrace) {
        this.listeners.forEach((fn) => fn(updates, lastTrace));
      }
    }

    return updates;
  }

  /** 批量处理事件链 */
  run(events: Array<{ event: string; payload?: Record<string, unknown> }>): NodeUpdate[] {
    const allUpdates: NodeUpdate[] = [];
    for (const ev of events) {
      const updates = this.processEvent(ev.event, ev.payload);
      allUpdates.push(...updates);
    }
    return allUpdates;
  }

  /** 将当前状态映射为画布节点更新 */
  mapStateToNodes(): NodeUpdate[] {
    const updates: NodeUpdate[] = [];
    if (!this.sim.mappings) return updates;

    for (const mapping of this.sim.mappings) {
      const val = this.state[mapping.stateKey];
      const update: NodeUpdate = { id: mapping.nodeId };

      // 标签模板映射
      if (mapping.labelTemplate) {
        update.label = this.interpolateTemplate(mapping.labelTemplate, this.state);
      }

      // 样式条件映射
      if (mapping.styleMap) {
        for (const cond of mapping.styleMap) {
          if (this.evaluateCondition(cond.when)) {
            update.style = { ...update.style, ...cond.style };
          }
        }
      }

      updates.push(update);
    }

    return updates;
  }

  // ─────────────────────────────────────────────────────────────
  // 内部方法
  // ─────────────────────────────────────────────────────────────

  private evaluateCondition(condition: string | undefined, payload?: Record<string, unknown>): boolean {
    if (!condition) return true;
    try {
      const fn = new Function('state', 'payload', `with(state) { return !!(${condition}); }`);
      return fn(this.state, payload ?? {});
    } catch {
      return false;
    }
  }

  private evaluateExpression(expr: string, payload?: Record<string, unknown>): unknown {
    try {
      const fn = new Function('state', 'payload', `with(state) { return ${expr}; }`);
      return fn(this.state, payload ?? {});
    } catch {
      return expr;
    }
  }

  private executeAction(action: SimulationAction): NodeUpdate[] {
    const updates: NodeUpdate[] = [];

    switch (action.type) {
      case 'set_state': {
        if (action.target !== undefined) {
          const val = typeof action.value === 'string' && action.value.includes('${')
            ? this.evaluateExpression(this.interpolateTemplate(action.value, this.state))
            : action.value;
          this.state[action.target] = this.clone(val);
        }
        break;
      }
      case 'increment': {
        if (action.target !== undefined) {
          const current = (this.state[action.target] as number) ?? 0;
          this.state[action.target] = current + (action.amount ?? 1);
        }
        break;
      }
      case 'decrement': {
        if (action.target !== undefined) {
          const current = (this.state[action.target] as number) ?? 0;
          this.state[action.target] = current - (action.amount ?? 1);
        }
        break;
      }
      case 'push': {
        if (action.target !== undefined) {
          const arr = (this.state[action.target] as unknown[]) ?? [];
          const val = (action.value !== null && typeof action.value === 'object') ? this.interpolateObject(action.value as Record<string, unknown>) : action.value;
          arr.push(this.clone(val));
          this.state[action.target] = arr;
        }
        break;
      }
      case 'pop': {
        if (action.target !== undefined) {
          const arr = (this.state[action.target] as unknown[]) ?? [];
          arr.pop();
          this.state[action.target] = arr;
        }
        break;
      }
      case 'move': {
        if (action.from !== undefined && action.to !== undefined && action.amount !== undefined) {
          const fromVal = (this.state[action.from] as number) ?? 0;
          const toVal = (this.state[action.to] as number) ?? 0;
          this.state[action.from] = fromVal - action.amount;
          this.state[action.to] = toVal + action.amount;
        }
        break;
      }
      case 'highlight': {
        if (action.target !== undefined) {
          updates.push({ id: action.target, highlight: true });
        }
        break;
      }
      case 'log': {
        break;
      }
      case 'call': {
        if (action.target === 'foldOldestSections') {
          const count = action.value as number ?? 4;
          const sections = this.state['sections'] as Array<{ status: string }> ?? [];
          let folded = 0;
          for (const sec of sections) {
            if (sec.status === 'active' && folded < count) {
              sec.status = 'folded';
              folded++;
            }
          }
        }
        break;
      }
    }

    const mappingUpdates = this.mapStateToNodes();
    updates.push(...mappingUpdates);

    return updates;
  }

  private interpolateObject(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (typeof val === 'string') {
        let processed = val;
        if (val.includes('${')) {
          processed = this.interpolateTemplate(val, this.state);
        }
        if (/^[\d+\-*/().\s]+$/.test(processed) || processed.includes('Math.')) {
          try {
            const fn = new Function('state', `with(state) { return ${processed}; }`);
            result[key] = fn(this.state);
          } catch {
            result[key] = processed;
          }
        } else {
          const numMatch = processed.match(/^(\d+\.?\d*)$/);
          result[key] = numMatch ? Number(numMatch[1]) : processed;
        }
      } else {
        result[key] = val;
      }
    }
    return result;
  }

  private recordTrace(
    event: string,
    rule: SimulationRule,
    conditionMet: boolean,
    actions: SimulationAction[],
    emittedEvents: string[],
    payload?: Record<string, unknown>,
  ): void {
    this.step++;
    this.trace.push({
      step: this.step,
      event,
      ruleId: rule.id,
      conditionMet,
      actions: actions.slice(),
      emittedEvents,
      timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
      stateSnapshot: this.clone(this.state),
    });
  }

  private interpolateTemplate(template: string, vars: EngineState): string {
    return template.replace(/\$\{(\w+)\}/g, (_, key) => {
      const val = vars[key];
      return val !== undefined ? String(val) : '';
    });
  }

  private clone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
  }
}

/** 将 NodeUpdate[] 应用到节点数组（用于测试和服务器端） */
export function applyNodeUpdates(nodes: Node[], updates: NodeUpdate[]): Node[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  for (const up of updates) {
    const node = nodeMap.get(up.id);
    if (!node) continue;

    if (up.label !== undefined) node.label = up.label;
    if (up.status !== undefined) node.status = up.status as 'draft' | 'in_progress' | 'done';
    if (up.highlight !== undefined) {
      if (!node.style) node.style = {};
      // highlight 通过 stroke 实现
      if (up.highlight) {
        node.style.border = '2px solid #ffc107';
      } else {
        delete node.style.border;
      }
    }
    if (up.style) {
      if (!node.style) node.style = {};
      Object.assign(node.style, up.style);
    }
  }

  return nodes;
}
