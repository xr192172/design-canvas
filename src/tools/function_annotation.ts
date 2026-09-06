/**
 * function_annotation —— 函数语义注释（TS/JS + Go）
 *
 * 目标：让"函数做什么"由**源码自带注释**承载，而不是每次由 LLM 从代码重新提取
 * （那只是把编译器信息再抄一遍，费时费钱还不更新）。作者意图在**写入时一次性沉淀**
 * （缺失时由 LLM 生成，随后在每次修改时通过 body 指纹检测同步），读端直接提出注释。
 * 注释风格按语言惯例：TS/JS 用 JSDoc `/**` 块；Go 用 `//` 行（贴近 godoc 惯例）。
 *
 * 机制：
 *   - 每个函数检查函数名上方是否有**语义化注释**。
 *   - 缺失 → LLM 依据 签名+函数体 生成一句"这函数做什么"，以 JSDoc 形式注入函数名上方。
 *   - 通过 `@fnhash <sha256(body)>` 标记体指纹：函数体一改 → 指纹变化 → 判为 **stale**，
 *     标记需要同步更新（LLM 重注）。任何编辑都会改 body，因此全改动路径天然被覆盖。
 *   - **只替换带自己 `@fnhash` 标记的块**，手写无标记注释一律不动（ok），绝不误删用户注释。
 *
 * 双形态：
 *   - 独立工具 annotate_functions（扫/只读/干跑/落盘）
 *   - 重构管线 stage（compute 纯计算返回 {absToNew, originals, units}，落盘/验证/回滚由管线负责）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseFileFull } from './ts_kernel/index.js';
import { loadLlmConfig, callChat } from './llm_focus.js';
import { scanProjectSourceFiles } from './detect_dead_imports.js';

/** 注释里的 body 指纹标记前缀 */
export const FNHASH_PREFIX = '@fnhash';

/** 每种语言函数注释状态 */
export type FnCommentStatus = 'ok' | 'missing' | 'stale';

export interface FnTarget {
  file: string;
  name: string;
  signature: string;
  /** 函数声明起始行（1-based） */
  startLine: number;
  /** 声明行缩进（注入注释时套用） */
  indent: string;
  /** 函数体源码（start_line..end_line），用于指纹与 LLM 描述 */
  body: string;
  bodyHash: string;
  status: FnCommentStatus;
  /** 既有注释块行（仅 stale 时用于替换） */
  blockLines: string[];
  /** 既有注释块起始行（0-based；-1=无） */
  blockStart: number;
}

export interface AnnotationSummary {
  files: number;
  scanned: number;
  with_comment: number;
  missing: number;
  stale: number;
  /** 本轮新注入注释数 */
  annotated: number;
  /** 本轮重注（stale 同步）数 */
  updated: number;
}

export interface AnnotationPlanResult {
  summary: AnnotationSummary;
  /** 待落盘 绝对路径 → 新内容（纯计算，不写盘） */
  absToNew: Map<string, string>;
  /** 原始内容（回滚用） */
  originals: Map<string, string>;
  note?: string;
}

// ─────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────
function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function isCommentLine(trim: string): boolean {
  return trim.startsWith('//') || trim.startsWith('/*') || trim.startsWith('*/') || trim.startsWith('*');
}

/** 提取声明行上方的既有注释块。
 *  - 仅当紧邻声明行上一行是注释行时才认定有"函数级"注释（避免吞掉文件头注释）。
 *  - 块 > 16 行视为文件头/大块说明（非函数级），返回无块（走插入走不通，视为缺失）。
 * 返回 [blockLines, blockStart0]。 */
function docBlock(lines: string[], decl0: number): { blockLines: string[]; blockStart: number } {
  const last = decl0 - 1;
  if (last < 0) return { blockLines: [], blockStart: -1 };
  if (!isCommentLine(lines[last].trim())) return { blockLines: [], blockStart: -1 };
  let s = last;
  while (s - 1 >= 0 && isCommentLine(lines[s - 1].trim())) s -= 1;
  if (last - s + 1 > 16) return { blockLines: [], blockStart: -1 };
  return { blockLines: lines.slice(s, last + 1), blockStart: s };
}

/** 从块文本提取已记录指纹；无返回 null */
function markerHash(blockLines: string[]): string | null {
  for (const ln of blockLines) {
    const m = /@fnhash\s+([0-9a-f]{64})/.exec(ln);
    if (m) return m[1];
  }
  return null;
}

/** 块是否含"描述性"正文（除 marker / 空 / 星号艺术行之外确有内容） */
function hasDescriptive(blockLines: string[]): boolean {
  return blockLines.some((ln) => {
    const t = ln.trim();
    if (t === '') return false;
    if (t === '*' || t === '/**' || t === '*/') return false;
    if (/@fnhash/.test(t)) return false;
    return true;
  });
}

/** 是否为纯状态归类：ok(有语义注释且指纹匹配或无指纹) / missing(无注释) / stale(有注释但 body 变了) */
function classify(existingLines: string[], bodyHash: string): FnCommentStatus {
  if (existingLines.length === 0) return 'missing';
  if (!hasDescriptive(existingLines)) return 'missing'; // 只有 marker/空 → 视为待补全
  const marker = markerHash(existingLines);
  if (marker === null) return 'ok'; // 手写无指纹注释：视为已注释，绝不改动
  return marker === bodyHash ? 'ok' : 'stale';
}

/** 判断函数体是否真空（{ } 之间无任何语句）。空体无可描述，不注。 */
function isEmptyBody(body: string): boolean {
  const i = body.indexOf('{');
  const j = body.lastIndexOf('}');
  if (i === -1 || j === -1 || j <= i) return true;
  return body.slice(i + 1, j).trim() === '';
}

/** 扫描单个源文件 → 函数目标列表（无 LLM，纯分类）。不读写异步依赖以外的状态。 */
export async function scanFileAnnotations(absFile: string): Promise<FnTarget[]> {
  const content = fs.readFileSync(absFile, 'utf-8');
  const lines = content.split(/\r?\n/);
  const parsed = await parseFileFull(absFile, content);
  if (parsed.error) return [];
  const out: FnTarget[] = [];
  for (const sym of parsed.symbols) {
    if (sym.kind !== 'function' && sym.kind !== 'method') continue;
    if (sym.start_line < 1 || sym.end_line < sym.start_line) continue;
    const decl = lines[sym.start_line - 1] ?? '';
    const indent = /^[ \t]*/.exec(decl)?.[0] ?? '';
    const body = lines.slice(sym.start_line - 1, sym.end_line).join('\n');
    if (isEmptyBody(body)) continue;
    const { blockLines, blockStart } = docBlock(lines, sym.start_line - 1);
    out.push({
      file: absFile,
      name: sym.name,
      signature: sym.signature,
      startLine: sym.start_line,
      indent,
      body,
      bodyHash: hashOf(body),
      status: classify(blockLines, hashOf(body)),
      blockLines,
      blockStart,
    });
  }
  return out;
}

/** 由 (indent, desc) 组注释块（含 @fnhash）。go=true 用 Go 惯例 `//` 行；否则 JSDoc 星号注释块。 */
function newBlock(go: boolean, indent: string, desc: string, hash: string): string[] {
  const raw = go
    ? [`// ${desc}`, '//', `// @${FNHASH_PREFIX} ${hash}`]
    : ['/**', ` * ${desc}`, ' *', ` * @${FNHASH_PREFIX} ${hash}`, '*/'];
  if (indent) return raw.map((ln) => (ln.trim() === '' ? '' : indent + ln));
  return raw;
}

/** 把待注入的函数目标应用到源码，返回新源码。targets 需已带 status 与（stale 时）新块。
 * 只做两件事：missing → 在声明行上方插入新块；stale → 用新块替换带指纹的旧块。 */
export function applyAnnotationsToSource(
  content: string,
  jobs: Array<{ startLine: number; status: FnCommentStatus; blockLines: string[]; blockStart: number; newBlock: string[] }>,
): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  // 自底向上应用，避免插入/替换造成的行号漂移
  const ops = jobs
    .map((j) => {
      if (j.status === 'missing') return { idx: j.startLine - 1, del: 0, ins: j.newBlock };
      if (j.status === 'stale') return { idx: j.blockStart, del: j.blockLines.length, ins: j.newBlock };
      return null;
    })
    .filter((o): o is { idx: number; del: number; ins: string[] } => o !== null)
    .sort((a, b) => b.idx - a.idx);
  for (const op of ops) lines.splice(op.idx, op.del, ...op.ins);
  return lines.join(eol);
}

/** LLM 批量生成描述（cfg 由调用方持有，便于复用/判空）。返回 Map: 目标索引 → 描述文本。 */
async function llmDescriptions(targets: FnTarget[], cfg: NonNullable<ReturnType<typeof loadLlmConfig>>): Promise<Map<number, string>> {
  if (targets.length === 0) return new Map();
  const items = targets
    .map((t, i) => {
      const bodyCap = t.body.length > 1400 ? t.body.slice(0, 1400) + '\n…(截断)' : t.body;
      return `- ${i}: 函数[${t.name}] 签名[${t.signature}] 体:\n\`\`\`\n${bodyCap}\n\`\`\``;
    })
    .join('\n');
  const prompt =
    `请为下列 TS/JS 函数各写一句**语义化注释**（中文，1-2 句，≤80 字），说明"这个函数在做什么"，` +
    `可顺带点出关键入参/返回值。只输出紧凑 JSON：{"comments":["注释0","注释1",...]}，顺序与列出的编号一致，共 ${targets.length} 个。\n\n${items}`;
  try {
    const text = await callChat(cfg, [{ role: 'user', content: prompt }], 0.2, 60_000);
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return new Map();
    const parsed = JSON.parse(m[0]) as { comments?: unknown };
    if (!Array.isArray(parsed.comments)) return new Map();
    const out = new Map<number, string>();
    parsed.comments.slice(0, targets.length).forEach((c, i) => {
      const s = String(c).trim();
      if (s && s.length <= 120) out.set(i, s);
    });
    return out;
  } catch {
    return new Map();
  }
}

// ─────────────────────────────────────────────
// 主入口（纯计算，不写盘；既是独立工具核心，也是管线 stage compute）
// ─────────────────────────────────────────────
export interface PlanAnnotationInput {
  project_dir: string;
  /** 显式绝对文件范围；缺省扫目录内 TS/JS 源文件 */
  absFiles?: string[];
  /** 是否用 LLM 补全/重注（默认 true；无 LLM 配置时退化仅扫描） */
  llm?: boolean;
}

export async function planFunctionAnnotation(input: PlanAnnotationInput): Promise<AnnotationPlanResult> {
  const summary: AnnotationSummary = { files: 0, scanned: 0, with_comment: 0, missing: 0, stale: 0, annotated: 0, updated: 0 };
  const absToNew = new Map<string, string>();
  const originals = new Map<string, string>();
  let note: string | undefined;
  const wantLlm = input.llm !== false;

  let absFiles = input.absFiles;
  if (!absFiles || absFiles.length === 0) {
    absFiles = scanProjectSourceFiles(input.project_dir).filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs|go)$/.test(f));
  }

  for (const f of absFiles) {
    if (!fs.existsSync(f)) continue;
    const targets = await scanFileAnnotations(f);
    if (targets.length === 0) continue;
    summary.files += 1;
    for (const t of targets) {
      summary.scanned += 1;
      if (t.status === 'ok') summary.with_comment += 1;
      else if (t.status === 'missing') summary.missing += 1;
      else summary.stale += 1;
    }
    // 需要补全/重注的
    const need = targets.filter((t) => t.status !== 'ok');
    if (need.length === 0) continue;

    let descs = new Map<number, string>();
    if (wantLlm) {
      const cfg = loadLlmConfig();
      if (!cfg) {
        note ??= '未配置 LLM，无法补全/重注注释（扫描结果仍如实上报）';
        continue;
      }
      descs = await llmDescriptions(need, cfg);
    } else continue;
    if (descs.size === 0) continue;

    const jobs: Array<{ startLine: number; status: FnCommentStatus; blockLines: string[]; blockStart: number; newBlock: string[] }> = [];
    const go = /\.go$/.test(f);
    for (let i = 0; i < need.length; i++) {
      const desc = descs.get(i);
      if (!desc) continue;
      const t = need[i];
      jobs.push({
        startLine: t.startLine,
        status: t.status,
        blockLines: t.blockLines,
        blockStart: t.blockStart,
        newBlock: newBlock(go, t.indent, desc, t.bodyHash),
      });
    }
    if (jobs.length === 0) continue;

    const original = fs.readFileSync(f, 'utf-8');
    const next = applyAnnotationsToSource(original, jobs);
    if (next === original) continue;
    absToNew.set(f, next);
    originals.set(f, original);
    for (const j of jobs) {
      if (j.status === 'missing') summary.annotated += 1;
      else summary.updated += 1;
    }
  }

  return { summary, absToNew, originals, note };
}