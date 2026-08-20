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
import { parseGoImportQualifiers } from './dead_deps.js';
import { aggregateContracts } from './harvest_from_url.js';
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
  build_verification?: { status: 'pass' | 'fail'; at: string; detail?: string };
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
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as BrickManifest;

  const filesRoot = path.join(brickDir, 'files');
  if (!fs.existsSync(filesRoot)) {
    throw new Error(`积木缺文件快照：${filesRoot}`);
  }
  const allFiles = walkRelative(filesRoot);
  const diskGoFiles = allFiles.filter((f) => f.endsWith('.go'));
  const nonGoFiles = allFiles.filter((f) => !f.endsWith('.go'));
  if (diskGoFiles.length === 0) {
    throw new Error('非 Go 积木：go-slim 剪刀只支持 Go（TS 剪刀未实现）');
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

  const slimName = input.name ?? `${input.brick_name}-slim`;
  const slimDir = path.join(boxDir, slimName);
  if (fs.existsSync(slimDir)) {
    throw new Error(`衍生积木已存在：${slimDir}（机器产物可重生成：删除该目录后重跑 slim_brick）`);
  }

  const write = input.write !== false;
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
