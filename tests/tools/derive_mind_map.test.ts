/**
 * derive_mind_map 分组兜底测试
 *
 * 覆盖场景：
 * - 无 feature_tree 但设计视图有语义分组（module 节点 + 文件 swimlane）
 *   → root → 分组(kind=feature) → 文件，且按 module.y 排序
 * - 未归入分组的文件落入「未分组」桶
 * - 无分组容器时保持平铺兜底（root → 文件）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { deriveMindMap } from '../../src/tools/derive_mind_map';
import { renderDsl } from '../../src/tools/render_dsl';
import { clearAllFeatures } from '../../src/storage';
import type { DesignDSL } from '../../src/dsl/types';

function makeDSL(feature: string, opts: { grouped: boolean }): DesignDSL {
  const modules = opts.grouped
    ? [
        { id: 'grp_pipeline', label: '装配主干', type: 'module', description: '组装流水线', x: 0, y: 4800, width: 140, height: 60 },
        { id: 'grp_meter', label: '计数与指标', type: 'module', description: '观测面', x: 0, y: 4660, width: 140, height: 60 },
      ]
    : [];
  const fileNodes = opts.grouped
    ? [
        { id: 'f_assembler', x: 0, y: 0, width: 100, height: 50, label: 'assembler.go', type: 'file', swimlane: 'grp_pipeline' },
        { id: 'f_counter', x: 0, y: 0, width: 100, height: 50, label: 'token_counter.go', type: 'file', swimlane: 'grp_meter' },
        { id: 'f_l3', x: 0, y: 0, width: 100, height: 50, label: 'l3.go', type: 'file' },
      ]
    : [
        { id: 'f_assembler', x: 0, y: 0, width: 100, height: 50, label: 'assembler.go', type: 'file' },
        { id: 'f_counter', x: 0, y: 0, width: 100, height: 50, label: 'token_counter.go', type: 'file' },
        { id: 'f_l3', x: 0, y: 0, width: 100, height: 50, label: 'l3.go', type: 'file' },
      ];

  return {
    id: `id_${feature}`,
    type: 'feature_diagram',
    feature,
    title: `${feature} 项目`,
    geometry: {
      layout: 'free',
      width: 200,
      height: 100,
      nodes: [...fileNodes, ...modules],
    },
    semantic: {
      files: [
        { id: 'f_assembler', path: 'assembler.go', responsibility: '装配上下文' },
        { id: 'f_counter', path: 'token_counter.go', responsibility: '计 token' },
        { id: 'f_l3', path: 'l3.go', responsibility: 'L3 层' },
      ],
    },
  } as DesignDSL;
}

describe('deriveMindMap 无功能树兜底', () => {
  beforeEach(() => clearAllFeatures());
  afterEach(() => clearAllFeatures());

  it('有语义分组：root → 分组 → 文件，按 module.y 排序，未归组文件入「未分组」', async () => {
    const feature = 'mm_grouped';
    renderDsl({ dsl_json: JSON.stringify(makeDSL(feature, { grouped: true })) });

    const r = await deriveMindMap({ feature });
    const root = r.mind_map.root;

    expect(root.children).toBeDefined();
    const labels = (root.children ?? []).map((c) => c.label);
    // y=4660 的 grp_meter 在前，y=4800 的 grp_pipeline 在后，最后是未分组
    expect(labels).toEqual(['计数与指标', '装配主干', '未分组']);

    const meter = root.children![0];
    const pipeline = root.children![1];
    const ungrouped = root.children![2];
    expect(meter.kind).toBe('feature');
    expect(meter.meta?.files).toBe(1);
    expect(meter.children!.map((c) => c.label)).toEqual(['token_counter.go']);
    expect(pipeline.children!.map((c) => c.label)).toEqual(['assembler.go']);
    expect(ungrouped.children!.map((c) => c.label)).toEqual(['l3.go']);
    // 文件锚点保留 L2 id（思维导图 → 设计图 → 代码可追溯）
    expect(meter.children![0].id).toBe('f_counter');
  });

  it('无分组容器：保持平铺兜底 root → 文件', async () => {
    const feature = 'mm_flat';
    renderDsl({ dsl_json: JSON.stringify(makeDSL(feature, { grouped: false })) });

    const r = await deriveMindMap({ feature });
    const root = r.mind_map.root;
    expect(root.description).toContain('按文件平铺');
    expect((root.children ?? []).every((c) => c.kind === 'file')).toBe(true);
    expect(root.children!.length).toBe(3);
  });
});
