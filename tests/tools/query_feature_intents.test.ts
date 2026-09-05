import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveDSL } from '../../src/storage.js';
import { queryFeature } from '../../src/tools/query_feature.js';

describe('get_dsl 定向读端：goals / edge_intents（overlay 读侧）', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'qfi_'));
    process.env.DESIGN_CANVAS_HOME = home;
    // feature 'f'：带 edge.intent + meta.goals（overlay 落 base 后的形态）
    saveDSL({
      feature: 'f',
      geometry: {
        nodes: [
          { id: 'a', label: 'A', x: 0, y: 0, width: 100, height: 40 },
          { id: 'b', label: 'B', x: 0, y: 0, width: 100, height: 40 },
        ],
        edges: [{ id: 'e1', from: 'a', to: 'b', intent: { reason: 'A 依赖 B 的缓存', boundary: '链路边界' } }],
      },
      meta: { goals: [{ id: 'g1', title: '统一读端', status: 'active' }] },
    } as never);
  });
  afterEach(() => {
    delete process.env.DESIGN_CANVAS_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('query=goals 返回 meta.goals 结构化目标', () => {
    const r = queryFeature({ query: 'goals', feature: 'f' });
    const data = r.data as Array<{ title?: string; status?: string }>;
    expect(data).toHaveLength(1);
    expect(data[0]?.title).toBe('统一读端');
    expect(r.message).toContain('结构化目标 1 条');
  });

  it('query=edge_intents 返回带 reason/boundary 的边级意图', () => {
    const r = queryFeature({ query: 'edge_intents', feature: 'f' });
    const data = r.data as Array<{ id?: string; reason?: string; boundary?: string }>;
    expect(data).toHaveLength(1);
    expect(data[0]?.id).toBe('e1');
    expect(data[0]?.reason).toBe('A 依赖 B 的缓存');
    expect(data[0]?.boundary).toBe('链路边界');
    expect(r.message).toContain('边级意图 1 条');
  });

  it('无目标/无边意图时返回空数组', () => {
    saveDSL({ feature: 'f2', geometry: { nodes: [{ id: 'a', label: 'A', x: 0, y: 0, width: 100, height: 40 }], edges: [] } } as never);
    expect((queryFeature({ query: 'goals', feature: 'f2' }).data as unknown[])).toEqual([]);
    expect((queryFeature({ query: 'edge_intents', feature: 'f2' }).data as unknown[])).toEqual([]);
  });

  it('query=node 决策向上并集：上层节点带出全部后代决策（own + descendants），不复制', () => {
    // 稳定叶子 c1/c2 各挂一条决策；上层 p 自己不挂 → union = 2（后代），own = 0
    saveDSL({
      feature: 'g',
      geometry: {
        nodes: [
          { id: 'p', label: '功能', x: 0, y: 0, width: 100, height: 40 },
          { id: 'c1', label: '步骤1', x: 0, y: 60, width: 100, height: 40, host: 'p', decision: { summary: '步骤1 决策' } },
          { id: 'c2', label: '文件X', x: 0, y: 120, width: 100, height: 40, host: 'c1', decision: { summary: '文件X 决策' } },
        ],
        edges: [],
      },
    } as never);
    const r = queryFeature({ query: 'node', feature: 'g', node_id: 'p' });
    const data = r.data as { decisions_own?: unknown[]; decisions_descendants?: unknown[]; decisions_union?: unknown[] };
    expect(data.decisions_own).toEqual([]);
    expect(data.decisions_descendants).toHaveLength(2);
    expect(data.decisions_union).toHaveLength(2);
    expect(r.message).toContain('向上并集: 本节点 0 · 含下层 2');
  });
});