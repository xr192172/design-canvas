/**
 * dictionary —— 伪维基双层术语词典（路线图序号 12）
 *
 * 通用术语词典（先有语言概念，现升级为"伪维基"）：
 *   - 全局词典（<dataHome>/.design-canvas/dict.global.json）：通用概念，跨语言/跨项目共享。
 *     不限于编程模式，任何通用术语（如「异步」「缓存」「依赖注入」乃至「维基百科」「算法」）
 *     都可收录。词条解释里命中其他已收录词 → 自动高亮并可点击跳转（词条互链）。
 *   - 项目词典（<projectRoot>/.design-canvas/dict.project.json）：项目专有词（函数名/库名/业务术语）。
 *
 * 词条结构：{ term, kind: 'global'|'project', newbie, pm, senior, generated_at, aliases? }
 *   - newbie / pm / senior：三档角色解释（复用 explain_gen 的角色化文案口径）
 *   - aliases：同义词/相关词，用于提高命中率（可选）
 *
 * 互链索引：加载词典后扫描所有解释文本，命中其他词条 term 即建立 term → links[] 映射。
 * 互链是"伪维基"的灵魂：解释里提到的已收录词也高亮可点。
 *
 * 数据源零新增：纯 JSON 文件读写，不依赖 cache.db / DSL，可独立运行。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDataHome } from '../storage.js';

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

export type DictKind = 'global' | 'project';

export interface DictEntry {
  /** 词条主词（规范写法） */
  term: string;
  /** 所属词典：global（通用概念）| project（项目专有） */
  kind: DictKind;
  /** 口语解释（面向新人） */
  newbie: string;
  /** 业务价值解释（面向产品/管理者） */
  pm: string;
  /** 技术实现解释（面向资深开发） */
  senior: string;
  /** 同义词/别名，提高命中率（可选） */
  aliases?: string[];
  /** 生成时间 ISO */
  generated_at: string;
}

/** 互链：词条 → 其解释文本中命中的其他词条 term 列表 */
export interface DictLinks {
  [term: string]: string[];
}

/** 词典聚合视图（供前端渲染/高亮） */
export interface DictionaryView {
  /** 全部词条（global + project 合并，project 覆盖同名 global） */
  entries: DictEntry[];
  /** 互链索引：term → 命中的其他 term 列表 */
  links: DictLinks;
  /** 词条 → 别名集合（用于高亮命中） */
  aliasesIndex: Record<string, string[]>;
}

// ─────────────────────────────────────────────────────────────
// 存储路径 + 安全校验
// ─────────────────────────────────────────────────────────────

/** 可信允许的项目根集合（可按需扩展）：当前工作目录及其显式子目录；
 *  真实部署时应由配置/启动参数注入。这里采取"默认拒绝、显式放行"策略，
 *  防止路径穿越写入系统目录、其他用户目录或敏感挂载点。 */
let _allowedRoots: string[] | null = null;

export function setAllowedProjectRoots(roots: string[]): void {
  _allowedRoots = roots.map((r) => path.resolve(r)).filter(Boolean);
}

function getAllowedRoots(): string[] {
  if (_allowedRoots) return _allowedRoots;
  return [path.resolve(process.cwd()), path.resolve(getDataHome())];
}

/**
 * 安全校验 project_dir：拒绝路径穿越、拒绝放行范围外的绝对路径。
 * 安全通过后返回规范化后的绝对路径；校验失败抛错。
 *  所有接受外部输入 projectRoot 的 API（HTTP / MCP）必须先通过本函数。
 */
export function validateProjectRoot(projectRoot: string, context = 'project_dir'): string {
  if (!projectRoot || typeof projectRoot !== 'string') {
    throw new Error(`${context} 不能为空`);
  }
  const raw = projectRoot.trim();
  if (!raw) throw new Error(`${context} 不能为空或纯空白`);

  // 1. 显式禁止穿越字面量：防止有人用"....//"之类变体绕过 resolve（双重保险）
  if (/\.{2,}[/\\]/.test(raw) || /[/\\]\.{2,}$/.test(raw) || raw === '..' || /^[.]{2,}[./\\]/.test(raw)) {
    throw new Error(`${context} 包含路径穿越（..），请使用项目内合法相对/绝对路径`);
  }
  // 2. 规范化绝对路径
  let resolved: string;
  try {
    resolved = path.resolve(raw);
  } catch (e) {
    throw new Error(`${context} 路径解析失败：${(e as Error).message}`);
  }
  // 3. 再次校验 normalize 后的路径不能含 ..（已解析完成仍出现 .. 说明是异常路径，如 Windows 卷影）
  if (resolved.includes('..')) {
    throw new Error(`${context} 规范化后仍含穿越段，拒绝执行`);
  }
  // 4. 白名单：必须落在允许根目录之一的子树内
  const allowed = getAllowedRoots();
  const ok = allowed.some((r) => {
    const withSep = r.endsWith(path.sep) ? r : r + path.sep;
    return resolved === r || resolved.startsWith(withSep);
  });
  if (!ok) {
    throw new Error(
      `${context} 超出允许范围（仅允许写入当前项目：${allowed.join(' ; ')}）。` +
        `如需跨项目，请在服务端 setAllowedProjectRoots 显式放行。`,
    );
  }
  return resolved;
}

/** 全局词典路径：<dataHome>/.design-canvas/dict.global.json */
export function getGlobalDictFile(): string {
  return path.join(getDataHome(), '.design-canvas', 'dict.global.json');
}

/** 项目词典路径：<projectRoot>/.design-canvas/dict.project.json
 *  ⚠️  外部输入 projectRoot 时，必须先经 validateProjectRoot 校验，本函数假设已安全通过。 */
export function getProjectDictFile(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), '.design-canvas', 'dict.project.json');
}

// ─────────────────────────────────────────────────────────────
// 底层读写（单文件）
// ─────────────────────────────────────────────────────────────

function readDictFile(file: string): DictEntry[] {
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e) =>
        e && typeof e.term === 'string' &&
        typeof e.newbie === 'string' && typeof e.pm === 'string' && typeof e.senior === 'string',
    ) as DictEntry[];
  } catch {
    return []; // 损坏即忽略，不阻塞
  }
}

function writeDictFile(file: string, entries: DictEntry[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(entries, null, 2), 'utf-8');
}

/** 读全局词典 */
export function loadGlobalDict(): DictEntry[] {
  return readDictFile(getGlobalDictFile());
}

/** 读指定项目词典；若项目根与全局 dataHome 相同，则项目词典跳过（避免自嵌套）。
 *  ⚠️  外部输入 projectRoot 时，必须先经 validateProjectRoot 校验。 */
export function loadProjectDict(projectRoot: string): DictEntry[] {
  const root = validateProjectRoot(projectRoot, 'loadProjectDict projectRoot');
  if (root === path.resolve(getDataHome())) return []; // 项目即全局，避免重复
  return readDictFile(getProjectDictFile(root));
}

/**
 * 保存词条到全局词典（按 term 覆盖）。
 * 返回写入后的全局词条数。
 */
export function saveGlobalEntry(entry: DictEntry): number {
  const entries = loadGlobalDict();
  const idx = entries.findIndex((e) => e.term === entry.term);
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  writeDictFile(getGlobalDictFile(), entries);
  return entries.length;
}

/**
 * 保存词条到项目词典（按 term 覆盖）。
 * 入口强制路径安全校验，避免外部传入恶意 projectRoot 造成任意目录写入。
 * 返回写入后的项目词条数。
 */
export function saveProjectEntry(projectRoot: string, entry: DictEntry): number {
  const root = validateProjectRoot(projectRoot, 'saveProjectEntry projectRoot');
  const file = getProjectDictFile(root);
  const entries = readDictFile(file);
  const idx = entries.findIndex((e) => e.term === entry.term);
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  writeDictFile(file, entries);
  return entries.length;
}

// ─────────────────────────────────────────────────────────────
// 词典聚合 + 互链索引
// ─────────────────────────────────────────────────────────────

/**
 * 构建聚合视图：project 覆盖同名 global，生成互链索引与别名索引。
 * @param projectRoot 项目根（用于加载项目词典）；传 null 则只看全局。
 */
export function buildDictionaryView(projectRoot?: string | null): DictionaryView {
  const global = loadGlobalDict().map((e) => ({ ...e, kind: 'global' as DictKind }));
  const project = projectRoot ? loadProjectDict(projectRoot).map((e) => ({ ...e, kind: 'project' as DictKind })) : [];

  // project 覆盖同名 global（按 term 去重，project 优先）
  const byTerm = new Map<string, DictEntry>();
  for (const e of global) byTerm.set(e.term, e);
  for (const e of project) byTerm.set(e.term, e);
  const entries = [...byTerm.values()];

  // 别名索引：规范 term → 所有可命中写法（含自身 + 别名，小写化）
  const aliasesIndex: Record<string, string[]> = {};
  for (const e of entries) {
    const terms = [e.term, ...(e.aliases ?? [])].map((t) => t.toLowerCase());
    for (const t of terms) {
      if (!aliasesIndex[t]) aliasesIndex[t] = [];
      if (aliasesIndex[t].indexOf(e.term) === -1) aliasesIndex[t].push(e.term);
    }
  }

  // 互链索引：扫描每条解释文本，命中其他词条 term → 建立链接
  const links: DictLinks = {};
  const termSet = new Set(entries.map((e) => e.term.toLowerCase()));
  for (const e of entries) {
    const texts = [e.newbie, e.pm, e.senior, ...(e.aliases ?? [])].join(' ');
    const linked = new Set<string>();
    for (const other of entries) {
      if (other.term === e.term) continue;
      if (texts.toLowerCase().includes(other.term.toLowerCase())) {
        linked.add(other.term);
      }
    }
    if (linked.size > 0) links[e.term] = [...linked];
  }

  return { entries, links, aliasesIndex };
}

/**
 * 在给定的解释文本中标记命中词典的词。
 * 返回按出现顺序去重后的命中词条 term 列表（已按 term 去重）。
 * 高亮命中用：文本包含某个词条（或别名）即命中。
 */
export function findDictHits(
  text: string,
  view: DictionaryView,
): Array<{ term: string; start: number; end: number }[]> {
  // 兼容旧接口：返回分组。实际高亮用 highlightText 更直接。
  const lower = text.toLowerCase();
  const found: Array<{ term: string; start: number; end: number }[]> = [];
  const seen = new Set<string>();
  // 按词条在文本中所有出现位置收集
  for (const e of view.entries) {
    const candidates = [e.term, ...(e.aliases ?? [])].map((t) => t.toLowerCase());
    const positions: Array<{ term: string; start: number; end: number }> = [];
    for (const c of candidates) {
      let from = 0;
      let i = lower.indexOf(c, from);
      while (i !== -1) {
        positions.push({ term: e.term, start: i, end: i + c.length });
        from = i + c.length;
        i = lower.indexOf(c, from);
      }
    }
    if (positions.length > 0) {
      found.push(positions);
      seen.add(e.term);
    }
  }
  return found;
}

/**
 * 将一段文本按命中词典的词拆分为高亮片段。
 * 返回 [{ text, term? }]，term 存在即需高亮并关联词条。
 * 用于前端 tooltip 渲染：把解释文字中的已收录词包成可点击高亮。
 */
export function splitHighlights(text: string, view: DictionaryView): Array<{ text: string; term?: string }> {
  if (!text || !text.trim()) return [{ text }];
  const lower = text.toLowerCase();

  // 收集所有命中区间（term → 起始位置），按起始位置排序
  type Span = { start: number; end: number; term: string };
  const spans: Span[] = [];
  for (const e of view.entries) {
    const candidates = [e.term, ...(e.aliases ?? [])].map((t) => t.toLowerCase()).filter((t) => t.length > 0);
    for (const c of candidates) {
      let from = 0;
      let i = lower.indexOf(c, from);
      while (i !== -1) {
        spans.push({ start: i, end: i + c.length, term: e.term });
        from = i + c.length;
        i = lower.indexOf(c, from);
      }
    }
  }
  if (spans.length === 0) return [{ text }];

  // 按起始排序，合并重叠区间（保留较长者）
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start < last.end) {
      // 重叠：保留覆盖更长的
      if (s.end > last.end) last.end = s.end;
    } else {
      merged.push({ ...s });
    }
  }

  // 切分
  const out: Array<{ text: string; term?: string }> = [];
  let cursor = 0;
  for (const s of merged) {
    if (s.start > cursor) out.push({ text: text.slice(cursor, s.start) });
    out.push({ text: text.slice(s.start, s.end), term: s.term });
    cursor = s.end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor) });
  return out;
}