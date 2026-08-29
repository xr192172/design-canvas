/**
 * arch_layer —— 架构分层分析（路线图序号5 + 序号7）
 *
 * 按文件路径的目录段/文件名模式启发式推断每个文件所属架构层，
 * 返回层定义（id/name/description/color/count）+ 每个文件节点的归属。
 *
 * 打磨（2026-08-29）：
 *   - 分层定义可配置：input.layers 传入自定义 LayerDef[]（如 积木/契约/胶水 三明治），
 *     覆盖内置 9 层。
 *   - 层间违规检测：input.check_violations（默认 true）从 source_root 读代码文件、
 *     轻量解析 import 边 → 按每层 allowed_deps 判定跨层依赖违规，输出
 *     violations（违规清单）+ layer_matrix（层间引用矩阵，供前端可视化）。
 *
 * 只读分析为主；可选 persist 把分层结果（arch_layer + layers）写回 feature，
 * 让渲染器据此生成「🎨 图层」着色与图例。复用 layer_detect 的纯函数。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDSL, saveDSL } from '../storage.js';
import {
  detectArchLayers,
  detectLayerViolations,
  parseImportsLight,
  type LayerDef,
  type ImportEdge,
  type LayerViolation,
} from './layer_detect.js';
import type { ArchLayer } from '../dsl/types.js';

export interface ArchLayerInput {
  /** feature 名 */
  feature: string;
  /** 是否把分层结果写回 feature（默认 false，仅分析不落盘） */
  persist?: boolean;
  /** 自定义分层定义（缺省用内置 9 层） */
  layers?: LayerDef[];
  /** 是否做层间违规检测（默认 true；从 source_root 读代码扫 import 边） */
  check_violations?: boolean;
}

export interface ArchLayerFileAssign {
  /** DSL 文件节点 id */
  id: string;
  /** 节点 label */
  label?: string;
  /** 相对路径（semantic.files[].path 或节点 description） */
  path?: string;
  /** 所属架构层 id */
  arch_layer: string;
}

/** 层间引用矩阵行（from → to 的 import 边计数，不含同层） */
export interface LayerMatrixRow {
  from: string;
  to: string;
  count: number;
}

export interface ArchLayerResult {
  feature: string;
  /** 文件节点总数（type=file） */
  total_files: number;
  /** 命中分层（arch_layer 非 core 兜底）的文件数 */
  classified: number;
  /** 各层定义 + 文件数；含 core 兜底层 */
  layers: ArchLayer[];
  /** 每个文件节点的层归属（供写回/核对） */
  assignments: ArchLayerFileAssign[];
  /** 层间依赖违规（check_violations=false 或代码根不可读时为空） */
  violations: LayerViolation[];
  /** 层间引用矩阵（按引用数降序） */
  layer_matrix: LayerMatrixRow[];
  /** 本功能未覆盖/失败的说明 */
  limitations: string[];
  persisted: boolean;
  message: string;
}

/** 从 source_root 读取一组相对路径文件的源码（读不到的文件跳过） */
async function collectSources(
  sourceRoot: string,
  rels: string[],
): Promise<Array<{ path: string; src: string }>> {
  const out: Array<{ path: string; src: string }> = [];
  for (const rel of rels) {
    try {
      out.push({ path: rel, src: await fs.promises.readFile(path.join(sourceRoot, rel), 'utf-8') });
    } catch {
      // 读不到的文件不参与边构建
    }
  }
  return out;
}

/** 由一组文件源码构建文件级 import 边（相对导入 → 项目内文件） */
export function scanImportEdges(files: Array<{ path: string; src: string }>): ImportEdge[] {
  const byNoExt = new Map<string, string>();
  for (const f of files) {
    const p = f.path.replace(/\\/g, '/');
    byNoExt.set(p.replace(/\.[^.]+$/, ''), p);
  }
  const edges: ImportEdge[] = [];
  for (const f of files) {
    const from = f.path.replace(/\\/g, '/');
    const dir = path.posix.dirname(from);
    for (const target of parseImportsLight(f.src)) {
      const abs = path.posix.normalize(path.posix.join(dir, target));
      const noExt = abs.replace(/\.[^.]+$/, '');
      const hit = byNoExt.get(noExt) ?? byNoExt.get(abs);
      if (hit && hit !== from) edges.push({ from, to: hit, via: target });
    }
  }
  return edges;
}

/** 把文件级 import 边聚合成层间引用矩阵（from 层 → to 层，忽略同层） */
function buildLayerMatrix(edges: ImportEdge[], fileLayers: Record<string, string>): LayerMatrixRow[] {
  const map = new Map<string, number>();
  for (const e of edges) {
    const fl = fileLayers[e.from];
    const tl = fileLayers[e.to];
    if (!fl || !tl || fl === tl) continue;
    const k = `${fl}\u0000${tl}`;
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, count]) => {
      const [from, to] = k.split('\u0000');
      return { from, to, count };
    });
}

export async function archLayer(input: ArchLayerInput): Promise<ArchLayerResult> {
  const { feature, persist = false, layers, check_violations = true } = input;
  const dsl = getDSL(feature);
  if (!dsl) {
    throw new Error(`feature "${feature}" 不存在`);
  }

  const layered = detectArchLayers(dsl, layers);

  // 语义路径 → 文件 id 的反查（给 assignment 补 path）
  const idToPath = new Map<string, string>();
  for (const f of layered.semantic?.files ?? []) {
    if (f.path) idToPath.set(f.id, f.path);
  }

  const fileNodes = layered.geometry.nodes.filter((n) => n.type === 'file');
  const assignments: ArchLayerFileAssign[] = fileNodes.map((n) => ({
    id: n.id,
    label: n.label,
    path: idToPath.get(n.id) ?? n.description,
    arch_layer: n.arch_layer ?? 'core',
  }));

  const classified = assignments.filter((a) => a.arch_layer !== 'core').length;
  const layersOut = layered.layers ?? [];
  const layerTotal = layersOut.reduce((s, l) => s + l.count, 0);

  // ── 层间违规检测（只读，不落盘）──────────────────────────
  let violations: LayerViolation[] = [];
  let layerMatrix: LayerMatrixRow[] = [];
  const limitations: string[] = [];
  if (check_violations && dsl.source_root) {
    const rels = [...new Set(assignments.map((a) => a.path).filter((p): p is string => Boolean(p)))];
    try {
      const files = await collectSources(dsl.source_root, rels);
      const edges = scanImportEdges(files);
      const fileLayers: Record<string, string> = {};
      for (const a of assignments) if (a.path) fileLayers[a.path] = a.arch_layer;
      violations = detectLayerViolations({ defs: layers ?? [], fileLayers, edges });
      layerMatrix = buildLayerMatrix(edges, fileLayers);
    } catch (e) {
      limitations.push(`层间违规检测未完成：${(e as Error).message}`);
    }
  } else if (check_violations) {
    limitations.push('feature 无 source_root，无法扫描 import 边，跳过违规检测');
  }

  let persisted = false;
  if (persist) {
    saveDSL(layered, 'arch_layer');
    persisted = true;
  }

  const summary = layersOut.map((l) => `${l.name}(${l.count})`).join(' / ');
  const violSummary = violations.length
    ? `；层间依赖违规 ${violations.length} 条（如 ${[...new Set(violations.map((v) => `${v.from_layer}→${v.to_layer}`))].slice(0, 3).join('、')}）`
    : '；层间依赖方向合规';
  const message =
    `架构分层完成：${fileNodes.length} 个文件节点，命中 ${classified} 个（${layersOut.length} 层：${summary}；` +
    `未归类 ${fileNodes.length - classified} 个归入核心层）${violSummary}。` +
    (persist ? '已写回 feature，渲染时将显示 🎨 图层着色与图例。' : '未落盘（persist=false）。');

  return {
    feature,
    total_files: fileNodes.length,
    classified,
    layers: layersOut,
    assignments,
    violations,
    layer_matrix: layerMatrix,
    limitations,
    persisted,
    message,
  };
}
