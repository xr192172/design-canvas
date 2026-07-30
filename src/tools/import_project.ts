/**
 * import_project 工具：扫描现有项目 → 自动生成 design-canvas DSL
 *
 * 降低工具门槛：新用户无需手写 DSL，指向项目目录即可得到初始设计图，
 * 随后在画布上迭代（人改几何层 / LLM 改语义层）。
 *
 * 产出：
 *   - geometry.nodes：目录容器节点（type=module）+ 文件节点（type=file，status=done）
 *   - geometry.edges：contains（目录父子/文件归属）+ imports（跨文件依赖）
 *   - semantic.files：每文件 expected_apis/actual_apis = tree-sitter 解析出的符号签名
 *
 * 布局：递归分组布局——目录容器紧凑包裹子节点，组内按依赖拓扑分列，
 * 避免自由依赖布局导致容器互相遮罩。
 *
 * 依赖解析：
 *   - 相对导入（./ ../，Python 前导点）→ 按文件系统解析
 *   - Go 包路径 → 读 go.mod module 前缀，映射到包目录下全部 .go 文件
 *   - Python 点分模块 → 点转路径，先试项目根再试导入者目录
 *   - 其他包导入（npm 包、标准库）→ 外部依赖，跳过
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DesignDSL, Node, Edge, SemanticFile, ExpectedApi } from '../dsl/types.js';
import { saveDSL } from '../storage.js';
import { parseFileFull, isSupported } from './ts_kernel/index.js';
import type { ParsedImport } from './ts_kernel/index.js';
import { countLines, assessLines } from './monolith.js';
import type { Database } from '../db/db.js';
import { syncProject, getFileParse, pruneDeletedFiles } from '../db/symbols.js';

export interface ImportProjectInput {
  /** 目标项目根目录（绝对路径或相对 cwd） */
  project_dir: string;
  /** 新 feature 名（^[a-zA-Z0-9_-]+$） */
  feature: string;
  /** 显示标题（默认等于 feature） */
  title?: string;
  /** 最多解析文件数（默认 200，防止大项目失控） */
  max_files?: number;
  /** 是否包含测试文件（默认 false，测试文件通常是架构噪声） */
  include_tests?: boolean;
  /**
   * 可选：符号缓存（openDb 的返回值）。提供时走增量路径——
   * content_hash 未变的文件直接读 cache.db，跳过重解析；
   * 变更文件由 syncFile 解析并写回缓存，下次运行受益。
   */
  cache_db?: Database;
}

export interface ImportProjectResult {
  message: string;
  feature: string;
  files_parsed: number;
  symbols_found: number;
  dep_edges: number;
  dirs_created: number;
  skipped: string[];
  /** 缓存增量统计（仅 cache_db 提供时存在）：hits=未变命中 reparsed=重解析 failed=失败 */
  cache?: { hits: number; reparsed: number; failed: number };
}

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/** 遍历跳过的目录名 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'output',
  'vendor', '__pycache__', '.design-canvas', 'coverage', 'target', 'bin', 'obj',
  '.next', '.nuxt', '.venv', 'venv', '.idea', '.vscode', '.backup', 'scaffold',
  '.pytest_cache', '.mypy_cache', '.tox', 'egg-info',
]);

/** 跳过的文件模式（测试/生成物，非架构） */
const SKIP_FILE_RE = /(_test\.go$|\.test\.[tj]sx?$|\.spec\.[tj]sx?$|\.min\.js$|\.d\.ts$|\.gen\.[tj]sx?$|test_.*\.py$|.*_test\.py$)/;

/** 布局常量（与渲染器父节点约定一致：padding 20 + title 30） */
const FILE_W = 240;
const FILE_H = 64;
const COL_GAP = 110;
const ROW_GAP = 40; // 给边绕障留出穿行通道（障碍检测 margin=10×2 + 线宽）
const PAD = 20;
const TITLE_H = 30;
const MARGIN = 60;

/** 布局常量导出（relayout_nested 恢复脚本复用，保证容器尺寸约定一致） */
export const IMPORT_LAYOUT = { FILE_W, FILE_H, COL_GAP, ROW_GAP, PAD, TITLE_H, MARGIN };

/** 各语言文件节点配色（深色主题协调） */
const LANG_COLORS: Record<string, { bg: string; color: string }> = {
  go: { bg: '#1a4a7a', color: '#ffffff' },
  ts: { bg: '#1565c0', color: '#ffffff' },
  tsx: { bg: '#1565c0', color: '#ffffff' },
  js: { bg: '#6d5c10', color: '#fff9c4' },
  jsx: { bg: '#6d5c10', color: '#fff9c4' },
  py: { bg: '#1a5f3a', color: '#ffffff' },
};
const DEFAULT_FILE_COLOR = { bg: '#37474f', color: '#eceff1' };
const DIR_STYLE = { bg: '#152141', color: '#90caf9' };

// ─────────────────────────────────────────────────────────────
// 文件扫描
// ─────────────────────────────────────────────────────────────

function walkFiles(root: string, includeTests: boolean): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(full);
      } else if (e.isFile()) {
        if (!includeTests && SKIP_FILE_RE.test(e.name)) continue;
        if (isSupported(path.extname(e.name))) out.push(full);
      }
    }
  }
  // 确定性顺序
  return out.sort();
}

// ─────────────────────────────────────────────────────────────
// import 解析 → 内部文件
// ─────────────────────────────────────────────────────────────

interface FileEntry {
  /** 相对项目根的 posix 路径（如 src/tools/a.ts） */
  rel: string;
  abs: string;
  ext: string;
  dir: string;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Go module 条目：module 路径 + go.mod 所在目录（相对项目根，'' 表示根） */
interface GoModule {
  module: string;
  dir: string;
}

/**
 * 读取项目内全部 go.mod（支持多模块/monorepo）。
 * 按 module 路径长度降序，保证最长前缀优先匹配
 * （如 example.com/a/v2 优先于 example.com/a）。
 */
function readGoModules(root: string): GoModule[] {
  const mods: GoModule[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(full);
      } else if (e.isFile() && e.name === 'go.mod') {
        try {
          const content = fs.readFileSync(full, 'utf-8');
          const m = content.match(/^\s*module\s+(\S+)/m);
          if (m) {
            const rel = toPosix(path.relative(root, dir));
            mods.push({ module: m[1], dir: rel === '.' ? '' : rel });
          }
        } catch {
          /* 忽略读取失败的 go.mod */
        }
      }
    }
  }
  return mods.sort((a, b) => b.module.length - a.module.length);
}

/** 扩展名解析优先级（同名无扩展名路径碰撞时，排名靠前者胜出——.ts 优先于编译产物 .js） */
const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go'];

/** 构建查找索引：无扩展名路径 / 目录路径 → 文件 rel 列表 */
function buildIndex(files: FileEntry[]): {
  byNoExt: Map<string, FileEntry>;
  byDir: Map<string, FileEntry[]>;
  /** 同名不同扩展名的碰撞记录（被丢弃的一方），用于结果可见性 */
  collisions: string[];
} {
  const byNoExt = new Map<string, FileEntry>();
  const byDir = new Map<string, FileEntry[]>();
  const collisions: string[] = [];
  const extRank = (f: FileEntry): number => {
    const i = RESOLVE_EXTS.indexOf(f.ext);
    return i === -1 ? RESOLVE_EXTS.length : i;
  };
  const setNoExt = (key: string, f: FileEntry): void => {
    const prev = byNoExt.get(key);
    if (!prev) {
      byNoExt.set(key, f);
      return;
    }
    if (prev.rel === f.rel) return;
    // 碰撞：保留扩展名优先级高者，另一方记录（静默覆盖会错连依赖边）
    if (extRank(f) < extRank(prev)) {
      byNoExt.set(key, f);
      collisions.push(`${prev.rel}（与 ${f.rel} 同名，依赖解析采用后者）`);
    } else {
      collisions.push(`${f.rel}（与 ${prev.rel} 同名，依赖解析采用后者）`);
    }
  };
  for (const f of files) {
    const noExt = f.rel.slice(0, f.rel.length - f.ext.length);
    setNoExt(noExt, f);
    const list = byDir.get(f.dir) || [];
    list.push(f);
    byDir.set(f.dir, list);
    // index 文件额外注册目录本身（import './dir' → ./dir/index.ts）
    const base = path.posix.basename(noExt);
    if (base === 'index' || base === '__init__' || base === 'mod') {
      setNoExt(f.dir, f);
    }
  }
  return { byNoExt, byDir, collisions };
}

/**
 * 把一条 import 解析为项目内部文件列表（0..n）
 * - relative：按导入者目录解析，补扩展名 / index
 * - Go package：module 前缀剥离 → 包目录下全部文件
 * - Python dotted：点转斜杠，先试项目根、再试导入者目录
 */
function resolveImport(
  imp: ParsedImport,
  importer: FileEntry,
  index: { byNoExt: Map<string, FileEntry>; byDir: Map<string, FileEntry[]> },
  goModules: GoModule[],
): FileEntry[] {
  const { byNoExt, byDir } = index;

  if (imp.kind === 'relative') {
    let target: string;
    if (/^\.+$/.test(imp.source) || /^\.+[^/]/.test(imp.source)) {
      // Python 前导点形式：'.'=当前目录 '..'=上一级，后续点分模块转路径
      const m = imp.source.match(/^(\.+)(.*)$/);
      const dots = m ? m[1] : '.';
      const rest = m ? m[2] : '';
      let base = importer.dir;
      for (let i = 1; i < dots.length; i++) base = path.posix.dirname(base);
      target = rest ? path.posix.join(base, rest.split('.').join('/')) : base;
    } else {
      target = path.posix.normalize(path.posix.join(importer.dir, imp.source));
    }
    const hit = byNoExt.get(target);
    if (hit) return [hit];
    for (const ext of RESOLVE_EXTS) {
      const cand = byNoExt.get(target.endsWith(ext) ? target.slice(0, -ext.length) : target);
      if (cand) return [cand];
    }
    // 目录形式（import './dir'）
    const dirFiles = byDir.get(target);
    if (dirFiles && dirFiles.length > 0) {
      const init = dirFiles.find((f) => /(^|\/)(index|__init__|mod)\.[^.]+$/.test(f.rel));
      return [init || dirFiles[0]];
    }
    return [];
  }

  // package 导入：遍历全部 go.mod（已按 module 长度降序，最长前缀优先）
  for (const gm of goModules) {
    if (imp.source === gm.module || imp.source.startsWith(gm.module + '/')) {
      const rest = imp.source.slice(gm.module.length).replace(/^\//, '');
      // 目标目录 = go.mod 所在目录 + 剥离 module 前缀后的子路径
      const dir = gm.dir ? (rest ? `${gm.dir}/${rest}` : gm.dir) : rest;
      const dirFiles = byDir.get(dir);
      if (dirFiles && dirFiles.length > 0) return [...dirFiles];
    }
  }

  // Python 点分模块 / 其他点分形式
  if (/^[\w][\w.]*$/.test(imp.source) && imp.source.includes('.')) {
    const asPath = imp.source.split('.').join('/');
    for (const base of ['', importer.dir]) {
      const target = base ? path.posix.join(base, asPath) : asPath;
      const hit = byNoExt.get(target);
      if (hit) return [hit];
    }
  }
  // 单段包名：试导入者同目录（Python 同包 import sibling 常见）
  if (/^[\w]+$/.test(imp.source)) {
    const hit = byNoExt.get(path.posix.join(importer.dir, imp.source));
    if (hit) return [hit];
  }
  return [];
}

// ─────────────────────────────────────────────────────────────
// 布局：递归分组（目录紧凑包裹，组内按依赖拓扑分列）
// ─────────────────────────────────────────────────────────────

export interface LayoutItem {
  id: string;
  w: number;
  h: number;
  x: number;
  y: number;
}

/** Kahn 拓扑分列；环上的节点追加到最后一列（按 id 排序保证确定性） */
export function rankItems(ids: string[], deps: Array<[string, string]>): Map<string, number> {
  const inDeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  ids.forEach((id) => { inDeg.set(id, 0); out.set(id, []); });
  for (const [f, t] of deps) {
    if (!inDeg.has(f) || !inDeg.has(t) || f === t) continue;
    inDeg.set(t, (inDeg.get(t) || 0) + 1);
    out.get(f)!.push(t);
  }
  const rank = new Map<string, number>();
  const queue = ids.filter((id) => (inDeg.get(id) || 0) === 0).sort();
  const tempIn = new Map(inDeg);
  queue.forEach((id) => rank.set(id, 0));
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const curRank = rank.get(cur) || 0;
    for (const next of (out.get(cur) || []).sort()) {
      rank.set(next, Math.max(rank.get(next) || 0, curRank + 1));
      tempIn.set(next, (tempIn.get(next) || 0) - 1);
      if (tempIn.get(next) === 0) queue.push(next);
    }
  }
  const leftovers = ids.filter((id) => !rank.has(id)).sort();
  const maxRank = rank.size > 0 ? Math.max(...rank.values()) : -1;
  leftovers.forEach((id) => rank.set(id, maxRank + 1));
  return rank;
}

/** 组内布局：按 rank 分列，列内按 id 排序纵排，返回内容 bbox 尺寸 */
export function layoutGroup(items: LayoutItem[], deps: Array<[string, string]>): { w: number; h: number } {
  const ids = items.map((i) => i.id);
  const rank = rankItems(ids, deps);
  const byRank = new Map<number, LayoutItem[]>();
  for (const item of items) {
    const r = rank.get(item.id) || 0;
    const list = byRank.get(r) || [];
    list.push(item);
    byRank.set(r, list);
  }
  const ranks = [...byRank.keys()].sort((a, b) => a - b);

  // 紧凑货架排布：依赖结构退化（≤2 列）且条目较多时，单列纵排会堆出数千 px 高塔
  // （如 cross-border-scout 100+ 文件单列 12834px），折叠视图无法适配屏幕。
  // 货架算法：按高度降序（同高按 id）逐行填充，行宽目标 = √（总面积×1.5)，
  // 天然支持异构尺寸（大容器与小文件混排），bbox 近 3:2，牺牲微弱拓扑序换可读性。
  if (ranks.length <= 2 && items.length >= 3) {
    const area = items.reduce((s, i) => s + (i.w + COL_GAP) * (i.h + ROW_GAP), 0);
    const maxItemW = Math.max(...items.map((i) => i.w));
    const targetW = Math.max(Math.sqrt(area * 1.5), maxItemW);
    const sorted = [...items].sort((a, b) => b.h - a.h || a.id.localeCompare(b.id));
    let x = 0;
    let y = 0;
    let shelfH = 0;
    let maxW = 0;
    for (const it of sorted) {
      if (x > 0 && x + it.w > targetW) {
        y += shelfH + ROW_GAP;
        x = 0;
        shelfH = 0;
      }
      it.x = x;
      it.y = y;
      x += it.w + COL_GAP;
      shelfH = Math.max(shelfH, it.h);
      maxW = Math.max(maxW, x - COL_GAP);
    }
    return { w: Math.max(maxW, FILE_W), h: Math.max(y + shelfH, FILE_H) };
  }

  let maxX = 0;
  let maxY = 0;
  let xCursor = 0;
  for (const r of ranks) {
    const col = byRank.get(r)!.sort((a, b) => a.id.localeCompare(b.id));
    let colW = 0;
    let yCursor = 0;
    for (const item of col) {
      item.x = xCursor;
      item.y = yCursor;
      yCursor += item.h + ROW_GAP;
      colW = Math.max(colW, item.w);
    }
    maxX = Math.max(maxX, xCursor + colW);
    maxY = Math.max(maxY, yCursor - ROW_GAP);
    xCursor += colW + COL_GAP;
  }
  return { w: Math.max(maxX, FILE_W), h: Math.max(maxY, FILE_H) };
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────

export async function importProject(input: ImportProjectInput): Promise<ImportProjectResult> {
  const { feature, max_files = 200, include_tests = false } = input;
  const root = path.resolve(input.project_dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`project_dir 不存在或不是目录: ${root}`);
  }

  // 1. 扫描文件
  let absFiles = walkFiles(root, include_tests);
  const skipped: string[] = [];
  // 截断前的完整列表——pruneDeletedFiles 的比对基准（拿截断后列表会误删）
  const walkedAll = absFiles;
  if (absFiles.length > max_files) {
    skipped.push(`超出 max_files=${max_files}，跳过 ${absFiles.length - max_files} 个文件`);
    absFiles = absFiles.slice(0, max_files);
  }
  if (absFiles.length === 0) {
    throw new Error(`未找到可解析的源文件（支持 .go/.ts/.js/.py 等，需已安装对应 tree-sitter 语言包）`);
  }

  const files: FileEntry[] = absFiles.map((abs) => {
    const rel = toPosix(path.relative(root, abs));
    return { rel, abs, ext: path.extname(abs), dir: path.posix.dirname(rel) };
  });
  const index = buildIndex(files);
  for (const c of index.collisions) skipped.push(`同名碰撞: ${c}`);
  const goModules = readGoModules(root);

  // 2. 解析符号 + import（顺带统计行数，零成本复用已读内容做单文件监控）
  const parsed = new Map<string, { symbols: ExpectedApi[]; imports: ParsedImport[] }>();
  const lineCounts = new Map<string, number>();
  let symbolsFound = 0;
  let cacheStats: { hits: number; reparsed: number; failed: number } | undefined;

  /** 两条路径共用的收录逻辑：50 上限截断 + 计数 + 登记 */
  const ingest = (rel: string, syms: Array<{ signature: string; start_line: number }>, imps: ParsedImport[]): void => {
    // 每文件 API 上限 50，超出记注（防止巨型生成文件撑爆 DSL）
    const apis: ExpectedApi[] = syms.slice(0, 50).map((s) => ({
      signature: s.signature,
      notes: `line ${s.start_line}`,
    }));
    if (syms.length > 50) {
      skipped.push(`${rel}: 符号数 ${syms.length} 超上限，仅收录前 50`);
    }
    symbolsFound += apis.length;
    parsed.set(rel, { symbols: apis, imports: imps });
  };

  if (input.cache_db) {
    // 缓存路径：syncProject 内部按 content_hash 增量——未变更文件不重解析，
    // 随后从 cache.db 读回符号与原始 import（含 Go 包路径 / Python 点分模块）
    const db = input.cache_db;
    const sync = await syncProject(db, root, absFiles);
    cacheStats = { hits: 0, reparsed: 0, failed: 0 };
    // 删除侦测：清掉磁盘上已不存在的文件的缓存行（比对基准是截断前完整列表）
    const pruned = pruneDeletedFiles(db, root, walkedAll);
    if (pruned.length > 0) {
      skipped.push(
        `缓存清理: ${pruned.length} 个文件已从磁盘删除（${pruned.slice(0, 3).join(', ')}${pruned.length > 3 ? ' 等' : ''}）`,
      );
    }
    const byPath = new Map(sync.results.map((r) => [r.path, r]));
    for (const f of files) {
      const r = byPath.get(f.rel);
      const cached = r && r.status !== 'failed' ? getFileParse(db, f.rel) : null;
      if (!r || r.status === 'failed' || !cached) {
        // 解析失败 = 静默丢依赖边 + 空 API 面，必须在结果中可见（区别于"文件本为空"）
        // 缓存侧不写 files 行，下次运行自动重试
        cacheStats.failed++;
        skipped.push(`解析失败: ${f.rel}（${r?.error || '缓存读取异常'}），该文件的依赖边与 API 缺失`);
        parsed.set(f.rel, { symbols: [], imports: [] });
        continue;
      }
      if (r.status === 'skipped') cacheStats.hits++;
      else cacheStats.reparsed++;
      lineCounts.set(f.rel, cached.line_count);
      ingest(
        f.rel,
        cached.symbols.map((s) => ({ signature: s.signature ?? s.name, start_line: s.start_line })),
        cached.imports,
      );
    }
  } else {
    for (const f of files) {
      let content: string;
      try {
        content = fs.readFileSync(f.abs, 'utf-8');
      } catch {
        skipped.push(`读取失败: ${f.rel}`);
        continue;
      }
      lineCounts.set(f.rel, countLines(content));
      const full = await parseFileFull(f.abs, content);
      // 解析失败 = 静默丢依赖边 + 空 API 面，必须在结果中可见（区别于"文件本为空"）
      if (full.error) {
        skipped.push(`解析失败: ${f.rel}（${full.error}），该文件的依赖边与 API 缺失`);
      }
      ingest(f.rel, full.symbols, full.imports);
    }
  }

  // 3. 依赖边（文件级，去重，去自环）
  const byRel = new Map(files.map((f) => [f.rel, f]));
  const depEdgeSet = new Set<string>();
  const fileDeps: Array<[string, string]> = [];
  for (const f of files) {
    const p = parsed.get(f.rel);
    if (!p) continue;
    for (const imp of p.imports) {
      const targets = resolveImport(imp, f, index, goModules);
      for (const t of targets) {
        if (t.rel === f.rel) continue;
        const key = `${f.rel}|${t.rel}`;
        if (depEdgeSet.has(key)) continue;
        depEdgeSet.add(key);
        fileDeps.push([f.rel, t.rel]);
      }
    }
  }

  // 4. 目录树
  interface DirNode {
    rel: string; // '' 表示项目根
    name: string;
    subdirs: Map<string, DirNode>;
    files: FileEntry[];
  }
  const rootDir: DirNode = { rel: '', name: path.basename(root), subdirs: new Map(), files: [] };
  const dirByRel = new Map<string, DirNode>([['', rootDir]]);
  const ensureDir = (rel: string): DirNode => {
    const existing = dirByRel.get(rel);
    if (existing) return existing;
    const parentRel = path.posix.dirname(rel);
    const parent = ensureDir(parentRel === '.' ? '' : parentRel);
    const d: DirNode = { rel, name: path.posix.basename(rel), subdirs: new Map(), files: [] };
    parent.subdirs.set(rel, d);
    dirByRel.set(rel, d);
    return d;
  };
  for (const f of files) {
    ensureDir(f.dir === '.' ? '' : f.dir).files.push(f);
  }

  // 5. 生成节点 ID
  const sanitize = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileNodeId = (rel: string): string => `file_${sanitize(rel)}`;
  const dirNodeId = (rel: string): string => `dir_${sanitize(rel)}`;

  // 6. 布局（后序：先内层目录，尺寸向上传递）
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const semanticFiles: SemanticFile[] = [];

  const fileLayout = new Map<string, LayoutItem>();
  for (const f of files) {
    fileLayout.set(f.rel, { id: fileNodeId(f.rel), w: FILE_W, h: FILE_H, x: 0, y: 0 });
  }

  /** 布局一个目录，返回其容器尺寸（根目录不生成容器节点） */
  const layoutDir = (dir: DirNode): { w: number; h: number } => {
    const items: LayoutItem[] = [];
    const localDeps: Array<[string, string]> = [];

    // 子目录先布局（递归），获得尺寸后作为 item
    const subdirItems = new Map<string, LayoutItem>();
    for (const sub of [...dir.subdirs.values()].sort((a, b) => a.rel.localeCompare(b.rel))) {
      const size = layoutDir(sub);
      const item: LayoutItem = { id: dirNodeId(sub.rel), w: size.w, h: size.h, x: 0, y: 0 };
      subdirItems.set(sub.rel, item);
      items.push(item);
    }
    // 文件节点
    for (const f of [...dir.files].sort((a, b) => a.rel.localeCompare(b.rel))) {
      items.push(fileLayout.get(f.rel)!);
    }
    // 局部依赖：两端都在本目录直接子级（文件→文件；涉及子目录内部的聚合到子目录容器）
    const ownerOf = (rel: string): string => {
      // 文件 rel 属于本组哪个直接子项：自身（本目录文件）或某个子目录容器
      if (dir.files.some((f) => f.rel === rel)) return fileNodeId(rel);
      for (const sub of dir.subdirs.keys()) {
        if (rel.startsWith(sub + '/')) return dirNodeId(sub);
      }
      return '';
    };
    for (const [fromRel, toRel] of fileDeps) {
      const a = ownerOf(fromRel);
      const b = ownerOf(toRel);
      if (a && b && a !== b) localDeps.push([a, b]);
    }
    const content = layoutGroup(items, localDeps);

    // 写回子项局部坐标（相对本目录内容原点，最终在 accumulate 阶段统一平移）
    for (const item of items) {
      if (item.id.startsWith('file_')) {
        const rel = files.find((f) => fileNodeId(f.rel) === item.id)!.rel;
        fileLayout.get(rel)!.x = item.x;
        fileLayout.get(rel)!.y = item.y;
      } else {
        const subRel = [...dirByRel.values()].find((d) => d.rel !== '' && dirNodeId(d.rel) === item.id)!.rel;
        // 仅记录子目录容器在本组内的位置（不递归平移，避免与 accumulate 双重累加）
        dirOffset.set(subRel, { x: item.x, y: item.y });
      }
    }

    const containerW = content.w + PAD * 2;
    const containerH = content.h + PAD * 2 + TITLE_H;
    // 容器节点（根目录除外）
    if (dir.rel !== '') {
      nodes.push({
        id: dirNodeId(dir.rel),
        label: `📁 ${dir.name}`,
        x: 0, // 占位，最终平移阶段统一赋值
        y: 0,
        width: containerW,
        height: containerH,
        type: 'module',
        style: { ...DIR_STYLE, borderRadius: 8 },
      });
    }
    // 记录容器内容偏移（子项需要额外加上 PAD / PAD+TITLE_H）
    dirContentOffset.set(dir.rel, { dx: PAD, dy: PAD + TITLE_H, w: containerW, h: containerH });
    return { w: containerW, h: containerH };
  };

  const dirContentOffset = new Map<string, { dx: number; dy: number; w: number; h: number }>();
  const dirOffset = new Map<string, { x: number; y: number }>();

  // 根级布局：把根目录当作一个组（不生成根容器）
  const rootSize = layoutDir(rootDir);

  // 7. 汇总坐标：自根向下累加。文件局部坐标相对于所属目录内容原点，
  //    目录偏移（dirOffset）只在此处应用一次。
  //    节点最终坐标 = 局部坐标 + Σ 祖先（容器位置 + 内容偏移）
  const accumulate = (dirRel: string, baseX: number, baseY: number): void => {
    const d = dirByRel.get(dirRel)!;
    const selfOff = dirOffset.get(dirRel) || { x: 0, y: 0 };
    const content = dirContentOffset.get(dirRel)!;
    // 容器左上角（根目录无容器，base 即内容原点）
    const containerX = baseX + selfOff.x;
    const containerY = baseY + selfOff.y;
    const contentX = dirRel === '' ? containerX : containerX + content.dx;
    const contentY = dirRel === '' ? containerY : containerY + content.dy;
    if (dirRel !== '') {
      const node = nodes.find((n) => n.id === dirNodeId(dirRel))!;
      node.x = containerX;
      node.y = containerY;
    }
    for (const f of d.files) {
      const item = fileLayout.get(f.rel)!;
      item.x += contentX;
      item.y += contentY;
    }
    for (const sub of d.subdirs.values()) {
      accumulate(sub.rel, contentX, contentY);
    }
  };
  accumulate('', MARGIN, MARGIN);

  // 8. 文件节点 + 边 + 语义层
  for (const f of files) {
    const p = parsed.get(f.rel);
    const apis = p?.symbols || [];
    const item = fileLayout.get(f.rel)!;
    const langKey = f.ext.slice(1);
    const colors = LANG_COLORS[langKey] || DEFAULT_FILE_COLOR;
    const apiCount = apis.length;
    nodes.push({
      id: fileNodeId(f.rel),
      label: `${path.posix.basename(f.rel)} · ${apiCount} APIs`,
      x: Math.round(item.x),
      y: Math.round(item.y),
      width: FILE_W,
      height: FILE_H,
      type: 'file',
      status: 'done',
      description: f.rel,
      style: { ...colors, borderRadius: 4 },
    });
    // 目录归属边
    if (f.dir && f.dir !== '.') {
      edges.push({ id: `contains_${sanitize(f.dir)}_${sanitize(f.rel)}`, from: dirNodeId(f.dir), to: fileNodeId(f.rel), label: 'contains' });
    }
    // 嵌套目录 contains 边
    semanticFiles.push({
      id: fileNodeId(f.rel),
      path: f.rel,
      responsibility: `${f.dir === '.' ? '根目录' : f.dir} — ${apiCount} 个 API（导入自 ${(p?.imports.length || 0)} 个模块）`,
      status: 'done',
      expected_apis: apis,
      actual_apis: apis,
    });
  }
  for (const d of [...dirByRel.values()].sort((a, b) => a.rel.localeCompare(b.rel))) {
    if (d.rel === '') continue;
    const parentRel = path.posix.dirname(d.rel);
    const parentId = parentRel === '.' || parentRel === '' ? null : dirNodeId(parentRel);
    if (parentId) {
      edges.push({ id: `contains_${sanitize(parentRel)}_${sanitize(d.rel)}`, from: parentId, to: dirNodeId(d.rel), label: 'contains' });
    }
  }
  // 依赖边渲染：与布局排序同构的分层聚合——
  // 同目录文件间保留文件级短边（信息精确）；
  // 跨目录依赖聚合到"最近公共祖先层的两个直接子项"之间（文件或目录容器），
  // 同一对节点合并为一条 label ×N。边只存在于同层兄弟之间，结构性消除跨容器穿越。
  const normDir = (d: string): string => (d === '.' ? '' : d);
  const ancestorsOf = (dir: string): string[] => {
    const out: string[] = [];
    let d = normDir(dir);
    for (;;) {
      out.push(d);
      if (d === '') break;
      d = normDir(path.posix.dirname(d));
    }
    return out;
  };
  /** rel 在 lcaDir 层的直接子项节点 id（直接文件 → 文件节点；深入子目录 → 目录容器） */
  const ownerAtLca = (rel: string, lca: string): string => {
    const rest = lca === '' ? rel : rel.slice(lca.length + 1);
    const slash = rest.indexOf('/');
    if (slash === -1) return fileNodeId(rel);
    return dirNodeId(lca === '' ? rest.slice(0, slash) : `${lca}/${rest.slice(0, slash)}`);
  };

  const aggEdges = new Map<string, { from: string; to: string; n: number }>();
  const directEdges: Array<[string, string]> = [];
  for (const [fromRel, toRel] of fileDeps) {
    const fromAnc = ancestorsOf(path.posix.dirname(fromRel));
    const toAncSet = new Set(ancestorsOf(path.posix.dirname(toRel)));
    const lca = fromAnc.find((d) => toAncSet.has(d));
    if (lca === undefined) continue;
    const a = ownerAtLca(fromRel, lca);
    const b = ownerAtLca(toRel, lca);
    if (a === b) continue;
    if (a.startsWith('file_') && b.startsWith('file_')) {
      directEdges.push([fromRel, toRel]);
    } else {
      const key = `${a}|${b}`;
      const cur = aggEdges.get(key);
      if (cur) cur.n++;
      else aggEdges.set(key, { from: a, to: b, n: 1 });
    }
  }
  for (const [fromRel, toRel] of directEdges) {
    edges.push({
      id: `dep_${sanitize(fromRel)}_${sanitize(toRel)}`,
      from: fileNodeId(fromRel),
      to: fileNodeId(toRel),
      label: 'imports',
      type: 'dashed',
    });
  }
  const aggSorted = [...aggEdges.values()].sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to));
  for (const { from, to, n } of aggSorted) {
    edges.push({
      id: `dep_${sanitize(from)}_${sanitize(to)}`,
      from,
      to,
      label: n > 1 ? `imports ×${n}` : 'imports',
      type: 'dashed',
      style: n > 3 ? { strokeWidth: 2 } : undefined,
    });
  }
  const renderedDepEdges = directEdges.length + aggSorted.length;

  // 9. 组装 DSL
  const canvasW = Math.round(rootSize.w + MARGIN * 2);
  const canvasH = Math.round(rootSize.h + MARGIN * 2 + TITLE_H);
  const dsl: DesignDSL = {
    id: `imported_${feature}`,
    type: 'feature_diagram',
    feature,
    version: '1.0.0',
    title: input.title || `${feature}（import_project 生成）`,
    status: 'done',
    geometry: {
      // 坐标已在本工具内全部算好（递归分组布局），渲染端按显式 x/y 摆放
      layout: 'free',
      width: Math.max(canvasW, 800),
      height: Math.max(canvasH, 400),
      nodes,
      edges,
    },
    semantic: { files: semanticFiles },
  } as DesignDSL;

  saveDSL(dsl);

  const dirCount = nodes.filter((n) => n.type === 'module').length;
  // 单文件化预警：行数超阈值的文件点名（仅行数统计，详细拆分建议走 check_monolith）
  const oversized = files
    .map((f) => ({ rel: f.rel, lines: lineCounts.get(f.rel) ?? 0 }))
    .filter((x) => assessLines(x.lines) !== 'ok')
    .sort((a, b) => b.lines - a.lines);
  const message = [
    `已导入项目 → feature "${feature}"`,
    `项目根: ${root}`,
    `文件: ${files.length} 个（符号 ${symbolsFound} 个，依赖 ${fileDeps.length} 条→渲染 ${renderedDepEdges} 条（跨目录已聚合），目录容器 ${dirCount} 个）`,
    cacheStats ? `缓存: 命中 ${cacheStats.hits} / 重解析 ${cacheStats.reparsed} / 失败 ${cacheStats.failed}` : null,
    goModules.length > 0 ? `Go modules: ${goModules.map((g) => g.module).join(', ')}` : null,
    oversized.length > 0
      ? `⚠ 单文件化预警 ${oversized.length} 个:\n  - ${oversized
          .map((x) => `${x.rel}（${x.lines} 行${x.lines >= 600 ? '，严重' : ''}）`)
          .join('\n  - ')}\n  → 运行 check_monolith 获取功能内聚拆分建议`
      : null,
    skipped.length > 0 ? `跳过/截断:\n  - ${skipped.join('\n  - ')}` : null,
    `下一步: render_dsl 渲染预览，或 get_dsl 查看/修改。`,
  ].filter(Boolean).join('\n');

  return {
    message,
    feature,
    files_parsed: files.length,
    symbols_found: symbolsFound,
    dep_edges: fileDeps.length,
    dirs_created: dirCount,
    skipped,
    cache: cacheStats,
  };
}
