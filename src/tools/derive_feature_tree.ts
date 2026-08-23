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
import { getDSLByView, saveDSL } from '../storage.js';
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
    .map((c) => `- ${c.id}: 锚点[${c.name}] · ${c.files.slice(0, 2).join(',')} 等${c.files.length}文件`)
    .join('\n');
  const prompt =
    `下面是一个软件项目的 ${comms.length} 个"功能社区"（每个社区 = 一个按调用边聚到一起的功能锚点及成员文件）。` +
    `一个社区内部高度内聚，不应再拆开；但多个社区可能属于同一个更大的**业务功能**。` +
    `请把这些社区归并成 **3-8 个"功能"**，每个功能给一个简短的**中文名**（4-8 字，如"渲染引擎""配置加载""命令分发"）。` +
    `要求：\n` +
    `1) 每个社区必须且只能归入一个功能；\n` +
    `2) 归并依据是业务语义（锚点/文件体现的职责），不是目录名；\n` +
    `3) 社区特别大时可单独成功能，不要强行塞进无关功能。\n` +
    `只输出紧凑 JSON（无空格无解释）：{"features":[{"name":"渲染引擎","community_ids":[1,5,7]}]}\n\n${list}`;
  try {
    const text = await callChat(cfg, [{ role: 'user', content: prompt }], 0.2, 120_000);
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

/**
 * LLM 仅重命名（降级路径）：全量语义归并失败/超时时的保底人话化。
 * 分组沿用目录归并（快而稳），只让 LLM 给每组起中文名——输出极小（N 个名字），
 * 秒级返回。返回与 groups 等长的名字数组，或 null（失败保持原名）。
 */
async function renameGroupsByLLM(groups: FeatureNode[]): Promise<string[] | null> {
  if (groups.length === 0) return null;
  const cfg = loadLlmConfig() ?? toLlmCfg(loadExplainConfig());
  if (!cfg) return null;
  const list = groups
    .map((g, i) => {
      const anchors = g.communities.slice(0, 5).map((c) => c.name).join('、');
      const files = [...new Set(g.communities.flatMap((c) => c.files))].slice(0, 4).join(', ');
      return `- ${i}: 现名[${g.name}] · 社区锚点：${anchors} · 文件如：${files}`;
    })
    .join('\n');
  const prompt =
    `下面是一个软件项目按目录粗分的功能组。请给每组起一个简短的**中文名**（4-8 字，体现业务用途，` +
    `如"渲染引擎""配置加载"），不要用目录名/英文原名。\n` +
    `只输出紧凑 JSON：{"names":["名字0","名字1",...]}，顺序与组号一致，共 ${groups.length} 个。\n\n${list}`;
  try {
    const text = await callChat(cfg, [{ role: 'user', content: prompt }], 0.2, 45_000);
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as { names?: unknown };
    if (!Array.isArray(parsed.names) || parsed.names.length !== groups.length) return null;
    const out = parsed.names.map((n) => String(n).trim());
    if (out.some((n) => !n || n.length > 12)) return null;
    return out;
  } catch {
    return null;
  }
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
  let renameOnly = false; // 语义归并失败，仅做了目录分组 + LLM 重命名
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
    // 降级人话化：语义归并失败时至少把目录名换成中文名（小输出，秒级）
    if (input.gen_names) {
      const names = await renameGroupsByLLM(nodes);
      if (names) {
        nodes.forEach((n, i) => {
          if (names[i]) n.name = names[i];
        });
        usedLlm = true;
        renameOnly = true;
      }
    }
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
  // 路径形态可能不一致：cache.db 的路径相对其项目根（如本仓库 camera/internal/...），
  // DSL 的路径相对导入快照根（顶层目录已剥，如 internal/...）。
  // 用后缀索引兜底（≥2 段，避免单文件名误命中）。
  const suffixToCommunity = new Map<string, number>();
  for (const [p, cid] of fileToCommunity) {
    const segs = p.split('/');
    for (let k = 0; k < segs.length - 1; k++) {
      const key = segs.slice(k).join('/');
      if (!suffixToCommunity.has(key)) suffixToCommunity.set(key, cid); // 长后缀优先
    }
  }
  function communityOf(relPath: string): number | undefined {
    const segs = relPath.split('/');
    for (let k = 0; k < segs.length - 1; k++) {
      const hit = suffixToCommunity.get(segs.slice(k).join('/'));
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  const fileMap: Record<string, { feature_id: string; community_id: number }> = {};
  // 功能树是"实际代码结构"的产物，语义基准必须对齐 cache.db 索引的代码快照（live 视图）。
  // 不能用设计视图（design）：设计视图是人工/历史拼装态，可能混入跨项目残留文件
  //（曾因 cwd 漂移把 go-camera、camera-conformance 等并进来），命中率闸门会误判"不相关"而拒生成。
  const liveDsl = input.feature ? getDSLByView(input.feature, 'live') : null;
  const semanticFiles = liveDsl?.semantic?.files ?? [];
  for (const sf of semanticFiles) {
    const cid = fileToCommunity.get(sf.path) ?? communityOf(sf.path);
    if (cid === undefined) continue;
    const fid = commFeatureId.get(cid);
    if (!fid) continue;
    fileMap[sf.id] = { feature_id: fid, community_id: cid };
  }

  // 5.5 范围过滤 + 命中率闸门：cache.db 覆盖整个 project_dir，而 feature 可能只是
  // 其中一个子目录，甚至属于完全无关的代码库（早期无 source_root 的数据）。
  // 闸门判据用 **db 侧命中率**：db 索引文件中属于该 feature 的比例 < 50% 视为
  // 不相关（db 必须是 feature 范围内的子集索引才合法）。注意 db 可只索引 feature
  // 的一部分（如跳过 scripts），DSL 侧命中率会偏低，故不用 DSL 侧做判据。
  const semExact = new Set(semanticFiles.map((f) => f.path));
  const semSuffix = new Set<string>();
  for (const f of semanticFiles) {
    const segs = f.path.split('/');
    for (let k = 0; k < segs.length - 1; k++) semSuffix.add(segs.slice(k).join('/'));
  }
  function inFeature(p: string): boolean {
    if (semExact.has(p)) return true;
    const segs = p.split('/');
    for (let k = 0; k < segs.length - 1; k++) if (semSuffix.has(segs.slice(k).join('/'))) return true;
    return false;
  }
  const dbTotal = mono.file_view.length;
  const dbHit = mono.file_view.filter((fv) => inFeature(fv.path)).length;
  if (dbTotal > 0 && dbHit < dbTotal * 0.5) {
    return {
      feature: input.feature,
      features: [],
      file_count: Object.keys(fileMap).length,
      unassigned_count: semanticFiles.length,
      message: `cache.db 与该 feature 不相关（db 文件 ${dbHit}/${dbTotal} 属于此项目），已拒绝生成功能树`,
    };
  }
  // 规则：功能下任一社区的文件都没进 file_map → 该功能整体剔除。
  const mappedFids = new Set(Object.values(fileMap).map((m) => m.feature_id));
  let scoped = features;
  if (semanticFiles.length > 0 && mappedFids.size > 0) {
    scoped = features.filter((f) => mappedFids.has(f.id));
  }

  // 6. 落盘（写回 live 快照；saveDSL 同时同步设计视图文件，使结构图与功能树对齐）
  if (input.feature && liveDsl) {
    liveDsl.feature_tree = { features: scoped, file_map: fileMap, source: usedLlm ? 'llm' : 'rule' };
    saveDSL(liveDsl, 'feature_tree');
  }

  const total = semanticFiles.length;
  return {
    feature: input.feature,
    features: scoped,
    file_count: Object.keys(fileMap).length,
    unassigned_count: Math.max(0, total - Object.keys(fileMap).length),
    message:
      `功能树生成：${features.length} 个功能 · ${mono.community_count} 个社区 · ` +
      `${Object.keys(fileMap).length}/${total} 个文件完成归属` +
      (renameOnly ? '（LLM 重命名目录分组）' : usedLlm ? '（LLM 归并命名）' : '（规则目录归并）'),
  };
}