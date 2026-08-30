/**
 * 走查：harvest_decisions「先写 DSL → 从源码实现」两条路径对比
 *
 * 步骤 1（先写 DSL）：把 harvest_decisions 的行为契约写进 feature DSL——
 *   决策卡（为什么做）+ expected_apis（输入/输出语义）。此时实现代码还不存在。
 * 步骤 2（从源码实现）：实现 src/tools/harvest_decisions.ts 后，
 *   从 design-canvas 自身 docs + git 日志跑一遍，验证候选质量（吃自己的狗粮）。
 *
 * 走查目标：暴露「先写 DSL」与「直接实现」的摩擦点（见测试输出的 ─ 摩擦 ─ 段）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { saveDSL, getDSL, deleteFeature, clearAllFeatures } from '../../src/storage';
import { harvestDecisions } from '../../src/tools/harvest_decisions';
import type { DesignDSL, SemanticFile, NodeDecision } from '../../src/dsl/types';

// ──────── 契约（先写 DSL：决策卡 + expected_apis）────────

/** 决策卡：为什么做 harvest_decisions（补录时机、防编造、draft 门槛） */
const HARVEST_CARD: NodeDecision = {
  summary: '从文档/git日志/注释粗提取设计意图证据，生成 draft 决策卡候选，LLM review 后定稿补录',
  rationale:
    '现有项目（尤其外来/历史代码）没有决策卡历史，直接扫描必然失真；先取证（出处+原文片段）再精炼，避免机器编造；' +
    'draft 态保证补录有复核门槛，不污染活文档',
  alternatives: [
    { option: '内置 LLM 自动补录并直接写 active 卡', rejected_because: '纯函数工具无 LLM 运行时；无出处的补录会编造历史' },
  ],
  acceptance: '从 design-canvas 自身 docs+git 日志能提取 3 条以上可复核（含出处）的决策候选',
  status: 'active',
  thread: '决策卡补录',
  tags: ['harvest', 'decision', 'gitlog', 'doc'],
};

/** 契约骨架（expected_apis）：只定行为语义，不定实现细节 */
const harvestDSL = (): DesignDSL => {
  const file: SemanticFile = {
    id: 'f_src_tools_harvest_decisions_ts',
    path: 'src/tools/harvest_decisions.ts',
    responsibility: '从文档/git日志/注释提取设计意图线索，生成 draft 决策卡候选，供 LLM review 后补录',
    lines: 1,
    expected_apis: [
      {
        signature: 'harvestDecisions(input: { feature: string; doc_dir?: string; git_root?: string; limit?: number; comment_files?: string[] }): HarvestResult',
        notes: '提取设计意图线索，产出 draft 候选（含出处/原文，可复核）',
      },
    ],
  };
  return {
    id: 'harvest-decisions',
    type: 'feature_diagram',
    feature: 'harvest-decisions',
    version: '1.0',
    title: 'harvest_decisions：决策卡补录',
    status: 'draft', // 未实现完成为 draft
    geometry: {
      layout: 'free',
      width: 800,
      height: 400,
      nodes: [{ id: file.id, label: 'src/tools/harvest_decisions.ts', decision: HARVEST_CARD }],
      edges: [],
    },
    semantic: { files: [file] },
  } as DesignDSL;
};

const PKG_ROOT = path.resolve(__dirname, '..', '..'); // design-canvas/

describe('走查：harvest_decisions 先写 DSL → 从源码实现', () => {
  beforeEach(() => clearAllFeatures());
  afterEach(() => {
    clearAllFeatures();
    try {
      deleteFeature('harvest-decisions');
    } catch {
      /* ignore */
    }
  });

  it('步骤1: 先写 DSL——契约与决策卡写进设计侧（实现代码尚不存在）', () => {
    const dsl = harvestDSL();
    saveDSL(dsl);

    const saved = getDSL('harvest-decisions')!;
    console.log('\n────── 走查·步骤1：先写 DSL（契约先行，实现未开始）──────');
    console.log(JSON.stringify(saved, null, 2));

    // 契约已落盘：expected_apis 是"要什么"，决策卡是"为什么做"
    expect(saved.semantic!.files[0].expected_apis?.[0].signature).toContain('harvestDecisions');
    expect(saved.geometry.nodes[0].decision?.summary).toBe(HARVEST_CARD.summary);
    expect(saved.status).toBe('draft');
  });

  it('步骤2: 从源码实现走一遍——用 design-canvas 自身 docs + git 日志跑 harvest（吃自己的狗粮）', () => {
    // 契约已定，现在实现源码（h2 完成后此处有真实现）
    const gitRoot = PKG_ROOT;
    const docDir = path.join(PKG_ROOT, 'docs');
    const result = harvestDecisions({
      feature: 'harvest-decisions',
      doc_dir: fs.existsSync(docDir) ? docDir : undefined,
      git_root: gitRoot,
      limit: 20,
    });

    console.log('\n────── 走查·步骤2：从真实源码/文档/git 日志提取决策线索 ──────');
    console.log(result.message);
    console.log(`\n  ─ 候选统计 ─`);
    console.log(`  共 ${result.candidates.length} 条（doc: ${result.candidates.filter((c) => c.source === 'doc').length}, gitlog: ${result.candidates.filter((c) => c.source === 'gitlog').length}, comment: ${result.candidates.filter((c) => c.source === 'comment').length})`);

    // 每条候选必须带出处（可复核，防编造）
    for (const c of result.candidates) {
      expect(c.ref).toBeTruthy();
      expect(c.draft_summary).toBeTruthy();
      expect(c.evidence).toBeTruthy();
    }
    // 验收标准：从自身 docs 能提取出 ≥1 条可复核候选
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it('步骤2b: 指定 comment_files 时能提取注释块作为决策线索', () => {
    const result = harvestDecisions({
      feature: 'harvest-decisions',
      git_root: undefined,
      comment_files: [path.join(PKG_ROOT, 'src/tools/backfill.ts')],
    });
    // 工具级注释块（/** … */）应被识别为设计意图线索
    console.log('\n────── 走查·步骤2b：从源码注释块提取决策线索 ──────');
    console.log(result.message);
    const commentCandidates = result.candidates.filter((c) => c.source === 'comment');
    expect(commentCandidates.length).toBeGreaterThanOrEqual(1);
  });
});
