/**
 * Camera 多语言契约 · TypeScript 探针端口（ProbeCapture）
 *
 * 对应 docs/camera-abstract.md §3.1 端口接口。目的：让 TS 侧埋点产出符合
 * `schema/camera_contract.schema.json` 中 Event 结构的 events.jsonl，使同一份
 * 观测能被 Go 装配层（`camera-dsl actual/diff/loop`）或 TS 哨兵判定器读取判定。
 *
 * 「跨语言契约」关键点：探针只产出 Event（语言无关），不关心判定逻辑——
 * 判定由统一规则谓词 & LLM 层承载，与探针所属语言解耦。
 */

import fs from 'node:fs';
import path from 'node:path';

/** TS 侧 Event，与 schema definitions.Event 逐字段对齐。 */
export interface TSEvent {
  probe: string;
  time: string; // UTC RFC3339
  source?: string; // static-rule / llm-design / runtime-invariant
  fields: Record<string, unknown>;
}

/** Merge 额外字段到 fields 的辅助类型。 */
export type ExtraFields = Record<string, unknown>;

/**
 * TS 探针端口：追加写 events.jsonl。
 * 与 Go 侧 Sink 语义对齐（append-only + 自动补 time），单线程 JS 无需锁。
 */
export class TSProbeCapture {
  private readonly eventsPath: string;

  constructor(eventsPath: string) {
    this.eventsPath = eventsPath;
  }

  /** 确定 events.jsonl 路径（默认 <cameraDir>/events.jsonl）。 */
  static pathFor(cameraDir: string): string {
    return path.join(cameraDir, 'events.jsonl');
  }

  /**
   * 追加一条事件到 events.jsonl。自动补 time（UTC RFC3339）。
   * 返回写入的事件（含补全的 time），便于测试断言。
   */
  emit(probe: string, fields: Record<string, unknown>, source = 'static-rule'): TSEvent {
    const ev: TSEvent = {
      probe,
      time: new Date().toISOString(),
      source,
      fields,
    };
    fs.mkdirSync(path.dirname(this.eventsPath), { recursive: true });
    fs.appendFileSync(this.eventsPath, JSON.stringify(ev) + '\n', 'utf8');
    return ev;
  }

  /** 幂等地清空事件文件（测试隔离用）。 */
  clear(): void {
    if (fs.existsSync(this.eventsPath)) {
      fs.unlinkSync(this.eventsPath);
    }
  }
}

/**
 * 读取 events.jsonl，解析为 TSEvent[]。坏行跳过（与 Go ActualDSLLoader 容错一致）。
 * 返回 { events, skipped }。
 */
export function loadTSEvents(eventsPath: string): { events: TSEvent[]; skipped: number } {
  if (!fs.existsSync(eventsPath)) return { events: [], skipped: 0 };
  const lines = fs.readFileSync(eventsPath, 'utf8').split('\n');
  const events: TSEvent[] = [];
  let skipped = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as TSEvent);
    } catch {
      skipped++;
    }
  }
  return { events, skipped };
}