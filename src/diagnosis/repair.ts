/**
 * repair —— 修复积木块（一键诊断闭环第 2 步）
 *
 * 职责：基于确定性证据（根因 + 源码片段 + 修复建议）生成行级补丁，
 * 安全应用与回退。延续 T4 的证据不编造原则：
 *   - 修改文件白名单：只允许改「根因文件 + fix_suggestions 的 target_file」，
 *     LLM 不得新增/改其他文件
 *   - old_text 不信任 LLM：应用时读取磁盘真实内容做区间替换，审批看的是
 *     磁盘真实 diff（LLM 编造的行号/内容会在 diff 展示与行号校验两层被拦下）
 *   - 行号越界 / 文件不存在 / 白名单外文件 → 拒绝应用
 *   - 应用前保存原始内容，revert 可逐文件还原（验收失败回退用）
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadLlmConfig, callChat } from '../tools/llm_focus.js';
import type { FixSuggestion, RootCause } from './contract.js';

// ─────────────────────────────────────────────────────────────
// 补丁契约
// ─────────────────────────────────────────────────────────────

/** 行级替换补丁：把文件 start_line..end_line（1-based 含）替换为 new_content */
export interface Patch {
  file: string;
  start_line: number;
  end_line: number;
  new_content: string;
}

export interface PatchPlan {
  patches: Patch[];
  rationale: string;
}

/** 已应用的补丁（含原始内容，供回退） */
export interface AppliedPatch {
  file: string;
  absFile: string;
  original: string;
}

/** 生成补丁的输入：诊断产物 + 修改白名单 */
export interface RepairInput {
  project_dir: string;
  root_cause?: RootCause;
  fix_suggestions: FixSuggestion[];
  /** 白名单：允许被修改的 posix 相对路径（默认 = 根因文件 + 建议 target_file） */
  allowed_files?: string[];
}

// ─────────────────────────────────────────────────────────────
// 白名单
// ─────────────────────────────────────────────────────────────

export function allowedPatchFiles(input: RepairInput): string[] {
  const set = new Set<string>();
  if (input.root_cause?.file_path) set.add(normalizeRel(input.root_cause.file_path));
  for (const s of input.fix_suggestions) {
    if (s.target_file) set.add(normalizeRel(s.target_file));
  }
  return [...set];
}

function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/');
}

// ─────────────────────────────────────────────────────────────
// LLM 补丁生成
// ─────────────────────────────────────────────────────────────

interface PatchJson {
  patches?: Array<{
    file?: string;
    start_line?: number;
    end_line?: number;
    new_content?: string;
  }>;
  rationale?: string;
}

export function buildRepairPrompt(input: RepairInput, allowed: string[]): string {
  const rc = input.root_cause;
  const snippet = rc
    ? readSnippet(path.resolve(input.project_dir, rc.file_path), rc.line ?? 1)
    : undefined;
  return [
    '【根因】',
    rc ? `  ${rc.symbol} @ ${rc.file_path}:${rc.line}（kind=${rc.kind}，置信度 ${rc.confidence}）` : '  （无根因）',
    `  reasoning：${rc?.reasoning ?? '无'}`,
    '',
    '【源码片段（报错点附近，行号真实）】',
    snippet ?? '（未能读取源码）',
    '',
    '【修复建议】',
    input.fix_suggestions.slice(0, 5).map((s) => `  - [${s.action}] ${s.target_file}:${s.target_line ?? '?'} ${s.description}`).join('\n') || '（无）',
  ].join('\n');
}

function readSnippet(absFile: string, aroundLine: number): string | undefined {
  try {
    const lines = fs.readFileSync(absFile, 'utf-8').split(/\r?\n/);
    const s = Math.max(1, aroundLine - 8);
    const e = Math.min(lines.length, aroundLine + 8);
    const width = String(e).length;
    return lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(width, ' ')}| ${l}`).join('\n');
  } catch {
    return undefined;
  }
}

/**
 * 生成补丁。需要 LLM 配置（无配置/调用失败返回 null → 闭环降级为"只诊断不修复"）。
 * LLM 只产出"行号区间 + 新内容"，应用时以磁盘真实行为准。
 */
export async function generatePatch(input: RepairInput): Promise<PatchPlan | null> {
  const allowed = allowedPatchFiles(input);
  if (allowed.length === 0) return null;

  const cfg = loadLlmConfig();
  if (!cfg) return null;

  const system =
    '你是资深后端工程师。基于确定性证据生成最小行级修复补丁。' +
    '规则：1) 只能修改白名单文件：' + allowed.join('、') + '；' +
    '2) 补丁 = 行号区间替换：start_line..end_line 是要替换的原有行区间（1-based 含端点），new_content 是替换后的完整内容（可多行），只改必要行、不重写整文件；' +
    '3) start_line/end_line 必须在源码片段展示的真实行号范围内；' +
    '4) 只输出 JSON：{"patches":[{"file":"","start_line":1,"end_line":1,"new_content":""}],"rationale":"一句话说明改动"}';

  try {
    const raw = await callChat(cfg, [
      { role: 'system', content: system },
      { role: 'user', content: buildRepairPrompt(input, allowed) },
    ]);
    const j = JSON.parse(raw) as PatchJson;
    const patches: Patch[] = (j.patches ?? [])
      .filter((p) => p.file && typeof p.new_content === 'string')
      .map((p) => ({
        file: normalizeRel(p.file as string),
        start_line: Number(p.start_line) || 1,
        end_line: Number(p.end_line) || 1,
        new_content: p.new_content as string,
      }));
    if (patches.length === 0) return null;
    return { patches, rationale: j.rationale?.trim() || 'LLM 补丁' };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// 校验 + 应用 + 回退
// ─────────────────────────────────────────────────────────────

export interface ValidationError {
  file: string;
  reason: string;
}

/** 校验补丁：白名单 / 文件存在 / 行号区间合法（不越界、start<=end）。返回错误列表 */
export function validatePatches(project_dir: string, plan: PatchPlan, allowed: string[]): ValidationError[] {
  const root = path.resolve(project_dir);
  const allowSet = new Set(allowed.map(normalizeRel));
  const errs: ValidationError[] = [];
  for (const p of plan.patches) {
    if (!allowSet.has(p.file)) {
      errs.push({ file: p.file, reason: `不在修改白名单（允许：${[...allowSet].join('、') || '空'}）` });
      continue;
    }
    const abs = path.resolve(root, p.file);
    if (!fs.existsSync(abs)) {
      errs.push({ file: p.file, reason: '文件不存在' });
      continue;
    }
    let lineCount: number;
    try {
      lineCount = fs.readFileSync(abs, 'utf-8').split(/\r?\n/).length;
    } catch {
      errs.push({ file: p.file, reason: '文件不可读' });
      continue;
    }
    if (p.start_line < 1 || p.end_line < p.start_line || p.end_line > lineCount) {
      errs.push({ file: p.file, reason: `行号越界（${p.start_line}..${p.end_line}，文件共 ${lineCount} 行）` });
    }
  }
  return errs;
}

/** 生成统一 diff 风格文本（供审批展示）——区间替换的直观呈现 */
export function formatPatchDiff(project_dir: string, plan: PatchPlan): string[] {
  const root = path.resolve(project_dir);
  const out: string[] = [];
  for (const p of plan.patches) {
    const abs = path.resolve(root, p.file);
    let lines: string[];
    try {
      lines = fs.readFileSync(abs, 'utf-8').split(/\r?\n/);
    } catch {
      continue;
    }
    const oldLines = lines.slice(p.start_line - 1, p.end_line);
    const newLines = p.new_content.split(/\r?\n/);
    out.push(`--- a/${p.file}`);
    out.push(`+++ b/${p.file}`);
    out.push(`@@ -${p.start_line},${oldLines.length} +${p.start_line},${newLines.length} @@`);
    for (const l of oldLines) out.push(`- ${l}`);
    for (const l of newLines) out.push(`+ ${l}`);
  }
  return out;
}

/** 应用补丁；返回已应用记录（含原始内容，供回退）。先整体校验通过再逐个应用。 */
export function applyPatches(project_dir: string, plan: PatchPlan, allowed: string[]): { applied: AppliedPatch[]; errors: ValidationError[] } {
  const errs = validatePatches(project_dir, plan, allowed);
  if (errs.length > 0) return { applied: [], errors: errs };

  const root = path.resolve(project_dir);
  const applied: AppliedPatch[] = [];
  for (const p of plan.patches) {
    const abs = path.resolve(root, p.file);
    const original = fs.readFileSync(abs, 'utf-8');
    const lines = original.split(/\r?\n/);
    const head = lines.slice(0, p.start_line - 1);
    const tail = lines.slice(p.end_line); // end_line 1-based 含，index=end_line 起为保留尾
    const newLines = p.new_content.split(/\r?\n/);
    fs.writeFileSync(abs, [...head, ...newLines, ...tail].join('\n'), 'utf-8');
    applied.push({ file: p.file, absFile: abs, original });
  }
  return { applied, errors: [] };
}

/** 回退：按原始内容还原已应用的文件（验收失败时调用） */
export function revertPatches(applied: AppliedPatch[]): void {
  for (const a of applied) {
    try {
      fs.writeFileSync(a.absFile, a.original, 'utf-8');
    } catch {
      /* 文件已被删除等极端情况：忽略，交给 git 兜底 */
    }
  }
}
