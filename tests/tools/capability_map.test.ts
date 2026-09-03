/**
 * capability_map 能力线导航 —— 纯函数测试
 *
 * 覆盖：目录工具全局唯一、direct 引用于线内有效、未知 lane 报错、无参/单线渲染。
 */
import { describe, it, expect } from 'vitest';
import {
  LANES,
  LANE_IDS,
  validateLanes,
  renderLaneText,
  capabilityMapHandler,
  getLane,
} from '../../src/tools/capability_map.js';

const regTools = [
  'get_dsl', 'edit_dsl', 'manage_feature', 'render_design', 'render_brickwork', 'scaffold',
  'backfill_scaffold', 'consistency_check', 'detect_drift', 'import_project', 'explore_code',
  'diff_views', 'archive_node', 'list_archive', 'harvest_decisions', 'sync_contracts',
  'harvest_closure', 'extract_contracts', 'reconcile_effects', 'harvest_from_url',
  'reconcile_brick', 'search_bricks', 'assemble_bricks', 'slim_brick', 'narrate_step',
  'observe_log', 'observe_judge', 'reconcile_chain', 'observe_instrument', 'edit_code',
  'rename_many', 'rename_symbols', 'rename_files', 'find_references', 'impact_analysis',
  'cross_repo_symbol_index', 'hybrid_precheck', 'behavior_baseline', 'code_health', 'run_tests',
  'remove_dead_imports', 'refactor_pipeline', 'suggest_renames', 'find_similar_names',
  'refactor_judge', 'diagnose', 'canvas_notes', 'gateway_provider', 'read_project_docs',
  'capability_map',
];

describe('capability_map 目录契约', () => {
  it('6 条能力线，id 唯一且不重复', () => {
    const ids = LANES.map((l) => l.id);
    expect(ids).toEqual([...new Set(ids)]);
    expect(ids.length).toBe(6);
    expect(LANE_IDS).toHaveLength(6);
  });

  it('目录覆盖所有注册工具（无遗漏、无超集）', () => {
    const catalogued = LANES.flatMap((l) => l.tools.map((t) => t.name));
    expect(catalogued.length).toBe(49);
    expect(catalogued).toEqual(expect.arrayContaining(regTools.filter((t) => t !== 'capability_map')));
    expect(new Set(catalogued).size).toBe(catalogued.length); // 无跨线重复
  });

  it('工具名全局唯一（validateLanes 无错误）', () => {
    expect(validateLanes()).toEqual([]);
  });

  it('direct 直接可用引用都在线内工具之间', () => {
    for (const lane of LANES) {
      const names = lane.tools.map((t) => t.name);
      for (const d of lane.direct) expect(names).toContain(d);
    }
  });

  it('平铺高频集 = 各线 direct 并集（6 个）', () => {
    const directSet = new Set(LANES.flatMap((l) => l.direct));
    expect([...directSet].sort()).toEqual(
      ['get_dsl', 'edit_dsl', 'explore_code', 'rename_symbols', 'rename_files', 'find_references'].sort(),
    );
  });
});

describe('capabilityMapHandler 渲染', () => {
  it('无参返回全部 6 线（标题 + 工具名齐全）', async () => {
    const r = await capabilityMapHandler({});
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('能力线导航');
    for (const id of LANE_IDS) expect(r.text).toContain(`◆ ${id}`);
    expect(r.text).toContain('rename_symbols');
    expect(r.text).toContain('run_tests');
    expect(r.text).toContain('cross_repo_symbol_index');
  });

  it('传 lane=refactor 只返回该线', async () => {
    const r = await capabilityMapHandler({ lane: 'refactor' });
    expect(r.text).toContain('◆ refactor');
    expect(r.text).not.toContain('◆ design');
    expect(r.text).not.toContain('◆ observe');
  });

  it('未知 lane 返回 isError 并列出可选线', async () => {
    const r = await capabilityMapHandler({ lane: 'xyz' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('未知能力线');
    expect(r.text).toContain('design');
  });

  it('getLane 命中与未知', () => {
    expect(getLane('design')?.label).toContain('设计');
    expect(getLane('nope')).toBeUndefined();
  });
});