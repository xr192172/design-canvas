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
import { parseFileFull, isSupported, type ParsedImport } from './ts_kernel/index.js';
import { readGoModules, type GoModule } from './import_project.js';
import { getProjectCacheDb, closeProjectCacheDb, type Database } from '../db/db.js';
import {
  toRelPath,
  hasAnyIndexedFiles,
  isFileIndexed,
  getResolvedImportSources,
  getRawImportsOfFile,
  findFilesImportingAnySource,
} from '../db/symbols.js';

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
// 跨语言 import 边（Go / Python）：让闭包沿非 TS 文件的 import 边扩展
// ─────────────────────────────────────────────

/**
 * 多语言 resolution 上下文（各语言 resolver 内部可能需要）
 */
export interface LangResolveCtx {
  /** 工程根（定位 Go 包目录 / Python 同包用） */
  root: string;
  /** Go module 列表（只 Go 用；已按 module 长度降序） */
  goModules: GoModule[];
  /** seed 所在项目名（裸包 workspace 互引用；可为 undefined） */
  seedPkgName?: string;
}

/**
 * 跨语言 import → 本地文件。
 *
 * 扩展点：本函数按文件扩展名分派到 `LANG_RESOLVERS[lang]`；未注册的语言走
 * `resolveGenericLangImport` 通用兜底（把 import 字符串按分隔符转路径，从 importer
 * 目录/工程根逐级落盘）。AST import 提取由 ts_kernel.parseFileFull 通用完成——
 * LANGUAGES 注册表已覆盖 150+ 语言，故【加一个新语言 = 给 LANG_RESOLVERS 加一条
 * 扩展名→resolver 映射】，AST 层零改动。
 */
export function resolveLangImport(absFile: string, imp: ParsedImport, ctx: LangResolveCtx): string | null {
  const ext = path.extname(absFile);
  const resolver = LANG_RESOLVERS[ext];
  if (resolver) return resolver(absFile, imp, ctx);
  return resolveGenericLangImport(absFile, imp);
}

/** 相对（./ ../ 或 Python 前导点）→ realResolveImport——所有语言统一 */
function resolveRelative(absFile: string, imp: ParsedImport): string | null {
  if (imp.kind === 'relative') return realResolveImport(absFile, imp.source);
  return null;
}

/** Go：Go 包路径按 go.mod module 前缀剥离 → 落到 go.mod 所在目录 */
function resolveGoImport(absFile: string, imp: ParsedImport, ctx: LangResolveCtx): string | null {
  const rel = resolveRelative(absFile, imp);
  if (rel) return rel;
  for (const gm of ctx.goModules) {
    if (imp.source === gm.module || imp.source.startsWith(gm.module + '/')) {
      const rest = imp.source.slice(gm.module.length).replace(/^\//, '');
      return resolveToFile(path.resolve(ctx.root, gm.dir || '.', rest)) ?? null;
    }
  }
  return null;
}

/** Python：点分模块/单段包 → importer 目录 → 工程根逐级试 */
function resolvePythonImport(absFile: string, imp: ParsedImport, ctx: LangResolveCtx): string | null {
  const rel = resolveRelative(absFile, imp);
  if (rel) return rel;
  const asPath = imp.source.split('.').join('/');
  for (const base of [path.dirname(absFile), ctx.root]) {
    const hit = resolveToFile(path.resolve(base, asPath));
    if (hit) return hit;
  }
  return null;
}

/** 通用兜底：把 import 字符串按 `::`/`.`/`/` 分隔符归一化为路径，从 importer 目录/工程根逐级落盘 */
function resolveGenericLangImport(absFile: string, imp: ParsedImport): string | null {
  const rel = resolveRelative(absFile, imp);
  if (rel) return rel;
  const asPath = imp.source.replace(/::/g, '/').replace(/\./g, '/');
  for (const base of [path.dirname(absFile), path.resolve(absFile, '../..')]) {
    const hit = resolveToFile(path.resolve(base, asPath));
    if (hit) return hit;
  }
  // 末段可能是符号名（如 Java 'com.x.Bar' 的 Bar 是类名，文件在 com/x/）→ 退目录一级
  const dirAsPath = asPath.replace(/\/[^/]+$/, '');
  for (const base of [path.dirname(absFile), path.resolve(absFile, '../..')]) {
    const hit = resolveToFile(path.resolve(base, dirAsPath));
    if (hit) return hit;
  }
  return null;
}

/** 各语言 resolver 注册表：加语言 = 加一条 [ext] → resolver */
const LANG_RESOLVERS: Record<string, (absFile: string, imp: ParsedImport, ctx: LangResolveCtx) => string | null> = {
  '.go': resolveGoImport,
  '.py': resolvePythonImport,
  '.java': resolveJavaImport,
  '.rs': resolveRustImport,
  '.cs': resolveCsImport,
  '.php': resolvePhpImport,
  // 其它语言不注册 → 走 resolveGenericLangImport 通用兜底
};

/** Rust：use 路径 → src 下 .rs / mod.rs（crate:: 相对 project root src） */
function resolveRustImport(absFile: string, imp: ParsedImport, ctx: LangResolveCtx): string | null {
  const rel = resolveRelative(absFile, imp);
  if (rel) return rel;
  if (!imp.source) return null;
  const src = imp.source.split('::')[0];
  // 外部标准库/第三方 crate（非本地模块）→ 不解析到本地
  if (['std', 'core', 'alloc', 'allocator'].includes(src)) return null;
  const p = imp.source.replace(/::/g, '/');
  for (const base of [path.join(ctx.root, 'src'), path.dirname(absFile), ctx.root]) {
    const hit = resolveToFile(path.join(base, p)) || resolveToFile(path.join(base, p, 'mod.rs')) || resolveToFile(path.join(base, p + '.rs'));
    if (hit) return hit;
  }
  return null;
}

/** Java：全限定包路径 → 常见 src 根下 .java（标准 Maven/Gradle 布局 + root 兜底） */
function resolveJavaImport(absFile: string, imp: ParsedImport, ctx: LangResolveCtx): string | null {
  const rel = resolveRelative(absFile, imp);
  if (rel) return rel;
  if (!imp.source) return null;
  const relPath = imp.source.replace(/\./g, '/'); // com.foo.Bar → com/foo/Bar
  for (const base of [
    path.join(ctx.root, 'src/main/java'),
    path.join(ctx.root, 'src/main'),
    path.join(ctx.root, 'src'),
    path.join(ctx.root, 'java'),
    ctx.root,
  ]) {
    // 末段可能是类名（import com.foo.Bar → 文件 com/foo/Bar.java）；也可能含类名需退一级不适用（包导入）
    const hit = resolveToFile(path.join(base, relPath + '.java')) || resolveToFile(path.resolve(base, relPath));
    if (hit) return hit;
  }
  return null;
}

/** C#：点分命名空间 → 常见 src 根下 .cs（标准 .NET 布局 + root 兜底） */
function resolveCsImport(absFile: string, imp: ParsedImport, ctx: LangResolveCtx): string | null {
  const rel = resolveRelative(absFile, imp);
  if (rel) return rel;
  if (!imp.source) return null;
  // 跳过 BCL/框架命名空间（System.*）：纯框架类型不落到本地项目文件
  if (/^System(\.|$)/.test(imp.source)) return null;
  const relPath = imp.source.replace(/\./g, '/'); // MyApp.Utils.Helper → MyApp/Utils/Helper
  for (const base of [
    path.join(ctx.root, 'src'),
    path.join(ctx.root, 'csharp'),
    ctx.root,
  ]) {
    const hit = resolveToFile(path.join(base, relPath + '.cs')) || resolveToFile(path.resolve(base, relPath));
    if (hit) return hit;
  }
  return null;
}

/** PHP：反斜杠命名空间 → src 根下 .php（PSR-4 composer src + root 兜底） */
function resolvePhpImport(absFile: string, imp: ParsedImport, ctx: LangResolveCtx): string | null {
  const rel = resolveRelative(absFile, imp);
  if (rel) return rel;
  if (!imp.source) return null;
  const relPath = imp.source.replace(/\\/g, '/').replace(/^\/+/, ''); // Foo\Bar → Foo/Bar
  for (const base of [
    path.join(ctx.root, 'src'),
    path.join(ctx.root, 'app'),
    ctx.root,
  ]) {
    const hit = resolveToFile(path.join(base, relPath + '.php')) || resolveToFile(path.resolve(base, relPath));
    if (hit) return hit;
  }
  return null;
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

/**
 * 文件是否通过 import 真实引用 targetAbs（TS 系才解析）。
 *  - 相对导入（./ ../）→ realResolveImport
 *  - 别名导入（@/ 等）→ resolveAliasedImport（用本文件所属项目的 tsconfig，aliasCfg 传近）
 *  - 裸包导入（非相对、非别名）→ 若匹配 seed 所在项目包名（workspace 互引）则命中
 */
async function importsTargetFile(fileAbs: string, targetAbs: string, aliasCfg?: AliasConfig | null, seedPkgName?: string): Promise<boolean> {
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
    if (!e.source) continue;
    let real: string | null = null;
    if (e.source.startsWith('.')) {
      real = realResolveImport(fileAbs, e.source);
    } else if (aliasCfg) {
      real = resolveAliasedImport(e.source, aliasCfg);
    } else if (seedPkgName && e.source === seedPkgName) {
      // 裸包 workspace 互引：import 了 seed 所在包（如 monorepo 内 B 引 A 包名）→ 命中
      return true;
    }
    if (real && path.resolve(real) === targetAbs) return true;
  }
  return false;
}

/** 读项目根 package.json 的 name（裸包 workspace 互引匹配用）；无则 undefined */
export function readPackageName(root: string): string | undefined {
  try {
    const p = path.join(root, 'package.json');
    if (!fs.existsSync(p)) return undefined;
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return typeof j.name === 'string' && j.name ? j.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * importer 邻域有界扫描：找到「根外、但引用了 seedFile」的本地文件。
 *
 * 只扫 **seed 根的直属兄弟目录**（root 的父目录里的项目样邻居 + 该层松散源文件），
 * 不向更上层上爬 —— 避免从 Temp/build 等深层路径一路扫进整个文件树里的项目。
 * 邻域语义 = "同 monorepo 根 / 同工作区下的平铺兄弟仓库"，本就是 root 直属层。
 *
 * 每进入一个项目样兄弟目录，按其自身 tsconfig 解析该目录内文件的别名导入
 * （@shared/ 等映射到 seed 项目的别名也能命中）；松散文件用 seed 根的别名兜底。
 * 裸包导入（npm 包 #/ workspace）不在本版，见 docs 边界。
 *
 * 防御：先数项目样兄弟数量，若远超工作区规模（> NEIGHBOR_LIMIT）→ 判定为 temp/缓存
 * 容器（历史测试残留），直接短路返回 —— 防止对上千个噪声目录逐个全量扫描。
 *
 *  - 只处理根的直接父目录一层：进入其中"项目样"兄弟（.git/manifest）+ 该层松散源文件
 *  - 排除 root 自身子树 / 噪音目录 / 用户主目录 / 驱动器根
 *  - 匹配：相对 import 或别名 import 真实解析到 seedFile
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
  // 松散文件（非项目样兄弟）用 seed 根的别名兜底
  const rootAlias = loadAliasConfig(rootAbs);
  // 裸包 workspace 互引：seed 所在项目包名（B `import {..} from 'a'`，a=A 包名 → 命中）
  const rootPkgName = readPackageName(rootAbs);
  for (const e of entries) {
    if (!e) continue;
    if (isSkippedDir(e.name)) continue;
    const p = path.join(siblingDir, e.name);
    if (p === rootAbs || rootAbs.startsWith(p + path.sep)) continue; // 排除 root 自身子树与其祖先
    if (e.isDirectory()) {
      if (!isProjectDir(p) || path.resolve(p) === home) continue;
      // 每个兄弟项目按其自身 tsconfig 解析（该目录内文件可能用 @xxx/* 别名引用 seed）
      const projAlias = loadAliasConfig(p);
      const projFiles: string[] = [];
      walkProjectFiles(p, projFiles);
      for (const f of projFiles) {
        const abs = path.resolve(f);
        if (abs === seedAbs || !isLocalSource(abs)) continue;
        if (await importsTargetFile(abs, seedAbs, projAlias, rootPkgName)) out.push(abs);
      }
    } else if (e.isFile() && SRC_EXTS.has(path.extname(e.name))) {
      const abs = path.resolve(p);
      if (abs === seedAbs || !isLocalSource(abs)) continue;
      if (await importsTargetFile(abs, seedAbs, rootAlias, rootPkgName)) out.push(abs);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// expandClosure 索引快速路径（② cache.db 反查子图 + ④ 无索引回退全扫）
// ─────────────────────────────────────────────────────────────

/** TS/JS 本地源扩展名（快路径 BFS 的 import dispatch 用） */
const CLOSURE_TS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);

/**
 * 取同目录的兄弟索引文件 relPath（包共享可见性：Go/Python/Java 同目录文件无需
 * import 即可互相引用；TS/JS 也常用同目录相对 import，保守兜底 alias 反向查询）。
 * 返回值包含 seedRel 自身。
 */
function sameDirIndexedFiles(db: Database, seedRel: string): string[] {
  const dir = path.posix.dirname(seedRel);
  const likePrefix = dir === '.' ? '' : dir + '/';
  // 同目录：path = seedRel（自身），或 path LIKE <dir>/% 且下一段不含 '/'
  //（即一层子节点 = 同目录的其他文件）。用 posix dirname 过滤实现精确匹配。
  const rows = db
    .prepare(likePrefix ? "SELECT path FROM files WHERE path LIKE ?" : "SELECT path FROM files WHERE path NOT LIKE '%/%'")
    .all(...(likePrefix ? [likePrefix + '%'] : [])) as Array<{ path: string }>;
  const out: string[] = [];
  for (const r of rows) {
    if (path.posix.dirname(r.path) === dir) out.push(r.path);
  }
  return out;
}

/**
 * 计算「哪些 import.source 字符串会让引用者解析到本文件」。
 * 用于跨语言（Go/Python/Java）的包导入反向查询：把本文件翻译成它对外的
 * 包导入串，再用 imports 表 IN 查询反抓所有引用它的文件。
 *
 * TS 别名反向太复杂（alias paths 是多对多映射，精确反解成本高），
 * TS 反向主要靠 edges(kind='import') 入边 + 同目录兄弟兜底——本条
 * 仅覆盖 package 导入型语言。
 */
function candidatePkgImportSources(
  fAbs: string,
  relPath: string,
  ext: string,
  root: string,
  goModules: GoModule[],
): string[] {
  const dirRel = path.posix.dirname(relPath);
  switch (ext) {
    case '.go': {
      // Go：每个 go.mod {module=github.com/x/y, dir=root} → 包导入 = module + '/' + dirRel
      const out: string[] = [];
      for (const gm of goModules) {
        const base = gm.module;
        if (dirRel === '.') out.push(base);
        else out.push(base + '/' + dirRel);
        // gm.dir 非空时补带 gm.dir 前缀版本
        if (gm.dir && gm.dir !== '.') {
          if (dirRel === '.') out.push(base); // module 本身就是顶层包
          else out.push(base + '/' + dirRel);
        }
      }
      return [...new Set(out)];
    }
    case '.py': {
      // Python：点分模块路径（pkg.sub.mod）+ 同目录相对变体（.mod + 上一级..pkg.mod）
      const dottedBase = relPath.slice(0, -ext.length).split('/').join('.');
      const dottedDir = dirRel === '.' ? '' : dirRel.split('/').join('.');
      const fileStem = path.posix.basename(relPath, ext);
      const cand = new Set<string>();
      cand.add(dottedBase);                         // pkg.sub.mod
      if (fileStem !== '__init__') {
        if (dottedDir) cand.add(dottedDir);          // pkg.sub（包级 import → 目录下 __init__ 导入本模块内容）
        cand.add('.' + fileStem);                    // .mod（同目录相对）
        if (dottedDir) cand.add('..' + dottedDir.split('.').slice(-1)[0] + '.' + fileStem); // 近似上一级相对
      } else {
        cand.add(dottedDir || '.');                  // __init__ 的引用 = import 包自身
      }
      return [...cand];
    }
    case '.java': {
      // Java：全限定包路径（com.foo.Bar 类 → 文件 com/foo/Bar.java 对应 import com.foo.* / com.foo.Bar）
      const dotted = dirRel === '.' ? '' : dirRel.split('/').join('.');
      const fileStem = path.posix.basename(relPath, ext);
      if (!dotted) return [fileStem];
      return [dotted + '.' + fileStem, dotted + '.*'];
    }
    default:
      return [];
  }
}

/**
 * 对一个文件做 import 现场解析（仅当该文件不在 cache.db 索引中时触发；
 * 典型如 findExternalImporters 扫到的跨根兄弟项目文件，或 watch 新文件尚未索引）。
 * 与原 drain 的单文件解析一致，但抽成纯函数复用。
 */
async function expandOneFileOnTheFly(
  f: string,
  aliasCfg: AliasConfig | null,
  ctx: LangResolveCtx,
): Promise<string[]> {
  const ext = path.extname(f);
  const out: string[] = [];
  if (CLOSURE_TS_EXTS.has(ext)) {
    let mod: Awaited<ReturnType<typeof analyzeModuleSource>> | null = null;
    try {
      mod = await analyzeModuleSource(fs.readFileSync(f, 'utf-8'), f);
    } catch { /* ignore */ }
    if (!mod) return out;
    for (const e of mod.imports) {
      if (!e.source) continue;
      let real: string | null = null;
      if (e.source.startsWith('.')) real = realResolveImport(f, e.source);
      else if (aliasCfg) real = resolveAliasedImport(e.source, aliasCfg);
      if (real) out.push(real);
    }
  } else if (isSupported(ext)) {
    let content: string;
    try { content = fs.readFileSync(f, 'utf-8'); } catch { return out; }
    let parsed: Awaited<ReturnType<typeof parseFileFull>> | null = null;
    try { parsed = await parseFileFull(f, content); } catch { /* ignore */ }
    if (!parsed) return out;
    for (const e of parsed.imports) {
      const real = resolveLangImport(f, e, ctx);
      if (real) out.push(real);
    }
  }
  return out;
}

/**
 * 索引快速路径：从 seed 沿 cache.db 的 import 边双向 BFS，只取依赖子图。
 * 成功返回闭包文件列表；任何前置不满足（项目无 cache.db / seed 未索引 /
 * 打开 DB 异常）返回 null → expandClosure 回退原现场全扫逻辑。
 *
 * 快路径覆盖（与原全扫等价的来源）：
 *  1) 种子文件（必含）
 *  2) 同目录兄弟文件（包共享可见性；TS alias 反向保守兜底）
 *  3) 正向：索引里每个文件的 import 原始记录 → resolve 到本地文件（TS 相对+别名，
 *     Go/Python 包路径）——与原 drain 用完全相同的 resolve 分派，结果一致。
 *  4) 反向 TS/JS 相对导入：edges(kind='import') 按 target 反查 source。
 *  5) 反向 Go/Python/Java 包导入：candidatePkgImportSources → imports 表反查。
 *  6) findExternalImporters（跨 git 根兄弟项目引用）—— 不在单一项目 cache.db
 *     覆盖范围，仍沿用原函数做一次有界邻域扫描（兄弟数通常 ≤ NEIGHBOR_LIMIT）。
 */
async function tryIndexedExpandClosure(
  seedAbs: string,
  root: string,
  aliasCfg: AliasConfig | null,
): Promise<string[] | null> {
  // 存在性预检：避免 getProjectCacheDb() 在无索引的项目里把空 cache.db 创建出来（否则 Windows 上会持有 EBUSY 锁，
  // 导致 temp 目录测试的 rmSync 抛错，且无意义消耗一次池连接）。
  const dbFile = path.join(root, '.design-canvas', 'cache.db');
  if (!fs.existsSync(dbFile)) return null;

  let db: Database | null = null;
  try {
    db = getProjectCacheDb(root);
  } catch {
    return null; // DB 打不开（权限 / 不可写 / 未 import_project）→ 回退
  }
  if (!hasAnyIndexedFiles(db)) {
    closeProjectCacheDb(root); // 空索引，释放句柄；下次 import_project 后再池化
    return null;
  }

  const seedRel = toRelPath(root, seedAbs);
  if (!isFileIndexed(db, seedRel)) {
    closeProjectCacheDb(root); // seed 未入索引（增量更新间隙 / 只建了部分）→ 不锚定，回退并释放
    return null;
  }

  const goModules = readGoModules(root);
  const langCtx: LangResolveCtx = { root, goModules };
  const included = new Map<string, boolean>(); // abs → 是否已扩边（true=已处理）
  const queue: string[] = [];
  const addAbs = (a: string) => {
    if (!isLocalSource(a)) return;
    if (!included.has(a)) {
      included.set(a, false);
      queue.push(a);
    }
  };

  // 1) seed 必含
  addAbs(seedAbs);

  // 2) 同目录兄弟（包共享可见性 + TS alias 反向保守兜底）
  for (const sibRel of sameDirIndexedFiles(db, seedRel)) {
    addAbs(path.resolve(root, sibRel));
  }

  // 3)+4)+5) 双向 BFS 扩边
  let head = 0;
  while (head < queue.length) {
    const f = queue[head++];
    if (included.get(f)) continue; // 已扩过
    included.set(f, true);
    const fRel = toRelPath(root, f);
    const ext = path.extname(f);
    const indexed = isFileIndexed(db, fRel);

    // ── 正向：f 引用了谁 → 扩入
    if (indexed) {
      // 缓存路径：读 imports 表 + 按语言分派 resolve（零文件读、零 AST）
      const cached = getRawImportsOfFile(db, fRel);
      for (const imp of cached) {
        if (imp.type_only) continue; // TS import type：运行时擦除、不算边
        let real: string | null = null;
        if (CLOSURE_TS_EXTS.has(ext)) {
          if (imp.source.startsWith('.')) {
            real = realResolveImport(f, imp.source);
          } else if (aliasCfg) {
            real = resolveAliasedImport(imp.source, aliasCfg);
          }
        } else {
          // 跨语言（Go/Python/Java/...）
          const pi: ParsedImport = {
            source: imp.source,
            kind: imp.kind,
            type_only: imp.type_only,
            line: imp.line,
          };
          real = resolveLangImport(f, pi, langCtx);
        }
        if (real) addAbs(real);
      }
    } else {
      // 未索引文件（典型：跨根 findExternalImporters 扩入的兄弟项目文件）
      // → 现场读+解析一次（这类文件极少，不等于全扫）
      for (const real of await expandOneFileOnTheFly(f, aliasCfg, langCtx)) {
        addAbs(real);
      }
    }

    // ── 反向：谁引用了 f → 扩入
    if (indexed) {
      // 4) TS/JS 相对导入入边（edges 表，已解析）
      for (const srcRel of getResolvedImportSources(db, fRel)) {
        addAbs(path.resolve(root, srcRel));
      }
      // 5) Go/Python/Java 包导入反向：按候选包串查 imports 表
      const cands = candidatePkgImportSources(f, fRel, ext, root, goModules);
      if (cands.length > 0) {
        for (const impRel of findFilesImportingAnySource(db!, cands)) {
          addAbs(path.resolve(root, impRel));
        }
      }
    }
    // 未索引文件的反向：没法用索引反查，但这些是跨根兄弟项目文件，
    // findExternalImporters 本身就从兄弟项目方向找到了"它们引用了 seed"，
    // 再找"它们的反向引用"属于极端边角，本轮不扩（宁可少不可错）。
  }

  // 6) 邻域 importer 有界扫描（跨 git 根引用 seed → 扩入，并 BFS 其 import 边）
  //    本步复用原 findExternalImporters——它是 O(兄弟项目数 × walk + import 解析)，
  //    但 NEIGHBOR_LIMIT=20 有界，且 seed 的邻域项目集合本身就很小（通常 0-2 个），
  //    不会回到 O(root)。
  const externalImporters = await findExternalImporters(seedAbs, root);
  for (const extAbs of externalImporters) addAbs(extAbs);
  // 对新加的邻域文件再跑一轮扩边（它们的依赖也要入闭包，与原逻辑一致）
  while (head < queue.length) {
    const f = queue[head++];
    if (included.get(f)) continue;
    included.set(f, true);
    for (const real of await expandOneFileOnTheFly(f, aliasCfg, langCtx)) {
      addAbs(real);
    }
  }

  return [...included.keys()];
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
 *
 * 2026-09 新增：cache.db 索引快速路径（交接文档 ②+④）。
 *  - 有可用 cache.db（import_project / watcher 已建索引）→ 走反查子图 BFS：
 *    从 seed 沿 import 边只扩实际相连文件，从 O(root) 降到 O(relevant)；
 *    仍做邻域 findExternalImporters 有界扫描（跨 git 根引用不进单项目 cache）。
 *  - 无索引/索引不可用/seed 未索引 → 完全保留原"现场全扫"逻辑（零前置免摩擦）。
 */
export async function expandClosure(seedFile: string, root: string, alias?: AliasConfig | null): Promise<string[]> {
  const aliasCfg = alias === undefined ? loadAliasConfig(root) : alias;
  const seedAbs = path.resolve(seedFile);

  // ② 索引反查快路径：有 cache.db 且 seed 已索引 → 子图 BFS
  const fast = await tryIndexedExpandClosure(seedAbs, root, aliasCfg);
  if (fast) return fast;

  // ④ 兜底：无索引时保留原现场全扫（零前置、免摩擦）
  const included = new Map<string, boolean>(); // absPath → 是否已解析其 imports
  const queue: string[] = [];

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
  const goModules = readGoModules(root); // 多语言 Go 包解析（一次）
  const drain = async (): Promise<void> => {
    while (head < queue.length) {
      const f = queue[head++];
      if (included.get(f)) continue; // 已解析过
      included.set(f, true);
      const ext = path.extname(f);
      let edges: Array<string | null> = [];
      if (CLOSURE_TS_EXTS.has(ext)) {
        // TS 系：analyzeModuleSource → import 边（相对/别名）
        let mod: Awaited<ReturnType<typeof analyzeModuleSource>>;
        try {
          mod = await analyzeModuleSource(fs.readFileSync(f, 'utf-8'), f);
        } catch {
          mod = null as any;
        }
        if (!mod) continue;
        for (const e of mod.imports) {
          if (!e.source) continue;
          if (e.source.startsWith('.')) edges.push(realResolveImport(f, e.source));
          else if (aliasCfg) edges.push(resolveAliasedImport(e.source, aliasCfg));
        }
      } else if (isSupported(ext)) {
        // 跨语言（Go/Python）：parseFileFull → import 边 → resolveLangImport
        let content: string;
        try {
          content = fs.readFileSync(f, 'utf-8');
        } catch {
          continue;
        }
        let parsed: Awaited<ReturnType<typeof parseFileFull>> | null = null;
        try {
          parsed = await parseFileFull(f, content);
        } catch {
          parsed = null;
        }
        if (!parsed) continue;
        for (const e of parsed.imports) edges.push(resolveLangImport(f, e, { root, goModules }));
      } else {
        continue; // 不支持的扩展名（.vue/.java 等本版不解析 import）
      }
      for (const real of edges) {
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
