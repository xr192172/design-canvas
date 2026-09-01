/**
 * project_root —— 自动定位项目根 + 动态闭包边界（消除"必须显式传 project_dir"的使用摩擦）
 *
 * 背景（工具被主动使用的障碍 #1/#2，见 docs/tool-convergence.md 5.6 节）：
 *   rename_symbol 等工具要求调用方显式传 project_dir，LLM 得先自己知道项目根——
 *   这是"不会想起来用"的第一根因。本项目内自己就是嵌套 git 实例：
 *   design-canvas-main（外壳非 git）内含 design-canvas/、dsl-workbench/ 两个独立 git 仓库。
 *
 * 本模块提供两级能力：
 *   1. resolveProjectRoot(file)：从文件自动定位初始项目根
 *        a. git rev-parse --show-toplevel 成功 → git 根（嵌套 git 天然返回最近仓库根）
 *        b. 否则向上找最近 manifest（package.json/go.mod/pyproject.toml）→ 其目录
 *        c. 都没有 → 文件所在目录
 *   2. expandClosure(seedFile, root)：沿 import 边做动态闭包边界
 *        - 初始 = 项目根内全部本地源文件（覆盖"谁引用 seed"的 importer 方向）
 *        - 对每个文件解析 import；相对导入（./ ../）若真实解析到边界外本地文件 → 扩入
 *          （覆盖"seed 依赖外层文件"的 importee 方向；解决跨 git 根引用漏改）
 *        - 排除 node_modules / dist / 隐目录 / 三方裸包（相对导入才解析到本地文件）
 *        - 结果 = 自包含的本地文件闭包
 *
 * 独立性：现场解析（不依赖 import_project 建的 cache.db），零前置状态。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { analyzeModuleSource } from './rename_symbol.js';

/** 本地源扩展名（闭包只收这些；与 rename_symbol/rename_file 的 TS_EXTS 对齐） */
const SRC_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.go', '.py', '.vue', '.java']);

/** 跳过的目录名（闭包扫描绝不进入） */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.svn', '.hg', 'vendor', 'target', 'out', 'output', '.next', '.nuxt', '__pycache__', '.venv', 'venv']);

/** 项目根标志文件（manifest，git 之外的项目边界判据） */
const MANIFESTS = ['package.json', 'go.mod', 'pyproject.toml', 'Cargo.toml', 'pom.xml', 'composer.json', 'pubspec.yaml', 'build.gradle'];

/** 邻域项目样兄弟数量上限：超过即判定为 temp/缓存容器（非工作区），短路不扫 */
const NEIGHBOR_LIMIT = 20;

function isSkippedDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith('.');
}

/**
 * 从 file 向上找 git 根（用 git 自身，嵌套 git 天然返回最近仓库根）。
 * 返回绝对路径或 null。
 */
export function gitRootOf(file: string): string | null {
  let dir = path.resolve(file);
  if (!fs.existsSync(dir)) dir = path.dirname(dir);
  if (fs.statSync(dir).isFile()) dir = path.dirname(dir);
  try {
    const out = execSync('git rev-parse --show-toplevel', { cwd: dir, encoding: 'utf-8', stdio: 'pipe', timeout: 15_000 });
    const root = out.trim();
    return root ? path.resolve(root) : null;
  } catch {
    return null; // 非 git 仓库
  }
}

/**
 * 从 file 向上找最近的 manifest 目录（非 git 项目的边界判据）。
 * 返回 manifest 所在目录的绝对路径，或 null。
 */
export function manifestRootOf(file: string): string | null {
  let dir = path.resolve(file);
  if (fs.existsSync(dir) && fs.statSync(dir).isFile()) dir = path.dirname(dir);
  for (;;) {
    for (const m of MANIFESTS) {
      if (fs.existsSync(path.join(dir, m))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * 自动定位项目根：git 根优先（嵌套安全），否则最近 manifest，否则文件所在目录。
 */
export function resolveProjectRoot(file: string): string {
  const git = gitRootOf(file);
  if (git) return git;
  const manifest = manifestRootOf(file);
  if (manifest) return manifest;
  const p = path.resolve(file);
  return fs.existsSync(p) && !fs.statSync(p).isFile() ? p : path.dirname(p);
}

/** 递归收集目录内全部本地源文件（跳过噪音目录） */
export function walkProjectFiles(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (isSkippedDir(e.name)) continue;
      walkProjectFiles(p, out);
    } else if (e.isFile() && SRC_EXTS.has(path.extname(e.name))) {
      out.push(p);
    }
  }
}

/** 把绝对路径 base 补成真实文件：直接命中 / 补扩展名 / 目录索引（.go/.py/.vue 一并） */
export function resolveToFile(p: string): string | null {
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  if (!path.extname(p)) {
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.go', '.py', '.vue']) {
      const cand = p + ext;
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
    }
  }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
    for (const name of ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'mod.ts', 'mod.go', '__init__.py']) {
      const cand = path.join(p, name);
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
    }
  }
  return null;
}

/**
 * 真实解析相对 import 到磁盘文件（不依赖任何预建索引表）。
 * 处理：扩展名补全（./x → x.ts/tsx/js/...）、目录索引（./dir → dir/index.ts）。
 * 只解析相对导入（./ ../）；裸包名 / 绝对路径 / 外部 → 返回 null（不属本地闭包）。
 */
export function realResolveImport(importerAbs: string, source: string): string | null {
  if (!source.startsWith('.')) return null;
  return resolveToFile(path.resolve(path.dirname(importerAbs), source));
}

// ─────────────────────────────────────────────
// tsconfig 路径别名（@/ 等）：真实项目几乎必用，别名导入若解析不到 → 漏改
// ─────────────────────────────────────────────

/** 解析后的别名配置：baseUrl（绝对）+ paths 前缀映射（最长前缀优先） */
export interface AliasConfig {
  /** baseUrl 绝对路径（无显式时=tsconfig 所在目录） */
  baseUrl: string;
  /** paths 展开：prefix（如 '@/'）→ 目标模板数组（相对 baseUrl；含 '*' 通配） */
  paths: Array<{ prefix: string; targets: string[] }>;
}

/**
 * 从 root 向上找最近的 tsconfig.json / jsconfig.json（jsconfig 兜底）。
 * 向上搜索覆盖 monorepo：paths 常定义在仓库根 tsconfig，包内文件在子目录。
 */
function findConfigFile(root: string): string | null {
  let dir = path.resolve(root);
  for (;;) {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * 读取并合并 tsconfig compilerOptions（支持一级 extends；子配置覆盖父）。
 * 无 tsconfig / 无 baseUrl+paths → 返回 null。
 */
export function loadAliasConfig(root: string): AliasConfig | null {
  const cfgFile = findConfigFile(root);
  if (!cfgFile) return null;
  const cfgDir = path.dirname(cfgFile);
  let cfg: any = null;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));
  } catch {
    return null;
  }
  // 一级 extends：父配置提供默认，子配置覆盖
  if (cfg && typeof cfg.extends === 'string') {
    try {
      const parent = JSON.parse(fs.readFileSync(path.resolve(cfgDir, cfg.extends), 'utf-8'));
      cfg = { ...parent, ...cfg, compilerOptions: { ...parent?.compilerOptions, ...cfg?.compilerOptions } };
    } catch {
      /* extends 解析失败不影响自身配置 */
    }
  }
  const opts = cfg?.compilerOptions;
  if (!opts) return null;
  const baseUrl = opts.baseUrl ? path.resolve(cfgDir, opts.baseUrl) : cfgDir;
  const paths = opts.paths && typeof opts.paths === 'object' ? opts.paths : {};
  const list: AliasConfig['paths'] = Object.entries(paths)
    .map(([prefix, targets]) => ({ prefix, targets: Array.isArray(targets) ? targets.map(String) : [] }))
    .filter((p) => p.targets.length > 0)
    .sort((a, b) => b.prefix.length - a.prefix.length); // 最长前缀优先（TS 语义）
  const hasPaths = list.length > 0;
  const hasBaseUrl = typeof opts.baseUrl === 'string';
  if (!hasPaths && !hasBaseUrl) return null;
  return { baseUrl, paths: list };
}

/**
 * 非相对导入 → 本地文件：paths 前缀（key 中 '*' 是通配，拆出头部做前缀匹配）→ baseUrl 直连。
 * 解析不到本地文件（如裸包 node_modules）→ null（不属本地闭包）。
 */
export function resolveAliasedImport(source: string, alias: AliasConfig): string | null {
  // 1) paths 前缀
  for (const { prefix, targets } of alias.paths) {
    const starIdx = prefix.indexOf('*');
    let rest: string | null = null;
    if (starIdx === -1) {
      // 精确 key：必须全等
      if (source === prefix) rest = '';
    } else {
      // 通配 key：'@/*' → 头 '@/'；source 以头开头、以尾结尾（尾通常为空）
      const head = prefix.slice(0, starIdx);
      const tail = prefix.slice(starIdx + 1);
      if (source.startsWith(head) && source.endsWith(tail) && source.length >= head.length + tail.length) {
        rest = source.slice(head.length, source.length - tail.length);
      }
    }
    if (rest === null) continue;
    for (const t of targets) {
      const mapped = t.includes('*') ? t.replace('*', rest) : t;
      const hit = resolveToFile(path.resolve(alias.baseUrl, mapped));
      if (hit) return hit;
    }
  }
  // 2) baseUrl 直连（如 'shared/util' 未配 paths，但 baseUrl 下恰好有该文件）
  return resolveToFile(path.resolve(alias.baseUrl, source));
}

/** 判断绝对路径是否属于本地源码（非 node_modules/隐目录/三方），供闭包纳入判定 */
export function isLocalSource(abs: string): boolean {
  const parts = abs.split(/[\\/]/);
  return !parts.some((s) => isSkippedDir(s));
}

// ─────────────────────────────────────────────
// importer 邻域扫描：根外文件引用 seed（Git 嵌套 / 兄弟仓库互引）
// ─────────────────────────────────────────────

/** 目录是否"项目样"（有 .git 或 manifest）——邻域扫描只进入这类兄弟目录，保证有界 */
export function isProjectDir(d: string): boolean {
  return fs.existsSync(path.join(d, '.git')) || MANIFESTS.some((m) => fs.existsSync(path.join(d, m)));
}

/** 文件是否通过相对 import 真实引用 targetAbs（TS 系才解析；跨项目常见形态是相对路径） */
async function importsTargetFile(fileAbs: string, targetAbs: string): Promise<boolean> {
  const ext = path.extname(fileAbs);
  if (!['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].includes(ext)) return false;
  let mod: Awaited<ReturnType<typeof analyzeModuleSource>> | null = null;
  try {
    mod = await analyzeModuleSource(fs.readFileSync(fileAbs, 'utf-8'), fileAbs);
  } catch {
    return false;
  }
  if (!mod) return false;
  for (const e of mod.imports) {
    if (!e.source || !e.source.startsWith('.')) continue; // 邻域只按相对路径追（跨项目常见形态）
    const real = realResolveImport(fileAbs, e.source);
    if (real && path.resolve(real) === targetAbs) return true;
  }
  return false;
}

/**
 * importer 邻域有界扫描：找到「根外、但引用了 seedFile」的本地文件。
 *
 * 只扫 **seed 根的直属兄弟目录**（root 的父目录里的项目样邻居 + 该层松散源文件），
 * 不向更上层上爬 —— 避免从 Temp/build 等深层路径一路扫进整个文件树里的项目。
 * 邻域语义 = "同 monorepo 根 / 同工作区下的平铺兄弟仓库"，本就是 root 直属层。
 *
 * 防御：先数项目样兄弟数量，若远超工作区规模（> NEIGHBOR_LIMIT）→ 判定为 temp/缓存
 * 容器（历史测试残留），直接短路返回 —— 防止对上千个噪声目录逐个全量扫描。
 *
 *  - 只处理根的直接父目录一层：进入其中"项目样"兄弟（.git/manifest）+ 该层松散源文件
 *  - 排除 root 自身子树 / 噪音目录 / 用户主目录 / 驱动器根
 *  - 匹配：相对 import 真实解析到 seedFile（跨项目常见形态；别名/裸包不在本版，见 docs 边界）
 * 返回被引用 seedFile 的文件绝对路径列表。
 */
export async function findExternalImporters(seedFile: string, root: string): Promise<string[]> {
  const seedAbs = path.resolve(seedFile);
  const rootAbs = path.resolve(root);
  const home = path.resolve(homedir());
  const siblingDir = path.dirname(rootAbs);
  if (siblingDir === path.dirname(siblingDir)) return []; // root 已在驱动器（盘）根 → 无兄弟层
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(siblingDir, { withFileTypes: true });
  } catch {
    return [];
  }
  // 防御：项目样兄弟数量异常 → 这是 temp/缓存容器，不是工作区，短路（不逐个 walk）
  let projectLike = 0;
  for (const e of entries) {
    if (!e || !e.isDirectory() || isSkippedDir(e.name)) continue;
    const p = path.join(siblingDir, e.name);
    if (p === rootAbs || rootAbs.startsWith(p + path.sep)) continue;
    if (isProjectDir(p)) projectLike++;
    if (projectLike > NEIGHBOR_LIMIT) return [];
  }
  const out: string[] = [];
  const candidates: string[] = [];
  for (const e of entries) {
    if (!e) continue;
    if (isSkippedDir(e.name)) continue;
    const p = path.join(siblingDir, e.name);
    if (p === rootAbs || rootAbs.startsWith(p + path.sep)) continue; // 排除 root 自身子树与其祖先
    if (e.isDirectory()) {
      if (isProjectDir(p) && path.resolve(p) !== home) walkProjectFiles(p, candidates);
    } else if (e.isFile() && SRC_EXTS.has(path.extname(e.name))) {
      candidates.push(p); // 该层松散源文件（如根旁的 shared.ts）
    }
  }
  for (const f of candidates) {
    const abs = path.resolve(f);
    if (abs === seedAbs || !isLocalSource(abs)) continue;
    if (await importsTargetFile(abs, seedAbs)) out.push(abs);
  }
  return out;
}

/**
 * 动态闭包边界：给定种子文件 + 初始项目根，返回自包含的本地源文件集合。
 *  - 初始 = 项目根内全部本地源（importer 方向全覆盖：谁引用 seed 不漏）
 *  - BFS 沿 import 边扩展：相对导入（./ ../）或别名导入（@/ 等，需 alias）真实解析到
 *    边界外本地文件 → 扩入（importee 方向：seed 依赖不漏）
 *  - 邻域 importer 有界扫描：根外兄弟项目/松散文件引用 seed → 扩入（importer 方向，
 *    覆盖跨 git 根引用，如 dsl-workbench 引用 design-canvas）
 *  - 跨 git 根引用也被纳入（不依赖单一 project_dir 的物理边界）
 *  - alias 可省略：缺省时按 root 的 tsconfig 自动加载；传 null 显式禁用别名解析
 */
export async function expandClosure(seedFile: string, root: string, alias?: AliasConfig | null): Promise<string[]> {
  const aliasCfg = alias === undefined ? loadAliasConfig(root) : alias;
  const included = new Map<string, boolean>(); // absPath → 是否已解析其 imports
  const queue: string[] = [];
  const seedAbs = path.resolve(seedFile);

  // 初始：项目根内全部本地源 + 种子文件（种子可能不在根内，如跨根引用起点）
  const rootFiles: string[] = [];
  walkProjectFiles(root, rootFiles);
  for (const f of rootFiles) {
    if (!included.has(f)) {
      included.set(f, false);
      queue.push(f);
    }
  }
  if (!included.has(seedAbs) && isLocalSource(seedAbs)) {
    included.set(seedAbs, false);
    queue.push(seedAbs);
  }

  // BFS 扩展（阶段 1：根内 + importee 方向；阶段 3：邻域 importer 扩入后再扩其 import 边）
  let head = 0;
  const drain = async (): Promise<void> => {
    while (head < queue.length) {
      const f = queue[head++];
      if (included.get(f)) continue; // 已解析过
      included.set(f, true);
      const ext = path.extname(f);
      if (!['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].includes(ext)) continue; // 非 TS 系不解析 import
      let mod: Awaited<ReturnType<typeof analyzeModuleSource>>;
      try {
        mod = await analyzeModuleSource(fs.readFileSync(f, 'utf-8'), f);
      } catch {
        mod = null;
      }
      if (!mod) continue;
      for (const e of mod.imports) {
        if (!e.source) continue;
        let real: string | null = null;
        if (e.source.startsWith('.')) {
          real = realResolveImport(f, e.source);
        } else if (aliasCfg) {
          real = resolveAliasedImport(e.source, aliasCfg);
        }
        if (!real || !isLocalSource(real)) continue;
        if (!included.has(real)) {
          included.set(real, false);
          queue.push(real);
        }
      }
    }
  };
  await drain();

  // 阶段 2：邻域 importer 有界扫描（根外引用 seed 的文件）→ 扩入，再 BFS 其 import 边
  for (const ext of await findExternalImporters(seedAbs, root)) {
    if (!included.has(ext)) {
      included.set(ext, false);
      queue.push(ext);
    }
  }
  await drain();

  return [...included.keys()];
}
