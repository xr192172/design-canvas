/**
 * deriveReasoning 生成器：把「Go 编译期插桩采集的 trace JSON」转成 ReasoningSystem DSL，
 * 作为函数级仿真（数据流转 + 上下文折叠）的原材料。
 *
 * 输入：AI base 项目 context/v2 引擎跑 N 轮长任务，tracecap 落盘的
 *   { version, rounds, root, records: [{ id, parent, fn, file, line, args, result, tokens, depth, order }] }
 *
 * 处理：
 *  1. 按 BeginRound 切分：初始化阶段 + 每轮一个阶段
 *  2. 阶段内按 fn 聚合（重复调用合并为一步，保留调用次数/累计 token/首末入出参）
 *  3. 用 parent 链重建调用树（父步骤序号/深度）
 *  4. 在真实 PulseEvict 调用处打折叠点（fold > folded 折叠该阶段自上次折叠以来的步骤）
 *  5. 产出合法可校验的 DesignDSL（geometry 每步一节点 + reasoning）
 *
 * 用法：deriveReasoning({ tracePath, feature, title, budget })
 */

import fs from 'node:fs';
import type { DesignDSL } from '../dsl/types.js';
import type {
  ReasoningSystem,
  ReasoningStep,
  ReasoningFold,
  ReasoningStepKind,
} from '../dsl/reasoning.js';

/** Go tracecap 落盘的单帧调用 */
export interface TraceFrame {
  id: number;
  parent: number;
  fn: string;
  file: string;
  line: number;
  args?: string;
  result?: string;
  tokens: number;
  depth: number;
  order: number;
  meta?: { round?: number };
}

/** Go tracecap 落盘的完整 trace */
export interface GoTrace {
  version: number;
  rounds: number;
  root: string;
  records: TraceFrame[];
}

export interface DeriveReasoningInput {
  /** trace JSON 绝对路径 */
  tracePath: string;
  /** 产出 DSL 的 feature 名 */
  feature?: string;
  /** DSL 标题 */
  title?: string;
  /** token 预算（缺省 max_tokens=131072 GPT4o 窗口, fold_at=0.8） */
  budget?: { max_tokens?: number; fold_at?: number };
  /** 只取前 N 轮（缺省全部） */
  rounds?: number;
  /** 入参/出参 recap 截断长度，默认 140 */
  cap?: number;
}

export interface DeriveReasoningResult {
  dsl: DesignDSL;
  counts: { steps: number; folds: number; total_tokens: number; rounds: number; unique_fns: number };
}

/** 名称 → 合法 node id */
function sanitize(s: string): string {
  return s.replace(/[^\w]/g, '_');
}

/** 截断 recap 成可读有限长度 */
function truncate(s: string | undefined, cap: number): string | undefined {
  if (!s) return s;
  return s.length > cap ? s.slice(0, cap) + '…' : s;
}

/** 根据函数名粗略推断步骤类型（think/tool/respond/fold） */
function kindOf(fn: string): ReasoningStepKind {
  if (/PulseEvict|Evict|Collapse|Summarize|Fold/i.test(fn)) return 'fold';
  if (/^(v2\.)?(Assemble|Compose|Build|Respond|Reply|Answer|Final|Draft)/i.test(fn)) return 'respond';
  // 纯内部辅助（token 计数/哈希/格式化）→ think；其余有数据进出 → tool
  if (/TokenCounter|fnv|format|estimate|hash|wrapToken|Count$/i.test(fn)) return 'think';
  return 'tool';
}

/** 解析 trace JSON */
export function loadTrace(tracePath: string): GoTrace {
  const raw = fs.readFileSync(tracePath, 'utf-8');
  const t = JSON.parse(raw) as GoTrace;
  if (!Array.isArray(t.records)) throw new Error(`trace 缺少 records 数组: ${tracePath}`);
  return t;
}

/** 阶段内聚合步骤（按 fn 合并，保留调用树父子/深度/次数/累计 token） */
interface AggStep {
  fn: string;
  depth: number;
  parent: number; // 步骤索引（0=根）
  order: number;
  calls: number;
  tokens: number;
  args?: string;
  result?: string;
  line: number;
}

function buildSteps(records: TraceFrame[], cap: number): { steps: AggStep[]; frameToStep: Map<number, number> } {
  const steps: AggStep[] = [];
  const keyIndex = new Map<string, number>();
  const frameToStep = new Map<number, number>();
  for (const rec of records) {
    if (rec.fn === 'tracecap' || rec.fn === 'context-trace') continue;
    let idx = keyIndex.get(rec.fn);
    if (idx === undefined) {
      const parentStep = rec.parent === 0 || rec.parent === rec.id ? 0 : (frameToStep.get(rec.parent) ?? 0);
      idx = steps.length;
      keyIndex.set(rec.fn, idx);
      steps.push({
        fn: rec.fn,
        depth: rec.depth,
        parent: parentStep,
        order: rec.order,
        calls: 1,
        tokens: rec.tokens,
        args: truncate(rec.args, cap),
        result: truncate(rec.result, cap),
        line: rec.line,
      });
    } else {
      const s = steps[idx];
      s.calls += 1;
      s.tokens += rec.tokens;
      if (rec.result) s.result = truncate(rec.result, cap);
      if (rec.depth < s.depth) s.depth = rec.depth;
      if (rec.tokens === 0 && s.args) s.args = s.args; // no-op 保持首次入参
    }
    frameToStep.set(rec.id, idx);
  }
  return { steps, frameToStep };
}

/** 主函数 */
export function deriveReasoning(input: DeriveReasoningInput): DeriveReasoningResult {
  const trace = loadTrace(input.tracePath);
  const cap = input.cap ?? 140;
  const maxRounds = input.rounds ?? trace.rounds;

  // 1) 按 BeginRound 切分阶段
  const beginIdx: number[] = [];
  trace.records.forEach((r, i) => {
    if (/BeginRound|\.BeginRound/i.test(r.fn)) beginIdx.push(i);
  });

  interface Phase {
    label: string;
    round: number;
    records: TraceFrame[];
  }
  const phases: Phase[] = [];
  // 初始化阶段（首个 BeginRound 之前）
  const firstBegin = beginIdx.length > 0 ? beginIdx[0] : trace.records.length;
  if (firstBegin > 0) phases.push({ label: '0. 引擎初始化', round: 0, records: trace.records.slice(0, firstBegin) });
  // 每轮一个阶段
  beginIdx.forEach((b, i) => {
    if (i >= maxRounds) return;
    const end = i + 1 < beginIdx.length ? beginIdx[i + 1] : trace.records.length;
    phases.push({ label: `第 ${i + 1} 轮`, round: i + 1, records: trace.records.slice(b, end) });
  });

  // 2) 逐阶段聚合步骤 → 全局 steps
  const steps: ReasoningStep[] = [];
  const nodeIds: string[] = []; // 索引对齐 steps
  let stepSeq = 0;
  for (const ph of phases) {
    const { steps: aggSteps } = buildSteps(ph.records, cap);
    for (const a of aggSteps) {
      stepSeq += 1;
      const sid = `s${stepSeq}`;
      const nodeId = `fn_${stepSeq}_${sanitize(a.fn)}`;
      steps.push({
        id: sid,
        node: nodeId,
        kind: kindOf(a.fn),
        tokens: a.tokens,
        input: a.args,
        reasoning: `${a.fn}${a.calls > 1 ? `（聚合 ${a.calls} 次调用）` : ''}`,
        output: a.result,
        api: a.fn,
        parent: a.parent,
        depth: a.depth,
        order: a.order,
        calls: a.calls,
        round: ph.round,
        args: a.args,
        result: a.result,
      });
      nodeIds.push(nodeId);
    }
  }

  // 3) 在真实 PulseEvict 处打折叠点
  const folds: ReasoningFold[] = [];
  let boundary = 0;
  trace.records.forEach((r) => {
    if (!/PulseEvict|Evict|Collapse/i.test(r.fn)) return;
    // 定位该调用合并到的全局步骤
    let target = -1;
    for (let i = steps.length - 1; i >= 0; i--) {
      if ((steps[i].api === r.fn) && steps[i].order! <= r.order) { target = i; break; }
    }
    if (target < 0) return;
    // folded 只含 PulseEvict 之前的步骤（保留 PulseEvict 步骤本身作为折叠触发标记）
    const range = steps.slice(boundary, target);
    if (range.length === 0) return;
    const folded = range.map((s) => s.id);
    const cum = range.reduce((s, x) => s + x.tokens, 0);
    folds.push({
      at_step: target + 1,
      node: nodeIds[target],
      kind: 'summarize',
      summary: `上下文折叠：最老的 ${range.length} 步（累计 ${cum} token）被 PulseEvict 压缩进 SummaryZone`,
      folded,
    });
    boundary = target + 1;
  });

  // 4) 组装 DSL
  const budget = { max_tokens: input.budget?.max_tokens ?? 131072, fold_at: input.budget?.fold_at ?? 0.8 };
  const reasoning: ReasoningSystem = {
    version: 1,
    entry: {
      label: `入口: ${trace.root}（${trace.rounds} 轮长任务）`,
      node: steps[0]?.node ?? '',
    },
    budget,
    steps,
    folds: folds.length > 0 ? folds : undefined,
  };

  // geometry 节点（每步一节点，分轮纵排；父节点不额外生成，保持简单可校验）
  const geometryNodes = steps.map((s, i) => {
    const depthOffset = (s.depth ?? 0) * 34;
    return {
      id: s.node,
      x: 60 + depthOffset,
      y: 60 + i * 52,
      width: 380,
      height: 44,
      label: `${i + 1}. ${s.api ?? s.node}`,
      description: s.input ?? '',
    };
  });

  const feature = input.feature ?? 'reasoning_trace';
  const dsl: DesignDSL = {
    id: feature,
    type: 'feature_diagram',
    feature,
    version: '1.0.0',
    title: input.title ?? `AI base 上下文引擎函数级仿真（${trace.rounds} 轮）`,
    theme: 'dynamic',
    geometry: {
      layout: 'vertical_flow',
      width: 900,
      height: 60 + steps.length * 52 + 60,
      nodes: geometryNodes,
    },
    reasoning,
  };

  const totalTokens = steps.reduce((s, x) => s + x.tokens, 0);
  return {
    dsl,
    counts: {
      steps: steps.length,
      folds: folds.length,
      total_tokens: totalTokens,
      rounds: phases.length,
      unique_fns: new Set(steps.map((s) => s.api)).size,
    },
  };
}