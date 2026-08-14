/**
 * diff_features 视图对比测试（bug #4 回归）
 *
 * 覆盖：
 * - design vs live 对比（view_b=live），live-only feature 也能找到
 * - 默认 design 视图行为不变
 * - 视图不存在时报错信息带视图名
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { diffFeatures } from '../../src/tools/diff';
import { createFeature } from '../../src/tools/feature_ops';
import { addNode } from '../../src/tools/node_ops';
import { clearAllFeatures, getDSL, saveLiveFeature } from '../../src/storage';

describe('diff_features 视图对比', () => {
  beforeEach(() => clearAllFeatures());
  afterEach(() => clearAllFeatures());

  it('design vs live：feature_b 为 live-only（无设计存档）也能对比', () => {
    // 设计侧：feature "design_a"，有一个节点
    createFeature({ feature: 'design_a', title: '设计版' });
    addNode({ feature: 'design_a', node_id: 'n1', label: '设计节点', type: 'service' });

    // live 侧：只写实际快照，不建设计存档（live-only feature）
    const liveDsl = {
      ...getDSL('design_a')!,
      feature: 'live_only_b',
      title: '实际快照',
      geometry: {
        nodes: [{ id: 'n1', label: '实际节点', type: 'service' }],
        edges: [],
      },
    };
    saveLiveFeature(liveDsl);

    // 旧实现：getDSL('live_only_b') 在设计存储找不到 → 抛 "feature_b 不存在"
    // 新实现：view_b=live 走 getLiveFeature，能找到
    const r = diffFeatures({ feature_a: 'design_a', feature_b: 'live_only_b', view_b: 'live' });
    expect(r.message).toContain('design_a(design) vs live_only_b(live)');
    expect(r.summary.modified).toBeGreaterThan(0);
    expect(r.diffs.some((d) => d.category === 'node' && d.field === 'label')).toBe(true);
  });

  it('默认 design 视图：两边都走设计存储', () => {
    createFeature({ feature: 'fa', title: 'A' });
    createFeature({ feature: 'fb', title: 'B' });
    addNode({ feature: 'fa', node_id: 'n1', label: 'A 节点', type: 'service' });
    addNode({ feature: 'fb', node_id: 'n1', label: 'B 节点', type: 'service' });

    const r = diffFeatures({ feature_a: 'fa', feature_b: 'fb' });
    expect(r.message).toContain('fa(design) vs fb(design)');
    expect(r.summary.modified).toBe(1);
  });

  it('live 视图不存在时报错带视图名', () => {
    createFeature({ feature: 'fa', title: 'A' });
    expect(() => diffFeatures({ feature_a: 'fa', feature_b: 'no_live', view_b: 'live' })).toThrow(
      /feature_b "no_live" 不存在（视图: live）/,
    );
  });
});