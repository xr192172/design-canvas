/**
 * analyze_monolith 工具：基于 cache.db 调用边做【跨文件】功能社区圈定
 *
 * 与 check_monolith 的分工：
 *   - check_monolith：单文件内的文本引用近似（声明体文本匹配），无跨文件视角、无功能锚点
 *   - analyze_monolith：读 cache.db 的调用边（kind='call'，含跨文件 cross 边），
 *     【从既存结构自动推导功能锚点】，锚点带权重做标签传播，把"同一功能"的符号
 *     聚进同一社区——哪怕这个功能很大、很碎、甚至跨了多个文件。
 *
 * 核心口径（用户愿景，见 evolution.md 12.X）：
 *   - 社区锚点是【功能/业务】，不是纯代码结构
 *   - 老项目没有现成锚点 → 从既存结构推导：入度（高频被调）/ 语义命名 / 导出入口
 *   - 标签传播不设"拆多碎"的下限——功能大就整块聚在一起，再在社区内评估子拆分
 *
 * 产出：
 *   - communities：功能社区清单（锚点 + 符号 + 跨哪些文件 + 估算行数）
 *   - file_view：每个文件被哪些社区占用（多社区文件 → 建议拆分）
 *   - dependencies：社区间调用边（决定拆完 import 怎么补）
 *   - suggestions：文本建议（只给证据 + 启发，落不落盘由人/LLM 裁决）
 */

import path from 'node:path';
import { openDb, type Database } from '../db/db.js';

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

export interface MonolithCommunity {
  /** 社区 id（0 起） */
  id: number;
  /** 社区名（取锚点 / 高频词） */
  name: string;
  /** 锚点符号 id 列表 */
  anchors: string[];
  /** 社区内符号 id 列表 */
  symbols: string[];
  /** 社区横跨的文件 */
  files: string[];
  /** 估算行数（社区内符号行区间并集） */
  est_lines: number;
  /** 社区内符号数 */
  symbol_count: number;
}

export interface MonolithFileView {
  path: string;
  lines: number;
  /** 该文件内按社区分组的符号数 */
  communities: Array<{ id: number; name: string; symbols: number }>;
  /** 文件行数是否超阈值 */
  oversized: boolean;
}

export interface AnalyzeMonolithInput {
  /** 项目根（定位 <root>/.design-canvas/cache.db） */
  project_dir: string;
  /** 可选：注入已打开的 cache.db 连接（复用调用方同一实例，避免路径漂移）；缺省按 project_dir 推导 */
  db?: Database;
  /** warning 阈值（默认 300 行） */
  warn_lines?: number;
  /** critical 阈值（默认 600 行） */
  crit_lines?: number;
  /** 锚点数上限（默认 0=不限，按分数取 top） */
  max_anchors?: number;
  /** 标签传播迭代次数（默认 12） */
  max_iter?: number;
  /** 拆分候选的多社区均衡度门槛：文件内每个社区符号占比 ≥ 此值才算"实质社区"，
   *  且 ≥2 个实质社区才建议拆分（默认 0.2=20%）。用于过滤"1 主导社区+零星尾随社区"的误报。 */
  min_community_share?: number;
}

export interface AnalyzeMonolithResult {
  message: string;
  /** 参与分析的符号数 */
  symbol_count: number;
  /** 功能社区数 */
  community_count: number;
  communities: MonolithCommunity[];
  file_view: MonolithFileView[];
  /** 社区间依赖边 [fromCommunity, toCommunity, weight] */
  dependencies: Array<[number, number, number]>;
  /** 建议拆分的目标文件（多社区文件） */
  split_candidates: string[];
  /** 社区内子拆分评估（P3：一个社区内部是否藏着多个可独立拆出的类型单元） */
  community_subsplit: CommunitySubSplit[];
}

/** 社区内一个可独立拆出的类型单元（owner 锚定凝聚单元） */
export interface SubSplitGroup {
  /** 类型/结构体名 */
  owner: string;
  /** 该类型的方法符号 id */
  symbols: string[];
  /** 该类型的方法明细（供 derive_split 按名抽取，name+所在文件） */
  methods: Array<{ name: string; file: string }>;
  /** 横跨文件 */
  files: string[];
  /** 估算行数 */
  est_lines: number;
}

/** 单个社区的社区内子拆分评估 */
export interface CommunitySubSplit {
  community_id: number;
  community_name: string;
  /** 社区内 ≥2 成员的实质类型单元（按 owner 分组） */
  groups: SubSplitGroup[];
  /** 是否建议社区内再拆（≥2 个实质类型单元 且 组间耦合低） */
  splittable: boolean;
  /** 组间跨组调用边 / 涉及实质组的调用边总数（0-1，越低越该拆） */
  cross_group_ratio: number;
  note: string;
}

// ─────────────────────────────────────────────────────────────
// 锚点推导（从既存结构，全自动）
// ─────────────────────────────────────────────────────────────

/** 语义命名锚点后缀（功能门面约定） */
const ROLE_SUFFIX_RE =
  /(Service|Services|Handler|Handlers|Repo|Repository|Repos|Manager|Managers|Controller|Controllers|Store|Stores|Client|Clients|Reader|Writer|Manager|Factory|Factories|Agent|Bot|Engine|Service)$/i;

interface FuncNode {
  id: string;
  name: string;
  qualified_name: string;
  file: string;
  start_line: number;
  end_line: number;
  /** 所属类型（类/结构体名）：TS/Java/Python 取 parent；Go 从 receiver 推导 */
  owner?: string;
}

/**
 * 推导符号的"所属类型"（类型锚定凝聚单元）。
 *   - TS/JS/Java/Python 等类方法：nodes.parent 已存类名
 *   - Go 方法：parent 为 NULL，但 qualified_name = "Receiver.Method(...)"，取 '.' 前前缀
 * 顶层函数（无 owner）返回 undefined，不参与类型聚合。
 */
function ownerOf(name: string, qn: string, file: string, parent?: string | null): string | undefined {
  if (parent) return parent;
  if (/\.go$/.test(file)) {
    const dot = qn.indexOf('.');
    if (dot > 0) return qn.slice(0, dot);
  }
  void name;
  return undefined;
}

interface CallGraph {
  /** 无向邻接（调用边双向，用于标签传播） */
  adj: Map<number, number[]>;
  /** 入度（被调用次数，有向） */
  inDegree: number[];
}

/** 从 cache.db 读全部函数/方法节点 + 调用边，构建无向连通邻接 */
export function buildCallGraphFromCache(db: Database): { funcs: FuncNode[]; graph: CallGraph } {
  const funcs = (
    db
      .prepare(
        `SELECT id, name, qualified_name, file_path, start_line, end_line, parent
         FROM nodes
         WHERE kind IN ('function', 'method')
         ORDER BY file_path, start_line`,
      )
      .all() as Array<{
      id: string;
      name: string;
      qualified_name: string;
      file_path: string;
      start_line: number;
      end_line: number;
      parent: string | null;
    }>
  ).map((r) => ({
    id: r.id,
    name: r.name,
    qualified_name: r.qualified_name,
    file: r.file_path,
    start_line: r.start_line,
    end_line: r.end_line,
    owner: ownerOf(r.name, r.qualified_name, r.file_path, r.parent),
  }));

  const idx = new Map<string, number>();
  funcs.forEach((f, i) => idx.set(f.id, i));

  const adj: Map<number, number[]> = new Map();
  const inDegree: number[] = new Array(funcs.length).fill(0);
  const edges = db.prepare("SELECT source, target FROM edges WHERE kind = 'call'").all() as Array<{
    source: string;
    target: string;
  }>;
  for (const e of edges) {
    const si = idx.get(e.source);
    const ti = idx.get(e.target);
    if (si === undefined || ti === undefined) continue;
    if (si === ti) continue;
    inDegree[ti]++;
    if (!adj.has(si)) adj.set(si, []);
    if (!adj.has(ti)) adj.set(ti, []);
    if (!adj.get(si)!.includes(ti)) adj.get(si)!.push(ti);
    if (!adj.get(ti)!.includes(si)) adj.get(ti)!.push(si);
  }
  return { funcs, graph: { adj, inDegree } };
}

/** 语义命名锚点得分（0-1） */
function roleScore(name: string): number {
  return ROLE_SUFFIX_RE.test(name) ? 1 : 0;
}

/** 导出/入口锚点得分（0-1）：Go 大写、Python 非下划线顶层 */
function exportScore(name: string, file: string): number {
  if (/\.go$/.test(file)) return /^[A-Z]/.test(name) ? 1 : 0;
  if (/\.py$/.test(file)) return name.startsWith('_') ? 0 : 0.5;
  return 0.3; // TS/JS：默认给低分，靠入度/语义命名
}

/**
 * 锚点打分：分数 = 入度 + 语义命名 + 导出（入度归一化到 [0,1]）。
 * 【锚点资格】用强信号判定，且必须排除"纯工具/属性访问"型 hub 函数：
 *   - 语义命名命中（xxxService/Handler/Repo…）
 *   - 真实导出（Go 大写 / Python 非下划线顶层）
 *   - 入度等于最高档且同时有语义命名（真实"功能门面"）
 * 关键：TS/JS 的默认 0.3 导出分只参与打分排序、【不授予锚点资格】。
 * 否则所有 TS 函数都成锚点，入度最高的工具函数（如 getDbFile）会被误判为
 * "功能门面"，经标签传播吸收成横跨半数的巨型 hub 社区——必须避免。
 * 返回按分数降序，anchor=true 表示有锚点资格。
 */
export function scoreAnchors(
  funcs: FuncNode[],
  graph: CallGraph,
): { idx: number; score: number; anchor: boolean }[] {
  const maxIn = Math.max(1, ...graph.inDegree);
  const scored = funcs.map((f, i) => {
    const inNorm = graph.inDegree[i] / maxIn;
    const score = inNorm + roleScore(f.name) + exportScore(f.name, f.file);
    // 排除"不像功能门面"的符号：getter/setter（getEngine 虽命中 Engine 后缀，
    // 但只是工厂）、带点的属性访问/内嵌 helper（exploreCode.req、
    // validateValueSchema.typeName）——它们不是社区之锚。
    const isGetter = /^(get|set)\w*$/i.test(f.name);
    const isQualifiedProp = f.name.includes('.');
    const semantic = roleScore(f.name) > 0 && !isGetter && !isQualifiedProp;
    const genuineExport = exportScore(f.name, f.file) >= 1; // Go 大写 / Python 顶层
    const topIn = graph.inDegree[i] === maxIn && maxIn >= 3 && semantic;
    const anchor = (semantic || genuineExport) && !isQualifiedProp || topIn;
    return { idx: i, score, anchor };
  });
  return scored.sort((a, b) => b.score - a.score);
}

// ─────────────────────────────────────────────────────────────
// 标签传播圈社区（锚点带权）
// ─────────────────────────────────────────────────────────────

/**
 * 标签传播：节点携带 (label, score)，锚点初始 label=自身、score=锚点分数；
 * 非锚点初始 label=自身、score=0。每轮取邻居中 score 最大的 label 作为新标签
 * （锚点标签会"传染"给邻居），直到收敛或达到 max_iter。
 *
 * 这样"功能锚点决定社区身份"：一个功能再大再碎，只要被同一锚点沿调用边串起，
 * 就聚进同一社区。返回 label → 节点索引组。
 */
export function labelPropagation(
  funcs: FuncNode[],
  graph: CallGraph,
  anchors: { idx: number; score: number }[],
  maxIter = 12,
  ownerClusters: number[][] = [],
): Map<number, number[]> {
  const n = funcs.length;
  if (n === 0) return new Map();

  // 锚点 label 池：只允许锚点作为最终社区 id（社区身份 = 锚点）
  const anchorScore = new Map<number, number>();
  for (const a of anchors) anchorScore.set(a.idx, a.score);

  // labels[i] = 当前 label；scores[i] = label 的分数
  const labels: number[] = new Array(n).fill(-1);
  const scores: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    labels[i] = i;
    scores[i] = anchorScore.get(i) ?? 0;
  }

  // 类型锚定先验：同 owner（类/结构体）的方法共享 rep 标签，强先验防"框架回调式
  // 调用"把方法粉碎成单例社区（Go 典型：Tool{Name,ReadOnly,Execute...} 各自成社区）。
  // 类型 = 凝聚单元，方法默认归属它所属的类型；真被拆碎的类型由 P3 社区内子拆分再评估。
  const ownerRep = new Map<number, number>();
  const repScore = new Map<number, number>();
  for (const cluster of ownerClusters) {
    if (cluster.length < 2) continue;
    let rep = cluster[0];
    let best = anchorScore.get(rep) ?? 0;
    for (const m of cluster) {
      const s = anchorScore.get(m) ?? 0;
      if (s > best) {
        best = s;
        rep = m;
      }
    }
    const prior = Math.max(best, 1.0); // 强先验：类型聚合优先于默认 self label
    for (const m of cluster) {
      ownerRep.set(m, rep);
      repScore.set(rep, prior);
    }
  }
  for (const [m, rep] of ownerRep) {
    labels[m] = rep;
    scores[m] = repScore.get(rep) ?? 1.0;
  }

  for (let it = 0; it < maxIter; it++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      const nbrs = graph.adj.get(i) ?? [];
      if (nbrs.length === 0) continue;
      // 统计邻居 label 的分数（锚点自带权重，非锚点 label 若指向锚点则继承锚点分数）
      const labelScore = new Map<number, number>();
      for (const nb of nbrs) {
        const lbl = labels[nb];
        // 邻居 label 的分数：若该 label 是锚点，用锚点分；否则用邻居 score
        const s = anchorScore.get(lbl) ?? scores[nb];
        labelScore.set(lbl, (labelScore.get(lbl) ?? 0) + s);
      }
      // 选 score 最大的 label；平局但当前 label 也在其中则保留（稳定）
      let best = labels[i];
      let bestScore = Number.NEGATIVE_INFINITY;
      for (const [lbl, s] of labelScore) {
        if (s > bestScore || (s === bestScore && lbl === best && s >= 0)) {
          if (s > bestScore || lbl === best) {
            bestScore = s;
            best = lbl;
          }
        }
      }
      if (best !== labels[i]) {
        labels[i] = best;
        scores[i] = labelScore.get(best) ?? 0;
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 按 label 分组；label 指向非锚点索引的仍可能（孤立岛），保留其自身
  const groups = new Map<number, number[]>();
  labels.forEach((lbl, i) => {
    if (!groups.has(lbl)) groups.set(lbl, []);
    groups.get(lbl)!.push(i);
  });
  return groups;
}

/**
 * 递归拆分超大社区：当标签传播把整个连通组件卷成一个巨型社区（如 renderer+
 * tools+db+dsl 全联通）时，在社区内部子街上重新做锚点+标签传播，把不同业务
 * 区域拆开，直到每个子社区文件数 ≤ maxFiles 或无法再拆。
 * 子社区内给锚点等权（1.0），让标签传播按"就近"做 Voronoi 式分割，而非让
 * 单个高分锚点再次淹没全图。depth 限制递归深度防退化。
 */
function splitOversizedGroups(
  funcs: FuncNode[],
  graph: CallGraph,
  groups: Map<number, number[]>,
  maxFiles: number,
  depth = 0,
): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const [lbl, members] of groups) {
    const fileSet = new Set(members.map((i) => funcs[i].file));
    if (fileSet.size <= maxFiles || members.length <= 1 || depth >= 3) {
      out.set(lbl, members);
      continue;
    }
    // 子图：仅保留本社区成员之间的边
    const local = new Map<number, number>(); // global idx -> local idx
    members.forEach((g, l) => local.set(g, l));
    const subFuncs = members.map((g) => funcs[g]);
    const subAdj = new Map<number, number[]>();
    const subInDeg = new Array(subFuncs.length).fill(0);
    for (const g of members) {
      const l = local.get(g)!;
      const nbrs = (graph.adj.get(g) ?? [])
        .filter((n) => local.has(n))
        .map((n) => local.get(n)!);
      subAdj.set(l, nbrs);
      for (const nb of nbrs) subInDeg[nb]++;
    }
    const subGraph: CallGraph = { adj: subAdj, inDegree: subInDeg };

    // 子社区锚点：语义锚点 + 入度靠前的非工具节点，锚点等权以便分区
    const scored = scoreAnchors(subFuncs, subGraph);
    let anchors = scored
      .filter((s) => s.anchor)
      .map((s) => ({ idx: s.idx, score: 1.0 }));
    if (anchors.length < 2) {
      const extra = scored
        .filter((s) => !/^(get|set)\w*$/i.test(subFuncs[s.idx].name) && !subFuncs[s.idx].name.includes('.'))
        .slice(0, 4)
        .map((s) => ({ idx: s.idx, score: 1.0 }));
      anchors = [...anchors, ...extra];
    }
    if (anchors.length < 2) {
      out.set(lbl, members);
      continue; // 无法再拆
    }
    const subGroups = labelPropagation(subFuncs, subGraph, anchors, 12, []);
    const remapped = new Map<number, number[]>();
    for (const sm of subGroups.values()) {
      const gm = sm.map((l) => members[l]);
      remapped.set(gm[0], gm);
    }
    const sub = splitOversizedGroups(funcs, graph, remapped, maxFiles, depth + 1);
    for (const [k, v] of sub) out.set(k, v);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 汇总产出
// ─────────────────────────────────────────────────────────────
/** 估算符号占用的行数（区间并集，粗略） */
function estimateLines(members: number[], funcs: FuncNode[]): number {
  const ranges = members
    .map((i) => ({ s: funcs[i].start_line, e: funcs[i].end_line }))
    .sort((a, b) => a.s - b.s);
  let total = 0;
  let curS = -1;
  let curE = -1;
  for (const r of ranges) {
    if (curS < 0) {
      curS = r.s;
      curE = r.e;
    } else if (r.s <= curE + 1) {
      curE = Math.max(curE, r.e);
    } else {
      total += curE - curS + 1;
      curS = r.s;
      curE = r.e;
    }
  }
  if (curS >= 0) total += curE - curS + 1;
  return total;
}

/**
 * 社区内子拆分评估（P3）：判断一个社区内部是否藏着多个【可独立拆出】的类型单元。
 *
 * 社区 = 功能锚点串起的整块；但一个功能可能由多个类型/结构体（owner）组成。若：
 *   1. 社区内 ≥2 个 owner 各自有 ≥minGroup 个方法（实质类型单元），且
 *   2. 这些类型单元之间的跨组调用占比低（耦合弱，能独立成文件）
 * 则建议在社区内再做子拆分。
 *
 * 只给证据与启发，不落盘改代码——拆不拆由 derive_split / 人确认。
 */
export function assessCommunitySubSplit(
  funcs: FuncNode[],
  communities: MonolithCommunity[],
  callRows: Array<{ source: string; target: string }>,
  minGroup = 3,
  maxCrossRatio = 0.4,
): CommunitySubSplit[] {
  const idxOf = new Map<string, number>();
  funcs.forEach((f, i) => idxOf.set(f.id, i));

  const out: CommunitySubSplit[] = [];
  for (const c of communities) {
    // 该社区内所有符号 → 节点索引
    const memberIdx = c.symbols.map((s) => idxOf.get(s)).filter((i): i is number => i !== undefined);
    // 按 owner 分组（仅统计有 owner 的方法）
    const ownerGroups = new Map<string, number[]>();
    for (const i of memberIdx) {
      const o = funcs[i].owner;
      if (!o) continue;
      const arr = ownerGroups.get(o);
      if (arr) arr.push(i);
      else ownerGroups.set(o, [i]);
    }
    // 过滤出实质类型单元（≥minGroup 个方法）
    const groups: SubSplitGroup[] = [...ownerGroups.entries()]
      .filter(([, idxs]) => idxs.length >= minGroup)
      .map(([owner, idxs]) => ({
        owner,
        symbols: idxs.map((i) => funcs[i].id),
        methods: idxs.map((i) => ({ name: funcs[i].name, file: funcs[i].file })),
        files: [...new Set(idxs.map((i) => funcs[i].file))].sort(),
        est_lines: estimateLines(idxs, funcs),
      }))
      .sort((a, b) => b.symbols.length - a.symbols.length);

    if (groups.length < 2) {
      out.push({
        community_id: c.id,
        community_name: c.name,
        groups,
        splittable: false,
        cross_group_ratio: 0,
        note: groups.length === 0 ? '社区内无类型单元（纯顶层函数）' : '社区内仅 1 个实质类型单元',
      });
      continue;
    }

    // 组间耦合：统计涉及这些 type 方法的调用边中，跨组边占比
    const groupOfNode = new Map<number, string>();
    groups.forEach((g) => g.symbols.forEach((s) => groupOfNode.set(idxOf.get(s)!, g.owner)));
    let total = 0;
    let cross = 0;
    for (const e of callRows) {
      const si = idxOf.get(e.source);
      const ti = idxOf.get(e.target);
      if (si === undefined || ti === undefined) continue;
      const go = groupOfNode.get(si);
      const to = groupOfNode.get(ti);
      if (go === undefined && to === undefined) continue; // 两端都不在实质组内
      total++;
      if (go !== undefined && to !== undefined && go !== to) cross++;
    }
    const ratio = total > 0 ? cross / total : 0;
    const splittable = ratio <= maxCrossRatio;
    out.push({
      community_id: c.id,
      community_name: c.name,
      groups,
      splittable,
      cross_group_ratio: ratio,
      note:
        total === 0
          ? `共 ${groups.length} 个实质类型单元，组间无调用边（完全独立，适合拆）`
          : `共 ${groups.length} 个实质类型单元，组间跨组调用占比 ${(ratio * 100).toFixed(0)}%`,
    });
  }
  return out;
}

/** 社区名：取锚点函数名去掉 role 后缀，否则取最常见文件名前缀 */
function communityName(group: number[], funcs: FuncNode[], anchorIdx: Set<number>): string {
  // 类型锚定：全组成员归属同一 owner（类/结构体）→ 用 owner 命名（如 ToolDefine）
  const owners = [...new Set(group.map((i) => funcs[i].owner).filter((o): o is string => !!o))];
  if (owners.length === 1) return owners[0];
  const anchor = group.find((i) => anchorIdx.has(i));
  if (anchor !== undefined) {
    const name = funcs[anchor].owner ?? funcs[anchor].name;
    const base = name.replace(ROLE_SUFFIX_RE, '');
    return base || name;
  }
  // 无锚点岛：取文件 basename 去扩展名
  const files = [...new Set(group.map((i) => funcs[i].file))];
  const base = files.length > 0 ? path.posix.basename(files[0]).replace(/\.[^.]+$/, '') : 'unknown';
  return base || 'unknown';
}

export function analyzeMonolith(input: AnalyzeMonolithInput): AnalyzeMonolithResult {
  const warnLines = input.warn_lines ?? 300;
  const critLines = input.crit_lines ?? 600;
  const maxAnchors = input.max_anchors ?? 0;
  const maxIter = input.max_iter ?? 12;

  const projectRoot = path.resolve(input.project_dir);
  const dbPath = path.join(projectRoot, '.design-canvas', 'cache.db');
  let db: Database | null = null;
  let opened = false;
  try {
    db = input.db ?? openDb(dbPath);
    opened = input.db === undefined;
  } catch (e) {
    return {
      message: `无法打开项目缓存 ${dbPath}：${(e as Error).message}。请先对项目执行 import_project / watch_project 建立索引。`,
      symbol_count: 0,
      community_count: 0,
      communities: [],
      file_view: [],
      dependencies: [],
      split_candidates: [],
      community_subsplit: [],
    };
  }

  try {
    const { funcs, graph } = buildCallGraphFromCache(db);

    // 文件行数（nodes 里 kind='file' 的 end_line）
    const fileLines = new Map<string, number>();
    for (const r of db.prepare("SELECT id, end_line FROM nodes WHERE kind = 'file'").all() as Array<{ id: string; end_line: number }>) {
      fileLines.set(r.id, r.end_line);
    }

    if (funcs.length === 0) {
      return {
        message: `缓存索引中无函数/方法符号（${dbPath}）。请先对项目执行 import_project / watch_project 建立索引后再分析。`,
        symbol_count: 0,
        community_count: 0,
        communities: [],
        file_view: [],
        dependencies: [],
        split_candidates: [],
        community_subsplit: [],
      };
    }

    // 锚点：取有资格的信号（maxAnchors=0 表示取全部）
    const scored = scoreAnchors(funcs, graph);
    const candidates = scored.filter((s) => s.anchor);
    const chosen = maxAnchors > 0 ? candidates.slice(0, maxAnchors) : candidates;
    // 至少保证 1 个锚点（全无信号时取最高分节点当锚点，避免无社区）
    const effectiveAnchors = chosen.length > 0 ? chosen : scored.slice(0, 1);

    // 类型锚定：同 owner 的方法聚成"类型社区"先验，owner 代表作为该类型锚点
    const ownerClusters: number[][] = [];
    const repAnchors: { idx: number; score: number }[] = [];
    const owners = new Map<string, number[]>();
    funcs.forEach((f, i) => {
      if (!f.owner) return;
      const arr = owners.get(f.owner);
      if (arr) arr.push(i);
      else owners.set(f.owner, [i]);
    });
    for (const members of owners.values()) {
      if (members.length < 2) continue;
      ownerClusters.push(members);
      let rep = members[0];
      let best = graph.inDegree[rep];
      for (const m of members) {
        if (graph.inDegree[m] > best) {
          best = graph.inDegree[m];
          rep = m;
        }
      }
      repAnchors.push({ idx: rep, score: 1.0 });
    }
    const allAnchors = [...effectiveAnchors, ...repAnchors];
    const anchorIdx = new Set(allAnchors.map((a) => a.idx));

    const groups = labelPropagation(funcs, graph, allAnchors, maxIter, ownerClusters);

    // 递归拆分仍过大的社区（全联通巨型组件会被卷成单个 60 文件 blob）
    const MAX_COMM_FILES = 20;
    const finalGroups = splitOversizedGroups(funcs, graph, groups, MAX_COMM_FILES);

    // 组装社区
    const communities: MonolithCommunity[] = [];
    const groupArr = [...finalGroups.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [lbl, members] of groupArr) {
      const files = [...new Set(members.map((i) => funcs[i].file))].sort();
      communities.push({
        id: communities.length,
        name: communityName(members, funcs, anchorIdx),
        anchors: members.filter((i) => anchorIdx.has(i)).map((i) => funcs[i].id),
        symbols: members.map((i) => funcs[i].id),
        files,
        est_lines: estimateLines(members, funcs),
        symbol_count: members.length,
      });
    }

    // 社区间依赖（有向调用边跨社区）
    const idxOf = new Map<string, number>();
    funcs.forEach((f, i) => idxOf.set(f.id, i));
    const commOf = new Map<number, number>();
    groupArr.forEach(([_lbl, members], ci) => members.forEach((i) => commOf.set(i, ci)));
    const depW = new Map<string, number>();
    const callRows = db.prepare("SELECT source, target FROM edges WHERE kind = 'call'").all() as Array<{ source: string; target: string }>;
    for (const e of callRows) {
      const si = idxOf.get(e.source);
      const ti = idxOf.get(e.target);
      if (si === undefined || ti === undefined) continue;
      const cs = commOf.get(si);
      const ct = commOf.get(ti);
      if (cs === undefined || ct === undefined || cs === ct) continue;
      const key = `${cs}|${ct}`;
      depW.set(key, (depW.get(key) ?? 0) + 1);
    }
    const dependencies: Array<[number, number, number]> = [...depW.entries()]
      .map(([key, w]) => {
        const [a, b] = key.split('|').map(Number);
        return [a, b, w] as [number, number, number];
      })
      .sort((x, y) => y[2] - x[2]);

    // 社区内子拆分评估（P3）：社区内部是否藏着多个可独立拆出的类型单元
    const community_subsplit = assessCommunitySubSplit(funcs, communities, callRows);

    // 文件视图 + 拆分候选
    const allFiles = [...new Set(funcs.map((f) => f.file))].sort();
    const file_view: MonolithFileView[] = [];
    const split_candidates: string[] = [];
    for (const f of allFiles) {
      const lines = fileLines.get(f) ?? 0;
      const commCount = new Map<number, number>();
      for (let i = 0; i < funcs.length; i++) {
        if (funcs[i].file !== f) continue;
        const c = commOf.get(i);
        if (c !== undefined) commCount.set(c, (commCount.get(c) ?? 0) + 1);
      }
      const commList = [...commCount.entries()]
        .map(([id, symbols]) => ({ id, name: communities[id].name, symbols }))
        .sort((a, b) => b.symbols - a.symbols);
      const oversized = lines >= warnLines;
      // 多社区均衡度门槛：仅当文件内 ≥2 个社区各自达到实质符号占比（share ≥ minShare）
      // 才建议拆分。过滤"1 个主导社区 + 零星尾随社区"的误报（如独立一次性脚本，
      // 其符号几乎全在一个社区，尾随社区仅 1-2 个符号，拆了反而制造碎片）。
      const totalComm = commList.reduce((s, c) => s + c.symbols, 0);
      const minShare = input.min_community_share ?? 0.2;
      const substantial = commList.filter((c) => totalComm > 0 && c.symbols / totalComm >= minShare).length;
      if (oversized && substantial >= 2) split_candidates.push(f);
      file_view.push({ path: f, lines, communities: commList, oversized });
    }

    // 文本报告
    const lines: string[] = [
      `analyze_monolith：基于调用边圈定 ${communities.length} 个功能社区（${funcs.length} 个符号，锚点 ${allAnchors.length} 个）` + (ownerClusters.length > 0 ? `，${ownerClusters.length} 个类型锚定` : ''),
      `缓存：${dbPath}`,
      '',
      '功能社区（锚点驱动，功能多大就多大）：',
    ];
    for (const c of communities) {
      const anchorNames = c.anchors.map((a) => a.split('#').pop()).join(', ');
      lines.push(
        `  [${c.id}] ${c.name} · ${c.symbol_count} 符号 / ~${c.est_lines} 行 / ${c.files.length} 文件` +
          (anchorNames ? ` · 锚点: ${anchorNames}` : ''),
      );
    }
    if (dependencies.length > 0) {
      lines.push('', '社区间依赖（决定拆完 import 怎么补）：');
      for (const [a, b, w] of dependencies) {
        lines.push(`  ${communities[a].name} → ${communities[b].name}（边 ×${w}）`);
      }
    }
    lines.push(
      '',
      `文件视图（${file_view.length} 个文件；warning≥${warnLines} / critical≥${critLines} 行）：`,
    );
    for (const fv of file_view) {
      const tag = fv.lines >= critLines ? 'CRITICAL' : fv.oversized ? 'WARNING' : 'ok';
      const comms = fv.communities.map((c) => `${c.name}(${c.symbols})`).join(', ') || '无函数';
      lines.push(`  [${tag}] ${fv.path} · ${fv.lines} 行 → ${comms}`);
    }
    if (split_candidates.length > 0) {
      lines.push('', '建议拆分（多社区共占的超标文件，按社区切文件）：');
      for (const f of split_candidates) lines.push(`  → ${f}`);
    } else {
      lines.push('', '无可拆目标：无"多社区共占的超标文件"。');
    }
    // 社区内子拆分评估（P3）
    const splittableSub = community_subsplit.filter((s) => s.splittable);
    lines.push(
      '',
      `社区内子拆分评估（${community_subsplit.length} 个社区；${community_subsplit.filter((s) => s.groups.length >= 2).length} 个含 ≥2 实质类型单元 / ${splittableSub.length} 个建议再拆）：`,
    );
    if (splittableSub.length === 0) {
      lines.push('  无——社区内类型单元要么不足 2 个，要么组间耦合偏高，保持凝聚。');
    }
    for (const s of community_subsplit) {
      if (s.groups.length < 2) continue;
      const tag = s.splittable ? '✔ 建议再拆' : '— 保持凝聚';
      lines.push(`  [${s.community_id}] ${s.community_name}: ${tag} · ${s.note}`);
      for (const g of s.groups) lines.push(`      · ${g.owner}: ${g.symbols.length} 方法 / ~${g.est_lines} 行 / ${g.files.join(', ')}`);
    }
    lines.push(
      '',
      '社区锚点是功能/业务，不设"拆多碎"下限；社区内子拆分是否执行由 derive_split 或人工裁决。',
    );
    lines.push(
      '',
      '本工具只给证据与启发（不落盘改代码）。拆分执行由 derive_split 或人工确认后执行。',
    );

    return {
      message: lines.join('\n'),
      symbol_count: funcs.length,
      community_count: communities.length,
      communities,
      file_view,
      dependencies,
      split_candidates,
      community_subsplit,
    };
  } finally {
    if (opened) {
      try {
        db.close();
      } catch {
        /* 已关闭 */
      }
    }
  }
}