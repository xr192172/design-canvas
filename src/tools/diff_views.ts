/**
 * diff_views：设计视图 vs 实际代码快照（live）的双栏对比
 *
 * 加载同一 feature 的 design 和 live 两个 DSL，逐层比对：
 * - 文件级：新增/删除/修改/不变
 * - 符号级：新增/删除/修改
 * - API 级：新增/删除/修改
 * - 依赖级：新增/删除
 * - 行数变化
 *
 * 输出结构化数据供 LLM 分析 + 可读摘要。
 */

import type { DesignDSL, SemanticFile, Symbol, ExpectedApi } from '../dsl/types.js';
import { getDSL, getLiveFeature } from '../storage.js';

// ──────── 输出类型 ────────

export interface DiffViewsInput {
  /** feature 名 */
  feature: string;
  /** live 视图的 baseDir（可选，默认 dataHome），与 import_project 的 live_dir 一致 */
  live_dir?: string;
}

/** 文件级别变更类型 */
export type FileChangeType = 'added' | 'removed' | 'modified' | 'unchanged';

/** 单个文件的对比结果 */
export interface FileDiff {
  file_id: string;
  path: string;
  change: FileChangeType;
  /** design 侧行数（不存在时为 undefined） */
  design_lines?: number;
  /** live 侧行数（不存在时为 undefined） */
  live_lines?: number;
  /** 符号变更 */
  symbols: SymbolDiff[];
  /** API 变更 */
  apis: ApiDiff[];
  /** design 层标签 */
  design_layer?: string;
  /** live 层标签 */
  live_layer?: string;
}

/** 符号级别变更 */
export interface SymbolDiff {
  name: string;
  kind: string;
  change: 'added' | 'removed' | 'modified';
  /** design 侧行号 */
  design_line?: number;
  /** live 侧行号 */
  live_line?: number;
  /** design 侧签名 */
  design_signature?: string;
  /** live 侧签名 */
  live_signature?: string;
}

/** API 级别变更 */
export interface ApiDiff {
  signature: string;
  change: 'added' | 'removed' | 'modified';
  design_line?: number;
  live_line?: number;
}

/** 对比结果 */
export interface DiffViewsResult {
  /** 可读摘要 */
  message: string;
  /** 结构化数据 */
  data: {
    feature: string;
    /** 设计视图是否存在 */
    design_exists: boolean;
    /** live 视图是否存在 */
    live_exists: boolean;
    /** 总体统计 */
    summary: {
      /** 设计视图文件数 */
      design_files: number;
      /** live 视图文件数 */
      live_files: number;
      /** 新增文件（仅 design 有） */
      added_files: number;
      /** 删除文件（仅 live 有） */
      removed_files: number;
      /** 修改文件（两边都有但内容不同） */
      modified_files: number;
      /** 未变文件 */
      unchanged_files: number;
      /** 设计侧总符号数 */
      design_symbols: number;
      /** live 侧总符号数 */
      live_symbols: number;
      /** 设计侧总 API 数 */
      design_apis: number;
      /** live 侧总 API 数 */
      live_apis: number;
    };
    /** 文件级对比详情 */
    files: FileDiff[];
  };
}

// ──────── 核心逻辑 ────────

/**
 * 执行双视图对比
 */
export function diffViews(input: DiffViewsInput): DiffViewsResult {
  const { feature, live_dir } = input;

  // 1. 加载两个视图
  const design = getDSL(feature);
  const live = getLiveFeature(feature, live_dir);

  // 构建结果
  const designFiles = design?.semantic?.files ?? [];
  const liveFiles = live?.semantic?.files ?? [];

  // 按文件路径建立索引（live 可能用新路径，两边都用 path 匹配）
  const designByPath = new Map<string, SemanticFile>();
  for (const f of designFiles) designByPath.set(f.path, f);

  const liveByPath = new Map<string, SemanticFile>();
  for (const f of liveFiles) liveByPath.set(f.path, f);

  // 所有出现的路径（去重并保持 design 顺序优先）
  const allPaths = new Set<string>();
  for (const f of designFiles) allPaths.add(f.path);
  for (const f of liveFiles) allPaths.add(f.path);

  // 统计计数
  let added = 0, removed = 0, modified = 0, unchanged = 0;
  let designSymbols = 0, liveSymbols = 0;
  let designApis = 0, liveApis = 0;
  const fileDiffs: FileDiff[] = [];

  for (const path of allPaths) {
    const df = designByPath.get(path);
    const lf = liveByPath.get(path);

    // 计数
    if (df) {
      designSymbols += df.symbols?.length ?? 0;
      designApis += (df.expected_apis?.length ?? 0) + (df.actual_apis?.length ?? 0);
    }
    if (lf) {
      liveSymbols += lf.symbols?.length ?? 0;
      liveApis += (lf.expected_apis?.length ?? 0) + (lf.actual_apis?.length ?? 0);
    }

    if (df && !lf) {
      // 仅设计视图有 → 文件被删除（或设计新增但未实现）
      removed++;
      fileDiffs.push({
        file_id: df.id,
        path,
        change: 'removed',
        design_lines: df.lines,
        symbols: (df.symbols ?? []).map((s) => ({
          name: s.name, kind: s.kind,
          change: 'removed' as const,
          design_line: s.line, design_signature: s.signature,
        })),
        apis: (df.expected_apis ?? []).map((a) => ({
          signature: a.signature, change: 'removed' as const,
          design_line: a.line,
        })),
        design_layer: df.layer,
      });
    } else if (!df && lf) {
      // 仅 live 视图有 → 新增文件
      added++;
      fileDiffs.push({
        file_id: lf.id,
        path,
        change: 'added',
        live_lines: lf.lines,
        symbols: (lf.symbols ?? []).map((s) => ({
          name: s.name, kind: s.kind,
          change: 'added' as const,
          live_line: s.line, live_signature: s.signature,
        })),
        apis: (lf.expected_apis ?? []).map((a) => ({
          signature: a.signature, change: 'added' as const,
          live_line: a.line,
        })),
        live_layer: lf.layer,
      });
    } else if (df && lf) {
      // 两边都有 → 比较差异
      const symDiffs = diffSymbols(df.symbols ?? [], lf.symbols ?? []);
      const apiDiffs = diffApis(
        [...(df.expected_apis ?? []), ...(df.actual_apis ?? [])],
        [...(lf.expected_apis ?? []), ...(lf.actual_apis ?? [])],
      );

      const hasChanges = symDiffs.length > 0 || apiDiffs.length > 0 || (df.lines !== lf.lines) || (df.layer !== lf.layer);

      if (hasChanges) {
        modified++;
        fileDiffs.push({
          file_id: df.id,
          path,
          change: 'modified',
          design_lines: df.lines,
          live_lines: lf.lines,
          symbols: symDiffs,
          apis: apiDiffs,
          design_layer: df.layer,
          live_layer: lf.layer,
        });
      } else {
        unchanged++;
        fileDiffs.push({
          file_id: df.id,
          path,
          change: 'unchanged',
          design_lines: df.lines,
          live_lines: lf.lines,
          symbols: [],
          apis: [],
          design_layer: df.layer,
          live_layer: lf.layer,
        });
      }
    }
  }

  // 2. 构建摘要
  const lines: string[] = [
    `══ feature "${feature}" 双视图对比 ══`,
    '',
    `  ─ 概览 ─`,
    `  设计视图: ${design ? `${designFiles.length} 文件` : '不存在'}`,
    `  实际视图: ${live ? `${liveFiles.length} 文件` : '不存在'}`,
    '',
    `  ─ 文件变更 ─`,
    `  新增: ${added} 文件`,
    `  删除: ${removed} 文件`,
    `  修改: ${modified} 文件`,
    `  未变: ${unchanged} 文件`,
    '',
    `  ─ 符号变更 ─`,
    `  设计视图: ${designSymbols} 符号`,
    `  实际视图: ${liveSymbols} 符号`,
    '',
    `  ─ API 变更 ─`,
    `  设计视图: ${designApis} API`,
    `  实际视图: ${liveApis} API`,
  ];

  // 有变更时列出详情
  const changedFiles = fileDiffs.filter((f) => f.change !== 'unchanged');
  if (changedFiles.length > 0) {
    lines.push('', `  ─ 变更详情 ─`);
    for (const f of changedFiles) {
      const changeIcon = f.change === 'added' ? '+' : f.change === 'removed' ? '-' : '~';
      const linesInfo = f.design_lines !== undefined || f.live_lines !== undefined
        ? ` (${f.design_lines ?? '—'} → ${f.live_lines ?? '—'} 行)`
        : '';
      const layerInfo = f.design_layer || f.live_layer
        ? ` [${f.design_layer ?? '—'} → ${f.live_layer ?? '—'}]`
        : '';
      lines.push(`    ${changeIcon} ${f.path}${linesInfo}${layerInfo}`);

      // 符号变更
      for (const s of f.symbols) {
        const sIcon = s.change === 'added' ? '+' : s.change === 'removed' ? '-' : '~';
        const sRange = s.design_line !== undefined
          ? `L${s.design_line}`
          : `L${s.live_line}`;
        const sSig = s.design_signature || s.live_signature
          ? ` — ${s.design_signature ?? s.live_signature}`
          : '';
        lines.push(`      ${sIcon} ${s.kind}: ${s.name} (${sRange})${sSig}`);
      }

      // API 变更
      for (const a of f.apis) {
        const aIcon = a.change === 'added' ? '+' : a.change === 'removed' ? '-' : '~';
        const aLine = a.design_line !== undefined ? `L${a.design_line}` : `L${a.live_line}`;
        lines.push(`      ${aIcon} ${a.signature} (${aLine})`);
      }
    }
  }

  // 无变更
  if (changedFiles.length === 0 && design && live) {
    lines.push('', '  ✓ 设计视图与实际代码快照完全一致');
  }

  // 某侧缺失
  if (!design) {
    lines.push('', '  ⚠ 设计视图不存在 — 请先通过 manage_feature 创建设计，或使用 import_project 生成设计 DSL');
  }
  if (!live) {
    lines.push('', '  ⚠ 实际视图不存在 — 请先运行 import_project(live_only=true) 生成代码快照');
  }

  lines.push('', '  (需要更多细节请使用 query_feature 查询单个文件)');

  return {
    message: lines.join('\n'),
    data: {
      feature,
      design_exists: !!design,
      live_exists: !!live,
      summary: {
        design_files: designFiles.length,
        live_files: liveFiles.length,
        added_files: added,
        removed_files: removed,
        modified_files: modified,
        unchanged_files: unchanged,
        design_symbols: designSymbols,
        live_symbols: liveSymbols,
        design_apis: designApis,
        live_apis: liveApis,
      },
      files: fileDiffs,
    },
  };
}

// ──────── 辅助函数 ────────

/** 比较两个符号列表，返回变更列表 */
function diffSymbols(design: Symbol[], live: Symbol[]): SymbolDiff[] {
  const result: SymbolDiff[] = [];
  const liveByName = new Map<string, Symbol>();
  for (const s of live) liveByName.set(s.name, s);

  const designByName = new Map<string, Symbol>();
  for (const s of design) designByName.set(s.name, s);

  // 找 design 中有的
  for (const ds of design) {
    const ls = liveByName.get(ds.name);
    if (!ls) {
      result.push({ name: ds.name, kind: ds.kind, change: 'removed', design_line: ds.line, design_signature: ds.signature });
    } else if (
      ds.line !== ls.line ||
      ds.end_line !== ls.end_line ||
      ds.signature !== ls.signature ||
      ds.kind !== ls.kind
    ) {
      result.push({
        name: ds.name, kind: ds.kind, change: 'modified',
        design_line: ds.line, live_line: ls.line,
        design_signature: ds.signature, live_signature: ls.signature,
      });
    }
  }

  // 找 live 中新增的
  for (const ls of live) {
    if (!designByName.has(ls.name)) {
      result.push({ name: ls.name, kind: ls.kind, change: 'added', live_line: ls.line, live_signature: ls.signature });
    }
  }

  return result;
}

/** 比较两个 API 列表，返回变更列表 */
function diffApis(design: ExpectedApi[], live: ExpectedApi[]): ApiDiff[] {
  const result: ApiDiff[] = [];
  const liveBySig = new Map<string, ExpectedApi>();
  for (const a of live) liveBySig.set(a.signature, a);

  const designBySig = new Map<string, ExpectedApi>();
  for (const a of design) designBySig.set(a.signature, a);

  // 找 design 中有的
  for (const da of design) {
    const la = liveBySig.get(da.signature);
    if (!la) {
      result.push({ signature: da.signature, change: 'removed', design_line: da.line });
    } else if (da.line !== la.line || da.end_line !== la.end_line) {
      result.push({ signature: da.signature, change: 'modified', design_line: da.line, live_line: la.line });
    }
  }

  // 找 live 中新增的
  for (const la of live) {
    if (!designBySig.has(la.signature)) {
      result.push({ signature: la.signature, change: 'added', live_line: la.line });
    }
  }

  return result;
}