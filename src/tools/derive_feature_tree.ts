/**
 * derive_feature_tree —— 功能树生成（项目 → 功能 → 社区 → 文件）
 *
 * 把"一滩平铺的文件星图"变成逐级下钻的层级导航数据：
 *   项目（feature 根）→ 几大功能 → 社区（analyze_monolith 功能社区）→ 文件
 *
 * 数据来源：
 *   - analyze_monolith：基于 cache.db 调用边做跨文件 Louvain 功能社区圈定，
 *     产出 communities（功能社区，锚点名 + 横跨文件）与 file_view（文件内社区分布）。
 *   - 本工具把社区**二次归并**成"几大功能"（社区锚点归并），并建立
 *     文件 → 主导社区 → 功能 的归属映射（file_map）。
 *
 * 归并策略：
 *   - gen_names=true（配置了 LLM，llm_focus / explain_gen 兼容 DEEPSEEK/AGNES）：
 *     把全部社区描述交给 LLM，让它按业务语义归并成 3-8 个功能并起中文名。
 *   - 否则 / LLM 输出非法：规则兜底——按社区成员文件的首段目录归并。
 * 结果写入 DSL 顶层 feature_tree 字段，供渲染端逐级下钻。
 */

import { analyzeMonolith } from './analyze_monolith.js';
import { getDSL, saveDSL } from '../storage.js';
import { loadLlmConfig, callChat } from './llm_focus.js';
import { loadExplainConfig } from './explain_gen.js';
import type { FeatureTree, FeatureNode, FeatureCommunity } from '../dsl/types.js';

export interface FeatureTreeInput {
  /** 项目根（定位 <root>/.design-canvas/cache.db） */
  project_dir: string;
  /** 可选：注入已打开的 cache.db 连接（复用调用方同一实例，避免路径漂移）；缺省按 project_dir 推导 */
  db?: import('../db/db.js').Database;
  /** 可选：写入哪个 feature 的 DSL（缺省不落盘，仅返回） */
  feature?: string;
  /** 是否用 LLM 归并社区成功能并起中文名（默认 false，未配置 LLM 时静默降级为目录归并） */
  gen_names?: boolean;
}

export interface FeatureTreeResult {
  feature?: string;
  /** 功能层 */
  features: Array<FeatureNode & { file_count: number }>;
  /** 参与归属的文件总数 */
  file_count: number;
  /** 未归入任何社区的孤立文件数（通常无调用边，如纯配置/定义） */
  unassigned_count: number;
  message: string;
}

/** 把 LLM 配置格式（explain_gen）转为通用 LlmConfig */
function toLlmCfg(c: ReturnType<typeof loadExplainConfig>) {
  return c ? { apiKey: c.apiKey, model: c.model, baseURL: c.baseURL } : null;
}

/** 取文件路径首段目录，作为规则兜底归并主键 */
function dirOf(p: string): string {
  const seg = p.split('/');
  return seg.length > 1 ? seg[0] : '(根)';
}

/** 用 LLM 把全部社区归并成几大功能：返回 [{ name, community_ids }] 或 null（调用失败/输出非法） */
async function groupFeaturesByLLM(
  comms: Array<{ id: number; name: string; files: string[]; est_lines: number }>,
): Promise<Array<{ name: string; community_ids: number[] }> | null> {
  if (comms.length === 0) return null;
  const cfg = loadLlmConfig() ?? toLlmCfg(loadExplainConfig());
  if (!cfg) return null;

  const list = comms
    .map((c) => `- ${c.id}: 锚点[${c.name}] · ${c.files.length} 文件(如 ${c.files.slice(0, 3).join(', ')}) · ~${c.est_lines} 行`)
    .join('\n');
  const prompt =
    `下面是一个软件项目的 ${comms.length} 个"功能社区"（每个社区 = 一个按调用边聚到一起的功能锚点及成员文件）。` +
    `一个社区内部高度内聚，不应再拆开；但多个社区可能属于同一个更大的**业务功能**。` +
    `请把这些社区归并成 **3-8 个"功能"**，每个功能给一个简短的**中文名**（4-8 字，如"渲染引擎""配置加载""命令分发"）。` +
    `要求：\n` +
    `1) 每个社区必须且只能归入一个功能；\n` +
    `2) 归并依据是业务语义（锚点/文件体现的职责），不是目录名；\n` +
    `3) 社区特别大时可单独成功能，不要强行塞进无关功能。\n` +
    `只输出 JSON 对象，形如 {"features":[{"name":"渲染引擎","community_ids":[1,5,7]}]}，不要任何其他文字。\n\n${list}`;
  try {
    const text = await callChat(cfg, [{ role: 'user', content: prompt }]);
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as { features?: Array<{ name?: string; community_ids?: unknown }> };
    if (!Array.isArray(parsed.features) || parsed.features.length < 1) return null;
    const out: Array<{ name: string; community_ids: number[] }> = [];
    const seen = new Set<number>();
    for (const f of parsed.features) {
      const name = String(f.name ?? '').trim();
      const ids = Array.isArray(f.community_ids) ? f.community_ids.filter((x) => Number.isInteger(x)).map(Number) : [];
      if (!name || name.length > 12 || ids.length === 0) continue;
      const validIds = ids.filter((id) => comms.some((c) => c.id === id) && !seen.has(id));
      if (validIds.length === 0) continue;
      for (const id of validIds) seen.add(id);
      out.push({ name, community_ids: validIds });
    }
    // 校验：所有社区都被归并（漏的归入"其他"），无重复
    if (seen.size === 0) return null;
    const missing = comms.filter((c) => !seen.has(c.id)).map((c) => c.id);
    if (missing.length > 0) out.push({ name: '其他', community_ids: missing });
    return out;
  } catch {
    return null;
  }
}

/** 规则兜底：按社区成员文件首段目录归并成功能 */
function groupByDir(
  comms: Array<{ id: number; name: string; files: string[]; est_lines: number; symbol_count: number }>,
): FeatureNode[] {
  const bucketOf = new Map<number, string>();
  for (const c of comms) {
    if (c.files.length === 0) { bucketOf.set(c.id, '(根)'); continue; }
    const dirs = new Map<string, number>();
    for (const f of c.files) {
      const d = dirOf(f);
      dirs.set(d, (dirs.get(d) || 0) + 1);
    }
    let best = '(根)';
    let bestN = 0;
    for (const [d, n] of dirs) if (n > bestN) { best = d; bestN = n; }
    bucketOf.set(c.id, best);
  }
  const byKey = new Map<string, number[]>();
  for (const [cid, key] of bucketOf) {
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(cid);
  }
  const features: FeatureNode[] = [];
  for (const [key, ids] of byKey) {
    features.push({ id: '', name: key, communities: ids.map((id) => comms.find((c) => c.id === id)!) });
  }
  return features;
}

export async function deriveFeatureTree(
  input: FeatureTreeInput,
): Promise<FeatureTreeResult> {
  const mono = analyzeMonolith({ project_dir: input.project_dir, db: input.db });
  if (mono.communities.length === 0) {
    return {
      feature: input.feature,
      features: [],
      file_count: 0,
      unassigned_count: 0,
      message: mono.message,
    };
  }

  // 1. 文件 → 主导社区（取 file_view 内符号数最多的社区）
  const fileToCommunity = new Map<string, number>();
  for (const fv of mono.file_view) {
    if (fv.communities.length === 0) continue;
    let top = fv.communities[0];
    for (const c of fv.communities) if (c.symbols > top.symbols) top = c;
    fileToCommunity.set(fv.path, top.id);
  }

  // 2. 提取社区描述（含文件、行数），供归并
  const comms: Array<{ id: number; name: string; files: string[]; est_lines: number; symbol_count: number }> =
    mono.communities
      .filter((c) => c.files.length > 0)
      .map((c) => ({ id: c.id, name: c.name, files: c.files, est_lines: c.est_lines, symbol_count: c.symbol_count }));
  if (comms.length === 0) {
    return { feature: input.feature, features: [], file_count: 0, unassigned_count: 0, message: '无有效功能社区' };
  }

  // 3. 归并成功能：LLM 优先，规则兜底
  let named: Array<{ name: string; community_ids: number[] }> | null = null;
  let usedLlm = false;
  if (input.gen_names) {
    named = await groupFeaturesByLLM(comms);
    usedLlm = named !== null;
  }
  let nodes: FeatureNode[] = [];
  if (named) {
    const byId = new Map(comms.map((c) => [c.id, c]));
    nodes = named.map((f) => ({
      id: '',
      name: f.name,
      communities: f.community_ids
        .map((id) => byId.get(id)!)
        .sort((a, b) => b.est_lines - a.est_lines),
    }));
  } else {
    nodes = groupByDir(comms);
  }

  // 4. 稳定功能 id（f0, f1, …），供 file_map 引用
  const fileCount = new Map<number, number>();
  for (const n of nodes) {
    let fc = 0;
    const s = new Set<string>();
    for (const c of n.communities) for (const f of c.files) s.add(f);
    fc = s.size;
    fileCount.set(n.communities[0]?.id ?? -1, fc);
  }
  // 社区 → 功能 id
  const commFeatureId = new Map<number, string>();
  nodes.forEach((n, i) => {
    n.id = `f${i}`;
    for (const c of n.communities) commFeatureId.set(c.id, n.id);
  });

  // 组装带 file_count + FeatureCommunity 的 features
  const features: Array<FeatureNode & { file_count: number }> = nodes.map((n) => ({
    id: n.id,
    name: n.name,
    communities: n.communities.map((c) => ({
      id: c.id,
      name: c.name,
      files: c.files,
      est_lines: c.est_lines,
      symbol_count: c.symbol_count,
    })),
    file_count: fileCount.get(n.communities[0]?.id ?? -1) ?? 0,
  }));
  features.sort((a, b) => b.file_count - a.file_count);

  // 5. file_map：文件 → 主导社区 → 功能
  const fileMap: Record<string, { feature_id: string; community_id: number }> = {};
  const dsl = input.feature ? getDSL(input.feature) : null;
  const semanticFiles = dsl?.semantic?.files ?? [];
  for (const sf of semanticFiles) {
    const cid = fileToCommunity.get(sf.path);
    if (cid === undefined) continue;
    const fid = commFeatureId.get(cid);
    if (!fid) continue;
    fileMap[sf.id] = { feature_id: fid, community_id: cid };
  }

  // 6. 落盘
  if (input.feature && dsl) {
    dsl.feature_tree = { features, file_map: fileMap };
    saveDSL(dsl, 'feature_tree');
  }

  const total = semanticFiles.length;
  return {
    feature: input.feature,
    features,
    file_count: Object.keys(fileMap).length,
    unassigned_count: Math.max(0, total - Object.keys(fileMap).length),
    message:
      `功能树生成：${features.length} 个功能 · ${mono.community_count} 个社区 · ` +
      `${Object.keys(fileMap).length}/${total} 个文件完成归属` +
      (usedLlm ? '（LLM 归并命名）' : '（规则目录归并）'),
  };
}