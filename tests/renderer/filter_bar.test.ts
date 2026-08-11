/**
 * 筛选条渲染测试：人端筛选（状态/孤岛/聚焦）的 HTML 生成与运行时逻辑注入。
 *
 * 对应需求：AI 端有 query_feature 过滤，人端缺筛选能力——渲染端加 Filter Bar。
 */

import { describe, it, expect } from 'vitest';
import { renderHTML } from '../../src/renderer/html_renderer';
import { buildScript } from '../../src/renderer/scripts';
import type { DesignDSL } from '../../src/dsl/types';

function makeDSL(): DesignDSL {
  return {
    id: 't',
    type: 'feature_diagram',
    feature: 'filter_test',
    geometry: {
      layout: 'free',
      width: 800,
      height: 600,
      nodes: [
        { id: 'a', x: 0, y: 0, width: 80, height: 40, label: 'A', status: 'done' },
        { id: 'b', x: 100, y: 0, width: 80, height: 40, label: 'B', status: 'in_progress' },
        { id: 'c', x: 200, y: 0, width: 80, height: 40, label: 'C' },
        { id: 'iso', x: 300, y: 0, width: 80, height: 40, label: '孤岛' },
      ],
      edges: [{ id: 'e1', from: 'a', to: 'b', label: 'calls' }],
    },
  };
}

describe('filter bar 渲染', () => {
  it('生成三个状态 chip 且计数正确（无 status 默认 draft）', () => {
    const html = renderHTML(makeDSL());
    expect(html).toContain('data-filter-status="draft"');
    expect(html).toContain('data-filter-status="in_progress"');
    expect(html).toContain('data-filter-status="done"');
    expect(html).toContain('>⬜ 待实现</span><span class="chip-count">2</span>');
    expect(html).toContain('>🟠 实现中</span><span class="chip-count">1</span>');
    expect(html).toContain('>✅ 已完成</span><span class="chip-count">1</span>');
  });

  it('生成孤岛/聚焦按钮，聚焦初始禁用', () => {
    const html = renderHTML(makeDSL());
    expect(html).toContain('id="filter-islands"');
    expect(html).toContain('id="filter-focus"');
    expect(html).toContain('filter-focus" disabled');
  });

  it('无节点时筛选条不显示', () => {
    const dsl = makeDSL();
    dsl.geometry.nodes = [];
    dsl.geometry.edges = [];
    const html = renderHTML(dsl);
    // 用 toolbar 的 DOM 特征断言（scripts 注入的 JS 含选择器字符串，不能全量匹配）
    expect(html).not.toContain('<div class="filter-bar"');
    expect(html).not.toContain('id="filter-islands"');
  });

  it('scripts 注入筛选运行时逻辑（applyFilters/聚焦/孤岛）', () => {
    const script = buildScript(makeDSL());
    expect(script).toContain('function applyFilters()');
    expect(script).toContain('function computeFocusScope');
    expect(script).toContain('function setupFilters()');
    expect(script).toContain('filter-hidden');
    expect(script).toContain('islandIds');
  });

  it('scripts 注入 filter-hidden 样式规则（!important 压制 inline display）', () => {
    const dsl = makeDSL();
    const html = renderHTML(dsl);
    expect(html).toContain('.filter-hidden');
    expect(html).toContain('display: none !important');
  });
});
