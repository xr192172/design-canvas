/**
 * impact_analyzer —— 影响面分析（诊断流水线第 4 步）
 *
 * 复用既有 diffImpact（src/tools/diff_impact.ts 的三类边影响图），把
 * 根因候选文件当作"变更源"做 callers 方向追溯，产出诊断语境下的影响面：
 *   - affected_files：波及文件（谁依赖根因所在文件）
 *   - affected_symbols：波及符号明细
 *   - dsl_contract_hits：波及符号撞上 DSL 语义层 API（设计契约被波及，优先复核）
 *
 * 只读，不改任何缓存/DSL。
 */

import { diffImpact } from '../tools/diff_impact.js';
import type { Impact } from './contract.js';

export interface ImpactInput {
  project_dir: string;
  /** 根因候选文件（相对项目根） */
  root_file: string;
  max_depth?: number;
}

export function analyzeImpact(input: ImpactInput): Impact {
  const { project_dir, root_file, max_depth = 3 } = input;
  const res = diffImpact({ project_dir, changed: [root_file], direction: 'callers', max_depth });
  return {
    affected_files: res.impacted_files.map((f) => ({
      path: f.path,
      reason: f.via_edges.length > 0 ? f.via_edges.join('+') : (f.direct ? 'direct' : 'unknown'),
      depth: f.depth,
      direct: f.direct,
    })),
    affected_symbols: res.impacted_symbols.map((s) => ({
      name: s.qualified_name,
      file_path: s.file_path,
      start_line: s.start_line,
      via_edge: s.via_edge,
    })),
    dsl_contract_hits: res.dsl_contract_hits.map((h) => `${h.path} [${h.dsl_node_id}] ${h.api}`),
  };
}
