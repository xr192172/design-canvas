/**
 * harvest_from_url —— 积木抽取编排（Brick Harvest Phase 3）
 *
 * 目标场景（用户原话）："我看见哪个项目好，告诉你，你自己去拉项目、解析、
 * 抽积木"——把已有原子工具串成一条链，行为内化成工具：
 *
 *   浅 clone（或本地目录原地） → import_project 建索引
 *     → extract_contracts（契约本体，return_contracts 内部消费）
 *     → 选积木（显式 seeds 或 auto：functional + fan_in + confidence）
 *     → harvest_closure 算闭包
 *     → 入盒三件套（Phase 2.7 决策：自包含快照，不保留原项目）
 *
 * 积木盒布局（<box_dir>/<name>/，默认 <dataHome>/.design-canvas/bricks/）：
 *   manifest.json   —— BrickManifest：闭包档案 + 聚合契约（检索货架卡片）
 *   contracts.json  —— 闭包全体文件 BrickContract（按 path 分 key）
 *   files/<rel>     —— 闭包文件内容原样（自包含快照）
 *   原项目只留 provenance 冷记录（git URL + commit），重抽凭记录可再来。
 *
 * 保护：单积木闭包 > max_closure（默认 50）跳过——防止把整个项目端走。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { getStorageRoot } from '../storage.js';
import { openDb, closeProjectCacheDb, getProjectCacheDb } from '../db/db.js';
import { syncProject } from '../db/symbols.js';
import { walkFiles } from './import_project.js';
import { extractContracts, type FileContractReport } from './extract_contracts.js';
import { harvestClosure } from './harvest_closure.js';
import { parseGoModRequires, resolveGoThirdParty } from './go_mod.js';
import { analyzeDeadThirdParty } from './dead_deps.js';
import type { BrickContract, BrickManifest, ShapeSchema } from '../dsl/contract.js';

export interface BrickSpec {
  /** 积木名（缺省 = <repo>__<种子文件名>） */
  name?: string;
  /** 种子文件（相对项目根；闭包从种子沿 import 展开） */
  seeds: string[];
}

export interface HarvestFromUrlInput {
  /** 项目来源：git URL（浅克隆）或本地目录（原地分析，不写源项目） */
  source: string;
  /** 显式积木规格（一组种子一个积木）；缺省走 auto 模式 */
  bricks?: BrickSpec[];
  /** auto 模式参数（bricks 未提供时生效） */
  auto?: {
    /** 最多抽几个积木（默认 5） */
    max_bricks?: number;
    /** 种子最低 fan_in（默认 2——被至少 2 个文件复用才算"值得拎"） */
    min_fan_in?: number;
    /** 额外排除的路径子串（vendored 克隆之外调用方自定义排除） */
    exclude?: string[];
  };
  /** 单积木闭包文件数上限（默认 50；超限跳过该积木并告警） */
  max_closure?: number;
  /** 积木盒根目录（默认 <dataHome>/.design-canvas/bricks） */
  box_dir?: string;
  /** false 只预演不入盒（dry-run） */
  write?: boolean;
}

export interface HarvestedBrickReport {
  name: string;
  seeds: string[];
  /** 闭包文件数（含种子） */
  closure_count: number;
  /** 闭包最大深度 */
  depth: number;
  external: { stdlib: number; third_party: number; unresolved: number };
  aggregate: {
    exposes: number;
    emits: number;
    reads_config: number;
    irreversible_effects: number;
  };
  /** 入盒目录（write=false 时为预演空值） */
  brick_dir: string;
  /** 同名覆盖 = 重抽更新（原快照被替换） */
  replaced: boolean;
}

export interface HarvestFromUrlResult {
  source: string;
  /** 解析出的项目根（clone 后临时目录或本地目录） */
  project_dir: string;
  repo_name: string;
  commit: string;
  /** 索引统计（import_project 结果摘要） */
  indexed_files: number;
  bricks: HarvestedBrickReport[];
  /** 跳过原因（闭包超限等） */
  skipped: Array<{ seeds: string[]; reason: string }>;
  box_dir: string;
  written: boolean;
  message: string;
}

// ── 工具函数 ──────────────────────────────────────────────

/** repo 名：URL 尾段去 .git；本地路径取目录名 */
function repoNameOf(source: string): string {
  const s = source.replace(/[\\/]+$/, '');
  const tail = s.split(/[\\/]/).pop() ?? 'project';
  return tail.replace(/\.git$/, '') || 'project';
}

/** 积木名规范化：小写、非法字符→下划线 */
function normalizeBrickName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\.go$|\.ts$|\.tsx$|\.js$|\.py$/, '')
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** 种子文件 stem（路径→下划线连接） */
function seedStem(seed: string): string {
  return normalizeBrickName(seed.replace(/\.[^.]+$/, '').replace(/[\\/]+/g, '__'));
}

function gitOk(cwd: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    return '';
  }
}

/** 浅克隆到临时目录；返回项目根。失败抛错（URL 错/网络断）。 */
function shallowClone(url: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brick-clone-'));
  execSync(`git clone --depth 1 --quiet ${JSON.stringify(url)} ${JSON.stringify(dir)}`, {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 120_000,
  });
  return dir;
}

/** 聚合闭包契约：并集 + 不可逆 effect 计数 */
function aggregateContracts(contracts: BrickContract[]): BrickManifest['aggregate'] {
  const byName = new Map<string, ShapeSchema>();
  const consumeByName = new Map<string, ShapeSchema>();
  const emits = new Set<string>();
  const config = new Set<string>();
  let irreversible = 0;
  for (const c of contracts) {
    for (const s of c.shapes.exposes) if (!byName.has(s.name)) byName.set(s.name, s);
    for (const s of c.shapes.consumes) if (!consumeByName.has(s.name)) consumeByName.set(s.name, s);
    for (const e of c.effects.emits) emits.add(e);
    for (const k of c.effects.reads_config) config.add(k);
    for (const t of [...c.effects.writes, ...c.effects.holds]) {
      if (!t.reversible) irreversible++;
    }
  }
  return {
    exposes: [...byName.values()],
    consumes: [...consumeByName.values()],
    emits: [...emits],
    reads_config: [...config],
    irreversible_effects: irreversible,
  };
}

/**
 * 判断相对路径是否落在 vendored 第三方项目克隆内（如 research/amazon-extensions/nodriver，
 * 或 gitignore 的 go-lab/agent-shell 实验克隆——嵌套 go.mod = 独立 module）。
 * 信号：某个祖先目录（非项目根）携带独立项目全套标记——
 *   Go 嵌套 module（go.mod）、Python 打包件（pyproject.toml/setup.py/setup.cfg）、
 *   或 LICENSE+README 并存（完整镜像特征；单 package.json 不算——monorepo 子包是一方代码）。
 * 这类目录的 fan_in 是库内部引用，不是宿主项目的复用信号，auto 选种必须排除；
 * 显式 seeds 不拦（人的判断优先，如刻意要抽 vendored 里的东西）。
 */
function underVendoredRoot(root: string, rel: string): boolean {
  const segs = rel.split(/[\\/]+/);
  for (let i = 1; i < segs.length; i++) {
    const dir = path.join(root, segs.slice(0, i).join(path.sep));
    if (!fs.existsSync(dir)) continue;
    const has = (m: string) => fs.existsSync(path.join(dir, m));
    const pyMarker = ['pyproject.toml', 'setup.py', 'setup.cfg'].some(has);
    const goModule = has('go.mod');
    const license_ = ['LICENSE', 'LICENSE.txt', 'COPYING'].some(has);
    const readme = ['README.md', 'README.rst', 'README.txt'].some(has);
    if (goModule || pyMarker || (license_ && readme)) return true;
  }
  return false;
}

// ── 主流程 ──────────────────────────────────────────────

export async function harvestFromUrl(input: HarvestFromUrlInput): Promise<HarvestFromUrlResult> {
  const source = input.source;
  const isLocal = fs.existsSync(source) && fs.statSync(source).isDirectory();

  let root: string;
  let cleanup = false;
  if (isLocal) {
    root = path.resolve(source);
  } else {
    root = shallowClone(source);
    cleanup = true;
  }

  try {
    const repoName = repoNameOf(source);
    const commit = gitOk(root);
    const boxDir = input.box_dir ?? path.join(getStorageRoot(), 'bricks');
    const maxClosure = input.max_closure ?? 50;

    // ① 索引（walkFiles + syncProject 纯建缓存，不走 importProject——那会写 DSL feature 污染列表）
    const dbPath = path.join(root, '.design-canvas', 'cache.db');
    const db = openDb(dbPath);
    let indexed: number;
    try {
      const absFiles = walkFiles(root, false, false);
      await syncProject(db, root, absFiles);
      indexed = (db.prepare('SELECT COUNT(*) n FROM files').get() as { n: number }).n;
    } finally {
      db.close();
    }
    const ec = extractContracts({ project_dir: root, return_contracts: true });
    const contractsByPath = ec.contracts ?? {};
    const reportByPath = new Map<string, FileContractReport>(ec.files.map((f) => [f.path, f]));

    // auto 模式被排除的候选（vendored/调用方 exclude）——进 skipped 报告，不静默消失
    const vendoredSkipped: Array<{ seeds: string[]; reason: string }> = [];

    // ③ 选积木
    let specs: BrickSpec[];
    if (input.bricks?.length) {
      specs = input.bricks;
    } else {
      const maxBricks = input.auto?.max_bricks ?? 5;
      const minFanIn = input.auto?.min_fan_in ?? 2;
      const excludes = input.auto?.exclude ?? [];
      specs = ec.files
        .filter(
          (f) =>
            f.role.class === 'functional' &&
            f.fan_in >= minFanIn &&
            f.role.confidence >= 0.7 &&
            !f.path.endsWith('_test.go') &&
            !/\.(test|spec)\.[jt]sx?$/.test(f.path),
        )
        .filter((f) => {
          // vendored 第三方克隆：fan_in 是库内部引用而非宿主复用信号，auto 不选
          if (underVendoredRoot(root, f.path)) {
            vendoredSkipped.push({ seeds: [f.path], reason: 'vendored 第三方项目克隆（fan_in=库内部引用，非宿主复用）' });
            return false;
          }
          const hit = excludes.find((p) => f.path.includes(p));
          if (hit) {
            vendoredSkipped.push({ seeds: [f.path], reason: `调用方 exclude 命中：${hit}` });
            return false;
          }
          return true;
        })
        .sort((a, b) => b.fan_in - a.fan_in)
        .slice(0, maxBricks)
        .map((f) => ({ seeds: [f.path] }));
    }

    // ④ 闭包 + ⑤ 入盒
    const reports: HarvestedBrickReport[] = [];
    const skipped: Array<{ seeds: string[]; reason: string }> = [];

    for (const spec of specs) {
      const missing = spec.seeds.filter((s) => !reportByPath.has(s) && !reportByPath.has(s.replace(/^src\//, '')));
      if (missing.length === spec.seeds.length) {
        skipped.push({ seeds: spec.seeds, reason: `种子不在索引中：${missing.join(', ')}` });
        continue;
      }
      const closure = harvestClosure({ project_dir: root, files: spec.seeds });
      if (closure.internal_files.length === 0) {
        skipped.push({ seeds: spec.seeds, reason: '闭包为空' });
        continue;
      }
      if (closure.internal_files.length > maxClosure) {
        skipped.push({
          seeds: spec.seeds,
          reason: `闭包 ${closure.internal_files.length} 文件超上限 ${maxClosure}（疑似整个项目被端走）`,
        });
        continue;
      }

      const name =
        spec.name ??
        normalizeBrickName(`${repoName}__${spec.seeds.map(seedStem).join('-and-')}`);
      const brickDir = path.join(boxDir, name);
      const replaced = fs.existsSync(path.join(brickDir, 'manifest.json'));

      // 重抽保留：acceptance/matches/effect_verification/description 是人工沉淀
      // （验收判据、匹配历史、camera 动静对账证据档案、人话介绍），不随快照覆盖
      // 丢失——契约/闭包/文件由重抽重算，人的判断与运行证据只有一份。
      let preserved: Pick<
        BrickManifest,
        'acceptance' | 'matches' | 'effect_verification' | 'description'
      > = {};
      if (replaced) {
        try {
          const old = JSON.parse(
            fs.readFileSync(path.join(brickDir, 'manifest.json'), 'utf-8'),
          ) as BrickManifest;
          if (old.acceptance) preserved.acceptance = old.acceptance;
          if (old.matches) preserved.matches = old.matches;
          if (old.effect_verification) preserved.effect_verification = old.effect_verification;
          if (old.description) preserved.description = old.description;
        } catch {
          // 旧 manifest 损坏：按全新入盒处理，保留逻辑静默跳过
        }
      }

      // 闭包契约（含 src/ 前缀适配）与聚合
      const closureContracts: Record<string, BrickContract> = {};
      for (const f of closure.internal_files) {
        const c =
          contractsByPath[f.path] ??
          contractsByPath[f.path.replace(/^src\//, '')] ??
          contractsByPath[`src/${f.path}`];
        if (c) closureContracts[f.path] = c;
      }
      const agg = aggregateContracts(Object.values(closureContracts));

      // Go 积木重依赖存档：源项目 go.mod 的 require 版本（拼装区自动 require 的事实来源）。
      // 机器可重算字段——重抽时刷新，不进保留列表；TS 积木/无 go.mod/归并不上 → 留空（拼装时进 pending）。
      let goModRequires: Record<string, string> | undefined;
      if (closure.internal_files.some((f) => f.path.endsWith('.go'))) {
        const goModPath = path.join(root, 'go.mod');
        if (fs.existsSync(goModPath)) {
          const requires = parseGoModRequires(fs.readFileSync(goModPath, 'utf-8'));
          const thirdParty = closure.external
            .filter((e) => e.class === 'third_party')
            .map((e) => e.source);
          const { resolved } = resolveGoThirdParty(thirdParty, requires);
          if (Object.keys(resolved).length) goModRequires = resolved;
        }
      }

      // 死依赖检测（瘦身事实层）：种子不可达代码引入的三方依赖 = 死候选。
      // Camera 宪法同构——只报告不剔除；机器可重算，重抽刷新。
      let slimCandidates: BrickManifest['slim_candidates'];
      if (closure.external.some((e) => e.class === 'third_party')) {
        try {
          const dd = analyzeDeadThirdParty({
            db: getProjectCacheDb(root),
            projectDir: root,
            closureFiles: closure.internal_files.map((f) => f.path),
            seedFiles: closure.internal_files
              .filter((f) => f.depth === 0)
              .map((f) => f.path),
            external: closure.external,
          });
          slimCandidates = {
            computed_at: new Date().toISOString(),
            live_symbols: dd.live_symbols,
            total_symbols: dd.total_symbols,
            dead_third_party: dd.dead,
            limitations: dd.limitations,
          };
        } catch {
          // 分析失败不阻塞入盒：slim_candidates 缺省 = 未检测
        }
      }

      if (input.write !== false) {
        // files/：闭包文件内容快照
        fs.rmSync(brickDir, { recursive: true, force: true });
        for (const f of closure.internal_files) {
          const src = path.join(root, f.path);
          if (!fs.existsSync(src)) continue;
          const dest = path.join(brickDir, 'files', f.path);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
        }
        // contracts.json：闭包全体契约
        fs.mkdirSync(brickDir, { recursive: true });
        fs.writeFileSync(
          path.join(brickDir, 'contracts.json'),
          JSON.stringify(closureContracts, null, 2),
          'utf-8',
        );
        // manifest.json：清单 + 聚合（+ 重抽保留的 acceptance/matches）
        const manifest: BrickManifest = {
          name,
          schema_version: 1,
          seed_files: spec.seeds,
          closure: {
            internal: closure.internal_files.map((f) => f.path),
            external: closure.external.map((e) => ({ source: e.source, class: e.class })),
          },
          aggregate: agg,
          go_mod_requires: goModRequires,
          slim_candidates: slimCandidates,
          ...preserved,
          provenance: {
            source_project: source,
            commit: commit || undefined,
            harvested_at: new Date().toISOString(),
          },
        };
        fs.writeFileSync(
          path.join(brickDir, 'manifest.json'),
          JSON.stringify(manifest, null, 2),
          'utf-8',
        );
      }

      reports.push({
        name,
        seeds: spec.seeds,
        closure_count: closure.internal_files.length,
        depth: closure.stats.max_depth_reached,
        external: {
          stdlib: closure.stats.stdlib_count,
          third_party: closure.stats.third_party_count,
          unresolved: closure.stats.unresolved_count,
        },
        aggregate: {
          exposes: agg.exposes.length,
          emits: agg.emits.length,
          reads_config: agg.reads_config.length,
          irreversible_effects: agg.irreversible_effects,
        },
        brick_dir: input.write === false ? '' : brickDir,
        replaced,
      });
    }

    const written = input.write !== false && reports.length > 0;
    const allSkipped = [...skipped, ...vendoredSkipped];
    const message =
      `积木抽取：${repoName}${commit ? `@${commit.slice(0, 8)}` : ''} 索引 ${indexed} 文件，` +
      `入盒 ${reports.length} 块${reports.length ? `（${reports.map((r) => `${r.name}×${r.closure_count}`).join(', ')}）` : ''}` +
      (allSkipped.length ? `；跳过 ${allSkipped.length}（${allSkipped.map((s) => s.reason.split('（')[0]).join('; ')}）` : '') +
      (written ? `，盒：${boxDir}` : '（dry-run 预演）') +
      `。`;

    return {
      source,
      project_dir: root,
      repo_name: repoName,
      commit,
      indexed_files: indexed,
      bricks: reports,
      skipped: allSkipped,
      box_dir: boxDir,
      written,
      message,
    };
  } finally {
    // 释放 extract_contracts/harvest_closure 经连接池占住的 cache.db 句柄
    //（不关则 Windows 删临时目录 EBUSY；本地目录关闭亦无妨，下次调用自动重开）
    closeProjectCacheDb(root);
    if (cleanup) {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    }
  }
}
