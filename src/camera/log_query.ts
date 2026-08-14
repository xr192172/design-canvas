/**
 * Camera 日志查询（TS 侧，供 serve 端点 /api/camera/log 使用）
 *
 * 定位：让 LLM/前端能按文件路径「主动拉取」某条链路/某个文件的异常日志，
 * 而不是一次全量丢出。语义与 Go `camera-dsl log --file <path>` 对齐：
 *   - 指定 file：只返回命中该路径的事件（含正常流动，异常打标记），供 LLM
 *     查看该文件数据流具体怎么实现。
 *   - 未指定 file：默认只返回偏差（静默吞错 / 设计不符）；all=true 才全量。
 *
 * 判定复用 judgeEvent（与 Go SilentErrorDiscard 语义对齐），单一事实来源。
 */

import fs from 'node:fs';
import { loadTSEvents, type TSEvent } from './probe.js';
import { judgeEvent, type JudgeVerdict } from './judge.js';

/** 单条日志查询结果。 */
export interface LogEntry {
  probe: string;
  time: string;
  rule: string;
  result: 'ok' | 'deviation';
  reason: string;
  file?: string;
  fields: Record<string, unknown>;
}

/** 日志查询选项。 */
export interface LogQueryOptions {
  /** 文件路径过滤（可多个）。传相对路径/文件名片段均可，精确或后缀/包含匹配。 */
  files?: string[];
  /** 未指定 file 时是否全量列出（默认只列偏差）。 */
  all?: boolean;
}

/** 日志查询结果。 */
export interface LogQueryResult {
  eventsPath: string;
  total: number;
  anomalyCount: number;
  skipped: number;
  entries: LogEntry[];
}

const norm = (s: string): string => s.replaceAll('\\', '/');

/** 事件是否命中任一文件过滤（与 Go 语义一致：精确 / 后缀 / 包含）。 */
function matchesFile(ev: TSEvent, files: string[]): boolean {
  const raw = ev.fields['file'];
  const evFile = typeof raw === 'string' ? norm(raw) : '';
  if (!evFile) return false;
  for (const f of files) {
    const ff = norm(f);
    if (evFile === ff || evFile.endsWith(ff) || evFile.includes(ff)) return true;
  }
  return false;
}

/** 单条事件 → 日志条目（判定 + 附文件路径）。 */
function toEntry(ev: TSEvent): LogEntry {
  const v: JudgeVerdict = judgeEvent(ev);
  const file = typeof ev.fields['file'] === 'string' ? (ev.fields['file'] as string) : undefined;
  return {
    probe: ev.probe,
    time: ev.time,
    rule: v.rule,
    result: v.result,
    reason: v.reason,
    ...(file ? { file } : {}),
    fields: ev.fields,
  };
}

/**
 * 查询 Camera 运行日志。
 * @param eventsPath 事件文件路径；不存在返回空结果。
 * @param opts 过滤/全量选项。
 */
export function queryCameraLog(eventsPath: string, opts: LogQueryOptions = {}): LogQueryResult {
  if (!fs.existsSync(eventsPath)) {
    return { eventsPath, total: 0, anomalyCount: 0, skipped: 0, entries: [] };
  }
  const { events, skipped } = loadTSEvents(eventsPath);

  // 先按文件过滤（若指定），否则取全部
  let pool = events;
  const files = opts.files?.filter(Boolean) ?? [];
  if (files.length > 0) {
    pool = events.filter((ev) => matchesFile(ev, files));
  }

  // 未指定文件且非全量 → 只取偏差
  let show = pool;
  if (files.length === 0 && !opts.all) {
    show = pool.filter((ev) => judgeEvent(ev).result === 'deviation');
  }

  const entries = show.map(toEntry);
  const anomalyCount = pool.filter((ev) => judgeEvent(ev).result === 'deviation').length;

  return { eventsPath, total: pool.length, anomalyCount, skipped, entries };
}