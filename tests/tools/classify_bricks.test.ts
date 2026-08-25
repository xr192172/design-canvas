/**
 * classify_bricks（解剖学分类官，粒度=簇）+ render_anatomy（泳道视图）测试：
 *   - 启发式降级：簇内文件路径关键词归类、命不中进未归类桶（诚实残留）
 *   - 每簇恰好归一槽；槽位顺序保持；空槽如实渲染
 *   - 同积木的簇可分归不同槽位（粒度=簇 的核心收益）
 *   - 倒挂交叉验证：上游槽位依赖下游 → limitations 出信号
 *   - HTML 骨架：泳道/积木分组/簇节点/面包屑悬窗/文件清单
 * LLM 真调用不做单测（成本+不确定性）；启发式路径即"分类层缺席"契约。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { classifyByRule, classifyBricks } from '../../src/tools/classify_bricks';
import { defaultPipelineTaxonomy } from '../../src/tools/taxonomy';
import { renderAnatomyHtml } from '../../src/tools/render_anatomy';
import type { BrickifyResult } from '../../src/tools/brickify';

function brick(id: string, subClusters: Array<{ sid: string; files: string[] }>): BrickifyResult['bricks'][number] {
  const allFiles = subClusters.flatMap((s) => s.files);
  return {
    id,
    files: { frontend: [], backend: allFiles, shared: [] },
    total: allFiles.length,
    dominant: 'backend',
    sub_clusters: subClusters.map((s) => ({
      id: s.sid,
      files: s.files,
      total: s.files.length,
      dominant: 'backend' as const,
      role: 'brick' as const,
      roles: { brick: s.files, contract: [], glue: [] },
      internal_edges: 0,
      external_edges: 0,
      cohesion: 1,
      degenerate: false,
    })),
    roles: { brick: allFiles, contract: [], glue: [] },
    role: 'brick',
    community: 'c',
    mixed_files: [],
  };
}

function resultWith(bricks: BrickifyResult['bricks'], fileDeps: Array<{ from: string; to: string; count: number }> = []): BrickifyResult {
  return {
    bricks,
    file_deps: fileDeps,
    communities: [{ id: 'c', bricks: bricks.map((b) => b.id), internal_edges: 0, external_edges: 0, cohesion: 1 }],
    mixed_files: [],
    call_edges: [],
    meta: {
      project_dir: '/proj',
      source_root: '/proj/src',
      scanned_files: bricks.reduce((a, b) => a + b.total, 0),
      langs: ['ts'],
      role_totals: { brick: 10, contract: 0, glue: 0 },
    },
    limitations: [],
  };
}

const ENV_KEYS = ['LLM_API_KEY', 'DEEPSEEK_API_KEY', 'AGNES_API_KEY', 'LLM_BASE_URL', 'DEEPSEEK_BASE_URL', 'AGNES_BASE_URL'];
const saved: Record<string, string | undefined> = {};

describe('classifyByRule 启发式降级（粒度=簇）', () => {
  it('同积木的簇按各自路径分归不同槽位（粒度=簇的核心收益）', () => {
    const r = resultWith([
      brick('tools', [
        { sid: 'tools#1', files: ['tools/brickify_cluster.ts', 'tools/refactor_pipeline.ts'] },   // compute
        { sid: 'tools#2', files: ['tools/camera_instrument.ts', 'tools/signal_check.ts'] },      // observe
        { sid: 'tools#3', files: ['tools/refactor_judge.ts', 'tools/alert_inbox_review.ts'] },   // review
      ]),
    ]);
    const out = classifyByRule(r, defaultPipelineTaxonomy());
    expect(out['tools#1'].slot).toBe('compute');
    expect(out['tools#2'].slot).toBe('observe');
    expect(out['tools#3'].slot).toBe('review');
  });

  it('命不中 → 未归类桶（诚实残留）', () => {
    const r = resultWith([brick('misc', [{ sid: 'misc#1', files: ['misc/zzz.ts'] }])]);
    const out = classifyByRule(r, defaultPipelineTaxonomy());
    expect(out['misc#1'].slot).toBe('__unclassified__');
  });
});

describe('classifyBricks 主流程（无 LLM 环境）', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  });

  it('每簇恰好归一槽；槽位顺序保持；空槽如实渲染；未归类独立', async () => {
    const r = resultWith([
      brick('camera', [{ sid: 'camera#1', files: ['camera/instrument.ts'] }]),
      brick('misc', [{ sid: 'misc#1', files: ['misc/zzz.ts'] }]),
    ]);
    const out = await classifyBricks(r, undefined);
    expect(out.meta.mode).toBe('rule');
    expect(out.unclassified).toEqual(['misc#1']);
    expect(out.slots.map((s) => s.slot.id)).toEqual(defaultPipelineTaxonomy().slots.map((s) => s.id));
    const cameraLane = out.slots.find((s) => s.slot.id === 'observe')!;
    expect(cameraLane.groups).toHaveLength(1);
    expect(cameraLane.groups[0].brick).toBe('camera');
    expect(cameraLane.groups[0].clusters.map((c) => c.id)).toEqual(['camera#1']);
    expect(out.slots.find((s) => s.slot.id === 'intake')!.groups).toHaveLength(0);
    expect(out.meta.total).toBe(2);
  });

  it('倒挂交叉验证：上游槽位依赖下游 → limitations 出信号', async () => {
    // intake 的 scanner 依赖 render 的 html_render（倒挂：摄取不该吃呈现）
    const r = resultWith(
      [
        brick('scanner', [{ sid: 'scanner#1', files: ['scanner/file_scan.ts'] }]),
        brick('htmlout', [{ sid: 'htmlout#1', files: ['htmlout/render.ts'] }]),
      ],
      [{ from: 'scanner/file_scan.ts', to: 'htmlout/render.ts', count: 5 }],
    );
    const out = await classifyBricks(r, undefined);
    expect(out.limitations.some((l) => l.includes('倒挂'))).toBe(true);
  });
});

describe('renderAnatomyHtml 泳道视图（簇粒度）', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  });

  it('泳道/积木分组/簇节点/悬窗文件清单全渲染；启发式徽章区分', async () => {
    const r = resultWith([
      brick('camera', [{ sid: 'camera#1', files: ['camera/instrument.ts'] }]),
      brick('misc', [{ sid: 'misc#1', files: ['misc/zzz.ts'] }]),
    ]);
    const anatomy = await classifyBricks(r, undefined);
    const html = renderAnatomyHtml(r, anatomy);
    expect(html).toContain('输入摄取');
    expect(html).toContain('人机闭环');
    expect(html).toContain('空槽——本项目没有这部分');
    // 簇节点 + 归类徽章
    expect(html).toContain('data-cluster="camera#1"');
    expect(html).toContain('启发'); // rule 徽章
    // 积木分组标签
    expect(html).toContain('an-group');
    expect(html).toContain('camera/');
    // 未归类泳道
    expect(html).toContain('未归类');
    // 悬窗数据（簇级：面包屑+文件清单）
    expect(html).toContain('const DETAIL');
    expect(html).toContain('fileList');
    expect(html).toContain('归类依据');
  });

  it('有人话时簇节点标题用翻译', async () => {
    const r = resultWith([brick('camera', [{ sid: 'camera#1', files: ['camera/instrument.ts'] }])]);
    const anatomy = await classifyBricks(r, undefined);
    anatomy.slots.find((s) => s.slot.id === 'observe')!.groups[0].clusters[0].title = '插桩探针';
    const html = renderAnatomyHtml(r, anatomy);
    expect(html).toContain('插桩探针');
  });
});
