/**
 * derive_algorithm 工具：函数体 → 算法控制流图（detail 层）
 *
 * 与 derive_detail_chain（D2，函数间调用链）互补：D2 回答"数据经过哪些函数"，
 * 本工具回答"单个函数内部怎么运转"——if 走哪边、for 循环、return 出口，
 * 用于交流学习/团队对齐/项目研究。
 *
 * 结构映射（复用渲染器形状语义）：
 *   entry/exit/return → circle，branch → diamond，loop → hexagon，step → rounded
 *   边 label：是/否（分支）、进入/重复/结束（循环）
 *
 * 幂等：节点前缀 {node_id}__alg_、边前缀 {node_id}__alge_，重跑先清理。
 * LLM 语义标注（label 人话化）由客户端走 update_node，工具不内置。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DesignDSL, Node, Edge } from '../dsl/types.js';
import { getDSL, saveDSL } from '../storage.js';
import { extractFunctionCfg } from './ts_kernel/cfg.js';
import type { CfgNodeKind } from './ts_kernel/cfg.js';

export interface DeriveAlgorithmInput {
  feature: string;
  /** 宿主节点 ID（文件节点） */
  node_id: string;
  /** 目标函数名（必填：算法结构针对单个函数） */
  function: string;
  /** 源文件路径（缺省用 semantic.files[node_id].path） */
  source_path?: string;
  /** 项目根目录（默认 cwd） */
  project_root?: string;
  /** 控制流嵌套最大深度（默认 3，超出折叠为"嵌套逻辑"块） */
  max_depth?: number;
}

export interface DeriveAlgorithmResult {
  message: string;
  nodes_created: number;
  edges_created: number;
  truncated: boolean;
  dead_code: boolean;
  /** 控制流节点分类计数 */
  stats: { steps: number; branches: number; loops: number; returns: number; throws: number; handlers: number };
}

/** CFG 节点类型 → 渲染形状（tone 为语义色，渲染器映射到主题变量：error=红 success=绿 warning=橙）
 *  导出供 derive_chain 跨文件追加复用（外部函数 CFG 同构挂载） */
export const KIND_SHAPE: Record<
  CfgNodeKind,
  { shape: 'circle' | 'diamond' | 'hexagon' | 'rounded'; w: number; h: number; tone?: 'error' | 'success' | 'warning' }
> = {
  entry: { shape: 'circle', w: 140, h: 44 },
  exit: { shape: 'circle', w: 140, h: 44 },
  return: { shape: 'circle', w: 180, h: 48 },
  branch: { shape: 'diamond', w: 220, h: 64 },
  loop: { shape: 'hexagon', w: 220, h: 56 },
  step: { shape: 'rounded', w: 240, h: 52 },
  throw: { shape: 'diamond', w: 220, h: 64, tone: 'error' },
  handler: { shape: 'rounded', w: 220, h: 52, tone: 'success' },
  finally: { shape: 'hexagon', w: 180, h: 48, tone: 'warning' },
};

const COL_GAP = 280;
const ROW_GAP = 104;

export async function deriveAlgorithm(input: DeriveAlgorithmInput): Promise<DeriveAlgorithmResult> {
  const { feature, node_id, function: funcName, max_depth = 3 } = input;
  const projectRoot = input.project_root ? path.resolve(input.project_root) : process.cwd();

  const dsl: DesignDSL | null = getDSL(feature);
  if (!dsl) throw new Error(`feature "${feature}" 不存在，请先 create_feature 或 render_dsl`);
  const host = dsl.geometry.nodes.find((n) => n.id === node_id);
  if (!host) throw new Error(`节点 "${node_id}" 不存在于 feature "${feature}"`);

  // 源文件定位（与 derive_detail_chain 同约定）
  let filePath: string | undefined;
  if (input.source_path) {
    filePath = path.isAbsolute(input.source_path) ? input.source_path : path.join(projectRoot, input.source_path);
  } else {
    const rel = dsl.semantic?.files?.find((f) => f.id === node_id)?.path;
    // semantic path 可能是绝对路径（外部项目回填），直接 join 会在 Windows 拼出怪胎
    if (rel) filePath = path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
  }
  if (!filePath) {
    throw new Error(`节点 "${node_id}" 没有对应源文件（semantic.files 无此 id，且未传 source_path）`);
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`源文件不存在，无法读取: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const cfg = await extractFunctionCfg(filePath, content, funcName, max_depth);
  if (!cfg) {
    throw new Error(
      `未能提取控制流：语言不支持、解析失败或函数 "${funcName}" 不存在于 ${path.basename(filePath)}` +
      `（方法需用裸名；Go 方法、TS method、Python 函数均可）`,
    );
  }

  // 幂等：清理旧的 algorithm 节点/边（不动 D2 的 __s/__chain_ 前缀）
  const nodePrefix = `${node_id}__alg_`;
  const edgePrefix = `${node_id}__alge_`;
  dsl.geometry.nodes = dsl.geometry.nodes.filter((n) => !n.id.startsWith(nodePrefix));
  dsl.geometry.edges = (dsl.geometry.edges ?? []).filter((e) => !e.id.startsWith(edgePrefix));

  // 布局：宿主下方；若已有 D2 链（__s 前缀节点），再下移一行避免重叠
  const hx = host.x ?? 0;
  const hy = host.y ?? 0;
  const hh = host.height ?? 60;
  const hasD2 = dsl.geometry.nodes.some((n) => n.id.startsWith(`${node_id}__s`));
  const baseY = hy + hh + 40 + (hasD2 ? 140 : 0);

  // 折行布局：同 col 超过 MAX_ALG_ROWS 个节点时折到右侧视觉列，
  // 避免长函数（60+ 节点）单列成数千 px 高塔无法浏览
  const MAX_ALG_ROWS = 10;
  const colCount = new Map<number, number>();
  for (const cn of cfg.nodes) colCount.set(cn.col, (colCount.get(cn.col) ?? 0) + 1);
  const colStart = new Map<number, number>();
  let accCols = 0;
  for (const c of [...colCount.keys()].sort((a, b) => a - b)) {
    colStart.set(c, accCols);
    accCols += Math.ceil((colCount.get(c) ?? 0) / MAX_ALG_ROWS);
  }
  const colSeq = new Map<number, number>();

  const newNodes: Node[] = cfg.nodes.map((cn) => {
    const meta = KIND_SHAPE[cn.kind];
    const seq = colSeq.get(cn.col) ?? 0;
    colSeq.set(cn.col, seq + 1);
    const vcol = (colStart.get(cn.col) ?? 0) + Math.floor(seq / MAX_ALG_ROWS);
    const row = seq % MAX_ALG_ROWS;
    const node: Node = {
      id: `${nodePrefix}${cn.id}`,
      x: hx + vcol * COL_GAP,
      y: baseY + row * ROW_GAP,
      width: meta.w,
      height: meta.h,
      label: cn.label,
      layer: 'detail',
      host: node_id,
      style: { shape: meta.shape, ...(meta.tone ? { tone: meta.tone } : {}) },
    };
    const descParts: string[] = [`${cn.kind}${cn.line > 0 ? ` · 源码第 ${cn.line} 行` : ''}`];
    if (cn.condition && cn.condition !== cn.label) descParts.push(`条件：${cn.condition}`);
    node.description = descParts.join('\n');
    return node;
  });

  const newEdges: Edge[] = cfg.edges.map((ce, i) => ({
    id: `${edgePrefix}${i}`,
    from: `${nodePrefix}${ce.from}`,
    to: `${nodePrefix}${ce.to}`,
    label: ce.label,
    layer: 'detail',
  }));

  dsl.geometry.nodes.push(...newNodes);
  dsl.geometry.edges.push(...newEdges);
  saveDSL(dsl);

  const relPath = path.relative(projectRoot, filePath) || path.basename(filePath);
  const kindCount = (k: CfgNodeKind) => cfg.nodes.filter((n) => n.kind === k).length;
  const lines = [
    `已推导算法控制流：feature "${feature}" 节点 ${node_id} 函数 ${funcName}()`,
    `源文件：${relPath}`,
    `结构：${kindCount('step')} 步骤 · ${kindCount('branch')} 分支 · ${kindCount('loop')} 循环 · ${kindCount('return')} return · ${kindCount('throw')} throw · ${kindCount('handler')} handler`,
    ...(cfg.truncated ? [`注意：存在超过 max_depth=${max_depth} 的嵌套块，已折叠为"嵌套逻辑"节点（可调大 max_depth 展开）`] : []),
    ...(cfg.deadCode ? ['注意：return 之后存在不可达语句（dead code），未入图——建议检查源码'] : []),
    '',
    '下一步（LLM 语义标注）：update_node 把 step 节点 label 改为人话步骤名。',
  ];

  return {
    message: lines.join('\n'),
    nodes_created: newNodes.length,
    edges_created: newEdges.length,
    truncated: cfg.truncated,
    dead_code: cfg.deadCode,
    stats: {
      steps: kindCount('step'),
      branches: kindCount('branch'),
      loops: kindCount('loop'),
      returns: kindCount('return'),
      throws: kindCount('throw'),
      handlers: kindCount('handler'),
    },
  };
}
