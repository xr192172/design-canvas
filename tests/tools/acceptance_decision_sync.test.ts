/**
 * 验收演示：决策卡进同步（增量功能端到端）
 *
 * 完整链路（对应设计流）：
 *   1. 先写 DSL——把"决策卡进同步"这个增量功能的设计决策写进 DSL（文件级卡 + 符号级卡）
 *   2. 锚定基线（import_project 首次导入的 fork 语义）
 *   3. 实现改动（模拟实现侧动了代码）
 *   4. 跑 diffViews——看决策卡依据（基线卡/设计卡/符号卡）如何作为裁决一手资料
 *   5. 下线归档（archive_node）——孤立节点进下线库
 *
 * 运行：npx vitest run tests/tools/acceptance_decision_sync.test.ts
 * 验收方式：看 console 输出的完整 diff 消息。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { diffViews } from '../../src/tools/diff_views';
import { archiveNode, listArchive } from '../../src/tools/archive_node';
import {
  saveDSL,
  getDSL,
  saveBaselineFeature,
  saveLiveFeature,
  deleteFeature,
  clearAllFeatures,
  listArchiveEntries,
  getArchiveEntryByPath,
} from '../../src/storage';
import type { DesignDSL, SemanticFile, Symbol, NodeDecision } from '../../src/dsl/types';

// ──────── 工厂 ────────

const file = (
  pathName: string,
  syms: Array<{ name: string; sig: string; decision?: NodeDecision }>,
  decision?: NodeDecision,
): SemanticFile => ({
  id: 'f_' + pathName.replace(/[^a-zA-Z0-9]/g, '_'),
  path: pathName,
  responsibility: pathName,
  lines: 10,
  decision,
  symbols: syms.map((s, i) => ({
    name: s.name,
    kind: 'function' as const,
    line: i + 1,
    signature: s.sig,
    decision: s.decision,
  })) as Symbol[] | undefined,
});

const dsl = (feature: string, files: SemanticFile[], nodeCards?: Array<{ id: string; decision: NodeDecision }>): DesignDSL => ({
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
    nodes: (nodeCards ?? []).map((n) => ({ id: n.id, label: n.id, decision: n.decision })),
    edges: [],
  },
  semantic: { files },
} as DesignDSL);

// ──────── 决策卡：这个增量功能的设计决策（先写 DSL 时写进去） ────────

/** 文件级卡（挂在 diff_views 节点）：为什么选"LLM 读 diff 裁决"路线 */
const DIFF_VIEWS_CARD: NodeDecision = {
  summary: '三方对比是同步裁决的唯一真相源，冲突不自动合并，交 LLM 读 diff 裁决',
  rationale:
    '全自动合并无法处理语义冲突；决策卡上下文（基线卡=当初为何这么定/设计卡=现在为何改/符号卡=函数级）作为裁决一手资料，随 diff 输出',
  status: 'active',
  thread: '设计流-代码同步',
  tags: ['sync', 'arbitration'],
};

/** 文件级卡（挂在 archive_node 节点）：为什么下线进下线库 */
const ARCHIVE_NODE_CARD: NodeDecision = {
  summary: '下线节点孤立进下线库，存档完整 DSL 快照+决策卡+原因，不再参与周边联系',
  rationale: '节点下线（合并/弃用）后若不归档会丢失历史；下线库作为历史研究材料，diff 到删除类状态时可回溯',
  status: 'active',
  thread: '设计流-代码同步',
  tags: ['archive', 'lifecycle'],
};

/** 符号级卡（挂在 archiveNode 函数上）：为什么合并不自动合卡 */
const ARCHIVE_FUNC_CARD: NodeDecision = {
  summary: '合并不自动合卡，只做结构化迁移（归档快照+merged_from 溯源），summary 重写交 LLM',
  rationale: '决策是语义的，机器分不清两张卡怎么合并；结构化部分落地，语义部分交 LLM 用 diff 增量+归档卡裁决',
  status: 'active',
  thread: '设计流-代码同步',
  tags: ['merge', 'decision'],
};

describe('验收：决策卡进同步（增量功能端到端）', () => {
  const feature = 'decision-sync-demo';

  beforeEach(() => {
    clearAllFeatures();
  });
  afterEach(() => {
    clearAllFeatures();
    try {
      deleteFeature(feature);
    } catch {
      /* ignore */
    }
  });

  it('写 DSL(带决策卡) → 锚基线 → 实现改动 → diff 看到决策依据 → 归档', () => {
    // 1. 先写 DSL——设计侧：给 diff_views / archive_node 两个增量功能写决策卡（文件级+符号级）
    const design = dsl(
      feature,
      [
        file('src/tools/diff_views.ts', [{ name: 'diffViews', sig: 'diffViews(input): DiffViewsResult' }], DIFF_VIEWS_CARD),
        file(
          'src/tools/archive_node.ts',
          [
            { name: 'archiveNode', sig: 'archiveNode(input): ArchiveNodeResult', decision: ARCHIVE_FUNC_CARD },
            { name: 'listArchive', sig: 'listArchive(input): ListArchiveResult' },
          ],
          ARCHIVE_NODE_CARD,
        ),
      ],
      [
        { id: 'f_src_tools_diff_views_ts', decision: DIFF_VIEWS_CARD },
        { id: 'f_src_tools_archive_node_ts', decision: ARCHIVE_NODE_CARD },
      ],
    );
    console.log('\n────── 1. 先写 DSL（决策卡写进设计侧）──────');
    console.log(`  feature: ${feature}`);
    for (const f of design.semantic!.files) {
      const n = design.geometry.nodes.find((x) => x.id === f.id);
      console.log(`  ▸ ${f.path}`);
      if (n?.decision) console.log(`      [文件卡] ${n.decision.summary}`);
      for (const s of f.symbols ?? []) {
        if (s.decision) console.log(`      [符号卡] ${s.name}: ${s.decision.summary}`);
      }
    }
    saveDSL(design);

    // 2. 锚定基线（fork 语义：契约创立时刻）
    const baseline = dsl(feature, [
      file('src/tools/diff_views.ts', [{ name: 'diffViews', sig: 'diffViews(input)' }]), // v1 无卡
    ]);
    saveBaselineFeature(baseline);
    console.log('\n────── 2. 锚定基线（fork：契约创立时刻，diff_views v1 无卡）──────');

    // 3. 实现改动（模拟实现侧动了代码：diff_views 加了新函数，live 未同步设计卡）
    const live = dsl(feature, [
      file('src/tools/diff_views.ts', [
        { name: 'diffViews', sig: 'diffViews(input)' },
        { name: 'renderDecisionRef', sig: 'renderDecisionRef(card)' }, // 实现新增
      ]),
      file('src/tools/archive_node.ts', [{ name: 'archiveNode', sig: 'archiveNode(input, force?)' }]),
    ]);
    saveLiveFeature(live);
    console.log('\n────── 3. 实现改动（live：diff_views 新增函数 renderDecisionRef；archive_node 签名改动）──────');

    // 4. diffViews——决策卡依据随 diff 输出（LLM 裁决的一手资料）
    console.log('\n────── 4. diff_views 完整消息 ──────');
    const r = diffViews({ feature });
    console.log(r.message);
    console.log('\n────── 5. 结构化 three_way（决策字段）──────');
    for (const f of r.data.three_way!.files) {
      console.log(`  ${f.state} ${f.path}`);
      if (f.baseline_decision) console.log(`      baseline_decision: ${f.baseline_decision.summary}`);
      if (f.design_decision) console.log(`      design_decision: ${f.design_decision.summary}`);
      if (f.symbol_decisions) for (const [k, v] of Object.entries(f.symbol_decisions)) console.log(`      symbol_decisions.${k}: ${v.summary}`);
      if (f.archive) console.log(`      archive: ${f.archive.retire_reason}`);
    }

    // 断言关键语义（验收不只看消息，还要有硬断言）
    const twDiffViews = r.data.three_way!.files.find((x) => x.path === 'src/tools/diff_views.ts')!;
    expect(twDiffViews.design_decision?.summary).toBe(DIFF_VIEWS_CARD.summary);
    expect(twDiffViews.state).toBe('conflict'); // 设计加了卡+实现加了函数，两侧都改且不一致
    const twArchive = r.data.three_way!.files.find((x) => x.path === 'src/tools/archive_node.ts')!;
    expect(twArchive.design_decision?.summary).toBe(ARCHIVE_NODE_CARD.summary);
    expect(twArchive.symbol_decisions?.['archiveNode']?.summary).toBe(ARCHIVE_FUNC_CARD.summary);

    // 5. 下线归档（archive_node）：把 diff_views 下线合并进 archive_node
    console.log('\n────── 6. 下线归档（archive_node）──────');
    const ar = archiveNode({
      feature,
      file_path: 'src/tools/diff_views.ts',
      retire_reason: 'diff 裁决逻辑并入 archive_node 统一收口',
      merged_into: 'src/tools/archive_node.ts',
    });
    console.log(ar.message);
    expect(getArchiveEntryByPath(feature, 'src/tools/diff_views.ts')?.retire_reason).toContain('统一收口');
    const cur = getDSL(feature)!;
    expect(cur.semantic!.files.map((x) => x.path)).not.toContain('src/tools/diff_views.ts');
    const target = cur.semantic!.files.find((x) => x.path === 'src/tools/archive_node.ts')!;
    expect(target.lifecycle?.status).toBe('merged');
    expect(target.lifecycle?.merged_from).toContain('src/tools/diff_views.ts');

    // 6. 下线库可查（历史研究材料）
    console.log('\n────── 7. 下线库（list_archive）──────');
    console.log(listArchive({ feature }).message);
    expect(listArchiveEntries(feature)).toHaveLength(1);
  });
});
