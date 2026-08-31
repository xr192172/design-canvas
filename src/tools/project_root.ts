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
import { analyzeModuleSource } from './rename_symbol.js';

/** 本地源扩展名（闭包只收这些；与 rename_symbol/rename_file 的 TS_EXTS 对齐） */
const SRC_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.go', '.py', '.vue', '.java']);

/** 跳过的目录名（闭包扫描绝不进入） */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.svn', '.hg', 'vendor', 'target', 'out', 'output', '.next', '.nuxt', '__pycache__', '.venv', 'venv']);

/** 项目根标志文件（manifest，git 之外的项目边界判据） */
const MANIFESTS = ['package.json', 'go.mod', 'pyproject.toml', 'Cargo.toml', 'pom.xml', 'composer.json', 'pubspec.yaml', 'build.gradle'];

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

/**
 * 真实解析相对 import 到磁盘文件（不依赖任何预建索引表）。
 * 处理：扩展名补全（./x → x.ts/tsx/js/...）、目录索引（./dir → dir/index.ts）。
 * 只解析相对导入（./ ../）；裸包名 / 绝对路径 / 外部 → 返回 null（不属本地闭包）。
 */
export function realResolveImport(importerAbs: string, source: string): string | null {
  if (!source.startsWith('.')) return null;
  const importerDir = path.dirname(importerAbs);
  const base = path.resolve(importerDir, source);
  const tryCandidates = (p: string): string | null => {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    // 补扩展名
    if (!path.extname(p)) {
      for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.go', '.py', '.vue']) {
        const cand = p + ext;
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
      }
    }
    // 目录索引（./dir → ./dir/index.ts 等）
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      for (const name of ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'mod.ts', 'mod.go', '__init__.py']) {
        const cand = path.join(p, name);
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
      }
    }
    return null;
  };
  return tryCandidates(base);
}

/** 判断绝对路径是否属于本地源码（非 node_modules/隐目录/三方），供闭包纳入判定 */
export function isLocalSource(abs: string): boolean {
  const parts = abs.split(/[\\/]/);
  return !parts.some((s) => isSkippedDir(s));
}

/**
 * 动态闭包边界：给定种子文件 + 初始项目根，返回自包含的本地源文件集合。
 *  - 初始 = 项目根内全部本地源（importer 方向全覆盖：谁引用 seed 不漏）
 *  - BFS 沿 import 边扩展：相对导入解析到边界外本地文件 → 扩入（importee 方向：seed 依赖不漏）
 *  - 跨 git 根引用也被纳入（不依赖单一 project_dir 的物理边界）
 */
export async function expandClosure(seedFile: string, root: string): Promise<string[]> {
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

  // BFS 扩展
  let head = 0;
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
      if (!e.source || !e.source.startsWith('.')) continue;
      const real = realResolveImport(f, e.source);
      if (!real || !isLocalSource(real)) continue;
      if (!included.has(real)) {
        included.set(real, false);
        queue.push(real);
      }
    }
  }

  return [...included.keys()];
}
