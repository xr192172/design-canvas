/**
 * slim_brick —— 积木瘦身编排器（Brick Harvest Phase 6，第 17 主工具）
 *
 * 用户思路原话："如果 Go 的编译它自动会不引入那些无关的，我们能不能效仿它的
 * 编译器——它只编译那些，我们也只读取那些，重新连成新文件。"
 *
 * 链条分工：
 *   dead_deps（眼睛）——索引可达性 BFS 产出 live 集，入盒时存进
 *     manifest.slim_candidates.live_symbols_by_file / live_type_names
 *   go-slim（手）——go/ast + go/format 按 live 集重写源文件（本仓库 go-slim/）
 *   slim_brick（本工具，编排）——读盒内积木 → 调剪刀 → 非 Go 资产按需搬运 →
 *     依赖清单对账 → 产出 -slim 衍生积木回盒
 *
 * 纪律（Camera 宪法同构）：
 *   - 原积木永不覆盖——衍生积木是独立目录 <brick>-slim/，机器产物可随时重生成
 *     （删除后重跑本工具即可）
 *   - 剪刀只对人拍板后的剔除负责：live 集是入盒时的事实档案，本工具执行不发明
 *   - 四层验证渐进：build 层可当场做（verify_build，临时目录 go build）；
 *     源测试/camera/效果验收由人后续补进 slim_verification
 *
 * 诚实边界：
 *   - 路径对齐防线：live 明细键与盒内 files/ 相对路径零命中 = 档案漂移，
 *     拒绝执行剪刀（keep 集全空等于全剪，宁可不做不能做错）
 *   - 统计以剪刀盘上产物为准（解析失败文件被原样拷贝、报告里没有它——
 *     盘上真相优先于报告；这类文件的 import 单独解析计入，防误报"已剔除"）
 *   - go_mod_requires 版本档案缺失时，依赖前后对比退化为原始 import 路径
 *     口径（不猜模块归属），拼装时进 pending 由人补
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getStorageRoot } from '../storage.js';
import { resolveGoThirdParty } from './go_mod.js';
import { resolveNpmThirdParty } from './npm_mod.js';
import { parseGoImportQualifiers } from './dead_deps.js';
import { aggregateContracts } from './harvest_from_url.js';
import { slimTsFile, type TsSlimResult } from './ts_slim.js';
import { NODE_BUILTINS } from './harvest_closure.js';
import type { BrickContract, BrickManifest } from '../dsl/contract.js';

export interface SlimBrickInput {
  /** 原积木名（盒内 <box_dir>/<brick_name>；须为 Go 积木且带 slim_candidates live 档案） */
  brick_name: string;
  /** 积木盒根目录（默认 <dataHome>/.design-canvas/bricks） */
  box_dir?: string;
  /** 衍生积木名（默认 <brick_name>-slim） */
  name?: string;
  /** true：临时目录 go build ./... 编译验证（需 Go 工具链与网络拉依赖），结果写 slim_verification.build */
  verify_build?: boolean;
  /** false 只预演不落盘（剪刀跑进临时目录，产出仅进报告） */
  write?: boolean;
}

export interface SlimFileReport {
  path: string;
  dropped: boolean;
  kept_decls: string[];
  dropped_decls: string[];
  dropped_imports: string[];
}

export interface SlimBrickResult {
  brick: string;
  slim_name: string;
  slim_dir: string;
  files_before: number;
  files_after: number;
  dropped_files: string[];
  symbols_before: number;
  symbols_after: number;
  deps_before: string[];
  deps_after: string[];
  deps_removed: string[];
  kept_imports_stdlib: string[];
  unresolved_imports: string[];
  files: SlimFileReport[];
  go_slim_errors: string[];
  build_verification?: { status: 'pass' | 'fail' | 'skipped'; at: string; detail?: string };
  written: boolean;
  message: string;
}

// ── go-slim 进程协议 ─────────────────────────────────────

interface GoSlimFileSpec {
  path: string;
  keep: string[];
}
interface GoSlimInput {
  root: string;
  out_root: string;
  types: string[];
  files: GoSlimFileSpec[];
}
interface GoSlimFileReport {
  path: string;
  dropped: boolean;
  kept_decls: string[];
  dropped_decls: string[];
  kept_imports: string[];
  dropped_imports: string[];
}
interface GoSlimReport {
  files: GoSlimFileReport[];
  errors?: string[];
}

function runGoSlim(input: GoSlimInput): { report: GoSlimReport | null; error?: string } {
  const json = JSON.stringify(input);
  const opts = {
    input: json,
    encoding: 'utf8' as const,
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  };
  const bin = process.env.GO_SLIM_BIN;
  const dir = process.env.GO_SLIM_DIR ?? fileURLToPath(new URL('../../go-slim', import.meta.url));
  const run = bin ? spawnSync(bin, [], opts) : spawnSync('go', ['run', '.'], { ...opts, cwd: dir });
  if (run.error) {
    return {
      report: null,
      error: `go-slim 启动失败：${run.error.message}（Go 工具链不在 PATH？或设 GO_SLIM_BIN 指向预编译二进制）`,
    };
  }
  if (run.status !== 0) {
    return { report: null, error: `go-slim 退出码 ${run.status}：${(run.stderr || '').slice(0, 2000)}` };
  }
  try {
    return { report: JSON.parse(run.stdout) as GoSlimReport };
  } catch (e) {
    return { report: null, error: `go-slim 输出解析失败：${String(e)}` };
  }
}

// ── 工具 ────────────────────────────────────────────────

/** 递归列出 root 下全部文件的相对路径（posix 形态，排序稳定） */
function walkRelative(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  };
  walk(root);
  out.sort();
  return out;
}

/** 从剪后文件反推源 module 路径：内部 import（后缀落在积木目录集合内的
 *  package 导入——assemble_bricks 同款"最长后缀匹配"判内）剥掉目录后缀得
 *  候选；能覆盖全部内部 import（前缀 + 剥前缀后落积木目录）的候选即真身。
 *  自包含（不读源项目 go.mod），git 抽取的积木同样适用；推不出返回 null
 *  （无内部 import 的单包积木用任意 module 名都能编）。 */
function deriveGoModule(
  filesRoot: string,
  relGoFiles: string[],
  thirdPartyRoots: string[],
): string | null {
  const dirs = new Set(relGoFiles.map((f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '')));
  const internalImports = new Set<string>();
  for (const rel of relGoFiles) {
    let src: string;
    try {
      src = fs.readFileSync(path.join(filesRoot, ...rel.split('/')), 'utf-8');
    } catch {
      continue;
    }
    for (const imp of parseGoImportQualifiers(src).keys()) {
      if (!imp.includes('/') || isStdlibImport(imp)) continue;
      if (thirdPartyRoots.some((m) => imp === m || imp.startsWith(m + '/'))) continue;
      for (const d of dirs) {
        if (d && (imp === d || imp.endsWith('/' + d))) {
          internalImports.add(imp);
          break;
        }
      }
    }
  }
  if (internalImports.size === 0) return null;
  const candidates = new Set<string>();
  for (const imp of internalImports) {
    for (const d of dirs) {
      if (!d) continue;
      if (imp === d) candidates.add(imp);
      else if (imp.endsWith('/' + d)) candidates.add(imp.slice(0, imp.length - d.length - 1));
    }
  }
  for (const m of [...candidates].sort((a, b) => a.length - b.length)) {
    const ok = [...internalImports].every((p) => {
      if (!p.startsWith(m + '/')) return false;
      const rest = p.slice(m.length + 1);
      return rest === '' || dirs.has(rest);
    });
    if (ok) return m;
  }
  return null;
}

/** 编译验证：临时目录拼一个最小 module（go.mod + 瘦身产物）跑 go build ./... */
function verifyBuild(
  filesRoot: string,
  requires: Record<string, string> | undefined,
  modulePath: string | null,
): { status: 'pass' | 'fail'; at: string; detail?: string } {
  const at = new Date().toISOString();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slim-verify-'));
  try {
    for (const rel of walkRelative(filesRoot)) {
      const dest = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(filesRoot, ...rel.split('/')), dest);
    }
    const reqLines = requires
      ? Object.entries(requires)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([m, v]) => `\t${m} ${v}`)
          .join('\n')
      : '';
    // module 名须与文件里内部 import 的前缀一致（剪刀不动 import 路径），
    // 否则 go build 报 "no required module provides …"。反推不出（无内部
    // import 的单包积木）才用占位名 slimverify
    const mod = modulePath ?? 'slimverify';
    fs.writeFileSync(
      path.join(dir, 'go.mod'),
      `module ${mod}\n\ngo 1.25\n${reqLines ? `\nrequire (\n${reqLines}\n)\n` : ''}`,
      'utf-8',
    );
    const run = spawnSync('go', ['build', './...'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GOFLAGS: '-mod=mod' },
    });
    if (run.error) {
      return { status: 'fail', at, detail: `go 启动失败：${run.error.message}` };
    }
    const tail = `${run.stdout || ''}\n${run.stderr || ''}`.trim().slice(-4000);
    return run.status === 0
      ? { status: 'pass', at, detail: tail || undefined }
      : { status: 'fail', at, detail: tail || `exit ${run.status}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** import 路径首段无点 = 标准库（"fmt"/"os" vs "github.com/…"） */
function isStdlibImport(p: string): boolean {
  return !p.split('/')[0].includes('.');
}

// ── 非 Go 资产按需搬运（embed 资产/.s 汇编——剪刀只碰 .go）─────────

/** //go:embed 模式提取：`//go:embed p1 p2`——all: 前缀剥掉、双引号剥壳。
 *  反引号 raw string 模式罕见不认（漏保由编译验证兜底）。 */
export function goEmbedPatterns(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\/\/go:embed\s+(.+)$/gm)) {
    for (const tok of m[1].trim().split(/\s+/)) {
      out.push(tok.replace(/^all:/, '').replace(/^"([^"]*)"$/, '$1'));
    }
  }
  return out;
}

/** embed 模式匹配：pattern 相对 fromDir 解析。逐段 glob（* 不跨 /，与
 *  path.Match 同规）；模式命中 candidate 的某级路径前缀（目录）= 整棵
 *  子树（Go embed 语义：模式匹配到的目录递归全嵌）。 */
export function embedPatternMatches(fromDir: string, pattern: string, rel: string): boolean {
  const prefix = fromDir === '' ? '' : fromDir + '/';
  if (!rel.startsWith(prefix)) return false;
  const candidate = rel.slice(prefix.length);
  if (candidate === '') return false;
  const ps = pattern.split('/');
  const cs = candidate.split('/');
  if (ps.length > cs.length) return false;
  return ps.every((p, i) => globSegMatches(p, cs[i]));
}

function globSegMatches(patternSeg: string, name: string): boolean {
  let re = '';
  for (const ch of patternSeg) {
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(name);
}

/**
 * 内部包 import 判定（assemble_bricks 同款规则）：import 路径的某个目录后缀
 * 落在闭包目录集合内 ⇔ 引的是积木自己的包（如 example.com/demo/pkg/model），
 * 不进三方/标准库统计，也不进 closure.external。
 */
function makeInternalImportMatcher(closureInternal: string[]): (p: string) => boolean {
  const dirs = new Set(
    closureInternal
      .map((f) => {
        const i = f.lastIndexOf('/');
        return i > 0 ? f.slice(0, i) : '';
      })
      .filter((d) => d !== ''),
  );
  return (p: string): boolean => {
    const parts = p.split('/');
    for (let i = 0; i < parts.length; i++) {
      if (dirs.has(parts.slice(i).join('/'))) return true;
    }
    return false;
  };
}

// ── 主流程 ──────────────────────────────────────────────

export async function slimBrick(input: SlimBrickInput): Promise<SlimBrickResult> {
  const boxDir = input.box_dir ?? path.join(getStorageRoot(), 'bricks');
  const brickDir = path.join(boxDir, input.brick_name);
  const manifestPath = path.join(brickDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`积木不存在：${manifestPath}（search_bricks 可查盒内清单）`);
  }
  let manifest: BrickManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as BrickManifest;
  } catch {
    throw new Error(`积木 manifest.json 损坏：${manifestPath}（请检查文件是否为有效 JSON）`);
  }

  const filesRoot = path.join(brickDir, 'files');
  if (!fs.existsSync(filesRoot)) {
    throw new Error(`积木缺文件快照：${filesRoot}`);
  }
  const allFiles = walkRelative(filesRoot);
  const diskGoFiles = allFiles.filter((f) => f.endsWith('.go'));
  const nonGoFiles = allFiles.filter((f) => !f.endsWith('.go'));
  const diskTsFiles = allFiles.filter((f) => TS_SRC_RE.test(f));
  if (diskGoFiles.length > 0 && diskTsFiles.length > 0) {
    throw new Error('混合语言积木（Go + TS 同盒）：剪刀按单语言工作，请分开抽取');
  }
  if (diskGoFiles.length === 0 && diskTsFiles.length === 0) {
    throw new Error('积木内无可剪源码文件（.go/.ts）：剪刀无事可做');
  }
  const slimName = input.name ?? `${input.brick_name}-slim`;
  const slimDir = path.join(boxDir, slimName);
  if (fs.existsSync(slimDir)) {
    throw new Error(`衍生积木已存在：${slimDir}（机器产物可重生成：删除该目录后重跑 slim_brick）`);
  }
  const write = input.write !== false;
  if (diskTsFiles.length > 0) {
    // TS 路径：tree-sitter 剪刀（进程内）——见文末 slimTsBrickCore
    return slimTsBrickCore(input, manifest, brickDir, filesRoot, allFiles, diskTsFiles, slimName, slimDir, write);
  }

  const slimCandidates = manifest.slim_candidates;
  if (!slimCandidates?.live_symbols_by_file) {
    throw new Error(
      '积木缺 live 明细档案（slim_candidates.live_symbols_by_file）：请重抽（harvest_from_url）刷新死依赖分析后再瘦身',
    );
  }
  const liveByFile = slimCandidates.live_symbols_by_file;

  // 路径对齐防线：live 明细键必须能命中盘上 .go 文件——零命中 = 档案漂移。
  // keep 集全空时剪刀只留 init/var/活类型方法，等于把积木剪残，宁可拒绝。
  const liveKeys = Object.keys(liveByFile);
  const hitCount = diskGoFiles.filter((f) => liveByFile[f] !== undefined).length;
  if (liveKeys.length > 0 && hitCount === 0) {
    throw new Error(
      `live 明细（${liveKeys.length} 文件）与盒内 .go 文件（${diskGoFiles.length} 个）零命中——路径形态漂移，拒绝执行剪刀；请重抽刷新档案`,
    );
  }

  const outRoot = write ? path.join(slimDir, 'files') : fs.mkdtempSync(path.join(os.tmpdir(), 'slim-dry-'));
  try {
    // ── ① 剪刀 ──
    const { report, error } = runGoSlim({
      root: filesRoot,
      out_root: outRoot,
      types: slimCandidates.live_type_names ?? [],
      files: diskGoFiles.map((f) => ({ path: f, keep: liveByFile[f] ?? [] })),
    });
    if (!report) throw new Error(error ?? 'go-slim 无输出');

    // ── ② 非 Go 资产按需搬运（剪刀只碰 .go）──
    // 死包的资产不再整体端走，只搬：
    //   a) 存活 .go 文件 //go:embed 引用的资产（模式相对该 .go 文件目录解析，
    //      逐段 glob；模式命中目录 = 整棵子树，与 Go embed 语义一致）
    //   b) 存活目录（含存活 .go 文件的目录）的 .s/.S 汇编（包编译即需要）
    // 运行时 os.ReadFile 读的资产静态看不见——camera/效果验收层把关
    const producedGo = walkRelative(outRoot).filter((p) => p.endsWith('.go'));
    const survivingDirs = new Set(producedGo.map((p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')));
    const embedPatterns: Array<{ dir: string; pattern: string }> = [];
    for (const rel of producedGo) {
      const src = fs.readFileSync(path.join(outRoot, ...rel.split('/')), 'utf-8');
      const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      for (const pattern of goEmbedPatterns(src)) embedPatterns.push({ dir, pattern });
    }
    const keptAssets = new Set<string>();
    for (const rel of nonGoFiles) {
      if (/\.[sS]$/.test(rel)) {
        const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
        if (survivingDirs.has(dir)) keptAssets.add(rel);
        continue;
      }
      if (embedPatterns.some(({ dir, pattern }) => embedPatternMatches(dir, pattern, rel))) {
        keptAssets.add(rel);
      }
    }
    for (const rel of keptAssets) {
      const dest = path.join(outRoot, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(filesRoot, ...rel.split('/')), dest);
    }
    const droppedNonGo = nonGoFiles.filter((f) => !keptAssets.has(f));

    // ── ③ 统计：以剪刀盘上产物为准 ──
    // 解析失败文件被剪刀原样拷贝、报告里没有它——盘上真相优先于报告。
    const produced = walkRelative(outRoot);
    const producedSet = new Set(produced);
    const reportedPaths = new Set(report.files.map((f) => f.path));
    const reportSurviving = report.files.filter((f) => !f.dropped && producedSet.has(f.path));
    const droppedFiles = report.files.filter((f) => f.dropped).map((f) => f.path);
    const parseFailedFiles = produced.filter((p) => p.endsWith('.go') && !reportedPaths.has(p));

    const filesBefore = allFiles.length;
    const filesAfter = produced.length;
    // 防御：旧版剪刀二进制会把空 slice 编成 null（?? [] 兜底）
    const symbolsBefore = report.files.reduce((n, f) => n + (f.kept_decls?.length ?? 0) + (f.dropped_decls?.length ?? 0), 0);
    const symbolsAfter = report.files.reduce((n, f) => n + (f.kept_decls?.length ?? 0), 0);

    // 依赖对账：存活文件 kept imports + 解析失败文件的原始 imports（防误报"已剔除"）
    const keptImports = new Set<string>();
    for (const f of reportSurviving) for (const imp of f.kept_imports ?? []) keptImports.add(imp);
    for (const rel of parseFailedFiles) {
      const src = fs.readFileSync(path.join(outRoot, ...rel.split('/')), 'utf-8');
      for (const imp of parseGoImportQualifiers(src).keys()) keptImports.add(imp);
    }

    const isInternal = makeInternalImportMatcher(manifest.closure.internal ?? []);
    const externalImports = [...keptImports].filter((p) => !isInternal(p)).sort();
    const stdlibImports = externalImports.filter(isStdlibImport);
    const thirdPartyImports = externalImports.filter((p) => !isStdlibImport(p));

    const requires = manifest.go_mod_requires;
    const hasRequires = !!requires && Object.keys(requires).length > 0;
    const beforeSources = (manifest.closure.external ?? [])
      .filter((e) => e.class === 'third_party')
      .map((e) => e.source);
    let depsBefore: string[];
    let depsAfter: string[];
    let unresolvedImports: string[];
    let slimRequires: Record<string, string> | undefined;
    if (hasRequires) {
      const before = resolveGoThirdParty(beforeSources, requires!);
      const after = resolveGoThirdParty(thirdPartyImports, requires!);
      // 对比口径统一：能归并到版本的按模块名，归并不了的（源 go.mod 没 require，
      // 如仅 import 未落档的死库）按原始路径——否则死依赖会从 before 里漏掉
      depsBefore = [...Object.keys(before.resolved), ...before.unresolved].sort();
      depsAfter = [...Object.keys(after.resolved), ...after.unresolved].sort();
      unresolvedImports = after.unresolved.sort();
      if (Object.keys(after.resolved).length) slimRequires = after.resolved;
    } else {
      // 版本档案缺失：退化为原始 import 路径口径（不猜模块归属），对比仅供参考
      depsBefore = [...new Set(beforeSources)].sort();
      depsAfter = thirdPartyImports;
      unresolvedImports = [];
    }
    const depsRemoved = depsBefore.filter((d) => !depsAfter.includes(d));

    // ── ④ 无可剪内容：不生成空壳衍生积木 ──
    const nothingToSlim =
      symbolsAfter === symbolsBefore &&
      droppedFiles.length === 0 &&
      parseFailedFiles.length === 0 &&
      depsRemoved.length === 0 &&
      report.files.every((f) => (f.dropped_imports ?? []).length === 0);
    if (nothingToSlim) {
      if (write) fs.rmSync(slimDir, { recursive: true, force: true });
      return {
        brick: input.brick_name,
        slim_name: slimName,
        slim_dir: '',
        files_before: filesBefore,
        files_after: filesAfter,
        dropped_files: [],
        symbols_before: symbolsBefore,
        symbols_after: symbolsAfter,
        deps_before: depsBefore,
        deps_after: depsAfter,
        deps_removed: [],
        kept_imports_stdlib: stdlibImports,
        unresolved_imports: unresolvedImports,
        files: report.files.map(({ path: p, dropped, kept_decls, dropped_decls, dropped_imports }) => ({
          path: p,
          dropped,
          kept_decls: kept_decls ?? [],
          dropped_decls: dropped_decls ?? [],
          dropped_imports: dropped_imports ?? [],
        })),
        go_slim_errors: report.errors ?? [],
        written: false,
        message: `无可剪内容（${symbolsBefore} 声明全部存活、无文件/依赖可剔），未生成衍生积木`,
      };
    }

    // ── ⑤ 编译验证（可选）──
    let buildVerification: SlimBrickResult['build_verification'];
    if (input.verify_build) {
      const modulePath = deriveGoModule(outRoot, produced.filter((p) => p.endsWith('.go')), [
        ...Object.keys(slimRequires ?? {}),
        ...unresolvedImports,
      ]);
      buildVerification = verifyBuild(outRoot, slimRequires, modulePath);
    }

    // ── ⑥ 落盘：contracts.json + manifest.json ──
    if (write) {
      let contractsByPath: Record<string, BrickContract> = {};
      try {
        contractsByPath = JSON.parse(
          fs.readFileSync(path.join(brickDir, 'contracts.json'), 'utf-8'),
        ) as Record<string, BrickContract>;
      } catch {
        // contracts.json 缺失/损坏：聚合退化为空（衍生积木仍可拼装，货架卡片薄）
      }
      const slimContracts: Record<string, BrickContract> = {};
      for (const [p, c] of Object.entries(contractsByPath)) {
        if (producedSet.has(p)) slimContracts[p] = c;
      }
      fs.writeFileSync(path.join(slimDir, 'contracts.json'), JSON.stringify(slimContracts, null, 2), 'utf-8');

      const slimManifest: BrickManifest = {
        name: slimName,
        schema_version: 1,
        description: `${manifest.description ? `${manifest.description}；` : ''}瘦身衍生积木（go-slim 按 live 集剪枝：${filesBefore}→${filesAfter} 文件 / ${symbolsBefore}→${symbolsAfter} 声明 / 剔除三方依赖 ${depsRemoved.length} 个）`,
        seed_files: manifest.seed_files,
        closure: {
          internal: [...producedSet].sort(),
          external: [
            ...stdlibImports.map((s) => ({ source: s, class: 'stdlib' as const })),
            ...depsAfter.map((m) => ({ source: m, class: 'third_party' as const })),
            ...unresolvedImports.map((u) => ({ source: u, class: 'unresolved' as const })),
          ],
        },
        aggregate: aggregateContracts(Object.values(slimContracts)),
        acceptance: manifest.acceptance, // 人工沉淀继承（验收判据与瘦身正交）
        go_mod_requires: slimRequires,
        derived_from: {
          brick: input.brick_name,
          slimmed_at: new Date().toISOString(),
          files_before: filesBefore,
          files_after: filesAfter,
          symbols_before: symbolsBefore,
          symbols_after: symbolsAfter,
          deps_before: depsBefore,
          deps_after: depsAfter,
        },
        slim_verification: buildVerification ? { build: buildVerification } : undefined,
        provenance: manifest.provenance
          ? {
              source_project: manifest.provenance.source_project,
              commit: manifest.provenance.commit,
              harvested_at: manifest.provenance.harvested_at,
            }
          : undefined,
      };
      fs.writeFileSync(path.join(slimDir, 'manifest.json'), JSON.stringify(slimManifest, null, 2), 'utf-8');
    }

    const verifyNote = buildVerification
      ? `；编译验证 ${buildVerification.status === 'pass' ? '通过' : '失败（详见 slim_verification.build）'}`
      : '';
    return {
      brick: input.brick_name,
      slim_name: slimName,
      slim_dir: write ? slimDir : '',
      files_before: filesBefore,
      files_after: filesAfter,
      dropped_files: droppedFiles,
      symbols_before: symbolsBefore,
      symbols_after: symbolsAfter,
      deps_before: depsBefore,
      deps_after: depsAfter,
      deps_removed: depsRemoved,
      kept_imports_stdlib: stdlibImports,
      unresolved_imports: unresolvedImports,
      files: report.files.map(({ path: p, dropped, kept_decls, dropped_decls, dropped_imports }) => ({
        path: p,
        dropped,
        kept_decls: kept_decls ?? [],
        dropped_decls: dropped_decls ?? [],
        dropped_imports: dropped_imports ?? [],
      })),
      go_slim_errors: report.errors ?? [],
      build_verification: buildVerification,
      written: write,
      message:
        `瘦身${write ? '完成' : '预演'}：${input.brick_name} → ${slimName}` +
        `（文件 ${filesBefore}→${filesAfter}，顶层声明 ${symbolsBefore}→${symbolsAfter}，` +
        `剔除三方依赖 ${depsRemoved.length} 个${depsRemoved.length ? `：${depsRemoved.join(', ')}` : ''}）${verifyNote}。` +
        `原积木未动；四层验证剩余三层（源测试/camera/效果验收）未做——剔除生效前请人工补验。`,
    };
  } finally {
    if (!write) fs.rmSync(outRoot, { recursive: true, force: true });
  }
}

// ── TS 路径（Phase 7：tree-sitter 剪刀，进程内）────────────────

const TS_SRC_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TS_RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'];

interface TsFileOutcome {
  path: string;
  dropped: boolean;
  /** 剪后零保留内容（候选整文件剔除，终判后回填 dropped） */
  empty: boolean;
  kept_decls: string[];
  dropped_decls: string[];
  kept_imports: string[];
  /** kept_imports 中无绑定子句的副作用导入（空壳终判依据：副作用引用→空壳，
   *  具名引用→档案缺口保原文） */
  side_effect_imports: string[];
  dropped_imports: string[];
}

function unquote(spec: string): string {
  return spec.replace(/^['"]|['"]$/g, '');
}

/** 源码 import/export specifier 提取（正则近似，误方向=多保依赖，安全） */
export function tsImportSpecifiers(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;\n]*?from\s*['"]([^'"]+)['"]/g)) {
    out.push(m[1]);
  }
  for (const m of src.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) {
    out.push(m[1]); // 副作用导入
  }
  return out;
}

/** 副作用导入 specifier（`import 'x'` 无绑定子句形态；gap 保留原文时用） */
function tsSideEffectSpecifiers(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) {
    out.push(m[1]);
  }
  return out;
}

/** import 绑定明细（正则近似；mark-sweep 需求闭包与回滚文件的绑定提取用）。
 *  named 的 names 取导出名（alias 前）；default/namespace 标 whole 需求 */
export interface TsImportBinding {
  module: string;
  kind: 'named' | 'default' | 'namespace' | 'side-effect';
  names: string[];
}

export function tsImportBindings(src: string): TsImportBinding[] {
  const out: TsImportBinding[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+([^;\n]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    const clause = m[1].trim();
    const module = m[2];
    if (!clause) {
      out.push({ module, kind: 'side-effect', names: [] });
      continue;
    }
    const namedMatch = clause.match(/\{([^}]*)\}/);
    if (namedMatch) {
      const names = namedMatch[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      if (names.length > 0) out.push({ module, kind: 'named', names });
      const pre = clause.slice(0, clause.indexOf('{')).replace(/,\s*$/, '').trim();
      if (pre && !pre.startsWith('*')) out.push({ module, kind: 'default', names: [] });
    } else if (/^\*\s+as\s+\S+$/.test(clause)) {
      out.push({ module, kind: 'namespace', names: [] });
    } else {
      out.push({ module, kind: 'default', names: [] });
    }
  }
  for (const m of src.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) {
    out.push({ module: m[1], kind: 'side-effect', names: [] });
  }
  return out;
}

/** 相对 specifier → 积木内相对路径（Node 解析规则：原样/补扩展名/index；
 *  exists 回调查存在性——目标可能是未写盘的待终判空文件） */
export function resolveTsSpecifier(
  fromRel: string,
  spec: string,
  exists: (p: string) => boolean,
): string | null {
  if (!spec.startsWith('.')) return null;
  const fromDir = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')) : '';
  const parts = (fromDir ? fromDir.split('/') : []).concat(spec.split('/'));
  const stack: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      stack.pop();
      continue;
    }
    stack.push(p);
  }
  const base = stack.join('/');
  if (base === '' || base.startsWith('..')) return null;
  if (exists(base)) return base;
  for (const ext of TS_RESOLVE_EXTS) if (exists(base + ext)) return base + ext;
  // TS ESM 惯例：'./x.js' 导入在盘上是 x.ts（tsc 编译期重写扩展名）——
  // mark-sweep 依赖 resolve 命中，漏映射会让类型文件不被 mark 而误剔
  if (/\.(js|jsx|mjs|cjs)$/.test(base)) {
    const stem = base.slice(0, base.lastIndexOf('.'));
    for (const e of ['.ts', '.tsx', '.mts', '.cts']) if (exists(stem + e)) return stem + e;
  }
  for (const ext of TS_RESOLVE_EXTS) if (exists(base + '/index' + ext)) return base + '/index' + ext;
  return null;
}

/** TS 贫困编译验证：tsc noEmit（进程内动态加载）。贫困口径：
 *  TS2307 且非相对路径 = 三方类型缺失（无 node_modules，预期）；
 *  相对路径 2307 / 其他诊断 = 真错误。typescript 不可用 → skipped 降级。
 *  导出供拼装区 e2e 复用（slim_brick / assemble 验证同口径）。 */
export async function verifyTsBuild(
  filesRoot: string,
): Promise<{ status: 'pass' | 'fail' | 'skipped'; at: string; detail?: string }> {
  const at = new Date().toISOString();
  let ts: typeof import('typescript');
  try {
    ts = (await import('typescript')) as typeof import('typescript');
  } catch {
    return { status: 'skipped', at, detail: 'typescript 包不可用——跳过贫困编译验证（源测试/效果验收层把关）' };
  }
  const files = walkRelative(filesRoot)
    .filter((f) => TS_SRC_RE.test(f))
    .map((f) => path.join(filesRoot, ...f.split('/')));
  if (files.length === 0) return { status: 'skipped', at, detail: '无 TS 源文件' };
  const program = ts.createProgram(files, {
    noEmit: true,
    skipLibCheck: true,
    allowJs: true,
    strict: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    esModuleInterop: true,
    // 源项目风格各异（ua_theme_engine 用 './presets.ts' 扩展名导入）——
    // noEmit 下合法，不开则贫困编译误报 TS5097
    allowImportingTsExtensions: true,
  });
  const real: string[] = [];
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ');
    if (d.code === 2307 && !/'?\.{1,2}\//.test(msg)) continue; // 三方缺类型 = 贫困预期
    const loc = d.file
      ? `${path.basename(d.file.fileName)}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}`
      : '?';
    real.push(`${loc} TS${d.code}: ${msg}`);
  }
  return real.length === 0
    ? { status: 'pass', at }
    : { status: 'fail', at, detail: real.slice(0, 30).join('\n') };
}

async function slimTsBrickCore(
  input: SlimBrickInput,
  manifest: BrickManifest,
  brickDir: string,
  filesRoot: string,
  allFiles: string[],
  diskTsFiles: string[],
  slimName: string,
  slimDir: string,
  write: boolean,
): Promise<SlimBrickResult> {
  const slimCandidates = manifest.slim_candidates;
  if (!slimCandidates?.live_symbols_by_file) {
    throw new Error(
      '积木缺 live 明细档案（slim_candidates.live_symbols_by_file）：请重抽（harvest_from_url）刷新死依赖分析后再瘦身',
    );
  }
  const liveByFile = slimCandidates.live_symbols_by_file;
  const liveKeys = Object.keys(liveByFile);
  const hitCount = diskTsFiles.filter((f) => liveByFile[f] !== undefined).length;
  if (liveKeys.length > 0 && hitCount === 0) {
    throw new Error(
      `live 明细（${liveKeys.length} 文件）与盒内 TS 文件（${diskTsFiles.length} 个）零命中——路径形态漂移，拒绝执行剪刀；请重抽刷新档案`,
    );
  }

  const outRoot = write ? path.join(slimDir, 'files') : fs.mkdtempSync(path.join(os.tmpdir(), 'slim-dry-'));
  try {
    // ── ① 逐文件剪刀（产物暂存内存，mark-sweep 终判后统一落盘）──
    interface Outcome {
      path: string;
      dropped: boolean;
      /** 当前产物源码（null = 剪后空）；终判迭代中被重剪/回滚更新 */
      outSrc: string | null;
      /** 需求闭包注入的 keep 名（档案缺口自愈；单调增） */
      keepExtra: Set<string>;
      /** 已回滚原文（default/namespace 需求、种子空文件、形态未覆盖兜底） */
      rolledBack: boolean;
      kept_decls: string[];
      dropped_decls: string[];
      kept_imports: string[];
      side_effect_imports: string[];
      dropped_imports: string[];
      /** 当前产物源码的 import 绑定（需求闭包输入） */
      bindings: TsImportBinding[];
    }
    const outcomes: Outcome[] = [];
    const tsSlimErrors: string[] = [];
    const byPath = new Map<string, Outcome>();
    const readBrickSrc = (rel: string): string =>
      fs.readFileSync(path.join(filesRoot, ...rel.split('/')), 'utf-8');
    const applyResult = (o: Outcome, r: TsSlimResult): void => {
      o.outSrc = r.out;
      o.kept_decls = r.kept_decls;
      o.dropped_decls = r.dropped_decls;
      o.kept_imports = r.kept_imports.map(unquote);
      o.side_effect_imports = r.side_effect_imports.map(unquote);
      o.dropped_imports = r.dropped_imports.map(unquote);
      o.bindings = r.kept_import_bindings;
    };
    const rollback = (o: Outcome, why: string): void => {
      const src = readBrickSrc(o.path);
      o.outSrc = src;
      o.rolledBack = true;
      o.kept_decls = [...o.kept_decls, ...o.dropped_decls];
      o.dropped_decls = [];
      o.dropped_imports = [];
      const b = tsImportBindings(src);
      o.bindings = b;
      o.kept_imports = [...new Set(b.map((x) => x.module))];
      o.side_effect_imports = b.filter((x) => x.kind === 'side-effect').map((x) => x.module);
      tsSlimErrors.push(`${o.path}: ${why}——已保留原文件`);
    };
    for (const rel of diskTsFiles) {
      const src = readBrickSrc(rel);
      const ext = rel.slice(rel.lastIndexOf('.'));
      try {
        const r = await slimTsFile(src, liveByFile[rel] ?? [], ext);
        const o: Outcome = {
          path: rel,
          dropped: false,
          outSrc: null,
          keepExtra: new Set<string>(),
          rolledBack: false,
          kept_decls: [],
          dropped_decls: [],
          kept_imports: [],
          side_effect_imports: [],
          dropped_imports: [],
          bindings: [],
        };
        applyResult(o, r);
        outcomes.push(o);
        byPath.set(rel, o);
      } catch (e) {
        // 解析失败：原样保留（盘上真相优先），绑定从原文提取防误报"已剔除"
        tsSlimErrors.push(`${rel}: ${(e as Error).message}`);
        const o: Outcome = {
          path: rel,
          dropped: false,
          outSrc: src,
          keepExtra: new Set<string>(),
          rolledBack: true,
          kept_decls: [],
          dropped_decls: [],
          kept_imports: [],
          side_effect_imports: [],
          dropped_imports: [],
          bindings: [],
        };
        const b = tsImportBindings(src);
        o.bindings = b;
        o.kept_imports = [...new Set(b.map((x) => x.module))];
        o.side_effect_imports = b.filter((x) => x.kind === 'side-effect').map((x) => x.module);
        outcomes.push(o);
        byPath.set(rel, o);
      }
    }

    // ── ② mark-sweep 终判 + 跨文件导出需求闭包（不动点）──
    // 文件级活性（mark）：种子恒活；活文件【保留的】import（解析到闭包内）
    //   → 目标活。死文件（闭包内、非 mark）剔除——其 import 不计引用
    //   （防注释词法误保活连锁：language-registry.ts 剪剩注释，注释里的
    //   "LanguageConfig" 字样曾保活 import 再连锁拽住 types.ts）。
    // 导出需求（需求闭包）：活文件 A 保留 import 的绑定名 → 目标 B 必须提供：
    //   named 缺失 → 注入 B 的 keep 集重剪（精确复活，live 档案缺口自愈——
    //     跨文件 type_ref 边缺失导致 keep 集漏名的主通道）；
    //   default/namespace → B 回滚原文（整文件导出面被需要，保守）。
    // keep 集与 mark 集单调增 → 收敛（轮数上限防呆）。
    const allRelSet = new Set(allFiles);
    const resolve = (fromRel: string, spec: string): string | null =>
      resolveTsSpecifier(fromRel, spec, (p) => allRelSet.has(p));
    // 种子判定：manifest.seed_files 与盒内路径形态对齐（src/ 前缀变体）
    const seedVariants = new Set<string>();
    for (const s of manifest.seed_files ?? []) {
      seedVariants.add(s);
      seedVariants.add(s.replace(/^src\//, ''));
      seedVariants.add(`src/${s}`);
    }
    const seedRootFiles = diskTsFiles.filter((f) => seedVariants.has(f));
    const markRootSet = new Set(seedRootFiles);
    // 种子零命中（路径形态漂移）→ 全部按种子处理（宁多保不误删）
    if (markRootSet.size === 0) for (const f of diskTsFiles) markRootSet.add(f);

    for (let round = 0; round < 12; round++) {
      // mark：从种子沿存活文件的保留 import BFS（type 文件也走——编译期需要）
      const marked = new Set<string>();
      const queue = [...markRootSet];
      while (queue.length > 0) {
        const f = queue.pop()!;
        if (marked.has(f)) continue;
        const o = byPath.get(f);
        if (!o || o.dropped) continue;
        marked.add(f);
        for (const spec of o.kept_imports) {
          const t = resolve(f, spec);
          if (t && byPath.has(t) && !marked.has(t)) queue.push(t);
        }
      }
      // 需求收集（只看 mark 文件——死文件的 import 不计引用）
      const demands = new Map<string, { named: Set<string>; whole: boolean }>();
      for (const f of marked) {
        const o = byPath.get(f)!;
        for (const b of o.bindings) {
          if (b.kind === 'side-effect') continue;
          const t = resolve(f, b.module);
          if (!t || !byPath.has(t)) continue;
          const d = demands.get(t) ?? { named: new Set<string>(), whole: false };
          if (b.kind === 'named') for (const n of b.names) d.named.add(n);
          else d.whole = true;
          demands.set(t, d);
        }
      }
      // gap 修复 + sweep
      let changed = false;
      for (const o of outcomes) {
        if (!marked.has(o.path)) {
          if (!o.dropped) {
            o.dropped = true;
            changed = true;
          }
          continue;
        }
        if (o.dropped) {
          o.dropped = false;
          changed = true;
        }
        if (o.outSrc === null && markRootSet.has(o.path) && !o.rolledBack) {
          rollback(o, '种子文件剪后为空（live 档案缺口）');
          changed = true;
          continue;
        }
        const d = demands.get(o.path);
        if (!d) continue;
        if (d.whole && !o.rolledBack) {
          rollback(o, '被 default/namespace import 引用（整文件导出面被需要）');
          changed = true;
          continue;
        }
        const missing = [...d.named].filter((n) => !o.kept_decls.includes(n));
        if (missing.length > 0) {
          for (const n of missing) o.keepExtra.add(n);
          const ext = o.path.slice(o.path.lastIndexOf('.'));
          const r = await slimTsFile(readBrickSrc(o.path), [...(liveByFile[o.path] ?? []), ...o.keepExtra], ext);
          applyResult(o, r);
          const still = [...d.named].filter((n) => !o.kept_decls.includes(n));
          if (still.length > 0) {
            rollback(o, `需求导出 ${still.join(', ')} 不在该文件声明集（re-export/形态未覆盖）`);
          }
          changed = true;
        }
      }
      if (!changed) break;
    }

    // 副作用空壳终判：mark 文件剪后空——被副作用 import 引用写空模块保路径
    // （import 即执行的模块不能 404）；无引用的空文件剔除
    for (const o of outcomes) {
      if (o.dropped || o.outSrc !== null) continue;
      const sideRef = outcomes.some(
        (other) =>
          other !== o &&
          !other.dropped &&
          other.bindings.some((b) => b.kind === 'side-effect' && resolve(other.path, b.module) === o.path),
      );
      if (sideRef) o.outSrc = '';
      else o.dropped = true;
    }

    // ── ③ 落盘：存活文件写剪后产物（空壳写空模块）──
    for (const o of outcomes) {
      if (o.dropped || o.outSrc === null) continue;
      const dest = path.join(outRoot, ...o.path.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, o.outSrc, 'utf-8');
    }

    // ── ④ 非 TS 资产按需搬运：存活产物 import 引用的资产（css/json 等）──
    // 与 Go 的 embed 按需同构：静态可见引用（import specifier）之外的资产不搬；
    // 运行时 fs.readFile 读的资产静态看不见——源测试/效果验收层把关
    const keptAssets = new Set<string>();
    for (const o of outcomes) {
      if (o.dropped) continue;
      for (const spec of o.kept_imports) {
        const t = resolve(o.path, spec);
        if (t && !TS_SRC_RE.test(t)) keptAssets.add(t);
      }
    }
    const nonTsFiles = allFiles.filter((f) => !TS_SRC_RE.test(f));
    for (const rel of keptAssets) {
      const dest = path.join(outRoot, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(filesRoot, ...rel.split('/')), dest);
    }

    // ── ④ 统计与依赖对账（原始路径口径：TS 无版本档案）──
    const produced = walkRelative(outRoot);
    const producedSet = new Set(produced);
    const surviving = outcomes.filter((o) => !o.dropped && producedSet.has(o.path));
    const droppedFiles = outcomes.filter((o) => o.dropped).map((o) => o.path);
    const filesBefore = allFiles.length;
    const filesAfter = produced.length;
    const symbolsBefore = outcomes.reduce((n, f) => n + f.kept_decls.length + f.dropped_decls.length, 0);
    const symbolsAfter = surviving.reduce((n, f) => n + f.kept_decls.length, 0);

    const keptImports = new Set<string>();
    for (const o of surviving) for (const imp of o.kept_imports) keptImports.add(imp);
    const isTsStdlib = (p: string): boolean => p.startsWith('node:') || NODE_BUILTINS.has(p.split('/')[0]);
    const externalImports = [...keptImports].filter((p) => !p.startsWith('.')).sort();
    const stdlibImports = externalImports.filter(isTsStdlib);
    const thirdPartyImports = externalImports.filter((p) => !isTsStdlib(p));
    const beforeSources = (manifest.closure.external ?? [])
      .filter((e) => e.class === 'third_party')
      .map((e) => e.source);
    const depsBefore = [...new Set(beforeSources)].sort();
    const depsAfter = thirdPartyImports;
    const unresolvedImports: string[] = [];
    const depsRemoved = depsBefore.filter((d) => !depsAfter.includes(d));
    // 依赖版本存档传导：只留剪后仍存活的依赖（死依赖的版本档案随代码一起出清）
    let slimNpmRequires: Record<string, string> | undefined;
    if (manifest.npm_requires) {
      const after = resolveNpmThirdParty(depsAfter, manifest.npm_requires);
      if (Object.keys(after.resolved).length) slimNpmRequires = after.resolved;
    }

    // ── ⑤ 无可剪内容：不生成空壳衍生积木 ──
    const nothingToSlim =
      symbolsAfter === symbolsBefore &&
      droppedFiles.length === 0 &&
      tsSlimErrors.length === 0 &&
      depsRemoved.length === 0 &&
      outcomes.every((o) => o.dropped_imports.length === 0) &&
      nonTsFiles.every((f) => keptAssets.has(f));
    if (nothingToSlim) {
      if (write) fs.rmSync(slimDir, { recursive: true, force: true });
      return {
        brick: input.brick_name,
        slim_name: slimName,
        slim_dir: '',
        files_before: filesBefore,
        files_after: filesAfter,
        dropped_files: [],
        symbols_before: symbolsBefore,
        symbols_after: symbolsAfter,
        deps_before: depsBefore,
        deps_after: depsAfter,
        deps_removed: [],
        kept_imports_stdlib: stdlibImports,
        unresolved_imports: unresolvedImports,
        files: outcomes.map(({ path: p, dropped, kept_decls, dropped_decls, dropped_imports }) => ({
          path: p,
          dropped,
          kept_decls,
          dropped_decls,
          dropped_imports,
        })),
        go_slim_errors: tsSlimErrors,
        written: false,
        message: `无可剪内容（${symbolsBefore} 声明全部存活、无文件/依赖/资产可剔），未生成衍生积木`,
      };
    }

    // ── ⑥ 贫困编译验证（可选；tsc 进程内）──
    let buildVerification: SlimBrickResult['build_verification'];
    if (input.verify_build) {
      buildVerification = await verifyTsBuild(outRoot);
    }

    // ── ⑦ 落盘：contracts.json + manifest.json ──
    if (write) {
      let contractsByPath: Record<string, BrickContract> = {};
      try {
        contractsByPath = JSON.parse(fs.readFileSync(path.join(brickDir, 'contracts.json'), 'utf-8')) as Record<
          string,
          BrickContract
        >;
      } catch {
        // contracts.json 缺失/损坏：聚合退化为空（衍生积木仍可拼装，货架卡片薄）
      }
      const slimContracts: Record<string, BrickContract> = {};
      for (const [p, c] of Object.entries(contractsByPath)) {
        if (producedSet.has(p)) slimContracts[p] = c;
      }
      fs.writeFileSync(path.join(slimDir, 'contracts.json'), JSON.stringify(slimContracts, null, 2), 'utf-8');

      const slimManifest: BrickManifest = {
        name: slimName,
        schema_version: 1,
        description: `${manifest.description ? `${manifest.description}；` : ''}瘦身衍生积木（ts-slim 按 live 集剪枝：${filesBefore}→${filesAfter} 文件 / ${symbolsBefore}→${symbolsAfter} 声明 / 剔除三方依赖 ${depsRemoved.length} 个）`,
        seed_files: manifest.seed_files,
        closure: {
          internal: [...producedSet].sort(),
          external: [
            ...stdlibImports.map((s) => ({ source: s, class: 'stdlib' as const })),
            ...depsAfter.map((m) => ({ source: m, class: 'third_party' as const })),
          ],
        },
        aggregate: aggregateContracts(Object.values(slimContracts)),
        acceptance: manifest.acceptance,
        npm_requires: slimNpmRequires,
        derived_from: {
          brick: input.brick_name,
          slimmed_at: new Date().toISOString(),
          files_before: filesBefore,
          files_after: filesAfter,
          symbols_before: symbolsBefore,
          symbols_after: symbolsAfter,
          deps_before: depsBefore,
          deps_after: depsAfter,
        },
        slim_verification: buildVerification ? { build: buildVerification } : undefined,
        provenance: manifest.provenance
          ? {
              source_project: manifest.provenance.source_project,
              commit: manifest.provenance.commit,
              harvested_at: manifest.provenance.harvested_at,
            }
          : undefined,
      };
      fs.writeFileSync(path.join(slimDir, 'manifest.json'), JSON.stringify(slimManifest, null, 2), 'utf-8');
    }

    const verifyNote = buildVerification
      ? `；贫困编译验证 ${buildVerification.status === 'pass' ? '通过' : buildVerification.status === 'skipped' ? '跳过' : '失败（详见 slim_verification.build）'}`
      : '';
    return {
      brick: input.brick_name,
      slim_name: slimName,
      slim_dir: write ? slimDir : '',
      files_before: filesBefore,
      files_after: filesAfter,
      dropped_files: droppedFiles,
      symbols_before: symbolsBefore,
      symbols_after: symbolsAfter,
      deps_before: depsBefore,
      deps_after: depsAfter,
      deps_removed: depsRemoved,
      kept_imports_stdlib: stdlibImports,
      unresolved_imports: unresolvedImports,
      files: outcomes.map(({ path: p, dropped, kept_decls, dropped_decls, dropped_imports }) => ({
        path: p,
        dropped,
        kept_decls,
        dropped_decls,
        dropped_imports,
      })),
      go_slim_errors: tsSlimErrors,
      build_verification: buildVerification,
      written: write,
      message:
        `瘦身${write ? '完成' : '预演'}：${input.brick_name} → ${slimName}` +
        `（文件 ${filesBefore}→${filesAfter}，顶层声明 ${symbolsBefore}→${symbolsAfter}，` +
        `剔除三方依赖 ${depsRemoved.length} 个${depsRemoved.length ? `：${depsRemoved.join(', ')}` : ''}）${verifyNote}。` +
        `原积木未动；四层验证剩余层（源测试/camera/效果验收）未做——剔除生效前请人工补验。`,
    };
  } finally {
    if (!write) fs.rmSync(outRoot, { recursive: true, force: true });
  }
}
