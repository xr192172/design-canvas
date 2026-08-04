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
