/**
 * signal_review —— 混合文件信号的 LLM 复核阶段（解耦拆分的"采纳/驳回"判据）
 *
 * 前置：brickify 的 detectMixedFiles 只产出**信号级**候选取证（一文件多个无耦合概念簇），
 * 它依据"引用相通=同簇"的静态依赖，**不判断"这是不是一个功能"**——会产生两类误判：
 *   - 工具函数簇（如 npm_mod 的 parseNpmDeps/resolveNpmThirdParty/... 同服务"依赖归并"）
 *     被当成多个"功能"，实际该**留同一契约**，拆开 = 制造碎片；
 *   - 新旧世代并存（如 dsl/animation 的"旧版阶段快照" vs "V2 数据流"），旧代已标记
 *     deprecated，才真正该拆成两个独立演进的积木。
 *
 * 本阶段把每个信号的文件**全文 + 概念簇声明清单**喂给 LLM，让它看**内容语义 + 文档/注释**
 * 逐簇判定【采纳（=值得独立成积木）/ 驳回（=该留原契约）】，判据只认三件只有语义能回答的事：
 *   ① 独立使用者：拆出来后，有没有模块**只**消费这一块（而不是整套）？
 *   ② 独立演进：两簇是否处于不同生命周期（一套废弃、一套新生）？
 *   ③ 文档证据：文件头/声明注释是否**明言**了这种分歧（如"旧版向后兼容"）？
 *
 * 能力边界（decline rather than guess）：
 *   - 判定是"该不该拆成积木"，**不做文件内符号的自动切分**；采纳后如何拆由人/下一步确认。
 *   - LLM 不可用（无 apiKey）→ 返回 null，调用方走规则降级（维持 brickify 原始信号）。
 *   - 超大文件全文截断到 MAX_SRC_CHARS，保证 prompt 可控；截断会在 evidence 里注明。
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadLlmConfig, callChat, type ChatMessage } from './llm_focus.js';
import { extractJsonObject } from './explain_gen.js';
import type { MixedFileSignal } from './brickify.js';

/** 单簇复核结论 */
export interface ClusterReview {
  /** LLM 概括的簇功能名（人话，非声明名拼接） */
  cluster: string;
  /** 该簇是否值得独立成积木 */
  adopt: boolean;
  /** 拆出后建议的积木/功能名（adopt=true 时有值） */
  feature: string;
  /** 一句话理由 */
  reason: string;
  /** 文档/注释证据（引用文件头或声明注释里的原句） */
  evidence: string;
}

/** 单文件复核结论 */
export interface SignalReview {
  file: string;
  /** 是否命中至少一个"采纳"（需要拆） */
  actionable: boolean;
  reviews: ClusterReview[];
  note?: string;
}

export interface ReviewOptions {
  project_dir: string;
  source_root?: string;
  signals: MixedFileSignal[];
  /** 单文件源码注入上限（字符数），超过截断 */
  max_source_chars?: number;
  /** 单次 LLM 调用的超时毫秒数（默认 120_000；大文件/慢端点可调大） */
  timeout_ms?: number;
  /** 只复核这些文件（相对 source_root 路径）；缺省复核全部 */
  only?: string[];
}

export interface ReviewResult {
  reviews: SignalReview[];
  meta: {
    total_signals: number;
    actionable: number;
    rejected: number;
    llm_available: boolean;
  };
  limitations: string[];
}

/** 读文件相对 source_root 的源码；失败返回 null（尽力而为） */
function readRel(sourceRoot: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(sourceRoot, ...rel.split('/')), 'utf-8');
  } catch {
    return null;
  }
}

const DEFAULT_MAX_SRC = 12_000;

/** 复核单个混合文件信号 → SignalReview（不含 sourceRoot/maxSrc 读取，因各文件独立，但读取依赖上下文，直接内联） */
async function reviewOne(
  cfg: Parameters<typeof callChat>[0],
  opts: ReviewOptions,
  sourceRoot: string,
  maxSrc: number,
  signal: MixedFileSignal,
): Promise<SignalReview> {
  let src = readRel(sourceRoot, signal.file) ?? '';
  let truncated = false;
  if (src.length > maxSrc) {
    src = src.slice(0, maxSrc);
    truncated = true;
  }
  if (!src.trim()) {
    return { file: signal.file, actionable: false, reviews: [], note: '文件读不到/为空，跳过（保留原始信号）' };
  }

  const sys =
    '你是软件架构"解耦评审官"，判断一个文件是否该被拆成多块独立的积木（功能单元）。' +
    '一份"解耦信号"说某文件含多个互相不直接耦合的概念簇，疑似一文件多功能。' +
    '你的任务：对**每个概念簇**判定它是否**值得独立成积木**。判断只看三件事(满足才算采纳)：\n' +
    '① 独立使用者：拆出来后，是否有模块只消费这一块、而不需要同一文件里的其他块？\n' +
    '② 独立演进：两块是否处于不同生命周期（如一套已废弃、另一套是当前主力）？\n' +
    '③ 文档证据：文件头部或声明注释里是否明言了这种分歧（如"旧版向后兼容""保留旧版"）？\n' +
    '注意：\n' +
    '- 工具函数集(helper 簇)，哪怕是不同纯函数、互不 import，只要同服务于一个用途、被整套一起使用，就判"驳回"（拆开=碎片）。\n' +
    '- 只有确实存在独立使用者/独立演进/文档佐证的多功能，才判"采纳"。\n' +
    '只输出紧凑 JSON：{"reviews":[{"cluster":"<簇的人话功能名>","adopt":<true|false>,"feature":"<拆出积木名，驳回留空>","reason":"一句话理由","evidence":"文档/注释里的原句证据或说明无"}]}，簇数量与输入一致。';

  const clusterLines = signal.clusters.map((c, i) => `簇${i + 1}：${c.join(', ')}`).join('\n');
  const srcBlock = `\n===== 文件源码${truncated ? '\u0060（仅前 ' + maxSrc + ' 字符，超标截断）\u0060' : '\u0060'} =====\n${src}`;
  const user = `项目：${path.basename(opts.project_dir)}\n文件：${signal.file}\n\n解耦信号检测到的概念簇：\n${clusterLines}\n${srcBlock}`;
  const messages: ChatMessage[] = [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];

  // 冷启动兜底：端点首发常达 30s+，随后热缓存秒回；失败/结构不符各重试一次命中热缓存
  let list: unknown = null;
  let last = '未知错误';
  const timeoutMs = opts.timeout_ms ?? 120_000;
  for (let attempt = 0; attempt < 2 && !Array.isArray(list); attempt++) {
    try {
      const text = await callChat(cfg, messages, 0.2, timeoutMs);
      const parsed = extractJsonObject(text);
      const l = parsed?.reviews;
      if (Array.isArray(l)) {
        list = l;
        break;
      }
      last = 'LLM 返回结构不符';
    } catch (e) {
      last = String((e as Error)?.message ?? e).slice(0, 120);
    }
  }
  if (!Array.isArray(list) || list.length !== signal.clusters.length) {
    return {
      file: signal.file,
      actionable: false,
      reviews: [],
      note: `LLM 复核失败已重试仍不通过（${last}），保留原始信号`,
    };
  }
  const clusterReviews: ClusterReview[] = list.map((r) => ({
    cluster: String((r as any).cluster ?? ''),
    adopt: Boolean((r as any).adopt),
    feature: String((r as any).feature ?? ''),
    reason: String((r as any).reason ?? ''),
    evidence: String((r as any).evidence ?? ''),
  }));
  return {
    file: signal.file,
    actionable: clusterReviews.some((r) => r.adopt),
    reviews: clusterReviews,
    note: truncated ? '源码经截断注入，判断基于文件头部' : undefined,
  };
}

/** 批量并发复核的批次大小：单批内 Promise.all（项目惯例，见 derive_mind_map 的 BATCH=12） */
const BATCH = 4;

/**
 * 复核全部混合文件信号：分批并发喂 LLM，产出每簇的采纳/驳回。LLM 不可用时返回 null。
 */
export async function reviewSignals(opts: ReviewOptions): Promise<ReviewResult | null> {
  const cfg = loadLlmConfig();
  if (!cfg) return null;
  const sourceRoot = path.resolve(opts.source_root ?? opts.project_dir);
  const maxSrc = opts.max_source_chars ?? DEFAULT_MAX_SRC;

  const reviews: SignalReview[] = [];
  let signals = opts.signals;
  if (opts.only?.length) {
    const onlySet = new Set(opts.only);
    signals = signals.filter((s) => onlySet.has(s.file));
  }
  for (let i = 0; i < signals.length; i += BATCH) {
    const chunk = signals.slice(i, i + BATCH);
    const results = await Promise.all(chunk.map((s) => reviewOne(cfg, opts, sourceRoot, maxSrc, s)));
    reviews.push(...results);
  }

  const actionable = reviews.filter((r) => r.actionable).length;
  return {
    reviews,
    meta: {
      total_signals: reviews.length,
      actionable,
      rejected: reviews.length - actionable,
      llm_available: true,
    },
    limitations: [
      '复核判据 = 独立使用者 / 独立演进 / 文档证据；不自动切分文件内部，采纳后拆法由人确认',
      '判定采用 LLM 语义理解，依赖注释/文档质量；注释含糊时可能误判',
      '单文件源码注入上限 ' + maxSrc + ' 字符，超长只按头部判断',
      'LLM 不可用或无 apiKey 时整体返回 null，调用方按原信号降级',
    ],
  };
}