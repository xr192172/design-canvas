import { describe, it, expect } from 'vitest';
import { SimulationEngine, applyNodeUpdates } from '../../src/renderer/simulation_engine';
import type { Simulation, Node } from '../../src/dsl/types';

function makeSim(def: Partial<Simulation>): Simulation {
  return {
    id: 'test_sim',
    initial_state: def.initial_state || [{ key: 'count', value: 0, type: 'number' }],
    rules: def.rules || [],
    mappings: def.mappings || [],
    ...def,
  };
}

describe('SimulationEngine', () => {
  describe('状态初始化', () => {
    it('初始状态从 initial_state 加载', () => {
      const sim = makeSim({
        initial_state: [
          { key: 'a', value: 5, type: 'number' },
          { key: 'b', value: 'hello', type: 'string' },
          { key: 'c', value: true, type: 'boolean' },
        ],
      });
      const engine = new SimulationEngine(sim);
      const state = engine.getState();
      expect(state.a).toBe(5);
      expect(state.b).toBe('hello');
      expect(state.c).toBe(true);
    });

    it('reset() 恢复初始状态', () => {
      const sim = makeSim({
        initial_state: [{ key: 'count', value: 0, type: 'number' }],
        rules: [{
          id: 'inc',
          event: 'inc',
          actions: [{ type: 'increment', target: 'count' }],
        }],
      });
      const engine = new SimulationEngine(sim);
      engine.processEvent('inc');
      engine.processEvent('inc');
      expect(engine.getState().count).toBe(2);
      engine.reset();
      expect(engine.getState().count).toBe(0);
    });
  });

  describe('事件级联', () => {
    it('单事件触发单规则', () => {
      const sim = makeSim({
        initial_state: [{ key: 'count', value: 0, type: 'number' }],
        rules: [{
          id: 'inc',
          event: 'inc',
          actions: [{ type: 'increment', target: 'count' }],
        }],
      });
      const engine = new SimulationEngine(sim);
      engine.processEvent('inc');
      expect(engine.getState().count).toBe(1);
    });

    it('事件级联：emits 触发下游事件', () => {
      const sim = makeSim({
        initial_state: [{ key: 'level', value: 0, type: 'number' }],
        rules: [
          {
            id: 'start',
            event: 'start',
            actions: [{ type: 'increment', target: 'level' }],
            emits: ['next'],
          },
          {
            id: 'next',
            event: 'next',
            actions: [{ type: 'increment', target: 'level' }],
            emits: ['final'],
          },
          {
            id: 'final',
            event: 'final',
            actions: [{ type: 'increment', target: 'level' }],
          },
        ],
      });
      const engine = new SimulationEngine(sim);
      engine.processEvent('start');
      expect(engine.getState().level).toBe(3);
    });

    it('多规则匹配同一事件', () => {
      const sim = makeSim({
        initial_state: [{ key: 'sum', value: 0, type: 'number' }],
        rules: [
          {
            id: 'add1',
            event: 'add',
            actions: [{ type: 'increment', target: 'sum', amount: 10 }],
          },
          {
            id: 'add2',
            event: 'add',
            actions: [{ type: 'increment', target: 'sum', amount: 20 }],
          },
        ],
      });
      const engine = new SimulationEngine(sim);
      engine.processEvent('add');
      expect(engine.getState().sum).toBe(30);
    });
  });

  describe('条件判断', () => {
    it('无条件规则始终执行', () => {
      const sim = makeSim({
        initial_state: [{ key: 'count', value: 0, type: 'number' }],
        rules: [{
          id: 'always',
          event: 'test',
          actions: [{ type: 'increment', target: 'count' }],
        }],
      });
      const engine = new SimulationEngine(sim);
      engine.processEvent('test');
      expect(engine.getState().count).toBe(1);
    });

    it('条件满足时执行', () => {
      const sim = makeSim({
        initial_state: [{ key: 'count', value: 5, type: 'number' }],
        rules: [{
          id: 'cond',
          event: 'check',
          condition: 'count >= 5',
          actions: [{ type: 'set_state', target: 'flag', value: true }],
        }],
      });
      const engine = new SimulationEngine(sim);
      engine.processEvent('check');
      expect(engine.getState().flag).toBe(true);
    });

    it('条件不满足时跳过', () => {
      const sim = makeSim({
        initial_state: [{ key: 'count', value: 3, type: 'number' }],
        rules: [{
          id: 'cond',
          event: 'check',
          condition: 'count >= 5',
          actions: [{ type: 'set_state', target: 'flag', value: true }],
        }],
      });
      const engine = new SimulationEngine(sim);
      engine.processEvent('check');
      expect(engine.getState().flag).toBeUndefined();
    });

    it('复杂条件表达式', () => {
      const sim = makeSim({
        initial_state: [
          { key: 'a', value: 10, type: 'number' },
          { key: 'b', value: 5, type: 'number' },
          { key: 'c', value: true, type: 'boolean' },
        ],
        rules: [{
          id: 'complex',
          event: 'test',
          condition: 'a > b && c && (a + b) > 12',
          actions: [{ type: 'set_state', target: 'result', value: 'passed' }],
        }],
      });
      const engine = new SimulationEngine(sim);
      engine.processEvent('test');
      expect(engine.getState().result).toBe('passed');
    });

    it('条件引用数组长度', () => {
      const sim = makeSim({
        initial_state: [{ key: 'items', value: [1, 2, 3], type: 'array' }],
        rules: [{
          id: 'check_len',
          event: 'test',
          condition: 'items.length > 2',
          actions: [{ type: 'set_state', target: 'valid', value: true }],
        }],
      });
      const engine = new SimulationEngine(sim);
      engine.processEvent('test');
      expect(engine.getState().valid).toBe(true);
    });

    it('条件引用 payload', () => {
      const sim = makeSim({
        initial_state: [{ key: 'count', value: 0, type: 'number' }],
        rules: [{
          id: 'payload',
          event: 'test',
          condition: 'payload.value > 5',
          actions: [{ type: 'set_state', target: 'passed', value: true }],
        }],
      });
      const engine = new SimulationEngine(sim);
      engine.processEvent('test', { value: 10 });
      expect(engine.getState().passed).toBe(true);
      engine.reset();
      engine.processEvent('test', { value: 3 });
      expect(engine.getState().passed).toBeUndefined();
    });
  });

  describe('动作类型', () => {
    it('set_state 设置任意值', () => {
      const sim = makeSim({
        initial_state: [{ key: 'val', value: 0, type: 'number' }],
        rules: [{
          id: 'set',
          event: 'set',
          actions: [{ type: 'set_state', target: 'val', value: 'new value' }],
        }],
      });
      const engine = new SimulationEngine(sim);
      engine.processEvent('set');
      expect(engine.getState().val).toBe('new value');
    });

    it('increment/decrement', () => {
      const sim = makeSim({
        initial_state: [{ key: 'count', value: 10, type: 'number' }],
        rules: [
          { id: 'inc', event: 'inc', actions: [{ type: 'increment', target: 'count', amount: 5 }] },
          { id: 'dec', event: 'dec', actions: [{ type: 'decrement', target: 'count', amount: 3 }] },
        ],
      });
      const engine = new SimulationEngine(sim);
      engine.processEvent('inc');
      expect(engine.getState().count).toBe(15);
      engine.processEvent('dec');
      expect(engine.getState().count).toBe(12);
    });

    it('push/pop 数组操作', () => {
      const sim = makeSim({
        initial_state: [{ key: 'arr', value: [], type: 'array' }],
        rules: [
          { id: 'push', event: 'push', actions: [{ type: 'push', target: 'arr', value: { id: 1 } }] },
          { id: 'push2', event: 'push2', actions: [{ type: 'push', target: 'arr', value: { id: 2 } }] },
          { id: 'pop', event: 'pop', actions: [{ type: 'pop', target: 'arr' }] },
        ],
      });
      const engine = new SimulationEngine(sim);
      engine.processEvent('push');
      engine.processEvent('push2');
      expect(engine.getState().arr).toEqual([{ id: 1 }, { id: 2 }]);
      engine.processEvent('pop');
      expect(engine.getState().arr).toEqual([{ id: 1 }]);
    });

    it('move 在状态间转移数值', () => {
      const sim = makeSim({
        initial_state: [
          { key: 'from', value: 10, type: 'number' },
          { key: 'to', value: 0, type: 'number' },
        ],
        rules: [{
          id: 'move',
          event: 'move',
          actions: [{ type: 'move', from: 'from', to: 'to', amount: 4 }],
        }],
      });
      const engine = new SimulationEngine(sim);
      engine.processEvent('move');
      expect(engine.getState().from).toBe(6);
      expect(engine.getState().to).toBe(4);
    });

    it('highlight 返回节点更新', () => {
      const sim = makeSim({
        initial_state: [{ key: 'count', value: 0, type: 'number' }],
        rules: [{
          id: 'hl',
          event: 'hl',
          actions: [{ type: 'highlight', target: 'node1' }],
        }],
      });
      const engine = new SimulationEngine(sim);
      const updates = engine.processEvent('hl');
      const hlUpdate = updates.find(u => u.highlight);
      expect(hlUpdate).toBeDefined();
      expect(hlUpdate!.id).toBe('node1');
    });
  });

  describe('状态到节点映射', () => {
    it('labelTemplate 插值', () => {
      const sim = makeSim({
        initial_state: [{ key: 'count', value: 5, type: 'number' }],
        rules: [],
        mappings: [{
          stateKey: 'count',
          nodeId: 'node1',
          labelTemplate: 'Items: ${count}',
        }],
      });
      const engine = new SimulationEngine(sim);
      const updates = engine.mapStateToNodes();
      expect(updates.length).toBe(1);
      expect(updates[0].id).toBe('node1');
      expect(updates[0].label).toBe('Items: 5');
    });

    it('styleMap 条件样式', () => {
      const sim = makeSim({
        initial_state: [{ key: 'count', value: 10, type: 'number' }],
        rules: [],
        mappings: [{
          stateKey: 'count',
          nodeId: 'node1',
          styleMap: [
            { when: 'count > 5', style: { border: '2px solid red' } },
            { when: 'count > 15', style: { bg: '#ff0000' } },
          ],
        }],
      });
      const engine = new SimulationEngine(sim);
      const updates = engine.mapStateToNodes();
      expect(updates[0].style).toEqual({ border: '2px solid red' });
    });

    it('动作触发后自动重新映射', () => {
      const sim = makeSim({
        initial_state: [{ key: 'count', value: 0, type: 'number' }],
        rules: [{
          id: 'inc',
          event: 'inc',
          actions: [{ type: 'increment', target: 'count' }],
        }],
        mappings: [{
          stateKey: 'count',
          nodeId: 'node1',
          labelTemplate: 'Count: ${count}',
        }],
      });
      const engine = new SimulationEngine(sim);
      const updates = engine.processEvent('inc');
      const nodeUpdate = updates.find(u => u.id === 'node1');
      expect(nodeUpdate).toBeDefined();
      expect(nodeUpdate!.label).toBe('Count: 1');
    });
  });

  describe('触发日志', () => {
    it('trace 记录每步执行', () => {
      const sim = makeSim({
        initial_state: [{ key: 'count', value: 0, type: 'number' }],
        rules: [{
          id: 'inc',
          event: 'inc',
          actions: [{ type: 'increment', target: 'count' }],
          emits: ['next'],
        }, {
          id: 'next',
          event: 'next',
          actions: [{ type: 'increment', target: 'count' }],
        }],
      });
      const engine = new SimulationEngine(sim);
      engine.processEvent('inc');
      const trace = engine.getTrace();
      expect(trace.length).toBe(2);
      expect(trace[0].event).toBe('inc');
      expect(trace[1].event).toBe('next');
    });

    it('trace 记录状态快照', () => {
      const sim = makeSim({
        initial_state: [{ key: 'count', value: 0, type: 'number' }],
        rules: [{
          id: 'inc',
          event: 'inc',
          actions: [{ type: 'increment', target: 'count' }],
        }],
      });
      const engine = new SimulationEngine(sim);
      engine.processEvent('inc');
      const trace = engine.getTrace();
      expect(trace[0].stateSnapshot.count).toBe(1);
    });
  });

  describe('applyNodeUpdates', () => {
    it('应用标签更新', () => {
      const nodes: Node[] = [{ id: 'n1', label: 'old' }];
      const updates = [{ id: 'n1', label: 'new' }];
      const result = applyNodeUpdates(nodes, updates);
      expect(result[0].label).toBe('new');
    });

    it('应用样式更新', () => {
      const nodes: Node[] = [{ id: 'n1', label: 'test', style: { bg: '#fff' } }];
      const updates = [{ id: 'n1', style: { bg: '#000', color: '#fff' } }];
      const result = applyNodeUpdates(nodes, updates);
      expect(result[0].style?.bg).toBe('#000');
      expect(result[0].style?.color).toBe('#fff');
    });

    it('应用高亮', () => {
      const nodes: Node[] = [{ id: 'n1', label: 'test' }];
      const updates = [{ id: 'n1', highlight: true }];
      const result = applyNodeUpdates(nodes, updates);
      expect(result[0].style?.border).toBe('2px solid #ffc107');
    });
  });

  describe('真实 Section 对象仿真', () => {
    it('Section 数组操作', () => {
      const sim = makeSim({
        initial_state: [{ key: 'sections', value: [], type: 'array' }],
        rules: [{
          id: 'add_section',
          event: 'add_section',
          actions: [{
            type: 'push',
            target: 'sections',
            value: { id: 'sec_1', summary: 'summary 1', tokens: 1500, messages: ['msg1'] },
          }],
        }],
      });
      const engine = new SimulationEngine(sim);
      engine.processEvent('add_section');
      const state = engine.getState();
      expect(state.sections.length).toBe(1);
      expect(state.sections[0].id).toBe('sec_1');
      expect(state.sections[0].tokens).toBe(1500);
    });

    it('按 token 总数触发折叠', () => {
      const sim = makeSim({
        initial_state: [{ key: 'sections', value: [], type: 'array' }],
        rules: [
          {
            id: 'add',
            event: 'add',
            actions: [{ type: 'push', target: 'sections', value: { tokens: 2000 } }],
            emits: ['check'],
          },
          {
            id: 'check',
            event: 'check',
            condition: 'sections.reduce((s, x) => s + x.tokens, 0) > 5000',
            actions: [{ type: 'set_state', target: 'should_fold', value: true }],
          },
        ],
      });
      const engine = new SimulationEngine(sim);
      engine.processEvent('add'); // 2000
      engine.processEvent('add'); // 4000
      expect(engine.getState().should_fold).toBeUndefined();
      engine.processEvent('add'); // 6000
      expect(engine.getState().should_fold).toBe(true);
    });

    it('FIFO 淘汰旧 Section', () => {
      const sim = makeSim({
        initial_state: [{ key: 'sections', value: [], type: 'array' }],
        rules: [
          {
            id: 'add',
            event: 'add',
            actions: [{ type: 'push', target: 'sections', value: { id: 'sec_${sections.length + 1}' } }],
          },
          {
            id: 'fold',
            event: 'fold',
            condition: 'sections.length > 3',
            actions: [{ type: 'pop', target: 'sections' }],
          },
        ],
      });
      const engine = new SimulationEngine(sim);
      engine.processEvent('add');
      engine.processEvent('add');
      engine.processEvent('add');
      engine.processEvent('add');
      expect(engine.getState().sections.length).toBe(4);
      engine.processEvent('fold');
      expect(engine.getState().sections.length).toBe(3);
    });
  });
});
