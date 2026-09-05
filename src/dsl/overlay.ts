/**
 * 设计层 overlay（design intent 增量保留层）
 *
 * 定位：真相 DSL（base）由代码扫描每次可再生，但设计意图（决策卡 / 决策历史 /
 * 设计参数 / 标注 / user_node / 分镜 / 主题）不是扫描能重造的。过去真相一刷新，
 * 设计 DSL 整体被 finalizeDsl 覆盖（saveDSL 直写），意图全丢。
 *
 * 本模块把设计意图抽成独立 overlay，通过「稳定锚点」增量对账，真相刷新时只替换
 * base，overlay 按锚点保留 / 迁移 / 孤儿 / 标过期，绝不整体覆盖。与项目铁律同构：
 * 真相单源 + 单向投影 + 对账（不改 DSL 只报偏差）。
 *
 * 存储：<features>/<feature>.overlay.json（见 storage_overlay.ts）。
 */
import { createHash } from 'node:crypto';
import type { DesignDSL } from './types.js';
import type { NodeDecision, DecisionHistoryEntry } from './geometry.js';
import type { Annotation } from './annotation.js';
import type { ThemeId, UserNode } from './types.js';
import type { ExpectedApi, Symbol } from './semantic.js';

/** 一个极简不可变 sha1 指纹，用于判断「接口签名变化」（过期的信号） */
export function computeFileSignature(
  apis: ExpectedApi[],
  nonFuncSymbols: Symbol[],
  lineCount: number,
): string {
  const parts = [
    ...(apis ?? []).map((a) => a.signature ?? '').sort(),
    ...(nonFuncSymbols ?? []).map((s) => `${s.kind}:${s.name}`).sort(),
    String(lineCount ?? 0),
  ].join('\n');
  return createHash('sha1').update(parts).digest('hex').slice(0, 12);
}

/** overlay 锚点：一份挂在稳定锚点上的设计意图 */
export interface OverlayAnchor {
  /** 相对路径（file=rel 路径；dir/brick=解码后的路径名） */
  path?: string;
  kind?: 'file' | 'dir' | 'brick' | 'symbol';
  /** 接口指纹（仅 file 节点有；dir/brick 无 → 永不判 stale） */
  signature?: string;
  /** 决策卡：结论/理由/替代/后果/验收 */
  decision?: NodeDecision;
  /** 决策卡·版本栈 */
  decision_history?: DecisionHistoryEntry[];
  /** 决策卡·参数表 */
  attributes?: Record<string, string | number | boolean>;
  /** 挂在该节点上的标注 */
  annotations?: Annotation[];
  /** 对账标记：真相面路径在、签名变 → 设计可能过期，需复核（不丢弃） */
  stale?: boolean;
  /** 对账标记：真相面已删除该锚点 → 设计暂存待决（不静默丢） */
  orphaned?: boolean;
  /** 迁移自哪个旧锚点（改名/换 id 时记录，便于审计） */
  _migratedFrom?: string;
}

/** overlay 全局件（不挂在具体节点上） */
export interface OverlayGlobal {
  /** feature 标题（人工修正的主题名） */
  title?: string;
  theme?: ThemeId;
  /** 顶层标注（未归属到单节点的） */
  annotations?: Annotation[];
  /** 人机共笔枝：用户在 AI 生成树上新增的分支 */
  user_nodes?: UserNode[];
  /** 科普分镜 meta.storyboard */
  storyboard?: unknown;
  /** 结构化目标/方向（缺口④）：全局性设计意图，LLM 开发时作为方向信号读 */
  goals?: OverlayGoal[];
}

/** 结构化目标/方向（缺口④）：全局性设计意图，落库进 base meta.goals */
export interface OverlayGoal {
  id: string;
  title: string;
  description?: string;
  /** active=推进中 · done=完成 · parked=暂缓 · dropped=放弃 */
  status?: 'active' | 'done' | 'parked' | 'dropped';
}

/** 边级设计意图（缺口③）：A 为何依赖 B / 边界归属，挂 base 边 id 上 */
export interface OverlayEdgeIntent {
  /** 源节点 id（对账时用 id→(from,to) 重定向） */
  from: string;
  /** 目标节点 id */
  to: string;
  /** A 为何依赖 B（关系级意图） */
  reason?: string;
  /** 边界归属说明（该依赖跨边界的理由/归属） */
  boundary?: string;
  /** 挂在边上的标注 */
  annotations?: Annotation[];
  /** 意图存活状态 */
  status?: 'open' | 'resolved';
  /** 对账标记：真相面已删该边 → 意图暂存待决（不静默丢） */
  orphaned?: boolean;
  /** 迁移自哪个旧边 id（边 id 变更时记录，便于审计） */
  _migratedFrom?: string;
}

/** 设计层 overlay 文档 */
export interface DesignOverlay {
  version: 1;
  feature: string;
  /** key = 写入时的节点锚点 id */
  anchors: Record<string, OverlayAnchor>;
  /** key = base 边的 id；边级意图随 base 再生按 id→(from,to) 对账保留 */
  edges?: Record<string, OverlayEdgeIntent>;
  global?: OverlayGlobal;
}

/** 真相面一个锚点候选（用于把旧 overlay 对齐到新 base） */
export interface AnchorCandidate {
  id: string;
  path: string;
  kind: 'file' | 'dir' | 'brick' | 'symbol';
  /** 接口指纹 */
  signature?: string;
}

/** 对账统计（报告用） */
export interface ReconcileStats {
  retained: number;
  migrated: number;
  orphaned: number;
  stale: number;
}

/** 从节点推导稳定路径（file 用 description=rel；dir/brick 解码 id 前缀）。base 与 seed 共用，保证两次对齐一致 */
export function nodePath(n: { id: string; type?: string; description?: string }): string {
  if (n.type === 'file') return n.description ?? n.id;
  if (n.type === 'module' && n.id.startsWith('dir_')) return decodeDirId(n.id);
  if (n.id.startsWith('brick_')) return n.id.slice('brick_'.length);
  return n.description ?? n.id;
}

function decodeDirId(id: string): string {
  // dir_id 由 sanitize(rel) 生成（非字母数字 → _）。解码丢失点，但 base 侧每次同样解码 → 两侧一致。
  return id.slice('dir_'.length).replace(/_/g, '/');
}

/** 从一份已落盘的 base DSL 提取锚点候选（签名由 semantic.files 带出） */
export function buildCandidates(dsl: DesignDSL): AnchorCandidate[] {
  const bySem = new Map((dsl.semantic?.files ?? []).map((f) => [f.id, f]));
  return (dsl.geometry?.nodes ?? []).map((n) => {
    const sf = bySem.get(n.id);
    const kind: AnchorCandidate['kind'] =
      n.type === 'module'
        ? 'dir'
        : n.id.startsWith('brick_')
          ? 'brick'
          : n.type === 'file'
            ? 'file'
            : 'symbol';
    let signature: string | undefined;
    if (sf && kind === 'file') {
      signature = computeFileSignature(sf.expected_apis ?? [], sf.symbols ?? [], sf.lines ?? 0);
    }
    return { id: n.id, path: nodePath(n), kind, signature };
  });
}

/** 边级对账用候选：从 base 提取边的稳定身份（id + from→to 端点） */
export interface EdgeCandidate {
  id: string;
  from: string;
  to: string;
}

/** 从一份 base DSL 提取边候选（对旧 overlay.edges 做 id→(from,to) 对账用） */
export function buildEdgeCandidates(base: DesignDSL): EdgeCandidate[] {
  return (base.geometry?.edges ?? []).map((e) => ({ id: e.id, from: e.from, to: e.to }));
}

/** 对账：把旧 overlay 按稳定锚点对齐到新 base 的锚点集 */
export function reconcileOverlay(
  old: DesignOverlay,
  newCandidates: AnchorCandidate[],
  newEdgeCandidates?: EdgeCandidate[],
): { overlay: DesignOverlay; stats: ReconcileStats } {
  const byPath = new Map<string, AnchorCandidate>();
  const bySig = new Map<string, AnchorCandidate[]>();
  for (const c of newCandidates) {
    byPath.set(c.path, c);
    if (c.signature) {
      const arr = bySig.get(c.signature) ?? [];
      arr.push(c);
      bySig.set(c.signature, arr);
    }
  }

  const stats: ReconcileStats = { retained: 0, migrated: 0, orphaned: 0, stale: 0 };
  const anchors: Record<string, OverlayAnchor> = {};

  for (const [oldKey, a] of Object.entries(old.anchors)) {
    // 上轮已判定孤儿的设计：只在首次明示，本轮回收（真相若重现路径会重新长锚点，不再追溯）
    if (a.orphaned) {
      anchors[oldKey] = a;
      continue;
    }

    let target: AnchorCandidate | undefined;

    const byPathHit = a.path ? byPath.get(a.path) : undefined;
    if (byPathHit) {
      target = byPathHit;
    } else if (a.signature) {
      // 路径漂移 → 尝试按接口签名认亲（改名检测）
      target = bySig.get(a.signature)?.[0];
    }

    if (!target) {
      // 真相面已删除该锚点 → 孤儿暂存，不静默丢
      anchors[oldKey] = { ...a, orphaned: true };
      stats.orphaned++;
      continue;
    }

    const migrated = target.id !== oldKey;
    const sigChanged = !!(a.signature && target.signature && a.signature !== target.signature);
    let na: OverlayAnchor;
    if (migrated) {
      // 改名/换 id：以新身份重新挂靠，签名随新路径取（stale 视为新起点，清掉旧标记）
      na = { ...a, path: target.path, kind: target.kind, signature: target.signature ?? a.signature };
      delete na.orphaned;
      delete na.stale;
      na._migratedFrom = oldKey;
      stats.migrated++;
    } else if (sigChanged) {
      // 接口签名变化：保留基线签名 + 标过期。直到签名回到基线才清除，可持续提示复核
      na = { ...a, path: target.path, kind: target.kind };
      delete na.orphaned;
      delete na._migratedFrom;
      na.signature = a.signature; // 保留基线（设计校验时的那份接口指纹）
      na.stale = true;
      stats.stale++;
      stats.retained++; // 设计被保留（仅标过期待复核），计入保留数
    } else {
      // 锚点一致/无基线：采用当前签名作为新基线，清除过期与迁移标记
      na = { ...a, path: target.path, kind: target.kind, signature: target.signature ?? a.signature };
      delete na.orphaned;
      delete na.stale;
      delete na._migratedFrom;
      stats.retained++;
    }
    anchors[target.id] = na;
  }

  // —— 边级意图对账（缺口③）：按 id→(from,to)→孤儿 对齐旧 edges 到新 base 边 ----
  let edges: Record<string, OverlayEdgeIntent> | undefined;
  if (old.edges && Object.keys(old.edges).length > 0) {
    const newById = new Map((newEdgeCandidates ?? []).map((e) => [e.id, e]));
    const newByPair = new Map((newEdgeCandidates ?? []).map((e) => [`${e.from}\u0000${e.to}`, e]));
    const resolved: Record<string, OverlayEdgeIntent> = {};
    for (const [oldEdgeId, intent] of Object.entries(old.edges)) {
      let target = newById.get(oldEdgeId);
      const isOrphaned = intent.orphaned;
      if (!target) {
        if (isOrphaned) { resolved[oldEdgeId] = intent; continue; } // 上轮孤儿：本轮只保留，不再追溯
        // 边 id 变了 → 尝试 (from,to) 认亲（依赖两端稳定则续能识别）
        target = newByPair.get(`${intent.from}\u0000${intent.to}`);
      }
      if (!target) {
        resolved[oldEdgeId] = { ...intent, orphaned: true }; // 真相面该边已删 → 孤儿暂存
        continue;
      }
      resolved[target.id] = target.id === oldEdgeId ? intent : { ...intent, _migratedFrom: oldEdgeId };
    }
    edges = resolved;
  }

  return { overlay: { ...old, anchors, ...(edges ? { edges } : {}) }, stats };
}

function mergeById<T extends { id: string }>(list: T[], add: T[]): T[] {
  const seen = new Set(list.map((x) => x.id));
  const out = [...list];
  for (const a of add) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out;
}

/** 把 overlay 的设计意图合回到 base（返回新对象，不改 base 引用） */
export function applyOverlay(base: DesignDSL, overlay: DesignOverlay): DesignDSL {
  const out: DesignDSL = { ...base };

  const nodes = (base.geometry?.nodes ?? []).map((n) => {
    const a = overlay.anchors[n.id];
    if (!a) return n;
    return {
      ...n,
      ...(a.decision ? { decision: a.decision } : {}),
      ...(a.decision_history ? { decision_history: a.decision_history } : {}),
      ...(a.attributes ? { attributes: a.attributes } : {}),
    };
  });
  out.geometry = { ...base.geometry!, nodes };

  // —— 边级意图（缺口③）：把 overlay.edges 的 reason/boundary 写回 base 边（id 已对账对齐）——
  if (overlay.edges && Object.keys(overlay.edges).length > 0) {
    const edges = (base.geometry?.edges ?? []).map((e) => {
      const ei = overlay.edges![e.id];
      if (!ei || ei.orphaned) return e;
      return { ...e, intent: { reason: ei.reason, boundary: ei.boundary } };
    });
    out.geometry = { ...out.geometry, edges };
  }

  // 标注：锚点内 + 全局，按 id 去重合回
  let anns: Annotation[] = out.annotations ?? [];
  for (const a of Object.values(overlay.anchors)) {
    if (a.annotations?.length) anns = mergeById(anns, a.annotations);
  }
  if (overlay.global?.annotations?.length) anns = mergeById(anns, overlay.global.annotations);
  out.annotations = anns;

  const g = overlay.global;
  if (g) {
    if (g.title) out.title = g.title;
    if (g.theme) out.theme = g.theme;
    if (g.user_nodes?.length) out.user_nodes = g.user_nodes;
    if (g.storyboard !== undefined || g.goals !== undefined) {
      const rec = out as unknown as { meta?: Record<string, unknown> };
      rec.meta = {
        ...(rec.meta ?? {}),
        ...(g.storyboard !== undefined ? { storyboard: g.storyboard } : {}),
        // 结构化目标（缺口④）：落进 meta.goals 供 LLM 作方向信号读；overlay 显式给了 goals（含空数组清空）就如实写入
        ...(g.goals !== undefined ? { goals: g.goals } : {}),
      };
    }
  }
  return out;
}

/**
 * 首次迁移：从一份既有设计 DSL 抽出现有设计意图，铺成 overlay（一次性的兼容垫）。
 * 只保留「人类意图字段」（决策/决策历史/参数/标注/user_node/主题/分镜/标题），
 * 不保留可再生的派生字段（LLM 职责标题、layer/host 分层、布局坐标、i18n title_en）。
 */
export function seedOverlayFromDsl(dsl: DesignDSL | null): DesignOverlay {
  const anchors: Record<string, OverlayAnchor> = {};
  const global: OverlayGlobal = {};

  const annIndex = new Map<string, Annotation[]>();
  for (const a of dsl?.annotations ?? []) {
    const key = a.node_id ?? a.target_id;
    if (!key) {
      (global.annotations ??= []).push(a);
      continue;
    }
    const arr = annIndex.get(key) ?? [];
    arr.push(a);
    annIndex.set(key, arr);
  }

  for (const n of dsl?.geometry?.nodes ?? []) {
    const anns = annIndex.get(n.id);
    if (!n.decision && !n.decision_history && !n.attributes && !anns?.length) continue;
    const a: OverlayAnchor = { path: nodePath(n), kind: nodePathKind(n) };
    if (n.decision) a.decision = n.decision;
    if (n.decision_history) a.decision_history = n.decision_history;
    if (n.attributes) a.attributes = n.attributes;
    if (anns?.length) a.annotations = anns;
    anchors[n.id] = a as OverlayAnchor;
  }

  if (dsl?.title) global.title = dsl.title;
  if (dsl?.theme) global.theme = dsl.theme;
  if (dsl?.user_nodes) global.user_nodes = dsl.user_nodes;
  const meta = (dsl as unknown as { meta?: { storyboard?: unknown; goals?: OverlayGoal[] } } | null)?.meta;
  if (meta?.storyboard) global.storyboard = meta.storyboard;
  if (meta?.goals && meta.goals.length > 0) global.goals = meta.goals;

  // 边级意图（缺口③）：base 若已带 edge.intent（上一轮 apply 产物）→ 铺回 overlay，保证迁移/回环不掉
  const edges: Record<string, OverlayEdgeIntent> = {};
  for (const e of dsl?.geometry?.edges ?? []) {
    if (!e.intent) continue;
    edges[e.id] = {
      from: e.from,
      to: e.to,
      reason: e.intent.reason,
      boundary: e.intent.boundary,
    };
  }

  return {
    version: 1,
    feature: dsl?.feature ?? '',
    anchors,
    ...(Object.keys(edges).length ? { edges } : {}),
    global: Object.keys(global).length ? global : undefined,
  };
}

function nodePathKind(n: { id: string; type?: string }): OverlayAnchor['kind'] {
  if (n.type === 'module' || n.id.startsWith('dir_')) return 'dir';
  if (n.type === 'file') return 'file';
  if (n.id.startsWith('brick_')) return 'brick';
  return 'symbol';
}

/** 对账统计的通用人类可读行（供报告 / 测试复用） */
export function statsLine(stats: ReconcileStats): string {
  return `设计意图保留：保留 ${stats.retained} / 迁移 ${stats.migrated} / 孤儿 ${
    stats.orphaned
  }（真相已删，暂存待决）/ 过期 ${stats.stale}（签名变化，标需复核）`;
}