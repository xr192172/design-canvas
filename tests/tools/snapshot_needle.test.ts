/**
 * snapshot_needle 测试：一整针(完整快照)采样——代表性命中的整针保留(含前因后果)、
 * 非代表性整针丢弃；支持注入自定义判定器。
 */
import { describe, it, expect } from 'vitest';
import type { RunTrace, RunTreeNode } from '../../src/tools/run_trace_replay';
import { sampleNeedles } from '../../src/tools/snapshot_needle';

function frame(probe: string, inV: unknown, outV: unknown, children: RunTreeNode[] = []): RunTreeNode {
  return { frame_id: 0, parent_id: 0, probe, in: inV, out: outV, dur_ms: 1, start_ms: 0, children };
}

function trace(id: string, root: RunTreeNode): RunTrace {
  return { trace_id: id, root, frames: 1 };
}

const KEEP_ARGS = '[[KEEP]]可复用补丁[[/KEEP]] 其余噪声忽略';

describe('snapshot_needle - 一整针采样', () => {
  it('命中 KEEP 的针 → 整针保留且完整（含前因后果），未命中针整针丢弃', () => {
    // 针1：conveyor 提取到 [[KEEP]] fact（代表性）
    const keepNeedle = trace('keep-1', frame('conveyor.toolResult', { }, { kept: 1 }, [
      frame('conveyor.extractKept', { text: KEEP_ARGS }, { facts: [{ text: '可复用补丁' }] }),
    ]));
    // 针2：普通 pass-through（非代表性）
    const plainNeedle = trace('plain-1', frame('proxy.forward', { body: 'hello' }, { status: 200 }));

    const { kept, dropped } = sampleNeedles([keepNeedle, plainNeedle]);
    expect(dropped).toBe(1);
    expect(kept).toHaveLength(1);
    const k = kept[0];
    expect(k.representative).toBe(true);
    expect(k.signals).toContain('kept-fact');
    // 整针完整：root 是整棵调用树，未裁掉 extractKept 子帧 —— 前因后果都在
    expect(k.root.probe).toBe('conveyor.toolResult');
    expect(k.root.children[0].probe).toBe('conveyor.extractKept');
    expect(k.root.children[0].in).toEqual({ text: KEEP_ARGS });
  });

  it('错误/异常信号 → 代表性并标注 signal-error', () => {
    const errNeedle = trace('err-1', frame('proxy.forward', { body: 'x' }, { status: 502, error: 'upstream timeout' }));
    const { kept, dropped } = sampleNeedles([errNeedle]);
    expect(dropped).toBe(0);
    expect(kept[0].signals).toContain('signal-error');
  });

  it('自定义判断器 → 用注入的规则决定整针去留', () => {
    const a = trace('a', frame('f', { x: 1 }, {}));
    const b = trace('b', frame('g', { x: 2 }, {}));
    const judge = (t: RunTrace) => ({ representative: t.root.in?.x === 2, signals: ['custom-hit'] });
    const { kept, dropped } = sampleNeedles([a, b], judge);
    expect(dropped).toBe(1);
    expect(kept).toHaveLength(1);
    expect(kept[0].trace_id).toBe('b');
    expect(kept[0].signals).toEqual(['custom-hit']);
  });

  it('零针 → kept 空 dropped 0', () => {
    const { kept, dropped } = sampleNeedles([]);
    expect(kept).toHaveLength(0);
    expect(dropped).toBe(0);
  });
});