/**
 * 三方对比（baseline/design/live）测试
 *
 * 覆盖：
 *   - import_project 首次写 live 时 fork 基线（ensureBaseline），再次导入不漂移
 *   - 无设计视图时退化为「基线→实现」实现增量（live_only）
 *   - 三方齐全时的 Git 三路 merge 语义分类：
 *     design_only / live_only / conflict / converged / added / implemented /
 *     removed / deleted_from_live / unchanged
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { importProject } from '../../src/tools/import_project';
import { diffViews } from '../../src/tools/diff_views';
import type { ThreeWayState } from '../../src/tools/diff_views';
import {
  saveDSL,
  saveLiveFeature,
  saveBaselineFeature,
  getBaselineFeature,
  getLiveFeature,
  deleteFeature,
  clearAllFeatures,
} from '../../src/storage';
import type { DesignDSL, SemanticFile, Symbol } from '../../src/dsl/types';

// ──────── 测试数据工厂 ────────

/** 构造一个带可选符号/API 的语义文件 */
function file(pathName: string, lines: number, syms?: Array<[string, string]>): SemanticFile {
  return {
    id: 'f_' + pathName.replace(/[^a-zA-Z0-9]/g, '_'),
    path: pathName,
    responsibility: '测试文件',
    lines,
    symbols: syms?.map(([name, signature], i) => ({ name, kind: 'function' as const, line: i + 1, signature })) as Symbol[] | undefined,
    expected_apis: syms?.map(([name, signature], i) => ({ name, signature, line: i + 1 })),
  };
}

/** 构造一个最小 DSL */
function dsl(feature: string, files: SemanticFile[]): DesignDSL {
  return {
    id: feature,
    type: 'feature_diagram',
    feature,
    version: '1.0',
    title: feature,
    status: 'done',
    geometry: { layout: 'free', width: 800, height: 400, nodes: [], edges: [] },
    semantic: { files },
  } as DesignDSL;
}

/** 组装 baseline/design/live 三视图并返回 diffViews 结果 */
function setup(feature: string, opts: { baseline?: SemanticFile[]; design?: SemanticFile[]; live?: SemanticFile[] }) {
  if (opts.baseline !== undefined) saveBaselineFeature(dsl(feature, opts.baseline));
  if (opts.live !== undefined) saveLiveFeature(dsl(feature, opts.live));
  if (opts.design !== undefined) saveDSL(dsl(feature, opts.design));
  return diffViews({ feature });
}

/** 取某文件的三方状态 */
function stateOf(feature: string, pathName: string): ThreeWayState | undefined {
  const d = diffViews({ feature });
  return d.data.three_way?.files.find((f) => f.path === pathName)?.state;
}

// 基准文件：一个符号 g(x)
const A = (sig = 'g(x)') => file('src/a.ts', 3, [['g', sig]]);

const features: string[] = [];

function track(feature: string): string {
  features.push(feature);
  return feature;
}

describe('import_project fork 基线（契约创立时刻）', () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-fixture-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src/a.ts'),
      'export function greet(name: string): string {\n  return "hi " + name;\n}\n',
      'utf-8',
    );
  });

  afterAll(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows 文件占用，留给 OS 清理
    }
  });

  beforeEach(() => {
    clearAllFeatures();
    for (const f of features) {
      try {
        deleteFeature(f);
      } catch {
        /* ignore */
      }
    }
    features.length = 0;
  });

  afterEach(() => {
    for (const f of features) {
      try {
        deleteFeature(f);
      } catch {
        /* ignore */
      }
    }
    features.length = 0;
  });

  it('首次 live_only 导入：落 live 的同时 fork 基线，diffViews 报告 baseline_exists 且无冲突', async () => {
    await importProject({ project_dir: root, feature: track('bl_import'), live_only: true });

    const baseline = getBaselineFeature('bl_import');
    const live = getLiveFeature('bl_import');
    expect(baseline).not.toBeNull();
    expect(live).not.toBeNull();
    expect(baseline!.semantic!.files.length).toBeGreaterThan(0);

    const d = diffViews({ feature: 'bl_import' });
    expect(d.data.baseline_exists).toBe(true);
    // 无设计视图 → 退化为实现增量，全部文件相对基线未动
    expect(d.data.three_way!.summary.conflict).toBe(0);
    expect(stateOf('bl_import', 'src/a.ts')).toBe('unchanged');
  });

  it('改代码后重新 live_only 导入：live 更新、baseline 不漂移，diffViews 报实现增量（live_only）', async () => {
    // 首次导入锚定基线
    await importProject({ project_dir: root, feature: track('bl_fix'), live_only: true });
    const baselineBefore = getBaselineFeature('bl_fix')!;
    const baseLines = baselineBefore.semantic!.files.find((f) => f.path === 'src/a.ts')!.lines;

    // 模拟修复：给 greet 增加重载，行数与符号都变化
    fs.writeFileSync(
      path.join(root, 'src/a.ts'),
      'export function greet(name: string): string {\n  return "hi " + name;\n}\n\nexport function farewell(name: string): string {\n  return "bye " + name;\n}\n',
      'utf-8',
    );
    await importProject({ project_dir: root, feature: 'bl_fix', live_only: true });

    // baseline 不漂移（行数仍是首次导入值）
    const baselineAfter = getBaselineFeature('bl_fix')!;
    expect(baselineAfter.semantic!.files.find((f) => f.path === 'src/a.ts')!.lines).toBe(baseLines);
    // live 已更新
    const liveAfter = getLiveFeature('bl_fix')!;
    expect(liveAfter.semantic!.files.find((f) => f.path === 'src/a.ts')!.lines).toBeGreaterThan(baseLines);

    // 三方对比：该文件 = 实现改动（fix 直接改代码）
    expect(stateOf('bl_fix', 'src/a.ts')).toBe('live_only');
  });
});

describe('三方对比分类（Git 三路 merge 语义）', () => {
  beforeEach(() => clearAllFeatures());
  afterEach(() => {
    for (const f of features) {
      try {
        deleteFeature(f);
      } catch {
        /* ignore */
      }
    }
    features.length = 0;
  });

  it('仅设计改动 → design_only（意图增量）', () => {
    const f = track('tw_design_only');
    const r = setup(f, { baseline: [A()], design: [A('g(x, y)')], live: [A()] });
    expect(r.data.three_way!.files.find((x) => x.path === 'src/a.ts')!.state).toBe('design_only');
    expect(r.data.three_way!.summary.design_only).toBe(1);
  });

  it('仅实现改动 → live_only（实现增量/fix）', () => {
    const f = track('tw_live_only');
    const r = setup(f, { baseline: [A()], design: [A()], live: [A('g(x, y)')] });
    expect(r.data.three_way!.files.find((x) => x.path === 'src/a.ts')!.state).toBe('live_only');
    expect(r.data.three_way!.summary.live_only).toBe(1);
  });

  it('两侧都改动且不一致 → conflict（交 LLM 读 diff 裁决）', () => {
    const f = track('tw_conflict');
    const r = setup(f, { baseline: [A()], design: [A('g(x, y)')], live: [A('g(a, b)')] });
    expect(r.data.three_way!.files.find((x) => x.path === 'src/a.ts')!.state).toBe('conflict');
    expect(r.data.three_way!.summary.conflict).toBe(1);
    // 冲突文件带两侧相对基线的增量
    const c = r.data.three_way!.files.find((x) => x.path === 'src/a.ts')!;
    expect(c.intent_symbols.some((s) => s.change === 'modified')).toBe(true);
    expect(c.implement_symbols.some((s) => s.change === 'modified')).toBe(true);
    expect(r.message).toContain('冲突待裁决');
  });

  it('两侧都改动但结果一致 → converged（已收敛，可直接采用）', () => {
    const f = track('tw_converged');
    const r = setup(f, { baseline: [A()], design: [A('g(x, y)')], live: [A('g(x, y)')] });
    expect(r.data.three_way!.files.find((x) => x.path === 'src/a.ts')!.state).toBe('converged');
  });

  it('设计新增未实现 → added', () => {
    const f = track('tw_added');
    const r = setup(f, { baseline: [], design: [A()], live: [] });
    expect(r.data.three_way!.files.find((x) => x.path === 'src/a.ts')!.state).toBe('added');
  });

  it('设计新增且已实现 → implemented', () => {
    const f = track('tw_implemented');
    const r = setup(f, { baseline: [], design: [A()], live: [A()] });
    expect(r.data.three_way!.files.find((x) => x.path === 'src/a.ts')!.state).toBe('implemented');
  });

  it('设计删除、代码仍在 → removed', () => {
    const f = track('tw_removed');
    const r = setup(f, { baseline: [A()], design: [], live: [A()] });
    expect(r.data.three_way!.files.find((x) => x.path === 'src/a.ts')!.state).toBe('removed');
  });

  it('实现删除、设计仍在 → deleted_from_live（结构塌方）', () => {
    const f = track('tw_deleted');
    const r = setup(f, { baseline: [A()], design: [A()], live: [] });
    expect(r.data.three_way!.files.find((x) => x.path === 'src/a.ts')!.state).toBe('deleted_from_live');
  });

  it('三方一致 → unchanged', () => {
    const f = track('tw_unchanged');
    const r = setup(f, { baseline: [A()], design: [A()], live: [A()] });
    expect(r.data.three_way!.files.find((x) => x.path === 'src/a.ts')!.state).toBe('unchanged');
  });

  it('无设计视图：实现新增未登记 → live_only（不误判为设计删除）', () => {
    const f = track('tw_no_design');
    const r = setup(f, { baseline: [A()], live: [A('g(x, y)')] });
    expect(r.data.design_exists).toBe(false);
    expect(r.data.baseline_exists).toBe(true);
    expect(r.data.three_way!.files.find((x) => x.path === 'src/a.ts')!.state).toBe('live_only');
  });
});
