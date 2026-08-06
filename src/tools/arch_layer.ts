/**
 * arch_layer —— 架构分层分析（路线图序号5 + 序号7）
 *
 * 按文件路径的目录段/文件名模式启发式推断每个文件所属架构层，
 * 返回层定义（id/name/description/color/count）+ 每个文件节点的归属。
 *
 * 只读分析为主；可选 persist 把分层结果（arch_layer + layers）写回 feature，
 * 让渲染器据此生成「🎨 图层」着色与图例。复用 layer_detect 的纯函数。
 */

import { getDSL, saveDSL } from '../storage.js';
import { detectArchLayers } from './layer_detect.js';
import type { ArchLayer } from '../dsl/types.js';

export interface ArchLayerInput {
  /** feature 名 */
  feature: string;
  /** 是否把分层结果写回 feature（默认 false，仅分析不落盘） */
  persist?: boolean;
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
  persisted: boolean;
  message: string;
}

export function archLayer(input: ArchLayerInput): ArchLayerResult {
  const { feature, persist = false } = input;
  const dsl = getDSL(feature);
  if (!dsl) {
    throw new Error(`feature "${feature}" 不存在`);
  }

  const layered = detectArchLayers(dsl);

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
  const layers = layered.layers ?? [];
  const layerTotal = layers.reduce((s, l) => s + l.count, 0);

  let persisted = false;
  if (persist) {
    saveDSL(layered, 'arch_layer');
    persisted = true;
  }

  const summary = layers
    .map((l) => `${l.name}(${l.count})`)
    .join(' / ');
  const message =
    `架构分层完成：${fileNodes.length} 个文件节点，命中 ${classified} 个（${layers.length} 层：${summary}；` +
    `未归类 ${fileNodes.length - classified} 个归入核心层）。` +
    (persist ? '已写回 feature，渲染时将显示 🎨 图层着色与图例。' : '未落盘（persist=false）。');

  return {
    feature,
    total_files: fileNodes.length,
    classified,
    layers,
    assignments,
    persisted,
    message,
  };
}