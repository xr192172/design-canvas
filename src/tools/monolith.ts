/**
 * check_monolith 工具：监控文件行数，识别"单文件化"风险并给出功能内聚拆分建议
 *
 * 工作流：
 *   1. 行数统计：读文件按阈值分档（ok / warning / critical）
 *   2. 声明提取：复用 ts_kernel（top-level 声明；class 方法随类、Go receiver 方法归并类型）
 *   3. 引用图：声明体文本中其他声明名的出现次数（语言无关的近似，Louvain 聚类足够）
 *   4. Louvain 社区发现：把互相引用紧密的声明聚成"功能内聚社区"
 *   5. 拆分建议：每社区建议一个新文件名（token 公共前缀 / 高频词）
 *   6. 双产出：文本报告 + 预览 DSL（社区节点 + 社区间引用边）
 *
 * 设计约定：
 *   - 仅对超阈值文件跑 AST + 聚类（行数正常的文件零成本跳过）
 *   - 社区数 ≤ 1 时不建议拆分（内聚良好，行数多只是体积问题）
 *   - 建议仅作参考（suggestion），不落盘改代码——拆分决策权在人/LLM
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DesignDSL, Node, Edge } from '../dsl/types.js';
import { getDSL, saveDSL } from '../storage.js';
import { parseFileFull } from './ts_kernel/index.js';
import type { ParsedSymbol } from './ts_kernel/index.js';
import { fileFingerprint, healthKey, readHealthCache, writeHealthCache } from './health_cache.js';

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

export type MonolithStatus = 'ok' | 'warning' | 'critical' | 'cohesive';

export interface CommunityInfo {
  /** 建议新文件名（不含目录） */
  suggested_name: string;
  /** 社区内声明的 qualified_name 列表 */
  decls: string[];
  /** 社区内声明的签名列表（报告可读性） */
  signatures: string[];
  /** 社区估算行数（声明区间行数求和） */
  est_lines: number;
  /** 社区内聚度：社区内部引用权重和 */
  internal_refs: number;
}

export interface FileMonolithReport {
  path: string;
  lines: number;
  status: MonolithStatus;
  /** top-level 声明数（未超阈值时为 0，不跑 AST） */
  decl_count: number;
  /** 社区列表（仅 status != ok 且声明数 ≥ 2 时非空） */
  communities: CommunityInfo[];
  /** 社区间引用边 [fromIdx, toIdx, weight] */
  inter_edges: Array<[number, number, number]>;
  /** 人类可读建议 */
  suggestion: string;
}

export interface CheckMonolithInput {
  /** 模式1：扫描项目目录 */
  project_dir?: string;
  /** 模式2：从已存 feature 的 semantic.files 取文件列表 */
  feature?: string;
  /** feature 模式下解析相对路径的项目根（默认 cwd） */
  base_dir?: string;
  /** 模式3：显式文件路径列表（绝对或相对 cwd） */
  files?: string[];
  /** warning 阈值（默认 500 行） */
  warn_lines?: number;
  /** critical 阈值（默认 1000 行） */
  crit_lines?: number;
  /** 内聚守卫：体积大但引用高度内聚（≤1 社区）的文件是否降级不标红（默认 true；false 时按体积严格标红） */
  flag_cohesive?: boolean;
  /** 扫描模式最多文件数（默认 200） */
  max_files?: number;
  /** 跳过体检缓存，强制重新体检（默认 false；缓存基于源文件快照指纹，文件没变则直接复用上次报告） */
  no_cache?: boolean;
  /** 是否生成预览 DSL 并保存为 feature（默认 false） */
  save_preview?: boolean;
  /** 预览 DSL 的 feature 名（默认 <feature|monolith>_split_preview） */
  preview_feature?: string;
}

export interface CheckMonolithResult {
  message: string;
  total_files: number;
  oversized: number;
  reports: FileMonolithReport[];
  preview_feature?: string;
}

// ─────────────────────────────────────────────────────────────
// D1 行数统计与阈值分档
// ─────────────────────────────────────────────────────────────

export function countLines(content: string): number {
  if (content.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) n++;
  }
  // 末尾无换行时最后一行已计入；末尾有换行则不多计（n 初始为 1 正好）
  return content.endsWith('\n') ? n - 1 : n;
}

export function assessLines(lines: number, warn = 500, crit = 1000): MonolithStatus {
  if (lines >= crit) return 'critical';
  if (lines >= warn) return 'warning';
  return 'ok';
}

// ─────────────────────────────────────────────────────────────
// D2 声明归一化（top-level；方法归并宿主类型）
// ─────────────────────────────────────────────────────────────

/** 归一化后的顶层声明单元（class 含方法 / Go 类型含 receiver 方法） */
export interface DeclUnit {
  /** 单元名（顶层声明名 / 宿主类型名） */
  name: string;
  /** 所有归属符号（含归并进来的方法） */
  members: ParsedSymbol[];
  /** 源码行区间（覆盖所有成员，用于引用匹配与行数估算） */
  start_line: number;
  end_line: number;
}

const GO_RECEIVER_SIG_RE = /^(\w+)\.(\w+)\(/;

/**
 * 把 kernel 符号表归并为顶层声明单元：
 * - parent 指向同文件顶层声明的符号（class 方法）→ 并入宿主
 * - Go receiver 签名 "Type.Method(" → 并入同名顶层类型
 * - 其余 parent === undefined → 独立单元
 */
export function buildDeclUnits(symbols: ParsedSymbol[]): DeclUnit[] {
  const top = symbols.filter((s) => !s.parent);
  const byName = new Map<string, DeclUnit>();
  const units: DeclUnit[] = [];

  const ensureUnit = (s: ParsedSymbol): DeclUnit => {
    const existing = byName.get(s.name);
    if (existing) {
      existing.members.push(s);
      existing.start_line = Math.min(existing.start_line, s.start_line);
      existing.end_line = Math.max(existing.end_line, s.end_line);
      return existing;
    }
    const u: DeclUnit = {
      name: s.name,
      members: [s],
      start_line: s.start_line,
      end_line: s.end_line,
    };
    byName.set(s.name, u);
    units.push(u);
    return u;
  };

  for (const s of top) ensureUnit(s);

  // 归并 parent 指向顶层名的成员（class methods 等）
  for (const s of symbols) {
    if (!s.parent) continue;
    const host = byName.get(s.parent);
    if (!host) continue;
    host.members.push(s);
    host.start_line = Math.min(host.start_line, s.start_line);
    host.end_line = Math.max(host.end_line, s.end_line);
  }

  // 归并 Go receiver 方法：kernel 对 Go method 不带 parent（name 仅是方法名），
  // receiver 在 signature 里（"Type.Method(...)"），按签名解析并入同名顶层类型。
  for (const s of symbols) {
    if (s.parent) continue; // 上面已处理
    const m = s.signature.match(GO_RECEIVER_SIG_RE);
    if (!m) continue;
    const host = byName.get(m[1]);
    if (!host) continue;
    const self = byName.get(s.name);
    if (self && self.members.includes(s)) {
      // 该符号已独立成单元 → 撤销独立，并入宿主
      if (self.members.length === 1) {
        units.splice(units.indexOf(self), 1);
        byName.delete(s.name);
      } else {
        self.members = self.members.filter((x) => x !== s);
      }
      host.members.push(s);
      host.start_line = Math.min(host.start_line, s.start_line);
      host.end_line = Math.max(host.end_line, s.end_line);
    }
  }

  units.sort((a, b) => a.start_line - b.start_line);
  return units;
}

// ─────────────────────────────────────────────────────────────
// D2 引用图（声明体文本近似）
// ─────────────────────────────────────────────────────────────

/**
 * 构建声明单元间的引用权重矩阵（有向）：w[i][j] = 单元 i 的文本中单元 j 名字出现次数。
 * - 目标名长度 < 3 跳过（避免 ok/id 之类的误匹配）
 * - 单元 j 是 i 的宿主/成员关系时跳过（归并已保证，防御性）
 * - 结果按调用方需要可对称化（Louvain 是无向算法）
 */
export function buildReferenceGraph(units: DeclUnit[], content: string): Array<Map<number, number>> {
  const lines = content.split('\n');
  const texts = units.map((u) => lines.slice(u.start_line - 1, u.end_line).join('\n'));
  const adj: Array<Map<number, number>> = units.map(() => new Map());

  for (let i = 0; i < units.length; i++) {
    for (let j = 0; j < units.length; j++) {
      if (i === j) continue;
      const name = units[j].name;
      if (name.length < 3) continue;
      const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
      const matches = texts[i].match(re);
      if (matches && matches.length > 0) {
        adj[i].set(j, matches.length);
      }
    }
  }
  return adj;
}

/** 有向图对称化：w_sym[i][j] = w[i][j] + w[j][i] */
export function symmetrize(directed: Array<Map<number, number>>): Array<Map<number, number>> {
  const n = directed.length;
  const adj: Array<Map<number, number>> = Array.from({ length: n }, () => new Map());
  for (let i = 0; i < n; i++) {
    for (const [j, w] of directed[i]) {
      adj[i].set(j, (adj[i].get(j) ?? 0) + w);
      adj[j].set(i, (adj[j].get(i) ?? 0) + w);
    }
  }
  return adj;
}

// ─────────────────────────────────────────────────────────────
// D3 Louvain 社区发现（无向加权图）
// ─────────────────────────────────────────────────────────────

const LOUVAIN_EPS = 1e-7;
const LOUVAIN_MAX_AGG = 20;

/**
 * Louvain 算法：两阶段（局部移动优化模块度 → 社区聚合为超节点）迭代至收敛。
 * @param adj 对称邻接（adj[i].get(j) === adj[j].get(i)）
 * @returns community[nodeIndex] = 社区 id（从 0 开始连续编号）
 */
export function louvain(adj: Array<Map<number, number>>): number[] {
  const n0 = adj.length;
  if (n0 === 0) return [];
  if (n0 === 1) return [0];

  // origNode → 当前层超节点
  let mapping: number[] = Array.from({ length: n0 }, (_, i) => i);
  let graph = adj.map((m) => new Map(m));
  let n = n0;

  for (let agg = 0; agg < LOUVAIN_MAX_AGG; agg++) {
    const { community: rawComm } = louvainLocalMove(graph, n);
    // 阶段1产出的社区 id 不连续（如 [1,1,3,3]），先重编号为 0..k-1
    const remapC = new Map<number, number>();
    const comm = rawComm.map((c) => {
      if (!remapC.has(c)) remapC.set(c, remapC.size);
      return remapC.get(c)!;
    });
    const nComm = remapC.size;
    // 展开 mapping：orig → 旧超节点 → 新社区
    mapping = mapping.map((sup) => comm[sup]);
    if (nComm === n) break; // 无聚合空间，收敛

    // 阶段2：聚合社区为超节点，自环保留社区内部权重
    const newGraph: Array<Map<number, number>> = Array.from({ length: nComm }, () => new Map());
    for (let i = 0; i < n; i++) {
      for (const [j, w] of graph[i]) {
        if (j < i) continue; // 对称边只处理一次
        const ci = comm[i];
        const cj = comm[j];
        if (ci === cj) {
          // 社区内边 → 自环（无向惯例 ×2，一条边贡献两个方向）
          newGraph[ci].set(ci, (newGraph[ci].get(ci) ?? 0) + w * 2);
        } else {
          newGraph[ci].set(cj, (newGraph[ci].get(cj) ?? 0) + w);
          newGraph[cj].set(ci, (newGraph[cj].get(ci) ?? 0) + w);
        }
      }
    }
    graph = newGraph;
    n = nComm;
  }

  // 重编号为 0..k-1 连续
  const remap = new Map<number, number>();
  return mapping.map((c) => {
    if (!remap.has(c)) remap.set(c, remap.size);
    return remap.get(c)!;
  });
}

/** 阶段1：局部移动（同步顺序扫描，直到无正增益移动） */
function louvainLocalMove(graph: Array<Map<number, number>>, n: number): { community: number[] } {
  // m2 = 2m = 全图权重和（含自环两个方向）
  let m2 = 0;
  const k: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (const [j, w] of graph[i]) {
      k[i] += w;
      m2 += w;
    }
  }
  if (m2 === 0) {
    return { community: Array.from({ length: n }, (_, i) => i) };
  }

  const community = Array.from({ length: n }, (_, i) => i);
  const sigmaTot = k.slice(); // 社区总度权

  let improved = true;
  let guard = 0;
  while (improved && guard++ < 100) {
    improved = false;
    for (let i = 0; i < n; i++) {
      const ci = community[i];
      // 邻接社区 → 边权
      const neighCommW = new Map<number, number>();
      for (const [j, w] of graph[i]) {
        if (j === i) continue;
        const cj = community[j];
        neighCommW.set(cj, (neighCommW.get(cj) ?? 0) + w);
      }
      // 移出当前社区（σ_tot 先减去自身度权，再评估各候选社区增益）
      sigmaTot[ci] -= k[i];
      let bestC = ci;
      let bestGain = 0;
      for (const [cj, kiIn] of neighCommW) {
        // 增益（python-louvain 形式，省略 1/m 统一缩放）：ΔQ ∝ kiIn - Σtot·ki/(2m)
        const gain = kiIn - (sigmaTot[cj] * k[i]) / m2;
        if (gain > bestGain + LOUVAIN_EPS) {
          bestGain = gain;
          bestC = cj;
        }
      }
      sigmaTot[bestC] += k[i];
      if (bestC !== ci) {
        community[i] = bestC;
        improved = true;
      } else {
        community[i] = ci;
      }
    }
  }
  return { community };
}

// ─────────────────────────────────────────────────────────────
// D4 命名建议
// ─────────────────────────────────────────────────────────────

/** 无语义命名 token 黑名单 */
const NAME_STOPWORDS = new Set([
  'utils', 'util', 'helper', 'helpers', 'common', 'base', 'core', 'misc',
  'module', 'part', 'data', 'info', 'item', 'obj', 'val', 'tmp', 'index', 'main', 'lib',
]);

/** camelCase / snake_case / PascalCase 拆词（全小写） */
export function tokenizeName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-./]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2);
}

/**
 * 为社区建议文件名：
 *   1. ≥2 个声明共享的最长 token 前缀（parseConfig/parseYaml → parse）
 *   2. 否则最高频非停用词 token
 *   3. 兜底 part_N
 * 与原文件名冲突时追加 _N。
 */
export function suggestFileName(declNames: string[], ext: string, taken: Set<string>, origBase: string): string {
  const tokenLists = declNames.map(tokenizeName).filter((t) => t.length > 0);
  let base = '';

  if (tokenLists.length >= 2) {
    // 最长公共前缀（token 级）
    const first = tokenLists[0];
    let prefixLen = 0;
    for (let i = 0; i < first.length; i++) {
      if (tokenLists.every((tl) => tl[i] === first[i])) prefixLen = i + 1;
      else break;
    }
    if (prefixLen > 0 && !NAME_STOPWORDS.has(first[prefixLen - 1])) {
      base = first.slice(0, prefixLen).join('_');
    }
  }

  if (!base) {
    // 最高频 token
    const freq = new Map<string, number>();
    for (const tl of tokenLists) {
      for (const t of new Set(tl)) {
        if (!NAME_STOPWORDS.has(t)) freq.set(t, (freq.get(t) ?? 0) + 1);
      }
    }
    let best = '';
    let bestN = 0;
    for (const [t, c] of freq) {
      if (c > bestN || (c === bestN && t < best)) {
        best = t;
        bestN = c;
      }
    }
    base = best;
  }

  if (!base) base = 'part';
  let candidate = `${base}${ext}`;
  let suffix = 2;
  while (taken.has(candidate) || candidate === origBase) {
    candidate = `${base}_${suffix++}${ext}`;
    if (suffix > 50) break;
  }
  taken.add(candidate);
  return candidate;
}

// ─────────────────────────────────────────────────────────────
// 单文件分析（D1-D4 串联）
// ─────────────────────────────────────────────────────────────

export async function analyzeFileContent(
  relPath: string,
  content: string,
  warn = 500,
  crit = 1000,
  flagCohesive = true,
): Promise<FileMonolithReport> {
  const lineCount = countLines(content);
  const status = assessLines(lineCount, warn, crit);
  const base: FileMonolithReport = {
    path: relPath,
    lines: lineCount,
    status,
    decl_count: 0,
    communities: [],
    inter_edges: [],
    suggestion: '',
  };
  if (status === 'ok') return base;

  const ext = path.extname(relPath);
  const origBase = path.posix.basename(relPath);
  const { symbols } = await parseFileFull(relPath, content);
  const units = buildDeclUnits(symbols);
  base.decl_count = units.length;

  if (units.length < 2) {
    base.suggestion = `${status === 'critical' ? '严重' : '警告'}：${lineCount} 行，但顶层声明不足 2 个（可能是巨型单函数/类），` +
      `建议人工按职责段拆分，或先在函数内部提取子函数。`;
    return base;
  }

  const directed = buildReferenceGraph(units, content);
  const adj = symmetrize(directed);
  const communityIds = louvain(adj);

  // 聚合社区
  const groups = new Map<number, number[]>();
  communityIds.forEach((c, i) => {
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c)!.push(i);
  });
  const communities = [...groups.values()].sort((a, b) => b.length - a.length);

  // 社区间引用边
  const unitToComm = new Map<number, number>();
  communities.forEach((members, ci) => members.forEach((u) => unitToComm.set(u, ci)));
  const interW = new Map<string, number>();
  for (let i = 0; i < units.length; i++) {
    for (const [j, w] of directed[i]) {
      const ci = unitToComm.get(i)!;
      const cj = unitToComm.get(j)!;
      if (ci === cj) continue;
      const key = `${ci}|${cj}`;
      interW.set(key, (interW.get(key) ?? 0) + w);
    }
  }
  base.inter_edges = [...interW.entries()].map(([key, w]) => {
    const [a, b] = key.split('|').map(Number);
    return [a, b, w] as [number, number, number];
  });

  // 命名 + 汇总
  const taken = new Set<string>([origBase]);
  const estLinesOf = (members: number[]): number =>
    members.reduce((sum, u) => sum + (units[u].end_line - units[u].start_line + 1), 0);
  const internalRefsOf = (members: number[]): number => {
    const set = new Set(members);
    let sum = 0;
    for (const i of members) {
      for (const [j, w] of directed[i]) if (set.has(j)) sum += w;
    }
    return sum;
  };

  base.communities = communities.map((members) => {
    const declNames = members.map((u) => units[u].name);
    const signatures = members.flatMap((u) => units[u].members.map((m) => m.signature));
    return {
      suggested_name: suggestFileName(declNames, ext, taken, origBase),
      decls: members.map((u) =>
        units[u].members.length > 1 ? `${units[u].name}(+${units[u].members.length - 1}成员)` : units[u].name,
      ),
      signatures,
      est_lines: estLinesOf(members),
      internal_refs: internalRefsOf(members),
    };
  });

  if (base.communities.length <= 1) {
    // 内聚守卫：引用高度内聚（≤1 社区）时，体积大不是拆分候选 → 降级为 cohesive（默认不标红）
    if (flagCohesive && base.status !== 'ok') base.status = 'cohesive';
    if (base.status === 'cohesive') {
      base.suggestion = `体积提示：${lineCount} 行 / ${units.length} 个顶层声明，引用关系高度内聚（仅 1 个社区），不构成拆分候选。可考虑按"接口/实现"或"类型/函数"分层拆解。`;
    } else {
      base.suggestion = `${base.status === 'critical' ? '严重' : '警告'}：${lineCount} 行 / ${units.length} 个顶层声明，` +
        `但引用关系高度内聚（仅 1 个社区），强行拆分反而割裂。可考虑按"接口/实现"或"类型/函数"分层拆分。`;
    }
  } else {
    const names = base.communities.map((c) => c.suggested_name).join(', ');
    base.suggestion = `${status === 'critical' ? '严重' : '警告'}：${lineCount} 行 / ${units.length} 个顶层声明，` +
      `Louvain 聚出 ${base.communities.length} 个功能社区，建议拆分：${names}`;
  }
  return base;
}

// ─────────────────────────────────────────────────────────────
// D5 预览 DSL（拆分后视图：社区功能内聚展示）
// ─────────────────────────────────────────────────────────────

const PV_NODE_W = 220;
const PV_NODE_H = 64;
const PV_COLS = 3;
const PV_GAP_X = 40;
const PV_GAP_Y = 30;
const PV_PAD = 20;
const PV_TITLE = 30;
const PV_CONTAINER_GAP = 60;

/** 由超标文件报告生成拆分预览 DSL（每个超标文件一个容器，社区为子节点） */
export function buildSplitPreviewDsl(
  feature: string,
  reports: FileMonolithReport[],
  warn: number,
  crit: number,
): DesignDSL {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  let yCursor = PV_PAD;

  const oversized = reports.filter((r) => r.status !== 'ok');
  for (const r of oversized) {
    const comms = r.communities.length > 0 ? r.communities : [];
    const cols = Math.max(1, Math.min(PV_COLS, comms.length));
    const rows = Math.ceil(comms.length / cols);
    const innerW = cols * PV_NODE_W + (cols - 1) * PV_GAP_X;
    const innerH = rows * PV_NODE_H + Math.max(0, rows - 1) * PV_GAP_Y;
    const contW = innerW + PV_PAD * 2;
    const contH = innerH + PV_PAD * 2 + PV_TITLE;
    const contId = `mono_${sanitizeId(r.path)}`;
    const isCrit = r.status === 'critical';

    nodes.push({
      id: contId,
      label: `📦 ${path.posix.basename(r.path)} · ${r.lines}行`,
      x: PV_PAD,
      y: yCursor,
      width: contW,
      height: contH,
      type: 'module',
      status: isCrit ? 'in_progress' : 'done',
      description: r.suggestion,
      style: {
        bg: isCrit ? 'rgba(233,69,96,0.08)' : 'rgba(255,152,0,0.08)',
        border: `2px dashed ${isCrit ? '#e94560' : '#FF9800'}`,
        borderRadius: 10,
      },
    });

    comms.forEach((c, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const nid = `${contId}_split_${idx}`;
      nodes.push({
        id: nid,
        label: `${c.suggested_name} · ~${c.est_lines}行`,
        x: PV_PAD + PV_PAD + col * (PV_NODE_W + PV_GAP_X),
        y: yCursor + PV_TITLE + PV_PAD + row * (PV_NODE_H + PV_GAP_Y),
        width: PV_NODE_W,
        height: PV_NODE_H,
        type: 'file',
        status: 'draft',
        description: `声明: ${c.decls.join(', ')}\n内聚引用: ${c.internal_refs}`,
        style: { borderRadius: 6 },
      });
      edges.push({
        id: `contains_${contId}_${idx}`,
        from: contId,
        to: nid,
        label: 'contains',
      });
    });

    r.inter_edges.forEach(([a, b, w], i) => {
      edges.push({
        id: `xref_${contId}_${i}`,
        from: `${contId}_split_${a}`,
        to: `${contId}_split_${b}`,
        label: `引用×${w}`,
        type: 'dashed',
        style: { stroke: '#FF9800' },
      });
    });

    yCursor += contH + PV_CONTAINER_GAP;
  }

  return {
    id: `${feature}_split_preview`,
    type: 'feature_diagram',
    feature,
    version: '1.0.0',
    title: `拆分建议预览（warning≥${warn} 行 / critical≥${crit} 行）`,
    status: 'draft',
    geometry: {
      layout: 'free',
      width: Math.max(800, PV_PAD * 4 + PV_COLS * PV_NODE_W + (PV_COLS - 1) * PV_GAP_X),
      height: Math.max(400, yCursor + PV_PAD),
      nodes,
      edges,
    },
  } as DesignDSL;
}

function sanitizeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

// ─────────────────────────────────────────────────────────────
// D6 主入口
// ─────────────────────────────────────────────────────────────

const WALK_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'output', 'vendor',
  '__pycache__', '.design-canvas', 'coverage', 'target', '.next', 'venv', '.venv',
]);

const SOURCE_EXT_RE = /\.(go|ts|tsx|js|jsx|py|mjs|cjs)$/;

function walkSourceFiles(root: string, max: number): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < max) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (out.length >= max) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!WALK_SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (SOURCE_EXT_RE.test(e.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

export async function checkMonolith(input: CheckMonolithInput): Promise<CheckMonolithResult> {
  const warn = input.warn_lines ?? 500;
  const crit = input.crit_lines ?? 1000;
  const flagCohesive = input.flag_cohesive ?? true;
  const maxFiles = input.max_files ?? 200;

  // 收集目标文件 [{abs, rel}]
  const targets: Array<{ abs: string; rel: string }> = [];
  if (input.files && input.files.length > 0) {
    for (const f of input.files.slice(0, maxFiles)) {
      const abs = path.resolve(f);
      targets.push({ abs, rel: path.basename(abs) });
    }
  } else if (input.feature) {
    const dsl = getDSL(input.feature);
    if (!dsl) throw new Error(`feature 不存在: ${input.feature}`);
    // 源码根回退链：显式 base_dir > DSL.source_root（导入时持久化的源码快照）> cwd
    const baseDir = path.resolve(input.base_dir ?? dsl.source_root ?? process.cwd());
    const files = (dsl.semantic?.files ?? []).slice(0, maxFiles);
    for (const sf of files) {
      const abs = path.resolve(baseDir, sf.path);
      targets.push({ abs, rel: sf.path });
    }
    if (targets.length === 0) throw new Error(`feature "${input.feature}" 无 semantic.files`);
  } else if (input.project_dir) {
    const root = path.resolve(input.project_dir);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new Error(`project_dir 不存在或不是目录: ${root}`);
    }
    for (const abs of walkSourceFiles(root, maxFiles)) {
      targets.push({ abs, rel: path.relative(root, abs).split(path.sep).join('/') });
    }
  } else {
    throw new Error('必须提供 project_dir / feature / files 之一');
  }

  // ── 体检缓存：源文件快照指纹 → 文件没变则复用上次报告，跳过重扫 ──
  // key 含 feature + 阈值参数：阈值变了即使文件没变也要重算（报告本就会变）
  let cacheKey: string | null = null;
  if (!input.no_cache) {
    const fp = fileFingerprint(targets);
    cacheKey = healthKey('monolith', [
      input.feature ?? input.project_dir ?? 'files',
      warn,
      crit,
      flagCohesive,
      maxFiles,
      fp,
    ]);
    const cached = readHealthCache<CheckMonolithResult>(cacheKey);
    if (cached) return cached;
  }

  // 逐文件分析
  const reports: FileMonolithReport[] = [];
  const readFailed: string[] = [];
  for (const t of targets) {
    let content: string;
    try {
      content = fs.readFileSync(t.abs, 'utf-8');
    } catch {
      readFailed.push(t.rel);
      continue;
    }
    reports.push(await analyzeFileContent(t.rel, content, warn, crit, flagCohesive));
  }

  // oversized = 真拆分候选（warning/critical）；cohesive 大而内聚不标红
  const oversized = reports.filter((r) => r.status === 'warning' || r.status === 'critical');
  const cohesive = reports.filter((r) => r.status === 'cohesive');
  // 报告排序：critical 在前，按行数降序
  oversized.sort((a, b) => b.lines - a.lines);

  // 预览 DSL（仅真拆分候选；cohesive 大而内聚不入预览容器）
  let previewFeature: string | undefined;
  if (input.save_preview && oversized.length > 0) {
    previewFeature = input.preview_feature ?? `${input.feature ?? 'monolith'}_split_preview`;
    const previewDsl = buildSplitPreviewDsl(previewFeature, oversized, warn, crit);
    saveDSL(previewDsl);
  }

  // 文本报告
  const linesOut: string[] = [
    `check_monolith：扫描 ${reports.length} 个文件，${oversized.length} 个超阈值（warning≥${warn} / critical≥${crit} 行）${cohesive.length ? `，另 ${cohesive.length} 个「大而内聚」未标红` : ''}`,
  ];
  if (readFailed.length) linesOut.push(`读取失败 ${readFailed.length} 个: ${readFailed.slice(0, 5).join(', ')}`);
  for (const r of oversized) {
    linesOut.push('', `【${r.status === 'critical' ? 'CRITICAL' : 'WARNING'}】${r.path} — ${r.lines} 行`);
    linesOut.push(`  ${r.suggestion}`);
    for (const c of r.communities) {
      linesOut.push(`    → ${c.suggested_name}（~${c.est_lines} 行，内聚引用 ${c.internal_refs}）: ${c.decls.join(', ')}`);
    }
  }
  if (cohesive.length) {
    linesOut.push('', `大而内聚（体积超阈值但引用内聚，不构成拆分候选）:`);
    for (const r of cohesive) linesOut.push(`  · ${r.path}（${r.lines} 行）`);
  }
  if (previewFeature) {
    linesOut.push('', `预览 DSL 已保存为 feature "${previewFeature}"，用 render_design 渲染查看拆分后视图。`);
  }
  if (oversized.length === 0 && cohesive.length === 0) {
    linesOut.push('所有文件行数健康，无单文件化风险。');
  } else if (oversized.length === 0) {
    linesOut.push('无拆分候选。大而内聚文件仅为体积提示，可自行决定是否分层拆解。');
  }

  const result: CheckMonolithResult = {
    message: linesOut.join('\n'),
    total_files: reports.length,
    oversized: oversized.length,
    reports: oversized,
    preview_feature: previewFeature,
  };
  if (cacheKey) writeHealthCache(cacheKey, result);
  return result;
}
