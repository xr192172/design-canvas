/**
 * 视图分层护栏测试（收敛 Step 2.5）
 *
 * 覆盖：
 * - getDSLByView：design → 设计层，live → 实际代码快照（只读）
 * - query_feature query=dsl view=live：读取 live 快照
 * - render_dsl view=live：渲染实际视图且不写回设计层（persist=false）
 * - edit_dsl view=live：写护栏拒绝且不落盘
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createFeature } from '../../src/tools/feature_ops';
import { clearAllFeatures, getDSL, saveLiveFeature, getDSLByView, getLiveFeature } from '../../src/storage';
import { queryFeature } from '../../src/tools/query_feature';
import { TOOL_DEFS } from '../../src/server_registry';

/** 从 TOOL_DEFS 取指定主工具的 handler */
function handlerOf(name: string) {
  const def = TOOL_DEFS.find((d) => d.name === name);
  if (!def) throw new Error(`工具 ${name} 不存在`);
  return def.handler;
}

describe('视图分层 - getDSLByView', () => {
  beforeEach(() => clearAllFeatures());
  afterEach(() => clearAllFeatures());

  it('design 返回设计层；live 返回实际代码快照；live 无快照返回 null', () => {
    createFeature({ feature: 'vf_guard', title: '设计版' });

    // live 尚不存在
    expect(getDSLByView('vf_guard', 'live')).toBeNull();

    // 构造 live 快照（代码现状）
    const design = getDSL('vf_guard')!;
    saveLiveFeature({ ...design, title: '代码现状版' });

    expect(getDSLByView('vf_guard', 'design')!.title).toBe('设计版');
    expect(getDSLByView('vf_guard', 'live')!.title).toBe('代码现状版');
    expect(getLiveFeature('vf_guard')!.title).toBe('代码现状版');
  });

  it('view 缺省为 design', () => {
    createFeature({ feature: 'vf_guard2', title: 'T' });
    expect(getDSLByView('vf_guard2')!.title).toBe('T');
  });
});

describe('视图分层 - get_dsl view=live', () => {
  beforeEach(() => clearAllFeatures());
  afterEach(() => clearAllFeatures());

  it('query=dsl view=live 读到 live 快照', () => {
    createFeature({ feature: 'vf_gql', title: '设计版' });
    const design = getDSL('vf_gql')!;
    saveLiveFeature({ ...design, title: '代码现状版' });

    const r = queryFeature({ query: 'dsl', feature: 'vf_gql', view: 'live' });
    expect((r.data as { title: string }).title).toBe('代码现状版');

    // design 视图仍读设计层
    const d = queryFeature({ query: 'dsl', feature: 'vf_gql', view: 'design' });
    expect((d.data as { title: string }).title).toBe('设计版');
  });
});

describe('视图分层 - edit_dsl view=live 写护栏', () => {
  beforeEach(() => clearAllFeatures());
  afterEach(() => clearAllFeatures());

  it('view=live 拒绝写入，且不落盘', async () => {
    createFeature({ feature: 'vf_we', title: '设计版' });
    const before = JSON.stringify(getDSL('vf_we'));

    const r = await handlerOf('edit_dsl')({
      feature: 'vf_we',
      view: 'live',
      operations: [{ op: 'add', type: 'node', id: 'n1', data: { label: 'X' } }],
    });

    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/view=live|只读|实际视图/);
    // 未落盘：设计层内容不变
    expect(JSON.stringify(getDSL('vf_we'))).toBe(before);
  });

  it('view 缺省为 design 正常写入', async () => {
    createFeature({ feature: 'vf_we2' });
    const r = await handlerOf('edit_dsl')({
      feature: 'vf_we2',
      operations: [{ op: 'add', type: 'node', id: 'n1', data: { label: 'X' } }],
    });
    expect(r.isError).toBeFalsy();
    expect(getDSL('vf_we2')!.geometry.nodes).toHaveLength(1);
  });
});

describe('视图分层 - render_dsl view=live', () => {
  beforeEach(() => clearAllFeatures());
  afterEach(() => clearAllFeatures());

  it('view=live 渲染实际视图且不写回设计层', async () => {
    createFeature({ feature: 'vf_rd', title: '设计版' });
    const design = getDSL('vf_rd')!;
    saveLiveFeature({ ...design, title: '代码现状版' });
    const before = JSON.stringify(getDSL('vf_rd'));

    const r = await handlerOf('render_dsl')({ feature: 'vf_rd', view: 'live', format: 'html' });

    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/已渲染/);
    expect(r.text).toMatch(/未写回设计层/);
    // 设计层未被 live 覆盖
    expect(JSON.stringify(getDSL('vf_rd'))).toBe(before);
  });
});