/**
 * cluster_narrator —— 簇级人话翻译层（LLM 充当"文件→功能"翻译，跨鸿沟的关键一环）
 *
 * 用户痛点（2026-08-25）：聚类科学但"看不懂"——节点全是文件名，非专业人员看不出
 * 这坨文件是干什么的、有什么用。答案：确定性聚类只给**骨架**（谁跟谁一伙），
 * 本模块给**血肉**（每伙是干什么的，用人话）。
 *
 * 忠实纪律（同 narrate_step）：LLM 只做名词翻译，不发明结构——
 *   - 证据 = 簇内每个文件的**真实顶层导出符号**（正则提取，非 AST 猜测）
 *     + 文件路径 + 内聚度/文件数（确定性事实）
 *   - LLM 输出必须挂在给定簇 id 上（path 白名单校验，防串答）
 *   - LLM 未配置/失败 → 降级为确定性事实句（"12 个文件互相依赖成簇，内聚 100%"），
 *     永不阻塞、永不编造
 *
 * 配置复用 role_title 的降级链：llm_focus 的 llm 段 → explain_gen 的 DeepSeek/Agnes。
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadLlmConfig, callChat } from './llm_focus.js';
import { loadExplainConfig } from './explain_gen.js';
import type { BrickifyResult, BrickRole } from './brickify.js';
import { ROLE_LABEL } from './brickify.js';

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

/** 一条人话翻译：title（≤12字标题）+ desc（干什么/有什么用，1-2 句） */
export interface ClusterNarrative {
  title: string;
  desc: string;
  /** 翻译来源：llm=模型翻译 / rule=确定性降级（LLM 不在或失败） */
  mode: 'llm' | 'rule';
}

/** 项目总览（第0层）：项目本身是什么 + 功能清单（与积木一一对应） */
export interface ProjectOverview {
  /** 项目是什么（≤16 字人话，如"可视化设计画布工具"） */
  title: string;
  /** 2-3 句：这个项目本身是什么、核心价值 */
  desc: string;
  /** 功能清单：每块积木一条（target=积木 id，与下钻结构一一对应） */
  features: Array<{ target: string; label: string; desc: string }>;
  mode: 'llm' | 'rule';
}

/** 三级人话：社区 / 积木 / 小簇（key = 对应 id）+ 项目总览 */
export interface ClusterNarratives {
  overview: ProjectOverview;
  communities: Record<string, ClusterNarrative>;
  bricks: Record<string, ClusterNarrative>;
  clusters: Record<string, ClusterNarrative>;
  meta: {
    /** 真实走了 LLM 的条数 / 总条数（不含 overview） */
    llm_ok: number;
    total: number;
    degraded: boolean;
  };
}

export interface NarrateOptions {
  /** 每批簇数（控制单次 payload），默认 6 */
  batch?: number;
  /** 并发批数上限，默认 2 */
  concurrency?: number;
}

// ─────────────────────────────────────────────────────────────
// 证据提取：文件顶层导出符号（正则，忠实且便宜）
// ─────────────────────────────────────────────────────────────

const EXPORT_RE =
  /export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_LIST_RE = /export\s*\{([^}]+)\}/g;

/** 单文件顶层导出符号名（去重，前 N 个）；读不到返回空。 */
export function topLevelExportsOf(sourceRoot: string, rel: string, limit = 8): string[] {
  let src = '';
  try {
    src = fs.readFileSync(path.join(sourceRoot, ...rel.split('/')), 'utf-8');
  } catch {
    return [];
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const m of src.matchAll(EXPORT_RE)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      names.push(m[1]);
    }
  }
  for (const m of src.matchAll(EXPORT_LIST_RE)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (seg && /^[A-Za-z_$][\w$]*$/.test(seg) && !seen.has(seg)) {
        seen.add(seg);
        names.push(seg);
      }
    }
  }
  return names.slice(0, limit);
}

// ─────────────────────────────────────────────────────────────
// 待翻译单元（拍平三级，统一喂 LLM）
// ─────────────────────────────────────────────────────────────

interface NarrUnit {
  /** 全局唯一 id：community:<id> / brick:<id> / cluster:<id> */
  key: string;
  kind: 'community' | 'brick' | 'cluster';
  /** 原始 id（回填用） */
  rawId: string;
  files: string[];
  exports: string[];
  facts: string; // 确定性事实句（内聚度/文件数/角色）——证据的一部分
}

/** 拍平 BrickifyResult → 待翻译单元（每单元带确定性事实 + 符号证据）。 */
export function collectNarrUnits(r: BrickifyResult, sourceRoot: string): NarrUnit[] {
  const units: NarrUnit[] = [];
  const roleCn: Record<BrickRole, string> = {
    brick: '功能',
    contract: '契约',
    glue: '胶水',
  };

  for (const c of r.communities) {
    const totalFiles = c.bricks.reduce((acc, bid) => {
      const b = r.bricks.find((x) => x.id === bid);
      return acc + (b?.total ?? 0);
    }, 0);
    units.push({
      key: `community:${c.id}`,
      kind: 'community',
      rawId: c.id,
      files: [],
      exports: [],
      facts: `${c.bricks.length} 块积木 / ${totalFiles} 文件 / 内聚 ${Math.round(c.cohesion * 100)}%`,
    });
  }

  for (const b of r.bricks) {
    const all = [...b.files.frontend, ...b.files.backend, ...b.files.shared];
    units.push({
      key: `brick:${b.id}`,
      kind: 'brick',
      rawId: b.id,
      files: all.slice(0, 10),
      exports: all.slice(0, 4).flatMap((f) => topLevelExportsOf(sourceRoot, f, 4)).slice(0, 12),
      facts: `${all.length} 文件 / 主导角色=${ROLE_LABEL[b.role]} / ${b.sub_clusters.length} 个内部功能簇`,
    });
    for (const s of b.sub_clusters) {
      units.push({
        key: `cluster:${s.id}`,
        kind: 'cluster',
        rawId: s.id,
        files: s.files.slice(0, 12),
        exports: s.files.slice(0, 4).flatMap((f) => topLevelExportsOf(sourceRoot, f, 4)).slice(0, 12),
        facts:
          `${s.files.length} 文件 / 内聚 ${Math.round(s.cohesion * 100)}% / 角色=${roleCn[s.role]}` +
          (s.degenerate && s.files.length > 1 ? ' / 整层耦合' : ''),
      });
    }
  }
  return units;
}

/** 确定性降级翻译：LLM 不在时的"事实句"人话（不编造，只陈述）。 */
export function fallbackNarrative(u: NarrUnit): ClusterNarrative {
  const kindCn: Record<NarrUnit['kind'], string> = {
    community: '功能社区',
    brick: '积木',
    cluster: '功能簇',
  };
  const seed = u.kind === 'cluster' ? u.rawId.split('#')[0] : u.rawId;
  return {
    title: `${seed}（${kindCn[u.kind]}）`,
    desc: `这${kindCn[u.kind]}由互相依赖的文件组成：${u.facts}。具体职责待 LLM 翻译或人工标注。`,
    mode: 'rule',
  };
}

// ─────────────────────────────────────────────────────────────
// LLM 批量翻译
// ─────────────────────────────────────────────────────────────

function toLlmCfg(c: ReturnType<typeof loadExplainConfig>) {
  return c ? { apiKey: c.apiKey, model: c.model, baseURL: c.baseURL } : null;
}

async function narrateOneBatch(
  cfg: { apiKey: string; model: string; baseURL: string },
  group: NarrUnit[],
): Promise<Record<string, ClusterNarrative>> {
  const listText = group
    .map((u, i) => {
      const files = u.files.length ? u.files.join(', ') : '(社区级，见积木清单)';
      const exports = u.exports.length ? u.exports.join(', ') : '(无导出符号)';
      return `${i + 1}. id=${u.key}\n   级别=${u.kind}\n   文件=${files}\n   导出符号=${exports}\n   事实=${u.facts}`;
    })
    .join('\n');

  const system =
    '你是项目结构翻译官。给定若干"文件簇"（同一功能互相依赖的文件组），请为每簇生成人话翻译，' +
    '让完全不懂代码的人也能明白这组文件是干什么的、有什么用。要求：\n' +
    '- title：不超过 12 个汉字的功能名（如"界面渲染引擎"、"依赖扫描与死码检测"），描述功能而非文件名；\n' +
    '- desc：1-2 句口语化说明"它做什么 + 给谁用/有什么用"，可用生活化比喻（如"像流水线上的质检员"）；\n' +
    '- 只依据给定的文件名、导出符号、事实推断，不得编造文件中不存在的功能；\n' +
    '- 同批内 title 不得重复。\n' +
    '只输出 JSON：{"narratives":[{"id":"...","title":"...","desc":"..."}]}，id 必须来自给定清单。';

  const raw = await callChat(cfg, [
    { role: 'system', content: system },
    { role: 'user', content: `请翻译以下 ${group.length} 个文件簇：\n${listText}` },
  ]);

  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return {};
  const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
    narratives?: Array<{ id?: string; title?: string; desc?: string }>;
  };
  const known = new Set(group.map((g) => g.key));
  const out: Record<string, ClusterNarrative> = {};
  for (const n of parsed.narratives ?? []) {
    if (n.id && known.has(n.id) && n.title) {
      out[n.id] = {
        title: n.title.trim().slice(0, 24),
        desc: (n.desc ?? '').trim().slice(0, 160),
        mode: 'llm',
      };
    }
  }
  return out;
}

/**
 * 全量翻译：第0层项目总览 + 三级（社区/积木/小簇）→ 人话。
 * LLM 缺席或部分失败时逐条降级为事实句。永不抛异常（翻译是增强层，不阻塞结构管线）。
 *
 * 巨簇/漏翻补轮（两轮制）：第一轮按 batch 分批并发；LLM 没翻出来的单元（大簇
 * JSON 截断/同批重名被拒）收集起来，第二轮小批量（≤3/批）重试一次，把覆盖率拉满。
 */
export async function narrateClusters(
  r: BrickifyResult,
  sourceRoot: string,
  opts: NarrateOptions = {},
): Promise<ClusterNarratives> {
  const units = collectNarrUnits(r, sourceRoot);
  const result: ClusterNarratives = {
    overview: fallbackOverview(r),
    communities: {},
    bricks: {},
    clusters: {},
    meta: { llm_ok: 0, total: units.length, degraded: true },
  };
  const bucketOf = (u: NarrUnit): Record<string, ClusterNarrative> =>
    u.kind === 'community' ? result.communities : u.kind === 'brick' ? result.bricks : result.clusters;

  // 全部先落降级（事实句），LLM 成功的再覆盖
  for (const u of units) bucketOf(u)[u.rawId] = fallbackNarrative(u);

  const cfg = loadLlmConfig() ?? toLlmCfg(loadExplainConfig());
  if (!cfg || units.length === 0) {
    return result; // 未配置 LLM：全部降级
  }

  const batch = opts.batch ?? 6;
  const concurrency = opts.concurrency ?? 2;

  const runBatches = async (group: NarrUnit[], size: number): Promise<void> => {
    const batches: NarrUnit[][] = [];
    for (let i = 0; i < group.length; i += size) batches.push(group.slice(i, i + size));
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const idx = next++;
        if (idx >= batches.length) return;
        try {
          const got = await narrateOneBatch(cfg, batches[idx]);
          for (const [key, nar] of Object.entries(got)) {
            const u = units.find((x) => x.key === key);
            if (u && bucketOf(u)[u.rawId].mode !== 'llm') {
              bucketOf(u)[u.rawId] = nar;
              result.meta.llm_ok++;
            }
          }
        } catch {
          // 单批失败：该批保持降级事实句（第二轮再补）
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));
  };

  // 第一轮：全量
  await runBatches(units, batch);
  // 第二轮：只补漏（小批量重试）
  const missing = units.filter((u) => bucketOf(u)[u.rawId].mode !== 'llm');
  if (missing.length > 0) {
    await runBatches(missing, Math.min(3, batch));
  }

  // 第0层：项目总览（用已翻好的积木人话做证据，保证"项目→功能"与下钻一一对应；失败重试一次）
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ov = await narrateOverview(cfg, r, r.meta.project_dir, result);
      if (ov) {
        result.overview = ov;
        break;
      }
    } catch {
      // 重试一次；再失败保持降级
    }
  }

  result.meta.degraded = result.meta.llm_ok === 0;
  return result;
}

// ─────────────────────────────────────────────────────────────
// 第0层：项目总览
// ─────────────────────────────────────────────────────────────

/** 读项目元证据：package.json name/description + README 头部（截断）。 */
function readProjectEvidence(projectDir: string): { pkg?: string; readme?: string } {
  const out: { pkg?: string; readme?: string } = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
    out.pkg = [pkg.name ? `name=${pkg.name}` : '', pkg.description ? `description=${pkg.description}` : '']
      .filter(Boolean)
      .join('; ');
  } catch {
    // 无 package.json（Go 项目等）：跳过
  }
  for (const name of ['README.md', 'README-zh.md', 'readme.md']) {
    try {
      const txt = fs.readFileSync(path.join(projectDir, name), 'utf-8');
      // 去掉 markdown 标记噪音，只留头 700 字
      out.readme = txt.replace(/[#>*`|\[\]]/g, ' ').replace(/\s{2,}/g, ' ').slice(0, 700);
      break;
    } catch {
      // 试下一个
    }
  }
  return out;
}

/** 总览降级：项目名=目录名，desc=事实句，features=积木 id + 簇人话聚合（有 LLM 簇翻译时也够用）。 */
function fallbackOverview(r: BrickifyResult): ProjectOverview {
  const name = path.basename(r.meta.project_dir);
  const features = r.bricks.map((b) => ({
    target: b.id,
    label: b.id,
    desc: `${b.total} 个文件${b.community ? `（社区 ${b.community}）` : ''}`,
  }));
  return {
    title: name,
    desc: `本项目共 ${r.meta.scanned_files} 个源文件，聚成 ${r.bricks.length} 块积木（功能模块）、${r.communities.length} 个功能社区。项目一句话定位待 LLM 翻译（--narrate）。`,
    features,
    mode: 'rule',
  };
}

/** LLM 总览：证据=package.json/README + 积木人话清单 → 项目定位 + 与积木一一对应的功能清单。 */
async function narrateOverview(
  cfg: { apiKey: string; model: string; baseURL: string },
  r: BrickifyResult,
  projectDir: string,
  partial: ClusterNarratives,
): Promise<ProjectOverview | null> {
  const ev = readProjectEvidence(projectDir);
  const brickList = r.bricks
    .map((b) => {
      const subs = b.sub_clusters
        .map((s) => ({ id: s.id, title: partial.clusters[s.id]?.title }))
        .filter((x) => !!x.title && x.title !== x.id)
        .slice(0, 5)
        .map((x) => x.title as string)
        .join('、');
      return `- ${b.id}（${b.total} 文件${subs ? `，内部功能：${subs}` : ''}）`;
    })
    .join('\n');

  const system =
    '你是项目解读官。给定项目元信息和它的"积木"（功能模块）清单，请产出项目总览：\n' +
    '- title：这个项目本身是什么，≤16 个汉字（如"人机共享的可视化设计工具"），不要出现"项目"二字；\n' +
    '- desc：2-3 句话讲清项目是什么、核心价值（给完全不懂代码的人听）；\n' +
    '- features：功能清单，与给定积木**一一对应**（每块积木恰好一条：target=积木id，label=≤10字功能名，desc=一句话它给项目提供什么）；\n' +
    '不得编造积木清单之外的功能；features 条数必须等于积木数。\n' +
    '只输出 JSON：{"title":"...","desc":"...","features":[{"target":"...","label":"...","desc":"..."}]}';

  const user =
    `项目目录=${path.basename(r.meta.project_dir)}\n` +
    (ev.pkg ? `package.json：${ev.pkg}\n` : '') +
    (ev.readme ? `README 摘要：${ev.readme}\n` : '') +
    `积木清单（${r.bricks.length} 块，功能与人话已初步译出）：\n${brickList}`;

  const raw = await callChat(cfg, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
    title?: string;
    desc?: string;
    features?: Array<{ target?: string; label?: string; desc?: string }>;
  };
  if (!parsed.title) return null;
  const known = new Set(r.bricks.map((b) => b.id));
  const features = (parsed.features ?? [])
    .filter((f) => f.target && known.has(f.target))
    .map((f) => ({
      target: f.target as string,
      label: (f.label ?? f.target as string).trim().slice(0, 16),
      desc: (f.desc ?? '').trim().slice(0, 120),
    }));
  // 一一对应兜底：LLM 漏的积木用积木级/簇级人话补齐
  const covered = new Set(features.map((f) => f.target));
  for (const b of r.bricks) {
    if (covered.has(b.id)) continue;
    features.push({
      target: b.id,
      label: partial.bricks[b.id]?.title?.slice(0, 16) ?? b.id,
      desc: partial.bricks[b.id]?.desc?.slice(0, 120) ?? `${b.total} 个文件`,
    });
  }
  return {
    title: parsed.title.trim().slice(0, 20),
    desc: (parsed.desc ?? '').trim().slice(0, 240),
    features: features.sort((a, b) => {
      const ia = r.bricks.findIndex((x) => x.id === a.target);
      const ib = r.bricks.findIndex((x) => x.id === b.target);
      return ia - ib;
    }),
    mode: 'llm',
  };
}
