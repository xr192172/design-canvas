/**
 * diagnose —— 诊断编排器（胶水层核心）
 *
 * 把六个积木块串成一条流水线：症状解析 → 候选定位 → 调用链追溯 →
 * 影响面分析 → 根因聚合（双引擎）→ 验证建议，产出完整的 DiagnoseOutput。
 * 这里是唯一知道"各步顺序"的地方；各积木块彼此不知道对方存在。
 */

import path from 'node:path';
import { getProjectCacheDb } from '../db/db.js';
import { parseSymptom } from './symptom_parser.js';
import { locateCandidates } from './candidate_locator.js';
import { traceChain } from './chain_tracer.js';
import { analyzeImpact } from './impact_analyzer.js';
import { aggregateRootCause } from './root_cause_aggregator.js';
import { suggestVerification } from './verifier.js';
import type { DiagnoseInput, DiagnoseOutput, Impact } from './contract.js';

const EMPTY_IMPACT: Impact = { affected_files: [], affected_symbols: [], dsl_contract_hits: [] };

export async function runDiagnosis(input: DiagnoseInput): Promise<DiagnoseOutput> {
  const { project_dir, symptom, symptom_type = 'auto', anchor, max_depth = 3, use_llm = true } = input;

  // 第 1 步：症状解析（纯正则，无副作用）
  const parsed = parseSymptom(symptom);

  // 打开符号缓存（缺省可建；失败则本轮无符号证据）
  let db;
  try {
    db = getProjectCacheDb(path.resolve(project_dir));
  } catch {
    db = undefined;
  }

  // 第 2 步：候选定位
  const loc = db ? locateCandidates(db, { project_dir, parsed, anchor }) : { candidates: [], warnings: ['无法打开符号缓存。'] };

  // 第 3 步：调用链追溯
  const chain = db
    ? traceChain(db, { project_dir, candidates: loc.candidates, max_depth })
    : { chain: [], reached: [], warnings: ['无法打开符号缓存。'] };

  // 第 4 步：影响面分析（以最高分候选文件为变更源）
  const impact =
    loc.candidates.length > 0
      ? analyzeImpact({ project_dir, root_file: loc.candidates[0].file_path, max_depth })
      : EMPTY_IMPACT;

  // 第 5 步：根因聚合（规则引擎先跑，LLM 可选增强；use_llm=false 强制规则）
  const agg = await aggregateRootCause(
    {
      project_dir,
      parsed,
      candidates: loc.candidates,
      evidence_chain: chain.chain,
      reached: chain.reached,
      impact,
      db,
    },
    { skipLlm: !use_llm },
  );

  // 第 6 步：验证建议
  const verification = suggestVerification({
    project_dir,
    symptom_type: symptom_type === 'auto' ? undefined : symptom_type,
    root_cause: agg.root_cause,
    impact,
  });

  const limitations = [...new Set([...loc.warnings, ...chain.warnings, ...agg.limitations])];

  return {
    summary: buildSummary(parsed.error_type, agg.engine, agg.root_cause, impact),
    engine: agg.engine,
    symptom_parsed: parsed,
    candidates: loc.candidates,
    root_cause: agg.root_cause,
    evidence_chain: chain.chain,
    impact,
    fix_suggestions: agg.fix_suggestions,
    verification,
    limitations,
  };
}

function buildSummary(
  errorType: string | undefined,
  engine: DiagnoseOutput['engine'],
  rootCause: DiagnoseOutput['root_cause'],
  impact: Impact,
): string {
  const base = errorType ? `症状「${errorType}」` : '症状';
  if (!rootCause) return `${base}：未定位到根因（证据不足）。`;
  const kind = rootCause.kind;
  return `${base} → 根因疑似在 ${rootCause.symbol}（${rootCause.file_path}:${rootCause.line}，kind=${kind}，置信度 ${rootCause.confidence}）；波及 ${impact.affected_files.length} 个文件。引擎：${engine}。`;
}

// ─────────────────────────────────────────────────────────────
// 可读文本报告（CLI 与 MCP 文本输出共用）
// ─────────────────────────────────────────────────────────────

export function formatDiagnoseText(out: DiagnoseOutput): string {
  const L: string[] = [];
  L.push('=== diagnose 诊断报告 ===');
  L.push(`引擎: ${out.engine}${out.root_cause?.source_snippet ? '（含 LLM 解读）' : ''}`);
  L.push(`症状: ${out.symptom_parsed.error_type ? `[${out.symptom_parsed.error_type}] ` : ''}${out.symptom_parsed.locations.map((l) => `${l.file}${l.line ? `:${l.line}` : ''}`).join('、') || '（无位置）'}`);
  L.push('');

  L.push(`【根因】${out.root_cause ? `${out.root_cause.symbol} @ ${out.root_cause.file_path}:${out.root_cause.line}（kind=${out.root_cause.kind}，置信度 ${out.root_cause.confidence}）` : '未定位（见局限）'}`);
  if (out.root_cause?.reasoning) {
    L.push(`  reasoning: ${out.root_cause.reasoning}`);
  }
  if (out.root_cause?.source_snippet) {
    L.push(`  —— 源码片段（${out.root_cause.file_path} 附近） ——`);
    for (const line of out.root_cause.source_snippet.split('\n')) L.push(`    ${line}`);
  }
  L.push('');

  L.push(`【证据链】（${out.evidence_chain.length} 步）`);
  for (const s of out.evidence_chain) L.push(`  ${s.step}. [${s.type}] ${s.text}`);
  L.push('');

  L.push(`【候选】（${out.candidates.length}）`);
  for (const c of out.candidates.slice(0, 8)) {
    L.push(`  - ${c.symbol} @ ${c.file_path}:${c.start_line}（${c.source}，score ${c.score}）`);
  }
  L.push('');

  L.push(`【影响面】波及文件 ${out.impact.affected_files.length} / 符号 ${out.impact.affected_symbols.length}`);
  for (const f of out.impact.affected_files.slice(0, 8)) {
    L.push(`  - ${f.path}（depth ${f.depth}${f.direct ? '，direct' : ''}）`);
  }
  if (out.impact.dsl_contract_hits.length > 0) {
    L.push('  ⚠ DSL 契约命中（设计契约被波及，优先复核）:');
    for (const h of out.impact.dsl_contract_hits.slice(0, 5)) L.push(`    - ${h}`);
  }
  L.push('');

  L.push('【修复建议】');
  for (const s of out.fix_suggestions) {
    L.push(`  - [${s.action}] ${s.target_file}${s.target_line ? `:${s.target_line}` : ''}: ${s.description}`);
    L.push(`    （${s.rationale}）`);
  }
  L.push('');

  L.push('【验证建议】（只给建议，不自动执行）');
  for (const v of out.verification) {
    L.push(`  - [${v.type}] ${v.command_hint}`);
  }
  L.push('');

  L.push('【局限】');
  if (out.limitations.length === 0) L.push('  无');
  for (const w of out.limitations) L.push(`  ⚠ ${w}`);
  return L.join('\n');
}
