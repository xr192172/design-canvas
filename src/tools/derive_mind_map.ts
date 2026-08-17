/**
 * derive_mind_map —— L3 思维导图层生成
 *
 * 把 L2 设计图层（feature_tree 功能树 + semantic 语义文件）提炼成
 * 普通人能看懂的逐级思维导图（root → 功能 → 社区 → 文件）。
 *
 * 数据来源：
 *   - dsl.feature_tree：项目 → 功能 → 社区（analyze_monolith 聚类）→ 文件
 *   - dsl.semantic.files：文件职责描述（responsibility）+ 行数 + 状态
 *   - dsl.layers：架构分层（作为功能描述补充）
 *
 * 提炼策略：
 *   - 骨架：无 LLM 也能生成（规则骨架，恒可用），供可观测产物兜底。
 *   - LLM 提炼（gen_descriptions=true）：用内置 LLM 为每个功能/社区生成
 *     "人话"描述（这是什么、解决什么问题），让思维导图对普通人也友好。
 *
 * 锚点：文件节点 id 与 L2 共享（file_xxx），保证思维导图 → 设计图 → 代码可追溯。
 *
 * 产出：
 *   - L3 思维导图 JSON（<dataHome>/.design-canvas/mindmap/<feature>.json）
 *   - 自包含 HTML 查看器（output/mind_map_<feature>.html），浏览器直接打开
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDSL, getStorageRoot, getDataHome } from '../storage.js';
import { extractJsonObject } from './explain_gen.js';
import { loadAgentConfig } from './llm_focus.js';
import { openDb } from '../db/db.js';
import type { Database } from '../db/db.js';
import type { DesignDSL, FeatureTree } from '../dsl/types.js';
import type { MindMap, MindMapNode, TeachStep } from '../dsl/mindmap.js';

export interface DeriveMindMapInput {
  /** feature 名（必填） */
  feature: string;
  /** 是否用 LLM 提炼描述（默认 false；未配置 LLM 时静默降级为规则骨架） */
  gen_descriptions?: boolean;
  /** 单个社区最多展开的文件节点数（默认 20，防止导图过大） */
  max_files_per_community?: number;
  /** 产物输出路径（可选，默认 output/mind_map_<feature>.html） */
  output_path?: string;
  /** 视图形态（默认 structure）：
   *  structure = 结构树（功能→社区→文件，开发者下钻用）
   *  teach     = 科普教学（功能 + 实现原理分镜 steps，像科普视频讲解，小白用） */
  view?: 'structure' | 'teach';
}

export interface DeriveMindMapResult {
  feature: string;
  mode: 'llm' | 'rule';
  /** 思维导图 JSON */
  mind_map: MindMap;
  /** JSON 落盘路径 */
  jsonFile: string;
  /** HTML 查看器路径 */
  htmlFile: string;
  message: string;
}

/** 思维导图 JSON 落盘路径：<storageRoot>/mindmap/<feature>.json（teach 版加 .teach 后缀） */
export function getMindMapFile(feature: string, view: 'structure' | 'teach' = 'structure'): string {
  const suffix = view === 'teach' ? '.teach' : '';
  return path.join(getStorageRoot(), 'mindmap', `${feature}${suffix}.json`);
}

/** 默认 HTML 输出路径：<dataHome>/output/mind_map_<feature>.html */
function defaultHtmlPath(feature: string): string {
  return path.join(getDataHome(), 'output', `mind_map_${feature}.html`);
}

/** 取文件名（去掉路径），用于文件节点标题 */
function basename(p: string): string {
  const seg = p.split(/[\\/]/);
  return seg[seg.length - 1] || p;
}

interface FileInfo {
  id: string;
  path: string;
  responsibility: string;
  lines?: number;
  status?: string;
  layer?: string;
  /** 关键函数签名（actual_apis 优先，teach 模式喂给 LLM 的实现材料） */
  apis?: string[];
}

/** 从语义层构建 文件路径 → FileInfo 索引，并保留 id（= geometry node id）。
 *  另建后缀索引（≥2 段）：功能树社区的 files 相对 cache.db 项目根，
 *  DSL 路径相对导入快照根，前缀可能不一致（如 camera/internal/… vs internal/…）。 */
function buildFileIndex(dsl: DesignDSL): { exact: Map<string, FileInfo>; bySuffix: Map<string, FileInfo> } {
  const exact = new Map<string, FileInfo>();
  const bySuffix = new Map<string, FileInfo>();
  for (const f of dsl.semantic?.files ?? []) {
    if (!f.path) continue;
    const info: FileInfo = {
      id: f.id,
      path: f.path,
      responsibility: f.responsibility || '',
      lines: f.lines,
      status: f.status,
      layer: f.layer,
      apis: (f.actual_apis ?? f.expected_apis ?? []).slice(0, 4).map((a) => a.signature),
    };
    exact.set(f.path, info);
    const segs = f.path.split('/');
    for (let k = 0; k < segs.length - 1; k++) {
      const key = segs.slice(k).join('/');
      if (!bySuffix.has(key)) bySuffix.set(key, info); // 长后缀优先
    }
  }
  return { exact, bySuffix };
}

/** 精确 → 后缀（至少保留 2 段）查文件信息 */
function lookupFile(idx: { exact: Map<string, FileInfo>; bySuffix: Map<string, FileInfo> }, rel: string): FileInfo | undefined {
  const hit = idx.exact.get(rel);
  if (hit) return hit;
  const segs = rel.split('/');
  for (let k = 0; k < segs.length - 1; k++) {
    const s = idx.bySuffix.get(segs.slice(k).join('/'));
    if (s) return s;
  }
  return undefined;
}

/** 规则描述：功能节点 */
function ruleFeatureDesc(f: { name: string; communities: unknown[] }, fileCount: number): string {
  return `由 ${f.communities.length} 个子模块组成，共 ${fileCount} 个文件`;
}

/** 规则描述：社区节点 */
function ruleCommunityDesc(c: { files: string[]; est_lines?: number; symbol_count?: number }): string {
  const parts = [`包含 ${c.files.length} 个文件`];
  if (c.est_lines) parts.push(`约 ${c.est_lines} 行`);
  if (c.symbol_count) parts.push(`${c.symbol_count} 个符号`);
  return parts.join(' · ');
}

/** 规则描述：文件节点 */
function ruleFileDesc(f: FileInfo): string {
  if (f.responsibility) return f.responsibility;
  const parts: string[] = [];
  if (f.lines) parts.push(`${f.lines} 行`);
  if (f.status) parts.push(`状态:${f.status}`);
  return parts.join(' · ') || '（无描述）';
}

/**
 * 用 LLM 为一批功能/社区节点批量生成人话描述。
 * 分批并行（每批 12 个条目，批间 Promise.all），单批 60s 超时——
 * 一次性喂几十个条目会让慢端点生成超长输出甚至悬挂（实测 5 分钟）。
 * 返回 { 节点id → 描述 }（合并各批成功部分）；全部失败返回 null（调用方降级规则）。
 */
async function llmEnrichDescriptions(
  nodes: Array<{ id: string; label: string; kind: string; hint: string }>,
  projectTitle: string,
): Promise<Map<string, string> | null> {
  const cfg = loadAgentConfig();
  if (!cfg) return null;
  const BATCH = 12;
  const chunks: Array<typeof nodes> = [];
  for (let i = 0; i < nodes.length; i += BATCH) chunks.push(nodes.slice(i, i + BATCH));
  const system =
    '你是软件项目的"人话翻译官"。用户要把一个项目的结构做成给普通人看的思维导图。' +
    '给定项目里的功能/子模块清单，请为每个条目写一句**通俗易懂的介绍**（2-3 句以内），' +
    '讲清"这是什么、大概干嘛用"，避免只重复技术名词。基于给定事实，不要编造。' +
    '只输出 JSON：{"descriptions":{"<id>":"<人话描述>", ...}}，id 必须来自给定清单。';
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const list = chunk
        .map((n) => `- id=${n.id} · ${n.kind === 'feature' ? '功能' : '子模块'}「${n.label}」· ${n.hint}`)
        .join('\n');
      try {
        const res = await fetch(`${cfg.baseURL}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({
            model: cfg.model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: `项目：${projectTitle}\n条目清单：\n${list}` },
            ],
            temperature: 0.4,
            response_format: { type: 'json_object' },
          }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const content = data.choices?.[0]?.message?.content ?? '';
        const parsed = extractJsonObject(content);
        const raw = parsed?.descriptions as Record<string, unknown> | undefined;
        if (!raw || typeof raw !== 'object') return null;
        const out = new Map<string, string>();
        for (const [id, v] of Object.entries(raw)) {
          const s = typeof v === 'string' ? v.trim() : '';
          if (s) out.set(id, s);
        }
        return out.size > 0 ? out : null;
      } catch {
        return null; // 单批失败不拖垮其余批次
      }
    }),
  );
  const merged = new Map<string, string>();
  for (const r of results) if (r) for (const [k, v] of r) merged.set(k, v);
  return merged.size > 0 ? merged : null;
}

/** 递归统计子树文件数 */
function countFiles(n: MindMapNode): number {
  if (!n.children || n.children.length === 0) return n.kind === 'file' ? 1 : 0;
  return n.children.reduce((s, c) => s + countFiles(c), 0);
}

// ─────────────────────────────────────────────────────────────
// teach 模式：科普教学导图（功能 + 实现原理分镜）
// 叙事框架参考科普视频：项目是什么 → 有哪些功能 → 每个功能怎么实现的（分镜）
// 材料三层：文件职责（静态）+ 函数签名（静态）+ 真实调用链（cache.db 动态证据）
// ─────────────────────────────────────────────────────────────

/** 给 LLM 的科普分镜产出 */
interface TeachScript {
  what: string;
  steps: TeachStep[];
}

/** 定位 feature 对应的 cache.db（与 overview/feature_tree 同一套候选逻辑） */
function findCacheDb(feature: string, dsl: DesignDSL): string | null {
  const candidates = [
    path.join(getStorageRoot(), `import_cache_${feature}.db`),
    dsl.source_root ? path.join(dsl.source_root, '.design-canvas', 'cache.db') : '',
    path.join(process.cwd(), '.design-canvas', 'cache.db'),
  ].filter(Boolean) as string[];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** 后缀匹配（≥2 段）判断 cache.db 路径是否属于功能文件集合（两套相对根可能前缀不同） */
function makeFileMatcher(featureRels: string[]): (p: string) => boolean {
  const exact = new Set(featureRels);
  const suffixes = new Set<string>();
  for (const f of featureRels) {
    const segs = f.split('/');
    for (let k = 0; k < segs.length - 1; k++) suffixes.add(segs.slice(k).join('/'));
  }
  return (p: string) => {
    if (exact.has(p)) return true;
    const segs = p.split('/');
    for (let k = 0; k < segs.length - 1; k++) if (suffixes.has(segs.slice(k).join('/'))) return true;
    return false;
  };
}

/**
 * 从 cache.db 取该功能的真实跨文件调用边（科普分镜的执行顺序证据）。
 * 按调用频次取 top N，一屏可读；文件粒度去重（同一对文件最多 2 条，防 hub 函数刷屏）。
 * 返回人读格式："a.ts:fnA → b.ts:fnB ×12"；db 不可用返回 []。
 */
function loadCallEdges(db: Database, featureRels: string[], maxEdges = 40): string[] {
  const match = makeFileMatcher(featureRels);
  const rows = db
    .prepare(
      `SELECT n1.file_path AS sf, n1.name AS sn, n2.file_path AS tf, n2.name AS tn, COUNT(*) AS w
       FROM edges e
       JOIN nodes n1 ON n1.id = e.source
       JOIN nodes n2 ON n2.id = e.target
       WHERE e.kind = 'call' AND n1.file_path != n2.file_path
       GROUP BY n1.file_path, n1.name, n2.file_path, n2.name
       ORDER BY w DESC`,
    )
    .all() as Array<{ sf: string; sn: string; tf: string; tn: string; w: number }>;
  const perPair = new Map<string, number>();
  const out: string[] = [];
  for (const r of rows) {
    if (!match(r.sf) || !match(r.tf)) continue;
    const pairKey = [r.sf, r.tf].sort().join('⇔');
    const cnt = perPair.get(pairKey) ?? 0;
    if (cnt >= 2) continue;
    perPair.set(pairKey, cnt + 1);
    out.push(`${r.sf}:${r.sn} → ${r.tf}:${r.tn}（×${r.w}）`);
    if (out.length >= maxEdges) break;
  }
  return out;
}

/** detail 中的技术噪声检测：函数调用/路径/驼峰/snake_case 标识（验收"零函数名"规矩；放行普通英文单词） */
const TECH_NOISE_RE =
  /[\w./-]+\(\s*\)|[\w-]+\.(ts|tsx|js|mjs|go|py|rs|java)\b|\b[a-z]+[A-Z][a-zA-Z]*\b|\b[a-z]+(_[a-z0-9]+)+\b/;

/** 限并发 map：每批最多 limit 个任务并发（避免全量并行打爆 LLM API 限流） */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 科普编剧 v2（teach 核心）。材料三区：职责清单 / 调用记录 / 函数签名。
 * 硬规矩：what 必须痛点开场（不说"XX功能用于"）；detail 零技术标识，
 * 锚点只进 involves；steps 顺序以调用记录为证据。
 * 返回 null 表示失败/未配置（调用方降级）。
 */
async function llmTeachFeature(material: string, featureName = ''): Promise<TeachScript | null> {
  const cfg = loadAgentConfig();
  if (!cfg) return null;
  const system =
    '你是技术科普编剧，擅长把软件功能讲成普通人爱看的科普视频（类似"3分钟看懂搜索引擎原理"）。\n' +
    '给定一个功能的材料：【职责】每个文件是干嘛的；【调用记录】真实代码里谁调用谁、调用多少次（这是真实执行顺序的证据，材料区允许出现函数名供你理解，但你的输出不许照搬）；【主人批注】项目主人在导图上写的理解/纠正（如有，优先级最高，人的说法与材料冲突时以人为准）。\n\n' +
    '请为这个功能写科普分镜：\n' +
    '1. what：从**痛点/场景**开场（"如果没它会怎样"或"它像生活中的什么"），1-2 句。禁止用"本功能用于/是一个…的功能"这类说明书腔。可以打生活类比（如"给程序装行车记录仪"）。\n' +
    '2. steps：实现原理分镜 3-6 步，像视频镜头按**真实执行/数据流顺序**推进——顺序必须以【调用记录】为证据，不能凭目录名猜。每步：\n' +
    '   - title：≤12 字动宾短语（如「埋下探针」「比对流水账」）；\n' +
    '   - detail：1-2 句纯人话，讲清这步发生什么、数据从哪来到哪去。**严禁**出现函数名、文件名、路径、英文驼峰词——技术细节只许放进 involves；\n' +
    '   - involves：这步依据的关键文件（只能从【职责】清单的文件里选，给想深挖的工程师看）。\n' +
    '只基于给定材料，不得编造。只输出 JSON（无其他文字）：\n' +
    '{"what":"...","steps":[{"title":"...","detail":"...","involves":["a.ts"]}]}';
  const callOnce = async (
    userContent: string,
  ): Promise<{ ok: boolean; status: number; content: string; finishReason: string; retryable: boolean; err?: string }> => {
    try {
      const res = await fetch(`${cfg.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userContent },
          ],
          temperature: 0.4,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(150_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, content: body.slice(0, 300), finishReason: '', retryable: res.status === 429 || res.status >= 500, err: `HTTP ${res.status}` };
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      };
      const choice = data.choices?.[0];
      return { ok: true, status: res.status, content: choice?.message?.content ?? '', finishReason: choice?.finish_reason ?? '', retryable: false };
    } catch (e) {
      const err = e as Error;
      // 超时/网络中断可重试；配置类错误重试也没用
      const retryable = err.name === 'TimeoutError' || err.name === 'AbortError' || err.name === 'TypeError';
      return { ok: false, status: 0, content: '', finishReason: '', retryable, err: `${err.name}: ${err.message}` };
    }
  };

  /** 解析 + 零函数名过滤。返回放行后的 script（可能为 null）与被拦截步骤的违规明细（供重写） */
  const parseAndFilter = (content: string): { script: TeachScript | null; violations: string[] } => {
    const parsed = extractJsonObject(content);
    if (!parsed) return { script: null, violations: [] };
    const what = typeof parsed.what === 'string' ? parsed.what.trim() : '';
    const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
    const steps: TeachStep[] = [];
    const violations: string[] = [];
    for (const s of rawSteps) {
      const step = s as { title?: unknown; detail?: unknown; involves?: unknown };
      const t = typeof step.title === 'string' ? step.title.trim() : '';
      const d = typeof step.detail === 'string' ? step.detail.trim() : '';
      if (!t || !d) continue;
      // 零函数名规矩：detail 带技术噪声的步骤先记违规；重写失败才整步丢弃（宁缺毋滥，不污染科普）
      if (TECH_NOISE_RE.test(d)) {
        violations.push(`「${t}」：${d}`);
        continue;
      }
      const inv = Array.isArray(step.involves)
        ? step.involves.filter((x): x is string => typeof x === 'string' && !!x).slice(0, 5)
        : undefined;
      steps.push({ title: t.slice(0, 24), detail: d.slice(0, 300), involves: inv });
    }
    if (!what || steps.length === 0) return { script: null, violations };
    return { script: { what: what.slice(0, 200), steps: steps.slice(0, 8) }, violations };
  };

  try {
    // 首遍调用：空 content（模型偶发返回空）/超时/限流 → 退避重试，最多 3 次尝试
    type CallResult = Awaited<ReturnType<typeof callOnce>>;
    const needRetry = (x: CallResult): boolean => (!x.ok && x.retryable) || (x.ok && x.content.trim() === '');
    let r = await callOnce(material);
    for (let attempt = 2; attempt <= 3 && needRetry(r); attempt++) {
      console.error(`[teach] 功能「${featureName}」第 ${attempt - 1} 次尝试失败（${r.err || r.content.slice(0, 100) || '空 content'}），${attempt * 2}s 后重试`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
      r = await callOnce(material);
    }
    if (!r.ok) {
      console.error(`[teach] 功能「${featureName}」LLM 调用失败：${r.err ?? ''} ${r.content}`);
      return null;
    }
    let { script, violations } = parseAndFilter(r.content);
    if (!script && r.content.trim() === '') {
      console.error(`[teach] 功能「${featureName}」LLM 返回空 content（finish_reason=${r.finishReason}）`);
    }
    // 违规重写回路：≥2 步带技术标识（或全灭）时，把违规明细发回 LLM 重写一次——
    // LLM 常照搬材料里的 snake_case 模块名，丢弃会导致整个功能无分镜，重写才能两全（零噪声 + 有分镜）
    if (violations.length >= 2 && (script === null || script.steps.length < 3)) {
      console.error(`[teach] 功能「${featureName}」${violations.length} 步含技术标识，触发重写回路`);
      const rewriteUser =
        material +
        '\n\n【重写要求】你上一遍输出的以下步骤 detail 含函数名/文件名/英文驼峰或下划线标识，已全部作废：\n' +
        violations.map((v) => `- ${v}`).join('\n') +
        '\n请重新输出完整 JSON（what + 全部 steps）：违规步骤用纯生活化语言重写（如「总指挥模块」「翻译官」这类角色化说法替代具体标识），未违规的步骤保持原样。involves 字段仍可写真实文件名。';
      const r2 = await callOnce(rewriteUser);
      if (r2.ok) {
        const second = parseAndFilter(r2.content);
        if (second.script && (script === null || second.script.steps.length > script.steps.length)) {
          console.error(`[teach] 功能「${featureName}」重写成功：${second.script.steps.length} 步全部合规`);
          script = second.script;
        }
      }
    }
    if (!script) {
      console.error(`[teach] 功能「${featureName}」无有效分镜（违规 ${violations.length} 步重写后仍不合规）`);
      return null;
    }
    return script;
  } catch (e) {
    console.error(`[teach] 功能「${featureName}」意外异常：`, (e as Error).message);
    return null;
  }
}

/** 组装单个功能的实现材料 v2：职责 + 调用记录（顺序证据）+ 主人批注 */
function buildTeachMaterial(
  projectTitle: string,
  fName: string,
  communities: FeatureTree['features'][number]['communities'],
  fileIndex: ReturnType<typeof buildFileIndex>,
  callEdges: string[],
  ownerNotes: string[],
): string {
  const anchors = communities.slice(0, 8).map((c) => c.name);
  const rels = [...new Set(communities.flatMap((c) => c.files))];
  const MAX = 25;
  const shown = rels.slice(0, MAX);
  const parts: string[] = [
    `项目：${projectTitle}`,
    `功能：${fName}（${rels.length} 个文件${anchors.length ? `，协作模块：${anchors.join('、')}` : ''}）`,
    '【职责】各文件是干嘛的：',
  ];
  for (const rel of shown) {
    const info = lookupFile(fileIndex, rel);
    if (!info) continue;
    const resp = info.responsibility || '（无职责说明）';
    parts.push(`- ${rel}：${resp}`);
  }
  if (rels.length > shown.length) parts.push(`（职责清单截断，共 ${rels.length} 个文件）`);
  if (callEdges.length > 0) {
    parts.push('【调用记录】真实代码里的跨文件调用（按频次排序，是分镜顺序的证据）：');
    parts.push(...callEdges.map((e) => `- ${e}`));
  } else {
    parts.push('【调用记录】无（该功能无跨文件调用数据，分镜顺序依据职责推断并在 detail 中说明）');
  }
  if (ownerNotes.length > 0) {
    parts.push('【主人批注】项目主人在这张导图上写的批注（人的理解和纠正，优先级最高，必须融入 what/steps）：');
    parts.push(...ownerNotes.map((n) => `- ${n}`));
  }
  return parts.join('\n');
}

/**
 * 构建 teach 导图：root → 功能（what + 实现原理分镜 steps）。
 * useLlm=true 时各功能并行调科普编剧；失败/未配置降级规则版（无分镜，仅描述）。
 * teach 只落 JSON（小白入口是项目页圆框图，不需要独立 HTML 查看器）。
 */
async function buildTeachMindMap(
  dsl: DesignDSL,
  feature: string,
  title: string,
  useLlm: boolean,
): Promise<DeriveMindMapResult> {
  const fileIndex = buildFileIndex(dsl);
  const ft = dsl.feature_tree;
  const jsonFile = getMindMapFile(feature, 'teach');

  // 平铺兜底：无功能树（早期数据）——诚实降级，与 structure 一致
  if (!ft || ft.features.length === 0) {
    const root: MindMapNode = {
      id: 'root',
      label: title,
      description: '项目总览（未生成功能树，按文件平铺）',
      kind: 'root',
      children: (dsl.semantic?.files ?? [])
        .filter((f) => f.path)
        .slice(0, 30)
        .map((f) => ({
          id: f.id,
          label: basename(f.path),
          description: f.responsibility || '（无描述）',
          kind: 'file' as const,
        })),
    };
    const mindMap: MindMap = {
      feature,
      mode: 'rule',
      view: 'teach',
      root,
      generated_at: new Date().toISOString(),
      note: '该项目缺少源码快照（早期导入数据），无法生成科普分镜；重新导入可获得完整教学视图',
    };
    fs.mkdirSync(path.dirname(jsonFile), { recursive: true });
    fs.writeFileSync(jsonFile, JSON.stringify(mindMap, null, 2), 'utf-8');
    return { feature, mode: 'rule', mind_map: mindMap, jsonFile, htmlFile: '', message: mindMap.note ?? '' };
  }

  // LLM 科普编剧：各功能并行（材料含真实调用链证据）
  // db 打不开时 edges=[]，材料仍以职责清单为主（LLM 会标注顺序为推断）
  let db: Database | null = null;
  const dbFile = findCacheDb(feature, dsl);
  if (dbFile) {
    try {
      db = openDb(dbFile);
    } catch {
      db = null;
    }
  }
  const featureRels = ft.features.map((f) => [...new Set(f.communities.flatMap((c) => c.files))]);
  const callEdgeLists = featureRels.map((rels) => (db ? loadCallEdges(db, rels) : []));
  db?.close();

  // 主人批注分拣：导图节点 id f{i}（功能）/ f{i}:{j}（步骤），target_id 前缀匹配
  const humanNotes = (dsl.annotations ?? []).filter((a) => a.author === 'human' && !a.resolved && a.text);
  const notesPerFeature = ft.features.map((_, i) => {
    const prefix = `f${i}:`;
    return humanNotes
      .filter((a) => a.target_id === `f${i}` || a.target_id?.startsWith(prefix))
      .map((a) => a.text)
      .slice(0, 10);
  });

  // 限并发调用（3 个一批）：全量 Promise.all 并行易触发 API 限流（429），导致整批"AI 分镜暂不可用"
  const scripts: (TeachScript | null)[] = useLlm
    ? await mapLimit(
        ft.features,
        3,
        (f, i) =>
          llmTeachFeature(
            buildTeachMaterial(title, f.name, f.communities, fileIndex, callEdgeLists[i], notesPerFeature[i]),
            f.name,
          ),
      )
    : ft.features.map(() => null as TeachScript | null);
  const anyLlm = scripts.some((s) => s !== null);

  const root: MindMapNode = {
    id: 'root',
    label: title,
    description: `项目总览：${ft.features.length} 个功能`,
    kind: 'root',
    children: ft.features.map((f, i) => {
      const rels = featureRels[i];
      const script = scripts[i];
      const hasEdges = callEdgeLists[i].length > 0;
      return {
        id: `f${i}`,
        label: f.name,
        kind: 'feature' as const,
        description: script?.what ?? `由 ${f.communities.length} 个子模块协作完成的业务功能`,
        steps: script?.steps ?? [
          {
            title: hasEdges ? 'AI 分镜暂不可用' : '材料不足，暂无法讲解',
            detail: hasEdges
              ? '本次 AI 讲解生成失败（可稍后重试），以下是该功能的静态概览。'
              : '该功能缺少源码调用记录（早期导入的数据），无法生成原理讲解；重新导入项目后可获得完整分析。',
            involves: rels.slice(0, 3),
          },
        ],
        meta: { files: rels.length },
      };
    }),
  };

  const mindMap: MindMap = {
    feature,
    mode: anyLlm ? 'llm' : 'rule',
    view: 'teach',
    root,
    generated_at: new Date().toISOString(),
    note: anyLlm
      ? `已用 LLM（${loadAgentConfig()?.model ?? ''}）生成科普分镜`
      : 'LLM 分镜不可用（未配置或调用失败），已降级规则描述',
  };
  fs.mkdirSync(path.dirname(jsonFile), { recursive: true });
  fs.writeFileSync(jsonFile, JSON.stringify(mindMap, null, 2), 'utf-8');
  return {
    feature,
    mode: mindMap.mode,
    mind_map: mindMap,
    jsonFile,
    htmlFile: '',
    message: `科普教学导图（teach）已生成：${jsonFile}\n说明：${mindMap.note}`,
  };
}

/** 构建思维导图（规则骨架 + 可选 LLM 描述） */
export async function deriveMindMap(input: DeriveMindMapInput): Promise<DeriveMindMapResult> {
  const { feature, gen_descriptions = false, max_files_per_community = 20 } = input;
  const dsl = getDSL(feature);
  if (!dsl) throw new Error(`feature "${feature}" 不存在，请先 render_dsl 或 import_project 创建`);

  const title = dsl.title || feature;

  // teach 模式独立分支：科普教学导图（功能 + 实现原理分镜）
  if ((input.view ?? 'structure') === 'teach') {
    return buildTeachMindMap(dsl, feature, title, gen_descriptions);
  }
  const fileIndex = buildFileIndex(dsl);
  const ft: FeatureTree | undefined = dsl.feature_tree;

  // 记录已尝试 LLM 提炼的节点，供批量生成描述
  const llmTargets: Array<{ id: string; label: string; kind: 'feature' | 'community'; hint: string }> = [];
  let root: MindMapNode;

  if (ft && ft.features.length > 0) {
    // ── 有功能树：root → 功能 → 社区 → 文件 ──
    root = { id: 'root', label: title, description: `项目总览：${ft.features.length} 个功能`, kind: 'root', children: [] };
    for (const f of ft.features) {
      const communityIds = new Set<string>();
      let fFileCount = 0;
      for (const c of f.communities) {
        for (const rel of c.files) {
          if (!communityIds.has(rel)) { communityIds.add(rel); fFileCount++; }
        }
      }
      const fNode: MindMapNode = {
        id: f.id || `feature_${root.children!.length}`,
        label: f.name,
        description: ruleFeatureDesc(f, fFileCount),
        kind: 'feature',
        meta: { files: fFileCount },
        children: [],
      };
      llmTargets.push({ id: fNode.id, label: f.name, kind: 'feature', hint: ruleFeatureDesc(f, fFileCount) });
      for (const c of f.communities) {
        const fileNodes: MindMapNode[] = [];
        const files = c.files.slice(0, max_files_per_community);
        for (const rel of files) {
          const info = lookupFile(fileIndex, rel);
          if (!info) continue;
          fileNodes.push({
            id: info.id,
            label: basename(rel),
            description: ruleFileDesc(info),
            kind: 'file',
            meta: { lines: info.lines, l2_ref: info.id },
          });
        }
        // 超出上限时折叠成"…更多文件"占位
        if (c.files.length > max_files_per_community) {
          fileNodes.push({
            id: `more_${c.id}`,
            label: `… 还有 ${c.files.length - max_files_per_community} 个文件`,
            description: '为保持导图可读，其余文件已折叠',
            kind: 'note',
          });
        }
        const cNode: MindMapNode = {
          id: `community_${c.id}`,
          label: c.name,
          description: ruleCommunityDesc(c),
          kind: 'community',
          meta: { files: c.files.length, lines: c.est_lines, symbols: c.symbol_count },
          children: fileNodes,
        };
        llmTargets.push({ id: cNode.id, label: c.name, kind: 'community', hint: ruleCommunityDesc(c) });
        fNode.children!.push(cNode);
      }
      root.children!.push(fNode);
    }
  } else {
    // ── 无功能树兜底：root → 文件（按语义层平铺） ──
    root = { id: 'root', label: title, description: '项目总览（未生成功能树，按文件平铺）', kind: 'root', children: [] };
    for (const f of dsl.semantic?.files ?? []) {
      if (!f.path) continue;
      root.children!.push({
        id: f.id,
        label: basename(f.path),
        description: f.responsibility || '（无描述）',
        kind: 'file',
        meta: { lines: f.lines, l2_ref: f.id },
      });
    }
  }

  // 汇总文件数（root/feature 层）
  const fillCounts = (n: MindMapNode): void => {
    if (n.children) {
      for (const c of n.children) fillCounts(c);
      if (n.kind === 'root' || n.kind === 'feature') {
        n.meta = { ...(n.meta ?? {}), files: countFiles(n) };
      }
    }
  };
  fillCounts(root);

  // 悬停气泡的纯文本 meta（不含 HTML）
  const bubbleMetaOf = (n: MindMapNode, files: number): string => {
    const parts: string[] = [];
    if (n.kind === 'root' || n.kind === 'feature') parts.push(`${files} 个文件`);
    if (n.kind === 'community') {
      if (n.meta?.files) parts.push(`${n.meta.files} 个文件`);
      if (n.meta?.lines) parts.push(`约 ${n.meta.lines} 行`);
      if (n.meta?.symbols) parts.push(`${n.meta.symbols} 个符号`);
    }
    if (n.kind === 'file') {
      if (n.meta?.lines) parts.push(`${n.meta.lines} 行`);
    }
    return parts.join(' · ');
  };

  // LLM 提炼描述（可选）
  let mode: 'llm' | 'rule' = 'rule';
  let note: string | undefined;
  if (gen_descriptions && llmTargets.length > 0) {
    const enriched = await llmEnrichDescriptions(llmTargets, title);
    if (enriched) {
      mode = 'llm';
      const apply = (n: MindMapNode): void => {
        const d = enriched!.get(n.id);
        if (d) n.description = d;
        if (n.children) for (const c of n.children) apply(c);
      };
      apply(root);
      note = `已用 LLM（${loadAgentConfig()?.model ?? ''}）提炼功能/子模块描述`;
    } else {
      note = 'LLM 提炼不可用（未配置或调用失败），已用规则描述';
    }
  }

  const mindMap: MindMap = {
    feature,
    mode,
    view: 'structure',
    root,
    generated_at: new Date().toISOString(),
    note,
  };

  // 落盘 JSON
  const jsonFile = getMindMapFile(feature);
  fs.mkdirSync(path.dirname(jsonFile), { recursive: true });
  fs.writeFileSync(jsonFile, JSON.stringify(mindMap, null, 2), 'utf-8');

  // 生成自包含 HTML 查看器
  const htmlFile = path.resolve(input.output_path ?? defaultHtmlPath(feature));
  fs.mkdirSync(path.dirname(htmlFile), { recursive: true });
  fs.writeFileSync(htmlFile, renderMindMapHtml(mindMap, title), 'utf-8');

  const fileUrl = `file:///${htmlFile.replace(/\\/g, '/')}`;
  const message = [
    `L3 思维导图已生成（${mode === 'llm' ? 'LLM 提炼' : '规则骨架'}）：${jsonFile}`,
    `HTML 查看器：${htmlFile}`,
    `（浏览器打开 ${fileUrl} 查看）`,
    note ? `说明：${note}` : '',
  ].filter(Boolean).join('\n');

  return { feature, mode, mind_map: mindMap, jsonFile, htmlFile, message };
}

// ─────────────────────────────────────────────────────────────
// 自包含 HTML 查看器
// ─────────────────────────────────────────────────────────────

/** 转义 HTML 特殊字符（防注入/显示安全） */
function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 生成自包含思维导图查看器 HTML */
export function renderMindMapHtml(mindMap: MindMap, title: string): string {
  const json = JSON.stringify(mindMap).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>思维导图 · ${esc(title)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
         background: #0a0f1e; color: #dbe7ff; height: 100vh; overflow: hidden; }
  .head { display: flex; align-items: center; gap: 12px; padding: 10px 18px;
          border-bottom: 1px solid rgba(125,211,252,.15); background: rgba(6,11,31,.9); }
  .head .ftitle { font-size: 15px; font-weight: 700; color: #7dd3fc; }
  .head .fchip { font-size: 11px; padding: 2px 8px; border-radius: 10px;
                 background: rgba(125,211,252,.12); border: 1px solid rgba(125,211,252,.2); color: #7dd3fc; }
  .head .mode { margin-left: auto; font-size: 12px; opacity: .7; }
  .head .search input { background: rgba(125,211,252,.08); border: 1px solid rgba(125,211,252,.2);
                        color: #dbe7ff; border-radius: 8px; padding: 5px 10px; font-size: 12px; outline: none; }
  .head .search input:focus { border-color: rgba(125,211,252,.5); }
  .stage { position: relative; height: calc(100vh - 51px); overflow: hidden; background:
           radial-gradient(1200px 600px at 20% 20%, rgba(59,130,246,.08), transparent 60%),
           radial-gradient(900px 500px at 80% 80%, rgba(29,201,129,.06), transparent 60%); }
  .tree { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
  .node-row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 8px;
              cursor: pointer; white-space: nowrap; }
  .node-row:hover { background: rgba(125,211,252,.08); }
  .node-row .tog { width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center;
                   font-size: 10px; color: #7dd3fc; border-radius: 4px; flex: none; }
  .node-row .tog.leaf { visibility: hidden; }
  .node-row .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .node-row .lbl { font-size: 13px; color: #e6efff; }
  .node-row .meta { font-size: 11px; color: #7d8db0; margin-left: 4px; }
  .nl-root { font-weight: 800; font-size: 15px; color: #7dd3fc; }
  .nl-root .dot { background: #7dd3fc; box-shadow: 0 0 8px rgba(125,211,252,.8); }
  .nl-feature { font-weight: 700; color: #a5b4fc; }
  .nl-feature .dot { background: #818cf8; }
  .nl-community { font-weight: 600; color: #6ee7b7; }
  .nl-community .dot { background: #34d399; }
  .nl-file { color: #dbe7ff; }
  .nl-file .dot { background: #64748b; }
  .nl-note { color: #fbbf24; font-style: italic; }
  .nl-note .dot { background: #f59e0b; }
  .children { margin-left: 22px; border-left: 1px solid rgba(125,211,252,.12); padding-left: 6px; }
  .bubble { position: absolute; max-width: 340px; background: rgba(10,16,34,.96); border: 1px solid rgba(125,211,252,.25);
            border-radius: 10px; padding: 10px 12px; font-size: 12px; line-height: 1.6; color: #dbe7ff;
            box-shadow: 0 8px 30px rgba(0,0,0,.5); z-index: 20; display: none; pointer-events: none; }
  .bubble .b-title { font-weight: 700; color: #7dd3fc; margin-bottom: 4px; font-size: 13px; }
  .bubble .b-meta { font-size: 11px; color: #7d8db0; margin-top: 6px; }
  .hint { position: absolute; bottom: 12px; left: 18px; font-size: 11px; opacity: .5; }
  .zoom { position: absolute; bottom: 12px; right: 18px; display: flex; gap: 6px; }
  .zoom button { width: 30px; height: 30px; background: rgba(125,211,252,.1); border: 1px solid rgba(125,211,252,.2);
                 color: #7dd3fc; border-radius: 8px; font-size: 16px; cursor: pointer; }
  .zoom button:hover { background: rgba(125,211,252,.2); }
  .empty { padding: 60px; text-align: center; color: #7d8db0; font-size: 14px; }
  /* ── 右侧对话面板 ── */
  .mmd-panel { position: absolute; top: 0; right: 0; bottom: 0; width: 320px; display: flex;
                flex-direction: column; background: rgba(6,11,31,.92); border-left: 1px solid rgba(125,211,252,.15);
                font-size: 12px; z-index: 30; }
  .mmd-panel.hidden { display: none; }
  .mmd-toggle { position: absolute; top: 12px; right: 14px; z-index: 40; background: rgba(125,211,252,.12);
                border: 1px solid rgba(125,211,252,.25); color: #7dd3fc; border-radius: 8px; padding: 5px 10px;
                font-size: 12px; cursor: pointer; }
  .mmd-head { padding: 10px 12px; border-bottom: 1px solid rgba(125,211,252,.15); font-weight: 700; color: #7dd3fc; }
  .mmd-msgs { flex: 1; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
  .mmd-msg { max-width: 92%; padding: 7px 10px; border-radius: 10px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
  .mmd-msg.user { align-self: flex-end; background: rgba(59,130,246,.25); border: 1px solid rgba(59,130,246,.3); color: #dbe7ff; }
  .mmd-msg.bot { align-self: flex-start; background: rgba(6,11,31,.6); border: 1px solid rgba(125,211,252,.2); color: #dbe7ff; }
  .mmd-msg.step { align-self: flex-start; background: rgba(125,211,252,.06); border-left: 2px solid #7dd3fc; color: #7d8db0; font-size: 11px; }
  .mmd-msg.err { align-self: flex-start; background: rgba(232,70,58,.12); border: 1px solid rgba(232,70,58,.3); color: #fca5a5; }
  .mmd-input { display: flex; gap: 6px; padding: 10px 12px; border-top: 1px solid rgba(125,211,252,.15); }
  .mmd-input input { flex: 1; background: rgba(125,211,252,.08); border: 1px solid rgba(125,211,252,.2); color: #dbe7ff;
                     border-radius: 8px; padding: 7px 10px; font-size: 12px; outline: none; }
  .mmd-input input:focus { border-color: rgba(125,211,252,.5); }
  .mmd-input button { background: rgba(59,130,246,.3); border: 1px solid rgba(59,130,246,.4); color: #e0ecff;
                      border-radius: 8px; padding: 7px 12px; font-size: 12px; cursor: pointer; }
  .mmd-input button:disabled { opacity: .5; cursor: not-allowed; }
  .mmd-stage { margin-left: 0; transition: margin-left .18s ease; }
</style>
</head>
<body>
<div class="head">
  <span class="ftitle">🧠 ${esc(title)}</span>
  <span class="fchip">L3 LLM 思维导图</span>
  <span class="mode" id="modeChip"></span>
  <div class="search"><input id="search" placeholder="搜索节点…"></div>
</div>
<div class="stage mmd-stage">
  <div class="empty" id="empty">加载中…</div>
  <div class="tree" id="tree"></div>
  <div class="hint">点击节点展开/折叠 · 悬停查看说明 · 滚轮缩放 · 可拖动</div>
  <div class="zoom">
    <button id="zin">+</button>
    <button id="zout">−</button>
    <button id="zreset">⟲</button>
  </div>
</div>
<button class="mmd-toggle" id="mmdToggle">💬 讲解</button>
<div class="mmd-panel hidden" id="mmdPanel">
  <div class="mmd-head">💬 思维导图管理助手</div>
  <div class="mmd-msgs" id="mmdMsgs"></div>
  <div class="mmd-input">
    <input id="mmdInput" placeholder="问项目 / 让它重新生成导图…">
    <button id="mmdSend">发送</button>
  </div>
</div>
<div class="bubble" id="bubble">
  <div class="b-title" id="bTitle"></div>
  <div id="bDesc"></div>
  <div class="b-meta" id="bMeta"></div>
</div>
<script>
(function(){
  var DATA = ${json};
  var tree = document.getElementById('tree');
  var empty = document.getElementById('empty');
  var bubble = document.getElementById('bubble');
  var modeChip = document.getElementById('modeChip');
  modeChip.textContent = DATA.mode === 'llm' ? '✨ LLM 提炼' : '📄 规则骨架';

  var ROOT_MODEL = DATA.root;
  var state = {}; // id -> collapsed
  var expandedSeed = new Set();

  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  var KIND_COLOR = { root:'#7dd3fc', feature:'#818cf8', community:'#34d399', file:'#64748b', note:'#f59e0b' };

  function countFiles(n){ if(n.children && n.children.length) return n.children.reduce(function(s,c){return s+countFiles(c);},0); return n.kind==='file'?1:0; }

  // 默认展开到功能层（root + 一级），折叠社区/文件，保持整体可读
  function defaultExpandDepth(n, depth){
    if(depth < 2) expandedSeed.add(n.id);
    (n.children||[]).forEach(function(c){ defaultExpandDepth(c, depth+1); });
  }
  defaultExpandDepth(ROOT_MODEL, 0);

  function render(){
    tree.innerHTML = '';
    var html = buildNode(ROOT_MODEL, 0);
    tree.innerHTML = html;
    bind();
    empty.style.display = 'none';
  }
  function buildNode(n, depth){
    var isCollapsed = state[n.id] === true;
    var hasKids = n.children && n.children.length;
    var defaultOpen = expandedSeed.has(n.id);
    var open = hasKids && !isCollapsed && (defaultOpen || state[n.id] === false);
    if(hasKids && state[n.id] === undefined) open = defaultOpen;
    var tog = hasKids ? '<span class="tog" data-tog="'+n.id+'">'+(open?'−':'+')+'</span>' : '<span class="tog leaf">·</span>';
    var files = n.meta && n.meta.files ? ' · '+n.meta.files+' 文件' : '';
    var metaHtml = n.meta && (n.meta.lines!==undefined || files) ? '<span class="meta">'+(n.meta.lines!==undefined?('~'+n.meta.lines+' 行'):'')+files+'</span>' : '';
    // 气泡用纯文本 meta（不含 HTML），避免悬停显示标签源码
    var metaText = '';
    if(n.kind==='root'||n.kind==='feature'){ if(n.meta&&n.meta.files) metaText=(n.meta.files+' 个文件'); }
    else if(n.kind==='community'){ var mp=[]; if(n.meta&&n.meta.files)mp.push(n.meta.files+' 个文件'); if(n.meta&&n.meta.lines)mp.push('约 '+n.meta.lines+' 行'); if(n.meta&&n.meta.symbols)mp.push(n.meta.symbols+' 个符号'); metaText=mp.join(' · '); }
    else if(n.kind==='file'){ if(n.meta&&n.meta.lines) metaText=n.meta.lines+' 行'; }
    var row = '<div class="node-row '+clsName(n.kind)+'" data-id="'+n.id+'" data-desc="'+esc(n.description||'')+'" data-kind="'+n.kind+'" data-label="'+esc(n.label||'')+'" data-meta="'+esc(metaText)+'">'
      + tog
      + '<span class="dot"></span>'
      + '<span class="lbl">'+esc(n.label||'')+'</span>'
      + metaHtml
      + '</div>';
    if(hasKids && open){
      var kids = '<div class="children">';
      (n.children||[]).forEach(function(c){ kids += buildNode(c, depth+1); });
      kids += '</div>';
      return row + kids;
    }
    return row;
  }
  function clsName(k){ return 'nl-'+k; }

  function bind(){
    tree.querySelectorAll('.node-row').forEach(function(row){
      row.addEventListener('click', function(e){
        var id = row.getAttribute('data-id');
        var tog = row.querySelector('[data-tog]');
        if(!tog){ return; }
        e.stopPropagation();
        state[id] = state[id] === true ? false : true;
        render();
      });
      row.addEventListener('mouseenter', function(e){
        var id = row.getAttribute('data-id');
        var label = row.getAttribute('data-label');
        var desc = row.getAttribute('data-desc');
        var meta = row.getAttribute('data-meta');
        if(!desc && !meta) return;
        bubble.style.display = 'block';
        document.getElementById('bTitle').textContent = label;
        document.getElementById('bDesc').textContent = desc || '（无说明）';
        document.getElementById('bMeta').textContent = (meta||'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&amp;/g,'&');
        var r = row.getBoundingClientRect();
        var stageR = row.parentElement.closest('.stage');
        var maxX = bubble.offsetWidth;
        bubble.style.left = Math.min(r.right + 12, window.innerWidth - bubble.offsetWidth - 10) + 'px';
        bubble.style.top = Math.min(r.top + window.scrollY, window.innerHeight - bubble.offsetHeight - 10) + 'px';
      });
      row.addEventListener('mouseleave', function(){ bubble.style.display = 'none'; });
    });
  }

  // 缩放 + 拖动
  var scale = 1, tx = 20, ty = 20;
  function applyTransform(){ tree.style.transform = 'translate('+tx+'px,'+ty+'px) scale('+scale+')'; }
  document.getElementById('zin').onclick = function(){ scale = Math.min(2.5, scale*1.2); applyTransform(); };
  document.getElementById('zout').onclick = function(){ scale = Math.max(.4, scale/1.2); applyTransform(); };
  document.getElementById('zreset').onclick = function(){ scale=1; tx=20; ty=20; applyTransform(); };
  tree.addEventListener('wheel', function(e){ e.preventDefault(); scale = Math.max(.4, Math.min(2.5, scale * (e.deltaY<0?1.1:.9))); applyTransform(); }, {passive:false});
  var dragging=false, sx=0, sy=0;
  tree.addEventListener('mousedown', function(e){ dragging=true; sx=e.clientX; sy=e.clientY; });
  window.addEventListener('mousemove', function(e){ if(dragging){ tx += e.clientX-sx; ty += e.clientY-sy; sx=e.clientX; sy=e.clientY; applyTransform(); }});
  window.addEventListener('mouseup', function(){ dragging=false; });

  // 搜索：展开匹配节点并高亮
  var searchInput = document.getElementById('search');
  var searchTimer;
  searchInput.addEventListener('input', function(){
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function(){ doSearch(searchInput.value.trim().toLowerCase()); }, 200);
  });
  function flatten(n, acc){ acc.push(n); (n.children||[]).forEach(function(c){ flatten(c, acc); }); return acc; }
  function doSearch(q){
    if(!q){ render(); return; }
    var all = flatten(ROOT_MODEL, []);
    var matchIds = new Set(all.filter(function(n){ return (n.label||'').toLowerCase().indexOf(q)!==-1 || (n.description||'').toLowerCase().indexOf(q)!==-1; }).map(function(n){return n.id;}));
    // 展开所有祖先路径
    all.forEach(function(n){
      if(matchIds.has(n.id)){
        var cur = ROOT_MODEL;
        state[n.id] = false;
        (function walk(p){
          if(p.id===n.id) return;
          (p.children||[]).forEach(function(c){ if(matchIds.has(c.id) || (function contains(x){ return (x.children||[]).some(function(y){ return y.id===n.id || contains(y); }); })(c)){ state[c.id]=false; walk(c); } });
        })(ROOT_MODEL);
      }
    });
    render();
    // 高亮命中
    tree.querySelectorAll('.node-row').forEach(function(row){
      var id = row.getAttribute('data-id');
      if(matchIds.has(id)) row.style.background = 'rgba(245,158,11,.18)';
    });
  }

  render();
  applyTransform();

  // ── 右侧对话面板：只读问答 Agent ──
  var panel = document.getElementById('mmdPanel');
  var toggle = document.getElementById('mmdToggle');
  var msgs = document.getElementById('mmdMsgs');
  var input = document.getElementById('mmdInput');
  var sendBtn = document.getElementById('mmdSend');
  var mmdHistory = [];
  var FEATURE = DATA.feature;

  function addMsg(text, cls){
    var d = document.createElement('div');
    d.className = 'mmd-msg ' + cls;
    d.textContent = text;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    return d;
  }
  toggle.addEventListener('click', function(){
    var hidden = panel.classList.contains('hidden');
    panel.classList.toggle('hidden');
    document.querySelectorAll('.mmd-stage')[0].style.marginLeft = hidden ? '320px' : '0';
    if(hidden) input.focus();
  });
  function send(){
    var text = input.value.trim();
    if(!text) return;
    addMsg(text, 'user');
    input.value = '';
    sendBtn.disabled = true;
    var waiting = addMsg('…正在请讲解助手分析', 'step');
    var payload = { feature: FEATURE, message: text, history: mmdHistory };
    fetch('/api/mmd/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function(r){ return r.json(); }).then(function(res){
      waiting.remove();
      if(!res.success){
        addMsg('请求失败：' + (res.error || '未知错误'), 'err');
        return;
      }
      if(res.note) addMsg(res.note, 'step');
      if(res.step) addMsg('🔧 ' + res.step.action + (res.step.observation ? '\\n' + res.step.observation.slice(0, 300) : ''), 'step');
      var answer = res.answer || '（无回答）';
      addMsg(answer, 'bot');
      mmdHistory.push({ role: 'user', content: text });
      mmdHistory.push({ role: 'assistant', content: answer });
    }).catch(function(e){
      waiting.remove();
      addMsg('请求失败：' + (e && e.message ? e.message : e), 'err');
    }).finally(function(){
      sendBtn.disabled = false;
      input.focus();
    });
  }
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', function(e){ if(e.key === 'Enter'){ send(); } });
})();
</script>
</body>
</html>`;
}