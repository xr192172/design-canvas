/**
 * harvest_decisions：从文档 / git 日志 / 注释提取设计意图线索，生成 draft 决策卡候选。
 *
 * 背景（决策卡补录）：现有项目（尤其外来/历史代码）没有决策卡历史，直接扫描必然失真。
 * 本工具不直接写 DSL——先取证（出处 ref + 原文 evidence + 一句话 draft_summary），
 * 产出可复核的候选；LLM review 后定稿（status: active）再写入 DSL。
 * draft 态保证补录有复核门槛，不污染活文档。
 *
 * 与契约（harvest-decisions DSL expected_apis）对齐：
 *   harvestDecisions(input: { feature; doc_dir?; git_root?; limit?; comment_files? }) → HarvestResult
 *
 * 策略（启发式，不假装精确）：
 *   - gitlog：最近提交 subject 里含设计意图关键词 → feature 级候选
 *   - doc：扫描 *.md 的标题/列表/段落，含设计意图关键词 → feature 级候选（ref=文件:行）
 *   - comment：显式指定源码文件，抓 JSDoc 注释块 → 文件级候选（ref=文件:行）
 *   - lifecycle_hint：evidence 含 下线/弃用/合并/取代/拆分 → 提示 lifecycle 演进，供 diff/归档参考
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

export type HarvestSource = 'doc' | 'gitlog' | 'comment';

export interface LifecycleHint {
  type: 'retired' | 'merged' | 'superseded' | 'split';
  detail: string;
}

/** 一条可复核的决策候选（draft，未写入 DSL） */
export interface HarvestCandidate {
  /** 挂载目标：feature 级用 feature 名；注释提取用文件相对路径 */
  file_path: string;
  source: HarvestSource;
  /** 出处（doc: 路径:行 / gitlog: hash / comment: 文件:行），复核依据 */
  ref: string;
  /** 提炼的一句话结论（draft，LLM review 后定稿） */
  draft_summary: string;
  /** 原始证据片段（可复核原文） */
  evidence: string;
  /** 推断的功能线 */
  thread?: string;
  /** 自由标签 */
  tags?: string[];
  /** 生命周期提示（下线/合并/取代/拆分），供 diff 与归档参考 */
  lifecycle_hint?: LifecycleHint;
}

export interface HarvestResult {
  message: string;
  feature: string;
  candidates: HarvestCandidate[];
}

export interface HarvestInput {
  /** feature 名（候选挂载目标） */
  feature: string;
  /** 文档目录（扫描 *.md），默认 <cwd>/docs */
  doc_dir?: string;
  /** git 仓库根（读 git log），默认 <cwd> */
  git_root?: string;
  /** git 日志条数上限，默认 30 */
  limit?: number;
  /** 显式指定要提取注释的源码文件（绝对路径） */
  comment_files?: string[];
}

// 设计意图关键词（启发式，宁多勿漏；draft 态保证后续复核）
const INTENT_KW = [
  '因为', '由于', '为了避免', '为避免', '为防止', '选择', '采用', '不用', '放弃', '不采用',
  '权衡', '约束', '设计方案', '方案', '设计', '弃用', '取代', '合并', '拆分', '下线',
  '为保证', '为支持', '以解决', '解决', '防止', '需要', '必须', '替代',
];

const LIFECYCLE_RULES: Array<{ kw: string[]; type: LifecycleHint['type'] }> = [
  { kw: ['弃用', '下线', '废弃', '删除'], type: 'retired' },
  { kw: ['合并', '并入'], type: 'merged' },
  { kw: ['取代', '替代', '替换'], type: 'superseded' },
  { kw: ['拆分', '拆开'], type: 'split' },
];

function lifecycleHint(text: string): LifecycleHint | undefined {
  for (const rule of LIFECYCLE_RULES) {
    for (const kw of rule.kw) {
      if (text.includes(kw)) {
        const idx = text.indexOf(kw);
        return { type: rule.type, detail: text.slice(Math.max(0, idx - 20), idx + 30).replace(/\s+/g, ' ').trim() };
      }
    }
  }
  return undefined;
}

function hasIntent(text: string): boolean {
  return INTENT_KW.some((k) => text.includes(k));
}

// ──────── git 日志提取 ────────

function gitLogEntries(gitRoot: string, limit: number): Array<{ hash: string; subject: string }> {
  try {
    const out = execSync(`git log -n ${limit} --pretty=format:%H%x09%s`, {
      cwd: gitRoot,
      encoding: 'utf-8',
      maxBuffer: 4 * 1024 * 1024,
    });
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        return tab > 0 ? { hash: line.slice(0, tab).slice(0, 8), subject: line.slice(tab + 1) } : null;
      })
      .filter((x): x is { hash: string; subject: string } => x !== null);
  } catch {
    return []; // 非 git 仓库或无 git：静默跳过
  }
}

// ──────── 文档提取 ────────

function collectMdFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith('.md')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function scanDocs(docDir: string): HarvestCandidate[] {
  const candidates: HarvestCandidate[] = [];
  for (const md of collectMdFiles(docDir)) {
    if (!fs.existsSync(md)) continue;
    const lines = fs.readFileSync(md, 'utf-8').split('\n');
    let heading = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const h = line.match(/^#{1,4}\s+(.+)$/);
      if (h) {
        heading = h[1].trim();
        continue;
      }
      // 列表项/段落：去掉 markdown 装饰后判断是否有设计意图
      const clean = line.replace(/^[-*•]\s+/, '').replace(/^#+\s*/, '').trim();
      if (clean.length < 12 || !hasIntent(clean)) continue;
      const ref = `${path.relative(process.cwd(), md) || md}:${i + 1}`;
      candidates.push({
        file_path: '',
        source: 'doc',
        ref,
        draft_summary: `[${heading || path.basename(md)}] ${clean.slice(0, 80)}${clean.length > 80 ? '…' : ''}`,
        evidence: clean.slice(0, 200),
        thread: heading || undefined,
        lifecycle_hint: lifecycleHint(clean),
      });
    }
  }
  return candidates;
}

// ──────── 注释提取 ────────

function scanComments(files: string[]): HarvestCandidate[] {
  const candidates: HarvestCandidate[] = [];
  for (const f of files) {
    if (!fs.existsSync(f) || !/\.(ts|tsx|js|jsx|go|py)$/.test(f)) continue;
    const content = fs.readFileSync(f, 'utf-8');
    const blockRe = /\/\*\*([\s\S]*?)\*\//g;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(content)) !== null) {
      const block = m[1];
      const lines = block.split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trim()).filter(Boolean);
      if (lines.length === 0) continue;
      const first = lines[0];
      // 意图判断放宽到整块（首行常是描述性文字，rationale 在后续行才出现"因为/避免"）
      if (!hasIntent(lines.join(' '))) continue;
      const lineNo = content.slice(0, m.index).split('\n').length;
      const rel = path.relative(process.cwd(), f) || f;
      candidates.push({
        file_path: rel,
        source: 'comment',
        ref: `${rel}:${lineNo}`,
        draft_summary: first.slice(0, 100),
        evidence: lines.slice(0, 6).join(' ').slice(0, 240),
        lifecycle_hint: lifecycleHint(lines.join(' ')),
      });
    }
  }
  return candidates;
}

// ──────── 主入口 ────────

export function harvestDecisions(input: HarvestInput): HarvestResult {
  const { feature } = input;
  const limit = input.limit ?? 30;
  const gitRoot = input.git_root ?? process.cwd();
  const docDir = input.doc_dir ?? path.join(process.cwd(), 'docs');

  const candidates: HarvestCandidate[] = [];

  // git 日志：提交 subject 即"为什么改"的一手线索
  for (const { hash, subject } of gitLogEntries(gitRoot, limit)) {
    if (!hasIntent(subject)) continue;
    candidates.push({
      file_path: feature,
      source: 'gitlog',
      ref: `git:${hash}`,
      draft_summary: subject,
      evidence: subject,
      tags: ['gitlog'],
      lifecycle_hint: lifecycleHint(subject),
    });
  }

  // 文档：设计意图段落
  candidates.push(...scanDocs(docDir));

  // 注释：显式指定的源码文件
  if (input.comment_files?.length) candidates.push(...scanComments(input.comment_files));

  const lines = [
    `harvest_decisions [${feature}] 提取到 ${candidates.length} 条决策候选（draft，未写入 DSL）`,
    `  来源分布: gitlog ${candidates.filter((c) => c.source === 'gitlog').length} · doc ${candidates.filter((c) => c.source === 'doc').length} · comment ${candidates.filter((c) => c.source === 'comment').length}`,
    '',
    ...candidates.map((c, i) => {
      const lh = c.lifecycle_hint ? `  ⚠ lifecycle:${c.lifecycle_hint.type}` : '';
      const th = c.thread ? `  [${c.thread}]` : '';
      return `  ${i + 1}. [${c.source}] ${c.draft_summary}${th}${lh}\n      ↳ 出处: ${c.ref}\n      ↳ 证据: ${c.evidence}`;
    }),
    '',
    '用法: LLM review 上述候选（核对出处/原文），定稿后通过 edit_dsl / 决策卡工具写入 DSL（status: active）。',
  ];
  return { message: lines.join('\n'), feature, candidates };
}
