/**
 * v2 分级采集 runtime 测试（对齐 go-camera/probe 测试集）。
 *
 * 覆盖 camera_v2 决策卡验收：
 *   c1 内存不变式：环预算固定，写入超预算后占用仍=预算（覆盖，不增长）
 *   c3 计数器：hit/err 按 probe 维度累计（.catch 计 err）
 *   c4 直方图：配对耗时入桶，P50/P99 单调
 *   c5 环形缓冲：溢出绕圈，快照 ≤ 预算
 *   c7 链路一致：嵌套 withScope 共享 trace id + parent frame 链
 *   c8 限流门：每探针每分钟超额即跳过并计数
 *   c6 开箱导出：catch 触发 incident 文件（头行 + 链路窗口）
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Tiered, setGlobalTiered, isCatchProbe } from '../../src/camera/tiered.js';
import { withScope, currentScope, currentTraceId } from '../../src/camera/trace.js';
import { ExportGate, splitEvents } from '../../src/camera/export_incident.js';
import { TSProbeCapture, type TSEvent } from '../../src/camera/probe.js';

function tmpDir(prefix = 'camera-v2-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function ev(probe: string, fields: Record<string, unknown> = {}): TSEvent {
  return { probe, time: new Date().toISOString(), source: 'v2-test', fields };
}

afterEach(() => {
  setGlobalTiered(null);
});

describe('c3/c5 计数器 + 环形缓冲', () => {
  it('hit/err 按 probe 累计，.catch 计 err（isCatchProbe）', () => {
    const t = new Tiered({ ringBudgetMB: 1 });
    t.emit(ev('save.write'));
    t.emit(ev('save.write'));
    t.emit(ev('save.write.catch'));
    const cs = t.countersSnapshot();
    expect(cs).toEqual([
      { probe: 'save.write', hit: 2, err: 0 },
      { probe: 'save.write.catch', hit: 1, err: 1 },
    ]);
    expect(isCatchProbe('save.write.catch')).toBe(true);
    expect(isCatchProbe('save.write.exit')).toBe(false);
  });

  it('c1 内存不变式：写入 3× 预算后占用恒=预算，旧数据被覆盖', () => {
    const t = new Tiered({ ringBudgetMB: 2 }); // 预算 2MB（2 段 × 1MB）
    const lineLen = JSON.stringify(ev('flood.big', { blob: 'x'.repeat(2000) })).length + 1;
    const budget = t.ringStats().budget_bytes;
    for (let i = 0; i < Math.ceil((budget * 3) / lineLen); i++) {
      t.emit(ev('flood.big', { blob: 'x'.repeat(2000), i }));
    }
    const st = t.ringStats();
    expect(st.budget_bytes).toBe(budget); // 预算不变
    expect(st.laps_overwritten).toBeGreaterThanOrEqual(1); // 已绕圈覆盖
    expect(st.written_bytes).toBeGreaterThan(budget); // 累计写入超预算
    const snap = t.ringSnapshot();
    expect(snap.length).toBeLessThanOrEqual(budget); // 占用 ≤ 预算（c1）
    // 覆盖边界残行自动丢弃，其余均可解析
    const events = splitEvents(snap);
    expect(events.length).toBeGreaterThan(100);
    for (const e of events) expect(e.probe).toBe('flood.big');
  });

  it('单事件超段大小被丢弃，不破坏环', () => {
    const t = new Tiered({ ringBudgetMB: 1 });
    const huge = 'y'.repeat(2 * 1024 * 1024); // 2MB > 1MB 段
    t.emit(ev('noisy.huge', { blob: huge }));
    expect(splitEvents(t.ringSnapshot()).length).toBe(0);
    t.emit(ev('ok.small'));
    expect(splitEvents(t.ringSnapshot()).length).toBe(1);
  });
});

describe('c7 trace 链路一致', () => {
  it('嵌套 withScope 共享 trace id，子帧 parent_id=父帧 frame_id', async () => {
    const dir = tmpDir();
    const t = new Tiered({ ringBudgetMB: 1, incidentDir: dir });
    setGlobalTiered(t); // 嵌套内层免传 tiered（对齐 Go Enter 的全局路由语义）
    const innerErr = new Error('inner boom');

    await withScope('svc.handle', { req: 'r1' }, async (outer) => {
      expect(currentScope()).toBe(outer); // ALS 绑定生效
      const outerTrace = currentTraceId();
      await withScope('svc.query', async (inner) => {
        expect(inner.traceId).toBe(outerTrace); // 同链路
        expect(inner.parentId).toBe(outer.frameId); // 父帧链
        inner.catch(innerErr); // 触发开箱
      });
    });

    const events = splitEvents(t.ringSnapshot());
    const enters = events.filter((e) => e.probe.endsWith('.enter'));
    expect(enters).toHaveLength(2);
    expect(new Set(enters.map((e) => e.trace_id)).size).toBe(1); // c7: trace id 唯一

    // exit 事件带 dur_ms
    const exits = events.filter((e) => e.probe.endsWith('.exit'));
    expect(exits.length).toBe(2);
    for (const e of exits) expect(typeof e.fields.dur_ms).toBe('number');
  });

  it('withScope 抛错：自动 catch（开箱导出）后原样上抛，exit 保证执行', async () => {
    const dir = tmpDir();
    const t = new Tiered({ ringBudgetMB: 1, incidentDir: dir });
    const boom = new Error('throw out');

    await expect(
      withScope('svc.bad', async (sp) => {
        void sp;
        throw boom;
      }, t),
    ).rejects.toThrow('throw out');

    const events = splitEvents(t.ringSnapshot());
    expect(events.some((e) => e.probe === 'svc.bad.catch')).toBe(true);
    expect(events.some((e) => e.probe === 'svc.bad.exit')).toBe(true);

    // c6: incident 文件已生成，头行含链路窗口
    const files = fs.readdirSync(dir).filter((n) => n.startsWith('incident-'));
    expect(files).toHaveLength(1);
    const lines = fs.readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n');
    const hdr = JSON.parse(lines[0]) as { type: string; trace_id: string; probe: string; err: string; chain: number };
    expect(hdr.type).toBe('incident');
    expect(hdr.probe).toBe('svc.bad');
    expect(hdr.err).toBe('throw out');
    expect(hdr.chain).toBeGreaterThanOrEqual(2); // 开箱发生在 catch 时：enter + catch（exit 尚未执行，与 Go 同语义）
    // 链路行 trace id 全一致
    const chain = lines.slice(1).map((l) => JSON.parse(l) as TSEvent);
    for (const c of chain) expect(c.trace_id).toBe(hdr.trace_id);
  });

  it('并行 async 链路互不串线（ALS 隔离）', async () => {
    const t = new Tiered({ ringBudgetMB: 1 });
    const run = (name: string, ms: number) =>
      withScope(name, async () => {
        await new Promise((r) => setTimeout(r, ms));
        return currentTraceId();
      }, t);
    const [a, b] = await Promise.all([run('svc.a', 5), run('svc.b', 15)]);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b); // 两条独立根链路
  });
});

describe('c4 直方图', () => {
  it('配对耗时入桶，P99 ≥ P50，count 与作用域数一致', async () => {
    const t = new Tiered({ ringBudgetMB: 1 });
    for (let i = 0; i < 5; i++) {
      await withScope('svc.timed', async () => {
        await new Promise((r) => setTimeout(r, 1));
      }, t);
    }
    const hs = t.histogramsSnapshot();
    expect(hs).toHaveLength(1);
    expect(hs[0].probe).toBe('svc.timed');
    expect(hs[0].count).toBe(5);
    expect(hs[0].p99_us).toBeGreaterThanOrEqual(hs[0].p50_us);
    expect(hs[0].p50_us).toBeGreaterThan(0);
  });
});

describe('c8 导出限流门', () => {
  it('每探针每分钟超额即跳过并计数', () => {
    const g = new ExportGate(2);
    const t0 = 1_000_000;
    expect(g.allow('p', t0)).toBe(true);
    expect(g.allow('p', t0 + 1000)).toBe(true);
    expect(g.allow('p', t0 + 2000)).toBe(false); // 超额
    expect(g.skipped()['p']).toBe(1);
    expect(g.allow('q', t0 + 3000)).toBe(true); // 其他探针不受影响
    // 窗口滑动：最早的过期后恢复名额
    expect(g.allow('p', t0 + 61_000)).toBe(true);
    expect(g.skipped()['p']).toBe(1);
  });

  it('quota ≤ 0 关闭导出', () => {
    const g = new ExportGate(0);
    expect(g.allow('p')).toBe(false);
  });

  it('catch 风暴下 incident 文件数 ≤ 限额', async () => {
    const dir = tmpDir('camera-storm-');
    const t = new Tiered({ ringBudgetMB: 1, incidentDir: dir, exportPerMin: 2 });
    for (let i = 0; i < 5; i++) {
      // 同一探针名连续 5 次 catch：c8 按探针限流，只导出前 2 次
      withScope('svc.storm', (sp) => {
        sp.catch(new Error(`e${i}`));
      }, t);
    }
    const files = fs.readdirSync(dir).filter((n) => n.startsWith('incident-'));
    expect(files).toHaveLength(2); // 限额 2，其余被 c8 跳过
    expect(t.gate.skipped()['svc.storm']).toBe(3);
  });
});

describe('全量镜像 + 全局路由', () => {
  it('fullSink 镜像每事件，setGlobalTiered 后 enterScope 免传 tiered', async () => {
    const dir = tmpDir('camera-mirror-');
    const cap = new TSProbeCapture(path.join(dir, 'events.jsonl'));
    const t = new Tiered({ ringBudgetMB: 1, fullSink: cap });
    setGlobalTiered(t); // 全局路由
    try {
      await withScope('svc.global', async () => undefined); // 不传 t，走全局
    } finally {
      setGlobalTiered(null);
    }
    const { events } = { events: splitEvents(t.ringSnapshot()) };
    expect(events.filter((e) => e.probe.startsWith('svc.global')).length).toBe(2);
    const mirrored = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
    expect(mirrored).toContain('svc.global.enter');
    expect(mirrored).toContain('svc.global.exit');
  });
});
