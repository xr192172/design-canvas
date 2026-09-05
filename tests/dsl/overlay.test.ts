import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reconcileOverlay, applyOverlay, buildCandidates, buildEdgeCandidates, seedOverlayFromDsl, computeFileSignature } from '../../src/dsl/overlay';
import type { DesignOverlay } from '../../src/dsl/overlay';
import type { DesignDSL, Node, UserNode } from '../../src/dsl/types';

describe('overlay 增量对账（design DSL 不再随真相刷新丢失设计意图）', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ov_'));
    process.env.DESIGN_CANVAS_HOME = home;
  });
  afterEach(() => {
    delete process.env.DESIGN_CANVAS_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  const cand = (id: string, p: string, sig?: string): { id: string; path: string; kind: 'file'; signature?: string } => ({
    id,
    path: p,
    kind: 'file',
    signature: sig,
  });

  it('同锚点、签名未变 → 原样保留，决策与标注都在', () => {
    const old: DesignOverlay = {
      version: 1,
      feature: 'f',
      anchors: {
        file_a: { path: 'src/a.ts', kind: 'file', signature: 'sig-v1', decision: { summary: '决策A' } },
        file_b: { path: 'src/b.ts', kind: 'file', signature: 's1', annotations: [{ id: 'n1', text: '标注', type: 'comment' }] },
      },
      global: { user_nodes: [{ id: 'u1', parent_id: 'root', text: '人写的枝' }] },
    };
    const next = [cand('file_a', 'src/a.ts', 'sig-v1'), cand('file_b', 'src/b.ts', 's1')];
    const { overlay, stats } = reconcileOverlay(old, next);

    expect(stats.retained).toBe(2);
    expect(stats.orphaned).toBe(0);
    expect(stats.stale).toBe(0);
    expect(overlay.anchors['file_a']?.decision?.summary).toBe('决策A');
    expect(overlay.anchors['file_b']?.annotations?.[0]?.text).toBe('标注');
    expect(overlay.global?.user_nodes).toBeDefined();
  });

  it('签名变化（实现动了）→ 保留设计 + 标过期（不丢）', () => {
    const old: DesignOverlay = {
      version: 1, feature: 'f',
      anchors: { file_a: { path: 'src/a.ts', kind: 'file', signature: 'sig-v1', decision: { summary: '决策A' } } },
    };
    const next = [cand('file_a', 'src/a.ts', 'sig-v2')]; // 只签名变
    const { overlay, stats } = reconcileOverlay(old, next);
    expect(stats.stale).toBe(1);
    expect(stats.retained).toBe(1);
    expect(overlay.anchors['file_a']?.decision?.summary).toBe('决策A');
    expect(overlay.anchors['file_a']?.stale).toBe(true);
  });

  it('签名恢复 → 过期标记清除', () => {
    // 过期锚点保留的是「设计校验时」的基线签名 sig-v1；真相签名回到基线后应清除过期标记
    const stale: DesignOverlay = {
      version: 1, feature: 'f',
      anchors: { file_a: { path: 'src/a.ts', kind: 'file', signature: 'sig-v1', decision: { summary: '决策A' }, stale: true } },
    };
    const { overlay } = reconcileOverlay(stale, [cand('file_a', 'src/a.ts', 'sig-v1')]);
    expect(overlay.anchors['file_a']?.stale).toBeUndefined();
  });

  it('路径漂移 + 签名相同 → 判定为改名，迁移到新锚点', () => {
    const old: DesignOverlay = {
      version: 1, feature: 'f',
      anchors: { file_a: { path: 'src/a.ts', kind: 'file', signature: 'sig-v1', decision: { summary: '决策A' } } },
    };
    const next = [cand('file_a2', 'src/a2.ts', 'sig-v1')]; // renamed
    const { overlay, stats } = reconcileOverlay(old, next);
    expect(stats.migrated).toBe(1);
    expect(overlay.anchors['file_a2']?.decision?.summary).toBe('决策A');
    expect(overlay.anchors['file_a2']?._migratedFrom).toBe('file_a');
  });

  it('真相已删该锚点 → 孤儿暂存，不静默丢弃', () => {
    const old: DesignOverlay = {
      version: 1, feature: 'f',
      anchors: { file_a: { path: 'src/a.ts', kind: 'file', signature: 'sig-v1', decision: { summary: '决策A' } } },
    };
    const next = [cand('file_b', 'src/b.ts', 's1')]; // file_a 没了
    const { overlay, stats } = reconcileOverlay(old, next);
    expect(stats.orphaned).toBe(1);
    expect(overlay.anchors['file_a']?.decision?.summary).toBe('决策A');
    expect(overlay.anchors['file_a']?.orphaned).toBe(true);
  });

  it('applyOverlay：把锚点决策/标注/全局件合回 base', () => {
    const overlay: DesignOverlay = {
      version: 1, feature: 'f',
      anchors: {
        file_a: { path: 'src/a.ts', kind: 'file', decision: { summary: '决策A' }, annotations: [{ id: 'n1', text: '标注' }] },
      },
      global: { user_nodes: [{ id: 'u1', parent_id: 'root', text: '人写的枝' }], storyboard: { steps: 3 } },
    };
    const node: Node = { id: 'file_a', label: 'a.ts', x: 0, y: 0, width: 100, height: 40, type: 'file', description: 'src/a.ts' };
    const base: DesignDSL = { feature: 'f', geometry: { nodes: [node], edges: [] } };
    const merged = applyOverlay(base, overlay);

    expect(merged.geometry.nodes[0]?.decision?.summary).toBe('决策A');
    expect(merged.annotations?.some((a) => a.id === 'n1')).toBe(true);
    expect((merged as unknown as { user_nodes?: UserNode[] }).user_nodes?.[0]?.text).toBe('人写的枝');
    expect(((merged as unknown as { meta?: { storyboard?: unknown } }).meta)?.storyboard).toEqual({ steps: 3 });
  });

  it('buildCandidates + computeFileSignature：接口签名稳定、变化可检测', () => {
    const dsl: DesignDSL = {
      feature: 'f',
      geometry: {
        nodes: [{ id: 'file_a', label: 'a.ts', x: 0, y: 0, width: 100, height: 40, type: 'file', description: 'src/a.ts' }],
        edges: [],
      },
      semantic: {
        files: [
          { id: 'file_a', path: 'src/a.ts', status: 'done', lines: 10, expected_apis: [{ signature: 'foo(x: number)', line: 1, end_line: 2 }] },
        ],
      },
    };
    const cs = buildCandidates(dsl);
    const s1 = computeFileSignature(dsl.semantic!.files[0].expected_apis!, [], 10);
    expect(cs[0].id).toBe('file_a');
    expect(cs[0].signature).toBe(s1);
    const s2 = computeFileSignature([{ signature: 'foo(x: string)', line: 1, end_line: 2 }], [], 10);
    expect(s2).not.toBe(s1);
  });

  it('seedOverlayFromDsl：从既有设计 DSL 一次性迁移设计意图', () => {
    const node: Node = {
      id: 'file_a', label: 'a.ts', x: 0, y: 0, width: 100, height: 40, type: 'file', description: 'src/a.ts',
      decision: { summary: '已有决策' },
    };
    const dsl: DesignDSL = {
      feature: 'f', theme: 'sakura',
      geometry: { nodes: [node], edges: [] },
      annotations: [{ id: 'n1', text: '旧标注', node_id: 'file_a' }],
      user_nodes: [{ id: 'u1', parent_id: 'root', text: '枝' }],
    };
    const ov = seedOverlayFromDsl(dsl);
    expect(ov.anchors['file_a']?.decision?.summary).toBe('已有决策');
    expect(ov.anchors['file_a']?.annotations?.[0]?.id).toBe('n1');
    expect(ov.global?.theme).toBe('sakura');
    expect(ov.global?.user_nodes?.[0]?.text).toBe('枝');
  });

  it('落盘一个 JSON 再读回，结构无损（写入真实文件）', () => {
    const overlay: DesignOverlay = {
      version: 1, feature: 'f',
      anchors: { file_a: { path: 'src/a.ts', kind: 'file', decision: { summary: '决策A' } } },
    };
    const file = path.join(home, '.design-canvas', 'features', 'f.overlay.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(overlay));
    const readBack = JSON.parse(readFileSync(file, 'utf-8'));
    expect(readBack.anchors['file_a'].decision.summary).toBe('决策A');
  });
});

describe('overlay 缺口：边级意图(③) / 结构化目标(④) / 决策作者时间线(①)', () => {
  const edgeBase = (edges: Array<{ id: string; from: string; to: string }>): DesignDSL => ({
    feature: 'f',
    geometry: { nodes: [], edges },
  });

  it('reconcileOverlay 边：id 未变 → 意图原样保留', () => {
    const old: DesignOverlay = {
      version: 1, feature: 'f', anchors: {},
      edges: { e1: { from: 'a', to: 'b', reason: 'A 需要 B 的缓存', boundary: '链路边界' } },
    };
    const { overlay } = reconcileOverlay(old, [], [{ id: 'e1', from: 'a', to: 'b' }]);
    expect(overlay.edges?.['e1']?.reason).toBe('A 需要 B 的缓存');
    expect(overlay.edges?.['e1']?.orphaned).toBeUndefined();
  });

  it('reconcileOverlay 边：id 变更但 (from,to) 稳定 → 认亲重挂并记 _migratedFrom', () => {
    const old: DesignOverlay = {
      version: 1, feature: 'f', anchors: {},
      edges: { e1: { from: 'a', to: 'b', reason: '边界依赖' } },
    };
    const { overlay } = reconcileOverlay(old, [], [{ id: 'e2', from: 'a', to: 'b' }]);
    expect(overlay.edges?.['e1']).toBeUndefined();
    expect(overlay.edges?.['e2']?.reason).toBe('边界依赖');
    expect(overlay.edges?.['e2']?._migratedFrom).toBe('e1');
  });

  it('reconcileOverlay 边：真相边消失 → 孤儿暂存，不静默丢；二次 reconcile 不再追溯', () => {
    const old: DesignOverlay = {
      version: 1, feature: 'f', anchors: {},
      edges: { e1: { from: 'a', to: 'b', reason: '依赖理由' } },
    };
    let { overlay } = reconcileOverlay(old, [], []); // base 无该边
    expect(overlay.edges?.['e1']?.orphaned).toBe(true);
    expect(overlay.edges?.['e1']?.reason).toBe('依赖理由');
    // 再跑一轮（base 仍无）→ 上轮孤儿只保留不追溯
    ({ overlay } = reconcileOverlay(overlay, [], []));
    expect(overlay.edges?.['e1']?.orphaned).toBe(true);
    expect(overlay.edges?.['e1']?._migratedFrom).toBeUndefined();
  });

  it('buildEdgeCandidates：从 base.geometry.edges 提取边候选', () => {
    const cs = buildEdgeCandidates(edgeBase([
      { id: 'e1', from: 'a', to: 'b' }, { id: 'e2', from: 'b', to: 'c' },
    ]));
    expect(cs).toEqual([{ id: 'e1', from: 'a', to: 'b' }, { id: 'e2', from: 'b', to: 'c' }]);
  });

  it('applyOverlay 边：reason/boundary 写回 base edge.intent；孤儿边不写回', () => {
    const overlay: DesignOverlay = {
      version: 1, feature: 'f', anchors: {},
      edges: {
        e1: { from: 'a', to: 'b', reason: 'A 依赖 B', boundary: '链路边界' },
        e2: { from: 'x', to: 'y', reason: '叙事', orphaned: true },
      },
    };
    const merged = applyOverlay(edgeBase([{ id: 'e1', from: 'a', to: 'b' }]), overlay);
    expect(merged.geometry!.edges![0]?.intent?.reason).toBe('A 依赖 B');
    expect(merged.geometry!.edges![0]?.intent?.boundary).toBe('链路边界');
  });

  it('applyOverlay 目标：goals 写进 base meta.goals（供 LLM 读）', () => {
    const overlay: DesignOverlay = {
      version: 1, feature: 'f', anchors: {},
      global: { goals: [{ id: 'g1', title: '统一读端', status: 'active' }] },
    };
    const merged = applyOverlay(edgeBase([]), overlay);
    const meta = (merged as unknown as { meta?: { goals?: unknown[] } }).meta;
    expect(meta?.goals).toEqual([{ id: 'g1', title: '统一读端', status: 'active' }]);
  });

  it('seedOverlayFromDsl：捕获 base 的 edge.intent 与 meta.goals（回环不丢）', () => {
    const dsl: DesignDSL = {
      feature: 'f',
      geometry: { nodes: [], edges: [{ id: 'e1', from: 'a', to: 'b', intent: { reason: '既有理由' } }] },
    } as DesignDSL & { meta?: unknown };
    (dsl as { meta?: { goals?: unknown[] } }).meta = { goals: [{ id: 'g1', title: '老目标' }] };
    const ov = seedOverlayFromDsl(dsl);
    expect(ov.edges?.['e1']?.reason).toBe('既有理由');
    expect(ov.edges?.['e1']?.from).toBe('a');
    expect(ov.global?.goals?.[0]?.title).toBe('老目标');
  });

  it('决策 author/updated_at 经 seed→reconcile→apply 全程保留（① 时间线不丢）', () => {
    const node: Node = {
      id: 'file_a', label: 'a.ts', x: 0, y: 0, width: 100, height: 40, type: 'file', description: 'src/a.ts',
      decision: { summary: '决策', author: 'human', updated_at: '2026-01-01T00:00:00Z' },
      decision_history: [{ at: '2025-12-01T00:00:00Z', decision: { summary: '旧版', author: 'llm' }, author: 'human' }],
    };
    const seeded = seedOverlayFromDsl({ feature: 'f', geometry: { nodes: [node], edges: [] } });
    const { overlay } = reconcileOverlay(seeded, [{ id: 'file_a', path: 'src/a.ts', kind: 'file', signature: 'sig-v1' }]);
    expect(overlay.anchors['file_a']?.decision?.author).toBe('human');
    expect(overlay.anchors['file_a']?.decision?.updated_at).toBe('2026-01-01T00:00:00Z');
    expect(overlay.anchors['file_a']?.decision_history?.[0]?.author).toBe('human');
    const merged = applyOverlay({ feature: 'f', geometry: { nodes: [node], edges: [] } }, overlay);
    expect(merged.geometry.nodes[0]?.decision?.author).toBe('human');
    expect(merged.geometry.nodes[0]?.decision?.updated_at).toBe('2026-01-01T00:00:00Z');
  });
});