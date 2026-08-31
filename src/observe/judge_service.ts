/**
 * Observe 判定下沉服务（语言无关）
 *
 * 目的：把「偏差判定」从各探针语言里剥出来，做成独立可调用的判定服务。
 * 探针只负责采集原始事件（captureProbe → events.jsonl / 直接入参），判定
 * 统一收敛到这一处。任何语言的探针（TS/Go/Java/…）只要产出符合 TSEvent
 * 形状的事件，就能 POST 上来判定，无需复刻判定规则。
 *
 * 判定语义与 Go contract.go（observe-dsl loop 权威）逐条对齐：
 *   design:silent-error-discard —— err 非空且非良性即为偏差。
 *   良性判定与操作相关：remove/remove-tmp/cleanup 显式标记 benign 才良性；
 *   writefile/save/mkdirall 一律非良性（数据未持久化）。
 *
 * 接口（挂到 serve 的 /api/observe/judge）：
 *   POST /api/observe/judge   body: { events: TSEvent[] } → 逐条判定 + 汇总
 *   GET  /api/observe/judge   从 OBSERVE_EVENTS_FILE 读全部事件判定（等价 Go JudgeLogFile）
 */

import { judgeEvent, type JudgeVerdict } from './judge.js';
import { callChat, loadLlmConfig } from '../tools/llm_focus.js';
import type { TSEvent } from './probe.js';

/** 单条判定结果（含事件副本，方便调用方对齐）。 */
export interface JudgeEntry {
  verdict: JudgeVerdict;
  event: TSEvent;
}

/** 单条判定结果（use_llm=true 时含 LLM 复核意见）。 */
export interface JudgeEntryWithLLM extends JudgeEntry {
  /** LLM 行为级复核结果（use_llm=true 且事件被判为可疑时存在；否则缺省）。 */
  llm?: { result: 'ok' | 'deviation'; rule: string; reason: string };
}

/** 判定服务响应：逐条 verdict + 汇总统计。 */
export interface JudgeResult {
  total: number;
  ok: number;
  deviation: number;
  entries: JudgeEntry[];
}

/** 校验入参是否为合法 TSEvent 数组，返回规范化后的事件或错误信息。 */
/** 校验入参是否为合法 TSEvent 数组，返回规范化后的事件或错误信息。
 * v2 trace 字段（trace_id/frame_id）原样保留——链路重建（rebuildChains）依赖它们。 */
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
      trace_id: typeof r['trace_id'] === 'string' ? (r['trace_id'] as string) : undefined,
      frame_id: typeof r['frame_id'] === 'number' ? (r['frame_id'] as number) : undefined,
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

/** judgeEvents 的 LLM 增强版：对规则秒判为「deviation」的事件做 LLM 行为级复核。
 * use_llm=false（默认）等价 judgeEvents，纯规则秒判、零 LLM 成本。
 * use_llm=true 时对可疑事件调 LLM 复核；LLM 不可用/调用失败时降级——保留规则
 * 判定结果，不阻断流程（与 Go LLMJudge 失败降级语义一致）。
 * LLM 判定只喂「事件快照 + 契约语义」，不接触项目文档（DSL 唯一真相源）。 */
export async function judgeEventsWithLLM(
  events: TSEvent[],
  useLlm = false,
): Promise<JudgeResult> {
  const base = judgeEvents(events);
  if (!useLlm) return base;

  const cfg = loadLlmConfig();
  const entries: JudgeEntryWithLLM[] = base.entries.map((e) => ({ ...e }));
  for (const entry of entries) {
    if (entry.verdict.result !== 'deviation') continue; // 只复核可疑事件，成本可控
    if (!cfg) {
      // 未配置 LLM：降级为纯规则，不补 llm 字段
      continue;
    }
    try {
      const raw = await callChat(cfg, [
        {
          role: 'system',
          content:
            '你是代码行为判定器。只依据给出的契约语义与事件观测快照判定，不得臆测契约之外的背景。输出纯 JSON，不要 markdown。',
        },
        { role: 'user', content: buildLLMPrompt(entry.event, entry.verdict.rule) },
      ]);
      const parsed = JSON.parse(raw) as { result?: string; rule?: string; reason?: string };
      if (parsed.result === 'ok' || parsed.result === 'deviation') {
        entry.llm = {
          result: parsed.result,
          rule: parsed.rule || entry.verdict.rule,
          reason: parsed.reason || '',
        };
      }
    } catch {
      // LLM 调用失败 → 降级，保留规则判定，不阻断
    }
  }

  const deviation = entries.filter((e) => e.verdict.result === 'deviation').length;
  return { total: entries.length, ok: entries.length - deviation, deviation, entries: entries as JudgeEntry[] };
}

/** 组装 LLM 复核 prompt：只含事件快照 + 契约语义（唯一真相源，无文档）。 */
function buildLLMPrompt(ev: TSEvent, rule: string): string {
  const lines: string[] = ['【事件观测快照】', `probe: ${ev.probe}`, `source: ${ev.source}`];
  lines.push('fields:');
  for (const [k, v] of Object.entries(ev.fields)) lines.push(`  ${k}: ${JSON.stringify(v)}`);
  lines.push(`\n【契约语义】（判定唯一依据）rule=${rule}`);
  if (rule === 'design:silent-error-discard') {
    lines.push(
      '在本来会静默丢弃错误的位置，捕获到的 err 必须为 nil 或可证明是良性的（benign）。' +
        'op=writefile/save/mkdirall 时任何错误都不可良性（父目录缺失的 ENOENT 也算非良性，因为数据未持久化）；' +
        'op=remove/cleanup 仅 os.IsNotExist 良性。',
    );
  }
  lines.push('\n【输出】纯 JSON：{"result":"ok"|"deviation","rule":"<命中的规则id>","reason":"一句话说明"}');
  return lines.join('\n');
}

/** 渲染人类可读的判定报告（与 Go RenderReport 对齐）。 */
export function renderJudgeReport(r: JudgeResult): string {
  const lines: string[] = [
    `Observe 判定报告：${r.total} 个事件 · ${r.ok} ok · ${r.deviation} 偏差`,
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