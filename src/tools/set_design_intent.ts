/**
 * set_design_intent —— 写设计意图到 overlay（缺口①③④ 的写入口，LLM 即消费方）
 *
 * 写两类意图（均可选，至少传一类）：
 *   · goals：全量替换 feature 的结构化目标/方向（OverlayGlobal.goals → applyOverlay 落进 base meta.goals）
 *   · edge_intents：按 base 边（id 或 from+to 匹配）挂/改「A 为何依赖 B」与边界归属，写进 overlay.edges
 *                   → applyOverlay 落进 base 边 intent
 *
 * overlay 是意图的权威存储（<feature>.overlay.json）；落完随即把意图 apply 回 base 并 saveDSL，
 * 让 get_dsl / serve 当下就读到，无需等下一次代码扫描再生。
 *
 * 与 base 再生对账：写前先用 buildCandidates/buildEdgeCandidates 把旧 overlay reconcile 到当前 base，
 * 保证 edges 键与 base 边 id 一致、被删边按孤儿暂存；此前孤儿、边重现时复原。
 */
import { getDSL, saveDSL } from '../storage.js';
import { loadOverlay, saveOverlay } from '../storage_overlay.js';
import {
  reconcileOverlay,
  buildCandidates,
  buildEdgeCandidates,
  seedOverlayFromDsl,
  applyOverlay,
} from '../dsl/overlay.js';
import type { OverlayGoal, OverlayEdgeIntent } from '../dsl/overlay.js';

/** 单条边意图写入：id 优先，其次 from+to 匹配 base 边 */
export interface DesignEdgeIntentWrite {
  /** 目标 base 边 id（与 from/to 同时给时以 id 为准，from/to 作校验） */
  id?: string;
  /** 源节点 id（无 id 时用 from+to 定位边） */
  from?: string;
  /** 目标节点 id */
  to?: string;
  /** A 为何依赖 B */
  reason?: string;
  /** 边界归属 */
  boundary?: string;
  status?: 'open' | 'resolved';
}

export interface SetDesignIntentInput {
  feature: string;
  goals?: OverlayGoal[];
  edge_intents?: DesignEdgeIntentWrite[];
}

export interface SetDesignIntentResult {
  message: string;
  feature: string;
  goals: number;
  edges_written: Array<{ id: string; from: string; to: string }>;
  unmatched: Array<{ id?: string; from?: string; to?: string; reason?: string }>;
}

export function setDesignIntent(input: SetDesignIntentInput): SetDesignIntentResult {
  const dsl = getDSL(input.feature);
  if (!dsl) throw new Error(`feature "${input.feature}" 不存在`);

  // 读旧 overlay（无则从现有设计 DSL 一次性迁移铺底），再对账到当前 base
  const base = loadOverlay(input.feature) ?? seedOverlayFromDsl(dsl);
  const { overlay } = reconcileOverlay(base, buildCandidates(dsl), buildEdgeCandidates(dsl));

  // —— 目标：全量替换（空数组 = 清空展开式目标）——
  const goals = Array.isArray(input.goals) ? input.goals : undefined;
  if (goals) overlay.global = { ...(overlay.global ?? {}), goals };

  // —— 边意图：按 id / from+to 匹配 base 边挂载 ——
  const intents = Array.isArray(input.edge_intents) ? input.edge_intents : [];
  const edges_written: SetDesignIntentResult['edges_written'] = [];
  const unmatched: SetDesignIntentResult['unmatched'] = [];
  if (intents.length > 0) {
    const byId = new Map((dsl.geometry?.edges ?? []).map((e) => [e.id, e]));
    const byPair = new Map((dsl.geometry?.edges ?? []).map((e) => [`${e.from}\u0000${e.to}`, e]));
    const changed: Record<string, OverlayEdgeIntent> = { ...(overlay.edges ?? {}) };
    for (const it of intents) {
      const edge = it.id ? byId.get(it.id) : it.from && it.to ? byPair.get(`${it.from}\u0000${it.to}`) : undefined;
      if (!edge) {
        unmatched.push({ id: it.id, from: it.from, to: it.to, reason: it.reason });
        continue;
      }
      const prev = changed[edge.id];
      changed[edge.id] = {
        from: edge.from,
        to: edge.to,
        reason: it.reason ?? prev?.reason,
        boundary: it.boundary ?? prev?.boundary,
        status: it.status ?? prev?.status,
      };
      // 此前孤儿、现在真相重现 → 复原（清孤儿标记）
      delete changed[edge.id].orphaned;
      delete changed[edge.id]._migratedFrom;
      edges_written.push({ id: edge.id, from: edge.from, to: edge.to });
    }
    if (intents.length) overlay.edges = changed;
  }

  // 有改动才落盘 + 落回 base（让 get_dsl 当下读到）
  const hasChange = goals !== undefined || intents.length > 0;
  if (hasChange) {
    saveOverlay(overlay);
    const merged = applyOverlay(dsl, overlay);
    saveDSL(merged, 'tool');
  }

  const parts: string[] = [`写入设计意图 · feature=${input.feature}`];
  if (goals) parts.push(`目标 ${goals.length} 条（全量替换）`);
  if (intents.length) parts.push(`边意图 ${edges_written.length}/${intents.length} 条（${edges_written.map((w) => w.id).join(',')}）`);
  if (unmatched.length) parts.push(`未匹配边 ${unmatched.length} 条（${unmatched.map((u) => u.id || `${u.from}->${u.to}`).join(',')}）`);
  if (!hasChange) parts.push('（未传 goals / edge_intents，无改动）');
  const msg = [...(unmatched.length ? ['[部分写入]'] : []), ...parts].join(' · ');

  return { message: msg, feature: input.feature, goals: goals?.length ?? 0, edges_written, unmatched };
}