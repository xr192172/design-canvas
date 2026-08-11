/**
 * dict_gen —— 伪维基词典的 LLM 生成与分类判断（路线图序号 12 的 LLM 后端）
 *
 * 复用 explain_gen 的 DeepSeek/Agnes 配置与三档文案口径，新增两个能力：
 *   1. classifyTerm：判断一个词是「通用概念（global）」还是「项目专有词（project）」
 *      —— 决定写入全局词典还是项目词典。
 *   2. generateDictEntry：为词生成三档解释（newbie/pm/senior），并建议别名。
 *
 * 失败策略：任何一步失败都抛错，由调用方决定是否回退到"未收录"提示，不阻塞前端。
 */

import path from 'node:path';
import { loadExplainConfig, type ExplainConfig } from './explain_gen.js';
import { extractJsonObject } from './explain_gen.js';

// ─────────────────────────────────────────────────────────────
// 分类判断
// ─────────────────────────────────────────────────────────────

export type DictClassResult = {
  /** global（通用概念）| project（项目专有）| unknown（无法判断） */
  kind: 'global' | 'project' | 'unknown';
  /** 规范化后的主词（去除前后空格等） */
  term: string;
  /** 可选的别名/近义词 */
  aliases?: string[];
  /** 判断理由（简短） */
  reason?: string;
};

/**
 * 让 LLM 判断待解释词属于通用概念还是项目专有词。
 * @param term      待解释词（用户选中）
 * @param projectHint 项目上下文片段（如项目根名/README 摘要），帮助 LLM 判断是否项目专有
 * @param cfg       LLM 配置
 */
export async function classifyTerm(
  term: string,
  projectHint: string,
  cfg: ExplainConfig,
): Promise<DictClassResult> {
  const system =
    '你是词典分类器。给定一个待解释的词，判断它属于「通用概念」还是「某项目的专有词」。' +
    '通用概念 = 跨语言/跨项目普遍成立的技术或通用术语（如 泛型/异步/缓存/依赖注入/算法/HTTP）。' +
    '项目专有词 = 只在这个项目里出现、外人不知道专指什么的词（特定函数名/类名/库名/业务术语/缩写）。' +
    '只输出 JSON：{"kind":"global"|"project"|"unknown","term":"规范写法","aliases":["..."],"reason":"..."}。' +
    '若无法判断，kind 用 "unknown"。不要输出其他内容。';

  const user = `待解释词：${term}\n项目上下文：${projectHint || '（无额外上下文）'}`;

  const res = await fetch(`${cfg.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
    }),
  });
  if (!res.ok) throw new Error(`词典分类 LLM 调用失败 ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content ?? '';
  const parsed = extractJsonObject(content);
  if (!parsed) throw new Error('词典分类 LLM 未返回有效 JSON');

  const kind = parsed.kind === 'global' || parsed.kind === 'project' ? parsed.kind : 'unknown';
  const aliases = Array.isArray(parsed.aliases)
    ? (parsed.aliases as unknown[]).filter((a) => typeof a === 'string').map((a) => String(a))
    : undefined;
  return {
    kind,
    term: (typeof parsed.term === 'string' && parsed.term.trim() ? parsed.term : term).trim(),
    aliases,
    reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
  };
}

// ─────────────────────────────────────────────────────────────
// 三档解释生成
// ─────────────────────────────────────────────────────────────

export interface DictGenerationResult {
  newbie: string;
  pm: string;
  senior: string;
  /** LLM 建议的别名（可选） */
  aliases?: string[];
}

/**
 * 为单个词生成三档解释（专用词典口径）。
 * 与 explain_gen 的 generateModuleNarrations 口径一致，但聚焦"术语词"而非"模块"。
 */
export async function generateDictEntry(
  term: string,
  cfg: ExplainConfig,
): Promise<DictGenerationResult> {
  const system =
    '你是伪维基词典词条小编剧。给定一个术语词，写出三档解释：' +
    '1. newbie：口语化、少术语，面向第一次接触的新人，讲清"这是什么、用来干嘛"；2-3 句。' +
    '2. pm：面向产品/管理者，讲"解决什么问题、业务价值在哪"，少写代码；2-3 句。' +
    '3. senior：面向资深开发，讲"内部怎么实现、关键机制/API"，保留技术术语；2-4 句。' +
    '三档解释都力求准确，不得编造事实；若不确定可写"通常指…"。' +
    '同时给出 1-3 个常见别名/近义词（可选）。' +
    '只输出 JSON：{"newbie":"...","pm":"...","senior":"...","aliases":["..."]}，不要输出其他内容。';

  const user = `术语：${term}`;

  const res = await fetch(`${cfg.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.4,
    }),
  });
  if (!res.ok) throw new Error(`词典生成 LLM 调用失败 ${res.status}：${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content ?? '';
  const parsed = extractJsonObject(content);
  if (!parsed) throw new Error('词典生成 LLM 未返回有效 JSON');

  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const out: DictGenerationResult = {
    newbie: str(parsed.newbie),
    pm: str(parsed.pm),
    senior: str(parsed.senior),
  };
  const rawAliases = Array.isArray(parsed.aliases)
    ? (parsed.aliases as unknown[]).filter((a) => typeof a === 'string').map((a) => String(a).trim()).filter(Boolean)
    : [];
  if (rawAliases.length > 0) out.aliases = rawAliases;

  if (!out.newbie && !out.pm && !out.senior) {
    throw new Error('词典生成 LLM 返回为空');
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 组合入口：分类 + 生成 + 注入
// ─────────────────────────────────────────────────────────────

import { saveGlobalEntry, saveProjectEntry, loadGlobalDict, loadProjectDict, type DictEntry } from './dictionary.js';

export interface IngestResult {
  term: string;
  kind: 'global' | 'project';
  entry: DictEntry;
  /** 写入后的对应词典词条数 */
  dictSize: number;
  /** 源词（用户选中的原始写法） */
  source: string;
}

/**
 * 一键闭环：分类判断 → 生成三档 → 写入对应词典。
 * @param source      用户选中的原始写法
 * @param projectRoot 项目根（决定项目词典路径）
 * @param projectHint 项目上下文（帮助分类）
 * @param opts.save   false=仅预览（分类+生成，不落库），默认 true=直接收录
 * @returns 注入结果；kind='unknown' 时默认归入 global 并标记 kind='global'。
 */
export async function ingestTerm(
  source: string,
  projectRoot: string,
  projectHint: string,
  opts: { save?: boolean } = {},
): Promise<IngestResult> {
  const cfg = loadExplainConfig();
  if (!cfg) throw new Error('未配置 LLM（DEEPSEEK_API_KEY 或 config.json explain 段），无法生成词典解释');

  // 1. 分类：通用 vs 项目专有
  let cls = await classifyTerm(source, projectHint, cfg);
  const kind = cls.kind === 'project' ? 'project' : 'global'; // unknown → 归入 global
  const term = cls.term || source.trim();

  // 2. 生成三档
  const gen = await generateDictEntry(term, cfg);

  const entry: DictEntry = {
    term,
    kind,
    newbie: gen.newbie,
    pm: gen.pm,
    senior: gen.senior,
    aliases: gen.aliases,
    generated_at: new Date().toISOString(),
  };

  // 3. 注入（预览模式不落库）
  let dictSize = kind === 'project'
    ? loadProjectDict(projectRoot).length
    : loadGlobalDict().length;
  if (opts.save !== false) {
    dictSize =
      kind === 'project'
        ? saveProjectEntry(projectRoot, entry)
        : saveGlobalEntry(entry);
  }

  return { term, kind, entry, dictSize, source };
}

/** 仅用于测试/冒烟：直接构造一个词条（不调 LLM） */
export function makeManualEntry(
  term: string,
  kind: 'global' | 'project',
  narrations: { newbie: string; pm: string; senior: string },
  projectRoot?: string,
): DictEntry {
  const entry: DictEntry = {
    term,
    kind,
    newbie: narrations.newbie,
    pm: narrations.pm,
    senior: narrations.senior,
    generated_at: new Date().toISOString(),
  };
  if (kind === 'project' && projectRoot) saveProjectEntry(projectRoot, entry);
  else saveGlobalEntry(entry);
  return entry;
}