/**
 * Observe 判定下沉服务测试：验证语言无关的判定服务（judge_service）语义，
 * 与 Go contract.go 权威判定逐条对齐（silent-error-discard）。
 *
 * 验证点：
 *   1. normalizeEvents 校验入参，丢弃非法事件、补全缺失 time/source。
 *   2. judgeEvents 逐条判定 + 汇总统计（total/ok/deviation）。
 *   3. 判定语义：writefile 非良性 err → deviation；cleanup+benign → ok。
 *   4. renderJudgeReport 输出人类可读报告（无偏差时单行 ✓）。
 */
import { describe, it, expect } from 'vitest';
import { normalizeEvents, judgeEvents, renderJudgeReport } from '../../src/observe/judge_service.js';
import type { TSEvent } from '../../src/observe/probe.js';

function ev(over: Partial<TSEvent> = {}): TSEvent {
  return { probe: 'save.writefile', time: '2026-08-14T00:00:00Z', source: 'llm-design', fields: {}, ...over };
}

describe('Observe 判定服务 · normalizeEvents', () => {
  it('非数组入参返回 error', () => {
    const r = normalizeEvents({ events: 'oops' });
    expect(r.error).toBeTruthy();
    expect(r.events).toHaveLength(0);
  });

  it('丢弃缺 probe/fields 的非法事件，补全缺失 time/source', () => {
    const r = normalizeEvents([
      { probe: 'a.enter', fields: { x: 1 } },
      { probe: 'b.enter', fields: { y: 2 }, time: '2026-01-01T00:00:00Z' },
      { foo: 'no probe' },
      42,
      null,
    ]);
    expect(r.error).toBeUndefined();
    expect(r.events).toHaveLength(2);
    // 缺 time/source 的被补全
    expect(typeof r.events[0].time).toBe('string');
    expect(r.events[0].source).toBe('llm-design');
    // 显式给定的保留
    expect(r.events[1].time).toBe('2026-01-01T00:00:00Z');
  });
});

describe('Observe 判定服务 · judgeEvents', () => {
  it('writefile 非良性 err → deviation，且汇总正确', () => {
    const r = judgeEvents([
      ev({ fields: { op: 'writefile', err: 'EISDIR: illegal operation' } }),
      ev({ fields: { op: 'writefile', err: '' } }),
      ev({ probe: 'cleanup.rm', fields: { op: 'cleanup', err: 'ENOENT', benign: true } }),
    ]);
    expect(r.total).toBe(3);
    expect(r.ok).toBe(2);
    expect(r.deviation).toBe(1);
    const dev = r.entries.find((e) => e.verdict.result === 'deviation');
    expect(dev?.verdict.rule).toBe('design:silent-error-discard');
    expect(dev?.verdict.reason).toContain('writefile');
  });

  it('空事件列表 → 全 0', () => {
    const r = judgeEvents([]);
    expect(r.total).toBe(0);
    expect(r.ok).toBe(0);
    expect(r.deviation).toBe(0);
  });
});

describe('Observe 判定服务 · renderJudgeReport', () => {
  it('无偏差输出单行 ✓', () => {
    const r = judgeEvents([ev({ fields: { op: 'writefile', err: '' } })]);
    const text = renderJudgeReport(r);
    expect(text).toContain('0 偏差');
    expect(text).toContain('✓');
  });

  it('有偏差列出明细', () => {
    const r = judgeEvents([ev({ fields: { op: 'writefile', err: 'boom' } })]);
    const text = renderJudgeReport(r);
    expect(text).toContain('1 偏差');
    expect(text).toContain('probe=save.writefile');
    expect(text).toContain('boom');
  });
});