/**
 * render_dep_canvas（mock 样式真数据依赖图画布）测试：
 *   - SCC 缩点分层布局：无环节点按依赖深度分列；环内节点塌缩同层
 *   - 连线路径程序生成（右缘中点→左缘中点贝塞尔）
 *   - 节点状态点忠实映射（整层耦合=warn / 待翻译=gray / 正常=ok）
 *   - HTML 骨架完整（节点/连线/小地图/悬窗数据）
 */
import { describe, it, expect } from 'vitest';
import { layoutCanvas, renderDepCanvasHtml } from '../../src/tools/render_dep_canvas';
import type { BrickifyResult } from '../../src/tools/brickify';

function brick(id: string, subIds: string[], opts?: { degenerate?: boolean }): BrickifyResult['bricks'][number] {
  const files = subIds.flatMap((sid) =>
    Array.from({ length: sid === 'big' ? 3 : 1 }, (_, i) => `${id}/${sid}_${i}.ts`),
  );
  const sub = subIds.map((sid, i) => ({
    id: `${id}#${i + 1}`,
    files: files.filter((f) => f.startsWith(`${id}/${sid}`)),
    total: files.filter((f) => f.startsWith(`${id}/${sid}`)).length,
    dominant: 'backend' as const,
    role: 'brick' as const,
    roles: { brick: files.filter((f) => f.startsWith(`${id}/${sid}`)), contract: [], glue: [] },
    internal_edges: 0,
    external_edges: 0,
    cohesion: 1,
    degenerate: false,
  }));
  if (opts?.degenerate) {
    for (const s of sub) {
      s.degenerate = true;
      s.internal_edges = 2;
    }
  }
  return {
    id,
    files: { frontend: [], backend: files, shared: [] },
    total: files.length,
    dominant: 'backend',
    sub_clusters: sub,
    roles: { brick: files, contract: [], glue: [] },
    role: 'brick',
    community: 'c',
    mixed_files: [],
  };
}

function resultWith(bricks: BrickifyResult['bricks'], fileDeps: Array<{ from: string; to: string; count: number }>): BrickifyResult {
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

describe('layoutCanvas SCC 分层布局（mock 没有的运算逻辑）', () => {
  it('依赖方向决定列：提供者在左，消费者在右（箭头向右=数据流）', () => {
    // b imports a（b 消费 a 的能力）：a 是提供者应更靠左
    const r = resultWith([brick('a', ['a']), brick('b', ['b'])], [
      { from: 'b/b_0.ts', to: 'a/a_0.ts', count: 1 },
    ]);
    // 画布边约定：from=提供者 → to=消费者（canvasEdges 已换向）
    const edges = [
      { from: 'a#1', to: 'b#1', count: 1, active: false },
    ];
    const layout = layoutCanvas(r, edges);
    const a = layout.nodes.find((n) => n.id === 'a#1')!;
    const b = layout.nodes.find((n) => n.id === 'b#1')!;
    expect(a.level).toBe(0);
    expect(b.level).toBe(1);
    expect(a.x).toBeLessThan(b.x);
  });

  it('环内节点塌缩为同层（Tarjan SCC）——不无限分层', () => {
    // x#1 ↔ y#1 互相调用成环：两者必须同层
    const r = resultWith([brick('x', ['x']), brick('y', ['y'])], [
      { from: 'x/x_0.ts', to: 'y/y_0.ts', count: 1 },
      { from: 'y/y_0.ts', to: 'x/x_0.ts', count: 1 },
    ]);
    const edges = [
      { from: 'x#1', to: 'y#1', count: 1, active: false },
      { from: 'y#1', to: 'x#1', count: 1, active: false },
    ];
    const layout = layoutCanvas(r, edges);
    const x = layout.nodes.find((n) => n.id === 'x#1')!;
    const y = layout.nodes.find((n) => n.id === 'y#1')!;
    expect(x.level).toBe(y.level);
    // 同层不同行：垂直堆叠不重叠
    expect(x.y).not.toBe(y.y);
  });

  it('同层节点垂直堆叠，无重叠；画布尺寸覆盖全部节点', () => {
    const r = resultWith([brick('a', ['p', 'q', 's'])], []);
    const layout = layoutCanvas(r, []);
    const rects = layout.nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }));
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const A = rects[i], B = rects[j];
        const overlap = A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h;
        expect(overlap).toBe(false);
      }
    }
    for (const n of layout.nodes) {
      expect(n.x + n.w).toBeLessThanOrEqual(layout.width + 1);
      expect(n.y + n.h).toBeLessThanOrEqual(layout.height + 1);
    }
  });
});

describe('renderDepCanvasHtml（mock 壳 + 真数据）', () => {
  it('节点/连线/小地图/悬窗/交互脚本全在；状态点忠实映射', () => {
    const r = resultWith(
      [brick('a', ['a'], { degenerate: true }), brick('b', ['b'])],
      [{ from: 'b/b_0.ts', to: 'a/a_0.ts', count: 3 }],
    );
    const html = renderDepCanvasHtml(r);
    // mock 壳的关键结构
    expect(html).toContain('dslw-node');
    expect(html).toContain('dslw-connections');
    expect(html).toContain('marker-end');
    expect(html).toContain('dslw-minimap');
    expect(html).toContain('mm-viewport');
    expect((html.match(/<path class="[^"]*flow/g) || []).length).toBeGreaterThanOrEqual(1);
    // 交互脚本（缩放/拖拽/fit/悬窗）
    expect(html).toContain('applyTransform');
    expect(html).toContain('addEventListener');
    expect(html).toContain('const DETAIL');
    // 状态忠实：整层耦合 → warn
    expect(html).toContain('整层耦合');
    // 调用量 tooltip（消费者 调用 提供者 · N 次）
    expect(html).toContain('调用');
    expect(html).toMatch(/· \d+ 次</);
  });

  it('有人话：节点标题/描述进画布；降级簇标 gray「待解读」', () => {
    const r = resultWith([brick('a', ['a'])], []);
    const nar = {
      overview: { title: '画布测试项目', desc: 'x', features: [], mode: 'llm' as const },
      communities: {},
      bricks: {},
      clusters: { 'a#1': { title: '渲染引擎核心', desc: '把数据变成画面', mode: 'llm' as const } },
      meta: { llm_ok: 1, total: 1, degraded: false },
    };
    const html = renderDepCanvasHtml(r, nar);
    expect(html).toContain('渲染引擎核心');
    expect(html).toContain('把数据变成画面');
    expect(html).toContain('画布测试项目'); // 总览进顶栏
    expect(html).toContain('LLM 解读 1/1');
  });
});
