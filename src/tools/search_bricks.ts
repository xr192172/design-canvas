/**
 * search_bricks —— 积木货架（Brick Harvest Phase 4：跨项目统一检索层）
 *
 * 积木盒 `.design-canvas/bricks/` 是跨项目资产（各积木来自不同源项目），
 * 本工具是盒的统一浏览/检索入口——"拎之前先看它要什么、给什么"：
 *
 *   浏览：无参数列出全部积木概况（语言/来源/规模/exposes/effects/验证状态）
 *   检索：query 关键词打分（积木名 > 形状名 > 字段名 > 人话介绍）
 *   过滤：language / verified（有 camera 运行证据）/ has_invariants / zero_third_party
 *   详情：name 精确命中（或 detail=true）→ 完整契约（fields/effects/invariants/闭包/验证档案）
 *
 * 数据源是 manifest.json（自包含快照档案），不碰项目 cache.db——积木盒
 * 的统一命名空间就是盒本身，无需联邦检索（Phase 4 "统一索引"决策：
 * 已入盒积木走本工具；未入盒代码的跨项目挖掘另走 harvest_from_url dry-run）。
 *
 * 语言推断：closure.internal 文件扩展名投票（manifest 无显式 language 字段，
 * 快照文件本身就是事实源——.go → go / .ts/.tsx → typescript / .py → python）。
 *
 * LLM 不产生事实：本工具只读档案做机械检索排序；description（人话介绍）
 * 是 LLM 生成后人工确认的重抽保留字段，标注"未经人工确认"时不作为
 * 置信依据——排序权重低于形状名/字段名。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { BrickManifest, ShapeSchema } from '../dsl/contract.js';

export interface SearchBricksInput {
  /** 关键词检索：匹配积木名/形状名/字段名/description，多词独立打分求和 */
  query?: string;
  /** 语言过滤（从闭包文件扩展名推断） */
  language?: 'go' | 'typescript' | 'python' | 'javascript';
  /** 只看有 camera 运行验证的（effect_verification 档案存在） */
  verified?: boolean;
  /** 只看有数学不变量的（acceptance.invariants 存在且非空） */
  has_invariants?: boolean;
  /** 只看零三方依赖的（closure.external 无 third_party——拎走即跑） */
  zero_third_party?: boolean;
  /** 精确积木名 → 详情模式（完整契约输出） */
  name?: string;
  /** query 命中时也输出完整契约（默认列表模式只给概况） */
  detail?: boolean;
  /** 积木盒根目录（默认 <cwd>/.design-canvas/bricks） */
  box_dir?: string;
}

export interface BrickShelfEntry {
  name: string;
  /** 闭包文件扩展名投票推断 */
  language: string;
  description?: string;
  brick_dir: string;
  /** 概况 */
  files: number;
  third_party: number;
  stdlib: number;
  unresolved: number;
  exposes: string[];
  consumes: string[];
  /** writes/holds 仅详情模式实算（manifest.aggregate 不带全量清单）；irreversible/emits 恒有 */
  effects: { writes?: number; holds?: number; emits: number; irreversible: number };
  /** 验证状态（缺省 = 未验证，检索时降权提示） */
  verified: boolean;
  verified_at?: string;
  confirmed_effects?: number;
  invariants?: number;
  /** invariant 来源分布（source-test/test-verified/llm-proposed 计数） */
  invariant_sources?: Record<string, number>;
  provenance: { source_project?: string; commit?: string; harvested_at?: string };
  /** query 检索得分（浏览模式无此字段） */
  score?: number;
  /** 命中明细（哪个词命中了什么） */
  matched?: string[];
}

export interface SearchBricksResult {
  box_dir: string;
  mode: 'browse' | 'search' | 'detail';
  total_bricks: number;
  entries: BrickShelfEntry[];
  message: string;
  /** 详情模式：按文件的 effects 全清单（contracts.json 聚合） */
  effects_detail?: Record<string, unknown>;
  /** 详情模式：contracts.json 原文（完整形状/契约） */
  contracts?: unknown;
}

/** 闭包文件扩展名投票推断语言 */
function inferLanguage(manifest: BrickManifest): string {
  const votes = new Map<string, number>();
  for (const f of manifest.closure?.internal ?? []) {
    const ext = path.extname(f).toLowerCase();
    const lang =
      ext === '.go'
        ? 'go'
        : ext === '.ts' || ext === '.tsx'
          ? 'typescript'
          : ext === '.py'
            ? 'python'
            : ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs'
              ? 'javascript'
              : '';
    if (lang) votes.set(lang, (votes.get(lang) ?? 0) + 1);
  }
  let best = '';
  let bestN = 0;
  for (const [lang, n] of votes) {
    if (n > bestN) {
      best = lang;
      bestN = n;
    }
  }
  return best || 'unknown';
}

/** 单词对单积木打分（返回 {score, matched}；0 = 不命中） */
function scoreBrick(word: string, manifest: BrickManifest): { score: number; matched: string[] } {
  const w = word.toLowerCase();
  const matched: string[] = [];
  let score = 0;

  if (manifest.name.toLowerCase().includes(w)) {
    score += manifest.name.toLowerCase() === w ? 100 : 60;
    matched.push(`name:${manifest.name}`);
  }
  const shapes = [...(manifest.aggregate?.exposes ?? []), ...(manifest.aggregate?.consumes ?? [])];
  for (const s of shapes) {
    if (s.name.toLowerCase().includes(w)) {
      score += s.name.toLowerCase() === w ? 50 : 30;
      matched.push(`shape:${s.name}`);
      // 形状名命中后不再对该形状字段重复计分（一个词一条主线）
      continue;
    }
    for (const f of s.fields ?? []) {
      if (f.name.toLowerCase().includes(w)) {
        score += 20;
        matched.push(`field:${s.name}.${f.name}`);
      }
    }
  }
  for (const e of manifest.aggregate?.emits ?? []) {
    if (e.toLowerCase().includes(w)) {
      score += 20;
      matched.push(`emit:${e}`);
    }
  }
  for (const c of manifest.aggregate?.reads_config ?? []) {
    if (c.toLowerCase().includes(w)) {
      score += 20;
      matched.push(`config:${c}`);
    }
  }
  if (manifest.description?.toLowerCase().includes(w)) {
    score += 15;
    matched.push('description');
  }
  return { score, matched };
}

function buildEntry(
  manifest: BrickManifest,
  brickDir: string,
  language: string,
  score?: number,
  matched?: string[],
): BrickShelfEntry {
  const external = manifest.closure?.external ?? [];
  const invariants = manifest.acceptance?.invariants ?? [];
  const invariantSources: Record<string, number> = {};
  for (const inv of invariants) {
    invariantSources[inv.source] = (invariantSources[inv.source] ?? 0) + 1;
  }
  return {
    name: manifest.name,
    language,
    description: manifest.description,
    brick_dir: brickDir,
    files: manifest.closure?.internal?.length ?? 0,
    third_party: external.filter((e) => e.class === 'third_party').length,
    stdlib: external.filter((e) => e.class === 'stdlib').length,
    unresolved: external.filter((e) => e.class === 'unresolved').length,
    exposes: (manifest.aggregate?.exposes ?? []).map((s: ShapeSchema) => s.name),
    consumes: (manifest.aggregate?.consumes ?? []).map((s: ShapeSchema) => s.name),
    effects: {
      emits: manifest.aggregate?.emits?.length ?? 0,
      irreversible: manifest.aggregate?.irreversible_effects ?? 0,
    },
    verified: Boolean(manifest.effect_verification),
    verified_at: manifest.effect_verification?.verified_at,
    confirmed_effects: manifest.effect_verification?.stats?.confirmed,
    invariants: invariants.length || undefined,
    invariant_sources: invariants.length > 0 ? invariantSources : undefined,
    provenance: {
      source_project: manifest.provenance?.source_project,
      commit: manifest.provenance?.commit,
      harvested_at: manifest.provenance?.harvested_at,
    },
    ...(score !== undefined ? { score } : {}),
    ...(matched?.length ? { matched } : {}),
  };
}

export async function searchBricks(input: SearchBricksInput): Promise<SearchBricksResult> {
  const boxDir = path.resolve(input.box_dir ?? path.join(process.cwd(), '.design-canvas', 'bricks'));
  if (!fs.existsSync(boxDir)) {
    throw new Error(`积木盒不存在：${boxDir}（先 harvest_from_url 入盒）`);
  }

  // ── 读全盒 manifest ──
  const bricks: Array<{ manifest: BrickManifest; dir: string; language: string }> = [];
  for (const name of fs.readdirSync(boxDir).sort()) {
    const dir = path.join(boxDir, name);
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.statSync(dir).isDirectory() || !fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as BrickManifest;
      bricks.push({ manifest, dir, language: inferLanguage(manifest) });
    } catch {
      // 损坏 manifest 跳过（不阻断整盒检索）
    }
  }
  if (bricks.length === 0) {
    return {
      box_dir: boxDir,
      mode: 'browse',
      total_bricks: 0,
      entries: [],
      message: `积木盒为空或全部 manifest 损坏：${boxDir}`,
    };
  }

  // ── 过滤（三态：undefined 不过滤 / true 只看有 / false 只看无） ──
  let filtered = bricks;
  if (input.language) {
    filtered = filtered.filter((b) => b.language === input.language);
  }
  if (input.verified !== undefined) {
    filtered = filtered.filter((b) => Boolean(b.manifest.effect_verification) === input.verified);
  }
  if (input.has_invariants !== undefined) {
    filtered = filtered.filter(
      (b) => ((b.manifest.acceptance?.invariants?.length ?? 0) > 0) === input.has_invariants,
    );
  }
  if (input.zero_third_party !== undefined) {
    filtered = filtered.filter(
      (b) =>
        ((b.manifest.closure?.external ?? []).filter((e) => e.class === 'third_party').length === 0) ===
        input.zero_third_party,
    );
  }

  // ── 详情模式（name 精确） ──
  if (input.name) {
    const hit = bricks.find((b) => b.manifest.name === input.name);
    if (!hit) {
      throw new Error(
        `积木「${input.name}」不在盒中。现有：${bricks.map((b) => b.manifest.name).join('、')}`,
      );
    }
    // 详情 = 概况条目 + 完整契约（contracts.json 聚合全文）
    const entry = buildEntry(hit.manifest, hit.dir, hit.language);
    const contractsPath = path.join(hit.dir, 'contracts.json');
    let fullContracts: unknown = undefined;
    if (fs.existsSync(contractsPath)) {
      fullContracts = JSON.parse(fs.readFileSync(contractsPath, 'utf-8'));
    }
    // effects 计数从 contracts.json 实算（manifest.aggregate 无 holds/writes 全量）
    let effectsDetail: Record<string, unknown> | undefined;
    if (fullContracts && typeof fullContracts === 'object') {
      let writes = 0;
      let holds = 0;
      for (const c of Object.values(fullContracts as Record<string, { effects?: { writes?: unknown[]; holds?: unknown[] } }>)) {
        writes += c?.effects?.writes?.length ?? 0;
        holds += c?.effects?.holds?.length ?? 0;
      }
      entry.effects.writes = writes;
      entry.effects.holds = holds;
      effectsDetail = {};
      for (const [file, c] of Object.entries(fullContracts as Record<string, { effects?: unknown }>)) {
        effectsDetail[file] = c?.effects ?? {};
      }
    }
    return {
      box_dir: boxDir,
      mode: 'detail',
      total_bricks: bricks.length,
      entries: [entry],
      message:
        `积木「${input.name}」详情：${entry.files} 文件（${entry.language}）` +
        `，exposes ${entry.exposes.length} 形状，effects ${entry.effects.writes ?? '?'} writes/${entry.effects.holds ?? '?'} holds/${entry.effects.emits} emits` +
        `（不可逆 ${entry.effects.irreversible}）` +
        (entry.verified ? `，camera 已验证（转正 ${entry.confirmed_effects} 条）` : '，未做 camera 验证') +
        (entry.invariants ? `，不变量 ${entry.invariants} 条` : '') +
        `。盒内路径 ${hit.dir}`,
      ...(effectsDetail ? { effects_detail: effectsDetail } : {}),
      ...(fullContracts ? { contracts: fullContracts } : {}),
    };
  }

  // ── 检索 / 浏览 ──
  const words = (input.query ?? '')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
  const mode: 'search' | 'browse' = words.length > 0 ? 'search' : 'browse';

  let entries: BrickShelfEntry[];
  if (mode === 'search') {
    const scored: Array<{ b: (typeof bricks)[number]; score: number; matched: string[] }> = [];
    for (const b of filtered) {
      let total = 0;
      const matched: string[] = [];
      for (const w of words) {
        const { score, matched: m } = scoreBrick(w, b.manifest);
        total += score;
        matched.push(...m);
      }
      if (total > 0) scored.push({ b, score: total, matched });
    }
    scored.sort((a, b) => b.score - a.score || a.b.manifest.name.localeCompare(b.b.manifest.name));
    entries = scored.map(({ b, score, matched }) => buildEntry(b.manifest, b.dir, b.language, score, matched));
  } else {
    entries = filtered.map((b) => buildEntry(b.manifest, b.dir, b.language));
  }

  const message =
    mode === 'search'
      ? `货架检索「${words.join(' ')}」：${entries.length}/${filtered.length} 积木命中` +
        (entries.length > 0 ? `，最高分 ${entries[0].name}（${entries[0].matched?.join('、')}）` : '') +
        '。用 name=<积木名> 看完整契约。'
      : `积木货架共 ${bricks.length} 块（当前过滤后 ${entries.length}）` +
        `：${entries.map((e) => `${e.name}(${e.language})`).join('、')}` +
        '。用 query 检索 / name 下钻 / verified=true 只看已验证。';

  return { box_dir: boxDir, mode, total_bricks: bricks.length, entries, message };
}
