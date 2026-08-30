/**
 * diff_views：设计视图 vs 实际代码快照（live）的双栏对比 + 三方对比
 *
 * 加载同一 feature 的 baseline / design / live 三个 DSL：
 * - baseline：契约创立时刻的 fork 快照（import_project 首次写 live 时锚定），即 Git 共同祖先
 * - design：设计视图（意图）
 * - live：实际代码快照（实现）
 *
 * 逐层比对（baseline 存在时升级为三方对比）：
 * - 文件级：新增/删除/修改/不变
 * - 符号级：新增/删除/修改
 * - API 级：新增/删除/修改
 * - 依赖级：新增/删除
 * - 行数变化
 *
 * 三方对比语义（Git 三路 merge 的 DSL 版）：
 * - baseline → design = 意图增量（intent delta）
 * - baseline → live   = 实现增量（implement delta）
 * - 两侧都改动且结果不一致 = 冲突，交 LLM 读 diff 裁决
 *
 * 输出结构化数据供 LLM 分析 + 可读摘要。
 */

import type { DesignDSL, SemanticFile, Symbol, ExpectedApi, Edge, NodeDecision, DecisionHistoryEntry } from '../dsl/types.js';
import { getDSL, getLiveFeature, getBaselineFeature, getArchiveEntryByPath } from '../storage.js';

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

/** 依赖边变更（边级 diff：结构塌方可视化） */
export interface EdgeDiff {
  /** 源节点 id（文件） */
  from: string;
  /** 目标节点 id（文件） */
  to: string;
  /** removed=设计有/实际无（结构塌方）；added=实际新增依赖 */
  change: 'added' | 'removed';
}

/**
 * 三方对比中单个文件的状态（Git 三路 merge 语义的 DSL 版）
 * - added：仅设计新增，尚未实现（baseline 无 / design 有 / live 无）
 * - implemented：设计新增且已实现（两侧一致）
 * - removed：设计删除、代码仍在（设计撤销）
 * - deleted_from_live：实现删除、设计仍在（结构塌方）
 * - design_only：仅设计改动（意图增量，待同步到实现）
 * - live_only：仅实现改动（实现增量/fix，待回填设计）；含「实现新增未登记」
 * - conflict：两侧都改动且结果不一致 → 需 LLM 读 diff 裁决
 * - converged：两侧都改动但结果一致（已收敛，可直接采用）
 * - unchanged：相对基线无变化
 */
export type ThreeWayState =
  | 'added'
  | 'implemented'
  | 'removed'
  | 'deleted_from_live'
  | 'design_only'
  | 'live_only'
  | 'conflict'
  | 'converged'
  | 'unchanged';

/** 决策卡上下文（供 LLM 裁决 diff 时的一手资料） */
export interface DecisionCardRef {
  /** 结论 */
  summary: string;
  /** 理由 */
  rationale?: string;
  /** 生效状态 */
  status?: string;
  /** 功能线 */
  thread?: string;
  /** 自由标签 */
  tags?: string[];
  /** 版本栈（旧决策） */
  history?: DecisionHistoryEntry[];
}

/** 三方对比中单个文件的详情 */
export interface ThreeWayFile {
  path: string;
  state: ThreeWayState;
  baseline_lines?: number;
  design_lines?: number;
  live_lines?: number;
  /** 意图增量（baseline→design）的符号/API 变更 */
  intent_symbols: SymbolDiff[];
  intent_apis: ApiDiff[];
  /** 实现增量（baseline→live）的符号/API 变更 */
  implement_symbols: SymbolDiff[];
  implement_apis: ApiDiff[];
  /** 决策卡上下文：基线侧=当初为什么这么定；设计侧=现在为什么改（文件级 Node.decision） */
  baseline_decision?: DecisionCardRef;
  design_decision?: DecisionCardRef;
  /** 符号级决策卡（有卡的符号名 → 卡），挂函数/API 上，逐符号对齐 diff */
  symbol_decisions?: Record<string, DecisionCardRef>;
  /** 归档关联（下线库历史研究材料：以前弃用过没 / 合并去向） */
  archive?: { retire_reason?: string; merged_into?: string; archived_at?: string };
}

/** 三方对比统计 */
export interface ThreeWaySummary {
  unchanged: number;
  /** 仅设计新增，尚未实现 */
  added: number;
  /** 设计新增且已实现 */
  implemented: number;
  /** 设计删除、代码仍在 */
  removed: number;
  /** 实现删除、设计仍在（结构塌方） */
  deleted_from_live: number;
  /** 仅设计改动（意图增量） */
  design_only: number;
  /** 仅实现改动（实现增量/fix） */
  live_only: number;
  /** 两侧都改动且不一致 → 需裁决 */
  conflict: number;
  /** 两侧都改动但结果一致 */
  converged: number;
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
    /** 基线视图（契约创立时刻的 fork）是否存在 */
    baseline_exists: boolean;
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
      /** 新增依赖边数（仅设计无） */
      added_edges: number;
      /** 删除依赖边数（仅实际无，结构塌方） */
      removed_edges: number;
    };
    /** 文件级对比详情 */
    files: FileDiff[];
    /** 依赖边级对比（两视图共有的文件节点之间的依赖变化） */
    edges: EdgeDiff[];
    /** 三方对比（baseline 存在时）详情 */
    three_way?: {
      /** 基线视图文件数 */
      baseline_files: number;
      summary: ThreeWaySummary;
      files: ThreeWayFile[];
    };
  };
}

// ──────── 核心逻辑 ────────

/**
 * 执行双视图对比（baseline 存在时升级为三方对比）
 */
export function diffViews(input: DiffViewsInput): DiffViewsResult {
  const { feature, live_dir } = input;

  // 1. 加载三个视图（baseline 与 live 同目录归位：baseDir = live_dir）
  const design = getDSL(feature);
  const live = getLiveFeature(feature, live_dir);
  const baseline = getBaselineFeature(feature, live_dir);

  // 构建结果
  const designFiles = design?.semantic?.files ?? [];
  const liveFiles = live?.semantic?.files ?? [];
  const baselineFiles = baseline?.semantic?.files ?? [];

  // 按文件路径建立索引（live 可能用新路径，两边都用 path 匹配）
  const designByPath = new Map<string, SemanticFile>();
  for (const f of designFiles) designByPath.set(f.path, f);

  const liveByPath = new Map<string, SemanticFile>();
  for (const f of liveFiles) liveByPath.set(f.path, f);

  const baselineByPath = new Map<string, SemanticFile>();
  for (const f of baselineFiles) baselineByPath.set(f.path, f);

  // 所有出现的路径（去重并保持 design 顺序优先）
  const allPaths = new Set<string>();
  for (const f of designFiles) allPaths.add(f.path);
  for (const f of liveFiles) allPaths.add(f.path);
  for (const f of baselineFiles) allPaths.add(f.path);

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

  // 2. 三方对比（baseline 存在时）：Git 三路 merge 语义 ——
  //    baseline→design=意图增量，baseline→live=实现增量，两侧都动且不一致=冲突
  const threeWay: ThreeWayFile[] = [];
  const twSummary: ThreeWaySummary = {
    unchanged: 0, added: 0, implemented: 0, removed: 0,
    deleted_from_live: 0, design_only: 0, live_only: 0, conflict: 0, converged: 0,
  };
  if (baseline) {
    // 视图整体缺失时的退化语义：
    // - 无设计视图（"没有设计 DSL 的项目"）：退化为「基线→实现」的实现增量
    // - 无实现视图（纯设计 DSL）：退化为「基线→设计」的意图增量
    const designAbsent = !design;
    const liveAbsent = !live;
    for (const path of allPaths) {
      const base = baselineByPath.get(path);
      const des = designByPath.get(path);
      const liv = liveByPath.get(path);

      const desChanged =
        fileChanged(base, des) ||
        fileDecisionChanged(baseline, design, path, base?.id, des?.id) ||
        symbolsDecisionChanged(base, des);
      const livChanged =
        fileChanged(base, liv) ||
        fileDecisionChanged(baseline, live, path, base?.id, liv?.id) ||
        symbolsDecisionChanged(base, liv);
      const desEqLiv = !fileChanged(des, liv) && !symbolsDecisionChanged(des, liv);

      let state: ThreeWayState;
      if (designAbsent) {
        if (!base && !liv) state = 'unchanged'; // 仅基线有
        else if (!base && liv) state = 'live_only'; // 实现新增未登记
        else if (base && !liv) state = 'deleted_from_live'; // 实现删除（结构塌方）
        else state = livChanged ? 'live_only' : 'unchanged';
      } else if (liveAbsent) {
        if (!base && !des) state = 'unchanged'; // 仅基线有
        else if (!base && des) state = 'added'; // 设计新增未实现
        else if (base && !des) state = 'removed'; // 设计删除
        else state = desChanged ? 'design_only' : 'unchanged';
      } else if (base && des && liv) {
        // 三方都有 → 按「谁动了」分类
        if (!desChanged && !livChanged) state = 'unchanged';
        else if (desChanged && !livChanged) state = 'design_only';
        else if (!desChanged && livChanged) state = 'live_only';
        else if (desEqLiv) state = 'converged';
        else state = 'conflict';
      } else if (!base && des && !liv) {
        state = 'added';
      } else if (!base && des && liv) {
        state = desEqLiv ? 'implemented' : 'conflict';
      } else if (!base && !des && liv) {
        state = 'live_only'; // 实现新增未登记
      } else if (base && !des && liv) {
        state = 'removed'; // 设计删除、代码仍在
      } else if (base && des && !liv) {
        state = 'deleted_from_live'; // 结构塌方
      } else {
        state = 'unchanged'; // 仅基线有 / 全无
      }
      twSummary[state]++;

      const tw: ThreeWayFile = {
        path,
        state,
        baseline_lines: base?.lines,
        design_lines: des?.lines,
        live_lines: liv?.lines,
        intent_symbols: diffSymbols(base?.symbols ?? [], des?.symbols ?? []),
        intent_apis: diffApis(
          [...(base?.expected_apis ?? []), ...(base?.actual_apis ?? [])],
          [...(des?.expected_apis ?? []), ...(des?.actual_apis ?? [])],
        ),
        implement_symbols: diffSymbols(base?.symbols ?? [], liv?.symbols ?? []),
        implement_apis: diffApis(
          [...(base?.expected_apis ?? []), ...(base?.actual_apis ?? [])],
          [...(liv?.expected_apis ?? []), ...(liv?.actual_apis ?? [])],
        ),
        // 决策卡上下文（LLM 裁决的一手资料）：
        // - 基线卡=当初为什么这么定；设计卡=现在为什么改
        // - 符号卡=挂函数/API 上的决策（基线+设计合并，设计覆盖同名）
        baseline_decision: fileDecisionRef(baseline, path, base?.id),
        design_decision: fileDecisionRef(design, path, des?.id),
        symbol_decisions: (() => {
          const merged = { ...symbolDecisionRefs(baseline, path), ...symbolDecisionRefs(design, path) };
          return Object.keys(merged).length > 0 ? merged : undefined;
        })(),
        // 归档关联：删除类状态时查下线库（以前弃用过没 / 合并去向）
        archive: getArchiveRef(feature, path, state, live_dir),
      };
      threeWay.push(tw);
    }
  }

  // 3. 边级 diff（结构塌方可视化）：仅比较两视图共有的文件节点之间的依赖边，
  //    避免「功能聚合视图 vs 文件视图」或「容器边」等 id 空间不一致造成的噪音。
  const designFileIds = new Set(designFiles.map((f) => f.id));
  const liveFileIds = new Set(liveFiles.map((f) => f.id));
  const edgeDiffs = diffEdges(
    design?.geometry?.edges ?? [],
    live?.geometry?.edges ?? [],
    designFileIds,
    liveFileIds,
  );
  let addedEdges = 0, removedEdges = 0;
  for (const d of edgeDiffs) {
    if (d.change === 'added') addedEdges++;
    else removedEdges++;
  }

  // 4. 构建摘要
  const lines: string[] = [
    `══ feature "${feature}" 视图对比 ══`,
    '',
    `  ─ 概览 ─`,
    `  设计视图: ${design ? `${designFiles.length} 文件` : '不存在'}`,
    `  实际视图: ${live ? `${liveFiles.length} 文件` : '不存在'}`,
    `  基线视图: ${baseline ? `${baselineFiles.length} 文件（契约创立时刻 fork）` : '不存在（首次导入后自动锚定）'}`,
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
    '',
    `  ─ 依赖边变更 ─`,
    `  新增: ${addedEdges} 边`,
    `  删除: ${removedEdges} 边（结构塌方）`,
  ];

  // 三方对比摘要（baseline 存在时）
  if (baseline) {
    const tw = twSummary;
    lines.push(
      '',
      `  ─ 三方对比（基线 → 意图 / 实现）─`,
      `  意图增量（基线→设计）: ${tw.design_only} 文件设计改动 + ${tw.added} 新增未实现`,
      `  实现增量（基线→实现）: ${tw.live_only} 文件实现改动 + ${tw.implemented} 新增已实现`,
      `  冲突待裁决: ${tw.conflict} 文件（两侧都动且不一致）`,
      `  已收敛: ${tw.converged} 文件 · 一致未动: ${tw.unchanged} 文件 · 设计撤销 ${tw.removed} · 实现塌方 ${tw.deleted_from_live}`,
    );
  }

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
  if (changedFiles.length === 0 && edgeDiffs.length === 0 && design && live && twSummary.conflict === 0) {
    lines.push('', '  ✓ 设计视图与实际代码快照完全一致');
  }

  // 边级变更详情（结构塌方高优先级列出）
  if (edgeDiffs.length > 0) {
    lines.push('', `  ─ 依赖边变更 ─`);
    for (const d of edgeDiffs) {
      const icon = d.change === 'added' ? '+' : '-';
      lines.push(`    ${icon} ${d.from} → ${d.to}${d.change === 'removed' ? '（结构塌方）' : ''}`);
    }
  }

  // 三方冲突详情（交 LLM 读 diff 裁决：设计侧 vs 实现侧各自相对基线的增量）
  if (baseline) {
    const conflicts = threeWay.filter((f) => f.state === 'conflict');
    if (conflicts.length > 0) {
      lines.push('', `  ─ 冲突待裁决（两侧都相对基线改动且不一致）─`);
      for (const f of conflicts) {
        const ln = `(基线 ${f.baseline_lines ?? '—'} 行 → 设计 ${f.design_lines ?? '—'} / 实现 ${f.live_lines ?? '—'} 行)`;
        lines.push(`    ~ ${f.path} ${ln}`);
        const emit = (tag: string, syms: SymbolDiff[], apis: ApiDiff[]) => {
          for (const s of syms) {
            const icon = s.change === 'added' ? '+' : s.change === 'removed' ? '-' : '~';
            const sig = s.design_signature || s.live_signature ? ` — ${s.design_signature ?? s.live_signature}` : '';
            lines.push(`        ${tag} ${icon} ${s.kind}: ${s.name}${sig}`);
          }
          for (const a of apis) {
            const icon = a.change === 'added' ? '+' : a.change === 'removed' ? '-' : '~';
            lines.push(`        ${tag} ${icon} ${a.signature}`);
          }
        };
        emit('[设计]', f.intent_symbols, f.intent_apis);
        emit('[实现]', f.implement_symbols, f.implement_apis);
      }
    }
  }

  // 决策卡依据（LLM 裁决的一手资料）：列出三方对比中有决策卡的文件的决策上下文
  if (baseline) {
    const withDecisions = threeWay.filter(
      (f) => f.baseline_decision || f.design_decision || (f.symbol_decisions && Object.keys(f.symbol_decisions).length > 0) || f.archive,
    );
    if (withDecisions.length > 0) {
      lines.push('', `  ─ 决策卡依据（裁决的一手资料：基线卡=当初为何这么定 / 设计卡=现在为何改 / 归档=历史弃用）─`);
      for (const f of withDecisions) {
        lines.push(`    ${f.state} ${f.path}`);
        if (f.baseline_decision) {
          const st = f.baseline_decision.status ? ` (${f.baseline_decision.status})` : '';
          lines.push(`        [基线卡] ${f.baseline_decision.summary}${st} — 当初为何这么定`);
        }
        if (f.design_decision) {
          lines.push(`        [设计卡] ${f.design_decision.summary} — 现在为何改`);
        }
        for (const [sym, card] of Object.entries(f.symbol_decisions ?? {})) {
          lines.push(`        [符号卡] ${sym}: ${card.summary}`);
        }
        if (f.archive) {
          const merged = f.archive.merged_into ? ` → 合并到 ${f.archive.merged_into}` : '';
          const at = f.archive.archived_at ? ` (${f.archive.archived_at.slice(0, 10)})` : '';
          lines.push(`        [归档] 弃用原因: ${f.archive.retire_reason ?? '—'}${merged}${at}`);
        }
      }
    }
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
      baseline_exists: !!baseline,
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
        added_edges: addedEdges,
        removed_edges: removedEdges,
      },
      files: fileDiffs,
      edges: edgeDiffs,
      three_way: baseline
        ? {
            baseline_files: baselineFiles.length,
            summary: twSummary,
            files: threeWay,
          }
        : undefined,
    },
  };
}

// ──────── 辅助函数 ────────

/**
 * 判断两个文件内容是否不同（相对比较用，非严格全等）。
 * 只比较语义相关字段：行数、层级标签、符号、API。两方都不存在视为相同。
 */
function fileChanged(a: SemanticFile | undefined, b: SemanticFile | undefined): boolean {
  if (a === b) return false;
  if (!a || !b) return true;
  if (a.lines !== b.lines || a.layer !== b.layer) return true;
  if (diffSymbols(a.symbols ?? [], b.symbols ?? []).length > 0) return true;
  if (
    diffApis(
      [...(a.expected_apis ?? []), ...(a.actual_apis ?? [])],
      [...(b.expected_apis ?? []), ...(b.actual_apis ?? [])],
    ).length > 0
  ) {
    return true;
  }
  return false;
}

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

/**
 * 边级 diff：比较设计视图与 live 视图的依赖边。
 * 只比较「两端都是两视图共有文件节点」的边，避免容器边 / 非文件节点 / 视图层级不一致造成的噪音。
 * - 设计有 / 实际无 → removed（结构塌方）
 * - 实际有 / 设计无 → added（新增依赖）
 */
function diffEdges(
  design: Edge[],
  live: Edge[],
  designFileIds: Set<string>,
  liveFileIds: Set<string>,
): EdgeDiff[] {
  const key = (e: Edge): string => e.from + '\u0000' + e.to;
  const comparable = (e: Edge): boolean =>
    designFileIds.has(e.from) && designFileIds.has(e.to) && liveFileIds.has(e.from) && liveFileIds.has(e.to);

  const liveKeys = new Set<string>();
  for (const e of live) if (comparable(e)) liveKeys.add(key(e));
  const designKeys = new Set<string>();
  for (const e of design) if (comparable(e)) designKeys.add(key(e));

  const result: EdgeDiff[] = [];
  for (const e of design) {
    if (comparable(e) && !liveKeys.has(key(e))) {
      result.push({ from: e.from, to: e.to, change: 'removed' });
    }
  }
  for (const e of live) {
    if (comparable(e) && !designKeys.has(key(e))) {
      result.push({ from: e.from, to: e.to, change: 'added' });
    }
  }
  return result;
}

// ──────── 决策卡上下文辅助 ────────

/** 比较两侧 DSL 某文件的文件级决策卡（node.decision + history）是否变化——决策卡变了就是设计变了 */
function fileDecisionChanged(a: DesignDSL | null, b: DesignDSL | null, path: string, aId?: string, bId?: string): boolean {
  const fa = a?.semantic?.files.find((f) => f.path === path) ?? a?.semantic?.files.find((f) => f.id === aId);
  const fb = b?.semantic?.files.find((f) => f.path === path) ?? b?.semantic?.files.find((f) => f.id === bId);
  if (!fa || !fb) return false; // 存在性由 fileChanged 处理
  const na = a?.geometry?.nodes?.find((n) => n.id === fa.id);
  const nb = b?.geometry?.nodes?.find((n) => n.id === fb.id);
  return (
    JSON.stringify(na?.decision ?? null) !== JSON.stringify(nb?.decision ?? null) ||
    JSON.stringify(na?.decision_history ?? null) !== JSON.stringify(nb?.decision_history ?? null)
  );
}

/** 比较两侧文件符号级决策卡是否变化（挂函数/API 上的卡） */
function symbolsDecisionChanged(fa: SemanticFile | undefined, fb: SemanticFile | undefined): boolean {
  if (!fa || !fb) return false;
  const key = (s: Symbol) => `${s.name}|${JSON.stringify(s.decision ?? null)}`;
  const sa = new Set((fa.symbols ?? []).map(key));
  const sb = new Set((fb.symbols ?? []).map(key));
  if (sa.size !== sb.size) return true;
  for (const k of sa) if (!sb.has(k)) return true;
  return false;
}

/** 取 DSL 中某文件的文件级决策卡（几何层 Node.decision + history，LLM 当初为什么这么定） */
function fileDecisionRef(dsl: DesignDSL | null, filePath: string, fileId?: string): DecisionCardRef | undefined {
  const d = dsl?.semantic?.files.find((f) => f.path === filePath) ?? dsl?.semantic?.files.find((f) => f.id === fileId);
  if (!d) return undefined;
  const node = dsl?.geometry?.nodes?.find((n) => n.id === d.id);
  const dec = node?.decision;
  if (!dec) return undefined;
  return {
    summary: dec.summary,
    rationale: dec.rationale,
    status: dec.status,
    thread: dec.thread,
    tags: dec.tags,
    history: node?.decision_history,
  };
}

/** 收集 DSL 中某文件的符号级决策卡（挂函数/API 上的卡，symbol → 卡） */
function symbolDecisionRefs(dsl: DesignDSL | null, filePath: string): Record<string, DecisionCardRef> {
  const out: Record<string, DecisionCardRef> = {};
  const f = dsl?.semantic?.files.find((x) => x.path === filePath);
  for (const s of f?.symbols ?? []) {
    if (!s.decision) continue;
    out[s.name] = {
      summary: s.decision.summary,
      rationale: s.decision.rationale,
      status: s.decision.status,
      thread: s.decision.thread,
      tags: s.decision.tags,
      history: s.decision_history,
    };
  }
  return out;
}

/** 删除类状态时查下线库归档关联（历史研究材料），无则 undefined */
function getArchiveRef(
  feature: string,
  filePath: string,
  state: ThreeWayState,
  live_dir?: string,
): { retire_reason?: string; merged_into?: string; archived_at?: string } | undefined {
  if (state !== 'removed' && state !== 'deleted_from_live') return undefined;
  const entry = getArchiveEntryByPath(feature, filePath, live_dir);
  if (!entry) return undefined;
  return {
    retire_reason: entry.retire_reason,
    merged_into: entry.merged_into,
    archived_at: entry.archived_at,
  };
}