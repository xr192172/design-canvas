/**
 * brick_bag —— 后端数据线路的"积木组装"段（BrickBag 投影）
 *
 * 把 feature_map（文件明细 + 功能聚合 + three 标注）重塑成积木集合（BrickBag）：
 *   每块积木(Brick) = 一个功能；积木内部挂前端/后端/通用文件；积木间通过 peers 交互
 *   （similar 相似虚线 / call 调用实线）。工作台外壳（沙盘/屎山重构/问题清单…）都消费它。
 *
 * 命名说明：本模块聚焦「功能 → 积木集合」的**投影组装**，服务于"可视化协作平台"的
 * 沙盘数据线路，与 Brick Harvest 的拼装区 `assemble_bricks`（把盒内积木搬到新目录）
 * 是两码事——故独立成 brick_bag，避免与既有 MCP 工具语义冲突。
 *
 * 原则（反屎山）：只做"投影 + 组装"，不重造解析/分层/死码/布局；
 *   - files/families/deprecation 直接投影自 feature_map.features；
 *   - peers.similar 直接搬 feature.similar；
 *   - peers.call 由本模块新增的 deriveFeatureCallEdges() 产出：复用 sources 级 import 枚举，
 *     把"文件 import 另一特征下的文件"折算成"积木→积木"的有向调用边（跨功能依赖）。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { FeatureMapResult, FeatureSide } from './feature_map.js';
import { scanSourceFiles } from './feature_map.js';
import { enumerateTsSources } from './detect_dead_imports.js';

export interface BrickFileGroups {
  frontend: string[];
  backend: string[];
  shared: string[];
}

export interface BrickFamily {
  root: string;
  files: string[];
}

export interface BrickDeprecation {
  deadImportSources: number;
  deadSources: Array<{ source: string; files: string[] }>;
}

export interface SimilarPeer {
  kind: 'similar';
  brickId: string;
  score: number;
  sharedBasenames: string[];
}

export interface CallPeer {
  kind: 'call';
  brickId: string;
  /** 'out' = 本积木 import 指向对端；'in' = 对端 import 本积木 */
  direction: 'out' | 'in';
  edges: number;
}

export type BrickPeer = SimilarPeer | CallPeer;

export interface Brick {
  /** 功能 id（= source_root 下首层目录段；根文件 'root'） */
  id: string;
  name: string;
  files: BrickFileGroups;
  /** 主导侧（frontend/backend/shared），用于卡片顶条配色 */
  dominant: FeatureSide;
  families: BrickFamily[];
  deprecation: BrickDeprecation;
  peers: BrickPeer[];
  /** 该积木内总文件数（卡片大小权重） */
  total: number;
}

/** 有向调用边（from 积木 → to 积木） */
export interface FeatureCallEdges {
  from: string;
  to: string;
  count: number;
}

export interface BrickBag {
  bricks: Brick[];
  /** 跨功能有向调用边（经去重在 peers 上体现；可空） */
  call_edges: FeatureCallEdges[];
  meta: {
    project_dir: string;
    source_root: string;
    scanned_files: number;
    langs: string[];
  };
  limitations: string[];
}

const sideCmp: Record<FeatureSide, number> = { frontend: 0, backend: 1, shared: 2 };

/**
 * 投影 + 相似边：由 feature_map 组装积木集合（纯计算，不落盘）。
 * call 边不在此步（见 deriveFeatureCallEdges / assembleBrickBagWithCall）。
 */
export function assembleBrickBag(featureMap: FeatureMapResult): BrickBag {
  const bricks: Brick[] = featureMap.features.map((f) => {
    const files = { frontend: f.frontend, backend: f.backend, shared: f.shared };
    const total = f.frontend.length + f.backend.length + f.shared.length;
    const dominant: FeatureSide =
      f.frontend.length > f.backend.length && f.frontend.length >= f.shared.length
        ? 'frontend'
        : f.backend.length > f.frontend.length && f.backend.length >= f.shared.length
          ? 'backend'
          : 'shared';

    const peers: BrickPeer[] = f.similar.map(
      (s): SimilarPeer => ({
        kind: 'similar',
        brickId: s.featureId,
        score: s.score,
        sharedBasenames: s.sharedBasenames,
      }),
    );

    return {
      id: f.id,
      name: f.name,
      files,
      dominant,
      families: f.repeatedFamilies.map((r) => ({ root: r.root, files: r.files })),
      deprecation: {
        deadImportSources: f.deprecation.deadImportSources,
        deadSources: f.deprecation.deadSources.map((d) => ({ source: d.source, files: d.files })),
      },
      peers,
      total,
    };
  });

  return {
    bricks,
    call_edges: [],
    meta: {
      project_dir: featureMap.meta.project_dir,
      source_root: featureMap.meta.source_root,
      scanned_files: featureMap.meta.scanned_files,
      langs: featureMap.meta.langs,
    },
    limitations: [...featureMap.limitations],
  };
}

/** 带 call 边的完整组装：再加一层跨功能调用边，写回 peers。 */
export function assembleBrickBagWithCall(featureMap: FeatureMapResult): BrickBag {
  const bag = assembleBrickBag(featureMap);
  const edges = deriveFeatureCallEdges(featureMap);
  bag.call_edges = edges;

  const brickById = new Map(bag.bricks.map((b) => [b.id, b]));
  const outAgg = new Map<string, Map<string, number>>();
  const inAgg = new Map<string, Map<string, number>>();
  for (const e of edges) {
    if (!outAgg.has(e.from)) outAgg.set(e.from, new Map());
    outAgg.get(e.from)!.set(e.to, (outAgg.get(e.from)!.get(e.to) ?? 0) + e.count);
    if (!inAgg.has(e.to)) inAgg.set(e.to, new Map());
    inAgg.get(e.to)!.set(e.from, (inAgg.get(e.to)!.get(e.from) ?? 0) + e.count);
  }

  for (const b of bag.bricks) {
    const outs = outAgg.get(b.id);
    if (outs) {
      for (const [to, count] of outs) {
        if (!brickById.has(to)) continue;
        if (b.peers.some((p) => p.brickId === to)) continue; // similar 已有，不重复
        b.peers.push({ kind: 'call', brickId: to, direction: 'out', edges: count });
      }
    }
    const ins = inAgg.get(b.id);
    if (ins) {
      for (const [from, count] of ins) {
        if (!brickById.has(from)) continue;
        if (b.peers.some((p) => p.brickId === from)) continue;
        b.peers.push({ kind: 'call', brickId: from, direction: 'in', edges: count });
      }
    }
  }
  // 稳定排序：similar 在前，call 按边数降序
  for (const b of bag.bricks) {
    b.peers.sort((x, y) => {
      const rx = x.kind === 'similar' ? 0 : 1;
      const ry = y.kind === 'similar' ? 0 : 1;
      if (rx !== ry) return rx - ry;
      if (x.kind === 'call' && y.kind === 'call') return y.edges - x.edges;
      return 0;
    });
  }
  return bag;
}

/**
 * 跨功能调用边：扫描 source_root 下源文件，对 TS/JS 复用 enumerateTsSources，
 * 把"相对 import 指向的同一工程内文件"折算到其归属积木 → 有向边（from import 方 → to 目标）。
 * 说明：仅工程内相对 import 参与；裸包名(如 axios)跨功能不可解析故跳过；
 * go/py 暂不参与 call 边（本项目对应 .ts 用 TS 枚举，limitations 已注明）。
 */
export function deriveFeatureCallEdges(featureMap: FeatureMapResult): FeatureCallEdges[] {
  const sourceRoot = featureMap.meta.source_root;
  const rels = scanSourceFiles(sourceRoot);
  const fileToFeature = new Map(rels.map((r) => [r, featureIdOf(r)]));
  const acc = new Map<string, number>();
  const key = (from: string, to: string): string => `${from}\u0001${to}`;

  for (const rel of rels) {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(rel)) continue;
    let src: string;
    try {
      src = fs.readFileSync(path.join(sourceRoot, ...rel.split('/')), 'utf-8');
    } catch {
      continue;
    }
    const fromFeature = fileToFeature.get(rel);
    if (!fromFeature) continue;
    const dir = rel.split('/').slice(0, -1).join('/');

    for (const spec of enumerateTsSources(src)) {
      if (!spec.startsWith('.') && !spec.startsWith('/')) continue; // 非工程内相对 import
      const targetRel = resolveSpecifier(sourceRoot, dir, spec);
      const toFeature = targetRel ? fileToFeature.get(targetRel) : undefined;
      if (!toFeature || toFeature === fromFeature) continue;
      const k = key(fromFeature, toFeature);
      acc.set(k, (acc.get(k) ?? 0) + 1);
    }
  }

  const edges: FeatureCallEdges[] = [];
  for (const [k, count] of acc) {
    const i = k.indexOf('\u0001');
    edges.push({ from: k.slice(0, i), to: k.slice(i + 1), count });
  }
  edges.sort((a, b) => b.count - a.count || (a.from < b.from ? -1 : 1));
  return edges;
}

function featureIdOf(rel: string): string {
  const parts = rel.split('/');
  return parts.length > 1 ? parts[0] : 'root';
}

/** 解析 './x'/'../x' → 相对 source_root 的路径（补/换扩展名），失败返回 undefined。
 * 兼容 ESM-TS 风格：specifier 常以 '.js' 结尾（映射到 .ts 源）。 */
function resolveSpecifier(sourceRoot: string, dir: string, spec: string): string | undefined {
  const rel = spec.startsWith('/') ? spec.slice(1) : path.posix.normalize(path.posix.join(dir, spec));
  const toAbs = (r: string): string => path.join(sourceRoot, ...r.split('/'));
  const srcExts = ['ts', 'tsx', 'js', 'jsx', 'cjs', 'mjs', 'cts', 'mts'];
  // 若已带扩展名，先剥掉，再作为"无扩展名"统一尝试（append + replace 两种）
  const base = rel.replace(/\.[a-z0-9]+(?:\.[a-z0-9]+)?$/i, '');
  const stripAppend = (noExt: string): string => {
    for (const ext of srcExts) {
      const withExt = `${noExt}.${ext}`;
      if (fs.existsSync(toAbs(withExt))) return withExt;
    }
    return '';
  };
  const hit = stripAppend(base);
  if (hit) return hit;
  for (const ext of srcExts) {
    const idx = `${base}/index.${ext}`;
    if (fs.existsSync(toAbs(idx))) return idx;
  }
  return undefined;
}