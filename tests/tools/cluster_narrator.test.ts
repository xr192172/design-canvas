/**
 * cluster_narrator（LLM 簇级翻译层）+ render_cluster_workbench（沙盘工作台）测试：
 *   - topLevelExportsOf 证据提取（正则忠实）
 *   - narrateClusters 无 LLM 全降级（事实句、不编造、不阻塞）
 *   - clusterEdgesOf 簇间边聚合（同簇忽略、跨簇聚合）
 *   - renderClusterWorkbenchHtml 有/无人话两种渲染形态
 * LLM 真调用不做单测（成本 + 不确定性）；降级路径即覆盖"翻译层缺席"契约。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  topLevelExportsOf,
  narrateClusters,
  collectNarrUnits,
  fallbackNarrative,
} from '../../src/tools/cluster_narrator';
import {
  clusterEdgesOf,
  renderClusterWorkbenchHtml,
} from '../../src/tools/render_cluster_workbench';
import { buildBrickify, type BrickifyResult } from '../../src/tools/brickify';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'narrator-'));
}
function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

/** 最小 BrickifyResult 夹具（2 积木 3 簇） */
function miniResult(): BrickifyResult {
  return {
    bricks: [
      {
        id: 'a',
        files: { frontend: [], backend: ['a/a1.ts', 'a/a2.ts'], shared: [] },
        total: 2,
        dominant: 'backend',
        sub_clusters: [
          {
            id: 'a#1',
            files: ['a/a1.ts', 'a/a2.ts'],
            total: 2,
            dominant: 'backend',
            role: 'brick',
            roles: { brick: ['a/a1.ts', 'a/a2.ts'], contract: [], glue: [] },
            internal_edges: 2,
            external_edges: 0,
            cohesion: 1,
            degenerate: false,
          },
        ],
        roles: { brick: ['a/a1.ts', 'a/a2.ts'], contract: [], glue: [] },
        role: 'brick',
        community: 'a',
        mixed_files: [],
      },
      {
        id: 'b',
        files: { frontend: ['b/b1.ts'], backend: [], shared: [] },
        total: 1,
        dominant: 'frontend',
        sub_clusters: [
          {
            id: 'b#1',
            files: ['b/b1.ts'],
            total: 1,
            dominant: 'frontend',
            role: 'glue',
            roles: { brick: [], contract: [], glue: ['b/b1.ts'] },
            internal_edges: 0,
            external_edges: 1,
            cohesion: 0,
            degenerate: false,
          },
        ],
        roles: { brick: [], contract: [], glue: ['b/b1.ts'] },
        role: 'glue',
        community: 'a',
        mixed_files: [],
      },
    ],
    file_deps: [
      { from: 'a/a1.ts', to: 'a/a2.ts', count: 2 },
      { from: 'b/b1.ts', to: 'a/a1.ts', count: 3 },
    ],
    communities: [
      { id: 'a', bricks: ['a', 'b'], internal_edges: 5, external_edges: 0, cohesion: 1 },
    ],
    mixed_files: [],
    call_edges: [{ from: 'b', to: 'a', count: 3 }],
    meta: {
      project_dir: '/proj',
      source_root: '/proj/src',
      scanned_files: 3,
      langs: ['ts'],
      role_totals: { brick: 2, contract: 0, glue: 1 },
    },
    limitations: [],
  };
}

const ENV_KEYS = ['LLM_API_KEY', 'DEEPSEEK_API_KEY', 'AGNES_API_KEY', 'LLM_BASE_URL', 'DEEPSEEK_BASE_URL', 'AGNES_BASE_URL'];
const saved: Record<string, string | undefined> = {};

describe('topLevelExportsOf 证据提取', () => {
  it('export function/const/class/interface/type/enum 与 export{} 名单都提取（去重限前 N）', () => {
    const root = makeTmp();
    write(
      root,
      'x.ts',
      [
        'export function alpha() {}',
        'export const beta = 1;',
        'export interface Gamma {}',
        'export type Delta = string;',
        'export class Epsilon {}',
        'export enum Zeta {}',
        'export { alpha as aliasA, extra };',
        'export default function() {}',
        'const internal = 0;', // 非导出：不提
      ].join('\n'),
    );
    const names = topLevelExportsOf(root, 'x.ts');
    for (const want of ['alpha', 'beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'aliasA', 'extra']) {
      expect(names).toContain(want);
    }
    expect(names).not.toContain('internal');
  });

  it('读不到文件返回空数组（不抛异常）', () => {
    expect(topLevelExportsOf(makeTmp(), 'nope.ts')).toEqual([]);
  });
});

describe('narrateClusters 降级路径（无 LLM 环境）', () => {
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

  it('无 LLM → 全部降级为事实句：mode=rule、degraded=true、三级全覆盖、不编造', async () => {
    const r = miniResult();
    const out = await narrateClusters(r, '/proj/src');
    expect(out.meta.degraded).toBe(true);
    expect(out.meta.llm_ok).toBe(0);
    expect(out.meta.total).toBe(5); // 1社区 + 2积木 + 2小簇
    expect(Object.keys(out.communities)).toHaveLength(1);
    expect(Object.keys(out.bricks)).toHaveLength(2);
    expect(Object.keys(out.clusters)).toHaveLength(2);
    for (const n of [...Object.values(out.communities), ...Object.values(out.bricks), ...Object.values(out.clusters)]) {
      expect(n.mode).toBe('rule');
    }
  });

  it('无 LLM → 项目总览降级：title=目录名、features 与积木一一对应、不编造功能', async () => {
    const r = miniResult();
    const out = await narrateClusters(r, '/proj/src');
    expect(out.overview.mode).toBe('rule');
    expect(out.overview.title).toBe('proj'); // path.basename('/proj')
    expect(out.overview.features.map((f) => f.target)).toEqual(['a', 'b']); // 一一对应
    expect(out.overview.desc).toContain('3 个源文件');
    expect(out.overview.desc).toContain('2 块积木');
    // 降级不发明功能名
    for (const f of out.overview.features) expect(f.desc).toMatch(/文件/);
  });

  it('事实句只陈述确定性事实（文件数/内聚度/角色），不带编造功能名', async () => {
    const u = collectNarrUnits(miniResult(), '/proj/src').find((x) => x.key === 'cluster:a#1')!;
    const fb = fallbackNarrative(u);
    expect(fb.mode).toBe('rule');
    expect(fb.title).toContain('a');
    expect(fb.desc).toContain('2 文件');
    expect(fb.desc).toContain('内聚 100%');
    expect(fb.desc).not.toMatch(/渲染|数据库|监控/); // 不发明功能
  });
});

describe('clusterEdgesOf 簇间边聚合', () => {
  it('同簇边忽略、跨簇边聚合计数', () => {
    const edges = clusterEdgesOf(miniResult());
    // a#1→a#1（同簇）忽略；b#1→a#1 跨簇保留
    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({ from: 'b#1', to: 'a#1', count: 3 });
  });
});

describe('renderClusterWorkbenchHtml 沙盘渲染', () => {
  it('无人话：全部节点带"待翻译"徽章，事实数字仍在', () => {
    const html = renderClusterWorkbenchHtml(miniResult());
    expect(html).toContain('待翻译');
    expect(html).toContain('内聚 100%');
    expect(html).toContain('2 文件');
    expect((html.match(/次调用/g) || []).length).toBeGreaterThan(0);
    // 详情悬窗数据在
    expect(html).toContain('const DETAIL');
  });

  it('有人话：卡片标题/描述进 HTML，徽章区分 llm/rule；项目总览卡+功能chips', () => {
    const nar = {
      overview: {
        title: '可视化设计画布',
        desc: '把想法变成图的工具，人和 AI 一起用。',
        features: [
          { target: 'a', label: '渲染引擎', desc: '画界面' },
          { target: 'b', label: '胶水接线', desc: '接起来' },
        ],
        mode: 'llm' as const,
      },
      communities: { a: { title: '渲染社区', desc: '负责画界面', mode: 'llm' as const } },
      bricks: { a: { title: '渲染积木', desc: '画界面核心', mode: 'llm' as const } },
      clusters: { 'a#1': { title: '界面渲染引擎', desc: '把数据变成图', mode: 'llm' as const } },
      meta: { llm_ok: 3, total: 5, degraded: false },
    };
    const html = renderClusterWorkbenchHtml(miniResult(), nar);
    expect(html).toContain('界面渲染引擎');
    expect(html).toContain('把数据变成图');
    // 社区行人话
    expect(html).toContain('渲染社区');
    // 项目总览卡：标题/desc/功能chips（与积木一一对应）
    expect(html).toContain('可视化设计画布');
    expect(html).toContain('把想法变成图的工具');
    expect(html).toContain('data-brick-target="a"');
    expect(html).toContain('渲染引擎');
    // 仍有降级簇（b#1 无翻译）→ 待翻译徽章
    expect(html).toContain('待翻译');
    expect(html).toContain('LLM 翻译 3/5');
  });
});

describe('buildBrickify 集成（真结构喂翻译层）', () => {
  it('collectNarrUnits 覆盖全部社区/积木/小簇，id 无碰撞', async () => {
    const r = await buildBrickify({ project_dir: path.join(process.cwd()), source_root: path.join(process.cwd(), 'src') });
    const units = collectNarrUnits(r, r.meta.source_root);
    const keys = units.map((u) => u.key);
    expect(new Set(keys).size).toBe(keys.length); // id 唯一
    expect(units.filter((u) => u.kind === 'community').length).toBe(r.communities.length);
    expect(units.filter((u) => u.kind === 'brick').length).toBe(r.bricks.length);
    expect(units.filter((u) => u.kind === 'cluster').length).toBe(r.bricks.reduce((a, b) => a + b.sub_clusters.length, 0));
  });
});
