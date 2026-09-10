/**
 * memory_watch —— judgeLeak 阈值判定（四态） + startMemoryWatch 命中/防抖。
 * CDP 采样与 alert 推送均用 vi.mock 隔离，不真连进程。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/tools/memory_observe.js', () => ({
  sampleRemote: vi.fn(),
  memoryTargetsHandler: vi.fn(),
}));
vi.mock('../../src/tools/alert_inbox.js', async (orig) => {
  const m = (await orig()) as Record<string, unknown>;
  return { ...m, pushAlert: vi.fn() };
});

import { judgeLeak, startMemoryWatch } from '../../src/daemon/memory_watch.js';
import { sampleRemote, memoryTargetsHandler } from '../../src/tools/memory_observe.js';
import { pushAlert } from '../../src/tools/alert_inbox.js';
import type { MemSample } from '../../src/tools/memory_observe.js';

const MB = 1048576;
const mk = (rssMB: number, heapMB: number, extMB = 0): MemSample => ({
  t: Date.now(),
  rss: rssMB * MB,
  heapUsed: heapMB * MB,
  heapTotal: heapMB * MB,
  external: extMB * MB,
  arrayBuffers: 0,
  usedHeap: heapMB * MB,
  heapLimit: 0,
  canGc: false,
});

describe('judgeLeak 四态判定', () => {
  const J = { rssDeltaMb: 1024, leakRuns: 3, leakDeltaMb: 64 };

  it('ok：相对基线基本平稳', () => {
    const series = [mk(100, 20), mk(102, 22)];
    expect(judgeLeak(series, J)).toBe('ok');
  });

  it('grow：RSS 增幅超阈值', () => {
    const series = [mk(100, 20, 5), mk(1500, 40, 8)];
    expect(judgeLeak(series, J)).toBe('grow');
  });

  it('leak：heapUsed 连续单调上升且相对基线增超阈值', () => {
    const series = [mk(300, 100), mk(300, 150), mk(300, 200), mk(300, 260)];
    expect(judgeLeak(series, J)).toBe('leak');
  });

  it('suspicious-native：RSS 涨但 heapUsed 平稳、external 侧涨', () => {
    // 把 grow 阈值抬高到 2048MB，使 RSS 增幅(1100MB)不判 grow，从而命中 suspicious-native
    const series = [mk(500, 80, 10), mk(1600, 90, 500)];
    expect(judgeLeak(series, { rssDeltaMb: 2048, leakRuns: 3, leakDeltaMb: 64 })).toBe('suspicious-native');
  });
});

describe('startMemoryWatch 命中 + 防抖', () => {
  let stop: () => void;

  beforeEach(() => {
    vi.mocked(pushAlert).mockClear();
  });

  afterEach(async () => {
    stop?.();
    vi.mocked(sampleRemote).mockReset();
    vi.mocked(memoryTargetsHandler).mockReset();
  });

  it('RSS 快速上升 → pushAlert 命中；防抖窗口内不重复', async () => {
    let rss = 100;
    vi.mocked(sampleRemote).mockImplementation(async () => mk((rss += 100), 20));
    stop = await startMemoryWatch({
      intervalMs: 30,
      rssDeltaMb: 64,
      leakRuns: 3,
      leakDeltaMb: 64,
      minAlertGapMs: 60000, // 长防抖
      targets: [39999],
    });
    await new Promise((r) => setTimeout(r, 200)); // ≈6+ ticks（含首轮立即 tick）
    expect(vi.mocked(pushAlert)).toHaveBeenCalledTimes(1); // 只第一次命中后压箱，防抖窗口内不重复
    const arg = vi.mocked(pushAlert).mock.calls[0][0];
    expect(arg.line).toContain('内存告警');
    expect(arg.line).toContain('39999');
  });
});