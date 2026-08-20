/**
 * import_project 工具：扫描现有项目 → 自动生成 design-canvas DSL
 *
 * 降低工具门槛：新用户无需手写 DSL，指向项目目录即可得到初始设计图，
 * 随后在画布上迭代（人改几何层 / LLM 改语义层）。
 *
 * 产出：
 *   - geometry.nodes：目录容器节点（type=module）+ 文件节点（type=file，status=done）
 *   - geometry.edges：contains（目录父子/文件归属）+ imports（跨文件依赖）
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
import type { DesignDSL, Node, Edge, SemanticFile, ExpectedApi, Symbol } from '../dsl/types.js';
import type { BrickManifest } from '../dsl/contract.js';
import { saveDSL, saveLiveFeature } from '../storage.js';
import { detectArchLayers } from './layer_detect.js';
import { parseFileFull, isSupported } from './ts_kernel/index.js';
import type { ParsedImport } from './ts_kernel/index.js';
import { countLines, assessLines } from './monolith.js';
import type { Database } from '../db/db.js';
import { syncProject, getFileParse, pruneDeletedFiles } from '../db/symbols.js';
import { generateFileRoleTitles } from './role_title.js';

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
   * 是否索引归档/历史目录（_archive/archive/_old/…，默认 false）。
   * 遗留项目归档代码不是主体，默认跳过以防稀释活跃社区；true 时索引且截断排序靠后。
   */
  include_archive?: boolean;
  /**
   * 可选：符号缓存（openDb 的返回值）。提供时走增量路径——
   * content_hash 未变的文件直接读 cache.db，跳过重解析；
   * 变更文件由 syncFile 解析并写回缓存，下次运行受益。
   */
  cache_db?: Database;
  /**
   * 可选：仅生成"实际 DSL"（代码实时快照，写 live/ 目录，不覆盖设计 DSL）。
   * 供 watch_project 变更回调 / serve 重建实际视图用。默认 false=写设计 DSL。
   */
  live_only?: boolean;
  /**
   * 可选：live_only 时实际 DSL 归属的项目根（默认 dataHome）。
   * watch_project 监听任意项目时传 project_dir，使实际 DSL 与该项目 cache.db 同目录归位。
   */
  live_dir?: string;
  /**
   * 可选：是否用 LLM 为每个文件节点生成中文职责主标题（node.title）。
   * 默认 false（不引入 LLM 依赖与延迟）；自分析/讲解场景开启。未配置 LLM 时静默跳过。
   */
  gen_roles?: boolean;
  /**
   * 可选：导入源码的持久根目录（绝对路径）。提供时写入 DSL.source_root，
   * 供巨石体检/影响面/一致性等需读源文件的功能定位源码。
   * 浏览器上传导入时由 serve 指定为 .design-canvas/projects/<feature>/。
   */
  source_root?: string;
  /**
   * 可选：设计模式 — 聚合文件到目录层级，只输出高层模块节点，不输出每个文件。
   * 用于从现有代码快速生成设计意图 DSL（草图供人后续调整）。默认 false=保留每个文件。
   * true 时：同一目录下的所有文件聚合为一个模块容器节点，符号和 API 汇总到语义层。
   */
  design_mode?: boolean;
  /**
   * 可选：功能模式 — 按调用图做【功能性】聚合，而非按目录聚合。
   * 理想聚合是"业务功能"而非"文件夹"：用文件级 import 边做标签传播，把互相依赖的
   * 文件聚成功能社区，每个社区 = 一个功能模块节点（可跨目录）。自包含，不依赖 cache.db。
   * 优先级高于 design_mode（functional_mode 即为一种设计级聚合）。
   */
  functional_mode?: boolean;
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
  /** 积木折叠数（拼装区 assembly.json 命中时 >0；积木=单符号黑盒节点，内部文件不进 DSL） */
  bricks_folded?: number;
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

/**
 * 归档/历史目录名单：遗留项目里"已弃用但保留"的代码堆（如 _archive/）。
 * 默认【不索引】——它们不是项目主体，混进 cache.db 会稀释/淹没真正活跃的社区
 * （analyze_monolith / derive_chain 等基于调用边的工具全部失真）。
 * include_archive=true 时才索引，且这些文件在 max_files 截断时排序靠后（优先保活跃主体）。
 */
const ARCHIVE_DIRS = new Set([
  '_archive', 'archive', 'archived', '_old', 'old', '_backup', '_deprecated',
  '_sandbox', '_wip', '_draft', '_legacy', '_stale', '_dead', '_scratch',
]);

/** 跳过的文件模式（测试/生成物 / 编辑器临时存取，非架构） */
const SKIP_FILE_RE = /(_test\.go$|\.test\.[tj]sx?$|\.spec\.[tj]sx?$|\.min\.js$|\.d\.ts$|\.gen\.[tj]sx?$|test_.*\.py$|.*_test\.py$|\.tmp$|\.temp$|\.crswap$|\.crdownload$|\.swp$|\.swo$|\.swx$|\.bak$|\.orig$|\.rej$|~$|^~)/;

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

/** 积木黑盒节点尺寸/配色（紫色系：已治理验证资产，区别于普通目录/文件） */
const BRICK_W = 280;
const BRICK_H = 84;
const BRICK_STYLE = { bg: '#3e2a63', color: '#d1c4e9' };

// ─────────────────────────────────────────────────────────────
// 文件扫描
// ─────────────────────────────────────────────────────────────

export function walkFiles(root: string, includeTests: boolean, includeArchive = false): string[] {
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
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        // 归档目录默认跳过（不索引）；include_archive=true 才深入
        if (!includeArchive && ARCHIVE_DIRS.has(e.name)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        if (!includeTests && SKIP_FILE_RE.test(e.name)) continue;
        if (isSupported(path.extname(e.name))) out.push(full);
      }
    }
  }
  // 确定性顺序；include_archive=true 时归档文件排后（max_files 截断优先保活跃主体）
  if (includeArchive) {
    return out.sort((a, b) => {
      const aArc = inArchiveDir(a) ? 1 : 0;
      const bArc = inArchiveDir(b) ? 1 : 0;
      if (aArc !== bArc) return aArc - bArc;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }
  return out.sort();
}

/** 路径是否落在某个归档目录下 */
function inArchiveDir(p: string): boolean {
  const parts = p.split(path.sep);
  return parts.some((seg) => ARCHIVE_DIRS.has(seg));
}

// ─────────────────────────────────────────────────────────────
// import 解析 → 内部文件
// ─────────────────────────────────────────────────────────────

export interface FileEntry {
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
export interface GoModule {
  module: string;
  dir: string;
}

/**
 * 读取项目内全部 go.mod（支持多模块/monorepo）。
 * 按 module 路径长度降序，保证最长前缀优先匹配
 * （如 example.com/a/v2 优先于 example.com/a）。
 */
export function readGoModules(root: string): GoModule[] {
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
export function buildIndex(files: FileEntry[]): {
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
 * - Python 点分模块 → 点转斜杠，先试项目根再试导入者目录
 */
export function resolveImport(
  imp: ParsedImport,
  importer: FileEntry,
  index: { byNoExt: Map<string, FileEntry>; byDir: Map<string, FileEntry[]> },
  goModules: GoModule[],
): FileEntry[] {
  const { byNoExt, byDir } = index;

  if (imp.kind === 'relative') {
    let target: string;
    // [^./] 而非 [^/]：'../types.js' 在回溯下会被误判成 Python 前导点形式
    // （`\.` 吃一个点、`[^/]` 吃第二个点）→ 走错分支解析成 types/js。
    // 排除点号后：'..' 纯点走第一支，'.pkg'/'..pkg' 走 Python 支，'./x'/'../x' 走 TS 支。
    if (/^\.+$/.test(imp.source) || /^\.+[^./]/.test(imp.source)) {
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
// 积木折叠（拼装区黑盒化）：assembly.json 出生证明 → DSL 单符号节点
// ─────────────────────────────────────────────────────────────

/** assembly.json 出生证明里的积木条目（assemble_bricks 写入的契约投影） */
export interface BrickFoldInfo {
  name: string;
  /** 拼装区内落位根（恒带尾斜杠，如 'go_logging/'） */
  dest_root: string;
  /** 积木人话一句话 */
  description?: string;
  /** 聚合契约（exposes/consumes/emits——黑盒节点的接口事实） */
  aggregate?: BrickManifest['aggregate'];
}

/**
 * 读拼装区出生证明（assembly.json）的积木清单。
 * 设计动机：拼装区里已治理积木对 DSL/LLM 是黑盒——检索不进内部、
 * 语义层只见契约投影（exposes/consumes/emits），除非 camera 检出异常才深挖。
 * 诚实边界：无出生证明 / JSON 损坏 → 空数组，退化为普通项目全量解析
 * （不因证明损坏而拒绝解析，也不猜积木边界）。
 */
export function readAssemblyBricks(root: string): BrickFoldInfo[] {
  const p = path.join(root, 'assembly.json');
  if (!fs.existsSync(p)) return [];
  try {
    const a = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
      bricks?: Array<{ name?: unknown; dest_root?: unknown; description?: unknown; aggregate?: unknown }>;
    };
    if (!Array.isArray(a?.bricks)) return [];
    const out: BrickFoldInfo[] = [];
    for (const b of a.bricks) {
      if (!b || typeof b.name !== 'string' || typeof b.dest_root !== 'string') continue;
      out.push({
        name: b.name,
        dest_root: b.dest_root.endsWith('/') ? b.dest_root : `${b.dest_root}/`,
        description: typeof b.description === 'string' ? b.description : undefined,
        aggregate: (b.aggregate ?? undefined) as BrickFoldInfo['aggregate'],
      });
    }
    return out;
  } catch {
    return [];
  }
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
  // 阈值从 3 提到 12：3~11 文件走 barycenter 列布局，边更短直。
  if (ranks.length <= 2 && items.length >= 12) {
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

  // barycenter 列内排序：邻居在上层/下层的平均 y 作为排序键，迭代 3 轮收敛
  const inNeighbors = new Map<string, string[]>();
  const outNeighbors = new Map<string, string[]>();
  for (const [f, t] of deps) {
    if (inNeighbors.has(f)) inNeighbors.get(f)!.push(t);
    if (outNeighbors.has(t)) outNeighbors.get(t)!.push(f);
  }
  // 初始 y：按列内 rank 索引占位（供 barycenter 计算）
  for (const r of ranks) {
    const col = byRank.get(r)!;
    col.forEach((it, idx) => { it.y = idx * (it.h + ROW_GAP); });
  }
  for (let iter = 0; iter < 3; iter++) {
    const topDown = iter < 2;
    const order = topDown ? ranks : [...ranks].reverse();
    for (const r of order) {
      const col = byRank.get(r)!;
      const neighborCol = topDown ? byRank.get(r - 1) : byRank.get(r + 1);
      if (neighborCol && neighborCol.length > 0) {
        const ny = new Map(neighborCol.map((it) => [it.id, it.y]));
        col.sort((a, b) => {
          const ay = (inNeighbors.get(a.id) || [])
            .map((n) => ny.get(n))
            .filter((v) => v !== undefined) as number[];
          const by = (inNeighbors.get(b.id) || [])
            .map((n) => ny.get(n))
            .filter((v) => v !== undefined) as number[];
          const av = ay.length ? ay.reduce((s, v) => s + v, 0) / ay.length : Number.MAX_VALUE;
          const bv = by.length ? by.reduce((s, v) => s + v, 0) / by.length : Number.MAX_VALUE;
          return av - bv;
        });
        // 重新赋 y
        let yCursor = 0;
        for (const it of col) { it.y = yCursor; yCursor += it.h + ROW_GAP; }
      }
    }
  }

  let maxX = 0;
  let maxY = 0;
  let xCursor = 0;
  for (const r of ranks) {
    const col = byRank.get(r)!;
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
// 功能性聚合：按调用图社区划功能模块（functional_mode）
// ─────────────────────────────────────────────────────────────

/** 文件级标签传播：把互相依赖的文件聚成功能社区。返回 社区 id → 文件 rel 列表 */
function communityDetectFiles(files: FileEntry[], deps: Array<[string, string]>, maxIter = 20): Map<number, string[]> {
  const idx = new Map<string, number>();
  files.forEach((f, i) => idx.set(f.rel, i));
  const n = files.length;
  const adj: number[][] = files.map(() => []);
  for (const [a, b] of deps) {
    const ia = idx.get(a);
    const ib = idx.get(b);
    if (ia === undefined || ib === undefined || ia === ib) continue;
    adj[ia].push(ib);
    adj[ib].push(ia);
  }
  // 标签传播：初始每个文件自成一派，邻居多数派标签胜出
  const labels = files.map((_, i) => i);
  for (let it = 0; it < maxIter; it++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      const nbrs = adj[i];
      if (nbrs.length === 0) continue;
      const cnt = new Map<number, number>();
      for (const nb of nbrs) {
        const l = labels[nb];
        cnt.set(l, (cnt.get(l) ?? 0) + 1);
      }
      let best = labels[i];
      let bestN = -1;
      for (const [l, c] of cnt) {
        if (c > bestN || (c === bestN && l < best)) {
          bestN = c;
          best = l;
        }
      }
      if (best !== labels[i]) {
        labels[i] = best;
        changed = true;
      }
    }
    if (!changed) break;
  }
  // 按 label 分组，稳定编号
  const byLabel = new Map<number, string[]>();
  files.forEach((f, i) => {
    const l = labels[i];
    const arr = byLabel.get(l) || [];
    arr.push(f.rel);
    byLabel.set(l, arr);
  });
  const out = new Map<number, string[]>();
  let cid = 0;
  for (const arr of byLabel.values()) out.set(cid++, arr);
  return out;
}

/** 社区默认名：取成员文件里出现最多的首段目录 */
function communityNameOf(files: string[]): string {
  const dirCount = new Map<string, number>();
  for (const f of files) {
    const d = f.includes('/') ? f.split('/')[0] : '(根)';
    dirCount.set(d, (dirCount.get(d) ?? 0) + 1);
  }
  let best = '(根)';
  let bestN = 0;
  for (const [d, n] of dirCount) if (n > bestN) { best = d; bestN = n; }
  return best;
}

/** 社区消歧符：取成员文件里出现最多的第二段路径（子目录/文件名），用于区分同顶层目录的多个社区 */
function communityQualifier(rels: string[]): string {
  const sub = new Map<string, number>();
  for (const f of rels) {
    const parts = f.split('/');
    const s = parts.length >= 2 ? parts[1] : f.split('.').slice(0, -1).join('.') || f;
    sub.set(s, (sub.get(s) ?? 0) + 1);
  }
  let best = rels[0]?.split('/').pop()?.replace(/\.[a-z]+$/i, '') ?? '?';
  let bestN = 0;
  for (const [s, n] of sub) if (n > bestN) { best = s; bestN = n; }
  return best;
}

/**
 * skill 级功能性聚合：基于 analyze_monolith 的锚点驱动社区（+ 可选 derive_feature_tree
 * LLM 归并成业务功能），产出功能模块节点 + 社区间依赖边。
 * 每个模块节点聚合其社区成员文件的 API/符号/行数，语义层写入职责描述。
 */
async function buildFromMonolith(
  mono: {
    communities: Array<{ id: number; name: string; files: string[]; est_lines: number; symbol_count: number }>;
    dependencies: Array<[number, number, number]>;
  },
  projectDir: string,
  parsed: Map<string, { symbols: ExpectedApi[]; nonFuncSymbols: Symbol[]; imports: ParsedImport[] }>,
  lineCounts: Map<string, number>,
  genNames: boolean,
  sanitize: (s: string) => string,
  moduleId: (cid: number) => string,
  cacheDb?: Database,
): Promise<{ nodes: Node[]; edges: Edge[]; semanticFiles: SemanticFile[]; size: { w: number; h: number } }> {
  // A. 模块分组：LLM 归并成业务功能（3-8 个中文名）；失败/未配置则用社区级
  let groups: Array<{ id: string; name: string; communities: Array<{ id: number; files: string[] }> }> | null = null;
  if (genNames) {
    try {
      const { deriveFeatureTree } = await import('./derive_feature_tree.js');
      const ft = await deriveFeatureTree({ project_dir: projectDir, db: cacheDb, gen_names: true });
      if (ft.features.length > 0) {
        groups = ft.features.map((f, i) => ({
          id: moduleId(i),
          name: f.name,
          communities: f.communities.map((c) => ({ id: c.id, files: c.files })),
        }));
      }
    } catch {
      groups = null;
    }
  }

  // 模块 → 成员文件 与 主键
  const moduleRels = new Map<string, { name: string; rels: string[] }>();
  if (groups) {
    for (const g of groups) {
      const rels = [...new Set(g.communities.flatMap((c) => c.files))].sort();
      moduleRels.set(g.id, { name: g.name, rels });
    }
  } else {
    for (const c of mono.communities) {
      moduleRels.set(moduleId(c.id), { name: c.name, rels: c.files });
    }
  }

  // 社区 → 模块 id 映射（用于依赖边聚合）
  const commToModule = new Map<number, string>();
  if (groups) {
    for (const g of groups) for (const c of g.communities) commToModule.set(c.id, g.id);
  } else {
    for (const c of mono.communities) commToModule.set(c.id, moduleId(c.id));
  }

  // B. 聚合社区间依赖边 → 模块边
  const agg = new Map<string, { from: string; to: string; n: number }>();
  for (const [a, b, w] of mono.dependencies) {
    const from = commToModule.get(a);
    const to = commToModule.get(b);
    if (!from || !to || from === to) continue;
    const key = `${from}|${to}`;
    const cur = agg.get(key);
    if (cur) cur.n += w;
    else agg.set(key, { from, to, n: w });
  }
  const aggDeps: Array<[string, string]> = [...agg.values()].map(({ from, to }) => [from, to]);

  // C. 布局：带社区依赖边做拓扑分列
  const items: LayoutItem[] = [];
  for (const [id, m] of moduleRels) {
    items.push({ id, w: FILE_W * Math.min(Math.max(m.rels.length, 1), 3), h: FILE_H, x: 0, y: 0 });
  }
  const content = layoutGroup(items, aggDeps);
  const contentW = content.w + PAD * 2;
  const contentH = content.h + PAD * 2 + TITLE_H;

  // D. 生成模块节点 + 语义层
  const nodes: Node[] = [];
  const semanticFiles: SemanticFile[] = [];
  for (const item of items) {
    const m = moduleRels.get(item.id)!;
    const containerW = item.w + PAD * 2;
    const containerH = FILE_H + PAD * 2 + TITLE_H;
    const x = item.x + MARGIN - PAD;
    const y = item.y + MARGIN - PAD;
    const apis: ExpectedApi[] = [];
    const nonFuncSymbols: Symbol[] = [];
    let lines = 0;
    for (const r of m.rels) {
      const p = parsed.get(r);
      if (p) {
        apis.push(...p.symbols.slice(0, 50 - apis.length));
        nonFuncSymbols.push(...p.nonFuncSymbols);
      }
      lines += lineCounts.get(r) ?? 0;
    }
    nodes.push({
      id: item.id,
      label: `🧩 ${m.name}`,
      x: Math.round(x),
      y: Math.round(y),
      width: containerW,
      height: containerH,
      type: 'module',
      style: { ...DIR_STYLE, borderRadius: 8 },
    });
    semanticFiles.push({
      id: item.id,
      path: m.rels.join(', '),
      responsibility: `${m.name} — 聚合 ${m.rels.length} 个文件 / ${apis.length + nonFuncSymbols.length} 个符号`,
      status: 'done',
      expected_apis: apis.length > 0 ? apis : undefined,
      symbols: nonFuncSymbols.length > 0 ? nonFuncSymbols : undefined,
      lines,
    });
  }

  // E. 组装模块边
  const edges: Edge[] = [];
  const sorted = [...agg.values()].sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to));
  for (const { from, to, n } of sorted) {
    edges.push({
      id: `dep_${sanitize(from)}_${sanitize(to)}`,
      from,
      to,
      label: n > 1 ? `imports ×${n}` : 'imports',
      type: 'dashed',
      style: n > 3 ? { strokeWidth: 2 } : undefined,
    });
  }

  return { nodes, edges, semanticFiles, size: { w: contentW, h: contentH } };
}

/**
 * 功能性聚合布局：每个功能社区 = 一个模块节点，社区间依赖边 = 模块边。
 * 孤立单文件（无依赖边）按顶层目录归并，避免一文件一模块的碎片爆炸。
 *
 * 优先走 skill 级管线：复用 analyze_monolith 锚点社区 + derive_feature_tree LLM 归并
 * （动态 import，隔离 node:sqlite 负载，不污染主链路）。无 cache.db / 无社区时
 * 回退到本文件自包含的朴素标签传播。
 *
 * useSkillPipeline=false：跳过 skill 管线强制走标签传播——积木折叠场景专用
 * （analyze_monolith 自行读盘/读库，会把积木内部文件吸进社区 → 黑盒泄漏；
 * 标签传播只吃传入的 files/fileDeps，外部文件集已在调用方过滤干净）。
 */
async function buildFunctionalLayout(
  files: FileEntry[],
  fileDeps: Array<[string, string]>,
  parsed: Map<string, { symbols: ExpectedApi[]; nonFuncSymbols: Symbol[]; imports: ParsedImport[] }>,
  lineCounts: Map<string, number>,
  projectDir: string,
  genNames: boolean,
  cacheDb?: Database,
  useSkillPipeline = true,
): Promise<{ nodes: Node[]; edges: Edge[]; semanticFiles: SemanticFile[]; size: { w: number; h: number } }> {
  const sanitize = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  const moduleId = (cid: number): string => `func_${cid}`;

  // 0. skill 级：复用 analyze_monolith（锚点驱动社区）+ derive_feature_tree（LLM 归并业务功能）
  if (useSkillPipeline) {
    try {
      const { analyzeMonolith } = await import('./analyze_monolith.js');
      const mono = analyzeMonolith({ project_dir: projectDir, db: cacheDb });
      if (mono.communities.length > 0) {
        return await buildFromMonolith(mono, projectDir, parsed, lineCounts, genNames, sanitize, moduleId, cacheDb);
      }
    } catch {
      // 无 cache.db / node:sqlite 不可用 → 回退自包含标签传播
    }
  }

  // 1. 社区检测
  const rawCommunities = communityDetectFiles(files, fileDeps);

  // 2. 合并孤立单文件社区（按顶层目录归并）
  const edgeFiles = new Set<string>();
  for (const [a, b] of fileDeps) {
    edgeFiles.add(a);
    edgeFiles.add(b);
  }
  const merged = new Map<number, string[]>();
  const fileToMerged = new Map<string, number>();
  const dirToMerged = new Map<string, number>();
  let nextId = 0;
  for (const rels of rawCommunities.values()) {
    const isIsolated = rels.length === 1 && !edgeFiles.has(rels[0]);
    if (!isIsolated) {
      merged.set(nextId, rels);
      rels.forEach((r) => fileToMerged.set(r, nextId));
      nextId++;
      continue;
    }
    const r = rels[0];
    const top = r.includes('/') ? r.split('/')[0] : '(根)';
    let m = dirToMerged.get(top);
    if (m === undefined) {
      m = nextId++;
      merged.set(m, []);
      dirToMerged.set(top, m);
    }
    merged.get(m)!.push(r);
    fileToMerged.set(r, m);
  }
  // 清理空 bucket（兜底）
  for (const [id, rels] of [...merged]) if (rels.length === 0) merged.delete(id);

  // 3. 先聚合社区间依赖边（跨社区的文件依赖）——布局需要真实边才能分列排布
  const agg = new Map<string, { from: string; to: string; n: number }>();
  for (const [fromRel, toRel] of fileDeps) {
    const a = fileToMerged.get(fromRel);
    const b = fileToMerged.get(toRel);
    if (a === undefined || b === undefined || a === b) continue;
    const key = `${a}|${b}`;
    const cur = agg.get(key);
    if (cur) cur.n++;
    else agg.set(key, { from: moduleId(a), to: moduleId(b), n: 1 });
  }
  const aggDeps: Array<[string, string]> = [...agg.values()].map(({ from, to }) => [from, to]);

  // 4. 布局：每个功能模块一个 item，带社区依赖边做拓扑分列（避免单列纵排高塔）
  const items: LayoutItem[] = [];
  const moduleMeta = new Map<number, { rels: string[] }>();
  for (const [cid, rels] of merged) {
    items.push({ id: moduleId(cid), w: FILE_W * Math.min(rels.length, 3), h: FILE_H, x: 0, y: 0 });
    moduleMeta.set(cid, { rels });
  }
  const content = layoutGroup(items, aggDeps);
  const contentW = content.w + PAD * 2;
  const contentH = content.h + PAD * 2 + TITLE_H;

  // 5. 生成功能模块节点 + 语义层；同名社区（同顶层目录）用消歧符区分
  const baseNameCount = new Map<string, number>();
  for (const item of items) {
    const cid = Number(item.id.replace(/^func_/, ''));
    const b = communityNameOf(moduleMeta.get(cid)!.rels);
    baseNameCount.set(b, (baseNameCount.get(b) ?? 0) + 1);
  }
  const nodes: Node[] = [];
  const semanticFiles: SemanticFile[] = [];
  for (const item of items) {
    const cid = Number(item.id.replace(/^func_/, ''));
    const meta = moduleMeta.get(cid)!;
    const containerW = item.w + PAD * 2;
    const containerH = FILE_H + PAD * 2 + TITLE_H;
    const x = item.x + MARGIN - PAD;
    const y = item.y + MARGIN - PAD;
    const apis: ExpectedApi[] = [];
    const nonFuncSymbols: Symbol[] = [];
    let lines = 0;
    for (const r of meta.rels) {
      const p = parsed.get(r);
      if (p) {
        apis.push(...p.symbols.slice(0, 50 - apis.length));
        nonFuncSymbols.push(...p.nonFuncSymbols);
      }
      lines += lineCounts.get(r) ?? 0;
    }
    const base = communityNameOf(meta.rels);
    const label = baseNameCount.get(base)! > 1
      ? `🧩 ${base} · ${communityQualifier(meta.rels)}`
      : `🧩 ${base}`;
    nodes.push({
      id: moduleId(cid),
      label,
      x: Math.round(x),
      y: Math.round(y),
      width: containerW,
      height: containerH,
      type: 'module',
      style: { ...DIR_STYLE, borderRadius: 8 },
    });
    semanticFiles.push({
      id: moduleId(cid),
      path: meta.rels.join(', '),
      responsibility: `${base} — 聚合 ${meta.rels.length} 个文件 / ${apis.length + nonFuncSymbols.length} 个符号`,
      status: 'done',
      expected_apis: apis.length > 0 ? apis : undefined,
      symbols: nonFuncSymbols.length > 0 ? nonFuncSymbols : undefined,
      lines,
    });
  }

  // 6. 组装社区间依赖边（按 id 排序保证确定性）
  const edges: Edge[] = [];
  const sorted = [...agg.values()].sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to));
  for (const { from, to, n } of sorted) {
    edges.push({
      id: `dep_${sanitize(from)}_${sanitize(to)}`,
      from,
      to,
      label: n > 1 ? `imports ×${n}` : 'imports',
      type: 'dashed',
      style: n > 3 ? { strokeWidth: 2 } : undefined,
    });
  }

  return { nodes, edges, semanticFiles, size: { w: contentW, h: contentH } };
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────

/** ParsedSymbol.kind 到 Symbol.kind 的映射（仅非函数类） */
function parsedKindToSymbolKind(kind: string): Symbol['kind'] {
  switch (kind) {
    case 'class': return 'class';
    case 'interface': return 'interface';
    case 'type': return 'type';
    default: return 'type';
  }
}

/** 汇总目录下所有符号和 API */
function aggregateDirSymbols(
  dir: string,
  files: FileEntry[],
  parsed: Map<string, { symbols: ExpectedApi[]; nonFuncSymbols: Symbol[]; imports: ParsedImport[] }>,
): { apis: ExpectedApi[]; nonFuncSymbols: Symbol[] } {
  const apis: ExpectedApi[] = [];
  const nonFuncSymbols: Symbol[] = [];
  for (const f of files) {
    const p = parsed.get(f.rel);
    if (p) {
      // 每个目录最多保留 50 API，避免过大
      apis.push(...p.symbols.slice(0, 50 - apis.length));
      nonFuncSymbols.push(...p.nonFuncSymbols);
    }
  }
  return { apis, nonFuncSymbols };
}

export async function importProject(input: ImportProjectInput): Promise<ImportProjectResult> {
  const { feature, max_files = 200, include_tests = false } = input;
  const root = path.resolve(input.project_dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`project_dir 不存在或不是目录: ${root}`);
  }

  // ── 积木折叠（拼装区黑盒化）──
  // 拼装区根的 assembly.json（assemble_bricks 出生证明）记录每个积木的
  // dest_root 与契约投影（description/aggregate）。据此把积木折叠成 DSL
  // 单符号节点：内部文件不进 geometry/semantic——LLM 检索 DSL 不再看
  // 已治理功能的内部细节（减少检索负担），接口事实只读契约投影；
  // 唯一事实来源仍是盒内 manifest，assembly.json 只是拼装时点的快照。
  const brickFolds = readAssemblyBricks(root);
  const brickByPrefix = new Map<string, BrickFoldInfo>();
  for (const b of brickFolds) brickByPrefix.set(b.dest_root, b);
  /** 文件归属积木判定（rel 以 '<dest_root>' 开头即积木内部文件） */
  const brickOf = (rel: string): BrickFoldInfo | null => {
    const slash = rel.indexOf('/');
    if (slash === -1) return null;
    return brickByPrefix.get(rel.slice(0, slash + 1)) ?? null;
  };

  // 1. 扫描文件
  let absFiles = walkFiles(root, include_tests, input.include_archive ?? false);
  const skipped: string[] = [];
  // 拼装区：积木内部文件排序靠后——黑盒无需优先解析符号，
  // max_files 截断时优先保 glue/外部文件（黑盒边界边不因截断而断）
  if (brickFolds.length > 0) {
    absFiles = [...absFiles].sort((a, b) => {
      const aB = brickOf(toPosix(path.relative(root, a))) ? 1 : 0;
      const bB = brickOf(toPosix(path.relative(root, b))) ? 1 : 0;
      if (aB !== bB) return aB - bB;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }
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
  const brickFilesTotal = files.filter((f) => brickOf(f.rel)).length;
  const index = buildIndex(files);
  for (const c of index.collisions) skipped.push(`同名碰撞: ${c}`);
  const goModules = readGoModules(root);

  // 2. 解析符号 + import（顺带统计行数，零成本复用已读内容做单文件监控）
  const parsed = new Map<string, { symbols: ExpectedApi[]; nonFuncSymbols: Symbol[]; imports: ParsedImport[] }>();
  const lineCounts = new Map<string, number>();
  let symbolsFound = 0;
  let cacheStats: { hits: number; reparsed: number; failed: number } | undefined;

  /** 两条路径共用的收录逻辑：50 上限截断 + 分离非函数符号 + 计数 + 登记 */
  const ingest = (rel: string, syms: Array<{ kind: string; name: string; signature: string | null; start_line: number; end_line: number }>, imps: ParsedImport[]): void => {
    const funcApis: ExpectedApi[] = [];
    const nonFuncSymbols: Symbol[] = [];
    for (const s of syms) {
      if (s.kind === 'function' || s.kind === 'method') {
        // 每文件 API 上限 50，超出记注（防止巨型生成文件撑爆 DSL）
        if (funcApis.length < 50) {
          funcApis.push({
            signature: s.signature ?? s.name,
            line: s.start_line,
            end_line: s.end_line,
            notes: `L${s.start_line}-${s.end_line}`,
          });
        }
      } else {
        // 非函数符号（class/interface/type）——无数量限制，数量通常远少于函数
        nonFuncSymbols.push({
          name: s.name,
          kind: parsedKindToSymbolKind(s.kind),
          line: s.start_line,
          end_line: s.end_line,
          signature: s.signature ?? undefined,
        });
      }
    }
    if (syms.length > 50) {
      skipped.push(`${rel}: 符号数 ${syms.length} 超上限，仅收录前 50 个 API`);
    }
    // 黑盒内部符号不计入（报告口径 = DSL/LLM 可见面；积木符号在盒内 manifest）
    if (!brickOf(rel)) symbolsFound += funcApis.length;
    parsed.set(rel, { symbols: funcApis, nonFuncSymbols, imports: imps });
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
        parsed.set(f.rel, { symbols: [], nonFuncSymbols: [], imports: [] });
        continue;
      }
      if (r.status === 'skipped') cacheStats.hits++;
      else cacheStats.reparsed++;
      lineCounts.set(f.rel, cached.line_count);
      ingest(f.rel, cached.symbols, cached.imports);
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
      // TS `import type` 运行时擦除——不算依赖边（与 syncFile/import_graph 同一纪律）
      if (imp.type_only) continue;
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

  // ── 3.5 节点 ID 与积木折叠分流（须在 functional_mode / 目录树 / 边聚合前）──
  const sanitize = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileNodeId = (rel: string): string => `file_${sanitize(rel)}`;
  const dirNodeId = (rel: string): string => `dir_${sanitize(rel)}`;
  const brickNodeId = (name: string): string => `brick_${sanitize(name)}`;
  /** 设计模式下：返回文件所属的顶级目录节点 ID（root 的直接子目录） */
  const topDirNodeId = (rel: string): string => {
    const slash = rel.indexOf('/');
    if (slash === -1) return dirNodeId(''); // 根目录文件，聚合到根
    return dirNodeId(rel.slice(0, slash));
  };

  /**
   * 依赖边三分流：积木内部边（黑盒吞掉）/ 折叠边（积木↔外部，端点重定向
   * 到积木节点）/ 普通边（两端皆外部，走原有 lca 聚合）。
   */
  const plainDeps: Array<[string, string]> = [];
  const foldedDeps: Array<{ from: string; to: string }> = [];
  for (const [fromRel, toRel] of fileDeps) {
    const fb = brickOf(fromRel);
    const tb = brickOf(toRel);
    if (fb && fb === tb) continue; // 积木内部边：黑盒内部不可见
    if (!fb && !tb) {
      plainDeps.push([fromRel, toRel]);
      continue;
    }
    foldedDeps.push({
      from: fb ? brickNodeId(fb.name) : fromRel,
      to: tb ? brickNodeId(tb.name) : toRel,
    });
  }
  /** 折叠边外部端的节点 id：根散文件=文件节点；深层文件=顶级目录容器（与 lca 聚合同一降级语义） */
  const foldPeerId = (rel: string): string | null => {
    if (input.design_mode && !rel.includes('/')) return null; // design_mode 忽略根散文件依赖（与原逻辑一致）
    const slash = rel.indexOf('/');
    return slash === -1 ? fileNodeId(rel) : dirNodeId(rel.slice(0, slash));
  };
  const brickEdgeAgg = new Map<string, { from: string; to: string; n: number }>();
  const brickLayoutDeps: Array<[string, string]> = [];
  for (const { from, to } of foldedDeps) {
    const fromId = from.startsWith('brick_') ? from : foldPeerId(from);
    const toId = to.startsWith('brick_') ? to : foldPeerId(to);
    if (!fromId || !toId || fromId === toId) continue;
    const key = `${fromId}|${toId}`;
    const cur = brickEdgeAgg.get(key);
    if (cur) cur.n++;
    else brickEdgeAgg.set(key, { from: fromId, to: toId, n: 1 });
    if (!brickLayoutDeps.some(([a, b]) => a === fromId && b === toId)) brickLayoutDeps.push([fromId, toId]);
  }

  /** 积木黑盒节点 + 语义层条目（契约投影自 assembly.json；坐标由调用方回填） */
  const buildBrickNode = (b: BrickFoldInfo): { node: Node; semantic: SemanticFile } => {
    const agg = b.aggregate;
    const members = files.filter((f) => brickOf(f.rel)?.name === b.name);
    const lines = members.reduce((s, f) => s + (lineCounts.get(f.rel) ?? 0), 0);
    const apis: ExpectedApi[] = (agg?.exposes ?? []).slice(0, 50).map((s) => ({
      signature:
        `${s.kind} ${s.name}` +
        (s.fields.length > 0
          ? `：${s.fields.slice(0, 5).map((f) => f.name).join('、')}${s.fields.length > 5 ? ' …' : ''}`
          : ''),
      line: 0,
      notes: `origin: ${s.origin}${s.fields.length > 0 ? `，${s.fields.length} 成员` : ''}`,
    }));
    const node: Node = {
      id: brickNodeId(b.name),
      label: `🧱 ${b.name} · ${members.length} 文件`,
      x: 0,
      y: 0,
      width: BRICK_W,
      height: BRICK_H,
      type: 'module',
      status: 'done',
      title: b.description,
      description: b.dest_root,
      style: { ...BRICK_STYLE, borderRadius: 8 },
      attributes: agg
        ? {
            exposes: agg.exposes.map((e) => e.name).join(', ') || '—',
            consumes: agg.consumes.map((c) => c.name).join(', ') || '—',
            emits: agg.emits.join(', ') || '—',
            irreversible_effects: agg.irreversible_effects,
          }
        : undefined,
    };
    const semantic: SemanticFile = {
      id: brickNodeId(b.name),
      path: b.dest_root,
      responsibility: b.description
        ? `${b.description}（积木黑盒：${members.length} 文件折叠，契约投影自 assembly.json）`
        : `积木黑盒：${members.length} 文件折叠（契约投影自 assembly.json）`,
      status: 'done',
      expected_apis: apis.length > 0 ? apis : undefined,
      lines,
    };
    return { node, semantic };
  };

  // 6.0 布局/语义产出（目录路径用；functional_mode 提前产出并返回）
  let nodes: Node[] = [];
  let edges: Edge[] = [];
  let semanticFiles: SemanticFile[] = [];
  let rootSize: { w: number; h: number } = { w: 0, h: 0 };
  let renderedDepEdges = 0;

  /** 共享收尾：组装 DSL → 分层 → 可选职责标题 → 落盘 → 报告 */
  const finalizeDsl = async (): Promise<ImportProjectResult> => {
    const canvasW = Math.round(rootSize.w + MARGIN * 2);
    const canvasH = Math.round(rootSize.h + MARGIN * 2 + TITLE_H);
    const dsl: DesignDSL = {
      id: `imported_${feature}`,
      type: 'feature_diagram',
      feature,
      version: '1.0.0',
      title: input.title || feature,
      source_root: input.source_root,
      status: 'done',
      geometry: {
        layout: 'free',
        width: Math.max(canvasW, 800),
        height: Math.max(canvasH, 400),
        nodes,
        edges,
      },
      semantic: { files: semanticFiles },
    } as DesignDSL;

    const layered = detectArchLayers(dsl);

    let roleNote: string | null = null;
    if (input.gen_roles) {
      const roleFiles = input.design_mode || input.functional_mode
        ? semanticFiles
            // 积木黑盒条目不进 LLM 职责生成（title=盒内 description 事实，不由 LLM 重述）
            .filter((sf) => sf.path && !sf.id.startsWith('brick_'))
            .map((sf) => {
              const p = sf.path!.endsWith('/') ? sf.path!.slice(0, -1) : sf.path!;
              return { path: p, dir: sf.path === '' ? '根' : p, apis: (sf.expected_apis ?? []).map((s) => s.signature) };
            })
        : files
            .filter((f) => !brickOf(f.rel))
            .map((f) => ({
              path: f.rel,
              dir: f.dir === '.' ? '根' : f.dir,
              apis: (parsed.get(f.rel)?.symbols ?? []).map((s) => s.signature),
            }));
      const titles = await generateFileRoleTitles(roleFiles);
      if (Object.keys(titles).length > 0) {
        for (const n of nodes) {
          if (n.type !== 'file' && n.type !== 'module') continue;
          const rel = n.description || (n.id.startsWith('dir_') ? n.id.replace(/^dir_/, '').replace(/_/g, '/') : '');
          const searchRel = rel.endsWith('/') ? rel.slice(0, -1) : rel;
          const t = titles[searchRel];
          if (t) {
            n.title = t;
            const sf = semanticFiles.find((f) => f.id === n.id);
            if (sf) sf.responsibility = `${t}（${sf.responsibility}）`;
          }
        }
        roleNote = `职责标题 ${Object.keys(titles).length} 个（LLM 生成）`;
      } else {
        roleNote = '职责标题未生成（未配置 LLM 或调用失败，仅显示文件名）';
      }
    }

    if (input.live_only) {
      saveLiveFeature(layered, input.live_dir);
    } else {
      saveDSL(layered);
    }

    const dirCount = nodes.filter((n) => n.type === 'module').length;
    const oversized = files
      // 积木内部文件不做单文件化预警（黑盒内部已四层验证，报告不报盒内事务）
      .filter((f) => !brickOf(f.rel))
      .map((f) => ({ rel: f.rel, lines: lineCounts.get(f.rel) ?? 0 }))
      .filter((x) => assessLines(x.lines) !== 'ok')
      .sort((a, b) => b.lines - a.lines);
    const message = [
      `已导入项目 → feature "${feature}"${input.design_mode ? '（设计模式：聚合文件到目录层级）' : input.functional_mode ? '（功能模式：按调用图社区聚合）' : ''}`,
      `项目根: ${path.resolve(input.project_dir)}`,
      `文件: ${files.length} 个 → ${nodes.length} 节点（符号 ${symbolsFound} 个，依赖 ${fileDeps.length} 条→渲染 ${renderedDepEdges} 条，模块节点 ${dirCount} 个）`,
      brickFolds.length > 0
        ? `积木折叠: ${brickFolds.length} 个黑盒节点（${brickFilesTotal} 文件折叠进盒，接口契约投影自 assembly.json；异常时再深挖盒内）`
        : null,
      cacheStats ? `缓存: 命中 ${cacheStats.hits} / 重解析 ${cacheStats.reparsed} / 失败 ${cacheStats.failed}` : null,
      goModules.length > 0 ? `Go modules: ${goModules.map((g) => g.module).join(', ')}` : null,
      oversized.length > 0
        ? `⚠ 单文件化预警 ${oversized.length} 个:\n  - ${oversized
            .map((x) => `${x.rel}（${x.lines} 行${x.lines >= 600 ? '，严重' : ''}）`)
            .join('\n  - ')}\n  → 运行 check_monolith 获取功能内聚拆分建议`
        : null,
      skipped.length > 0 ? `跳过/截断:\n  - ${skipped.join('\n  - ')}` : null,
      roleNote ? `职责标题: ${roleNote}` : null,
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
      bricks_folded: brickFolds.length > 0 ? brickFolds.length : undefined,
    };
  };

  // 6.1 功能模式：按调用图社区做功能性聚合，产出功能模块节点并提前返回
  if (input.functional_mode) {
    // 积木内部文件不参与社区检测（黑盒）；依赖用普通边（折叠边单独聚合）。
    // 积木折叠时跳过 skill 管线（analyze_monolith 自行读盘会把盒内文件吸进社区）
    const externalFiles = files.filter((f) => !brickOf(f.rel));
    const res = await buildFunctionalLayout(
      externalFiles,
      plainDeps,
      parsed,
      lineCounts,
      input.project_dir,
      !!input.gen_roles,
      input.cache_db,
      brickFolds.length === 0,
    );
    nodes = res.nodes;
    edges = res.edges;
    semanticFiles = res.semanticFiles;
    rootSize = res.size;
    renderedDepEdges = res.edges.length;

    // 积木黑盒节点：功能模块布局下方横排一行（坐标独立于社区布局）
    if (brickFolds.length > 0) {
      const rowY = res.size.h + 100;
      let xCursor = 0;
      for (const b of brickFolds) {
        const { node, semantic } = buildBrickNode(b);
        node.x = xCursor;
        node.y = rowY;
        nodes.push(node);
        semanticFiles.push(semantic);
        xCursor += BRICK_W + COL_GAP;
      }
      rootSize = { w: Math.max(res.size.w, xCursor - COL_GAP), h: rowY + BRICK_H };

      // brick ↔ 功能模块 边：semanticFiles.path（成员文件清单）反查文件归属模块
      const fileToModule = new Map<string, string>();
      for (const sf of res.semanticFiles) {
        for (const r of sf.path.split(', ')) fileToModule.set(r, sf.id);
      }
      const bagg = new Map<string, { from: string; to: string; n: number }>();
      for (const { from, to } of foldedDeps) {
        const fromId = from.startsWith('brick_') ? from : fileToModule.get(from);
        const toId = to.startsWith('brick_') ? to : fileToModule.get(to);
        if (!fromId || !toId || fromId === toId) continue;
        const key = `${fromId}|${toId}`;
        const cur = bagg.get(key);
        if (cur) cur.n++;
        else bagg.set(key, { from: fromId, to: toId, n: 1 });
      }
      const bSorted = [...bagg.values()].sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to));
      for (const { from, to, n } of bSorted) {
        edges.push({
          id: `dep_${sanitize(from)}_${sanitize(to)}`,
          from,
          to,
          label: n > 1 ? `imports ×${n}` : 'imports',
          type: 'dashed',
          style: n > 3 ? { strokeWidth: 2 } : undefined,
        });
      }
      renderedDepEdges += bSorted.length;
    }
    return await finalizeDsl();
  }

  // 4. 目录树
  interface DirNode {
    rel: string; // '' 表示项目根
    name: string;
    subdirs: Map<string, DirNode>;
    files: FileEntry[];
    /** 子树文件数（含自身文件 + 所有后代目录文件） */
    subtreeSize: number;
  }
  const rootDir: DirNode = { rel: '', name: path.basename(root), subdirs: new Map(), files: [], subtreeSize: 0 };
  const dirByRel = new Map<string, DirNode>([['', rootDir]]);
  const ensureDir = (rel: string): DirNode => {
    const existing = dirByRel.get(rel);
    if (existing) return existing;
    const parentRel = path.posix.dirname(rel);
    const parent = ensureDir(parentRel === '.' ? '' : parentRel);
    const d: DirNode = { rel, name: path.posix.basename(rel), subdirs: new Map(), files: [], subtreeSize: 0 };
    parent.subdirs.set(rel, d);
    dirByRel.set(rel, d);
    return d;
  };
  for (const f of files) {
    // 积木内部文件不进目录树（黑盒折叠——积木根目录不生成 dir 容器，
    // 由 brick 单符号节点代表）
    if (brickOf(f.rel)) continue;
    ensureDir(f.dir === '.' ? '' : f.dir).files.push(f);
  }
  // 子树文件数自底向上统计（目录排序用）
  const computeSubtree = (d: DirNode): number => {
    let n = d.files.length;
    for (const sub of d.subdirs.values()) n += computeSubtree(sub);
    d.subtreeSize = n;
    return n;
  };
  computeSubtree(rootDir);

  // 5. 节点 ID 生成器已上移至 3.5（积木折叠分流依赖；functional_mode 分支亦用）

  // 6. 布局（后序：先内层目录，尺寸向上传递）
  // 注：nodes/edges/semanticFiles 已在 6.0 声明为外层可变量，此处沿用

  /** 收集子树下所有文件（递归） */
  const collectSubtreeFiles = (d: DirNode): FileEntry[] => {
    const result = [...d.files];
    for (const sub of d.subdirs.values()) {
      result.push(...collectSubtreeFiles(sub));
    }
    return result;
  };

  /** 布局一个目录，返回其容器尺寸（根目录不生成容器节点） */
  const layoutDir = (dir: DirNode): { w: number; h: number } => {
    const items: LayoutItem[] = [];
    const localDeps: Array<[string, string]> = [];

    // 设计模式：聚合子文件到当前目录节点，不生成单个文件节点
    if (input.design_mode && dir.rel !== '') {
      // 在 design_mode 下，整个目录只生成一个模块节点，不需要展开子文件
      items.push({ id: dirNodeId(dir.rel), w: FILE_W * Math.min(dir.subtreeSize, 3), h: FILE_H, x: 0, y: 0 });
    } else {
      // 子目录先布局（递归），获得尺寸后作为 item
      const subdirOrder = (a: DirNode, b: DirNode): number => {
        const aIsEntry = a.files.some((f) => /main|index|server|app\./i.test(f.rel));
        const bIsEntry = b.files.some((f) => /main|index|server|app\./i.test(f.rel));
        if (aIsEntry !== bIsEntry) return aIsEntry ? -1 : 1;
        return b.subtreeSize - a.subtreeSize;
      };
      for (const sub of [...dir.subdirs.values()].sort(subdirOrder)) {
        const size = layoutDir(sub);
        items.push({ id: dirNodeId(sub.rel), w: size.w, h: size.h, x: 0, y: 0 });
      }
      // 文件节点（排序：入口文件优先，其余按行数降序）
      const fileOrder = (a: FileEntry, b: FileEntry): number => {
        const aIsEntry = /main|index|server|app\./i.test(a.rel);
        const bIsEntry = /main|index|server|app\./i.test(b.rel);
        if (aIsEntry !== bIsEntry) return aIsEntry ? -1 : 1;
        return (lineCounts.get(b.rel) ?? 0) - (lineCounts.get(a.rel) ?? 0);
      };
      if (!input.design_mode) {
        for (const f of [...dir.files].sort(fileOrder)) {
          items.push(fileLayout.get(f.rel)!);
        }
      }
      // 积木黑盒参与根级布局（拼装区：积木与 glue 目录平级；布局拓扑含折叠边）
      if (dir.rel === '') {
        for (const b of brickFolds) {
          items.push({ id: brickNodeId(b.name), w: BRICK_W, h: BRICK_H, x: 0, y: 0 });
        }
        for (const [a, b] of brickLayoutDeps) localDeps.push([a, b]);
      }
      // 局部依赖：两端都在本目录直接子级
      const ownerOf = (rel: string): string => {
        if (dir.files.some((f) => f.rel === rel)) return fileNodeId(rel);
        for (const sub of dir.subdirs.keys()) {
          if (rel.startsWith(sub + '/')) return dirNodeId(sub);
        }
        return '';
      };
      for (const [fromRel, toRel] of plainDeps) {
        const a = ownerOf(fromRel);
        const b = ownerOf(toRel);
        if (a && b && a !== b) localDeps.push([a, b]);
      }
      const content = layoutGroup(items, localDeps);

      // 写回子项局部坐标
      for (const item of items) {
        if (item.id.startsWith('file_')) {
          const rel = files.find((f) => fileNodeId(f.rel) === item.id)!.rel;
          fileLayout.get(rel)!.x = item.x;
          fileLayout.get(rel)!.y = item.y;
        } else if (item.id.startsWith('brick_')) {
          brickOffset.set(item.id, { x: item.x, y: item.y });
        } else {
          const subRel = [...dirByRel.values()].find((d) => d.rel !== '' && dirNodeId(d.rel) === item.id)!.rel;
          dirOffset.set(subRel, { x: item.x, y: item.y });
        }
      }

      const containerW = content.w + PAD * 2;
      const containerH = content.h + PAD * 2 + TITLE_H;
      if (dir.rel !== '') {
        nodes.push({
          id: dirNodeId(dir.rel),
          label: `📁 ${dir.name}`,
          x: 0,
          y: 0,
          width: containerW,
          height: containerH,
          type: 'module',
          style: { ...DIR_STYLE, borderRadius: 8 },
        });
      }
      dirContentOffset.set(dir.rel, { dx: PAD, dy: PAD + TITLE_H, w: containerW, h: containerH });
      return { w: containerW, h: containerH };
    }

    // ── 设计模式非根目录：单个模块节点，聚合符号到语义层 ──
    const subtreeFiles = collectSubtreeFiles(dir);
    const { apis, nonFuncSymbols } = aggregateDirSymbols(dir.rel, subtreeFiles, parsed);
    semanticFiles.push({
      id: dirNodeId(dir.rel),
      path: dir.rel + '/',
      responsibility: `${dir.rel} — 聚合 ${apis.length + nonFuncSymbols.length} 个符号`,
      status: 'done',
      expected_apis: apis.length > 0 ? apis : undefined,
      symbols: nonFuncSymbols.length > 0 ? nonFuncSymbols : undefined,
      lines: subtreeFiles.reduce((sum, f) => sum + (lineCounts.get(f.rel) ?? 0), 0),
    });
    const itemW = FILE_W * Math.min(dir.subtreeSize, 3);
    const containerW = itemW + PAD * 2;
    const containerH = FILE_H + PAD * 2 + TITLE_H;
    nodes.push({
      id: dirNodeId(dir.rel),
      label: `📁 ${dir.name}`,
      x: 0,
      y: 0,
      width: containerW,
      height: containerH,
      type: 'module',
      style: { ...DIR_STYLE, borderRadius: 8 },
    });
    dirContentOffset.set(dir.rel, { dx: PAD, dy: PAD + TITLE_H, w: containerW, h: containerH });
    return { w: containerW, h: containerH };
  };

  const fileLayout = new Map<string, LayoutItem>();
  if (!input.design_mode) {
    for (const f of files) {
      fileLayout.set(f.rel, { id: fileNodeId(f.rel), w: FILE_W, h: FILE_H, x: 0, y: 0 });
    }
  }

  const dirContentOffset = new Map<string, { dx: number; dy: number; w: number; h: number }>();
  const dirOffset = new Map<string, { x: number; y: number }>();
  /** 积木黑盒节点局部坐标（根级 item，accumulate 后回填） */
  const brickOffset = new Map<string, { x: number; y: number }>();

  // 根级布局：把根目录当作一个组（不生成根容器）
  rootSize = layoutDir(rootDir);

  // 7. 汇总坐标：自根向下累加
  const accumulate = (dirRel: string, baseX: number, baseY: number): void => {
    const d = dirByRel.get(dirRel)!;
    const selfOff = dirOffset.get(dirRel) || { x: 0, y: 0 };
    const content = dirContentOffset.get(dirRel)!;
    const containerX = baseX + selfOff.x;
    const containerY = baseY + selfOff.y;
    const contentX = dirRel === '' ? containerX : containerX + content.dx;
    const contentY = dirRel === '' ? containerY : containerY + content.dy;
    if (dirRel !== '') {
      const node = nodes.find((n) => n.id === dirNodeId(dirRel))!;
      node.x = containerX;
      node.y = containerY;
    }

    if (input.design_mode && dirRel !== '') {
      // 设计模式非根目录：不处理子文件，也不递归子目录（已聚合到当前目录节点）
    } else {
      if (!input.design_mode) {
        for (const f of d.files) {
          const item = fileLayout.get(f.rel)!;
          item.x += contentX;
          item.y += contentY;
        }
      }
      for (const sub of d.subdirs.values()) {
        accumulate(sub.rel, contentX, contentY);
      }
    }
  };
  accumulate('', MARGIN, MARGIN);

  // 积木黑盒节点（普通/design 模式；functional 已在提前返回分支处理）：
  // 单符号 + 契约投影（exposes/consumes/emits 进 attributes，接口面进语义层）
  for (const b of brickFolds) {
    const { node, semantic } = buildBrickNode(b);
    nodes.push(node);
    semanticFiles.push(semantic);
  }

  // 积木黑盒节点坐标回填：根级 item 局部坐标 + 根内容原点（根无容器，内容原点 = MARGIN）
  for (const [id, off] of brickOffset) {
    const n = nodes.find((x) => x.id === id);
    if (n) {
      n.x = Math.round(off.x + MARGIN);
      n.y = Math.round(off.y + MARGIN);
    }
  }

  // 8. 文件节点 + 边 + 语义层（设计模式：每个目录聚合所有子文件符号）
  if (!input.design_mode) {
    for (const f of files) {
      // 积木内部文件：黑盒折叠，无节点无语义条目（由 brick 单符号节点代表）
      if (brickOf(f.rel)) continue;
      const p = parsed.get(f.rel);
      const apis = p?.symbols || [];
      const syms = p?.nonFuncSymbols || [];
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
        symbols: syms.length > 0 ? syms : undefined,
        lines: lineCounts.get(f.rel) ?? 0,
      });
    }
  }
  for (const d of [...dirByRel.values()].sort((a, b) => a.rel.localeCompare(b.rel))) {
    if (input.design_mode) continue; // 设计模式只保留顶级目录节点，无父子 contains 边
    if (d.rel === '') continue;
    const parentRel = path.posix.dirname(d.rel);
    const parentId = parentRel === '.' || parentRel === '' ? null : dirNodeId(parentRel);
    if (parentId) {
      edges.push({ id: `contains_${sanitize(parentRel)}_${sanitize(d.rel)}`, from: parentId, to: dirNodeId(d.rel), label: 'contains' });
    }
  }

  // 聚合依赖边
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
  for (const [fromRel, toRel] of plainDeps) {
    if (input.design_mode) {
      // 设计模式：只聚合到顶级目录（root 的直接子目录），忽略根目录散文件依赖（无 '/' 的 rel）
      if (!fromRel.includes('/') || !toRel.includes('/')) continue;
      const fromTop = topDirNodeId(fromRel);
      const toTop = topDirNodeId(toRel);
      if (fromTop === toTop) continue; // 同一目录内，跳过（内部依赖）
      const key = `${fromTop}|${toTop}`;
      const cur = aggEdges.get(key);
      if (cur) cur.n++;
      else aggEdges.set(key, { from: fromTop, to: toTop, n: 1 });
    } else {
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
  }

  if (!input.design_mode) {
    for (const [fromRel, toRel] of directEdges) {
      edges.push({
        id: `dep_${sanitize(fromRel)}_${sanitize(toRel)}`,
        from: fileNodeId(fromRel),
        to: fileNodeId(toRel),
        label: 'imports',
        type: 'dashed',
      });
    }
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

  // 积木折叠边：brick ↔ 顶级节点（已聚合；积木内部边在分流阶段吞掉）
  const brickSorted = [...brickEdgeAgg.values()].sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to));
  for (const { from, to, n } of brickSorted) {
    edges.push({
      id: `dep_${sanitize(from)}_${sanitize(to)}`,
      from,
      to,
      label: n > 1 ? `imports ×${n}` : 'imports',
      type: 'dashed',
      style: n > 3 ? { strokeWidth: 2 } : undefined,
    });
  }

  renderedDepEdges = directEdges.length + aggSorted.length + brickSorted.length;

  // 9. 组装 DSL + 落盘 + 报告（目录路径收尾，功能模式已提前返回）
  return await finalizeDsl();
}

export { parsedKindToSymbolKind };