/**
 * run_trace_replay 测试：用真实 observev2-record 产出的帧数据重建调用树。
 * fixture 为一次性录制（order.Place → pay.Charge → inv.Reserve，3 层）。
 */
import { describe, it, expect } from 'vitest';
import { parseRunTraces } from '../../src/tools/run_trace_replay';

const RUNS = [
  '{"probe":"order.Place.enter","trace_id":"20961189ba5d9338","frame_id":1,"fields":{"order_id":42}}',
  '{"probe":"pay.Charge.enter","trace_id":"20961189ba5d9338","frame_id":2,"parent_id":1,"fields":{"order_id":42}}',
  '{"probe":"inv.Reserve.enter","trace_id":"20961189ba5d9338","frame_id":3,"parent_id":2,"fields":{"order_id":42}}',
  '{"probe":"inv.Reserve.exit","trace_id":"20961189ba5d9338","frame_id":3,"parent_id":2,"fields":{"dur_ms":0}}',
  '{"probe":"pay.Charge.exit","trace_id":"20961189ba5d9338","frame_id":2,"parent_id":1,"fields":{"dur_ms":0}}',
  '{"probe":"order.Place.exit","trace_id":"20961189ba5d9338","frame_id":1,"fields":{"dur_ms":7.375}}',
].join('\n');

describe('run_trace_replay - 重建调用树', () => {
  it('把一次操作的 enter/exit 帧重建为 3 层父子调用树', () => {
    const traces = parseRunTraces(RUNS);
    expect(traces).toHaveLength(1);
    const t = traces[0];
    expect(t.trace_id).toBe('20961189ba5d9338');
    expect(t.frames).toBe(3);
    expect(t.root.probe).toBe('order.Place');
    expect(t.root.dur_ms).toBeCloseTo(7.375, 3);
    expect(t.root.in).toEqual({ order_id: 42 });
    const pay = t.root.children[0];
    expect(pay.probe).toBe('pay.Charge');
    expect(pay.children).toHaveLength(1);
    expect(pay.children[0].probe).toBe('inv.Reserve');
    // 各帧都有 enter 的入参与 exit 的耗时，无缺帧标注
    expect(t.root.missingIn).toBeFalsy();
    expect(t.root.missingOut).toBeFalsy();
  });

  it('同一 trace 出现两条完整链 → 各自独立成树', () => {
    const second = RUNS.replace(/20961189ba5d9338/g, 'aaaa000000000000');
    const traces = parseRunTraces(RUNS + '\n' + second);
    expect(traces).toHaveLength(2);
  });

  it('只有 enter 无 exit 的帧 → 诚实标 missingOut', () => {
    const traces = parseRunTraces(
      '{"probe":"a.F.enter","trace_id":"t1","frame_id":1,"fields":{"x":1}}\n{"probe":"a.F.enter","trace_id":"t1","frame_id":2,"parent_id":1,"fields":{"x":2}}',
    );
    expect(traces).toHaveLength(1);
    expect(traces[0].root.missingOut).toBe(true);
  });
});