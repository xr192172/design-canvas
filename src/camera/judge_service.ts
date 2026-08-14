/**
 * Camera 判定下沉服务（语言无关）
 *
 * 目的：把「偏差判定」从各探针语言里剥出来，做成独立可调用的判定服务。
 * 探针只负责采集原始事件（captureProbe → events.jsonl / 直接入参），判定
 * 统一收敛到这一处。任何语言的探针（TS/Go/Java/…）只要产出符合 TSEvent
 * 形状的事件，就能 POST 上来判定，无需复刻判定规则。
 *
 * 判定语义与 Go contract.go（camera-dsl loop 权威）逐条对齐：
 *   design:silent-error-discard —— err 非空且非良性即为偏差。
 *   良性判定与操作相关：remove/remove-tmp/cleanup 显式标记 benign 才良性；
 *   writefile/save/mkdirall 一律非良性（数据未持久化）。
 *
 * 接口（挂到 serve 的 /api/camera/judge）：
 *   POST /api/camera/judge   body: { events: TSEvent[] } → 逐条判定 + 汇总
 *   GET  /api/camera/judge   从 CAMERA_EVENTS_FILE 读全部事件判定（等价 Go JudgeLogFile）
 */

import { judgeEvent, type JudgeVerdict } from './judge.js';
import type { TSEvent } from './probe.js';

/** 单条判定结果（含事件副本，方便调用方对齐）。 */
export interface JudgeEntry {
  verdict: JudgeVerdict;
  event: TSEvent;
}

/** 判定服务响应：逐条 verdict + 汇总统计。 */
export interface JudgeResult {
  total: number;
  ok: number;
  deviation: number;
  entries: JudgeEntry[];
}

/** 校验入参是否为合法 TSEvent 数组，返回规范化后的事件或错误信息。 */
export function normalizeEvents(input: unknown): { events: TSEvent[]; error?: string } {
  if (!Array.isArray(input)) {
    return { events: [], error: '请求体需为 { events: [...] }' };
  }
  const events: TSEvent[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r['probe'] !== 'string' || typeof r['fields'] !== 'object' || r['fields'] === null) continue;
    events.push({
      probe: r['probe'] as string,
      time: typeof r['time'] === 'string' ? (r['time'] as string) : new Date().toISOString(),
      source: typeof r['source'] === 'string' ? (r['source'] as string) : 'llm-design',
      fields: r['fields'] as Record<string, unknown>,
    });
  }
  return { events };
}

/** 对一批事件执行判定，返回逐条结果与汇总。 */
export function judgeEvents(events: TSEvent[]): JudgeResult {
  const entries: JudgeEntry[] = events.map((ev) => ({ verdict: judgeEvent(ev), event: ev }));
  const deviation = entries.filter((e) => e.verdict.result === 'deviation').length;
  return { total: entries.length, ok: entries.length - deviation, deviation, entries };
}

/** 渲染人类可读的判定报告（与 Go RenderReport 对齐）。 */
export function renderJudgeReport(r: JudgeResult): string {
  const lines: string[] = [
    `Camera 判定报告：${r.total} 个事件 · ${r.ok} ok · ${r.deviation} 偏差`,
  ];
  if (r.deviation === 0) {
    lines.push('  ✓ 所有观测值符合契约');
    return lines.join('\n');
  }
  lines.push('\n▎偏差（观测值不符合设计/契约）');
  for (const e of r.entries) {
    if (e.verdict.result !== 'deviation') continue;
    lines.push(`  ✗ [${e.verdict.rule}] probe=${e.event.probe} source=${e.event.source}`);
    lines.push(`      ${e.verdict.reason}`);
    for (const [k, v] of Object.entries(e.event.fields)) {
      lines.push(`      ${k}=${JSON.stringify(v)}`);
    }
  }
  return lines.join('\n');
}