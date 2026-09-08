/**
 * Observe 多语言契约 · TypeScript 探针端口（ProbeCapture）
 *
 * 对应 docs/observe-abstract.md §3.1 端口接口。目的：让 TS 侧埋点产出符合
 * `schema/observe_contract.schema.json` 中 Event 结构的 events.jsonl，使同一份
 * 观测能被 Go 装配层（`observe-dsl actual/diff/loop`）或 TS 哨兵判定器读取判定。
 *
 * 「跨语言契约」关键点：探针只产出 Event（语言无关），不关心判定逻辑——
 * 判定由统一规则谓词 & LLM 层承载，与探针所属语言解耦。
 */

import fs from 'node:fs';
import path from 'node:path';

// ─────────────────────────────────────────────────────────────
// 全局零侵入探针接口（对齐 Go 侧 SetGlobalSink / Capture 语义）
// 默认关闭：未配置 sink 时 captureProbe 是 no-op，插桩不改变宿主行为。
// 狗食插桩路径：<dataHome>/.design-canvas/observe/events.jsonl
//
// 重要：sink 状态挂在 globalThis 上，而非模块级变量。因为全自动插桩会把
// captureProbe 注入到项目的任意文件，而同一 probe.js 被不同相对路径 specifier
// 加载时，Node ESM 会创建多个模块实例（各自持有独立模块级变量）。若 sink 存
// 模块级，被插桩代码与哨兵就会各持一份 sink，导致 enableObserveFromEnv 设置的
// sink 无法被被插桩代码看到。挂在 globalThis 上则所有实例共享同一份状态。
// ─────────────────────────────────────────────────────────────

import { AsyncLocalStorage } from 'node:async_hooks';

const GLOBAL_SINK_KEY = '__observe_global_sink__';

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

// ─────────────────────────────────────────────────────────────
// v2 scope（调用树录制）：enterScope/exitScope 通过 AsyncLocalStorage 在
// async 调用链中传播当前帧，自动给 enter/exit 事件补 trace_id/frame_id/parent_id，
// 是可重建"一次操作调用树"的事件源。与 Go 侧 trace.go 的 Enter/Exit 同级。
//
// 说明：AsyncLocalStorage 在 Promise 链中传递 store，模拟"当前调用帧"；
// 对深同步 + await 的主链是准确的；并行兄弟分支会继承同一 trace（可接受，
// 与"一次操作主链"语义一致）。退出用 parent 指针恢复上下文，支持嵌套。
// ─────────────────────────────────────────────────────────────

const als = new AsyncLocalStorage<FrameCtx | undefined>();
let frameSeq = 0;

/** 公开的帧信息（事件补 trace），供 scope emit / 外部重建用。 */
export interface ProbeFrame {
  trace_id: string;
  frame_id: number;
  parent_id: number;
}

/** 帧上下文（含父指针，退出时恢复）。 */
interface FrameCtx extends ProbeFrame {
  started: number;
  parent?: FrameCtx;
}

/** 生成 16 字符十六进制 trace id。 */
function newTraceID(): string {
  let s = '';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** enter 一个调用帧：继承父 trace/frame，分配新 frame，发 .enter 事件。 */
export function enterScope(probe: string, fields: Record<string, unknown>): void {
  const prev = als.getStore();
  const frame: FrameCtx = {
    trace_id: prev?.trace_id ?? newTraceID(),
    frame_id: ++frameSeq,
    parent_id: prev?.frame_id ?? 0,
    started: Date.now(),
    parent: prev,
  };
  emitFrame(probe + '.enter', fields, frame);
  als.enterWith(frame);
}

/** exit 一个调用帧：发 .exit 事件（带耗时），并把当前帧恢复为父。 */
export function exitScope(probe: string, fields: Record<string, unknown> = {}): void {
  const cur = als.getStore();
  if (!cur) return;
  emitFrame(probe + '.exit', { ...(fields || {}), dur_ms: msSince(cur.started) }, cur);
  als.enterWith(cur.parent);
}

function msSince(started: number): number {
  return Math.max(0, Date.now() - started);
}

/** 内部：向全局 sink 发带帧事件（未配置 no-op）。 */
function emitFrame(probe: string, fields: Record<string, unknown>, frame: FrameCtx): void {
  const sink = getGlobalSink();
  if (!sink) return;
  try {
    sink.emit(probe, fields, 'v2-scope', frame);
  } catch {
    /* 探针不允许抛错 */
  }
}

/** TS 侧 Event，与 schema definitions.Event 逐字段对齐（含 v2 trace 字段）。 */
export interface TSEvent {
  probe: string;
  time: string; // UTC RFC3339
  source?: string; // static-rule / llm-design / runtime-invariant / v2-scope
  fields: Record<string, unknown>;
  /** c7: 整条调用链共享的 trace id（v1 事件省略，向后兼容）。 */
  trace_id?: string;
  /** c7: 本帧唯一 id（每次调用一个；省略=0）。 */
  frame_id?: number;
  /** c7: 父调用帧 id（0/省略=根）。 */
  parent_id?: number;
}

/** 单字段估值最大的 JSON 长度预算（字符）。超限的对象/数组降级为概要，避免大对象整段撑爆。 */
const MAX_FIELD_CHARS = 2048;
/** 单字段允许的最大嵌套深度。超出按概要处理。 */
const MAX_FIELD_DEPTH = 4;

/**
 * 有界容错的价值序列化（供事件落盘前调用）：
 *   - 循环引用 / BigInt / 函数 / undefined → 不会让 JSON.stringify 抛错（丢帧）
 *   - 大对象（超出 MAX_FIELD_CHARS / MAX_FIELD_DEPTH）→ 降级为概要 `{ $type, $size, ... }`，
 *     不整段落盘（如 Commander 对象、整个 profile 配置 dump）
 * 返回可直接 appendFile 的单行 JSON 文本，永不抛错。
 */
function serializeSafe(ev: TSEvent): string {
  const clean = { ...ev, fields: scrub(ev.fields, 0) as Record<string, unknown> };
  return JSON.stringify(clean) ?? JSON.stringify({ probe: ev.probe, time: ev.time, error: 'serialize-failed' });
}

/** 递归清洗为可 JSON 的安全副本；超深/超大降级为概要。 */
function scrub(v: unknown, depth: number): unknown {
  if (v === null) return null;
  const t = typeof v;
  if (t === 'string' || t === 'boolean' || t === 'number') return v;
  if (t === 'bigint' || t === 'symbol' || t === 'function' || t === 'undefined') {
    return t === 'bigint' ? String(v) : undefined;
  }
  if (v instanceof Error) return { name: v.name, message: v.message };
  if (t === 'object') {
    if (depth >= MAX_FIELD_DEPTH) {
      return summarize(v);
    }
    // 先结构化概要估算整体规模：超预算直接降级
    const rough = estimateJsonLength(v);
    if (rough > MAX_FIELD_CHARS) return summarize(v);
    const seen = new Set<object>();
    const build = (x: unknown, d: number): unknown => {
      if (x === null || typeof x !== 'object') return scrub(x, d);
      // Error 的 name/message/stack 可能是非枚举属性，Object.keys 枚举不到会得到空对象 → 显式抽取
      if (x instanceof Error || (typeof (x as { message?: unknown }).message === 'string' && typeof (x as { stack?: unknown }).stack === 'string')) {
        const e = x as Error;
        return { name: e.name, message: e.message };
      }
      if (seen.has(x)) return '[Circular]';
      seen.add(x);
      let out: unknown;
      if (Array.isArray(x)) {
        const arr: unknown[] = [];
        for (const it of x) arr.push(build(it, d + 1));
        out = arr;
      } else {
        const o: Record<string, unknown> = {};
        for (const k of Object.keys(x)) o[k] = build((x as Record<string, unknown>)[k], d + 1);
        out = o;
      }
      seen.delete(x);
      return out;
    };
    return build(v, depth);
  }
  return undefined;
}

/** 估算值的 JSON 体积（近似：string 取长但单条封顶，避免单个长串/Error.stack 误判整棵过大）。
 *  seen 防循环引用递归爆栈（自引用对象计小成本）。超限即用概要替代。 */
function estimateJsonLength(v: unknown, seen = new Set<object>()): number {
  if (v === null || v === undefined) return 4;
  const t = typeof v;
  if (t === 'string') return Math.min((v as string).length, 512);
  if (t === 'number' || t === 'boolean') return 8;
  if (v instanceof Error) return 16;
  if (Array.isArray(v)) {
    if (seen.has(v)) return 8;
    seen.add(v);
    const n = v.reduce((acc, it) => acc + estimateJsonLength(it, seen) + 1, 0);
    seen.delete(v);
    return n;
  }
  if (t === 'object') {
    if (seen.has(v as object)) return 8;
    seen.add(v as object);
    let n = 0;
    for (const k of Object.keys(v as object)) n += k.length + (estimateJsonLength((v as Record<string, unknown>)[k], seen)) + 1;
    seen.delete(v as object);
    return n;
  }
  return 8;
}

/** 大对象概要：只留类型 + 规模 + 顶层键（或数组长度），不再展开整段。 */
function summarize(v: unknown): Record<string, unknown> {
  if (Array.isArray(v)) return { $type: 'array', $size: v.length };
  if (typeof v === 'object' && v !== null) {
    const keys = Object.keys(v);
    return { $type: 'object', $size: keys.length, $keys: keys.slice(0, 12) };
  }
  return { $type: typeof v };
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

  /** 确定 events.jsonl 路径（默认 <observeDir>/events.jsonl）。 */
  static pathFor(observeDir: string): string {
    return path.join(observeDir, 'events.jsonl');
  }

  /**
   * 追加一条事件到 events.jsonl。自动补 time（UTC RFC3339）。
   * frame?: 传入则补 trace_id/frame_id/parent_id（scope 事件用它重建调用树）。
   * 返回写入的事件（含补全的 time），便于测试断言。
   */
  emit(probe: string, fields: Record<string, unknown>, source = 'static-rule', frame?: ProbeFrame): TSEvent {
    const ev: TSEvent = {
      probe,
      time: new Date().toISOString(),
      source,
      fields,
    };
    if (frame) {
      ev.trace_id = frame.trace_id;
      ev.frame_id = frame.frame_id;
      ev.parent_id = frame.parent_id;
    }
    fs.mkdirSync(path.dirname(this.eventsPath), { recursive: true });
    // 有界容错序列化：循环引用/大对象/含函数/不可 JSON 的值不再让 JSON.stringify 抛错丢帧，
    // 也不再整段落盘撑爆体积（如 Commander 对象、整个 profile 配置 dump）。详见 serializeSafe 文档。
    const serialized = serializeSafe(ev);
    fs.appendFileSync(this.eventsPath, serialized + '\n', 'utf8');
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