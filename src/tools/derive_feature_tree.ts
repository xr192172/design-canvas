/**
 * derive_feature_tree —— 功能树生成（项目 → 功能 → 社区 → 文件）
 *
 * 把"一滩平铺的文件星图"变成逐级下钻的层级导航数据：
 *   项目（feature 根）→ 几大功能 → 社区（analyze_monolith 功能社区）→ 文件
 *
 * 数据来源：
 *   - analyze_monolith：基于 cache.db 调用边做跨文件 Louvain 功能社区圈定，
 *     产出 communities（功能社区，锚点名 + 横跨文件）与 file_view（文件内社区分布）。
 *   - 本工具把社区**二次归并**成"几大功能"，并建立
 *     文件 → 主导社区 → 功能 的归属映射（file_map）。
 *
 * 归并策略（目录优先，结构保真——功能树必须对得上实际项目、符合人类阅读习惯）：
 *   - 社区按"成员文件主导目录"聚成功能（dsl/db/daemon/renderer/camera… 各成功能，
 *     tools 大桶再按能力域拆成 8 类，杜绝"工具"一口大锅）；
 *   - 零社区的目录（纯定义/配置/入口文件，如 dsl 类型、db 存储、daemon 守护、tools 脚本）
 *     按目录直挂补成功能，不凭空消失；
 *   - gen_names=true（配置了 LLM）时 LLM 只做**命名润色**（目录分组 → 中文功能名），
 *     不重新归并——避免 LLM 按猜的业务语义把目录打散/吞并，导致对不上实际项目。
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
  /** 是否用 LLM 润色功能名（默认 false；未配置 LLM 时静默降级为规则中文名） */
  gen_names?: boolean;
}

export interface FeatureTreeResult {
  feature?: string;
  /** 功能层 */
  features: Array<FeatureNode & { file_count: number }>;
  /** 参与归属的文件总数 */
  file_count: number;
  /** 未归入任何功能的孤立文件数（通常无调用边也无目录归属，如纯配置） */
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

/**
 * 顶层目录 → 中文功能名（规则归并时功能名符合人类阅读习惯，而非裸目录名）。
 * 未列出的目录保持原名（如 go-camera、go-slim 等外部子项目）。
 */
const DIR_FEATURE_NAMES: Record<string, string> = {
  dsl: 'DSL 协议定义',
  db: '数据存储',
  daemon: '守护进程',
  renderer: '渲染引擎',
  camera: '观测探针',
  diagnosis: '诊断分析',
  go_camera: 'Go 探针引擎',
  go_slim: '轻量探针',
  scripts: '构建脚本',
  schema: 'Schema 定义',
  tests: '测试套件',
};

/**
 * tools/ 能力域（对齐 classify_tools 8 域）：tools 大桶按文件名关键词打分归入能力域。
 * 命中不了默认归 'query'（查询理解）——诚实兜底，多数读/查类工具落这里。
 */
const TOOL_DOMAINS: Array<{ id: string; label: string; kws: string[] }> = [
  { id: 'design', label: '设计编辑', kws: ['scaffold', 'render_dsl', 'render_sandbox', 'render_workbench', 'render_cluster', 'workbench', 'wizard', 'overlay', 'animation', 'anim', 'shape', 'edge_', 'layout', 'simulation'] },
  { id: 'query', label: '查询理解', kws: ['query', 'search', 'diff', 'explore', 'get_', 'list', 'dict', 'snapshot', 'language_concepts', 'arch_layer', 'layer_detect', 'feature_map', 'dag_layout', 'role_title'] },
  { id: 'refactor', label: '重构治理', kws: ['rename', 'assemble', 'slim', 'refactor', 'split', 'dead', 'contract', 'effects', 'pipeline', 'extract', 'remov', 'repair', 'migration', 'brick', 'verify_refactor', 'ts_slim', 'similar'] },
  { id: 'observe', label: '观测质检', kws: ['camera', 'probe', 'judge', 'instrument', 'narrate', 'trace', 'monitor', 'watch', 'log', 'diagnos', 'verify', 'consistency', 'chain', 'dogfood', 'freshness', 'signal', 'recon'] },
  { id: 'judge', label: '治理裁决', kws: ['approval', 'submit_gate', 'review', 'gate'] },
  { id: 'edit', label: '代码编辑', kws: ['edit_code', 'file_ops', 'api_ops', 'node_ops', 'batch_ops', 'edge_ops', 'apply', 'patch'] },
  { id: 'harvest', label: '逆向采集', kws: ['harvest', 'import_', 'url', 'closure', 'collect_functions', 'cli_extract', 'registry_extract'] },
  { id: 'export', label: '交付导出', kws: ['export', 'render_mindmap', 'render_anatomy', 'render_tools_map', 'render_wizard', 'registry', 'report', 'tour'] },
];

/** tools/ 下文件 → 能力域 id（按文件名关键词打分取多数） */
function toolDomainOf(relPath: string): string {
  const base = (relPath.split('/').pop() ?? '').toLowerCase();
  let best = 'query';
  let bestHits = 0;
  for (const d of TOOL_DOMAINS) {
    let hits = 0;
    for (const k of d.kws) if (base.includes(k)) hits++;
    if (hits > bestHits) { bestHits = hits; best = d.id; }
  }
  return best;
}

/**
 * 全局基础设施文件：真身是数据层/协议层/服务层（dsl/db/daemon/根级 storage/server），
 * 不应随调用边被吸进业务社区——文件归属按目录直挂，不跟社区走。
 */
function isInfraPath(relPath: string): boolean {
  const seg = relPath.split('/');
  if (seg.length === 1) {
    return /^(storage|server|server_registry|storage_overlay)\./.test(seg[0]);
  }
  return seg[0] === 'dsl' || seg[0] === 'db' || seg[0] === 'daemon';
}

/** 社区 → 规则归并主键：tools 桶按能力域，根级归"基础服务"，其余按首段目录 */
function communityKeyOf(c: { files: string[] }): string {
  if (c.files.length === 0) return 'root-svc';
  const counts = new Map<string, number>();
  for (const f of c.files) {
    const seg = f.split('/');
    const key = seg.length > 1 ? (seg[0] === 'tools' ? `tools:${toolDomainOf(f)}` : seg[0]) : 'root-svc';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = 'root-svc';
  let bestN = 0;
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
  return best;
}

/** 单个文件 → 规则归并主键（目录/能力域维度）：tools → tools:<domain>，根级 → root-svc，其余按首段目录 */
function fileKeyOf(relPath: string): string {
  const seg = relPath.split('/');
  if (seg.length === 1) return 'root-svc';
  return seg[0] === 'tools' ? `tools:${toolDomainOf(relPath)}` : seg[0];
}

/** 规则归并主键 → 功能展示名 */
function ruleLabelOf(key: string): string {
  if (key.startsWith('tools:')) {
    const d = TOOL_DOMAINS.find((x) => x.id === key.slice('tools:'.length));
    return d ? d.label : '工具集';
  }
  if (key === 'root-svc') return '基础服务';
  return DIR_FEATURE_NAMES[key] ?? key;
}

/**
 * 规则兜底归并：社区按"成员文件主导目录"聚成功能（先目录聚）；
 *   - tools/ 大桶按能力域再拆（design/query/refactor/observe/judge/edit/harvest/export）
 *   - 根级文件（storage/server…）聚成"基础服务"，消除"(根)"伪功能
 * 功能名用中文（DIR_FEATURE_NAMES / 能力域 label），符合人类阅读习惯。
 */
function groupByDir(
  comms: Array<{ id: number; name: string; files: string[]; est_lines: number; symbol_count: number }>,
): FeatureNode[] {
  const bucketOf = new Map<number, string>();
  for (const c of comms) bucketOf.set(c.id, communityKeyOf(c));
  const byKey = new Map<string, number[]>();
  for (const [cid, key] of bucketOf) {
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(cid);
  }
  const features: FeatureNode[] = [];
  for (const [key, ids] of byKey) {
    features.push({ id: '', name: ruleLabelOf(key), communities: ids.map((id) => comms.find((c) => c.id === id)!) });
  }
  return features;
}

/**
 * LLM 仅重命名（命名润色路径）：目录归并结构不动，只让 LLM 给每组起中文名——
 * 结构对得上实际项目，名字又符合人类阅读习惯。输出极小（N 个名字），秒级返回。
 * 返回与 groups 等长的名字数组，或 null（失败保持规则中文名）。
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

  // 3. 归并成功能：目录优先（结构保真，对得上实际项目）——社区按"成员文件主导目录"聚成功能，
  //    再按能力域拆 tools 大桶；LLM 只做命名润色（不重新归并，避免把目录打散成猜的业务功能）。
  let nodes: FeatureNode[] = groupByDir(comms);
  let usedLlm = false;
  let renameOnly = false;
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

  // 4. 稳定功能 id（f0, f1, …），供 file_map 引用
  nodes.forEach((n, i) => {
    n.id = `f${i}`;
  });
  // 语义基准：live 视图（功能树是"实际代码结构"的产物，必须对齐 cache.db 索引的代码快照）。
  // 不能用设计视图（design）：设计视图是人工/历史拼装态，可能混入跨项目残留文件
  //（曾因 cwd 漂移把 go-camera、camera-conformance 等并进来），命中率闸门会误判"不相关"而拒生成。
  const liveDsl = input.feature ? getDSLByView(input.feature, 'live') : null;
  const semanticFiles = liveDsl?.semantic?.files ?? [];

  // 4.5 建"目录主键 → 功能"索引 + 补零社区目录功能（B）：
  //     数据/协议/服务/工具等目录的纯定义/配置/入口文件（dsl/db/daemon/tools/camera 等）没有调用边，
  //     进不了社区；按目录直挂补成功能，保证 L2 层体现真实目录，而不是凭空消失。
  const keyToFeature = new Map<string, string>();
  const coveredKeys = new Set<string>();
  for (const n of nodes) {
    if (n.communities.length === 0) continue;
    const k = communityKeyOf(n.communities[0]);
    if (!keyToFeature.has(k)) {
      keyToFeature.set(k, n.id);
      coveredKeys.add(k);
    }
  }
  const dirFileCount = new Map<string, number>();
  for (const sf of semanticFiles) {
    const k = fileKeyOf(sf.path);
    dirFileCount.set(k, (dirFileCount.get(k) ?? 0) + 1);
  }
  for (const [k, n] of dirFileCount) {
    if (coveredKeys.has(k) || n === 0) continue;
    const id = `f${nodes.length}`;
    keyToFeature.set(k, id);
    nodes.push({ id, name: ruleLabelOf(k), communities: [] });
    coveredKeys.add(k);
  }
  // 社区 → 功能 id
  const commFeatureId = new Map<number, string>();
  nodes.forEach((n) => {
    for (const c of n.communities) commFeatureId.set(c.id, n.id);
  });

  // 组装 features（file_count 按 file_map 归属实算，见下方）
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
    file_count: 0,
  }));

  // 5. file_map：文件 → 功能（社区优先保原子性，孤儿文件目录直挂补全）
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
  // 归属原则（E）：
  //   - 有社区的成员文件 → 按社区归属（社区是原子单元，不拆开；社区所在功能由"主导目录"决定，
  //     故结构上仍对得上目录）；
  //   - 孤儿文件（无社区 / 社区被范围过滤）→ 按 fileKeyOf 目录直挂到对应功能
  //     （infra 直挂、tools 按能力域），文件不凭空消失、不跨目录乱跑。
  for (const sf of semanticFiles) {
    const cid = fileToCommunity.get(sf.path) ?? communityOf(sf.path);
    const fid = cid !== undefined ? commFeatureId.get(cid) : undefined;
    if (fid) {
      fileMap[sf.id] = { feature_id: fid, community_id: cid! };
      continue;
    }
    const dirFid = keyToFeature.get(fileKeyOf(sf.path));
    if (dirFid) {
      fileMap[sf.id] = { feature_id: dirFid, community_id: cid ?? -1 };
    }
  }
  // file_count：按 file_map 实算（社区成员 + 目录直挂都算上）
  const perFeatureFiles = new Map<string, number>();
  for (const m of Object.values(fileMap)) {
    perFeatureFiles.set(m.feature_id, (perFeatureFiles.get(m.feature_id) ?? 0) + 1);
  }
  for (const f of features) f.file_count = perFeatureFiles.get(f.id) ?? 0;
  features.sort((a, b) => b.file_count - a.file_count);

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
