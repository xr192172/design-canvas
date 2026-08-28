/**
 * overview 工具：小白视图数据组装（项目页第一屏）
 *
 * 回答新手的四个问题中的三个（第四个"怎么做"由 first_steps 兜）：
 *   - 这是什么软件？   → summary（一句话 + 两行简介）
 *   - 有哪些功能？     → mind_map 的 root→feature→community 层（前端画圆框图）
 *   - 每个功能里有什么？→ 社区节点 description（点开看）
 *   - 要怎么做？       → first_steps（guided_tour 学习路径前几步）
 *
 * 数据全部来自现有能力（derive_mind_map / guided_tour / LLM），本工具只做组装与缓存：
 *   - 摘要缓存：<storageRoot>/overview/<feature>.json（记 dsl_rev，DSL 变更自动失效）
 *   - LLM 未配置/失败：降级规则版摘要，页面照常可用
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDSL, getStorageRoot } from '../storage.js';
import { deriveMindMap, getMindMapFile } from './derive_mind_map.js';
import { loadAgentConfig } from './llm_focus.js';
import { guidedTour } from './guided_tour.js';
import type { TourStep } from './guided_tour.js';
import type { MindMap } from '../dsl/mindmap.js';
import { extractJsonObject } from './explain_gen.js';
import { deriveFeatureTree } from './derive_feature_tree.js';
import { openDb } from '../db/db.js';

export interface OverviewSummary {
  /** 一句话：这是什么软件（≤30 字，人话） */
  one_liner: string;
  /** 两三句：它大概由哪几块组成、用来干嘛 */
  brief: string;
  mode: 'llm' | 'rule';
}

export interface OverviewResult {
  feature: string;
  title: string;
  summary: OverviewSummary;
  /** 功能树（root→feature→community→file；前端展示到 community，file 下钻用） */
  mind_map: MindMap;
  /** 上手步骤（guided_tour 前几步） */
  first_steps: TourStep[];
  generated_at: string;
  note?: string;
}

/** 摘要缓存文件：<storageRoot>/overview/<feature>.json */
function overviewFile(feature: string): string {
  return path.join(getStorageRoot(), 'overview', `${feature}.json`);
}

function readCachedSummary(feature: string, dslRev: number): OverviewSummary | null {
  try {
    const f = overviewFile(feature);
    if (!fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, 'utf-8')) as OverviewSummary & { dsl_rev: number };
    if (j.dsl_rev !== dslRev) return null; // DSL 已变更，缓存失效
    return { one_liner: j.one_liner, brief: j.brief, mode: j.mode };
  } catch {
    return null;
  }
}

function writeCachedSummary(feature: string, dslRev: number, s: OverviewSummary): void {
  try {
    const f = overviewFile(feature);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ ...s, dsl_rev: dslRev }, null, 2));
  } catch {
    /* 缓存写失败不影响主流程 */
  }
}

/** 规则版摘要：无 LLM / LLM 失败时的兜底（从功能树拼装，不编造） */
function ruleSummary(feature: string, title: string, mm: MindMap, fileCount?: number): OverviewSummary {
  const feats = mm.root.children ?? [];
  // 文件总数：teach 树 meta.files 缺失时用语义层文件数兜底（避免显示「0 个源码文件」）
  const fileTotal = mm.root.meta?.files ?? fileCount ?? 0;
  if (feats.length === 0) {
    return {
      one_liner: `${title}（${fileTotal} 个源码文件）`,
      brief: '功能树尚未生成，暂无法给出功能级概览。可先执行 derive_mind_map 生成。',
      mode: 'rule',
    };
  }
  const names = feats
    .map((f) => (f.label === '(根)' ? '其他模块' : f.label))
    .slice(0, 6)
    .join('、');
  const more = feats.length > 6 ? ` 等 ${feats.length} 个功能` : '';
  return {
    one_liner: `${title}：由 ${feats.length} 个功能组成的软件（${fileTotal} 个源码文件）`,
    brief: `主要功能包括 ${names}${more}。每个功能由若干子模块组成，点下方圆框查看各功能说明。`,
    mode: 'rule',
  };
}

/** LLM 版摘要：把功能树喂给 LLM，产出"这是什么软件"的人话概括 */
async function llmSummary(feature: string, title: string, mm: MindMap): Promise<OverviewSummary | null> {
  const cfg = loadAgentConfig();
  if (!cfg) return null;
  const feats = mm.root.children ?? [];
  if (feats.length === 0) return null;
  const list = feats
    .map((f) => {
      const subs = (f.children ?? []).map((c) => c.label).slice(0, 5).join('、');
      return `- ${f.label}（${f.meta?.files ?? '?'} 文件${subs ? `，含：${subs}` : ''}）${f.description ?? ''}`;
    })
    .join('\n');
  const system =
    '你是软件产品介绍官。给定一个项目的功能清单（功能名/子模块/文件数），用普通人能懂的话概括这个软件。\n' +
    '只输出 JSON：{"one_liner":"一句话（≤30字，说清这是什么软件）","brief":"2-3句（它由哪几块组成、用来干嘛，不要罗列文件名）"}\n' +
    '基于给定事实，不编造功能。';
  try {
    const res = await fetch(`${cfg.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `项目：${title}\n功能清单：\n${list}` },
        ],
        temperature: 0.4,
        response_format: { type: 'json_object' },
        signal: AbortSignal.timeout(60_000),
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? '';
    const obj = extractJsonObject(content) as { one_liner?: string; brief?: string } | null;
    if (!obj?.one_liner) return null;
    return { one_liner: String(obj.one_liner).slice(0, 80), brief: String(obj.brief ?? '').slice(0, 300), mode: 'llm' };
  } catch {
    return null;
  }
}

/** mind_map 是否处于"文件平铺"形态（无功能层）——小白视图 unacceptable，需补功能树 */
function isFlatMindMap(mm: MindMap): boolean {
  const kids = mm.root.children ?? [];
  return kids.length === 0 || kids[0].kind === 'file';
}

/**
 * 平铺兜底修复：DSL 没有 feature_tree 时用 deriveFeatureTree 现场生成
 * （Louvain 社区 → 按目录/LLM 归并成 3-8 个功能），写回 DSL。
 * cache.db 定位顺序：导入缓存 import_cache_<feature>.db > <source_root>/.design-canvas/cache.db
 * > <serve 项目根>/.design-canvas/cache.db。找不到任何 db 时静默失败（保持平铺）。
 */
function tryDeriveFeatureTree(feature: string, dsl: { source_root?: string }, genNames: boolean): Promise<boolean> {
  const candidates: string[] = [
    path.join(getStorageRoot(), `import_cache_${feature}.db`),
    dsl.source_root ? path.join(dsl.source_root, '.design-canvas', 'cache.db') : '',
    path.join(process.cwd(), '.design-canvas', 'cache.db'),
  ].filter(Boolean) as string[];
  const dbFile = candidates.find((p) => fs.existsSync(p));
  if (!dbFile) return Promise.resolve(false);
  let db;
  try {
    db = openDb(dbFile);
  } catch {
    return Promise.resolve(false);
  }
  const projectDir = dsl.source_root ?? process.cwd();
  return deriveFeatureTree({ project_dir: projectDir, feature, db, gen_names: genNames })
    .then((r) => r.features.length > 0)
    .catch(() => false)
    .finally(() => db.close());
}

export interface GetOverviewInput {
  feature: string;
  /** 强制重新生成（忽略摘要缓存；refresh_llm=true 时才尝试 LLM 升级） */
  refresh?: boolean;
  /** 允许调用 LLM：升级摘要 + 思维导图描述（慢，首次/用户主动刷新时用） */
  refresh_llm?: boolean;
  /** 上手步骤数（默认 3） */
  first_steps?: number;
}

/** 自动生成的统计型 responsibility（如 "src/tools — 9 个 API（导入自 5 个模块）"）不是人话，视为缺失 */
const STATISTICAL_DESC_RE = / — \d+ 个| — 聚合 /;

/** 共享能力描述缓存：<storageRoot>/overview/<feature>.shared_desc.json（按 dsl_rev 失效） */
function sharedDescCacheFile(feature: string): string {
  return path.join(getStorageRoot(), 'overview', `${feature}.shared_desc.json`);
}

/** LLM 批量为共享能力文件写一句"它是干嘛的"。材料全部是已有事实：调用方×次数 + 导出 API 签名 */
async function llmSharedDesc(
  shared: NonNullable<MindMap['shared']>,
  dsl: NonNullable<ReturnType<typeof getDSL>>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const cfg = loadAgentConfig();
  if (!cfg) return out;
  // API 签名材料：精确 → 后缀匹配 semantic.actual_apis（cache.db 与 DSL 路径前缀可能不一致）
  const apiExact = new Map<string, string[]>();
  const apiSuffix = new Map<string, string>();
  for (const f of dsl.semantic?.files ?? []) {
    const sigs = (f.actual_apis ?? []).slice(0, 5).map((a) => a.signature).filter(Boolean);
    if (!f.path || sigs.length === 0) continue;
    apiExact.set(f.path, sigs);
    const segs = f.path.split('/');
    for (let k = 0; k < segs.length - 1; k++) {
      const key = segs.slice(k).join('/');
      if (!apiSuffix.has(key)) apiSuffix.set(key, sigs.join('; '));
    }
  }
  const apisOf = (file: string): string => {
    if (apiExact.has(file)) return apiExact.get(file)!.join('; ');
    const segs = file.split('/');
    for (let k = 0; k < segs.length; k++) {
      const hit = apiSuffix.get(segs.slice(k).join('/'));
      if (hit) return hit;
    }
    return '';
  };
  const items = shared
    .slice(0, 16)
    .map((s) => {
      const callers = s.used_by.map((u) => `${u.feature}×${u.count}`).join('、');
      return `- ${s.file}｜被调用：${callers}｜导出API：${apisOf(s.file) || '（无记录）'}`;
    })
    .join('\n');
  try {
    const res = await fetch(`${cfg.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          {
            role: 'system',
            content:
              '你是代码库讲解员。给定项目里被多个功能共用的"共享能力"文件清单（含真实调用方与导出API），' +
              '为每个文件写一句通俗易懂的"它是干嘛的"（15~40 字，讲它为整个项目提供了什么能力，不罗列函数名）。' +
              '只输出 JSON：{"descs":{"<文件路径>":"<一句话>"}}，路径必须来自给定清单。',
          },
          { role: 'user', content: `项目：${dsl.title || ''}\n清单：\n${items}` },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return out;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const parsed = extractJsonObject(data.choices?.[0]?.message?.content ?? '');
    const raw = parsed?.descs as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== 'object') return out;
    for (const [f, v] of Object.entries(raw)) {
      const s = typeof v === 'string' ? v.trim() : '';
      if (s) out.set(f, s);
    }
  } catch {
    // LLM 失败静默降级：面板只少一行介绍，不影响其余数据
  }
  return out;
}

/** 共享能力补"它是干嘛的"三级填充：语义层人话职责 → 描述缓存 → LLM 后台生成（wait=false 时不阻塞响应） */
const sharedDescInflight = new Map<string, Promise<void>>();
async function enrichSharedDesc(
  mindMap: MindMap,
  dsl: NonNullable<ReturnType<typeof getDSL>>,
  feature: string,
  dslRev: number,
  wait: boolean,
): Promise<void> {
  const shared = mindMap.shared;
  if (!shared?.length) return;
  // 1) 语义层直取（统计型兜底文案视为缺失）
  const exact = new Map<string, string>();
  const bySuffix = new Map<string, string>();
  for (const f of dsl.semantic?.files ?? []) {
    if (!f.path || !f.responsibility || STATISTICAL_DESC_RE.test(f.responsibility)) continue;
    exact.set(f.path, f.responsibility);
    const segs = f.path.split('/');
    for (let k = 0; k < segs.length - 1; k++) {
      const key = segs.slice(k).join('/');
      if (!bySuffix.has(key)) bySuffix.set(key, f.responsibility);
    }
  }
  for (const s of shared) {
    if (s.desc) continue;
    let hit = exact.get(s.file);
    const segs = s.file.split('/');
    for (let k = 0; k < segs.length - 1 && !hit; k++) hit = bySuffix.get(segs.slice(k).join('/'));
    if (hit) s.desc = hit;
  }
  const missing = () => shared.filter((s) => !s.desc);
  if (missing().length === 0) return;
  // 2) 描述缓存（按 dsl_rev 失效）
  let cached: Record<string, string> = {};
  try {
    const j = JSON.parse(fs.readFileSync(sharedDescCacheFile(feature), 'utf-8')) as { dsl_rev?: number; descs?: Record<string, string> };
    if (j.dsl_rev === dslRev && j.descs) cached = j.descs;
  } catch {
    cached = {};
  }
  for (const s of missing()) if (cached[s.file]) s.desc = cached[s.file];
  if (missing().length === 0) return;
  // 3) LLM 生成（wait=false 时后台执行，本次响应不带介绍，下次刷新可见）
  const run = (async () => {
    const descs = await llmSharedDesc(missing(), dsl);
    const all = { ...cached };
    for (const s of shared) {
      if (descs.get(s.file)) s.desc = descs.get(s.file);
      if (s.desc) all[s.file] = s.desc;
    }
    try {
      fs.mkdirSync(path.dirname(sharedDescCacheFile(feature)), { recursive: true });
      fs.writeFileSync(sharedDescCacheFile(feature), JSON.stringify({ dsl_rev: dslRev, descs: all }, null, 2), 'utf-8');
    } catch {
      // 缓存写失败不影响当次结果
    }
  })().finally(() => sharedDescInflight.delete(feature));
  if (wait) {
    await run;
  } else if (!sharedDescInflight.has(feature)) {
    sharedDescInflight.set(feature, run);
  }
}

export async function getOverview(input: GetOverviewInput): Promise<OverviewResult> {
  const { feature, refresh = false, refresh_llm = false, first_steps = 3 } = input;
  const dsl = getDSL(feature);
  if (!dsl) {
    const err = new Error(`feature "${feature}" 不存在`) as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  const title = dsl.title || feature;
  let dslRev = dsl._dsl_rev ?? 0;

  // 1. 思维导图：优先 teach（科普分镜版）→ structure 降级 → 现场生成 rule 版 teach
  let mindMap: MindMap | null = null;
  const teachFile = getMindMapFile(feature, 'teach');
  if (fs.existsSync(teachFile)) {
    try {
      mindMap = JSON.parse(fs.readFileSync(teachFile, 'utf-8')) as MindMap;
    } catch {
      mindMap = null;
    }
  }
  if (!mindMap) {
    const mmFile = getMindMapFile(feature);
    if (fs.existsSync(mmFile)) {
      try {
        mindMap = JSON.parse(fs.readFileSync(mmFile, 'utf-8')) as MindMap;
      } catch {
        mindMap = null;
      }
    }
  }
  let note: string | undefined;
  if (!mindMap) {
    const result = await deriveMindMap({ feature, view: 'teach' });
    mindMap = result.mind_map;
    note = `思维导图已生成（${result.mode === 'llm' ? 'LLM 科普分镜' : '规则骨架'}）`;
  }

  // 1.5 平铺兜底修复 + 规则树升级：小白第一屏不能是文件名列表，功能名也不能
  // 一直是目录名（tools/camera）。两种情况需要（重）生成功能树：
  //   a) 导图平铺（DSL 缺 feature_tree）→ 现场聚类（refresh_llm 时用 LLM 命名）
  //   b) refresh_llm 且现有树是规则版（source!=='llm'）→ 用 LLM 重新归并命名
  // 树更新后 teach 导图需重建（吃新功能名）；树已是 LLM 版但 teach 未升级时也补生成。
  const treeIsRule = (dsl.feature_tree?.source ?? 'rule') !== 'llm';
  const wasFlat = isFlatMindMap(mindMap);
  if (wasFlat || (refresh_llm && treeIsRule)) {
    const ok = await tryDeriveFeatureTree(feature, dsl, refresh_llm);
    if (ok) {
      mindMap = (await deriveMindMap({ feature, view: 'teach', gen_descriptions: refresh_llm })).mind_map;
      const fresh = getDSL(feature);
      const upgraded = fresh?.feature_tree?.source === 'llm';
      note = wasFlat
        ? '已自动生成功能树（按调用关系聚类）'
        : upgraded
          ? '功能已用 AI 重新命名归类'
          : undefined;
      // saveDSL 已推进磁盘 rev；重取最新值，否则摘要缓存会误命中补树前的旧文案
      if (fresh) dslRev = fresh._dsl_rev ?? dslRev;
    } else if (!dsl.source_root && wasFlat) {
      note = '该项目缺少源码快照（早期导入数据），无法聚类功能树；重新导入可获得完整功能视图';
    }
  } else if (refresh_llm && (dsl.feature_tree?.features?.length ?? 0) > 0) {
    // refresh_llm 总是重建 teach：批注（DSL.annotations）可能已变，LLM 需读到最新的人的理解
    const result = await deriveMindMap({ feature, view: 'teach', gen_descriptions: true });
    if (result.mode === 'llm') {
      mindMap = result.mind_map;
      note = '已生成 AI 科普分镜（含最新批注）';
    }
  }

  enrichSharedDesc(mindMap, dsl, feature, dslRev, refresh_llm);

  // 2. 摘要：缓存 → LLM（允许时）→ 规则兜底
  let summary: OverviewSummary | null = refresh ? null : readCachedSummary(feature, dslRev);
  if (!summary) {
    summary = (refresh_llm ? await llmSummary(feature, title, mindMap) : null) ?? ruleSummary(feature, title, mindMap, dsl.semantic?.files?.length);
    writeCachedSummary(feature, dslRev, summary);
  }

  // 3. 上手步骤：guided_tour 前 N 步（多取 3 倍再过滤噪声，临时/隐藏文件
  //（.tmp/_dbg 等 0 依赖节点）会被拓扑排序排到最前，对新手是纯噪声）
  let steps: TourStep[] = [];
  try {
    const noisy = /^[_.\[]|\/_|\.tmp|\.test\.|\.spec\./;
    steps = guidedTour({ feature, max_steps: first_steps * 4 })
      .steps.filter((s) => !noisy.test(s.label))
      .slice(0, first_steps);
  } catch {
    steps = []; // 无几何节点等情况，步骤区隐藏即可
  }

  return { feature, title, summary, mind_map: mindMap, first_steps: steps, generated_at: new Date().toISOString(), note };
}
