/**
 * 决策卡进同步测试
 *
 * 覆盖：
 *   - 符号级决策卡（挂函数/API）进 diff：symbol_decisions 逐符号提取
 *   - 文件级决策卡（Node.decision）进 diff：baseline_decision=当初为何这么定 / design_decision=现在为何改
 *   - 下线库（archive）：存储/列出/按路径查/连带清理
 *   - archive_node 工具：孤立归档（移除文件+节点+边）、合并归档（目标 lifecycle.merged_from）、重复归档防御
 *   - diff_views 删除类状态附归档关联（历史研究材料）
 */
import fs from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { diffViews } from '../../src/tools/diff_views';
import { archiveNode } from '../../src/tools/archive_node';
import {
  saveDSL,
  getDSL,
  saveBaselineFeature,
  saveLiveFeature,
  deleteFeature,
  clearAllFeatures,
  saveArchiveEntry,
  listArchiveEntries,
  getArchiveEntryByPath,
  getArchiveDir,
  type ArchiveEntry,
} from '../../src/storage';
import type { DesignDSL, SemanticFile, Symbol, NodeDecision } from '../../src/dsl/types';

// ──────── 测试数据工厂 ────────

function file(pathName: string, syms?: Array<[string, string]>): SemanticFile {
  return {
    id: 'f_' + pathName.replace(/[^a-zA-Z0-9]/g, '_'),
    path: pathName,
    responsibility: '测试文件',
    lines: 5,
    symbols: syms?.map(([name, signature], i) => ({
      name,
      kind: 'function' as const,
      line: i + 1,
      signature,
      decision: { summary: `决策：${name}` },
    })) as Symbol[] | undefined,
  };
}

const node = (id: string, label: string, decision?: NodeDecision) => ({ id, label, decision });

/** 带决策卡的最小 DSL（文件级卡在 geometry.nodes 上，符号级卡在 symbols 上） */
function dsl(
  feature: string,
  files: SemanticFile[],
  nodes?: Array<{ id: string; label: string; decision?: NodeDecision }>,
): DesignDSL {
  return {
    id: feature,
    type: 'feature_diagram',
    feature,
    version: '1.0',
    title: feature,
    status: 'done',
    geometry: {
      layout: 'free',
      width: 800,
      height: 400,
      nodes:
        nodes ??
        files.map((f) => ({ id: f.id, label: f.path, decision: { summary: `文件决策：${f.path}` } })),
      edges: [],
    },
    semantic: { files },
  } as DesignDSL;
}

const A = () => file('src/a.ts', [['g', 'g(x)']]);

const features: string[] = [];
function track(feature: string): string {
  features.push(feature);
  return feature;
}

describe('决策卡进 diff（LLM 裁决的一手资料）', () => {
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

  it('符号级决策卡：diff 提取 symbol_decisions（挂函数上的卡逐符号对齐）', () => {
    const f = track('ds_sym');
    const design = dsl(f, [A()]);
    const live = dsl(f, [file('src/a.ts', [['g', 'g(x, y)']])]); // 实现改动
    const baseline = dsl(f, [A()]);
    saveBaselineFeature(baseline);
    saveLiveFeature(live);
    saveDSL(design);

    const r = diffViews({ feature: f });
    const tw = r.data.three_way!.files.find((x) => x.path === 'src/a.ts')!;
    expect(tw.state).toBe('live_only');
    // 符号卡随基线/设计侧提取（有卡的符号）
    expect(tw.symbol_decisions?.['g']?.summary).toBe('决策：g');
    // 消息里出现符号卡依据
    expect(r.message).toContain('决策卡依据');
    expect(r.message).toContain('[符号卡] g');
  });

  it('文件级决策卡：conflict 时带基线卡（当初为何这么定）+ 设计卡（现在为何改）', () => {
    const f = track('ds_file');
    const baseline = dsl(f, [A()], [{ id: 'f_src_a_ts', label: 'a.ts', decision: { summary: '当初用方案X', rationale: '为了性能' } }]);
    const design = dsl(f, [A()], [{ id: 'f_src_a_ts', label: 'a.ts', decision: { summary: '改用方案Y', thread: '内存治理' } }]);
    const live = dsl(f, [file('src/a.ts', [['g', 'g(a, b)']])]);
    saveBaselineFeature(baseline);
    saveLiveFeature(live);
    saveDSL(design);

    const r = diffViews({ feature: f });
    const tw = r.data.three_way!.files.find((x) => x.path === 'src/a.ts')!;
    expect(tw.state).toBe('conflict');
    expect(tw.baseline_decision?.summary).toBe('当初用方案X');
    expect(tw.baseline_decision?.rationale).toBe('为了性能');
    expect(tw.design_decision?.summary).toBe('改用方案Y');
    expect(tw.design_decision?.thread).toBe('内存治理');
    // 消息里出现基线卡/设计卡
    expect(r.message).toContain('[基线卡] 当初用方案X');
    expect(r.message).toContain('[设计卡] 改用方案Y');
  });
});

describe('下线库（archive）存储', () => {
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

  it('保存/列出/按路径查，deleteFeature 连带清理', () => {
    const f = track('ar_storage');
    const entry: ArchiveEntry = {
      feature: f,
      file_path: 'src/old.ts',
      dsl: dsl(f, []),
      retire_reason: '并入 service.ts',
      merged_into: 'src/service.ts',
      archived_at: '2026-08-30T00:00:00Z',
    };
    const id = saveArchiveEntry(entry);
    expect(id).toBe(`${f}__src_old_ts`);

    expect(listArchiveEntries(f)).toHaveLength(1);
    expect(getArchiveEntryByPath(f, 'src/old.ts')?.retire_reason).toBe('并入 service.ts');

    deleteFeature(f);
    expect(fs.existsSync(getArchiveDir(f))).toBe(false);
  });

  it('非法条目 id 防御', () => {
    const f = track('ar_bad');
    expect(() => saveArchiveEntry({ feature: f, file_path: 'a b/c', dsl: dsl(f, []), retire_reason: 'x', archived_at: 'x' })).not.toThrow();
    // 自动生成的 id 已被 sanitize，可直接访问
    expect(getArchiveEntryByPath(f, 'a b/c')).not.toBeNull();
  });
});

describe('archive_node 工具（孤立/合并下线）', () => {
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

  it('孤立归档：存档快照+原因，并从设计 DSL 移除文件/节点/边', () => {
    const f = track('ar_isolate');
    const design = dsl(f, [file('src/a.ts', [['g', 'g(x)']]), file('src/b.ts')], [
      { id: 'f_src_a_ts', label: 'a.ts', decision: { summary: '当初的决策' } },
      { id: 'f_src_b_ts', label: 'b.ts' },
    ]);
    // 加一条连到 a 的边，验证边也清理
    design.geometry!.edges = [{ id: 'e1', from: 'f_src_a_ts', to: 'f_src_b_ts' }];
    saveDSL(design);

    const r = archiveNode({ feature: f, file_path: 'src/a.ts', retire_reason: '功能并入 b.ts' });
    expect(r.removed_from_dsl).toBe(true);
    expect(r.archived_decision?.summary).toBe('当初的决策');
    expect(getArchiveEntryByPath(f, 'src/a.ts')?.retire_reason).toBe('功能并入 b.ts');

    // DSL 已移除文件/节点/边
    const cur = getDSL(f)!;
    expect(cur.semantic!.files.map((x) => x.path)).not.toContain('src/a.ts');
    expect(cur.geometry!.nodes.map((x) => x.id)).not.toContain('f_src_a_ts');
    expect(cur.geometry!.edges).toHaveLength(0);
  });

  it('合并归档：目标文件 lifecycle.merged_from 记录来源', async () => {
    const f = track('ar_merge');
    const design = dsl(f, [file('src/a.ts'), file('src/b.ts')]);
    saveDSL(design);

    const r = archiveNode({ feature: f, file_path: 'src/a.ts', retire_reason: 'a 并入 b', merged_into: 'src/b.ts' });
    expect(r.merged_into).toBe('src/b.ts');

    const cur = getDSL(f)!;
    const target = cur.semantic!.files.find((x) => x.path === 'src/b.ts')!;
    expect(target.lifecycle?.status).toBe('merged');
    expect(target.lifecycle?.merged_from).toContain('src/a.ts');
    expect(target.lifecycle?.retire_reason).toBe('a 并入 b');
  });

  it('重复归档防御：同一文件二次归档报错', async () => {
    const f = track('ar_dup');
    const design = dsl(f, [file('src/a.ts')]);
    saveDSL(design);
    archiveNode({ feature: f, file_path: 'src/a.ts', retire_reason: 'x' });
    expect(() => archiveNode({ feature: f, file_path: 'src/a.ts', retire_reason: 'y' })).toThrow(/已归档过/);
  });

  it('目标文件不存在时合并退化为孤立归档', async () => {
    const f = track('ar_miss');
    const design = dsl(f, [file('src/a.ts')]);
    saveDSL(design);
    const r = archiveNode({ feature: f, file_path: 'src/a.ts', retire_reason: 'x', merged_into: 'src/nope.ts' });
    expect(r.merged_into).toBeUndefined(); // 退化为孤立
  });
});

describe('diff_views 删除类状态附归档关联（历史研究材料）', () => {
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

  it('deleted_from_live（结构塌方）时附归档 retire_reason，消息可读', () => {
    const f = track('ds_arch');
    const baseline = dsl(f, [A()]);
    const design = dsl(f, [A()]);
    const live = dsl(f, []); // live 视图存在，但 a.ts 已被删（结构塌方）
    saveBaselineFeature(baseline);
    saveLiveFeature(live);
    saveDSL(design);
    // 预先归档该文件（历史研究材料）
    saveArchiveEntry({ feature: f, file_path: 'src/a.ts', dsl: baseline, retire_reason: '曾经下线过，因 X 弃用', archived_at: '2026-01-01T00:00:00Z' });

    const r = diffViews({ feature: f });
    const tw = r.data.three_way!.files.find((x) => x.path === 'src/a.ts')!;
    expect(tw.state).toBe('deleted_from_live');
    expect(tw.archive?.retire_reason).toBe('曾经下线过，因 X 弃用');
    expect(r.message).toContain('[归档] 弃用原因: 曾经下线过，因 X 弃用');
  });
});
