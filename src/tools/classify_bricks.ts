/**
 * classify_bricks —— 分类官：把**功能簇**归入软件解剖学槽位（自顶向下组织的关键一步）
 *
 * 用户定调：先定义好"一个软件该有哪些部分"（taxonomy 槽位，人话、封闭集合），
 * 再归类，从上往下下钻。粒度选**簇**而非积木——狗食证明积木太粗（tools 119 文件
 * 横跨核心运算/观测/人审多个身份，整块归类必然失真）；簇是"单一职责的最小功能
 * 单元"，恰好一个身份，天生的分类单元。积木在泳道内作为分组容器保留。
 *
 * LLM 角色（分类官）：
 *   - 证据 = 簇人话（cluster_narrator 已译）+ 簇内文件 + 槽位判据
 *   - 输出 = 封闭集合内的 slot id + confidence + reason（防串、防发明）
 *   - 降级（rule）= 簇内文件路径关键词启发式；不中 → 诚实进"未归类"桶
 *
 * 交叉验证信号（limitations）：分类学 vs 依赖分层的倒挂提示。
 */

import type { BrickifyResult } from './brickify.js';
import type { ClusterNarratives } from './cluster_narrator.js';
import { loadLlmConfig, callChat } from './llm_focus.js';
import { loadExplainConfig } from './explain_gen.js';
import { defaultPipelineTaxonomy, slotIndex, type Taxonomy, type TaxonomySlot } from './taxonomy.js';

export interface ClusterClassification {
  slot: string;
  confidence: number;
  reason: string;
  mode: 'llm' | 'rule';
}

export interface AnatomySlotView {
  slot: TaxonomySlot;
  /** 槽位内按积木分组（积木=分组容器，簇=归类单元） */
  groups: Array<{
    brick: string;
    brickTitle: string;
    clusters: Array<{
      id: string;
      title: string;
      desc: string;
      files: number;
      cohesion: number;
      classification: ClusterClassification;
    }>;
  }>;
}

export interface AnatomyResult {
  taxonomy: Taxonomy;
  slots: AnatomySlotView[];
  /** 未归类簇 id 清单（诚实残留） */
  unclassified: string[];
  meta: {
    mode: 'llm' | 'rule';
    llm_ok: number;
    total: number;
  };
  limitations: string[];
}

export interface ClassifyOptions {
  taxonomy?: Taxonomy;
}

/** 规则降级：簇内文件路径关键词启发式。 */
export function classifyByRule(
  r: BrickifyResult,
  taxonomy: Taxonomy,
): Record<string, ClusterClassification> {
  const out: Record<string, ClusterClassification> = {};
  for (const b of r.bricks) {
    for (const s of b.sub_clusters) {
      const haystack = `${b.id} ${s.id} ${s.files.slice(0, 20).join(' ')}`.toLowerCase();
      let best: { slot: string; hits: number } | null = null;
      for (const slot of taxonomy.slots) {
        const hits = slot.keywords.reduce((acc, kw) => acc + (haystack.includes(kw) ? 1 : 0), 0);
        if (hits > 0 && (!best || hits > best.hits)) best = { slot: slot.id, hits };
      }
      out[s.id] = best
        ? { slot: best.slot, confidence: Math.min(0.7, 0.3 + best.hits * 0.15), reason: '启发式：路径命中关键词', mode: 'rule' }
        : { slot: '__unclassified__', confidence: 0.2, reason: '启发式未命中', mode: 'rule' };
    }
  }
  return out;
}

function toLlmCfg(c: ReturnType<typeof loadExplainConfig>) {
  return c ? { apiKey: c.apiKey, model: c.model, baseURL: c.baseURL } : null;
}

/** LLM 分类官：封闭槽位集合 + 簇证据 → 归类（粒度=簇）。 */
async function classifyByLlm(
  cfg: { apiKey: string; model: string; baseURL: string },
  r: BrickifyResult,
  narratives: ClusterNarratives | undefined,
  taxonomy: Taxonomy,
): Promise<Record<string, ClusterClassification> | null> {
  const slotsText = taxonomy.slots
    .map((s) => `- ${s.id}（${s.label}）：${s.desc}`)
    .join('\n');

  const items = r.bricks.flatMap((b) =>
    b.sub_clusters.map((s) => {
      const nar = narratives?.clusters[s.id];
      return {
        id: s.id,
        brick: b.id,
        title: nar?.title ?? s.id,
        desc: nar?.desc ?? '',
        files: s.files.slice(0, 5).join(', '),
      };
    }),
  );

  // 分批（大项目簇多，单发 payload 会爆）；批内上下文带槽位定义
  const BATCH = 12;
  const out: Record<string, ClusterClassification> = {};
  for (let i = 0; i < items.length; i += BATCH) {
    const group = items.slice(i, i + BATCH);
    const clustersText = group
      .map(
        (c) =>
          `### ${c.id}（积木 ${c.brick}）\n功能：${c.title}${c.desc ? `——${c.desc}` : ''}\n文件：${c.files}`,
      )
      .join('\n\n');

    const system =
      '你是软件架构分类官。给定"软件解剖学槽位"（封闭集合）和项目的功能簇清单，' +
      '请把每个功能簇归入**恰好一个**槽位。要求：\n' +
      '- slot 必须来自给定槽位 id，禁止发明；拿不准时选最接近的并降 confidence；\n' +
      '- confidence 0..1（证据充分≥0.8，模棱两可≤0.5）；\n' +
      '- reason 一句话依据；每个簇都必须有归类结果。\n' +
      '只输出 JSON：{"assignments":[{"id":"...","slot":"...","confidence":0.9,"reason":"..."}]}，id 来自给定清单。';

    const raw = await callChat(cfg, [
      { role: 'system', content: system },
      { role: 'user', content: `槽位定义：\n${slotsText}\n\n功能簇清单（${group.length} 个）：\n${clustersText}` },
    ]);
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fence ? fence[1] : raw;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
      assignments?: Array<{ id?: string; slot?: string; confidence?: number; reason?: string }>;
    };
    const valid = slotIndex(taxonomy);
    const known = new Set(group.map((g) => g.id));
    for (const a of parsed.assignments ?? []) {
      if (!a.id || !a.slot || !valid.has(a.slot) || !known.has(a.id)) continue;
      out[a.id] = {
        slot: a.slot,
        confidence: Math.max(0, Math.min(1, a.confidence ?? 0.5)),
        reason: (a.reason ?? '').trim().slice(0, 80),
        mode: 'llm',
      };
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** 分类学 vs 依赖分层交叉验证：上游槽位被下游依赖是正常流向，倒挂给提示。 */
function crossValidate(
  r: BrickifyResult,
  assignments: Record<string, ClusterClassification>,
  taxonomy: Taxonomy,
): string[] {
  const orderOf = new Map(taxonomy.slots.map((s, i) => [s.id, i]));
  const clusterSlot = new Map<string, string>();
  for (const b of r.bricks)
    for (const s of b.sub_clusters) clusterSlot.set(s.id, assignments[s.id]?.slot ?? '');
  const fileToCluster = new Map<string, string>();
  for (const b of r.bricks) for (const s of b.sub_clusters) for (const f of s.files) fileToCluster.set(f, s.id);

  const notes: string[] = [];
  const acc = new Map<string, number>();
  for (const d of r.file_deps) {
    const a = clusterSlot.get(fileToCluster.get(d.from) ?? '');
    const b2 = clusterSlot.get(fileToCluster.get(d.to) ?? '');
    if (!a || !b2 || a === b2) continue;
    const k = `${a}\u0001${b2}`;
    acc.set(k, (acc.get(k) ?? 0) + d.count);
  }
  for (const [k, count] of acc) {
    const i = k.indexOf('\u0001');
    const from = k.slice(0, i);
    const to = k.slice(i + 1);
    // from 调用 to = from 依赖 to = from 应在下游（order 更大）。倒挂 = 上游槽位依赖下游且量大
    if ((orderOf.get(from) ?? 0) < (orderOf.get(to) ?? 0) - 2 && count >= 3) {
      const label = (id: string): string => taxonomy.slots.find((s) => s.id === id)?.label ?? id;
      notes.push(`倒挂信号：槽位「${label(from)}」依赖「${label(to)}」${count} 次，归类或依赖方向建议复核`);
    }
  }
  return [...new Set(notes)].slice(0, 5);
}

/**
 * 主入口：功能簇 → 解剖学槽位归类，产出泳道视图（槽位→积木分组→簇，供渲染直接吃）。
 * LLM 缺席/失败 → 关键词启发式降级；启发式也命不中 → 诚实"未归类"桶。
 */
export async function classifyBricks(
  r: BrickifyResult,
  narratives: ClusterNarratives | undefined,
  opts: ClassifyOptions = {},
): Promise<AnatomyResult> {
  const taxonomy = opts.taxonomy ?? defaultPipelineTaxonomy();
  const rule = classifyByRule(r, taxonomy);

  let assignments = rule;
  let llmOk = 0;
  const cfg = loadLlmConfig() ?? toLlmCfg(loadExplainConfig());
  if (cfg) {
    try {
      const llm = await classifyByLlm(cfg, r, narratives, taxonomy);
      if (llm) {
        assignments = { ...rule, ...llm };
        llmOk = Object.keys(llm).length;
      }
    } catch {
      // LLM 失败：保持启发式
    }
  }

  // 组装泳道视图：槽位 → 积木分组 → 簇
  const slotGroups = new Map<string, Map<string, string[]>>(); // slot → brick → cluster ids
  const unclassified: string[] = [];
  for (const b of r.bricks) {
    for (const s of b.sub_clusters) {
      const slot = assignments[s.id]?.slot ?? '__unclassified__';
      if (slot === '__unclassified__') unclassified.push(s.id);
      else {
        if (!slotGroups.has(slot)) slotGroups.set(slot, new Map());
        const g = slotGroups.get(slot)!;
        if (!g.has(b.id)) g.set(b.id, []);
        g.get(b.id)!.push(s.id);
      }
    }
  }

  const slots: AnatomySlotView[] = taxonomy.slots.map((slot) => {
    const groups = slotGroups.get(slot.id) ?? new Map();
    return {
      slot,
      groups: [...groups.entries()].map(([bid, clusterIds]) => {
        const b = r.bricks.find((x) => x.id === bid)!;
        return {
          brick: bid,
          brickTitle: narratives?.bricks[bid]?.title ?? bid,
          clusters: clusterIds.map((cid: string) => {
            const s = b.sub_clusters.find((x) => x.id === cid)!;
            return {
              id: cid,
              title: narratives?.clusters[cid]?.title ?? cid,
              desc: narratives?.clusters[cid]?.desc ?? '',
              files: s.files.length,
              cohesion: Math.round(s.cohesion * 100),
              classification: assignments[cid],
            };
          }),
        };
      }),
    };
  });

  return {
    taxonomy,
    slots,
    unclassified,
    meta: { mode: llmOk > 0 ? 'llm' : 'rule', llm_ok: llmOk, total: r.bricks.reduce((a, b) => a + b.sub_clusters.length, 0) },
    limitations: [
      ...crossValidate(r, assignments, taxonomy),
      llmOk === 0 ? 'LLM 未配置/失败，当前为关键词启发式归类（mode=rule），置信度有限' : '',
    ].filter(Boolean),
  };
}
