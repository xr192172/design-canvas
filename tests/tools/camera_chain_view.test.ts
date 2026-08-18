/**
 * camera_chain_view —— 链路契约偏差可视化测试
 *
 * 聚焦 HTML 结构断言：概览统计、链块状态徽章（满足/链断裂/根未观测）、
 * 声明序 vs 最近实测子序列语义（未声明中间帧灰色块）、trace_id 注入、HTML 转义。
 */
import { describe, it, expect } from 'vitest';
import { buildChainViewHtml } from '../../src/tools/camera_chain_view';
import type { TSDLDecl, TSDeviation, TSDiffReport } from '../../src/camera/contract';
import type { TSChainObs } from '../../src/camera/chain';

function declsOf(...decs: TSDLDecl[]): TSDLDecl[] { return decs; }

function chain(trace: string, seq: string[]): TSChainObs {
  return { trace_id: trace, sequence: seq, events: seq.length, errs: 0 };
}

function dev(kind: TSDeviation['kind'], partial: Partial<TSDeviation>): TSDeviation {
  return { kind, detail: 'd', ...partial } as TSDeviation;
}

function diff(devs: TSDeviation[]): TSDiffReport {
  return {
    generated_at: '2026-08-18T12:00:00Z',
    event_count: 42,
    deviations: devs,
    unobserved: devs.filter((d) => d.kind === 'unobserved').length,
    violated: 0,
    undesigned: 0,
    chain_broken: devs.filter((d) => d.kind === 'chain-broken').length,
  };
}

describe('buildChainViewHtml', () => {
  it('满足态：声明序是实测链子序列 → 徽章满足、无 trace 警告', () => {
    const decls = declsOf({ rule: 'chain:ok', chain: ['a.Run', 'b.Mid', 'c.End'] });
    const chains = [chain('t1', ['a.Run', 'x.extra', 'b.Mid', 'c.End'])];
    const html = buildChainViewHtml({ title: '满足', decls, chains, diff: diff([]) });

    expect(html).toContain('满足');
    expect(html).toContain('class="cbadge b-ok">满足');
    expect(html).toContain('chain:ok');
    // 声明序三格全为 declared
    expect(html).toContain('class="cnode declared" title="a.Run"');
    // 未声明中间帧 x.extra 为灰色虚线块（子序列语义：被允许，不算偏差）
    expect(html).toContain('class="cnode inter" title="x.extra"');
    // 统计：链断裂 0
    expect(html).toContain('<b>0</b><span>链断裂</span>');
  });

  it('链断裂：缺中间声明帧 → 徽章链断裂 + trace_id 注入', () => {
    const decls = declsOf({ rule: 'chain:broken', chain: ['a.Run', 'b.Mid', 'c.End'] });
    const chains = [chain('t-bad', ['a.Run', 'c.End'])];
    const html = buildChainViewHtml({
      title: '断裂',
      decls,
      chains,
      diff: diff([
        dev('chain-broken', {
          rule: 'chain:broken', probe: 'a.Run', trace_id: 't-bad',
          window: ['a.Run', 'c.End'],
          detail: '链路断裂：声明序 [a.Run → b.Mid → c.End] 未被满足',
        }),
      ]),
    });

    expect(html).toContain('class="cbadge b-broken">链断裂');
    expect(html).toContain('trace=t-bad');
    expect(html).toContain('<b>1</b><span>链断裂</span>');
    expect(html).toContain('链路断裂');
  });

  it('根未观测：根探针不在任何实测链 → 徽章根未观测', () => {
    const decls = declsOf({ rule: 'chain:ghost', chain: ['ghost.Root', 'x.Step'] });
    const chains = [chain('t1', ['other.a'])];
    const html = buildChainViewHtml({
      title: '未观测',
      decls,
      chains,
      diff: diff([dev('unobserved', { probe: 'ghost.Root', detail: '根探针从未被观测到' })]),
    });

    expect(html).toContain('class="cbadge b-unobs">根未观测');
    expect(html).toContain('<b>1</b><span>根未观测</span>');
  });

  it('HTML 转义：声明/细节含 <> 引号不破坏结构', () => {
    const decls = declsOf({ rule: 'chain:x<y>"', chain: ['a<b', 'c>d'] });
    const html = buildChainViewHtml({ title: '逃', decls, chains: [chain('t1', ['a<b'])], diff: diff([]) });
    // 转义后 title 属性值应为实体；不应出现未经转义的属性注入（title="a<b）——否则引号/尖括号会破坏标签
    expect(html).toContain('title="a&lt;b"');
    expect(html).toContain('>a&lt;b</span>');
    expect(html).not.toContain('title="a<b');
    expect(html).toContain('chain:x&lt;y&gt;');
  });

  it('无含 chain 声明 → 提示空态', () => {
    const html = buildChainViewHtml({
      decls: declsOf({ rule: 'no-chain', probe: 'x' }),
      chains: [],
      diff: diff([]),
    });
    expect(html).toContain('未提供含 chain 的 DSL 声明');
  });
});