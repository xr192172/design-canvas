/**
 * memory_watch —— 内存自动托管（memory_observe 闭环：持续采样 → 阈值判定 → 主动提醒）
 *
 * 定位：常驻在 design-canvas daemon 里的看门狗。每 intervalMs 对外部目标 gen（带 --inspect 的
 * node 进程）做一次 `sampleRemote`（复用 memory_observe 的 CDP 采样），按阈值判定：
 *   - grow              ：RSS 相对启动基线增幅 ≥ rssDeltaMb → 内存快速增长
 *   - leak              ：heapUsed 连续 leakRuns 次单调上升且对比基线增超 leakDeltaMb → 疑似 JS 堆泄漏
 *   - suspicious-native ：RSS 涨但 heapUsed 平稳，external/arrayBuffers 侧涨 → 疑似 native 侧
 * 命中 → `pushAlert`（alert_inbox）：既是 daemon SSE `/api/events` 实况广播，又会搭"下一次任意
 * MCP 工具响应"自动附带 —— DSH gen 自己在下次调工具时看到自己内存超标提醒，即"系统自动托管自提醒"。
 *
 * 只提醒不动手（不杀进程/不强 GC/不重启），避免误判误伤。目标自动由 memory_targets 扫描所得（可覆盖新增 gen）。
 */
import { MemSample, sampleRemote, memoryTargetsHandler } from '../tools/memory_observe.js';
import { pushAlert } from '../tools/alert_inbox.js';

const MB = (b: number): number => Math.round(b / 1048576);

export interface MemoryWatchOpts {
  /** false=不启动（默认 true） */
  enabled?: boolean;
  /** 采样周期 ms（默认 60000） */
  intervalMs?: number;
  /** RSS 相对基线增幅超过此(MB)判 grow（默认 1024） */
  rssDeltaMb?: number;
  /** heapUsed 连续单调上升运行数判 leak（默认 3） */
  leakRuns?: number;
  /** leak 还需 heapUsed 对比基线增超此(MB)（默认 64） */
  leakDeltaMb?: number;
  /** 同 target 告警去抖 ms（默认 300000 = 5min） */
  minAlertGapMs?: number;
  /** 显式目标端口；缺省自动扫描 memory_targets */
  targets?: number[];
}

export type MemoryVerdict = 'ok' | 'grow' | 'leak' | 'suspicious-native';

export interface JudgeOpts {
  rssDeltaMb: number;
  leakRuns: number;
  leakDeltaMb: number;
}

/** 阈值判定（纯函数，便于单测）：series[0] 视为基线，配合后续采样序列判定位最大的一种。 */
export function judgeLeak(series: MemSample[], o: JudgeOpts): MemoryVerdict {
  if (series.length < 2) return 'ok';
  const base = series[0];
  const last = series[series.length - 1];
  const dRss = last.rss - base.rss;
  const dHeap = last.heapUsed - base.heapUsed;

  // leak：heapUsed 相对基线增超 leakDeltaMb，且最近若干采样单调上升
  if (dHeap > o.leakDeltaMb * 1048576 && series.length >= o.leakRuns) {
    let mono = true;
    const tail = series.slice(-o.leakRuns);
    for (let i = 1; i < tail.length; i++) {
      if (tail[i].heapUsed <= tail[i - 1].heapUsed) {
        mono = false;
        break;
      }
    }
    if (mono) return 'leak';
  }
  // grow：RSS 相对基线增幅超阈值
  if (dRss >= o.rssDeltaMb * 1048576) return 'grow';
  // suspicious-native：RSS 涨但 heapUsed 平稳，external/arrayBuffers 侧涨
  if (dRss > 64 * 1048576 && dHeap <= 16 * 1048576) {
    const dExt = last.external - base.external + (last.arrayBuffers - base.arrayBuffers);
    if (dExt > 16 * 1048576) return 'suspicious-native';
  }
  return 'ok';
}

const FORMAT = (v: MemoryVerdict): string =>
  v === 'grow'
    ? 'grow'
    : v === 'leak'
      ? 'leak'
      : v === 'suspicious-native'
        ? 'suspicious-native'
        : 'ok';

interface TargetState {
  baseline: MemSample | null;
  series: MemSample[];
  lastAlertAt: number;
}

/**
 * 启动内存看门狗。返回 stop 函数（清 setInterval）。daemon 调用后常驻；告警经 pushAlert 双通道触达。
 */
export async function startMemoryWatch(opts: MemoryWatchOpts = {}): Promise<() => void> {
  if (opts.enabled === false) return () => {};
  const intervalMs = opts.intervalMs ?? 60_000;
  const judge: JudgeOpts = {
    rssDeltaMb: opts.rssDeltaMb ?? 1024,
    leakRuns: opts.leakRuns ?? 3,
    leakDeltaMb: opts.leakDeltaMb ?? 64,
  };
  const minGapMs = opts.minAlertGapMs ?? 300_000;
  const fixedTargets = opts.targets ?? [];

  const byTarget = new Map<number, TargetState>();
  let seq = 0;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const resolveTargets = async (): Promise<number[]> => {
    if (fixedTargets.length > 0) return fixedTargets;
    try {
      const d = await memoryTargetsHandler();
      const rows = (d.data ?? []) as Array<{ port: string }>;
      return [...new Set(rows.map((r) => Number(r.port)).filter((n) => n > 0))];
    } catch {
      return [];
    }
  };

  const tick = async (): Promise<void> => {
    if (inFlight) return; // 上一轮未完成则跳过（防堆积/重叠）
    inFlight = true;
    try {
      const targets = await resolveTargets();
      for (const port of targets) {
        let st = byTarget.get(port);
        if (!st) {
          st = { baseline: null, series: [], lastAlertAt: 0 };
          byTarget.set(port, st);
        }
        let s: MemSample;
        try {
          s = await sampleRemote(port);
        } catch {
          continue; // 目标未就绪/已停：跳过，下一轮再看
        }
        st.series.push(s);
        if (st.series.length > judge.leakRuns) st.series.shift();
        if (!st.baseline) st.baseline = s;
        const verdict = judgeLeak([st.baseline, ...st.series], judge);
        if (verdict !== 'ok') {
          const now = Date.now();
          if (now - st.lastAlertAt >= minGapMs) {
            st.lastAlertAt = now;
            const baseRss = st.baseline?.rss ?? s.rss;
            pushAlert({
              project_dir: `gen@inspect-${port}`,
              seq: ++seq,
              line:
                `内存告警 [${FORMAT(verdict)}] target=端口 ${port} RSS=${MB(s.rss)}MB ` +
                `heapUsed=${MB(s.heapUsed)}MB（相对基线 RSS +${MB(s.rss - baseRss)}MB）。` +
                `可 memory_observe(target=${port},action=snapshot) 落堆快照定位泄漏持有者。`,
              created_at: new Date().toISOString(),
            });
          }
        }
      }
    } catch (e) {
      /* 单轮异常不致死看门狗 */
    } finally {
      inFlight = false;
    }
  };

  timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return () => {
    if (timer) clearInterval(timer);
    byTarget.clear();
  };
}