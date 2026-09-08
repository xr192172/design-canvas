/**
 * TS probe scope 测试：enterScope/exitScope 通过 AsyncLocalStorage 录出
 * 带 trace_id/frame_id/parent_id 的调用树事件（一次操作 → 可重建调用树）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setGlobalProbeSink, TSProbeCapture, loadTSEvents, enterScope, exitScope, type TSEvent } from '../../src/observe/probe';

let tmp: string;
let eventsPath: string;
let prevSink: TSProbeCapture | null;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tscope_'));
  eventsPath = path.join(tmp, 'events.jsonl');
  prevSink = setGlobalProbeSink(new TSProbeCapture(eventsPath));
});
afterEach(() => {
  setGlobalProbeSink(prevSink);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 把一条同步/async 调用链录成帧事件：order.Place(enter) → pay.Charge → inv.Reserve → 逐层 exit */
function runChain(): Promise<void> {
  return new Promise((resolve) => {
    enterScope('order.Place', { order_id: 42 });
    setTimeout(() => {
      enterScope('pay.Charge', { order_id: 42 });
      enterScope('inv.Reserve', { order_id: 42 });
      exitScope('inv.Reserve');
      exitScope('pay.Charge');
      exitScope('order.Place');
      resolve();
    }, 5); // 每次 async 跳转都靠 ALS 传播当前帧
  });
}

describe('TS probe scope - 录调用树', () => {
  it('async 调用链录出同 trace、帧递增、父子正确的 enter/exit 事件', async () => {
    await runChain();
    const { events } = loadTSEvents(eventsPath);
    const enter = events.filter((e) => e.probe.endsWith('.enter'));
    const exit = events.filter((e) => e.probe.endsWith('.exit'));
    expect(enter).toHaveLength(3);
    expect(exit).toHaveLength(3);

    // 同一次操作：全部 enter/exit 共享一个 trace_id
    const tids = new Set(events.map((e) => e.trace_id));
    expect(tids.size).toBe(1);
    const tid = [...tids][0];

    // 帧结构：Place=根(parent 0)，Charge 的父=Place，Reserve 的父=Charge
    const byProbe = (p: string): TSEvent => events.find((e) => e.probe === p)!;
    const placeE = byProbe('order.Place.enter');
    const chargeE = byProbe('pay.Charge.enter');
    const reserveE = byProbe('inv.Reserve.enter');
    expect(placeE.parent_id ?? 0).toBe(0);
    expect(chargeE.parent_id).toBe(placeE.frame_id);
    expect(reserveE.parent_id).toBe(chargeE.frame_id);
    expect(reserveE.trace_id).toBe(tid);

    // exit 带 dur_ms 且帧号与对应 enter 一致
    const chargeX = byProbe('pay.Charge.exit');
    expect(chargeX.frame_id).toBe(chargeE.frame_id);
    expect(typeof chargeX.fields?.dur_ms).toBe('number');
  }, 10000);

  it('未配置 sink → enterScope/exitScope 无副作用（no-op）', () => {
    setGlobalProbeSink(null);
    enterScope('x.F', { a: 1 });
    exitScope('x.F');
    expect(fs.existsSync(eventsPath)).toBe(false);
  }, 10000);
});

describe('TS probe - 有界容错序列化（大对象/循环/不可 JSON）', () => {
  it('循环引用对象落盘不抛错且值降级为 [Circular]', () => {
    const cap = new TSProbeCapture(eventsPath);
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    expect(() => cap.emit('x.F.enter', { arg: cyc }, 'v2-scope')).not.toThrow();
    const { events } = loadTSEvents(eventsPath);
    expect(events).toHaveLength(1);
    const arg = events[0].fields?.arg as Record<string, unknown>;
    expect(arg.a).toBe(1);
    expect(arg.self).toBe('[Circular]');
  });

  it('超大对象降级为概要（$type/$size/$keys），不整段落盘', () => {
    const cap = new TSProbeCapture(eventsPath);
    const big: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) big['key' + i] = 'x'.repeat(20);
    cap.emit('p.allPatches', big, 'v2-scope');
    const { events } = loadTSEvents(eventsPath);
    const f = events[0].fields as Record<string, unknown>;
    expect(f.$type).toBe('object');
    expect(f.$size).toBe(500);
    expect(Array.isArray(f.$keys)).toBe(true);
    // 不再整段展开
    expect(JSON.stringify(f).length).toBeLessThan(400);
  });

  it('函数/undefined/BigInt/Error 均安全落盘', () => {
    const cap = new TSProbeCapture(eventsPath);
    const withErr = new Error('boom');
    cap.emit('p.F', { fn: () => 1, und: undefined, bi: 9007199254740993n, err: withErr }, 'v2-scope');
    const { events } = loadTSEvents(eventsPath);
    const f = events[0].fields as Record<string, unknown>;
    expect(f.und).toBeUndefined();
    expect(f.bi).toBe('9007199254740993');
    expect((f.err as { name: string }).name).toBe('Error');
    expect((f.err as { message: string }).message).toBe('boom');
  });
});