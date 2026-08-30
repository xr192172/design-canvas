/**
 * archive_node：把下线的文件/节点孤立到下线库（archive）。
 *
 * Git 语义：基线是"共同祖先"，下线库是"reflog/存档分支"。
 * 节点下线分两种，都经本工具落地：
 *   - 合并（"下线=两个文件合并了"）：把文件归档，记录 merged_into 指向合并目标；
 *     目标文件 lifecycle.merged_from 记上来源，diff 时 LLM 据 archive 读两边决策卡做决策合并。
 *   - 孤立（真弃用）：归档后不再参与周边联系（从设计 DSL 移除文件/节点/边），
 *     条目挂既往决策卡 + retire_reason，作为历史研究材料。
 *
 * 决策卡"合到一起"不做自动合并——决策是语义的，结构化部分（归档快照 + merged_from
 * 溯源）由本工具落地，summary 重写交 LLM 用 diff 增量 + 归档卡裁决（与三方对比哲学一致）。
 */

import type { DesignDSL } from '../dsl/types.js';
import { getDSL, saveDSL, saveArchiveEntry, getArchiveEntryByPath, type ArchiveEntry } from '../storage.js';

export interface ArchiveNodeInput {
  /** feature 名 */
  feature: string;
  /** 要下线的文件相对路径 */
  file_path: string;
  /** 为什么下线（孤立原因，必填，作为历史研究材料） */
  retire_reason: string;
  /** 若下线是合并（两文件合一），填合并目标文件路径 */
  merged_into?: string;
}

export interface ArchiveNodeResult {
  message: string;
  feature: string;
  archive_id: string;
  file_path: string;
  merged_into?: string;
  archived_decision: { summary?: string; thread?: string } | null;
  removed_from_dsl: boolean;
}

/** 归档一个文件节点：存档 DSL 快照 → 从设计 DSL 移除 → 目标文件记 merged_from */
export function archiveNode(input: ArchiveNodeInput): ArchiveNodeResult {
  const { feature, file_path, retire_reason, merged_into } = input;
  if (!file_path || !retire_reason?.trim()) {
    throw new Error('archive_node 需要 file_path 与 retire_reason（为什么下线，必填）');
  }

  const dsl = getDSL(feature);
  if (!dsl) throw new Error(`feature "${feature}" 不存在`);

  // 重复归档防御：先查归档库（同一文件二次归档 = 操作冲突），再查设计 DSL
  if (getArchiveEntryByPath(feature, file_path)) {
    throw new Error(`文件 "${file_path}" 已归档过，勿重复归档`);
  }

  const file = dsl.semantic?.files.find((f) => f.path === file_path);
  if (!file) throw new Error(`设计 DSL 中不存在文件 "${file_path}"`);

  // 1. 归档：完整 DSL 快照 + 元数据（快照含该文件的决策卡/符号卡，作为历史研究材料）
  const entry: ArchiveEntry = {
    feature,
    file_path,
    dsl: structuredClone(dsl) as DesignDSL,
    retire_reason,
    merged_into,
    archived_at: new Date().toISOString(),
  };
  const archiveId = saveArchiveEntry(entry);

  // 归档的决策卡摘要（文件级卡在几何层 node 上）
  const archivedNode = dsl.geometry.nodes?.find((n) => n.id === file.id);
  const archivedDecision = archivedNode?.decision
    ? { summary: archivedNode.decision.summary, thread: archivedNode.decision.thread }
    : null;

  // 2. 从设计 DSL 移除该文件/节点/边（"不需要和周边有联系"）
  const removedId = file.id;
  const next: DesignDSL = {
    ...dsl,
    semantic: dsl.semantic
      ? { ...dsl.semantic, files: dsl.semantic.files.filter((f) => f.id !== removedId) }
      : undefined,
    geometry: {
      ...dsl.geometry,
      nodes: (dsl.geometry.nodes ?? []).filter((n) => n.id !== removedId),
      edges: (dsl.geometry.edges ?? []).filter((e) => e.from !== removedId && e.to !== removedId),
    },
  };

  // 3. 合并场景：目标文件 lifecycle 记上 merged_from（diff 时 LLM 可据 archive 回溯两边决策卡）
  let mergedTarget: string | undefined = merged_into;
  if (merged_into && next.semantic) {
    const target = next.semantic.files.find((f) => f.path === merged_into);
    if (target) {
      target.lifecycle = {
        status: 'merged',
        merged_into: undefined,
        merged_from: [...(target.lifecycle?.merged_from ?? []), file_path],
        retire_reason,
        changed_at: new Date().toISOString(),
      };
    } else {
      mergedTarget = undefined; // 目标不存在则退化为孤立归档
    }
  }

  saveDSL(next);

  return {
    message: [
      `已把 "${file_path}" 下线归档 → 下线库条目 "${archiveId}"`,
      `  原因: ${retire_reason}`,
      mergedTarget ? `  合并到: ${mergedTarget}（目标 lifecycle.merged_from 已记录来源）` : '  孤立：不再参与周边联系',
      archivedDecision ? `  归档决策卡: ${archivedDecision.summary}${archivedDecision.thread ? ` [${archivedDecision.thread}]` : ''}` : '  （该文件无决策卡）',
      `  归档快照含该文件全部决策卡，diff 时可作裁决依据`,
    ].join('\n'),
    feature,
    archive_id: archiveId,
    file_path,
    merged_into: mergedTarget,
    archived_decision: archivedDecision,
    removed_from_dsl: true,
  };
}
