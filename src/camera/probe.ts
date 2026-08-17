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

// ─────────────────────────────────────────────────────────────
// 全局零侵入探针接口（对齐 Go 侧 SetGlobalSink / Capture 语义）
// 默认关闭：未配置 sink 时 captureProbe 是 no-op，插桩不改变宿主行为。
// 狗食插桩路径：<dataHome>/.design-canvas/camera/events.jsonl
//
// 重要：sink 状态挂在 globalThis 上，而非模块级变量。因为全自动插桩会把
// captureProbe 注入到项目的任意文件，而同一 probe.js 被不同相对路径 specifier
// 加载时，Node ESM 会创建多个模块实例（各自持有独立模块级变量）。若 sink 存
// 模块级，被插桩代码与哨兵就会各持一份 sink，导致 enableCameraFromEnv 设置的
// sink 无法被被插桩代码看到。挂在 globalThis 上则所有实例共享同一份状态。
// ─────────────────────────────────────────────────────────────

const GLOBAL_SINK_KEY = '__camera_global_sink__';

// globalThis 是值而非命名空间，不能直接用作类型。用任意对象类型的索引签名访问。
type SinkHolder = { [GLOBAL_SINK_KEY]?: TSProbeCapture | null };

/** 读取全局共享的 sink（跨模块实例一致）。 */
function getGlobalSink(): TSProbeCapture | null {
  return (globalThis as unknown as SinkHolder)[GLOBAL_SINK_KEY] ?? null;
}

/** 全局 sink 是否已配置（供 lazy 初始化方判断，避免覆盖已有 sink）。 */
export function hasGlobalProbeSink(): boolean {
  return getGlobalSink() !== null;
}

/**
 * 配置全局探针 sink（null 关闭）。返回前一个 sink，便于测试隔离/恢复。
 * 与 Go 侧 SetGlobalSink 语义一致：probe 只依赖这个开关，未配置则 no-op。
 */
export function setGlobalProbeSink(s: TSProbeCapture | null): TSProbeCapture | null {
  const holder = globalThis as unknown as SinkHolder;
  const prev = holder[GLOBAL_SINK_KEY] ?? null;
  holder[GLOBAL_SINK_KEY] = s;
  return prev;
}

/**
 * 零侵入捕获：向全局 sink 追加一条事件（若已配置）。未配置时静默 no-op，
 * 因此可在任意宿主代码路径无条件调用，不引入 try/catch 污染。
 */
export function captureProbe(probe: string, fields: Record<string, unknown>, source = 'static-rule'): void {
  const sink = getGlobalSink();
  if (!sink) return;
  try {
    sink.emit(probe, fields, source);
  } catch {
    /* 探针绝不允许反过来让业务路径抛错 */
  }
}

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
  private readonly onEvent?: (ev: TSEvent) => void;

  /**
   * @param eventsPath events.jsonl 路径
   * @param onEvent    可选的即时回调：每条事件写入后立即调用（不阻塞）。
   *                   用于「开发时即时观测提示」——serve 侧借此在事件产生瞬间
   *                   判定并 SSE 推送，而非事后跑 Go loop 才知道结果。
   */
  constructor(eventsPath: string, onEvent?: (ev: TSEvent) => void) {
    this.eventsPath = eventsPath;
    this.onEvent = onEvent;
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
    if (this.onEvent) {
      try {
        this.onEvent(ev);
      } catch {
        /* 即时回调失败不影响落盘 */
      }
    }
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