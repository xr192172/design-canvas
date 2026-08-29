/**
 * llm_decider —— 批注工单 → LLM 决策 → 审批流闭环（阶段 C · 内置 LLM 作为"工具"）
 *
 * 角色定位：内置 LLM 是工具，主消费者是外部 agent。本模块 = 该工具的决策内核：
 *   读某 feature 的 open 批注工单（ResolvedCanvasNote[]，含 L1-L4 上下文）
 *   → 逐单交给 LLM 决策 → 产出三类结论：
 *     change ：产出一个具体改动方案（edit_code / dsl_rename / rename_file）
 *              → 映射到 code_workbench 审批流（proposeChange，propose 只出干跑预览不写源文件）
 *     done   ：无需改码（信息性批注/已满足）→ 直接标 done
 *     reject ：无法自动化（需求模糊/超范围/需人工）→ 标 rejected
 *
 * 配置（复用 llm_focus，OpenAI 兼容）：
 *   环境变量 LLM_API_KEY / LLM_MODEL / LLM_BASE_URL
 *   或 <home>/.design-canvas/config.json 的 llm 段 / agent.mmd 段（AGNES）。
 * 无配置 → 规则降级（诚实分类：信息性→done，动作性→reject，不伪造代码）。
 * LLM_DECIDER_MOCK=1 → 确定性假决策（无 key 环境的端到端接线验证专用，明确标注）。
 *
 * 安全：change 一律走 proposeChange 干跑（语法门 + 行区间校验），不直接写源文件；
 *       真正写盘由审批流 approve 决定（人工/agent 介入点）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDSL, saveDSL } from '../storage.js';
import { loadLlmConfig, callChat, type LlmConfig, type ChatMessage } from './llm_focus.js';
import { resolveCanvasNoteTargets, markCanvasNotesStatus, type ResolvedCanvasNote } from './derive_mind_map.js';
import { proposeChange, type ChangeKind, type ChangeOp } from './code_workbench.js';

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

export type DecideAction = 'change' | 'done' | 'reject';

/** 单条工单的决策结果 */
export interface NoteDecisionResult {
  /** 工单 id（= 批注套 groupId，与 mark_canvas_notes_status 的 id 对齐） */
  note_id: string;
  action: DecideAction;
  /** 人话理由 */
  reason: string;
  /** 是否真由 LLM 决策（false = 规则降级 / mock） */
  llm: boolean;
  /** action=change 时：改动类型 */
  kind?: ChangeKind;
  /** action=change 时：改动操作（映射到审批流 op） */
  change?: ChangeOp;
  /** action=change 且 propose 成功：提案 id（审批流 pending id） */
  pending_change_id?: string;
  /** action=change 且 propose 成功：提案 label */
  label?: string;
  /** action=change 且 propose 成功：干跑预览文本 */
  preview?: string;
  /** action=change 但 propose 失败：失败原因（该条按 reject 处理） */
  error?: string;
}

export interface DecideCanvasNotesInput {
  feature: string;
  /** 项目根目录（缺省用 dsl.source_root；target.file.path 相对此解析） */
  project_dir?: string;
  /** 喂给 LLM 的目标文件最大行数（默认 300；超出截断并标注） */
  max_file_lines?: number;
  /** dry_run=true 时不写批注状态（纯决策 + 提提案，不落状态） */
  dry_run?: boolean;
}

export interface DecideCanvasNotesResult {
  feature: string;
  /** 提案/目标文件解析所用的项目根目录（= 传入或 dsl.source_root） */
  project_dir: string;
  /** 全局是否真用 LLM（false = 规则降级 / mock） */
  llm: boolean;
  /** 决策模式说明 */
  note: string;
  open: number;
  decisions: NoteDecisionResult[];
  /** 已落盘的状态更新（action=done/reject 且非 dry_run） */
  applied_statuses: Array<{ id: string; status: 'done' | 'rejected' }>;
  /** 成功进入审批流的提案数 */
  proposed: number;
}

// ─────────────────────────────────────────────────────────────
// 目标文件读取（喂给 LLM 的真实代码上下文）
// ─────────────────────────────────────────────────────────────

interface FileExcerpt {
  path: string;
  content: string;
  total: number;
  truncated: boolean;
}

/** 目标文件路径 → 相对项目根的本地路径（拒绝绝对路径/穿越） */
function safeRel(rel: string): string | null {
  if (!rel || path.isAbsolute(rel)) return null;
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => p === '..' || p === '.')) return null;
  return parts.join('/');
}

/** 读取目标文件内容（有界，最大 maxLines 行，超出截断） */
function readFileExcerpt(project_dir: string, rel: string, maxLines: number): FileExcerpt | null {
  const safe = safeRel(rel);
  if (!safe) return null;
  const abs = path.resolve(project_dir, safe);
  if (!fs.existsSync(abs)) return null;
  const raw = fs.readFileSync(abs, 'utf8');
  const lines = raw.split(/\r?\n/);
  const total = lines.length;
  const cap = Math.max(1, maxLines);
  const truncated = total > cap;
  return { path: safe, content: lines.slice(0, cap).join('\n') + (truncated ? '\n// …(截断，共 ' + total + ' 行)' : ''), total, truncated };
}

/** 取工单目标文件路径（仅 file 目标有） */
function targetFileRel(n: ResolvedCanvasNote): string | null {
  const t = n.target;
  if (t?.kind === 'file' && t.file?.path) return t.file.path;
  return null;
}

// ─────────────────────────────────────────────────────────────
// 决策 JSON 契约与容错解析
// ─────────────────────────────────────────────────────────────

interface RawDecision {
  action?: string;
  reason?: string;
  change?: { kind?: string; op?: Record<string, unknown> };
}

/** 从 LLM 文本中容错提取 JSON（剥 ```json 围栏、取首尾大括号） */
function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1));
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 校验/归一化 LLM 产出的 change op（轻校验，重校验交给 proposeChange 的语法门/行区间） */
function normalizeChangeOp(change: RawDecision['change']): { kind: ChangeKind; op: ChangeOp } | null {
  const kind = change?.kind;
  const op = change?.op ?? {};
  if (kind === 'edit_code') {
    const file = typeof op.file === 'string' ? op.file : '';
    const start = Number(op.start);
    const end = Number(op.end);
    const code = typeof op.code === 'string' ? op.code : '';
    if (!file || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || !code) return null;
    return { kind, op: { file, op: 'range', start, end, code } };
  }
  if (kind === 'dsl_rename') {
    const feature = typeof op.feature === 'string' ? op.feature : '';
    const oldName = typeof op.oldName === 'string' ? op.oldName : '';
    const newName = typeof op.newName === 'string' ? op.newName : '';
    if (!feature || !oldName || !newName || oldName === newName) return null;
    return { kind, op: { feature, oldName, newName } };
  }
  if (kind === 'rename_file') {
    const from = typeof op.from === 'string' ? op.from : '';
    const to = typeof op.to === 'string' ? op.to : '';
    if (!from || !to || from === to) return null;
    return { kind, op: { from, to } };
  }
  return null;
}

/** 解析 LLM JSON → 规范决策（结构非法返回 null，交由降级） */
function parseRawDecision(text: string): RawDecision | null {
  const obj = extractJson(text);
  if (!obj) return null;
  const action = obj.action;
  if (action !== 'change' && action !== 'done' && action !== 'reject') return null;
  const raw: RawDecision = { action, reason: typeof obj.reason === 'string' ? obj.reason : '', change: undefined };
  if (action === 'change' && obj.change && typeof obj.change === 'object') {
    raw.change = obj.change as RawDecision['change'];
  }
  return raw;
}

// ─────────────────────────────────────────────────────────────
// 决策实现：LLM / mock / 规则降级
// ─────────────────────────────────────────────────────────────

/** 模式判定：mock（显式开关）> LLM（有配置）> 规则降级 */
function decideMode(cfg: LlmConfig | null): { mode: 'llm' | 'mock' | 'rule'; cfg: LlmConfig | null; note: string } {
  if (process.env.LLM_DECIDER_MOCK === '1') {
    return { mode: 'mock', cfg: null, note: 'LLM_DECIDER_MOCK=1：确定性假决策（端到端接线验证，非真实 LLM）' };
  }
  if (cfg) {
    return { mode: 'llm', cfg, note: `LLM 决策（model=${cfg.model}）` };
  }
  return { mode: 'rule', cfg: null, note: '未配置 LLM（LLM_API_KEY 或 config.json），已用规则降级：信息性→done，动作性→reject' };
}

/** 规则降级：诚实分类，不伪造代码 */
function ruleDecide(n: ResolvedCanvasNote): { action: DecideAction; reason: string } {
  const text = (n.text ?? '').trim();
  const t = n.target;
  if (!t) return { action: 'reject', reason: '批注未绑定节点，无法定位改动点' };
  if (!text) return { action: 'reject', reason: '批注无文字，无法判断处理方式' };
  const infoWords = ['待评估', '评估', '待定', '待确认', '参考', '备注', '观察', '注意'];
  const actionWords = ['缺失', '校验', '验证', '修复', '重构', '问题', 'bug', '报错', '溢出', '越界'];
  if (actionWords.some((w) => text.includes(w))) {
    return { action: 'reject', reason: `批注含动作性描述（${text}），需 LLM/人工产出具体改动方案（未配置 LLM）` };
  }
  if (infoWords.some((w) => text.includes(w))) {
    return { action: 'done', reason: '信息性批注（评估/备注类），无需改码' };
  }
  return { action: 'done', reason: '批注不构成代码改动诉求' };
}

/** mock 决策：确定性产出（仅 LLM_DECIDER_MOCK=1 时启用）——有文件目标的"待评估"→ 提一个阈值上调提案 */
function mockDecide(n: ResolvedCanvasNote, file: FileExcerpt | null): { action: DecideAction; reason: string; change?: { kind: ChangeKind; op: ChangeOp } } {
  const text = (n.text ?? '').trim();
  if (text.includes('待评估') && file) {
    // 定位阈值常量行，产出一个行区间有效的 edit_code（propose 只干跑预览，不写盘）
    const lines = file.content.split('\n');
    const idx = lines.findIndex((l) => l.includes('MAX_SEQUENCE_EXPORT ='));
    const start = idx >= 0 ? idx + 1 : 1;
    const end = idx >= 0 ? idx + 1 : 1;
    const targetLine = idx >= 0 ? lines[idx] : `// 目标文件 ${file.path} 第 ${start} 行`;
    const code = `${targetLine} // 阈值上调（LLM 决策 mock，待人工审批）`;
    return {
      action: 'change',
      reason: 'rebuildChains 阈值待评估 → 产出阈值上调提案（mock 决策）',
      change: { kind: 'edit_code', op: { file: file.path, op: 'range', start, end, code } },
    };
  }
  return { action: 'done', reason: '信息性批注，无需改码（mock 决策）' };
}

/** 构建单条工单的 LLM prompt（系统约束 + 工单 + 目标文件内容） */
function buildNotePrompt(n: ResolvedCanvasNote, file: FileExcerpt | null): ChatMessage[] {
  const system =
    '你是代码批注工单的自动决策器。用户在画布上对代码工程画了批注，每条批注是一条"工单"，捆绑了功能/步骤/文件/契约上下文。' +
    '请判断对每条工单应如何处理，只输出一个 JSON 对象（不要 markdown，不要注释）：\n' +
    '{"action":"change"|"done"|"reject","reason":"一句话人话理由","change":{"kind":"edit_code"|"dsl_rename"|"rename_file","op":{...}}}\n' +
    'action 含义：\n' +
    '- change：需要改代码/数据名 → 给出具体改动方案。edit_code 的 op 必须含 file/start/end/code（file 用给定的目标文件路径，start/end 为 1 起始行区间，code 为完整替换该区间的新代码）；' +
    'dsl_rename 的 op 含 feature/oldName/newName；rename_file 的 op 含 from/to。\n' +
    '- done：无需改码（信息性批注、已满足、仅备注）→ 直接标记已处理。\n' +
    '- reject：无法自动化（需求模糊、超出工具能力、需人工决策）→ 标记已驳回。\n' +
    '禁止编造：只能引用给定文件内容中的真实行；行区间必须落在文件长度内；若信息不足宁可 reject 也不要臆造代码。';
  const targetJson = n.target
    ? JSON.stringify(n.target, (_k, v) => (v === undefined ? null : v), 2)
    : 'null';
  const fileBlock = file
    ? `\n## 目标文件内容（${file.path}，共 ${file.total} 行，展示 ${file.content.split('\n').length} 行）\n\`\`\`\n${file.content}\n\`\`\``
    : '\n（工单未绑定文件或文件不存在——如要改代码请先确认目标）';
  const user =
    `## 工单\n${JSON.stringify({ id: n.id, type: n.type, text: n.text, status: n.status, target: targetJson }, null, 2)}\n` +
    fileBlock +
    '\n\n请按上面契约输出决策 JSON。';
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** LLM 决策单条（失败降级到规则） */
async function llmDecide(cfg: LlmConfig, n: ResolvedCanvasNote, file: FileExcerpt | null): Promise<{ action: DecideAction; reason: string; change?: { kind: ChangeKind; op: ChangeOp }; llm: boolean }> {
  try {
    const raw = await callChat(cfg, buildNotePrompt(n, file), 0.2, 60_000);
    const parsed = parseRawDecision(raw);
    if (!parsed || !parsed.action) return { ...ruleDecide(n), llm: false };
    if (parsed.action === 'change') {
      const norm = normalizeChangeOp(parsed.change);
      if (!norm) return { action: 'reject', reason: `LLM 的 change 方案结构非法（${parsed.reason || 'op 缺失/行区间非法'}），已驳回`, llm: true };
      return { action: 'change', reason: parsed.reason || 'LLM 提议改动', change: norm, llm: true };
    }
    if (parsed.action === 'reject') {
      return { action: 'reject', reason: parsed.reason || 'LLM 判定无法自动化', llm: true };
    }
    return { action: 'done', reason: parsed.reason || 'LLM 判定无需改码', llm: true };
  } catch (e) {
    return { ...ruleDecide(n), llm: false };
  }
}

// ─────────────────────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────────────────────

export async function decideCanvasNotes(input: DecideCanvasNotesInput): Promise<DecideCanvasNotesResult> {
  const feature = input.feature;
  const maxLines = input.max_file_lines ?? 300;
  const dryRun = input.dry_run === true;

  const dsl = getDSL(feature);
  if (!dsl) {
    return { feature, project_dir: '', llm: false, note: `feature "${feature}" 不存在`, open: 0, decisions: [], applied_statuses: [], proposed: 0 };
  }
  const projectDir = input.project_dir || dsl.source_root || '';
  const resolved = resolveCanvasNoteTargets(feature);
  const open = resolved.filter((n) => n.status === 'open');

  const mode = decideMode(loadLlmConfig());
  const statusUpdates: Array<{ id: string; status: 'done' | 'rejected' }> = [];
  const decisions: NoteDecisionResult[] = [];
  let proposed = 0;

  for (const n of open) {
    const fileRel = targetFileRel(n);
    const file = fileRel && projectDir ? readFileExcerpt(projectDir, fileRel, maxLines) : null;

    // 1) 决策
    let raw: { action: DecideAction; reason: string; change?: { kind: ChangeKind; op: ChangeOp }; llm: boolean };
    if (mode.mode === 'llm' && mode.cfg) {
      raw = await llmDecide(mode.cfg, n, file);
    } else if (mode.mode === 'mock') {
      const m = mockDecide(n, file);
      raw = { action: m.action, reason: m.reason, change: m.change, llm: false };
    } else {
      const r = ruleDecide(n);
      raw = { action: r.action, reason: r.reason, llm: false };
    }

    // 2) 映射到审批流 / 状态
    const d: NoteDecisionResult = { note_id: n.id, action: raw.action, reason: raw.reason, llm: raw.llm };
    if (raw.action === 'change' && raw.change) {
      if (!projectDir) {
        d.action = 'reject';
        d.reason = '无法定位项目根目录（dsl.source_root 缺失且未传 project_dir），改动方案已驳回';
      } else {
        const r = await proposeChange({
          kind: raw.change.kind,
          project_dir: projectDir,
          op: raw.change.op,
          submitter: 'llm_decider',
        });
        if (r.ok && r.change) {
          d.kind = r.change.kind;
          d.change = r.change.op;
          d.pending_change_id = r.change.id;
          d.label = r.change.label;
          d.preview = r.change.preview;
          proposed++;
        } else {
          d.action = 'reject';
          d.error = r.error || '提案失败';
          d.reason = `改动方案未通过审批流校验（${d.error}），已驳回`;
        }
      }
    }
    if (d.action === 'done') statusUpdates.push({ id: n.id, status: 'done' });
    if (d.action === 'reject') statusUpdates.push({ id: n.id, status: 'rejected' });
    decisions.push(d);
  }

  // 3) 落批注状态（done/reject；change 保持 open 等审批；dry_run 不落）
  let applied: Array<{ id: string; status: 'done' | 'rejected' }> = [];
  if (!dryRun && statusUpdates.length > 0 && dsl) {
    dsl.canvas_notes = markCanvasNotesStatus(dsl, statusUpdates);
    saveDSL(dsl, 'decide');
    applied = statusUpdates;
  }

  return {
    feature,
    project_dir: projectDir,
    llm: mode.mode === 'llm',
    note: mode.note,
    open: open.length,
    decisions,
    applied_statuses: applied,
    proposed,
  };
}
