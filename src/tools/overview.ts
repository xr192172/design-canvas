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
function ruleSummary(feature: string, title: string, mm: MindMap): OverviewSummary {
  const feats = mm.root.children ?? [];
  const fileTotal = mm.root.meta?.files ?? 0;
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

export async function getOverview(input: GetOverviewInput): Promise<OverviewResult> {
  const { feature, refresh = false, refresh_llm = false, first_steps = 3 } = input;
  const dsl = getDSL(feature);
  if (!dsl) throw new Error(`feature "${feature}" 不存在`);
  const title = dsl.title || feature;
  let dslRev = dsl._dsl_rev ?? 0;

  // 1. 思维导图：有现成的用现成的；没有现场生成（rule 快速版）
  let mindMap: MindMap | null = null;
  const mmFile = getMindMapFile(feature);
  if (fs.existsSync(mmFile)) {
    try {
      mindMap = JSON.parse(fs.readFileSync(mmFile, 'utf-8')) as MindMap;
    } catch {
      mindMap = null;
    }
  }
  let note: string | undefined;
  if (!mindMap) {
    const result = refresh_llm
      ? await deriveMindMap({ feature, gen_descriptions: true })
      : await deriveMindMap({ feature });
    mindMap = result.mind_map;
    note = `思维导图已生成（${result.mode === 'llm' ? 'LLM 提炼' : '规则骨架'}）`;
  }

  // 1.5 平铺兜底修复 + 规则树升级：小白第一屏不能是文件名列表，功能名也不能
  // 一直是目录名（tools/camera）。两种情况需要（重）生成功能树：
  //   a) 导图平铺（DSL 缺 feature_tree）→ 现场聚类（refresh_llm 时用 LLM 命名）
  //   b) refresh_llm 且现有树是规则版（source!=='llm'）→ 用 LLM 重新归并命名
  const treeIsRule = (dsl.feature_tree?.source ?? 'rule') !== 'llm';
  const wasFlat = isFlatMindMap(mindMap);
  if (wasFlat || (refresh_llm && treeIsRule)) {
    const ok = await tryDeriveFeatureTree(feature, dsl, refresh_llm);
    if (ok) {
      mindMap = (await deriveMindMap({ feature, gen_descriptions: refresh_llm })).mind_map;
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
  }

  // 2. 摘要：缓存 → LLM（允许时）→ 规则兜底
  let summary: OverviewSummary | null = refresh ? null : readCachedSummary(feature, dslRev);
  if (!summary) {
    summary = (refresh_llm ? await llmSummary(feature, title, mindMap) : null) ?? ruleSummary(feature, title, mindMap);
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
