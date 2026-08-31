/**
 * Observe v2 调用链作用域 · TypeScript 端口（c7 correlation ID）
 *
 * 对齐 go-observe/probe/trace.go。链路串联靠 trace id：调用进入时生成、
 * 层层传递。否决方案：模块级全局变量隐式传递——Go goroutine / TS async
 * 下不成立。落地方式：
 *   - Go：trace id 经 context.Context 显式流动（Go 惯用法）
 *   - TS：AsyncLocalStorage 按异步上下文隔离传递（Node 惯用法）——
 *     每个 async 调用链有独立 store，天然免疫并发串线
 *
 * 用法（手写或插桩器注入）：
 *
 *   async function handle(req: Req): Promise<Resp> {
 *     return withScope('svc.handle', { req: req.id }, async (sp) => {
 *       ...
 *       if (err) {
 *         sp.catch(err);      // 触发错误开箱导出（同 trace id 整条链路窗口）
 *         throw err;
 *       }
 *     });
 *   }
 *
 * 嵌套调用（withScope 内再 withScope）自动继承父 trace id 与 frame id。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import crypto from 'node:crypto';
import type { Tiered } from './tiered.js';
import { getGlobalTiered } from './tiered.js';
import { exportIncident } from './export_incident.js';

const scopeALS = new AsyncLocalStorage<Scope>();

/** 帧序号（进程内唯一递增；单线程无需原子操作）。 */
let frameSeq = 0;

export type ScopeFields = Record<string, unknown>;

/**
 * 一次函数调用的采集作用域：enter/exit 配对（耗时→直方图）、
 * catch 触发错误开箱导出。由 enterScope/withScope 创建，不直接构造。
 */
export class Scope {
  readonly probe: string; // 基础探针名，如 "svc.Handle"（enter/exit/catch 加后缀）
  readonly traceId: string;
  readonly frameId: number;
  readonly parentId: number; // 0=根
  private readonly t: Tiered | null;
  private readonly start: number; // performance.now()
  private exited = false;
  private exported = false; // Catch 已触发导出（一帧只导一次）

  constructor(t: Tiered | null, probe: string, traceId: string, frameId: number, parentId: number) {
    this.t = t;
    this.probe = probe;
    this.traceId = traceId;
    this.frameId = frameId;
    this.parentId = parentId;
    this.start = performance.now();
  }

  /**
   * 退出作用域：发出 "<probe>.exit"（带耗时），耗时记入直方图（c4）。
   * 幂等：多次调用只记一次。
   */
  exit(fields?: ScopeFields): void {
    if (!this.t || this.exited) return;
    this.exited = true;
    const durMs = performance.now() - this.start;
    const f: ScopeFields = { ...(fields ?? {}), dur_ms: Math.round(durMs * 1000) / 1000 };
    this.t.emit({
      probe: `${this.probe}.exit`,
      time: new Date().toISOString(),
      source: 'v2-scope',
      fields: f,
      trace_id: this.traceId,
      frame_id: this.frameId,
      parent_id: this.parentId,
    });
    this.t.recordDuration(this.probe, durMs);
  }

  /**
   * 记录一次错误：err 计数器 +1，并触发错误开箱导出（c6，经 c8 限流门）。
   * 一帧只导出一次（重复 Catch 只计数）。
   */
  catch(err: unknown, fields?: ScopeFields): void {
    if (!this.t) return;
    const f: ScopeFields = { ...(fields ?? {}) };
    f.err = err instanceof Error ? err.message : err === null || err === undefined ? null : String(err);
    this.t.emit({
      probe: `${this.probe}.catch`,
      time: new Date().toISOString(),
      source: 'v2-scope',
      fields: f,
      trace_id: this.traceId,
      frame_id: this.frameId,
      parent_id: this.parentId,
    });
    // 首次 Catch 且确有错误才导出（一帧最多一次）
    if (err !== null && err !== undefined && !this.exported) {
      this.exported = true;
      exportIncident(this.t, this, err);
    }
  }

  /**
   * 在本作用域内执行 fn：fn 内（含全部 await 后续）的 enterScope/withScope
   * 自动以本帧为父（AsyncLocalStorage 按异步上下文传递）。
   * fn 抛错时自动 catch 记录后原样上抛（不吞错），并保证 exit。
   */
  run<T>(fn: () => T): T {
    return scopeALS.run(this, fn);
  }
}

/**
 * 进入一个调用作用域：
 *   - 异步上下文里已有父 Scope → 继承 trace id，记 parent frame
 *   - 无父 → 生成新 trace id（根）
 *   - 发出 "<probe>.enter" 事件（计数器+环形缓冲）
 * 注意：裸 enterScope 不会让后续嵌套调用看到本帧——需用 scope.run(fn)
 * 包裹（或直接用 withScope）。推荐一律用 withScope。
 */
export function enterScope(probe: string, fields?: ScopeFields, t?: Tiered | null): Scope {
  const tiered = t === undefined ? getGlobalTiered() : t;
  const parent = scopeALS.getStore();
  const sp = new Scope(
    tiered,
    probe,
    parent ? parent.traceId : newTraceId(),
    ++frameSeq,
    parent ? parent.frameId : 0,
  );
  if (tiered) {
    tiered.emit({
      probe: `${probe}.enter`,
      time: new Date().toISOString(),
      source: 'v2-scope',
      fields: { ...(fields ?? {}) },
      trace_id: sp.traceId,
      frame_id: sp.frameId,
      parent_id: sp.parentId,
    });
  }
  return sp;
}

/**
 * 作用域包裹执行（推荐入口）：enter → ALS 绑定 → fn → exit。
 * fn 抛错：先 sp.catch(err)（触发开箱导出）再上抛；exit 由 finally 保证。
 */
export function withScope<T>(probe: string, fields: ScopeFields | undefined, fn: (sp: Scope) => T, t?: Tiered | null): T;
export function withScope<T>(probe: string, fn: (sp: Scope) => T, t?: Tiered | null): T;
export function withScope<T>(
  probe: string,
  fieldsOrFn: ScopeFields | undefined | ((sp: Scope) => T),
  fnOrT?: ((sp: Scope) => T) | Tiered | null,
  maybeT?: Tiered | null,
): T {
  let fields: ScopeFields | undefined;
  let fn: (sp: Scope) => T;
  let t: Tiered | null | undefined;
  if (typeof fieldsOrFn === 'function') {
    fn = fieldsOrFn;
    t = fnOrT as Tiered | null | undefined;
  } else {
    fields = fieldsOrFn;
    fn = fnOrT as (sp: Scope) => T;
    t = maybeT;
  }
  const sp = enterScope(probe, fields, t);
  let result: T;
  try {
    result = scopeALS.run(sp, fn, sp);
  } catch (err) {
    // 同步抛错：catch（触发开箱导出）→ exit → 原样上抛
    sp.catch(err);
    sp.exit();
    throw err;
  }
  if (result instanceof Promise) {
    // 异步 fn：同步 try/catch 捕获不了 Promise rejection，必须走 then 链。
    // 成功/失败都保证 exit（幂等），失败先 catch（开箱导出）再上抛。
    const p = result as unknown as Promise<unknown>;
    return p.then(
      (v) => {
        sp.exit();
        return v;
      },
      (err) => {
        sp.catch(err);
        sp.exit();
        throw err;
      },
    ) as unknown as T;
  }
  sp.exit();
  return result;
}

/** 取当前异步上下文里的 Scope（无则 undefined）。 */
export function currentScope(): Scope | undefined {
  return scopeALS.getStore();
}

/** 取当前 trace id（无作用域返回空串）。 */
export function currentTraceId(): string {
  return scopeALS.getStore()?.traceId ?? '';
}

/** 生成 16 字符十六进制随机 id（crypto.randomBytes，128bit 碰撞可忽略）。 */
export function newTraceId(): string {
  return crypto.randomBytes(8).toString('hex');
}
