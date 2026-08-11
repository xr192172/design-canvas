/**
 * traceReasoning 工具：零接触自动插桩记录器（Agent 推理痕迹）
 *
 * 开发者只需提供 entryFile + entryFn + input，其余全自动：
 *  1. 自动发现：ts_kernel 解析 → buildCallGraph + walkChain 取传递闭包调用链
 *  2. 自动包装：动态加载模块，对链上类方法做原型包装、对导出自由函数做导出包装
 *     —— 无需手动埋探针，内部 this.method() 调用也会被拦截
 *  3. 真实执行：调 entryFn(input)，包装器自动记录每个函数的调用/输入/输出/耗时
 *  4. 自动算 token：行数 × tokensPerLine 估算
 *  5. 自动折叠：累积 token 超 budget.max_tokens × fold_at 阈值 → 自动记录折叠点
 *  6. 产出 reasoning DSL（含自动生成的 geometry 节点），每次运行重算 → 随代码更新
 *
 * 边界：包装拦截的是「经由模块导出 / 类原型」调用的链上函数；
 * module 内部自由函数之间的直接闭包调用（非导出、非 this 调用）v1 不拦截。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFileFull } from './ts_kernel/index.js';
import type { ParsedSymbol } from './ts_kernel/kernel.js';
import type { DesignDSL } from '../dsl/types.js';
import type {
  ReasoningSystem,
  ReasoningStep,
  ReasoningFold,
  ReasoningStepKind,
} from '../dsl/reasoning.js';
import { buildCallGraph, pickEntry, walkChain } from './derive_chain.js';

export interface TraceReasoningInput {
  /** 入口文件（绝对路径，或相对 projectRoot） */
  entryFile: string;
  /** 入口函数名（缺省自动推导 pickEntry） */
  entryFn?: string;
  /** 传给入口函数的输入 */
  input?: unknown;
  /** token 预算（缺省 max_tokens=8000, fold_at=0.8） */
  budget?: { max_tokens?: number; fold_at?: number };
  /** 项目根（解析相对 entryFile 用），默认 process.cwd() */
  projectRoot?: string;
  /** 入链函数上限，默认 12 */
  max_steps?: number;
  /** 每行估算 token 数，默认 2 */
  tokensPerLine?: number;
  /** DSL 标题 */
  title?: string;
  /** 产出 DSL 的 feature 名 */
  feature?: string;
  /** 可选：trace 落盘路径（跑完把原始 TraceRecord[] 写到该文件，供 L4 证据回溯复算） */
  traceFile?: string;
}

export interface TraceRecord {
  step: number;
  name: string;
  qualified_name: string;
  kind: ReasoningStepKind;
  tokens: number;
  reasoning: string;
  duration_ms: number;
  args: unknown;
  result: unknown;
}

export interface TraceReasoningResult {
  /** 完整 DSL：自动生成的 geometry（每函数一节点，垂直排布）+ reasoning */
  dsl: DesignDSL;
  /** 原始记录（含 args/result/耗时） */
  trace: TraceRecord[];
  counts: { steps: number; folds: number; total_tokens: number };
}

const DEFAULT_BUDGET = { max_tokens: 8000, fold_at: 0.8 };
const DEFAULT_TOKENS_PER_LINE = 2;

/** 名称 → 合法 node id */
function sanitize(s: string): string {
  return s.replace(/[^\w]/g, '_');
}

/** 把值转成简短可读的 reasoning 摘要 */
function summarize(value: unknown, maxLen = 120): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return value.length > maxLen ? value.slice(0, maxLen) + '…' : value;
  try {
    const json = JSON.stringify(value);
    if (!json) return String(value);
    return json.length > maxLen ? json.slice(0, maxLen) + '…' : json;
  } catch {
    return String(value);
  }
}

/** 在模块导出里递归找一个 Class：其 prototype 上含 methodName（类名匹配 className） */
function findClassInExports(
  ns: Record<string, unknown>,
  className: string,
  methodName: string,
): { ctor: new (...a: unknown[]) => unknown; proto: Record<string, unknown> } | null {
  const seen = new Set<object>();
  const found: Array<new (...a: unknown[]) => unknown> = [];
  const visit = (obj: unknown): void => {
    // 函数（class/构造函数）typeof 是 'function' 而非 'object'，必须放行
    if (
      !obj ||
      (typeof obj !== 'object' && typeof obj !== 'function') ||
      seen.has(obj as object)
    )
      return;
    seen.add(obj as object);
    // obj 本身是类/构造函数：其 prototype 上有 methodName
    if (typeof obj === 'function' && (obj as { prototype?: unknown }).prototype) {
      const p = (obj as { prototype: Record<string, unknown> }).prototype;
      if (typeof p[methodName] === 'function') {
        if (!className || (obj as { name?: string }).name === className)
          found.push(obj as new (...a: unknown[]) => unknown);
      }
    }
    for (const v of Object.values(obj)) visit(v);
  };
  visit(ns);
  // 精确类名优先；找不到再退回任意含该方法的类
  const ctor =
    (className ? found.find((c) => (c as { name?: string }).name === className) : undefined) ??
    found[0];
  if (!ctor) return null;
  return { ctor, proto: (ctor as { prototype: Record<string, unknown> }).prototype };
}

/** 加载模块并包装链上函数，返回模块命名空间 + 包装后的自由函数表 */
async function loadAndWrap(
  absFile: string,
  chain: ParsedSymbol[],
  tracer: Tracer,
): Promise<{ mod: Record<string, unknown>; freeFns: Map<string, (...a: unknown[]) => unknown> }> {
  const url = pathToFileURL(absFile).href;
  const mod = (await import(url)) as Record<string, unknown>;
  // ESM 模块命名空间冻结只读，不能给 mod[name] 重新赋值；
  // 方法原型可变（instance.method() 走原型，可拦截内部 this 调用），自由函数在此仅登记、调用点包装。
  const freeFns = new Map<string, (...a: unknown[]) => unknown>();
  const wrapped = new Set<string>();

  for (const sym of chain) {
    // 方法：定位类原型并包装（能拦截内部 this.method() 调用）
    if (sym.kind === 'method') {
      const className = sym.parent;
      const methodName = sym.name;
      const found = findClassInExports(mod, className ?? '', methodName);
      if (found && typeof found.proto[methodName] === 'function') {
        const orig = found.proto[methodName] as (...a: unknown[]) => unknown;
        found.proto[methodName] = tracer.wrap(sym, orig);
        wrapped.add(sym.qualified_name);
      }
      continue;
    }
    // 自由函数：登记原导出，调用点用 tracer 包装后执行
    if (typeof mod[sym.name] === 'function') {
      freeFns.set(sym.qualified_name || sym.name, mod[sym.name] as (...a: unknown[]) => unknown);
      wrapped.add(sym.qualified_name);
    }
  }
  // 记录包装明细（供调试/日志）
  tracer.wrapped = [...wrapped];
  return { mod, freeFns };
}

/** 执行记录器 */
class Tracer {
  records: TraceRecord[] = [];
  wrapped: string[] = [];
  private stepNo = 0;

  wrap(sym: ParsedSymbol, orig: (...a: unknown[]) => unknown): (...a: unknown[]) => unknown {
    const self = this;
    return function (this: unknown, ...args: unknown[]) {
      const step = ++self.stepNo;
      const t0 = Date.now();
      const finish = (result: unknown): unknown => {
        const duration = Date.now() - t0;
        self.records.push({
          step,
          name: sym.name,
          qualified_name: sym.qualified_name,
          kind: self.kindOf(sym),
          tokens: self.tokensOf(sym),
          reasoning: `调用 ${sym.signature || sym.name}${args.length ? ` ← ${summarize(args[0])}` : ''}`,
          duration_ms: duration,
          args,
          result,
        });
        return result;
      };
      const r = orig.apply(this, args);
      if (r && typeof (r as Promise<unknown>).then === 'function') {
        return (r as Promise<unknown>).then(finish, (e) => {
          finish(e);
          throw e;
        });
      }
      return finish(r);
    };
  }

  private kindOf(sym: ParsedSymbol): ReasoningStepKind {
    // 粗略：方法带参数 → tool（有输入）；无参数 → think；响应类名 → respond
    if (/^(respond|reply|answer|final|compose|build)/i.test(sym.name)) return 'respond';
    const hasParam = /\(([^)]+)\)/.exec(sym.signature)?.[1]?.trim();
    return hasParam ? 'tool' : 'think';
  }

  private tokensOf(sym: ParsedSymbol): number {
    const lines = Math.max(1, sym.end_line - sym.start_line + 1);
    return lines;
  }
}

/** 主函数 */
export async function traceReasoning(input: TraceReasoningInput): Promise<TraceReasoningResult> {
  const root = input.projectRoot ? path.resolve(input.projectRoot) : process.cwd();
  const absFile = path.isAbsolute(input.entryFile)
    ? input.entryFile
    : path.join(root, input.entryFile);
  if (!fs.existsSync(absFile)) {
    throw new Error(`入口文件不存在: ${absFile}`);
  }
  const content = fs.readFileSync(absFile, 'utf-8');
  const parsed = await parseFileFull(absFile, content);
  if (parsed.error) throw new Error(`解析失败: ${parsed.error}`);

  const symbols = parsed.symbols.filter((s) => s.kind === 'function' || s.kind === 'method');
  if (symbols.length === 0) {
    throw new Error(`未从 ${path.basename(absFile)} 解析到函数/方法`);
  }
  const graph = buildCallGraph(symbols, parsed.calls);
  let entrySym: ParsedSymbol;
  if (input.entryFn) {
    const found = symbols.find((s) => s.name === input.entryFn || s.qualified_name === input.entryFn);
    if (!found) throw new Error(`入口函数 "${input.entryFn}" 在源文件中不存在`);
    entrySym = found;
  } else {
    entrySym = pickEntry(symbols, graph);
  }
  const maxSteps = input.max_steps ?? 12;
  const chain = walkChain(entrySym, symbols, graph).slice(0, maxSteps);

  // 记录 + 包装 + 真实执行
  const tracer = new Tracer();
  const { freeFns } = await loadAndWrap(absFile, chain, tracer);
  const budget = { ...DEFAULT_BUDGET, ...(input.budget ?? {}) };
  const tokensPerLine = input.tokensPerLine ?? DEFAULT_TOKENS_PER_LINE;

  // 调入口函数（自由函数：用 tracer 包装后执行；方法入口 v1 需通过导出实例）
  const rawEntry = freeFns.get(entrySym.qualified_name) ?? freeFns.get(entrySym.name);
  if (typeof rawEntry !== 'function') {
    throw new Error(
      `入口 "${entrySym.name}" 不是导出函数（v1 仅支持导出自由函数作为入口，内部方法调用经原型包装拦截）`,
    );
  }
  const wrappedEntry = tracer.wrap(entrySym, rawEntry);
  await wrappedEntry(input.input);

  // pieces：按 qualified_name 聚合（同一函数可能被多次调用，合并为一步）
  const order = new Map<string, number>();
  chain.forEach((s, i) => order.set(s.qualified_name, i));
  const stepsRaw = new Map<string, TraceRecord>();
  for (const rec of tracer.records) {
    const prev = stepsRaw.get(rec.qualified_name);
    if (!prev || rec.step > prev.step) stepsRaw.set(rec.qualified_name, rec);
  }
  const orderedRecords = [...stepsRaw.values()].sort(
    (a, b) => (order.get(a.qualified_name) ?? 0) - (order.get(b.qualified_name) ?? 0),
  );

  // 生成 geometry 节点（每函数一节点，垂直排布）
  const geometryNodes = orderedRecords.map((r, i) => ({
    id: `fn_${sanitize(r.qualified_name)}`,
    x: 120,
    y: 60 + i * 90,
    width: 320,
    height: 56,
    label: `${i + 1}. ${r.name}`,
    description: r.reasoning,
  }));
  const nodeIdByQn = new Map(orderedRecords.map((r, i) => [r.qualified_name, `fn_${sanitize(r.qualified_name)}`]));

  // 折叠点：累积 token 超 budget × fold_at → summarize 折叠
  const folds: ReasoningFold[] = [];
  const steps: ReasoningStep[] = [];
  let windowStart = 0;
  let cum = 0;
  orderedRecords.forEach((r, i) => {
    const tokens = r.tokens * tokensPerLine;
    cum += tokens;
    steps.push({
      id: `s${i + 1}`,
      node: nodeIdByQn.get(r.qualified_name) ?? `fn_${sanitize(r.qualified_name)}`,
      kind: r.kind,
      tokens,
      reasoning: r.reasoning,
      output: r.result === undefined ? undefined : summarize(r.result),
      api: r.name,
    });
    if (cum > budget.max_tokens * (budget.fold_at ?? 0.8)) {
      const foldedIds = steps.slice(windowStart, i + 1).map((s) => s.id);
      folds.push({
        at_step: i + 1,
        node: nodeIdByQn.get(r.qualified_name) ?? `fn_${sanitize(r.qualified_name)}`,
        kind: 'summarize',
        summary: `前 ${foldedIds.length} 步已折叠（累计 ${cum} token 超预算 ${budget.max_tokens}×${
          budget.fold_at ?? 0.8
        }）`,
        folded: foldedIds,
      });
      windowStart = i + 1;
      cum = 0;
    }
  });

  const reasoning: ReasoningSystem = {
    version: 1,
    entry: {
      label: `输入: ${input.input === undefined ? '(无)' : summarize(input.input)}`,
      node: nodeIdByQn.get(entrySym.qualified_name) ?? `fn_${sanitize(entrySym.qualified_name)}`,
    },
    budget: { max_tokens: budget.max_tokens, fold_at: budget.fold_at },
    steps,
    folds: folds.length > 0 ? folds : undefined,
  };

  // 组装完整 DSL（可渲染、可校验）
  const feature = input.feature ?? 'trace_reasoning';
  const dsl: DesignDSL = {
    id: feature,
    type: 'feature_diagram',
    feature,
    version: '1.0.0',
    title: input.title ?? `Agent 推理痕迹：${path.basename(absFile)}`,
    theme: 'dynamic',
    geometry: {
      layout: 'vertical_flow',
      width: 640,
      height: 60 + orderedRecords.length * 90 + 60,
      nodes: geometryNodes,
    },
    reasoning,
  };

  const totalTokens = steps.reduce((s, x) => s + x.tokens, 0);

  // 可选落盘原始 trace，供 L4 证据回溯复算（<feature>.trace.json 约定）
  if (input.traceFile) {
    const absTrace = path.isAbsolute(input.traceFile)
      ? input.traceFile
      : path.join(root, input.traceFile);
    fs.mkdirSync(path.dirname(absTrace), { recursive: true });
    fs.writeFileSync(
      absTrace,
      JSON.stringify(
        { feature, generated_at: new Date().toISOString(), records: tracer.records },
        null,
        2,
      ),
      'utf-8',
    );
  }

  return {
    dsl,
    trace: tracer.records,
    counts: { steps: steps.length, folds: folds.length, total_tokens: totalTokens },
  };
}