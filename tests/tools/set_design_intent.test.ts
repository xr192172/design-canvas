import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getDSL, saveDSL } from '../../src/storage.js';
import { loadOverlay } from '../../src/storage_overlay.js';
import { setDesignIntent } from '../../src/tools/set_design_intent.js';

describe('set_design_intent —— 写设计意图到 overlay（goals / edge_intents）', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'sdi_'));
    process.env.DESIGN_CANVAS_HOME = home;
    saveDSL({
      feature: 'f',
      geometry: {
        nodes: [
          { id: 'a', label: 'A', x: 0, y: 0, width: 100, height: 40 },
          { id: 'b', label: 'B', x: 0, y: 0, width: 100, height: 40 },
        ],
        edges: [{ id: 'e1', from: 'a', to: 'b' }],
      },
    });
  });
  afterEach(() => {
    delete process.env.DESIGN_CANVAS_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('写 goals + edge_intents：overlay 落库，base 的 meta.goals / edge.intent 立即可见', () => {
    const r = setDesignIntent({
      feature: 'f',
      goals: [{ id: 'g1', title: '统一读端', status: 'active' }],
      edge_intents: [{ from: 'a', to: 'b', reason: 'A 依赖 B 的缓存', boundary: '链路边界' }],
    });
    expect(r.edges_written).toEqual([{ id: 'e1', from: 'a', to: 'b' }]);
    expect(r.unmatched).toEqual([]);
    expect(r.message).toContain('目标 1 条');
    expect(r.message).toContain('边意图 1/1');

    const ov = loadOverlay('f');
    expect(ov?.global?.goals?.[0]?.title).toBe('统一读端');
    expect(ov?.edges?.['e1']?.reason).toBe('A 依赖 B 的缓存');
    expect(ov?.edges?.['e1']?.boundary).toBe('链路边界');

    const dsl = getDSL('f');
    expect((dsl as unknown as { meta?: { goals?: unknown[] } }).meta?.goals).toEqual([
      { id: 'g1', title: '统一读端', status: 'active' },
    ]);
    expect(dsl.geometry.edges[0]?.intent?.reason).toBe('A 依赖 B 的缓存');
  });

  it('edge_intents 按 id 定位；from+to 不匹配 → 未匹配上报，消息带 [部分写入]', () => {
    const r = setDesignIntent({
      feature: 'f',
      edge_intents: [
        { from: 'a', to: 'b', reason: '命中' },
        { from: 'x', to: 'y', reason: '没这条边' },
      ],
    });
    expect(r.edges_written).toEqual([{ id: 'e1', from: 'a', to: 'b' }]);
    expect(r.unmatched).toEqual([{ from: 'x', to: 'y', reason: '没这条边' }]);
    expect(r.message).toContain('[部分写入]');
    expect(r.message).toContain('未匹配边 1 条');
  });

  it('只传 goals：不动 edges；只传 edge_intents：不动 goals', () => {
    setDesignIntent({ feature: 'f', goals: [{ id: 'g1', title: '目标A' }] });
    const dsl1 = getDSL('f');
    expect((dsl1 as unknown as { meta?: { goals?: unknown[] } }).meta?.goals).toHaveLength(1);
    expect(dsl1.geometry.edges[0]?.intent).toBeUndefined();

    setDesignIntent({ feature: 'f', edge_intents: [{ from: 'a', to: 'b', reason: '边原因' }] });
    const dsl2 = getDSL('f');
    expect(dsl2.geometry.edges[0]?.intent?.reason).toBe('边原因');
    expect((dsl2 as unknown as { meta?: { goals?: unknown[] } }).meta?.goals).toHaveLength(1); // goals 未被清
  });

  it('空数组 goals 清空目标；feature 不存在抛错', () => {
    setDesignIntent({ feature: 'f', goals: [{ id: 'g1', title: '先写一条' }] });
    setDesignIntent({ feature: 'f', goals: [] });
    const dsl = getDSL('f');
    expect((dsl as unknown as { meta?: { goals?: unknown[] } }).meta?.goals).toEqual([]);

    expect(() => setDesignIntent({ feature: 'notexist', goals: [{ id: 'g', title: 'x' }] })).toThrow(/不存在/);
  });
});