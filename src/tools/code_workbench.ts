/**
 * code_workbench —— 代码变更审批工作台（P3：把 P1/P2 能力接进可视化界面）
 *
 * 闭环：LLM / 前端提交「变更提案（propose，干跑只算预览）」
 *   → 人看一眼 UI 里的 diff → 通过（approve，真正落盘）或 驳回（reject，丢弃）。
 *
 * 接地层：
 *   - P1 rename_file（文件级智能重命名）：dry_run 只出影响面，不迁移/不改写；
 *      approve 时才真正 `renameFile` 执行迁移 + 全项目改写引用 + 重索引。
 *   - P2 edit_code op:'range'（显式行区间）：dry_run 走语法门不写盘；
 *     approve 时才真正写盘并重建索引。
 *
 * 安全：
 *   - approve 时重新跑真实操作（非内存假执行），复用 edit_code 的语法门 /
 *     rename_file 的目标冲突阻断，行号漂移会报错上抛而非静默改错。
 *   - 行号漂移 / 目标已存在等执行失败 → 保留原提案并记录 lastError，不吞。
 *   - 变更按（project_dir）隔离存在 `<dataHome>/.design-canvas/workbench/` 下。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getStorageRoot, getDSL, saveDSL } from '../storage.js';
import { renameFile, type RenameFileInput } from './rename_file.js';
import { editCode, type EditCodeArgs } from './edit_code.js';
import type { DesignDSL } from '../dsl/types.js';

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

export type ChangeKind = 'rename_file' | 'edit_code' | 'dsl_rename';

export interface ChangeOp {
  /** rename_file */
  from?: string;
  to?: string;
  /** edit_code */
  file?: string;
  op?: 'range';
  start?: number;
  end?: number;
  code?: string;
  /** dsl_rename：目标 feature + 数据名（= 产出节点 label）新旧名 + 产出节点 id */
  feature?: string;
  oldName?: string;
  newName?: string;
  producer?: string;
}

export type ChangeStatus = 'pending' | 'approved' | 'rejected' | 'executed';

export interface ChangeDiff {
  /** 目标展示文件（rename 为 "a → b"） */
  file: string;
  kind: 'replace' | 'rename';
  /** 变更前内容（行） */
  before: string[];
  /** 变更后内容（行） */
  after: string[];
  /** 影响面说明 / 区间穿透符号告警等 */
  note?: string;
}

export interface PendingChange {
  id: string;
  kind: ChangeKind;
  project_dir: string;
  op: ChangeOp;
  label: string;
  summary: string[];
  diffs: ChangeDiff[];
  preview?: string;        // edit_code dry-run 的官方预览文本（带语法门结论）
  status: ChangeStatus;
  lastError?: string;
  result?: string;         // 执行成功后的结果文本
  submitted_at: string;
  decided_at?: string;
}

export interface ProposeInput {
  kind: ChangeKind;
  project_dir: string;
  op: ChangeOp;
  submitter?: string;
}

// ─────────────────────────────────────────────────────────────
// 存储（按 project_dir 隔离）
// ─────────────────────────────────────────────────────────────

function safeName(project_dir: string): string {
  const base = path.basename(path.resolve(project_dir)) || 'root';
  return base.replace(/[^A-Za-z0-9._-]/g, '_');
}

function storeFile(project_dir: string): string {
  const dir = path.join(getStorageRoot(), 'workbench');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${safeName(project_dir)}.json`);
}

function loadChanges(project_dir: string): PendingChange[] {
  const f = storeFile(project_dir);
  if (!fs.existsSync(f)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(f, 'utf-8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveChanges(project_dir: string, changes: PendingChange[]): void {
  fs.writeFileSync(storeFile(project_dir), JSON.stringify(changes, null, 2), 'utf-8');
}

function nowIso(): string {
  return new Date().toISOString();
}

function uid(): string {
  return `cw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// ─────────────────────────────────────────────────────────────
// 行工具（与 edit_code 对齐：保留行尾、按文件换行风格归一）
// ─────────────────────────────────────────────────────────────

function splitKeepEnds(content: string): string[] {
  const lines = content.split(/(?<=\n)/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function normalizeLines(code: string, eol: string): string[] {
  const normalized = code.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const parts = normalized.split('\n');
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => l + eol);
}

function detectEol(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function absPath(project_dir: string, p: string): string {
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(project_dir, p);
}

// ─────────────────────────────────────────────────────────────
// 预览生成
// ─────────────────────────────────────────────────────────────

function buildLabel(kind: ChangeKind, op: ChangeOp): string {
  if (kind === 'rename_file') return `移动/重命名文件 ${op.from ?? ''} → ${op.to ?? ''}`;
  if (kind === 'dsl_rename') return `数据名重命名 ${op.oldName ?? ''} → ${op.newName ?? ''}`;
  return `行区间编辑 ${op.file ?? ''} L${op.start}-${op.end}`;
}

/** edit_code range：读当前文件，计算 before/after 块 + 调 edit_code dry_run 取官方预览与语法门结论 */
async function previewEditRange(project_dir: string, op: ChangeOp): Promise<{ diffs: ChangeDiff[]; preview: string }> {
  const file = op.file;
  if (!file || op.start == null || op.end == null || op.code == null) {
    throw new Error('edit_code 变更缺 file/start/end/code');
  }
  const abs = absPath(project_dir, file);
  if (!fs.existsSync(abs)) throw new Error(`文件不存在: ${abs}`);
  const content = fs.readFileSync(abs, 'utf8');
  const eol = detectEol(content);
  const lines = splitKeepEnds(content);
  const total = lines.length;
  const start = op.start;
  const end = op.end;
  if (start < 1 || end < start || end > total) {
    throw new Error(`行区间越界：L${start}-L${end}/${total}（文件可能已漂移）`);
  }
  const startIdx = start - 1;
  const count = end - start + 1;
  const removed = lines.slice(startIdx, startIdx + count);
  const added = normalizeLines(op.code, eol);
  // 上下文（前 1 行 / 后 1 行）
  const beforeCtx = lines.slice(Math.max(0, startIdx - 1), startIdx);
  const afterCtx = lines.slice(startIdx + count, Math.min(lines.length, startIdx + count + 1));
  const before = [...beforeCtx, ...removed, ...afterCtx];
  const after = [...beforeCtx, ...added, ...afterCtx];
  const diffs: ChangeDiff[] = [
    {
      file: file,
      kind: 'replace',
      before,
      after,
      note: `${count} 行 → ${added.length} 行${startIdx > 0 || afterCtx.length > 0 ? '' : ''}`,
    },
  ];
  // 官方 dry-run（验证语法门 + 取区间穿透告警）
  const { editCode: ec } = await import('./edit_code.js');
  const dry = await ec(
    Object.assign({ project_dir, file, op: 'range', start, end, code: op.code, dry_run: true } as EditCodeArgs),
  );
  return { diffs, preview: dry.message };
}

/** rename_file：dry_run 取影响面，转成可视化 diff（from→to + 逐引用改写） */
async function previewRename(project_dir: string, op: ChangeOp): Promise<{ diffs: ChangeDiff[]; preview: string }> {
  if (!op.from || !op.to) throw new Error('rename_file 变更缺 from/to');
  const input: RenameFileInput = { project_dir, from: op.from, to: op.to, dry_run: true };
  const r = await renameFile(input);
  if (!r.ok && r.blocked?.length) {
    throw new Error('阻断：' + r.blocked.join('；'));
  }
  const diffs: ChangeDiff[] = [];
  if (r.references.length > 0 || r.pending.length > 0) {
    diffs.push({
      file: `${r.fromRel} → ${r.toRel}`,
      kind: 'rename',
      before: r.references.map((x) => `import ... from "${x.fromSource}"   // ${x.file}`),
      after: r.references.map((x) => `import ... from "${x.toSource}"   // ${x.file}`),
      note:
        `被移动文件 ${r.fromRel}；自动改写 ${r.editCount} 处引用` +
        (r.pending.length ? '；\n需人工复核：\n  - ' + r.pending.join('\n  - ') : ''),
    });
  } else {
    diffs.push({
      file: `${r.fromRel} → ${r.toRel}`,
      kind: 'rename',
      before: ['（无 import 引用被改写——目标为原地改名或包内引用）'],
      after: [],
      note: '仅移动文件本身，无跨文件引用需同步',
    });
  }
  const preview =
    `影响面：${r.editCount} 处引用改写\n` +
    r.references.map((x) => `  ${x.file}: "${x.fromSource}" → "${x.toSource}"`).join('\n') +
    (r.pending.length ? '\n需人工复核：\n  - ' + r.pending.join('\n  - ') : '');
  return { diffs, preview };
}

// ─────────────────────────────────────────────────────────────
// dsl_rename：数据名（= 产出节点 label）全图谱同步重命名
// 干跑只算影响面不写盘；approve 时真实改 DSL 并通过 saveDSL 广播。
// ─────────────────────────────────────────────────────────────

/** 一次重命名命中点 */
export interface DslRenameEdit {
  kind: 'node_label' | 'node_title' | 'edge_label';
  node?: string;
  edge?: string;
  from: string;
  to: string;
}

/**
 * 计算重命名影响面（纯读，不改 dsl）：
 * 1. 产出节点（op.producer 指定 id，或按 label 首匹配）label / title 命中 → 改名
 * 2. 引用该数据名的 flow 边（label === oldName）→ 同步
 */
export function collectDslRenameEdits(dsl: DesignDSL, op: ChangeOp): DslRenameEdit[] {
  const oldName = op.oldName ?? '';
  const newName = op.newName ?? '';
  if (!oldName || !newName || oldName === newName) return [];
  const nodes = dsl.geometry?.nodes ?? [];
  const edges = dsl.geometry?.edges ?? [];
  const edits: DslRenameEdit[] = [];

  // 产出节点：优先按 id，其次按 label 首匹配
  const producer = op.producer
    ? nodes.find((n) => n.id === op.producer)
    : nodes.find((n) => n.label === oldName);
  if (producer) {
    if (producer.label === oldName) edits.push({ kind: 'node_label', node: producer.id, from: oldName, to: newName });
    if (producer.title === oldName) edits.push({ kind: 'node_title', node: producer.id, from: oldName, to: newName });
  }
  // 引用边：凡是 label 承载该数据名的边（via）都同步改名
  for (const e of edges) {
    if (e.label === oldName) edits.push({ kind: 'edge_label', edge: e.id, from: oldName, to: newName });
  }
  return edits;
}

/** 真正把 edits 落到 dsl 对象上（approve 时用） */
export function applyDslRenameEdits(dsl: DesignDSL, edits: DslRenameEdit[]): number {
  let n = 0;
  for (const ed of edits) {
    if (ed.kind === 'node_label') {
      const node = (dsl.geometry?.nodes ?? []).find((x) => x.id === ed.node);
      if (node && node.label === ed.from) { node.label = ed.to; n++; }
    } else if (ed.kind === 'node_title') {
      const node = (dsl.geometry?.nodes ?? []).find((x) => x.id === ed.node);
      if (node && node.title === ed.from) { node.title = ed.to; n++; }
    } else if (ed.kind === 'edge_label') {
      const edge = (dsl.geometry?.edges ?? []).find((x) => x.id === ed.edge);
      if (edge && edge.label === ed.from) { edge.label = ed.to; n++; }
    }
  }
  return n;
}

/** dsl_rename 干跑：定位 DSL → 算影响面 → 转可视化 diff + 预览文本 */
async function previewDslRename(project_dir: string, op: ChangeOp): Promise<{ diffs: ChangeDiff[]; preview: string }> {
  const feature = op.feature;
  if (!feature) throw new Error('dsl_rename 变更缺 feature');
  const dsl = getDSL(feature);
  if (!dsl) throw new Error(`DSL 不存在: feature "${feature}"（请先 import/save 该 feature）`);
  const edits = collectDslRenameEdits(dsl, op);
  if (edits.length === 0) {
    throw new Error(`在 feature "${feature}" 中找不到数据名「${op.oldName}」的产出节点或引用边`);
  }
  const labelEdits = edits.filter((e) => e.kind === 'node_label');
  const titleEdits = edits.filter((e) => e.kind === 'node_title');
  const edgeEdits = edits.filter((e) => e.kind === 'edge_label');
  const lines: string[] = [];
  if (labelEdits.length) lines.push(`产出节点 ${labelEdits[0].node}  label: "${op.oldName}" → "${op.newName}"`);
  if (titleEdits.length) lines.push(`产出节点 title: "${op.oldName}" → "${op.newName}"`);
  if (edgeEdits.length) lines.push(`引用边 ${edgeEdits.length} 条（via label）同步改名`);
  const before = [`数据名「${op.oldName}」定义于节点 ${labelEdits[0]?.node ?? op.producer ?? '（未定位）'}`];
  const after = [...lines];
  const diffs: ChangeDiff[] = [
    {
      file: `DSL · ${feature}`,
      kind: 'rename',
      before,
      after,
      note: `共 ${edits.length} 处同步：${labelEdits.length} 定义 + ${titleEdits.length} 标题 + ${edgeEdits.length} 引用边`,
    },
  ];
  const preview = `数据名「${op.oldName}」→「${op.newName}」\n` + lines.map((l) => '  ' + l).join('\n');
  return { diffs, preview };
}

/** dsl_rename 真改：定位 DSL → 算影响面 → 落盘 + 广播（source=mcp 触发浏览器刷新） */
async function executeDslRename(project_dir: string, op: ChangeOp): Promise<string> {
  const feature = op.feature;
  if (!feature) throw new Error('dsl_rename 变更缺 feature');
  const dsl = getDSL(feature);
  if (!dsl) throw new Error(`DSL 不存在: feature "${feature}"`);
  const edits = collectDslRenameEdits(dsl, op);
  if (edits.length === 0) throw new Error(`找不到数据名「${op.oldName}」的产出节点或引用边`);
  const n = applyDslRenameEdits(dsl, edits);
  saveDSL(dsl, 'mcp');
  return `已重命名「${op.oldName}」→「${op.newName}」，同步 ${n}/${edits.length} 处（节点 label/title + 引用边），feature "${feature}" 已回写`;
}

// ─────────────────────────────────────────────────────────────
// 提案 / 列表 / 审批 / 驳回
// ─────────────────────────────────────────────────────────────

export async function proposeChange(input: ProposeInput): Promise<{ change: PendingChange; ok: boolean; error?: string }> {
  const project_dir = path.resolve(input.project_dir);
  const op = input.op ?? {};
  try {
    let preview = '';
    let diffs: ChangeDiff[] = [];
    let summary: string[] = [];
    if (input.kind === 'edit_code') {
      const p = await previewEditRange(project_dir, op);
      preview = p.preview;
      diffs = p.diffs;
      summary = [`行区间编辑 ${op.file} L${op.start}-L${op.end}`, '语法门通过（干跑预览）'];
    } else if (input.kind === 'rename_file') {
      const p = await previewRename(project_dir, op);
      preview = p.preview;
      diffs = p.diffs;
      summary = [`移动/重命名 ${op.from} → ${op.to}`, `引用改写 ${diffs[0]?.after.length ?? 0} 处`];
    } else if (input.kind === 'dsl_rename') {
      const p = await previewDslRename(project_dir, op);
      preview = p.preview;
      diffs = p.diffs;
      const edgeN = diffs[0]?.note ?? '';
      summary = [`数据名重命名 ${op.oldName} → ${op.newName}`, edgeN, '干跑预览（未写盘）'];
    } else {
      throw new Error(`未知变更类型: ${input.kind}`);
    }
    const change: PendingChange = {
      id: uid(),
      kind: input.kind,
      project_dir,
      op,
      label: buildLabel(input.kind, op),
      summary,
      diffs,
      preview,
      status: 'pending',
      submitted_at: nowIso(),
    };
    const all = loadChanges(project_dir);
    all.push(change);
    saveChanges(project_dir, all);
    return { change, ok: true };
  } catch (e) {
    return { change: {} as PendingChange, ok: false, error: (e as Error).message };
  }
}

export function listChanges(project_dir: string): PendingChange[] {
  const all = loadChanges(project_dir);
  return [...all].sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));
}

export function getChange(project_dir: string, id: string): PendingChange | undefined {
  return loadChanges(project_dir).find((c) => c.id === id);
}

function findAndUpdate(project_dir: string, id: string, fn: (c: PendingChange) => void): PendingChange | undefined {
  const all = loadChanges(project_dir);
  const c = all.find((x) => x.id === id);
  if (!c) return undefined;
  fn(c);
  saveChanges(project_dir, all);
  return c;
}

export interface ApproveResult {
  ok: boolean;
  status: ChangeStatus;
  result?: string;
  error?: string;
}

export async function approveChange(project_dir: string, id: string): Promise<ApproveResult> {
  project_dir = path.resolve(project_dir);
  const c = loadChanges(project_dir).find((x) => x.id === id);
  if (!c) return { ok: false, status: 'pending', error: '变更不存在' };
  if (c.status === 'executed') return { ok: false, status: 'executed', error: '该变更已执行，勿重复审批' };
  if (c.status === 'rejected') return { ok: false, status: 'rejected', error: '该变更已驳回' };

  try {
    if (c.kind === 'rename_file') {
      const r = await renameFile({ project_dir: c.project_dir, from: c.op.from!, to: c.op.to! });
      const rblocked = r.blocked ?? [];
      if (!r.ok && rblocked.length) {
        findAndUpdate(project_dir, id, (x) => {
          x.lastError = '阻断：' + rblocked.join('；');
          x.status = 'pending';
        });
        return { ok: false, status: 'pending', error: '阻断：' + rblocked.join('；') };
      }
      const result = `已移动 ${r.fromRel} → ${r.toRel}，改写 ${r.editCount} 处引用，重建索引`;
      findAndUpdate(project_dir, id, (x) => {
        x.result = result;
        x.lastError = undefined;
        x.status = 'executed';
        x.decided_at = nowIso();
      });
      return { ok: true, status: 'executed', result };
    }

    if (c.kind === 'dsl_rename') {
      const result = await executeDslRename(c.project_dir, c.op);
      findAndUpdate(project_dir, id, (x) => {
        x.result = result;
        x.lastError = undefined;
        x.status = 'executed';
        x.decided_at = nowIso();
      });
      return { ok: true, status: 'executed', result };
    }

    // edit_code range
    const res = await editCode({
      project_dir: c.project_dir,
      file: c.op.file!,
      op: 'range',
      start: c.op.start!,
      end: c.op.end!,
      code: c.op.code!,
    } as EditCodeArgs);
    findAndUpdate(project_dir, id, (x) => {
      x.result = res.message;
      x.lastError = undefined;
      x.status = 'executed';
      x.decided_at = nowIso();
    });
    return { ok: true, status: 'executed', result: res.message };
  } catch (e) {
    findAndUpdate(project_dir, id, (x) => {
      x.lastError = (e as Error).message;
      x.status = 'pending'; // 执行失败，保留提案待改
    });
    return { ok: false, status: 'pending', error: (e as Error).message };
  }
}

export function rejectChange(project_dir: string, id: string): ApproveResult {
  project_dir = path.resolve(project_dir);
  const c = loadChanges(project_dir).find((x) => x.id === id);
  if (!c) return { ok: false, status: 'pending', error: '变更不存在' };
  if (c.status === 'executed') return { ok: false, status: 'executed', error: '已执行，无法驳回' };
  findAndUpdate(project_dir, id, (x) => {
    x.status = 'rejected';
    x.decided_at = nowIso();
  });
  return { ok: true, status: 'rejected', result: '已驳回，未写盘' };
}