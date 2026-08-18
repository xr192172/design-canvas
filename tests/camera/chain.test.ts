/**
 * P2 链路重建与链路契约判定测试（TS 侧，对齐 go-camera/probe/chain_test.go 语义）
 *
 * 覆盖：
 *   - rebuildChains：trace 分组 / 帧聚合 / scope 后缀剥离 / 时间排序 / anon 补尾 / 预算封顶
 *   - isSubsequence / subsequencePrefixLen：子序列语义（允许中间插帧）
 *   - matchChainDecl：satisfied / 最接近链 / 根探针无关链跳过
 *   - TSComparator.compare 链路段：chain-broken（trace_id+window+断裂点）/
 *     satisfied 零偏差 / 根探针从未观测（unobserved）
 *   - normalizeEvents 保留 v2 trace 字段（camera_judge 链路判定的数据通路）
 */

import { describe, it, expect } from 'vitest';
import {
  rebuildChains,
  isSubsequence,
  subsequencePrefixLen,
  matchChainDecl,
  baseProbeName,
  type TSChainObs,
} from '../../src/camera/chain';
import { TSComparator, type TSDesignDSLDoc } from '../../src/camera/contract';
import { normalizeEvents } from '../../src/camera/judge_service';
import type { TSEvent } from '../../src/camera/probe';

function ev(probe: string, time: string, traceId?: string, frameId?: number, err?: string): TSEvent {
  return {
    probe,
    time,
    source: 'v2-scope',
    fields: err ? { err } : {},
    trace_id: traceId,
    frame_id: frameId,
  };
}

describe('baseProbeName', () => {
  it('剥离 scope 后缀', () => {
    expect(baseProbeName('svc.Handle.enter')).toBe('svc.Handle');
    expect(baseProbeName('svc.Handle.exit')).toBe('svc.Handle');
    expect(baseProbeName('svc.Handle.catch')).toBe('svc.Handle');
    expect(baseProbeName('plain.probe')).toBe('plain.probe');
  });
});

describe('rebuildChains', () => {
  it('按 trace 分组，帧聚合同一 frame_id，scope 后缀聚合到同一帧', () => {
    const events = [
      ev('a.Run.enter', '2026-08-18T10:00:00.000Z', 't1', 1),
      ev('a.Run.exit', '2026-08-18T10:00:05.000Z', 't1', 1),
      ev('b.Step.enter', '2026-08-18T10:00:01.000Z', 't1', 2),
      ev('b.Step.exit', '2026-08-18T10:00:02.000Z', 't1', 2),
    ];
    const { chains, dropped } = rebuildChains(events);
    expect(dropped).toBe(0);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.trace_id).toBe('t1');
    // 帧按起始时间排序：a.Run（10:00:00）→ b.Step（10:00:01）
    expect(chains[0]!.sequence).toEqual(['a.Run', 'b.Step']);
    expect(chains[0]!.events).toBe(4);
  });

  it('多条 trace 各自成链，v1 事件（无 trace_id）不参与', () => {
    const events = [
      ev('a.enter', '2026-08-18T10:00:00.000Z', 't1', 1),
      ev('b.enter', '2026-08-18T11:00:00.000Z', 't2', 10),
      ev('x.legacy', '2026-08-18T12:00:00.000Z'), // v1：无 trace
    ];
    const { chains } = rebuildChains(events);
    expect(chains).toHaveLength(2);
    expect(chains.map((c) => c.trace_id).sort()).toEqual(['t1', 't2']);
  });

  it('有 trace 无 frame 的事件按原序补进序列尾（v1 式手动传 trace）', () => {
    const events = [
      ev('a.Run', '2026-08-18T10:00:00.000Z', 't1', 1),
      ev('legacy.point', '2026-08-18T10:00:03.000Z', 't1'), // 无 frame_id
    ];
    const { chains } = rebuildChains(events);
    expect(chains[0]!.sequence).toEqual(['a.Run', 'legacy.point']);
  });

  it('链上 err 计数进画像', () => {
    const events = [
      ev('a.enter', '2026-08-18T10:00:00.000Z', 't1', 1),
      ev('a.exit', '2026-08-18T10:00:01.000Z', 't1', 1, 'boom'),
      ev('b.enter', '2026-08-18T10:00:02.000Z', 't1', 2, 'again'),
    ];
    const { chains } = rebuildChains(events);
    expect(chains[0]!.errs).toBe(2);
  });

  it('超预算链被丢弃并计数', () => {
    const events: TSEvent[] = [];
    for (let i = 0; i < 520; i++) {
      events.push(ev(`p${i}.enter`, '2026-08-18T10:00:00.000Z', `t${i}`, i + 1));
    }
    const { chains, dropped } = rebuildChains(events);
    expect(chains.length).toBeLessThanOrEqual(512);
    expect(dropped).toBe(520 - chains.length);
  });
});

describe('subsequence 语义', () => {
  it('isSubsequence：按序出现，允许中间插帧', () => {
    expect(isSubsequence(['a', 'c'], ['a', 'x', 'b', 'c'])).toBe(true);
    expect(isSubsequence(['a', 'c'], ['c', 'a'])).toBe(false);
    expect(isSubsequence(['a'], [])).toBe(false);
    expect(isSubsequence([], [])).toBe(true);
  });

  it('subsequencePrefixLen：最长可匹配前缀', () => {
    expect(subsequencePrefixLen(['a', 'b', 'c'], ['a', 'x', 'b', 'y'])).toBe(2);
    expect(subsequencePrefixLen(['a', 'b'], ['b', 'a'])).toBe(1); // 只匹配到 a
  });
});

describe('matchChainDecl', () => {
  const chains: TSChainObs[] = [
    { trace_id: 't1', sequence: ['svc.Handle', 'db.Query', 'cache.Set'], events: 6 },
    { trace_id: 't2', sequence: ['web.Req', 'svc.Handle', 'db.Query'], events: 6 },
  ];

  it('存在满足子序列的链 → satisfied', () => {
    const r = matchChainDecl(['svc.Handle', 'cache.Set'], chains);
    expect(r.satisfied).toBe(true);
    expect(r.best!.chain.trace_id).toBe('t1');
  });

  it('不满足时返回最接近的链（前缀匹配最长）', () => {
    const r = matchChainDecl(['svc.Handle', 'mq.Publish'], chains);
    expect(r.satisfied).toBe(false);
    expect(r.best!.matched).toBe(1);
    expect(r.best!.ok).toBe(false);
  });

  it('根探针未出现在任何链 → best 为 null（契约与链无关）', () => {
    const r = matchChainDecl(['nope.Root', 'x'], chains);
    expect(r.satisfied).toBe(false);
    expect(r.best).toBeNull();
  });
});

describe('TSComparator.compare 链路契约段', () => {
  const comp = new TSComparator().registerDefaultPredicates();

  function design(chain: string[]): TSDesignDSLDoc {
    return { version: 1, updated_at: 'now', decls: [{ rule: 'chain:main-flow', chain }] };
  }

  it('声明序是实测链子序列 → 零偏差（未声明的中间帧不算）', () => {
    const chains = rebuildChains([
      ev('a.Run.enter', '2026-08-18T10:00:00.000Z', 't1', 1),
      ev('b.Mid.enter', '2026-08-18T10:00:01.000Z', 't1', 2),
      ev('c.End.enter', '2026-08-18T10:00:02.000Z', 't1', 3),
    ]).chains;
    const r = comp.compare(design(['a.Run', 'c.End']), [], chains);
    expect(r.chain_broken).toBe(0);
    expect(r.deviations).toHaveLength(0);
  });

  it('声明的调用序断裂 → chain-broken 带 trace_id/window/断裂点', () => {
    const chains = rebuildChains([
      ev('a.Run.enter', '2026-08-18T10:00:00.000Z', 't1', 1),
      ev('c.End.enter', '2026-08-18T10:00:01.000Z', 't1', 2), // 缺 b.Mid
    ]).chains;
    const r = comp.compare(design(['a.Run', 'b.Mid', 'c.End']), [], chains);
    expect(r.chain_broken).toBe(1);
    const d = r.deviations[0]!;
    expect(d.kind).toBe('chain-broken');
    expect(d.trace_id).toBe('t1');
    expect(d.window).toEqual(['a.Run', 'c.End']);
    expect(d.detail).toContain('b.Mid');
    expect(d.detail).toContain('1/3');
  });

  it('根探针从未在任何链上观测 → unobserved', () => {
    const chains = rebuildChains([
      ev('a.Run.enter', '2026-08-18T10:00:00.000Z', 't1', 1),
    ]).chains;
    const r = comp.compare(design(['ghost.Root', 'x.Step']), [], chains);
    expect(r.chain_broken).toBe(0);
    expect(r.unobserved).toBe(1);
    expect(r.deviations[0]!.detail).toContain('根探针');
  });

  it('乱序（声明序倒转）→ chain-broken，前缀只匹配 1', () => {
    const chains = rebuildChains([
      ev('a.Run.enter', '2026-08-18T10:00:00.000Z', 't1', 1),
      ev('b.Mid.enter', '2026-08-18T10:00:01.000Z', 't1', 2),
      ev('c.End.enter', '2026-08-18T10:00:02.000Z', 't1', 3),
    ]).chains;
    const r = comp.compare(design(['a.Run', 'c.End', 'b.Mid']), [], chains);
    expect(r.chain_broken).toBe(1);
    expect(r.deviations[0]!.detail).toContain('2/3');
  });
});

describe('normalizeEvents 保留 v2 trace 字段', () => {
  it('trace_id/frame_id 原样透传（camera_judge 链路判定的数据通路）', () => {
    const { events } = normalizeEvents([
      { probe: 'a.Run.enter', time: '2026-08-18T10:00:00Z', fields: {}, trace_id: 't9', frame_id: 7 },
      { probe: 'b.legacy', fields: {} }, // v1 无 trace 字段
    ]);
    expect(events[0]!.trace_id).toBe('t9');
    expect(events[0]!.frame_id).toBe(7);
    expect(events[1]!.trace_id).toBeUndefined();
  });
});
