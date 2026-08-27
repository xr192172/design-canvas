/**
 * root_cause_aggregator —— 根因聚合（诊断流水线第 5 步，双引擎）
 *
 * 规则引擎永远先跑（纯代码，确定性）：从候选里挑最可疑符号，按
 * 报错位置/调用链/影响面加成打分，产出根因 + 修改建议 + 局限。
 * LLM 引擎可选：把"症状 + 确定性证据 + 源码片段（限长）"喂给 LLM，
 * 让它把证据翻成人话根因与更贴合项目的修复建议；未配置/调用失败自动
 * 降级回规则引擎（engine 如实标注）。
 *
 * 安全边界：LLM 只负责"解释与建议"，根因的 file/line/symbol 一律以
 * 规则引擎定位为准，防止 LLM 编造证据。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Database } from '../db/db.js';
import { loadLlmConfig, callChat, type LlmConfig } from '../tools/llm_focus.js';
import type {
  Candidate,
  EvidenceStep,
  FixSuggestion,
  Impact,
  RootCause,
  SymptomParsed,
} from './contract.js';

export interface AggregateInput {
  project_dir: string;
  parsed: SymptomParsed;
  candidates: Candidate[];
  evidence_chain: EvidenceStep[];
  /** chain_tracer 追溯到的最可疑符号 id（"<file>#<qn>"） */
  reached: string[];
  impact: Impact;
  /** 可选：用于查符号 span 与调用边，精准定 kind/抓源码 */
  db?: Database;
}

export interface AggregateResult {
  root_cause?: RootCause;
  fix_suggestions: FixSuggestion[];
  limitations: string[];
  engine: 'rule' | 'hybrid';
  llm_note?: string;
}

// ─────────────────────────────────────────────────────────────
// 源码片段抓取（限长，喂 LLM / 展示用）
// ─────────────────────────────────────────────────────────────

export interface CaptureOpts {
  /** 符号 start_line 上方带几行上下文（1-based 行号），默认 1 */
  before?: number;
  /** 符号 end_line 下方带几行上下文，默认 2 */
  after?: number;
  /** 最多抓多少行，默认 30 */
  maxLines?: number;
  /** 最多多少字符（含行号前缀），默认 1200 */
  maxChars?: number;
}

/** 抓取指定符号附近的源码片段；文件缺失/行号越界返回 undefined */
export function captureSnippet(absFile: string, startLine: number, endLine?: number, opts: CaptureOpts = {}): string | undefined {
  const { before = 1, after = 2, maxLines = 30, maxChars = 1200 } = opts;
  let lines: string[];
  try {
    lines = fs.readFileSync(absFile, 'utf-8').split(/\r?\n/);
  } catch {
    return undefined;
  }
  if (lines.length === 0) return undefined;
  const s = Math.max(1, startLine - before);
  const e = Math.min(lines.length, (endLine ?? startLine) + after);
  const slice = lines.slice(s - 1, e);
  if (slice.length > maxLines) {
    slice.length = maxLines;
  }
  const width = String(e).length;
  const numbered = slice.map((l, i) => `${String(s + i).padStart(width, ' ')}| ${l}`);
  let out = numbered.join('\n');
  if (out.length > maxChars) {
    // 保头舍尾：截断到 maxChars 前最后一个换行
    out = out.slice(0, maxChars);
    const nl = out.lastIndexOf('\n');
    if (nl > 0) out = out.slice(0, nl);
    out += '\n…（已截断）';
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 规则引擎
// ─────────────────────────────────────────────────────────────

interface Scored {
  candidate: Candidate;
  score: number;
  id: string;
  span: { start_line: number; end_line: number } | undefined;
  reasons: string[];
}

const clamp = (v: number): number => Math.min(1, Math.max(0, v));

function toRel(root: string, p: string): string {
  return path.isAbsolute(p) ? path.relative(root, p).split(path.sep).join('/') : p.replace(/\\/g, '/');
}

/** 从候选打分，选最可疑符号 + 判定 kind */
function pickRoot(db: Database | undefined, input: AggregateInput): { root?: RootCause; scored: Scored[] } {
  const { project_dir, parsed, candidates, reached, impact } = input;
  const root = path.resolve(project_dir);
  const located = parsed.locations[0];
  const locatedRel = located ? toRel(root, located.file) : undefined;

  const scored: Scored[] = candidates.map((c) => {
    const id = `${c.file_path}#${c.qualified_name}`;
    const span = db
      ? (db.prepare('SELECT start_line, end_line FROM nodes WHERE id = ?').get(id) as
          | { start_line: number; end_line: number }
          | undefined)
      : undefined;
    const reasons: string[] = [];
    let score = c.score;
    const fileRel = toRel(root, c.file_path);
    if (locatedRel && fileRel === locatedRel) {
      score += 0.2;
      reasons.push('报错位置文件命中');
      if (span && located.line && located.line >= span.start_line && located.line <= span.end_line) {
        score += 0.1;
        reasons.push('行号落在符号 span 内');
      }
    }
    if (reached.includes(id)) {
      score += 0.15;
      reasons.push('在证据链上');
    }
    const selfImpact = impact.affected_files.find((f) => toRel(root, f.path) === fileRel);
    if (selfImpact?.direct) {
      score += 0.05;
      reasons.push('作为变更源直接受影响');
    }
    return { candidate: c, score: clamp(score), id, span, reasons };
  });

  scored.sort((a, b) => b.score - a.score || a.candidate.start_line - b.candidate.start_line);
  if (scored.length === 0 || scored[0].score <= 0) return { scored };

  const top = scored[0];
  const { candidate: c, span } = top;
  const fileRel = toRel(root, c.file_path);

  // kind 判定
  let kind: RootCause['kind'] = 'inferred';
  if (locatedRel && fileRel === locatedRel && span && located.line && located.line >= span.start_line && located.line <= span.end_line) {
    kind = 'error_direct';
  } else if (locatedRel && fileRel !== locatedRel) {
    kind = 'caller';
  } else if (db) {
    // 候选调用了链上的其它符号 → 真凶可能在被调方
    const topId = `${top.candidate.file_path}#${top.candidate.qualified_name}`;
    const callees = (db
      .prepare("SELECT target FROM edges WHERE source = ? AND kind = 'call'")
      .all(topId) as Array<{ target: string }>)
      .map((e) => e.target);
    if (callees.some((t) => reached.includes(t))) kind = 'callee';
    else if (reached.some((r) => r.startsWith(`${top.candidate.file_path}#`) && r !== topId)) kind = 'callee';
  }

  const kindText: Record<RootCause['kind'], string> = {
    error_direct: '报错行直接命中该符号',
    caller: '该符号的调用方在报错位置，症状自此处向上传播',
    callee: '该符号依赖的被调方在证据链上，真凶可能在被调方',
    type_ref: '经类型引用关联，改动类型会影响此处',
    inferred: '无可定位证据，属推断',
  };

  const rootCause: RootCause = {
    file_path: fileRel,
    line: located && fileRel === locatedRel ? located.line : span?.start_line ?? c.start_line,
    symbol: c.symbol,
    kind,
    confidence: Math.round(top.score * 100) / 100,
    reasoning: [
      `症状类型「${parsed.error_type ?? '未识别'}」，报错位置 ${locatedRel ? `${locatedRel}${located.line ? `:${located.line}` : ''}` : '（无）'}`,
      `候选符号 ${c.symbol}（${fileRel}:${c.start_line}，${c.source} 命中，相关度 ${c.score}）${top.reasons.length ? `；加分：${top.reasons.join('、')}` : ''}`,
      kindText[kind],
    ].join('。'),
  };

  return { root: rootCause, scored };
}

/** 规则引擎：根因 + 修改建议 + 局限（纯同步、无 LLM） */
export function aggregateRule(input: AggregateInput): AggregateResult {
  const { project_dir, candidates, parsed, evidence_chain, impact } = input;
  const root = path.resolve(project_dir);
  const limitations: string[] = [];

  const { root: rootCause, scored } = pickRoot(input.db, input);
  if (!rootCause) {
    limitations.push('无足够证据定位根因（候选为空或分数过低）。请检查项目是否已运行 import_project 建立符号缓存。');
    return {
      root_cause: undefined,
      fix_suggestions: [
        {
          target_file: '',
          action: 'inspect',
          description: '先用原生搜索/打断点定位报错符号，再运行诊断工具重试',
          rationale: '证据不足，需要人工线索（anchor）聚焦',
        },
      ],
      limitations,
      engine: 'rule',
    };
  }

  const fix_suggestions: FixSuggestion[] = [
    {
      target_file: rootCause.file_path,
      target_line: rootCause.line,
      action: 'modify',
      description: `检查并修复 ${rootCause.symbol} 在 ${rootCause.file_path}${rootCause.line ? `:${rootCause.line}` : ''} 的实现（${rootCause.kind}）`,
      rationale: `命中证据链的疑点位置（置信度 ${rootCause.confidence}）`,
    },
    {
      target_file: rootCause.file_path,
      target_line: rootCause.line,
      action: 'inspect',
      description: `在 ${rootCause.file_path}:${rootCause.line} 打断点/加日志，确认 ${rootCause.symbol} 的入参与返回值是否符合预期`,
      rationale: '动手改前先坐实证据，避免误修',
    },
  ];

  const indirect = impact.affected_files.filter((f) => !f.direct && f.path !== rootCause.file_path);
  if (indirect.length > 0) {
    const names = indirect.slice(0, 5).map((f) => f.path).join('、');
    fix_suggestions.push({
      target_file: indirect[0].path,
      action: 'verify',
      description: `修改将波及 ${impact.affected_files.length - 1} 个上层文件（${names}${indirect.length > 5 ? ' 等' : ''}），修复后需回归验证`,
      rationale: '影响面提示：上游调用方会受此改动影响',
    });
  } else {
    fix_suggestions.push({
      target_file: rootCause.file_path,
      action: 'verify',
      description: '修改后运行项目对应测试/构建验证（见 verification 建议）',
      rationale: '根因修复后应闭环验证',
    });
  }

  if (candidates.length === 0) limitations.push('未建立符号缓存：症状解析得到的符号在缓存中无命中。请先运行 import_project。');
  if (evidence_chain.every((s) => s.type === 'rule' || s.type === 'symbol_hit'))
    limitations.push('证据链未能沿 call/type_ref/import 边展开，仅给出文件级线索（该符号可能孤立/仅锚点到文件，或缓存该部分不完整，而非缓存整体缺失）。');
  if (impact.affected_files.length === 1) limitations.push('影响面仅根因文件本身，未发现上层调用方——缓存可能不完整或该文件确实孤立。');

  return { root_cause: rootCause, fix_suggestions, limitations, engine: 'rule' };
}

// ─────────────────────────────────────────────────────────────
// LLM 引擎（可选，降级安全）
// ─────────────────────────────────────────────────────────────

interface LlmRootCauseJson {
  root_cause?: { file_path?: string; line?: number; symbol?: string; reasoning?: string; confidence?: number };
  fix_suggestions?: Array<{
    target_file?: string;
    target_line?: number;
    action?: FixSuggestion['action'];
    description?: string;
    rationale?: string;
  }>;
}

function buildPrompt(input: AggregateInput, rule: AggregateResult, snippet: string | undefined): string {
  const { project_dir, parsed, candidates, evidence_chain, impact } = input;
  const root = path.resolve(project_dir);
  const rc = rule.root_cause;

  const candLines = candidates
    .slice(0, 5)
    .map((c, i) => `${i + 1}. ${c.symbol} @ ${c.file_path}:${c.start_line}（${c.source}，相关度 ${c.score}，kind=${c.kind}）`)
    .join('\n');
  const chainLines = evidence_chain.slice(0, 20).map((s) => `  ${s.step}. [${s.type}] ${s.text}`).join('\n');
  const impactLines = [
    `受影响文件 ${impact.affected_files.length}：${impact.affected_files.slice(0, 8).map((f) => f.path).join('、')}${impact.affected_files.length > 8 ? '…' : ''}`,
    `受影响符号 ${impact.affected_symbols.length}`,
  ].join('\n');

  return [
    '【症状】',
    input.parsed.error_type ? `  类型：${input.parsed.error_type}` : '',
    `  原始：${input.parsed.keywords.join(' ')}`.trim(),
    `  位置：${parsed.locations.map((l) => `${l.file}${l.line ? `:${l.line}` : ''}`).join('、') || '（无）'}`,
    `  符号：${parsed.symbols.join('、') || '（无）'}`,
    '',
    '【规则引擎定位的根因（以此为准，勿改 file/line/symbol）】',
    rc ? `  ${rc.symbol} @ ${rc.file_path}:${rc.line}（kind=${rc.kind}，置信度 ${rc.confidence}）` : '  （无）',
    `  reasoning：${rc?.reasoning ?? '无'}`,
    '',
    '【源码片段（报错点附近）】',
    snippet ?? '（未能读取源码）',
    '',
    '【候选清单】',
    candLines || '（无）',
    '',
    '【证据链】',
    chainLines || '（空）',
    '',
    '【影响面】',
    impactLines,
  ].join('\n');
}

function parseLlmJson(raw: string): LlmRootCauseJson {
  try {
    return JSON.parse(raw) as LlmRootCauseJson;
  } catch {
    throw new Error(`LLM 返回非 JSON：${raw.slice(0, 120)}`);
  }
}

async function aggregateWithLlm(cfg: LlmConfig, input: AggregateInput, rule: AggregateResult): Promise<AggregateResult> {
  const rc = rule.root_cause;
  let snippet: string | undefined;
  if (rc) {
    snippet = captureSnippet(path.resolve(input.project_dir, rc.file_path), rc.line ?? 1);
  }

  const system =
    '你是资深后端工程师。基于给定的确定性证据（症状、候选、证据链、影响面、源码片段）回答项目根因。' +
    '规则：1) 根因的 file_path/line/symbol 必须与"规则引擎定位的根因"一致，不得编造或替换；' +
    '2) reasoning 用 2-3 句人话解释为什么是它；3) 给出 1-3 条具体修复建议；4) 只输出 JSON，' +
    '格式：{"root_cause":{"file_path":"","line":1,"symbol":"","reasoning":"","confidence":0.8},"fix_suggestions":[{"target_file":"","target_line":1,"action":"modify|add|remove|verify|inspect","description":"","rationale":""}]}';

  try {
    const raw = await callChat(cfg, [
      { role: 'system', content: system },
      { role: 'user', content: buildPrompt(input, rule, snippet) },
    ]);
    const j = parseLlmJson(raw);
    if (!rc || !j.root_cause || !j.root_cause.symbol) {
      throw new Error('LLM 未返回有效根因');
    }
    // 只采用 LLM 的 reasoning/confidence，file/line/symbol 以规则为准（防编造）
    const rootCause: RootCause = {
      ...rc,
      reasoning: j.root_cause.reasoning?.trim() || rc.reasoning,
      confidence: typeof j.root_cause.confidence === 'number' ? clamp(Math.round(j.root_cause.confidence * 100) / 100) : rc.confidence,
      source_snippet: snippet,
    };
    const suggestions: FixSuggestion[] = (j.fix_suggestions ?? [])
      // 建议的 target_file 必须是项目内真实存在的文件：LLM 只出建议，不许编造
      // 不存在的文件/路径（幻觉文件），证据与事实边界以磁盘为准
      .filter((s) => s.target_file && s.description && fs.existsSync(path.resolve(input.project_dir, s.target_file)))
      .slice(0, 3)
      .map((s) => ({
        target_file: s.target_file as string,
        target_line: s.target_line,
        action: (['modify', 'add', 'remove', 'verify', 'inspect'] as const).includes(s.action as FixSuggestion['action'])
          ? (s.action as FixSuggestion['action'])
          : 'modify',
        description: s.description as string,
        rationale: s.rationale ?? 'LLM 建议',
      }));
    return {
      root_cause: rootCause,
      fix_suggestions: suggestions.length > 0 ? suggestions : rule.fix_suggestions,
      limitations: rule.limitations,
      engine: 'hybrid',
    };
  } catch (e) {
    return {
      ...rule,
      root_cause: rc ? { ...rc, source_snippet: snippet } : undefined,
      limitations: [...rule.limitations, `LLM 兜底失败，已用规则引擎结论：${(e as Error).message}`],
    };
  }
}

/** 主入口：规则引擎先跑，LLM 可选增强，未配置/失败自动降级 */
export async function aggregateRootCause(input: AggregateInput, opts?: { skipLlm?: boolean }): Promise<AggregateResult> {
  const rule = aggregateRule(input);
  if (opts?.skipLlm) {
    return { ...rule, llm_note: '已按调用方要求只走规则引擎（use_llm=false）' };
  }
  const cfg = loadLlmConfig();
  if (!cfg) {
    return { ...rule, llm_note: '未配置 LLM（config.json 或 LLM_API_KEY），已用规则引擎结论' };
  }
  const res = await aggregateWithLlm(cfg, input, rule);
  return res.engine === 'hybrid' ? res : { ...res, llm_note: (res as AggregateResult & { llm_note?: string }).llm_note ?? 'LLM 调用失败，已用规则引擎结论' };
}
