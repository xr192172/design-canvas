/**
 * 数据流追踪核心逻辑（L5a 静态推演，纯逻辑单源）
 *
 * 双消费：被 scripts/gen_anim_core_bundle.mjs 内联进浏览器 IIFE（运行时），
 * 也被 vitest 直接 import（单测）。不依赖 DOM / DSL 类型，只操作普通对象。
 *
 * 语义（v1 静态推演，不执行代码）：
 *   - 用户向入口节点注入一个数据值
 *   - 值沿 detail 层链边（id 含 __chain_）逐步传递：上一步 out → 下一步 in
 *   - 每个节点的 out 由该节点 shapes.out schema 生成 mock 值（无 schema → 继承 in）
 *   - 跳边（id 含 __branch_）不额外建步骤：在途经节点标注"数据分流 → 目标"
 *
 * 判定（if/分支）的精确表达依赖函数内部 CFG（derive_algorithm），
 * 为后续迭代留位：TraceStep.note 与 branchEdgeIds 即分流标注的载体。
 */

// ─────────────────────────────────────────────────────────────
// 类型（普通对象子集，避免依赖 DSL 类型便于内联）
// ─────────────────────────────────────────────────────────────

export interface DfNodeLike {
  id: string;
  label?: string;
  layer?: string;
  host?: string;
  shapes?: { in?: unknown; out?: unknown } | null;
  /** derive_algorithm 生成的 CFG 节点用 style.shape 区分判定形状 */
  style?: { shape?: string; tone?: string } | null;
  description?: string;
}

export interface DfEdgeLike {
  id: string;
  from: string;
  to: string;
  type?: string;
  label?: string;
}

export interface DfTraceStep {
  /** 节点 id */
  nodeId: string;
  /** 节点显示名（label 或 id） */
  label: string;
  /** 进入该节点的数据值 */
  inValue: unknown;
  /** 离开该节点的数据值（mock 推演） */
  outValue: unknown;
  /** 分流/判定说明（跳边途经时标注） */
  note?: string;
}

export interface DfTrace {
  /** 按执行顺序的步骤序列（入口 → 链尾） */
  steps: DfTraceStep[];
  /** 途经的跳边 id（渲染时高亮虚线） */
  branchEdgeIds: string[];
}

// ─────────────────────────────────────────────────────────────
// 判定精确化（CFG 接入）：函数内部 if/loop 的条件原文与走向
// ─────────────────────────────────────────────────────────────

export interface DfJudgementBranch {
  /** 出边 label（是/否/进入/重复/结束…） */
  via: string;
  /** 走向目标节点 label（截断） */
  to: string;
}

export interface DfJudgement {
  /** 条件原文（如 'len(items) > 3'） */
  cond: string;
  /** 判定点节点 id */
  nodeId: string;
  /** 走向分支 */
  branches: DfJudgementBranch[];
}

/**
 * 收集宿主下某函数的 CFG 判定（derive_algorithm 产物，id 前缀 {host}__alg_）。
 * 关联方式：CFG entry 节点 label 为 "▶ {funcName}"（derive_algorithm 生成规则）。
 * 沿出边 BFS 收集 branch（diamond）/ loop（hexagon）节点的条件与走向。
 * v1 只展示真实条件与走向结构，不做 mock 求值（mock 值是假值，求值无意义）。
 */
export function collectJudgements(
  nodes: DfNodeLike[],
  edges: DfEdgeLike[],
  host: string,
  funcName: string,
): DfJudgement[] {
  if (!host || !funcName) return [];
  const algPrefix = host + '__alg_';
  const algEdgePrefix = host + '__alge_';
  const algNodes = nodes.filter((n) => n.id.startsWith(algPrefix));
  if (algNodes.length === 0) return [];
  const nodeById = new Map(algNodes.map((n) => [n.id, n]));

  // entry：label === "▶ {funcName}"
  const entry = algNodes.find((n) => n.label === `▶ ${funcName}`) ?? algNodes.find((n) => (n.label || '').includes(funcName) && (n.label || '').startsWith('▶'));
  if (!entry) return [];

  // 出边索引
  const outEdges = new Map<string, DfEdgeLike[]>();
  for (const e of edges) {
    if (!e.id.startsWith(algEdgePrefix)) continue;
    let arr = outEdges.get(e.from);
    if (!arr) {
      arr = [];
      outEdges.set(e.from, arr);
    }
    arr.push(e);
  }

  const kindOf = (n: DfNodeLike): string => {
    const shape = (n.style as { shape?: string } | undefined)?.shape;
    if (shape === 'diamond') return 'branch';
    if (shape === 'hexagon') return 'loop';
    return '';
  };

  // BFS 从 entry 出发，遇判定节点收集，遇 return/throw/exit 不深入（它们是出口）
  const judgements: DfJudgement[] = [];
  const visited = new Set<string>();
  const queue: string[] = [entry.id];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const kind = kindOf(nodeById.get(cur) ?? ({} as DfNodeLike));
    const n = nodeById.get(cur);
    if (kind === 'branch' || kind === 'loop') {
      if (n) {
        const branches = (outEdges.get(cur) ?? []).map((e) => {
          const t = nodeById.get(e.to);
          const label = (t?.label ?? e.to).replace(/\s+/g, ' ').slice(0, 40);
          return { via: e.label || '', to: label };
        });
        judgements.push({ cond: (n.description ?? '').split('\n').find((l) => l.startsWith('条件：'))?.slice(3) ?? '', nodeId: cur, branches });
      }
      // 判定点也继续深入（嵌套 if/循环内的判定也要收集；visited 防环）
    }
    for (const e of outEdges.get(cur) ?? []) queue.push(e.to);
  }
  return judgements;
}

// ─────────────────────────────────────────────────────────────
// 判定走向选择：注入值 → 扁平 scope → 对条件轻量求值 → 命中走向
// ─────────────────────────────────────────────────────────────

/** 注入值 → 变量查找表（顶层 key + 一层嵌套属性展开，不覆盖顶层） */
export function flattenScope(value: unknown): Record<string, unknown> {
  const scope: Record<string, unknown> = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      scope[k] = v;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
          if (!(k2 in scope)) scope[k2] = v2;
        }
      }
    }
  }
  return scope;
}

export interface EvalResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** 安全非受限求值：用 JS 引擎直接求值条件表达式（完整语法覆盖：方法调用/三元/可选链/正则…）。
 *  隔离（接触不到外界）：new Function + with(env) + Proxy——
 *  - 所有标识符都从 env 取，未匹配抛"未匹配变量：xx"（与受限版报错语义一致）
 *  - 白名单只放纯函数内建（Math/parseInt/JSON/Array/String…，scope 可覆盖），
 *    window/document/fetch/process 等全局访问被阻断 → 无法逃逸
 *  - 条件被包进 return (…) 表达式：语句语法（循环/赋值/声明）直接 SyntaxError，只能算表达式
 *  静态推演边界：函数调用（如 len(items)）仍无法求值——函数实现不在 DSL 里，报"未匹配变量"。
 */
export function evaluateCond(cond: string, scope: Record<string, unknown>): EvalResult {
  try {
    if (!cond || !cond.trim()) return { ok: false, error: '空条件' };
    // 白名单内建（纯函数，无 I/O/副作用）
    const env: Record<string, unknown> = Object.assign(
      {
        Math, JSON, Number, String, Array, Object, Boolean, RegExp, Date,
        parseInt, parseFloat, isNaN, isFinite,
        undefined, NaN, Infinity,
      },
      scope,
    );
    // Proxy 隔离：has 恒 true（标识符不逃逸到全局），get 未匹配即抛
    const sandbox = new Proxy(env, {
      has() { return true; },
      get(t, k) {
        if (typeof k === 'symbol') return undefined;
        if (k in t) return t[k];
        throw new Error(`未匹配变量：${String(k)}`);
      },
    });
    // new Function 函数体默认 sloppy（with 合法），即使外层模块是 strict 模式
    const fn = new Function('env', 'with (env) { return (' + cond + '); }');
    const value = fn(sandbox);
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** 走向分支的 via 标签 → 真/假分支识别（derive_algorithm 生成规则：是/否、进入/重复/结束…） */
const TRUE_VIA = /是|进入|继续|重复|满足|成立/;
const FALSE_VIA = /否|结束|退出|不满足|不成立/;

export interface DfJudgementResult extends DfJudgement {
  /** 是否用注入值成功求值 */
  evaluable: boolean;
  /** 无法求值的原因（未匹配变量 / 不支持语法） */
  error?: string;
  /** 实际走向的分支 via 标签（命中高亮用） */
  chosenVia?: string;
  /** 实际走向的目标节点 label */
  chosenTo?: string;
}

/** 为每个判定做走向选择：注入值 scope 求值 → 真走"是/重复"类分支，假走"否/结束"类分支 */
export function applyJudgements(judgements: DfJudgement[], scope: Record<string, unknown>): DfJudgementResult[] {
  return judgements.map((j) => {
    const r = evaluateCond(j.cond, scope);
    if (!r.ok) return { ...j, evaluable: false, error: r.error };
    const truthy = Boolean(r.value);
    const chosen = j.branches.find((b) => (truthy ? TRUE_VIA : FALSE_VIA).test(b.via));
    return { ...j, evaluable: true, chosenVia: chosen?.via, chosenTo: chosen?.to };
  });
}

// ─────────────────────────────────────────────────────────────
// mock 值生成：schema → 示例值（静态推演的"输出"来源）
// ─────────────────────────────────────────────────────────────

export function mockValue(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return null;
  const s = schema as Record<string, unknown>;
  switch (s.type) {
    case 'string':
      return s.label && s.label !== '任意' ? `示例${s.label}` : '示例文本';
    case 'number':
      return 42.5;
    case 'integer':
      return 7;
    case 'boolean':
      return true;
    case 'null':
      return null;
    case 'array': {
      const item = mockValue(s.items);
      return [item, item];
    }
    case 'object': {
      const props = s.properties as Record<string, unknown> | undefined;
      if (props) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(props)) out[k] = mockValue(v);
        return out;
      }
      const label = typeof s.label === 'string' && s.label && s.label !== '对象' && s.label !== '任意' ? s.label : '示例';
      return { [label]: '值' };
    }
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────
// 轨迹构建：入口节点 → 链式步骤序列 + 分流标注
// ─────────────────────────────────────────────────────────────

function isChainEdge(id: string): boolean {
  return id.includes('__chain_');
}

function isBranchEdge(id: string): boolean {
  return id.includes('__branch_');
}

export function buildDataTrace(
  nodes: DfNodeLike[],
  edges: DfEdgeLike[],
  entryId: string,
  inputValue: unknown,
): DfTrace {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const entry = nodeById.get(entryId);
  if (!entry) return { steps: [], branchEdgeIds: [] };

  // 只处理 detail 层子图（数据流追踪发生在加工链上）
  const host = entry.host;
  const detailEdges = edges.filter((e) => {
    if (!host) return isChainEdge(e.id) || isBranchEdge(e.id);
    // 宿主限定：链边/跳边 id 都以 ${host}__ 为前缀（derive_detail_chain 生成规则）
    return e.id.startsWith(host + '__') && (isChainEdge(e.id) || isBranchEdge(e.id));
  });

  // 链边：线性推进（每节点至多一条出链边；从入口沿出链边走）
  const chainOut = new Map<string, DfEdgeLike>();
  for (const e of detailEdges) {
    if (isChainEdge(e.id)) chainOut.set(e.from, e);
  }
  // 跳边：from → to 列表
  const branchOut = new Map<string, DfEdgeLike[]>();
  for (const e of detailEdges) {
    if (!isBranchEdge(e.id)) continue;
    let arr = branchOut.get(e.from);
    if (!arr) {
      arr = [];
      branchOut.set(e.from, arr);
    }
    arr.push(e);
  }

  // 沿链推进，防止环路（防御：异常数据不该死循环）
  const steps: DfTraceStep[] = [];
  const branchEdgeIds: string[] = [];
  const visited = new Set<string>();
  let curId = entryId;
  let carry = inputValue;
  while (curId && !visited.has(curId)) {
    visited.add(curId);
    const cur = nodeById.get(curId);
    if (!cur) break;

    const outSchema = cur.shapes?.out;
    const outValue = outSchema ? mockValue(outSchema) : carry;
    const note = buildNote(cur, branchOut, nodeById);
    steps.push({
      nodeId: cur.id,
      label: cur.label || cur.id,
      inValue: carry,
      outValue,
      note: note.text,
    });
    for (const e of note.edges) branchEdgeIds.push(e.id);

    // 数据流到下一链节点
    const next = chainOut.get(curId);
    if (!next) break;
    carry = outValue;
    curId = next.to;
  }

  return { steps, branchEdgeIds };
}

/** 当前节点的分流标注：途经的跳边 → "→ 目标label（分支）" */
function buildNote(
  cur: DfNodeLike,
  branchOut: Map<string, DfEdgeLike[]>,
  nodeById: Map<string, DfNodeLike>,
): { text?: string; edges: DfEdgeLike[] } {
  const outs = branchOut.get(cur.id);
  if (!outs || outs.length === 0) return { edges: [] };
  const parts = outs.map((e) => {
    const t = nodeById.get(e.to);
    return t ? `${t.label || t.id}` : e.to;
  });
  return {
    text: `数据分流 → ${parts.join(', ')}（分支）`,
    edges: outs,
  };
}
