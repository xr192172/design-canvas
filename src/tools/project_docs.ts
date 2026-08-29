/**
 * project_docs —— 每项目文档夹 → LLM 决策上下文（阶段 C · 文档注入）
 *
 * 设计（用户拍板路线：按批关联注入 + 项目仓库 docs/ + frontmatter 关联兜底文件名）：
 *   1. 文档夹位置：<project_dir>/docs/**\/*.md（project_dir = feature 的 source_root，
 *      即真实项目仓库，文档跟代码同库）；兜底 <dataHome>/.design-canvas/docs/<feature>/。
 *   2. 关联方式：文档头部 frontmatter 写 feature/steps/files 元信息（精确关联），
 *      未写 frontmatter 时按文件名关键词（拆 [-_ ]）对目标名做包含匹配（兜底）。
 *   3. 注入粒度（按批）：一次决策一批工单时，汇总这批工单涉及的 功能/步骤/文件 集合，
 *      只取命中该集合的文档正文注入（token 封顶）；全部文档只以"目录清单（TOC）"形式注入，
 *      让 LLM 知道存在哪些文档但不灌全文。
 *
 * 对外：
 *   - buildDocsPromptBlock(targets)：llm_decider 用它拼 prompt 注入块
 *   - listProjectDocs / readProjectDoc：read_project_docs 工具 + docs Resource 用
 */

import fs from 'node:fs';
import path from 'node:path';
import { getStorageRoot } from '../storage.js';

/** 单篇项目文档的索引条目 */
export interface ProjectDoc {
  /** 稳定 id（相对路径，/ 分隔） */
  id: string;
  /** 文件名（含扩展名） */
  name: string;
  /** 相对文档夹的路径 */
  rel: string;
  /** 绝对路径 */
  abs: string;
  /** frontmatter 声明的关联（精确关联） */
  tags: { features: string[]; steps: string[]; files: string[] };
  /** 是否来自 frontmatter（false = 文件名关键词兜底匹配） */
  tagged: boolean;
  /** 行数 */
  lines: number;
  /** 首行标题（# xxx 或前 24 字） */
  title: string;
}

export interface DocsManifest {
  docs: ProjectDoc[];
  dir: string | null;
}

const MAX_DOC_LINES = 300; // 单篇注入正文封顶
const MAX_MATCHED_DOCS = 5; // 单批注入正文封顶篇数
const TOC_PREVIEW = 32; // TOC 里每篇展示的正文预览字数

// ─────────────────────────────────────────────────────────────
// 文档夹定位
// ─────────────────────────────────────────────────────────────

/** frontmatter tags：单行 "a、b" / "a,b" / "a b" 均可，中文顿号/逗号/空格分割 */
function parseTagLine(v: unknown): string[] {
  if (typeof v !== 'string') return [];
  return v
    .split(/[、,，;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 解析 md 头部 frontmatter（--- 围栏；YAML 子集：feature/steps/files/tags 逐行） */
function parseFrontmatter(text: string): { features: string[]; steps: string[]; files: string[] } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return { features: [], steps: [], files: [] };
  const tags: { features: string[]; steps: string[]; files: string[] } = { features: [], steps: [], files: [] };
  for (const line of m[1].split(/\r?\n/)) {
    const mm = /^\s*([A-Za-z_]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (!mm) continue;
    const val = parseTagLine(mm[2]);
    if (mm[1] === 'feature' || mm[1] === 'features') tags.features.push(...val);
    else if (mm[1] === 'step' || mm[1] === 'steps') tags.steps.push(...val);
    else if (mm[1] === 'file' || mm[1] === 'files') tags.files.push(...val);
  }
  return tags;
}

/** 文档夹候选路径：主=项目仓库 docs/，兜底=受管目录 */
function docDirs(project_dir: string, feature: string): string[] {
  const dirs: string[] = [];
  if (project_dir) dirs.push(path.join(project_dir, 'docs'));
  dirs.push(path.join(getStorageRoot(), 'docs', feature));
  return dirs;
}

/** 扫描一个目录下的 *.md（顶层 + 一层子目录，防深递归） */
function scanDir(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isFile() && /\.md$/i.test(ent.name)) out.push(abs);
    else if (ent.isDirectory() && !ent.name.startsWith('.') && !ent.name.startsWith('node_modules')) {
      for (const sub of fs.readdirSync(abs)) {
        const subAbs = path.join(abs, sub);
        if (fs.statSync(subAbs).isFile() && /\.md$/i.test(sub)) out.push(subAbs);
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 清单 + 读取
// ─────────────────────────────────────────────────────────────

export function listProjectDocs(project_dir: string, feature: string): DocsManifest {
  const docs: ProjectDoc[] = [];
  let dir: string | null = null;
  for (const d of docDirs(project_dir, feature)) {
    for (const abs of scanDir(d)) {
      const rel = path.relative(d, abs);
      const raw = fs.readFileSync(abs, 'utf8');
      const tags = parseFrontmatter(raw);
      const lines = raw.split(/\r?\n/).length;
      const titleLine = raw.split(/\r?\n/).find((l) => l.startsWith('#'))?.replace(/^#+\s*/, '').trim();
      docs.push({
        id: rel.replace(/\\/g, '/'),
        name: path.basename(abs),
        rel: rel.replace(/\\/g, '/'),
        abs,
        tags,
        tagged: tags.features.length > 0 || tags.steps.length > 0 || tags.files.length > 0,
        lines,
        title: titleLine || rel.replace(/\.md$/i, '').replace(/[_-]/g, ' ').slice(0, 40),
      });
      dir ??= d;
    }
  }
  docs.sort((a, b) => a.id.localeCompare(b.id));
  return { docs, dir };
}

export function readProjectDoc(project_dir: string, feature: string, id: string): string | null {
  const man = listProjectDocs(project_dir, feature);
  const doc = man.docs.find((d) => d.id === id);
  return doc ? fs.readFileSync(doc.abs, 'utf8') : null;
}

// ─────────────────────────────────────────────────────────────
// 匹配（frontmatter 精确 + 文件名关键词兜底）
// ─────────────────────────────────────────────────────────────

/** 目标集合：一批工单涉及的功能/步骤/文件 */
export interface DocTargetSet {
  features: string[];
  steps: string[];
  files: string[];
}

function hit(needle: string, haystacks: string[]): boolean {
  if (!needle) return false;
  const n = needle.toLowerCase();
  return haystacks.some((h) => h.toLowerCase().includes(n));
}

/** 文件名关键词（拆 -_ 空格 后的小写 token） */
function nameTokens(doc: ProjectDoc): string[] {
  return doc.name
    .replace(/\.md$/i, '')
    .split(/[-_.\s]+/)
    .filter((s) => s.length >= 2)
    .map((s) => s.toLowerCase());
}

/** 单篇文档是否命中目标集合 */
function docMatches(doc: ProjectDoc, t: DocTargetSet): { matched: boolean; via: 'frontmatter' | 'filename' } {
  const features = t.features ?? [];
  const steps = t.steps ?? [];
  const files = t.files ?? [];
  // 精确关联（frontmatter）：任一类目有交集即命中
  if (doc.tags.files.length > 0 && files.some((f) => doc.tags.files.some((tf) => f.toLowerCase().includes(tf.toLowerCase())))) {
    return { matched: true, via: 'frontmatter' };
  }
  if (doc.tags.features.length > 0 && features.some((f) => doc.tags.features.some((tf) => f.toLowerCase().includes(tf.toLowerCase())))) {
    return { matched: true, via: 'frontmatter' };
  }
  if (doc.tags.steps.length > 0 && steps.some((s) => doc.tags.steps.some((ts) => s.toLowerCase().includes(ts.toLowerCase())))) {
    return { matched: true, via: 'frontmatter' };
  }
  // 文件名关键词兜底：任一 token 命中任一目标名
  if (!doc.tagged) {
    const tokens = nameTokens(doc);
    if (tokens.length > 0) {
      const allNames = [...features, ...steps, ...files.map((f) => path.basename(f))].map((s) => s.toLowerCase());
      if (tokens.some((tok) => allNames.some((n) => n.includes(tok)))) return { matched: true, via: 'filename' };
    }
  }
  return { matched: false, via: 'filename' };
}

/** 按批匹配：从清单取命中目标集合的文档（封顶） */
export function matchDocsForTargets(man: DocsManifest, targets: DocTargetSet, maxDocs = MAX_MATCHED_DOCS): ProjectDoc[] {
  const hits = man.docs
    .map((d) => ({ doc: d, r: docMatches(d, targets) }))
    .filter((x) => x.r.matched)
    .sort((a, b) => (a.r.via === 'frontmatter' ? -1 : 1) - (b.r.via === 'frontmatter' ? -1 : 1));
  return hits.slice(0, maxDocs).map((x) => x.doc);
}

// ─────────────────────────────────────────────────────────────
// Prompt 注入块（TOC 全量 + 命中正文封顶）
// ─────────────────────────────────────────────────────────────

/** 拼注入块：先全量 TOC（让 LLM 知道有哪些文档），再命中文档正文（截断封顶） */
export function buildDocsPromptBlock(
  man: DocsManifest,
  targets: DocTargetSet,
  maxLines = MAX_DOC_LINES,
  maxDocs = MAX_MATCHED_DOCS,
): string {
  if (man.docs.length === 0) return '';
  const toc = man.docs
    .map((d) => `- \`${d.id}\`（${d.lines} 行${d.tagged ? '·已关联' : '·未标记'}）：${d.title}`)
    .join('\n');
  const matched = matchDocsForTargets(man, targets, maxDocs);
  const body =
    matched.length === 0
      ? ''
      : '\n## 命中批内节点的项目文档（正文）\n' +
        matched
          .map((d) => {
            const lines = fs.readFileSync(d.abs, 'utf8').split(/\r?\n/);
            const cap = Math.max(1, maxLines);
            const truncated = lines.length > cap;
            return `### ${d.id}\n\`\`\`md\n${lines.slice(0, cap).join('\n')}${truncated ? '\n…(截断，共 ' + lines.length + ' 行)' : ''}\n\`\`\``;
          })
          .join('\n\n');
  return `## 项目文档清单（docs/，共 ${man.docs.length} 篇）\n${toc}${body}`;
}
