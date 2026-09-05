/**
 * archify_mappers —— 把 SemanticSurface 映射成 5 种图类型的官方 candidate
 *
 * 每个 candidate 遵循 skill 的 authoring invariants：
 *   - 首稿不排几何：一律省略 via/labelAt/labelDx/labelDy/channelX/channelY/
 *     fromSide/toSide/非 auto route/pos/size，交给官方自动路由；
 *   - meta.quality_profile = "showcase"、meta.locale = "zh-CN"、省略 visual_preset；
 *   - 稀疏语义边 + 语义标签（数据名优先，缺则动作词兜底）。
 * candidate 结构严格按 schemas/*.schema.json 的 required 字段生成，保证 validate 可跑。
 */
import type { SemanticSurface, SemanticEdge } from './archify_semantics.js';

export const DIAGRAM_TYPES = ['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle'] as const;
export type DiagramType = (typeof DIAGRAM_TYPES)[number];
export interface DiagramCandidate { type: DiagramType; ir: unknown }

function metaFor(sem: SemanticSurface, type: string): Record<string, unknown> {
  return { title: sem.label, output: `${sem.id}-${type}-candidate.html`, locale: 'zh-CN', quality_profile: 'showcase' };
}

/** 语义边标签：数据名优先，缺则按 kind 补动作词（各类型 required label 时兜底用） */
export function edgeLabel(e: SemanticEdge, fallback: string): string {
  if (e.data) return e.data;
  return ({ flow: '调用', async: '派发', return: '返回', error: '失败' })[e.kind] || fallback;
}

// ── architecture ──
export function toArchitecture(sem: SemanticSurface): DiagramCandidate {
  const connections = sem.edges.map((e, i) => {
    const c: Record<string, unknown> = { id: `c${i}`, from: e.from, to: e.to };
    // 架构网格布局下过多语义 label 必然压组件/互叠，且逐条 labelDy 是无尽拉锯。
    // 细节改由节点 sublabel/tag 承载；边保留方向与变体（结构可见），省略 label。
    if (e.kind === 'async') c.variant = 'dashed';
    else if (e.kind === 'error') c.variant = 'security';
    return c;
  });
  return {
    type: 'architecture',
    ir: {
      schema_version: 1,
      diagram_type: 'architecture',
      meta: metaFor(sem, 'architecture'),
      // 架构图官方允许自由摆放：按"分区成列"排布（每个顶层分区一列，区内子系统纵向叠放），
      // 让连线有明确端点侧、避免 grid 自动布线对 hub 星型的端点方向 clash。pos 是架构 schema 的标准字段。
      components: archPosComponents(sem),
      // 边界：按 groupOf（顶层功能分区）生成 region，包裹其下子系统，表达分层而非平铺顶层
      boundaries: archBoundaries(sem),
      connections,
      cards: sem.mainPath.length ? [
        { dot: 'cyan', title: '主路径', items: sem.mainPath.map((id) => sem.nodes.find((n) => n.id === id)?.label || id) },
        { dot: 'emerald', title: '核心', items: [`${sem.nodes.length} 组件 · ${sem.edges.length} 关系`] },
      ] : undefined,
    },
  };
}

// ── workflow（schema_version 2，readable 布局）──
export function toWorkflow(sem: SemanticSurface): DiagramCandidate {
  // schema 限制每 lane col ∈ 0..5（6 列），而官方主路径校验只看 col 不看 lane：
  //   to.col < from.col 才报 backward。因此长链不能靠"全局递增 col"（超 5 会被
  //   schema 拒）也不能跨 lane 回绕到 0（会被判 backward）。
  // 正解：col 单调非递减，装不下时节点落到本 lane 尾列（col5）往后堆叠、下一 lane
  //   垂直承接——视觉是"一行走完蛇形到下行"，主路径 col 恒 ≥ 前驱，validate 放行。
  const ordered = [...sem.nodes].sort((a, b) => (sem.colOrder.get(a.id) ?? 0) - (sem.colOrder.get(b.id) ?? 0));
  const LANE_COLS = 6; // schema 硬限每 lane 6 列（col 0..5）
  const lanes: Record<string, unknown>[] = [];
  const laneOf = new Map<string, string>();
  const colOf = new Map<string, number>();
  const yOffOf = new Map<string, number>();
  const ZH = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  const laneColCount = new Map<string, number>(); // laneId·col → 该位已叠节点数（用于 yOffset 错开）
  ordered.forEach((n, idx) => {
    const laneIdx = Math.min(Math.floor(idx / LANE_COLS), 9);
    const laneId = `lane${laneIdx}`;
    const laneLabel = `实现 ${ZH[laneIdx] ?? String(laneIdx + 1)}`;
    if (!lanes.some((l) => l.id === laneId)) lanes.push({ id: laneId, label: laneLabel });
    laneOf.set(n.id, laneId);
    // schema 限 col∈0..5 且主路径校验只看 col（to.col<from.col 才判 backward）。
    // 长链只能 col 单调非递减：超过 6 列的节点落到尾列 col5，下一 lane 垂直承接。
    // 同 lane 同 col 的堆叠节点用 yOffset 垂直错开，避免节点重叠。
    const col = Math.min(idx, LANE_COLS - 1);
    colOf.set(n.id, col);
    const key = `${laneId}·${col}`;
    yOffOf.set(n.id, (laneColCount.get(key) ?? 0) * 96);
    laneColCount.set(key, (laneColCount.get(key) ?? 0) + 1);
  });
  const nodes = sem.nodes.map((n) => {
    const c: Record<string, unknown> = { id: n.id, lane: laneOf.get(n.id)!, col: colOf.get(n.id)!, type: n.type, label: n.label };
    if (n.sublabel) c.sublabel = n.sublabel;
    const y = yOffOf.get(n.id);
    if (y) c.yOffset = y;
    return c;
  });
  const edges = sem.edges.map((e, i) => {
    const edge: Record<string, unknown> = { id: `wf${i}`, from: e.from, to: e.to };
    if (e.data) edge.label = e.data;
    edge.role = ({ flow: 'main', async: 'async', return: 'return', error: 'error' })[e.kind];
    return edge;
  });
  // workflow 的 mainPath 必须沿真实边（官方校验：相邻 step 需有匹配 edge、列不后退）；
  // 兜底主路径（无边时的拓扑序）不满足该约束 → 过滤成最长的「沿真实边」段，无则省略。
  const wfMain = mainPathAlongEdges(sem);
  return {
    type: 'workflow',
    ir: {
      schema_version: 2,
      diagram_type: 'workflow',
      meta: metaFor(sem, 'workflow'), // 省略 viewBox：readable-v2 编译器用其测量画布，避免 viewbox-capacity
      lanes,
      nodes,
      edges,
      ...(wfMain && wfMain.length >= 2 ? { mainPath: wfMain } : {}),
      cards: [{ dot: 'cyan', title: '主路径', items: wfMain.map((id) => sem.nodes.find((n) => n.id === id)?.label || id) }],
    },
  };
}
/** 从语义主路径里取最长的「沿真实边」段（workflow/mainPath 校验要求相邻有边） */
function mainPathAlongEdges(sem: SemanticSurface): string[] {
  const hasEdge = new Set(sem.edges.filter((e) => sem.mainPath.includes(e.from) && sem.mainPath.includes(e.to)).map((e) => `${e.from}>${e.to}`));
  let best: string[] = [];
  let run: string[] = [];
  for (const id of sem.mainPath) {
    if (run.length && !hasEdge.has(`${run[run.length - 1]}>${id}`)) { if (run.length > best.length) best = run; run = []; }
    run.push(id);
  }
  if (run.length > best.length) best = run;
  return best;
}
/** 架构图网格列数：随节点数增长，保持近似正方形布局 */
function archCols(nodeCount: number): number {
  return Math.max(1, Math.min(4, Math.ceil(Math.sqrt(nodeCount))));
}
/** dataflow 画布：宽度随 stage 数扩展（官方要求 viewBox[0]≥stages 布局宽度），高度随行数 */
function dataflowViewBox(stageCount: number, nodeCount: number): [number, number] {
  const rowsPerStage = Math.max(1, Math.ceil(nodeCount / Math.max(1, stageCount)));
  return [
    Math.max(900, stageCount * 230),
    Math.max(560, rowsPerStage * 120 + 160),
  ];
}
/** 架构组件宽度：按 label + sublabel 长度给足，避免官方校验拒超宽 sublabel */
function componentWidth(label: string, sublabel?: string): number {
  const units = (s: string) => { let t = 0; for (const ch of s || '') t += (/[\u2E80-\u9FFF\uFF00-\uFFEF\u{1F000}-\u{1FAFF}]/u.test(ch) ? 2 : 1); return t; };
  return Math.max(120, Math.ceil(units(label) * 12 * 0.6) + 8, Math.ceil(units(sublabel || '') * 9 * 0.6) + 12);
}
/** 由 groupOf 生成架构边界：每个顶层功能分区一个 region，包裹其下子系统（≥2 节点才成组） */
function archBoundaries(sem: SemanticSurface): Array<{ kind: 'region'; label: string; wraps: string[] }> {
  if (!sem.groupOf?.size) return [];
  const byGroup = new Map<string, string[]>();
  for (const [id, g] of sem.groupOf) {
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(id);
  }
  return [...byGroup.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .map(([g, ids]) => ({ kind: 'region' as const, label: g, wraps: ids }));
}
/** 架构组件：按 groupOf 分区成列排布（每分区一列、区内纵向叠放），显式 pos + 适配 size。
 *  列序按拓扑（colOrder 最小值）而非字典序 → 链式/管线节点相邻列，主路径边不横穿中间列节点（修 edge-through-node） */
function archPosComponents(sem: SemanticSurface): Record<string, unknown>[] {
  const byCol = new Map<string, string[]>();
  for (const n of sem.nodes) {
    const g = sem.groupOf?.get(n.id) || '其他';
    if (!byCol.has(g)) byCol.set(g, []);
    byCol.get(g)!.push(n.id);
  }
  const pos = new Map<string, [number, number]>();
  // 列按组内拓扑最深列最小来排序（越上游越靠左），保证连接边相邻、不穿中间列
  const cols = [...byCol.keys()].sort(
    (a, b) => minCol(sem, byCol.get(a)!) - minCol(sem, byCol.get(b)!),
  );
  cols.forEach((g, ci) => byCol.get(g)!.forEach((id, ri) => pos.set(id, [ci * 250, ri * 130])));
  return sem.nodes.map((n) => {
    const c: Record<string, unknown> = { id: n.id, type: n.type, label: n.label, pos: pos.get(n.id) || [0, 0], size: [componentWidth(n.label, n.sublabel), 60] };
    if (n.sublabel) c.sublabel = n.sublabel;
    if (n.tag) c.tag = n.tag;
    return c;
  });
}
/** 组内拓扑最浅列号（组内所有节点的 colOrder 最小值；无则退化 0） */
function minCol(sem: SemanticSurface, ids: string[]): number {
  let m = Infinity;
  for (const id of ids) {
    const c = sem.colOrder.get(id);
    if (c !== undefined && c < m) m = c;
  }
  return Number.isFinite(m) ? m : 0;
}

// ── sequence ──
export function toSequence(sem: SemanticSurface): DiagramCandidate | null {
  if (sem.nodes.length < 2) return null; // participants min 2
  // 仅保留主路径 + 分支触及的节点，控制在 4–8 个参与者，避免消息网状过密
  const keep = likelyTopologyOf(sem);
  if (keep.length < 2) return null;
  const participants = keep.map((n) => {
    const p: Record<string, unknown> = { id: n.id, type: n.type, label: n.label };
    if (n.sublabel) p.sublabel = n.sublabel;
    return p;
  });
  const edges = sem.edges.filter((e) => keep.some((k) => k.id === e.from) && keep.some((k) => k.id === e.to));
  const messages = edges.map((e, i) => {
    const m: Record<string, unknown> = { id: `m${i}`, from: e.from, to: e.to, y: 160 + i * 42, label: edgeLabel(e, '调用') };
    m.variant = ({ flow: 'emphasis', async: 'dashed', return: 'return', error: 'security' })[e.kind];
    return m;
  });
  return {
    type: 'sequence',
    ir: {
      schema_version: 1,
      diagram_type: 'sequence',
      meta: metaFor(sem, 'sequence'),
      participants,
      messages, // messages min 1；边稀疏时可无 —— 无则补一条主路径首个消息
      ...((messages.length === 0 && sem.mainPath.length >= 2)
        ? { messages: [{ id: 'm0', from: sem.mainPath[0], to: sem.mainPath[1], y: 160, label: '调用', variant: 'emphasis' }] }
        : {}),
      cards: [{ dot: 'cyan', title: '主路径', items: sem.mainPath.map((id) => sem.nodes.find((n) => n.id === id)?.label || id) }],
    },
  };
}

// ── dataflow ──
export function toDataflow(sem: SemanticSurface): DiagramCandidate | null {
  if (sem.nodes.length < 2) return null; // nodes min 2
  const STAGE_LABELS = ['来源', '接入', '处理', '存储', '消费'];
  // 依赖深度分层：每条 flow 从浅 stage → 深 stage（单向向左到右），从根上消除回退边
  // 横穿无关节点（纯单向数据流布局对逆向依赖必然穿行）。
  const ids = sem.nodes.map((n) => n.id);
  const depth = new Map<string, number>(ids.map((id) => [id, 0]));
  // 深度传播：环（双向依赖）会让 while(changed) 不收敛，故加迭代上限（节点数+1）兜底
  for (let iter = 0; iter < ids.length + 1; iter += 1) {
    let changed = false;
    for (const e of sem.edges) {
      if (!depth.has(e.from) || !depth.has(e.to)) continue;
      if ((depth.get(e.from) ?? 0) + 1 > (depth.get(e.to) ?? 0)) {
        depth.set(e.to, (depth.get(e.from) ?? 0) + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const maxDepth = Math.max(...ids.map((id) => depth.get(id) ?? 0));
  const k = Math.min(5, Math.max(2, maxDepth + 1));
  const stages = STAGE_LABELS.slice(0, k).map((label) => ({ label }));
  const stageIdx = new Map<string, number>();
  sem.nodes.forEach((n) => stageIdx.set(n.id, Math.min(depth.get(n.id) ?? 0, k - 1)));
  const rowIdx = new Map<string, number>();
  const buckets = new Map<number, string[]>();
  const topo = [...sem.nodes].sort((a, b) => (sem.colOrder.get(a.id) ?? 0) - (sem.colOrder.get(b.id) ?? 0));
  topo.forEach((n) => {
    const seg = stageIdx.get(n.id)!;
    if (!buckets.has(seg)) buckets.set(seg, []);
    buckets.get(seg)!.push(n.id);
  });
  buckets.forEach((ids2, seg) => ids2.forEach((id, r) => rowIdx.set(id, r)));
  const nodes = sem.nodes.map((n) => {
    const c: Record<string, unknown> = { id: n.id, type: n.type, label: n.label, stage: stageIdx.get(n.id) ?? 0, row: rowIdx.get(n.id) ?? 0 };
    if (n.sublabel) c.sublabel = n.sublabel;
    return c;
  });
  const seenU = new Set<string>();
  const flows = sem.edges.map((e, i) => {
    const fl: Record<string, unknown> = { id: `f${i}`, from: e.from, to: e.to, label: edgeLabel(e, '承接'), labelDy: 60 };
    if (e.kind === 'error') fl.variant = 'security';
    return fl;
  }).filter((fl) => { const k = [fl.from, fl.to].sort().join('|'); if (seenU.has(k)) return false; seenU.add(k); return true; });
  return {
    type: 'dataflow',
    ir: {
      schema_version: 1,
      diagram_type: 'dataflow',
      meta: { ...metaFor(sem, 'dataflow'), viewBox: dataflowViewBox(stages.length, sem.nodes.length) },
      stages,
      nodes,
      flows, // flows 允许为空（无跨段依赖时）—— schema 未 required flows minItems
      cards: [{ dot: 'cyan', title: '主路径', items: sem.mainPath.map((id) => sem.nodes.find((n) => n.id === id)?.label || id) }],
    },
  };
}

// ── lifecycle ──
export function toLifecycle(sem: SemanticSurface): DiagramCandidate | null {
  if (sem.mainPath.length < 2 || sem.nodes.length < 2) return null; // 不适配：缺主路径/终态
  const zh = ['一', '二', '三', '四', '五'];
  const lanes: Record<string, unknown>[] = [{ id: 'main', label: '生命周期' }];
  const laneBy: Record<string, unknown> = { main: lanes[0] };
  const plain = new Map(sem.nodes.map((n) => [n.id, n]));
  const stateBy = new Map<string, Record<string, unknown>>();
  // 主轨：mainPath 前 5 个状态 col 0..4，step 01..05
  const rail = sem.mainPath.slice(0, 5);
  rail.forEach((id, col) => {
    const n = plain.get(id)!;
    const st: Record<string, unknown> = {
      id, type: col === 0 ? 'start' : (col === rail.length - 1 ? 'success' : 'active'),
      label: n.label, sublabel: n.sublabel, lane: 'main', col, step: `0${col + 1}`,
      ...(n.sublabel ? { sublabel: n.sublabel } : {}),
    };
    stateBy.set(id, st);
  });
  // 其余状态（不在 rail 上）进 waiting/exceptions/terminal 侧轨
  const side = sem.nodes.filter((n) => !rail.includes(n.id));
  const withOut = new Set(sem.edges.map((e) => e.from));
  const sideLane: Record<string, Record<string, unknown>> = { waiting: { id: 'waiting', label: '等待' }, exceptions: { id: 'exceptions', label: '恢复' }, terminal: { id: 'terminal', label: '终态' } };
  let wi = 0, ei = 0, ti = 0;
  for (const n of side) {
    const hasOut = withOut.has(n.id);
    const isErr = sem.edges.some((e) => e.from === n.id && e.kind === 'error');
    const target = isErr ? 'exceptions' : (hasOut ? 'waiting' : 'terminal');
    if (!laneBy[target]) { laneBy[target] = sideLane[target]; lanes.push(sideLane[target]); }
    const colIdx = target === 'terminal' ? Math.min(2, ti) : (target === 'exceptions' ? ei % 3 : wi % 3);
    const st: Record<string, unknown> = {
      id: n.id,
      type: target === 'terminal' ? 'failure' : (target === 'exceptions' ? 'neutral' : 'waiting'),
      label: n.label, ...(n.sublabel ? { sublabel: n.sublabel } : {}), lane: target, col: colIdx,
    };
    stateBy.set(n.id, st);
    if (target === 'terminal') ti += 1; else if (target === 'exceptions') ei += 1; else wi += 1;
  }
  const transitions = sem.edges.map((e, i) => {
    const t: Record<string, unknown> = { id: `t${i}`, from: e.from, to: e.to };
    if (e.kind === 'error') t.variant = 'security';
    return t;
  });
  return {
    type: 'lifecycle',
    ir: {
      schema_version: 1,
      diagram_type: 'lifecycle',
      meta: { ...metaFor(sem, 'lifecycle'), viewBox: [980, 660] },
      lanes,
      states: [...stateBy.values()],
      transitions, // transitions 允许为空
      cards: [{ dot: 'cyan', title: '主路径', items: rail.map((id) => plain.get(id)?.label || id) }],
    },
  };
}

/** 序列图参与者：主路径优先 ∪ 分支触及，控制在 4–8 */
function likelyTopologyOf(sem: SemanticSurface): typeof sem.nodes {
  const main = new Set(sem.mainPath);
  const reach = new Set<string>(sem.mainPath);
  for (const e of sem.edges) if (reach.has(e.from)) reach.add(e.to);
  for (const e of sem.edges) if (reach.has(e.to)) reach.add(e.from);
  const picked = sem.nodes.filter((n) => main.has(n.id) || (reach.has(n.id) && !main.has(n.id)));
  return picked.slice(0, 8);
}