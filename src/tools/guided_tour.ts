/**
 * guided_tour —— Guided Tours（路线图序号6）
 *
 * 按依赖边拓扑排序，把一个 feature 的节点排成"先看依赖 → 再看依赖者"的学习路径，
 * 供导览播放器逐个高亮。呼应动画系统"演示文稿"定位——Guided Tour 就是播放列表。
 *
 * 只读，不修改 DSL。复用 dag_layout 的 Kahn 排序思路，但产出"线性学习顺序"
 * （入度先清空的节点先看，即依赖喂给谁、谁就排在依赖之后）。
 */

import { getDSL } from '../storage.js';

export interface GuidedTourInput {
  /** feature 名 */
  feature: string;
  /** 是否展开深层节点（layer=detail/error）进路径，默认 false（只走主干） */
  include_deep?: boolean;
  /** 是否包含目录容器节点（type=module），默认 false（文件/服务才是学习单元） */
  include_containers?: boolean;
  /** 最大步数，默认 40 */
  max_steps?: number;
}

export interface TourStep {
  /** 1-based 步序号 */
  step: number;
  /** 节点 id */
  node_id: string;
  /** 节点 label */
  label: string;
  /** 节点类型 */
  type?: string;
  /** 该节点此刻已就绪的依赖（前面步骤已看过）标签，用于解释"为什么现在看它" */
  deps_seen: string[];
  reason: string;
}

export interface GuidedTourResult {
  feature: string;
  /** 参与排序的节点数 */
  total_nodes: number;
  /** 被截断的节点数（超过 max_steps） */
  truncated: number;
  steps: TourStep[];
  message: string;
}

const isDeep = (layer?: string): boolean => layer !== undefined && layer !== 'main';

export function guidedTour(input: GuidedTourInput): GuidedTourResult {
  const {
    feature,
    include_deep = false,
    include_containers = false,
    max_steps = 40,
  } = input;

  const dsl = getDSL(feature);
  if (!dsl) {
    throw new Error(`feature "${feature}" 不存在`);
  }

  const nodes = dsl.geometry.nodes ?? [];
  const edges = dsl.geometry.edges ?? [];

  // 1. 筛参与节点：跳过深层节点（除非 include_deep）、跳过目录容器（除非 include_containers）
  const participate = new Set<string>();
  for (const n of nodes) {
    if (!include_deep && isDeep(n.layer)) continue;
    if (!include_containers && n.type === 'module') continue;
    participate.add(n.id);
  }
  const partNodes = nodes.filter((n) => participate.has(n.id));
  const labelById = new Map<string, string>();
  for (const n of partNodes) labelById.set(n.id, n.label ?? n.id);

  // 2. 依赖边（限参与节点内；跳过 contains 边）
  const inEdges = new Map<string, string[]>();
  const outEdges = new Map<string, string[]>();
  for (const id of participate) {
    inEdges.set(id, []);
    outEdges.set(id, []);
  }
  for (const e of edges) {
    const l = (e.label ?? '').toLowerCase();
    if (l === 'contains' || l === '包含') continue;
    if (!participate.has(e.from) || !participate.has(e.to)) continue;
    inEdges.get(e.to)!.push(e.from);
    outEdges.get(e.from)!.push(e.to);
  }

  // 3. Kahn 拓扑排序 → 线性学习顺序（依赖先于依赖者）
  const inDegree = new Map<string, number>();
  for (const id of participate) inDegree.set(id, inEdges.get(id)!.length);
  const queue: string[] = [];
  for (const [id, deg] of inDegree) if (deg === 0) queue.push(id);
  // 稳定顺序：按原节点出现顺序出队，保证可复现
  queue.sort((a, b) => partNodes.findIndex((n) => n.id === a) - partNodes.findIndex((n) => n.id === b));

  const order: string[] = [];
  const seen = new Set<string>();
  const depsSeenAt = new Map<string, string[]>();
  while (queue.length > 0) {
    const cur = queue.shift()!;
    order.push(cur);
    seen.add(cur);
    // 记录此时已就绪的依赖（在 seen 中的前驱）
    depsSeenAt.set(cur, inEdges.get(cur)!.filter((p) => seen.has(p)).map((p) => labelById.get(p) ?? p));
    const nexts = outEdges.get(cur) || [];
    for (const nxt of nexts) {
      inDegree.set(nxt, (inDegree.get(nxt) || 0) - 1);
      if (inDegree.get(nxt) === 0) queue.push(nxt);
    }
    queue.sort((a, b) => partNodes.findIndex((n) => n.id === a) - partNodes.findIndex((n) => n.id === b));
  }

  // 4. 环/孤立残留：按原顺序补到末尾
  for (const n of partNodes) {
    if (!seen.has(n.id)) {
      order.push(n.id);
      depsSeenAt.set(n.id, inEdges.get(n.id)!.filter((p) => seen.has(p)).map((p) => labelById.get(p) ?? p));
    }
  }

  // 5. 组装步骤（截断到 max_steps）
  const steps: TourStep[] = order.slice(0, max_steps).map((id, i) => {
    const deps = depsSeenAt.get(id) ?? [];
    const reason = deps.length > 0
      ? `依赖 ${deps.join('、')} 已看过，顺着看它`
      : '无待办依赖，从它起手';
    return {
      step: i + 1,
      node_id: id,
      label: labelById.get(id) ?? id,
      type: partNodes.find((n) => n.id === id)?.type,
      deps_seen: deps,
      reason,
    };
  });

  const truncated = Math.max(0, order.length - max_steps);
  const message =
    `导览路径生成：${steps.length} 步${truncated > 0 ? `（另有 ${truncated} 个节点被截断）` : ''}，` +
    `覆盖 ${steps.length} 个主干节点，按依赖拓扑序（先依赖后依赖者）。`;

  return { feature, total_nodes: order.length, truncated, steps, message };
}