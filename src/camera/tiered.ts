/**
 * Camera v2 分级采集 runtime · TypeScript 端口
 *
 * 对齐 go-camera/probe/tiered.go（camera_v2 决策卡 c1/c3/c4/c5 落地）。
 *
 * c1 内存不变式（铁律）：任何事件留存层，跑 1 秒与跑 1 年占用必须相同（常数）。
 *   - 计数器：O(探针数)
 *   - 直方图：O(探针数)（每探针 20 个固定桶）
 *   - 环形缓冲：O(固定预算)（默认 64MB，溢出=旧事件被覆盖，构造性有界）
 *   - 导出：错误触发才落盘（export_incident.ts），每探针限速，目录封顶
 *
 * 单线程 JS 事件循环内无需锁（与 Go 侧原子操作语义对齐：Node 单线程下
 * Map 读写天然串行；跨 worker 场景各自持有独立 Tiered 实例）。
 */

import type { TSEvent } from './probe.js';
import { ExportGate, DEFAULT_EXPORT_PER_MIN } from './export_incident.js';

// ─────────────────────────────────────────────────────────────
// c3 计数器：每探针 hit/err
// ─────────────────────────────────────────────────────────────

export interface CountersSnapshot {
  probe: string;
  hit: number;
  err: number;
}

// ─────────────────────────────────────────────────────────────
// c4 直方图：每探针 20 个固定桶（对数刻度）
// ─────────────────────────────────────────────────────────────

const HIST_BUCKETS = 20;

/**
 * 桶边界：bucket i 覆盖 [2^i, 2^(i+1)) 微秒，i=0..18；
 * bucket 19 兜底 ≥ 2^19µs（≥524ms）。与 Go 侧一致。
 */
class Histogram {
  private readonly buckets = new Array<number>(HIST_BUCKETS).fill(0);

  /** 记一次耗时（µs 精度，<1µs 记 1µs）。 */
  record(dMs: number): void {
    let us = Math.round(dMs * 1000);
    if (us < 1) us = 1;
    // floor(log2(us))：us ≤ 2^32 用 clz32 精确计算，超界兜底桶
    let idx = us > 0xffffffff ? 32 : 31 - Math.clz32(us >>> 0);
    if (idx >= HIST_BUCKETS) idx = HIST_BUCKETS - 1;
    this.buckets[idx]++;
  }

  /** 近似分位值（桶内线性内插），count=0 返回 0。单位 µs。 */
  percentile(p: number): number {
    let total = 0;
    for (const c of this.buckets) total += c;
    if (total === 0) return 0;
    let target = Math.round(total * p);
    if (target < 1) target = 1;
    let cum = 0;
    for (let i = 0; i < HIST_BUCKETS; i++) {
      const c = this.buckets[i];
      cum += c;
      if (cum >= target) {
        const lo = 1 << i; // 桶下界 µs
        const hi = 2 << i; // 桶上界 µs
        const frac = (target - (cum - c)) / Math.max(c, 1);
        return Math.round(lo + frac * (hi - lo));
      }
    }
    return 0;
  }

  snapshot(probe: string): HistogramSnapshot {
    let count = 0;
    let maxUs = 0;
    for (let i = 0; i < HIST_BUCKETS; i++) {
      const c = this.buckets[i];
      count += c;
      if (c > 0) maxUs = 2 << i; // 最高非零桶的上界
    }
    return {
      probe,
      count,
      p50_us: this.percentile(0.5),
      p99_us: this.percentile(0.99),
      max_us: maxUs,
    };
  }
}

export interface HistogramSnapshot {
  probe: string;
  count: number;
  p50_us: number;
  p99_us: number;
  max_us: number; // 非零的最高桶上界
}

// ─────────────────────────────────────────────────────────────
// c5 环形缓冲：预分配分段字节环，滚动覆盖
// ─────────────────────────────────────────────────────────────

/**
 * 预分配 n 段 × segSize 字节（Node Buffer）。事件序列化后拷入，放不下当前段
 * 剩余空间就整段推进到下一段（段尾浪费 ≤ 单事件大小，不做跨段拼接）。
 * 占用恒等于预算值；溢出 = 最旧事件被覆盖，数学上不可能爆。
 */
class RingBuf {
  private readonly segs: Buffer[];
  private readonly segSize: number;
  private writeSeg = 0;
  private off = 0;
  private wrapped = false;
  private written = 0;
  private laps = 0;

  constructor(budgetBytes: number, segSize = 1 << 20) {
    if (segSize <= 0) segSize = 1 << 20; // 1MB
    let n = Math.max(1, Math.floor(budgetBytes / segSize));
    this.segs = Array.from({ length: n }, () => Buffer.alloc(segSize));
    this.segSize = segSize;
  }

  /** 拷入一行 JSONL（含结尾换行）。单事件超段大小：丢弃（防异常巨事件破坏环）。 */
  write(data: Buffer): void {
    if (data.length > this.segSize) return;
    if (this.off + data.length > this.segSize) {
      this.writeSeg = (this.writeSeg + 1) % this.segs.length;
      if (this.writeSeg === 0) {
        this.wrapped = true;
        this.laps++;
      }
      this.off = 0;
    }
    data.copy(this.segs[this.writeSeg], this.off);
    this.off += data.length;
    this.written += data.length;
  }

  /**
   * 按时间顺序（旧→新）取出一整圈有效字节。
   * 首块可能从旧数据的半行开始（上一圈段尾残留），调用方需跳过首个换行符前
   * 的残包字节（splitEvents 自动丢弃解析失败的行）。
   */
  snapshot(): Buffer {
    const n = this.segs.length;
    const parts: Buffer[] = [];
    if (!this.wrapped) {
      for (let i = 0; i <= this.writeSeg; i++) {
        const end = i === this.writeSeg ? this.off : this.segSize;
        parts.push(this.segs[i].subarray(0, end));
      }
      return Buffer.concat(parts);
    }
    for (let k = 0; k < n; k++) {
      const i = (this.writeSeg + k) % n;
      const end = k === n - 1 ? this.off : this.segSize;
      parts.push(this.segs[i].subarray(0, end));
    }
    return Buffer.concat(parts);
  }

  stats(): RingStats {
    return {
      budget_bytes: this.segs.length * this.segSize,
      written_bytes: this.written,
      laps_overwritten: this.laps,
    };
  }
}

export interface RingStats {
  budget_bytes: number;
  written_bytes: number;
  laps_overwritten: number;
}

// ─────────────────────────────────────────────────────────────
// Tiered：v2 分级采集 sink（组合 c3/c4/c5；c6/c8 见 export_incident.ts）
// ─────────────────────────────────────────────────────────────

/** 决策卡 c5：64MB 固定预算。 */
export const DEFAULT_RING_BUDGET_MB = 64;
export const DEFAULT_RING_SEG_SIZE = 1 << 20;

/** 全量镜像 sink 的最小接口（TSProbeCapture 天然满足）。 */
export interface FullSink {
  emit(probe: string, fields: Record<string, unknown>, source?: string): TSEvent;
}

export interface TieredOptions {
  /** 环形缓冲预算（MB，≥1）。默认 64。 */
  ringBudgetMB?: number;
  /** 可选全量镜像（JSONL 落盘，conformance/调试用）。生产默认不挂：平时零磁盘。 */
  fullSink?: FullSink;
  /** 错误开箱导出目录（空=不导出，c6 关闭）。 */
  incidentDir?: string;
  /** 每探针每分钟导出限额（c8，默认 10；≤0 关闭导出）。 */
  exportPerMin?: number;
}

/**
 * v2 分级采集 runtime。所有留存层 O(探针数) 或 O(固定预算)，
 * 满足 c1 铁律：任意压力下内存占用恒等于预算值。
 */
export class Tiered {
  private readonly counters = new Map<string, { hit: number; err: number }>();
  private readonly histos = new Map<string, Histogram>();
  private readonly ring: RingBuf;
  readonly full?: FullSink;
  readonly incidentDir?: string;
  readonly gate: ExportGate;

  private seq = 0;

  constructor(opts: TieredOptions = {}) {
    const mb = opts.ringBudgetMB ?? DEFAULT_RING_BUDGET_MB;
    this.ring = new RingBuf(Math.max(1, mb) * 1024 * 1024, DEFAULT_RING_SEG_SIZE);
    this.full = opts.fullSink;
    this.incidentDir = opts.incidentDir;
    this.gate = new ExportGate(opts.exportPerMin ?? DEFAULT_EXPORT_PER_MIN);
  }

  /** 所有采集路径的汇合点：计数器 + 环形缓冲（+ 可选全量镜像）。 */
  emit(ev: TSEvent): void {
    this.seq++;
    // c3 计数器
    let c = this.counters.get(ev.probe);
    if (!c) {
      c = { hit: 0, err: 0 };
      this.counters.set(ev.probe, c);
    }
    c.hit++;
    if (isCatchProbe(ev.probe)) c.err++;
    // c5 环形缓冲
    try {
      this.ring.write(Buffer.from(JSON.stringify(ev) + '\n', 'utf8'));
    } catch {
      /* 序列化失败（异常字段）：只计数不进环 */
    }
    // 可选全量镜像（自带文件落盘）
    if (this.full) {
      try {
        this.full.emit(ev.probe, ev.fields, ev.source);
      } catch {
        /* 镜像失败不影响内存态 */
      }
    }
  }

  /** 全部计数器快照（按探针名排序）。 */
  countersSnapshot(): CountersSnapshot[] {
    const out: CountersSnapshot[] = [];
    for (const [probe, c] of this.counters) out.push({ probe, hit: c.hit, err: c.err });
    out.sort((a, b) => (a.probe < b.probe ? -1 : 1));
    return out;
  }

  /** 全部直方图快照（按探针名排序）。 */
  histogramsSnapshot(): HistogramSnapshot[] {
    const out: HistogramSnapshot[] = [];
    for (const [probe, h] of this.histos) out.push(h.snapshot(probe));
    out.sort((a, b) => (a.probe < b.probe ? -1 : 1));
    return out;
  }

  ringStats(): RingStats {
    return this.ring.stats();
  }

  /** 环形缓冲原始快照（incident 导出用）。 */
  ringSnapshot(): Buffer {
    return this.ring.snapshot();
  }

  /** 当前事件序号（测试/统计用）。 */
  get seqCount(): number {
    return this.seq;
  }

  /** 记一次配对耗时（c4，由 Scope.exit 调用）。dMs 单位毫秒。 */
  recordDuration(base: string, dMs: number): void {
    let h = this.histos.get(base);
    if (!h) {
      h = new Histogram();
      this.histos.set(base, h);
    }
    h.record(dMs);
  }
}

/** 判定探针是否为 catch 点（错误计数器递增依据）。 */
export function isCatchProbe(name: string): boolean {
  return name.endsWith('.catch');
}

// ─────────────────────────────────────────────────────────────
// 全局路由（对齐 Go 侧 SetGlobalTiered / globalTieredFor）
// ─────────────────────────────────────────────────────────────

const GLOBAL_TIERED_KEY = '__camera_global_tiered__';

type TieredHolder = { [k: string]: Tiered | null | undefined };

/**
 * 配置全局 v2 分级采集 runtime（null 关闭）。返回前一个，便于测试隔离。
 * 挂 globalThis（与 probe.ts 的 sink 同理：跨模块实例共享，防 ESM 多副本）。
 */
export function setGlobalTiered(t: Tiered | null): Tiered | null {
  const holder = globalThis as unknown as TieredHolder;
  const prev = (holder[GLOBAL_TIERED_KEY] as Tiered | null | undefined) ?? null;
  holder[GLOBAL_TIERED_KEY] = t;
  return prev;
}

/** 读取全局 Tiered（trace.ts 的 enterScope 使用）。 */
export function getGlobalTiered(): Tiered | null {
  const holder = globalThis as unknown as TieredHolder;
  return (holder[GLOBAL_TIERED_KEY] as Tiered | null | undefined) ?? null;
}
