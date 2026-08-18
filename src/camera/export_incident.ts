/**
 * Camera v2 错误开箱导出 + 导出限流 · TypeScript 端口
 *
 * 对齐 go-camera/probe/export.go（决策卡 c6/c8）。
 *
 * c6 错误开箱（嵌入式黑匣子语义）：环形缓冲一直在录、平时永不落盘；
 * catch 探针触发才"打开黑匣子"——捞同 trace id 的整条链路窗口 + 现场
 * 计数器/直方图快照，写成一个自包含 incident 文件。
 *
 * c8 限流（防导出风暴）：每探针每分钟最多 N 次（默认 10）。超限不导出、
 * 只计数（skipped 统计暴露风暴规模）——错误洪峰时宁丢现场不写爆磁盘。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Tiered } from './tiered.js';
import type { TSEvent } from './probe.js';
import type { Scope } from './trace.js';
import type { CountersSnapshot, HistogramSnapshot } from './tiered.js';

export const DEFAULT_EXPORT_PER_MIN = 10; // c8: 每探针每分钟导出限额
export const DEFAULT_MAX_INCIDENTS = 64; // incident 目录保留条数封顶（最旧先删）
const AMBIENT_WINDOW = 50; // 开箱附带的环境窗口：catch 前最近 N 条任意事件

/**
 * 每探针滑动窗口限流（c8）。内存 O(探针数 × quota)。
 * 单线程 JS 无需锁（对齐 Go 侧 mutex 保护）。
 */
export class ExportGate {
  readonly quota: number;
  private readonly seen = new Map<string, number[]>();
  private readonly skippedC = new Map<string, number>();

  constructor(quota: number) {
    this.quota = quota;
  }

  /** 判定本探针本轮分钟窗口内是否还有导出名额。now 单位 ms（可注入便于测试）。 */
  allow(probe: string, now = Date.now()): boolean {
    if (this.quota <= 0) return false;
    const times = (this.seen.get(probe) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= this.quota) {
      this.seen.set(probe, times);
      this.skippedC.set(probe, (this.skippedC.get(probe) ?? 0) + 1);
      return false;
    }
    times.push(now);
    this.seen.set(probe, times);
    return true;
  }

  /** 被限流跳过的导出次数（按探针）。 */
  skipped(): Record<string, number> {
    return Object.fromEntries(this.skippedC);
  }
}

/** 开箱文件首行：自描述现场快照。 */
export interface IncidentHeader {
  type: 'incident';
  trace_id: string;
  probe: string;
  err: string;
  at: string;
  counters: CountersSnapshot[]; // 触发时全量计数器
  histograms: HistogramSnapshot[]; // 触发探针的耗时形态
  ambient: number; // 环境窗口条数
  chain: number; // 同 trace_id 链路事件条数
}

/**
 * 打开黑匣子：扫环形缓冲一整圈，抽出
 *   1. 同 trace_id 的链路事件（c7 验收：各层窗口 trace id 一致）
 *   2. catch 前最近 AMBIENT_WINDOW 条任意事件（现场环境）
 * 加 IncidentHeader 头行，写成单个 JSONL 文件；目录超出保留数删最旧。
 * 返回文件路径；限流/未配置目录返回 null。
 */
export function exportIncident(t: Tiered, sp: Scope, err: unknown): string | null {
  const dir = t.incidentDir;
  if (!dir || t.gate.quota <= 0) return null;
  const now = new Date();
  if (!t.gate.allow(sp.probe, now.getTime())) return null; // c8 限流

  const all = splitEvents(t.ringSnapshot());
  const chain: TSEvent[] = [];
  for (const ev of all) {
    if (ev.trace_id === sp.traceId) chain.push(ev);
  }
  const ambient = all.length > AMBIENT_WINDOW ? all.slice(all.length - AMBIENT_WINDOW) : all;

  fs.mkdirSync(dir, { recursive: true });
  const name = `incident-${formatTimestamp(now)}-${sp.traceId}.jsonl`;
  const file = path.join(dir, name);

  const hdr: IncidentHeader = {
    type: 'incident',
    trace_id: sp.traceId,
    probe: sp.probe,
    err: errText(err),
    at: now.toISOString(),
    counters: t.countersSnapshot(),
    histograms: t.histogramsSnapshot().filter((h) => h.probe === sp.probe),
    ambient: ambient.length,
    chain: chain.length,
  };
  const lines: string[] = [JSON.stringify(hdr)];
  for (const ev of chain) lines.push(JSON.stringify(ev));
  if (chain.length === 0) {
    // 链路窗口已被环覆盖（罕见：链路跨度大于环容量）——环境窗口兜底
    for (const ev of ambient) lines.push(JSON.stringify(ev));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  pruneIncidents(dir);
  return file;
}

/** 解析环形快照为事件序列（残行/覆盖边界自动丢弃）。 */
export function splitEvents(raw: Buffer): TSEvent[] {
  const out: TSEvent[] = [];
  for (const line of raw.toString('utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as TSEvent);
    } catch {
      /* 覆盖边界残包丢弃 */
    }
  }
  return out;
}

/** 保持 incident 目录 ≤ DEFAULT_MAX_INCIDENTS 条（c1 铁律同样适用于磁盘）。 */
function pruneIncidents(dir: string): void {
  let entries: string[];
  try {
    entries = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith('incident-') && !n.endsWith('.tmp'));
  } catch {
    return;
  }
  if (entries.length <= DEFAULT_MAX_INCIDENTS) return;
  entries.sort(); // 名含时间戳，字典序=时间序
  const excess = entries.length - DEFAULT_MAX_INCIDENTS;
  for (const name of entries.slice(0, excess)) {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      /* 尽力删除 */
    }
  }
}

/** Go 布局 "20060102-150405.000000" 的 TS 等价（本地时间 → UTC 保持一致语义）。 */
function formatTimestamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}` +
    `.${p(d.getUTCMilliseconds(), 6)}`
  );
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err === null || err === undefined) return '';
  return String(err);
}
