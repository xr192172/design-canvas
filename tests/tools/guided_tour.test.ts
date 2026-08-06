/**
 * guided_tour 拓扑导览测试（路线图序号6）
 *
 * 覆盖：
 *   - 依赖先于依赖者：A→B→C 时路径为 A,B,C（Kahn 拓扑序）
 *   - 跳过 contains 边（目录归属不计入学习依赖）
 *   - include_deep：默认跳过 layer=detail/error 深层节点，开启后纳入
 *   - include_containers：默认跳过 type=module 目录容器，开启后纳入
 *   - max_steps 截断：超出步数被截断并计数
 *   - feature 不存在 → 抛错
 *   - 环：环形依赖不卡死，残留节点补到末尾
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { guidedTour } from '../../src/tools/guided_tour';
import { saveDSL } from '../../src/storage';
import type { DesignDSL } from '../../src/dsl/types';

const roots: string[] = [];

afterAll(() => {
  for (const r of roots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      // Windows 文件占用，留给 OS 清理
    }
  }
});

/** 存一个 DSL 到设计存储并返回 feature 名（feature 唯一避免与活态文件串扰） */
function saveFeature(feature: string, nodes: Partial<DesignDSL['geometry']['nodes'][number]>[], edges: DesignDSL['geometry']['edges']) {
  const dsl = {
    id: `f_${feature}`,
    type: 'feature_diagram',
    feature,
    version: '1.0.0',
    title: feature,
    status: 'done',
    geometry: {
      layout: 'free',
      width: 800,
      height: 400,
      nodes,
      edges,
    },
    semantic: { files: [] },
  } as unknown as DesignDSL;
  saveDSL(dsl, 'mcp');
}

describe('guidedTour 拓扑导览', () => {
  it('依赖先于依赖者：A→B→C 路径为 A,B,C', () => {
    const feature = 'gt_chain';
    roots.push(''); // 占位，实际存储写入 dataHome
    saveFeature(feature, [
      { id: 'a', label: 'A', type: 'file' },
      { id: 'b', label: 'B', type: 'file' },
      { id: 'c', label: 'C', type: 'file' },
    ], [
      { id: 'e1', from: 'a', to: 'b', label: 'imports' },
      { id: 'e2', from: 'b', to: 'c', label: 'imports' },
    ]);
    const r = guidedTour({ feature });
    expect(r.steps.map((s) => s.node_id)).toEqual(['a', 'b', 'c']);
    expect(r.truncated).toBe(0);
  });

  it('跳过 contains 边（目录归属不计入学习依赖）', () => {
    const feature = 'gt_contains';
    saveFeature(feature, [
      { id: 'dir', label: '📁 src', type: 'module' },
      { id: 'a', label: 'A', type: 'file' },
      { id: 'b', label: 'B', type: 'file' },
    ], [
      { id: 'c1', from: 'dir', to: 'a', label: 'contains' },
      { id: 'c2', from: 'dir', to: 'b', label: 'contains' },
      { id: 'e1', from: 'a', to: 'b', label: 'imports' },
    ]);
    // 默认跳过目录容器，contains 边不参与拓扑 → A,B 无依赖顺序约束，但 import 仍约束 A→B
    const r = guidedTour({ feature });
    const ids = r.steps.map((s) => s.node_id);
    expect(ids).not.toContain('dir');
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
  });

  it('include_deep：默认跳过深层节点，开启后纳入', () => {
    const feature = 'gt_deep';
    saveFeature(feature, [
      { id: 'a', label: 'A', type: 'file', layer: 'main' },
      { id: 'd', label: 'D', type: 'file', layer: 'detail' },
      { id: 'e', label: 'E', type: 'file', layer: 'error' },
    ], [
      { id: 'e1', from: 'a', to: 'd', label: 'imports' },
      { id: 'e2', from: 'a', to: 'e', label: 'imports' },
    ]);
    const shallow = guidedTour({ feature });
    expect(shallow.steps.map((s) => s.node_id)).toEqual(['a']);
    const deep = guidedTour({ feature, include_deep: true });
    const deepIds = deep.steps.map((s) => s.node_id);
    expect(deepIds).toContain('d');
    expect(deepIds).toContain('e');
  });

  it('include_containers：默认跳过目录容器，开启后纳入', () => {
    const feature = 'gt_container';
    saveFeature(feature, [
      { id: 'dir', label: '📁 pkg', type: 'module' },
      { id: 'a', label: 'A', type: 'file' },
    ], [
      { id: 'c1', from: 'dir', to: 'a', label: 'contains' },
    ]);
    const noContainers = guidedTour({ feature });
    expect(noContainers.steps.map((s) => s.node_id)).toEqual(['a']);
    const withContainers = guidedTour({ feature, include_containers: true });
    expect(withContainers.steps.map((s) => s.node_id)).toContain('dir');
  });

  it('max_steps 截断：超出步数被截断并计数', () => {
    const feature = 'gt_trunc';
    saveFeature(feature, [
      { id: 'a', label: 'A', type: 'file' },
      { id: 'b', label: 'B', type: 'file' },
      { id: 'c', label: 'C', type: 'file' },
    ], [
      { id: 'e1', from: 'a', to: 'b', label: 'imports' },
      { id: 'e2', from: 'b', to: 'c', label: 'imports' },
    ]);
    const r = guidedTour({ feature, max_steps: 2 });
    expect(r.steps.length).toBe(2);
    expect(r.truncated).toBe(1);
  });

  it('环：环形依赖不卡死，残留节点补到末尾', () => {
    const feature = 'gt_cycle';
    saveFeature(feature, [
      { id: 'a', label: 'A', type: 'file' },
      { id: 'b', label: 'B', type: 'file' },
      { id: 'c', label: 'C', type: 'file' },
    ], [
      { id: 'e1', from: 'a', to: 'b', label: 'imports' },
      { id: 'e2', from: 'b', to: 'a', label: 'imports' },
      { id: 'e3', from: 'c', to: 'a', label: 'imports' },
    ]);
    const r = guidedTour({ feature });
    // 环上 a/b 无入度为 0 起点，会以 c 为起点，a/b 补到末尾；不卡死且覆盖全部节点
    expect(r.steps.length).toBe(3);
    expect(new Set(r.steps.map((s) => s.node_id)).size).toBe(3);
  });

  it('feature 不存在 → 抛错', () => {
    expect(() => guidedTour({ feature: 'does_not_exist_xyz' })).toThrow();
  });
});