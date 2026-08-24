/**
 * feature_map —— 可视化地基：把"文件结构 → 功能 → 前端/后端 → 相似功能 → 废弃功能"算出来
 *
 * 用户目标：可视化要能展示——"一个功能下面挂着它的前端功能和后端功能；还能列出相似功能、
 * 重构废弃功能"。本模块把这份*语义树*确定性算出来，供渲染层直接画，也供人先看报告再拍板。
 *
 * 设计原则（反屎山）：**只拼装既有的探索原子，不重复实现**——
 *   - 前端/后端 分层：复用 layer_detect.matchLayer（ui→前端；api/service/data/middleware/entry→后端；
 *     util/config/types/test/core→通用）。
 *   - 废弃证据：复用 detectDeadImports（TS/Go 文件级死 import）+ detectDeadPyImports（py）。
 *   - 源码收集：扫描 source_root 下源文件（跳过 node_modules/.git/dist/venv/__pycache__ 等噪音）。
 * 新增的只有"功能(按目录切分) + 相似功能(文件重名重叠)"这两层聚合，属于这个粒度的新能力。
 *
 * 功能切分：source_root 下按*首层目录段*作为一个功能（如 src/renderer → 'renderer'）；
 * 直接挂在 source_root 下的文件归入 'root' 功能。目录名即功能 id，顺序稳定。
 *
 * 相似功能：两个功能若存在*文件基名重叠*（如都含 index.ts/types.ts/verify.ts），视为结构雷同——
 * 这正反映"AI 重复实现而非在原功能上扩展"的典型屎山症状。score = 重叠基名数 / 两端基名集的小者。
 */

import fs from 'node:fs';
import path from 'node:path';
import { matchLayer } from './layer_detect.js';
import { detectDeadImports, type DeadImportCandidate } from './detect_dead_imports.js';
import { detectDeadPyImports, type DetectPyDeadImportsResult } from './python_refactor/dead_imports.js';

export type FeatureSide = 'frontend' | 'backend' | 'shared';

export interface FeatureMapOptions {
  /** 工程根 */
  project_dir: string;
  /** 源码根；缺省 = project_dir。功能按此根的首层目录切分。 */
  source_root?: string;
}

export interface SimilarFeatureLink {
  featureId: string;
  /** 重叠基名数 / 两端基名集较小者的比值 [0,1] */
  score: number;
  sharedBasenames: string[];
}

export interface DeprecationEvidence {
  /** 该功能内死 import 源数（跨栈累计） */
  deadImportSources: number;
  /** 命中的死 import 明细（source → 相对文件） */
  deadSources: Array<{ source: string; files: string[] }>;
}

export interface FeatureMapFeature {
  id: string;
  /** 该功能的"挂载名"：source_root 内的目录段 */
  name: string;
  /** 每个侧面的相对文件（相对 source_root） */
  frontend: string[];
  backend: string[];
  shared: string[];
  /** 与它相似的其它功能（双向都在两侧各自体现） */
  similar: SimilarFeatureLink[];
  /** 功能内"重复实现"家族：共享姓名前缀簇（derive_*、*_ops、*_verify…），
   *  提示同一功能里存在成族平行实现——典型 AI 重复实现而非扩展的症状。 */
  repeatedFamilies: RepeatedFamily[];
  /** 废弃证据（死 import 聚合） */
  deprecation: DeprecationEvidence;
}

export interface RepeatedFamily {
  /** 家族前缀词根（含分隔符前的 token，如 'derive'、'ops'） */
  root: string;
  /** 命中的文件基名（相对 source_root） */
  files: string[];
}

export interface FeatureMapResult {
  features: FeatureMapFeature[];
  /** 参与切分的源文件数 */
  scannedFiles: number;
  /** 规则说明（供报告 / 人审） */
  limitations: string[];
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', '.next', 'out', 'build', 'target',
  'venv', '.venv', '__pycache__', 'coverage', '.cache',
]);

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|go|py)$/;

/** 副作用：确定 source_root 下的相对文件列表（语言无关，扫描源文件）。 */
export function scanSourceFiles(sourceRoot: string): string[] {
  const root = path.resolve(sourceRoot);
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) walk(path.join(dir, ent.name), path.join(rel, ent.name));
        continue;
      }
      if (SOURCE_EXT.test(ent.name)) out.push(path.join(rel, ent.name).replace(/\\/g, '/'));
    }
  };
  walk(root, '');
  return out;
}

/** 文件相对路径 → 功能 id：取 source_root 下首层目录段；无目录段 → 'root' */
export function featureIdOf(rel: string): string {
  const parts = rel.split('/');
  return parts.length > 1 ? parts[0] : 'root';
}

/** 层 → 前端/后端/通用 */
export function sideOfLayer(layer: string): FeatureSide {
  if (layer === 'ui') return 'frontend';
  if (['api', 'data', 'service', 'middleware', 'entry'].includes(layer)) return 'backend';
  return 'shared'; // utility/config/types/test/core
}

function basename(rel: string): string {
  return rel.split('/').pop() ?? rel;
}

/** 提取文件基名的"家族词根"：首段分离符前的 token（derive_chain → 'derive'；_ops? 用词根配对）。
 * 取第一段（下划线/连字符/其他分隔符前的长于2字符的 token）。 */
function familyRoot(base: string): string | null {
  const stem = base.replace(/\.[a-z0-9]+$/i, '');
  const m = stem.match(/^([A-Za-z][A-Za-z0-9]*)[_-]/);
  return m ? m[1].toLowerCase() : null;
}

/** 功能内聚类"重复实现"家族：同词根的基名 >=3 个 → 一族（derive_*、*_ops、*_verify、*_test…）。
 * 排除纯测试文件族（*_test / *.test.* / *_spec）——测试成族是正常，不当作重复实现。 */
function detectRepeatedFamilies(rels: string[]): RepeatedFamily[] {
  const byRoot = new Map<string, string[]>();
  for (const rel of rels) {
    const base = basename(rel);
    if (/_\.test\./.test(base) || /\.test\./.test(base) || /_spec\./.test(base)) continue;
    const root = familyRoot(base);
    if (!root) continue;
    const arr = byRoot.get(root);
    if (arr) arr.push(base);
    else byRoot.set(root, [base]);
  }
  return [...byRoot.entries()]
    .filter(([, files]) => files.length >= 3)
    .map(([root, files]) => ({ root, files: [...files].sort() }))
    .sort((a, b) => b.files.length - a.files.length);
}

/**
 * 计算功能图。纯计算，不落盘；返回可渲染的 FeatureMapResult。
 */
export function buildFeatureMap(opts: FeatureMapOptions): FeatureMapResult {
  const proj = path.resolve(opts.project_dir);
  const sourceRoot = path.resolve(opts.source_root ?? proj);
  const rels = scanSourceFiles(sourceRoot);

  // 1) 收集既有的废弃证据（TS/Go 死 import + py 死 import），文件→功能下钻
  const deadBySource = new Map<string, string[]>();
  const collectDead = (deadList: Array<{ source: string; files: string[] }>): void => {
    for (const d of deadList) {
      const list = deadBySource.get(d.source) ?? [];
      for (const f of d.files) {
        const abs = path.isAbsolute(f) ? path.resolve(f) : path.resolve(proj, f);
        const rel = path.relative(sourceRoot, abs).replace(/\\/g, '/');
        if (!rel.startsWith('..') && !list.includes(rel)) list.push(rel);
      }
      deadBySource.set(d.source, list);
    }
  };
  collectDead(detectDeadImports({ project_dir: proj }).dead);
  const pyDead = detectDeadPyImports({ project_dir: proj });
  collectDead(pyDead.dead.map((c) => ({ source: c.source, files: c.files })));

  // 2) 按功能分组文件，标前端/后端/通用
  interface FeatAcc {
    id: string;
    frontend: string[];
    backend: string[];
    shared: string[];
  }
  const featMap = new Map<string, FeatAcc>();
  const ensure = (id: string): FeatAcc => {
    let f = featMap.get(id);
    if (!f) {
      f = { id, frontend: [], backend: [], shared: [] };
      featMap.set(id, f);
    }
    return f;
  };
  for (const rel of rels) {
    const f = ensure(featureIdOf(rel));
    const side = sideOfLayer(matchLayer(rel));
    (side === 'frontend' ? f.frontend : side === 'backend' ? f.backend : f.shared).push(rel);
  }

  // 3) 相似功能：按文件基名重叠聚合
  const baseNameSetOf = (acc: FeatAcc): Set<string> =>
    new Set([...acc.frontend, ...acc.backend, ...acc.shared].map(basename));
  const baseNameSets = new Map<string, Set<string>>();
  for (const [id, acc] of featMap) baseNameSets.set(id, baseNameSetOf(acc));

  const features: FeatureMapFeature[] = [];
  for (const [id, acc] of featMap) {
    // 废弃证据：收集该功能内出现死 import 的 source
    const localDead: Array<{ source: string; files: string[] }> = [];
    for (const [source, files] of deadBySource) {
      const inFeat = files.filter((rel) => featureIdOf(rel) === id);
      if (inFeat.length > 0) localDead.push({ source, files: inFeat });
    }
    const featureRels = [...acc.frontend, ...acc.backend, ...acc.shared];

    const similar: SimilarFeatureLink[] = [];
    const mine = baseNameSets.get(id)!;
    for (const [otherId, otherSet] of baseNameSets) {
      if (otherId === id) continue;
      const sharedBases = [...mine].filter((b) => otherSet.has(b));
      if (sharedBases.length === 0) continue;
      const score = sharedBases.length / Math.min(mine.size, otherSet.size);
      if (score >= 0.2) similar.push({ featureId: otherId, score: Number(score.toFixed(2)), sharedBasenames: sharedBases });
    }

    features.push({
      id,
      name: id,
      frontend: acc.frontend,
      backend: acc.backend,
      shared: acc.shared,
      similar: similar.sort((a, b) => b.score - a.score),
      repeatedFamilies: detectRepeatedFamilies(featureRels),
      deprecation: { deadImportSources: localDead.length, deadSources: localDead },
    });
  }

  const limitations = [
    '功能 = source_root 下首层目录段；直接挂根的文件归入 root（目录即功能的约定，简单可用）',
    '前端/后端 由文件路径的模式启发式分层推得（复用 layer_detect），非运行时确证',
    '相似功能 = 文件基名重叠（>=0.2）的启发式，抓"重复实现"毒征兆；需人确认是否真合并',
    '废弃证据 = 文件级死 import 聚合（复用 TS/Go/py 检测的保守规则）；高死源 ≠ 必废弃',
  ];
  return { features: features.sort((a, b) => a.id.localeCompare(b.id)), scannedFiles: rels.length, limitations };
}