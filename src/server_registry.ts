/**
 * server_registry：MCP 工具注册表（路线图序号 2 收敛）
 *
 * 只注册主工具（2026-08-17 起旧工具名别名已全部移除，无兼容层）。
 *
 * 设计：
 * - 每个工具定义 = { name, title, description, inputSchema, handler }
 * - handler(args) 返回 MCP content 数组（text + isError）
 * - 主工具走强 schema；explore_code/manage_feature 用宽松 record，内部强校验
 *
 * 主工具 handler 复用现有纯函数（src/tools/*.ts），不重写业务逻辑，因此
 * 500+ 单测（针对纯函数）不受影响。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { collectPendingAlertText, dispatchDslEdit } from './daemon/dispatch.js';
import { renderDsl } from './tools/render_dsl.js';
import { exportSvg, exportMarkdown } from './tools/export.js';
import { deriveMindMap } from './tools/derive_mind_map.js';
import { queryFeature } from './tools/query_feature.js';
import { updateFeature } from './tools/update_feature.js';
import { scaffold } from './tools/scaffold.js';
import { checkStatus } from './tools/status_tools.js';
import { backfillScaffold } from './tools/backfill.js';
import { checkConsistency } from './tools/consistency.js';
import { exploreCode, EXPLORE_ACTIONS } from './tools/explore_code.js';
import { editCode } from './tools/edit_code.js';
import { importProject } from './tools/import_project.js';
import type { ImportProjectInput } from './tools/import_project.js';
import { manageFeature, MANAGE_ACTIONS } from './tools/manage_feature.js';
import { diffViews } from './tools/diff_views.js';
import { archiveNode, listArchive } from './tools/archive_node.js';
import { harvestDecisions } from './tools/harvest_decisions.js';
import { syncContracts } from './tools/sync_contracts.js';
import { harvestClosure } from './tools/harvest_closure.js';
import type { HarvestClosureInput } from './tools/harvest_closure.js';
import { extractContracts } from './tools/extract_contracts.js';
import type { ExtractContractsInput } from './tools/extract_contracts.js';
import { reconcileEffects } from './tools/reconcile_effects.js';
import type { ReconcileEffectsInput } from './tools/reconcile_effects.js';
import { reconcileBrick } from './tools/reconcile_brick.js';
import type { ReconcileBrickInput } from './tools/reconcile_brick.js';
import { searchBricks } from './tools/search_bricks.js';
import type { SearchBricksInput } from './tools/search_bricks.js';
import { assembleBricks } from './tools/assemble_bricks.js';
import { narrateStep } from './tools/narrate_step.js';
import type { NarrateStepInput } from './tools/narrate_step.js';
import type { AssembleBricksInput } from './tools/assemble_bricks.js';
import { buildBrickifyPreview } from './tools/render_sandbox.js';
import { harvestFromUrl } from './tools/harvest_from_url.js';
import type { HarvestFromUrlInput } from './tools/harvest_from_url.js';
import { slimBrick } from './tools/slim_brick.js';
import type { SlimBrickInput } from './tools/slim_brick.js';
import { renameMany, type RenameItem } from './tools/ast_rename.js';
import { renameSymbol } from './tools/rename_symbol.js';
import { renameFile } from './tools/rename_file.js';
import { removeDeadImports, removeDeadImportsWithVerify, type RemoveDeadImportsVerifyOptions } from './tools/remove_dead_imports.js';
import { runRefactorPipeline } from './tools/refactor_pipeline.js';
import { suggestRenames, type SuggestOptions } from './tools/ast_suggest.js';
import { suggestDisambiguations, disambiguationItems } from './tools/similar_names.js';
import { runRefactorJudge } from './tools/refactor_judge.js';
import type { JudgeIssue, JudgeDecision } from './tools/refactor_judge.js';
import { validateReason } from './tools/reason_validator.js';
import type { ReasonEvidenceRef } from './tools/reason_validator.js';
import { loadTraceRecords, buildTraceResolver } from './tools/trace_evidence.js';
import { runDiagnosis, formatDiagnoseText } from './diagnosis/diagnose.js';
import type { DiagnoseInput } from './diagnosis/contract.js';
import { getDSLByView, getLiveDir, getDSL, saveDSL } from './storage.js';
import { resolveCanvasNoteTargets, renderCanvasNotesDigest, markCanvasNotesStatus } from './tools/derive_mind_map.js';
import { decideCanvasNotes } from './tools/llm_decider.js';
import { listProjectDocs, readProjectDoc, matchDocsForTargets, buildDocsPromptBlock, type DocTargetSet } from './tools/project_docs.js';
import { listProvidersMasked, upsertProvider, deleteProvider, getStats, resetStats, testProvider } from './tools/gateway.js';
import { getProjectCacheDb } from './db/db.js';
import { recordDogfoodUsage } from './tools/dogfood_stats.js';
import { queryObserveLog } from './observe/log_query.js';
import { normalizeEvents, judgeEvents, judgeEventsWithLLM, renderJudgeReport } from './observe/judge_service.js';
import { TSComparator, renderTSDiffReport, type TSDLDecl, type TSDiffReport } from './observe/contract.js';
import { rebuildChains } from './observe/chain.js';
import { reconcileChain } from './tools/reconcile_chain.js';
import type { ReconcileChainInput } from './tools/reconcile_chain.js';
import {
  instrumentProject,
  collectTsFiles,
  restoreInstrumented,
  buildProbeLedger,
  saveProbeLedger,
  clearProbeLedger,
  ledgerSummary,
} from './observe/instrument.js';
import path from 'node:path';
import { statSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────
// 陈旧进程检测（版本握手）
// ─────────────────────────────────────────────────────────────

/**
 * 狗食缺陷修复：MCP 进程长驻，dist 重建后进程仍运行旧代码，AI 侧表现为
 * "工具缺失/参数报错却不知原因"（2026-08-18 decisions 查询缺失事件）。
 *
 * 机制：进程加载时记录本文件（dist/server_registry.js）的 mtime；
 * 每次工具调用轻量 stat 比对，dist 更新后在所有返回（含错误）尾部追加
 * 重启警告。警告由 registerAllTools 统一注入（唯一出口，覆盖全部工具；
 * wrap/wrapData 不再各自追加）。开销 = 每调用一次 stat，可忽略。
 */
const SELF_PATH = (() => {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return null; // 异常环境（理论不可达）——禁用检测
  }
})();
const SELF_MTIME_MS: number | null = SELF_PATH ? safeMtimeMs(SELF_PATH) : null;

function safeMtimeMs(p: string): number | null {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 陈旧构建判定（纯函数，可单测）：加载时的 mtime 早于当前 mtime → 进程仍跑旧代码。
 * 任何一侧未知（非编译产物环境）→ 返回空串，静默禁用。
 */
export function staleBuildWarningFor(loadedMtimeMs: number | null, curMtimeMs: number | null): string {
  if (loadedMtimeMs === null || curMtimeMs === null) return '';
  if (curMtimeMs > loadedMtimeMs) {
    return (
      '\n⚠️ STALE BUILD：dist 已在本进程启动后重建，当前响应来自旧代码——' +
      '新增工具/字段/参数可能缺失或报"未知"错误。请重启 design-canvas MCP server 后再执行写操作。'
    );
  }
  return '';
}

/** dist 已更新（进程仍在跑旧代码）时返回重启警告，否则空串。 */
function staleBuildWarning(): string {
  return staleBuildWarningFor(SELF_MTIME_MS, SELF_PATH ? safeMtimeMs(SELF_PATH) : null);
}

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  handler: (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;
}

/** MCP content 输出 */
function textOut(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError };
}

/** 包装一个同步/异步纯函数调用为 handler（统一 try/catch；陈旧构建警告由 registerAllTools 统一注入，避免重复） */
function wrap(
  fn: (args: Record<string, unknown>) => { message: string; data?: unknown } | Promise<{ message: string; data?: unknown }>,
): ToolDef['handler'] {
  return async (args) => {
    try {
      const r = await fn(args);
      return { text: r.message };
    } catch (e) {
      return { text: (e as Error).message, isError: true };
    }
  };
}

/** 同 wrap，但 data 一并序列化进文本（---DATA--- 分隔），避免只回显 message 导致静默丢数据 */
function wrapData(
  fn: (args: Record<string, unknown>) => { message: string; data?: unknown } | Promise<{ message: string; data?: unknown }>,
): ToolDef['handler'] {
  return async (args) => {
    try {
      const r = await fn(args);
      const parts: string[] = [];
      if (r.message) parts.push(r.message);
      if (r.data !== undefined) {
        parts.push('---DATA---');
        parts.push(JSON.stringify(r.data));
      }
      return { text: parts.join('\n') };
    } catch (e) {
      return { text: (e as Error).message, isError: true };
    }
  };
}

// ─────────────────────────────────────────────────────────────
// 8 个主工具 handler
// ─────────────────────────────────────────────────────────────

/** get_dsl：只读查询（复用 queryFeature） */
const getDslHandler = wrap(async (a) => queryFeature(a as never));

/** edit_dsl：统一写操作（复用 updateFeature，Step A 扩展后覆盖更多写动作） */
const editDslHandler = wrap(async (a) => {
  // 视图写护栏：live 是代码快照，只能由 import/watch 重建，禁止手改
  if (a.view === 'live') {
    throw new Error(
      '实际视图（view=live）是代码快照，只读，请勿手改。要改请用 view=design（设计视图）；' +
        '要重建实际视图请用 import_project 工具（全量导入），增量监听用 explore_code action=watch。',
    );
  }
  // 活文档：变更原因四层校验（L1-L4），不通过拒绝写入
  const reason = (a.reason as string | undefined) ?? '';
  const evidence = (a.evidence as ReasonEvidenceRef[] | undefined) ?? [];
  const dsl = getDSLByView(a.feature as string, 'design');
  const entityIds: string[] = [];
  if (dsl) {
    for (const n of dsl.geometry?.nodes ?? []) entityIds.push(n.id);
    for (const e of dsl.geometry?.edges ?? []) entityIds.push(e.id);
    for (const f of dsl.semantic?.files ?? []) {
      if (f.id) entityIds.push(f.id);
      if (f.path) entityIds.push(f.path);
    }
  }
  // L4 证据回溯：从真实 trace 库（<feature>.trace.json）加载记录并复算校验；
  // 无 trace 文件 → 无法回溯 → evidence 一律打回（宁缺毋滥，杜绝编造证据进库）
  const traceFile = path.join(getLiveDir(), `${a.feature as string}.trace.json`);
  const records = loadTraceRecords(traceFile);
  const traceResolver = records.length > 0 ? buildTraceResolver(records) : undefined;
  const v = validateReason({
    reason,
    evidence,
    resolver: {
      entityIds,
      exists: traceResolver?.exists,
      traceRefs: traceResolver?.traceRefs,
    },
  });
  if (!v.ok) {
    throw new Error(`变更原因校验未通过（L${v.layer}）：${v.error}`);
  }
  // 写收敛（方向 E）：daemon 可用则转发单写者队列执行（乐观锁 + 读改写互斥），
  // 否则本地 updateFeature（现状降级）。冲突时抛错，LLM 据此 rebase，绝不静默覆盖。
  const { result } = await dispatchDslEdit(a as unknown as Record<string, unknown>, (input) => updateFeature(input as never));
  return result;
});

/** manage_feature：生命周期 */
const manageFeatureHandler = wrap(async (a) => manageFeature(a as never));

/** render_dsl：渲染思维导图/HTML/SVG/Markdown（format 参数聚合导出；view 决定渲染设计或实际视图） */
const renderDslHandler = wrap(async (a) => {
  // 默认 mindmap：现行思维导图架构（root → 功能分组 → 文件）；html 星图画布仅调试保留
  const format = typeof a.format === 'string' ? a.format : 'mindmap';
  const feature = a.feature as string;
  const view = a.view === 'live' ? 'live' : 'design';
  const output_path = typeof a.output_path === 'string' ? a.output_path : undefined;
  if (format === 'mindmap') {
    if (!feature) throw new Error('render_dsl mindmap 模式需要 feature（从存储读取设计 DSL 派生，不支持 dsl_json 直传）');
    const r = await deriveMindMap({ feature, gen_descriptions: false });
    // 空导图回退：DSL 无 semantic.files 时导图会空，降级为 html 设计画布避免产物不可用
    if ((r.mind_map.root.children ?? []).length === 0) {
      const dsl = getDSLByView(feature, view);
      if (dsl) {
        const rr = renderDsl({ dsl_json: JSON.stringify(dsl), output_path, persist: false });
        return {
          message:
            `⚠ 思维导图为空（DSL 无语义文件层），已回退渲染设计画布：\n${rr.message}\n` +
            `提示：先 import_project 或 edit_dsl 补充 semantic.files 后再派生思维导图`,
        };
      }
    }
    return {
      message:
        r.message +
        `\n交互版（人机共笔：⊕ 新增分支 / 双击批注 / 保存回写 DSL）：http://localhost:3000/mindmap/${feature}`,
    };
  }
  if (format === 'svg') {
    const r = exportSvg({ feature, output_path });
    return { message: r.message };
  }
  if (format === 'markdown') {
    const r = exportMarkdown({ feature, output_path });
    return { message: r.message };
  }
  // html：优先用显式 dsl_json；否则按 view 从存储读取
  let dsl_json = a.dsl_json as string | undefined;
  if (!dsl_json) {
    if (!feature) throw new Error('render_dsl html 模式需要 feature 或 dsl_json');
    const dsl = getDSLByView(feature, view);
    if (!dsl) throw new Error(`feature "${feature}" 不存在（视图: ${view}）`);
    dsl_json = JSON.stringify(dsl);
  }
  // live 视图渲染不写回设计层（persist=false）
  const r = renderDsl({ dsl_json, output_path, persist: view === 'design' });
  return { message: r.message };
});

/** scaffold：骨架 + 状态推断 */
const scaffoldHandler = wrap(async (a) => {
  const r = scaffold({
    feature: a.feature as string,
    output_dir: a.output_dir as string | undefined,
    overwrite: a.overwrite as boolean | undefined,
    ui_framework: a.ui_framework as 'vue' | 'react' | 'html' | undefined,
  });
  return { message: r.message };
});

/** backfill_scaffold：回填 */
const backfillHandler = wrap(async (a) => {
  const r = await backfillScaffold({
    feature: a.feature as string,
    scaffold_dir: a.scaffold_dir as string | undefined,
  });
  return { message: r.message };
});

/** consistency_check：一致性 */
const consistencyHandler = wrap(async (a) => {
  const r = await checkConsistency({
    feature: a.feature as string,
    code_dir: a.code_dir as string | undefined,
  });
  return { message: r.message };
});

/** explore_code：参数化代码理解（用 wrapData：data 不丢弃，杜绝「有结果却静默空输出」） */
const exploreCodeHandler = wrapData(async (a) => {
  const action = a.action as never;
  const result = await exploreCode({ action, args: (a.args ?? {}) as Record<string, unknown> });
  return { message: result.message, data: result.data };
});

/** diff_views：设计视图 vs 实际代码快照双栏对比 */
const diffViewsHandler = wrap(async (a) => {
  const r = diffViews({
    feature: a.feature as string,
    live_dir: a.live_dir as string | undefined,
  });
  return { message: r.message, data: r.data };
});

/** archive_node：把下线的文件/节点孤立到下线库（历史研究材料） */
const archiveNodeHandler = wrap(async (a) => {
  const r = archiveNode({
    feature: a.feature as string,
    file_path: a.file_path as string,
    retire_reason: a.retire_reason as string,
    merged_into: a.merged_into as string | undefined,
  });
  return { message: r.message, data: r };
});

/** sync_contracts：以 server_registry zod schema 为唯一源，回填 DSL expected_apis */
const syncContractsHandler = wrap((a) => {
  const r = syncContracts({ feature: a.feature as string, include_all: a.include_all as boolean | undefined });
  return { message: r.message, data: r };
});

/** list_archive：列出某 feature 的下线库归档条目 */
const listArchiveHandler = wrap(async (a) => {
  const r = listArchive({ feature: a.feature as string, live_dir: a.live_dir as string | undefined });
  return { message: r.message, data: r };
});

/** harvest_decisions：从文档/git日志/注释提取决策卡候选（draft，供 review 补录） */
const harvestDecisionsHandler = wrap(async (a) => {
  const r = harvestDecisions({
    feature: a.feature as string,
    doc_dir: a.doc_dir as string | undefined,
    git_root: a.git_root as string | undefined,
    limit: a.limit as number | undefined,
    comment_files: a.comment_files as string[] | undefined,
  });
  return { message: r.message, data: r };
});

// ─────────────────────────────────────────────────────────────
// Observe 观测工具 handler（设计→开发→测试闭环的「测试」端）
// 与 design 主工具并列同一套 MCP。底层复用 observe/* 纯函数，不重写逻辑。
// ─────────────────────────────────────────────────────────────

/** observe_log：按文件/全量查询 Observe 运行日志（复用 queryObserveLog） */
const observeLogHandler = wrap(async (a) => {
  const eventsFile = a.events_file as string | undefined;
  if (!eventsFile) {
    throw new Error('observe_log 需要 events_file 参数：传 Observe 事件文件路径（events.jsonl）。');
  }
  const files = Array.isArray(a.files) ? (a.files as string[]).filter(Boolean) : [];
  const all = a.all === true || a.all === 'true' || a.all === '1';
  const r = queryObserveLog(eventsFile, { files, all });
  const lines = [
    `Observe 日志 [${r.eventsPath}]`,
    `  事件 ${r.total} · 偏差 ${r.anomalyCount} · 跳过 ${r.skipped} · 返回 ${r.entries.length} 条`,
    ...(r.entries.length === 0 ? ['  （无匹配事件）'] : []),
  ];
  for (const e of r.entries) {
    const mark = e.result === 'deviation' ? '✗' : '✓';
    lines.push(`  ${mark} [${e.result}] ${e.probe}${e.file ? ` (${e.file})` : ''} rule=${e.rule}`);
    lines.push(`      ${e.reason}`);
  }
  // 附完整结构化数据供 LLM 继续分析
  lines.push('---DATA---');
  lines.push(JSON.stringify(r.entries));
  return { message: lines.join('\n'), data: r.entries };
});

/** observe_judge：对一批事件执行偏差判定。decls（可选）提供时额外执行 P2 链路契约判定——
 * 重建实测调用链（trace 三元组）+ Comparator 全量对比（探针级 + 链路级），
 * 链路断裂（chain-broken）带 trace_id 与实测窗口。不传 decls 保持逐事件判定。 */
const observeJudgeHandler = wrap(async (a) => {
  const events = a.events;
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('observe_judge 需要 events 参数：传要判定的事件数组（符合 TSEvent 形状）。');
  }
  const { events: norm, error } = normalizeEvents(events);
  if (error) throw new Error(error);
  const useLlm = a.use_llm === true || a.use_llm === 'true' || a.use_llm === '1';
  const report = useLlm ? await judgeEventsWithLLM(norm, true) : judgeEvents(norm);

  // P2 链路契约：decls 提供时重建实测链 + Comparator 全量对比（探针级 + 链路级）
  let diff: TSDiffReport | undefined;
  let chainsNote = '';
  const decls = Array.isArray(a.decls) ? (a.decls as TSDLDecl[]) : undefined;
  if (decls && decls.length > 0) {
    const { chains, dropped } = rebuildChains(norm);
    const comp = new TSComparator().registerDefaultPredicates();
    diff = comp.compare(
      { version: 1, updated_at: new Date().toISOString(), decls },
      TSComparator.aggregate(norm),
      chains,
    );
    chainsNote = `\n链路重建: ${chains.length} 条链${dropped > 0 ? `（超预算丢弃 ${dropped} 条）` : ''}`;
  }

  const merged = diff ? { ...report, diff } : report;
  const text = a.text === true || a.text === '1'
    ? renderJudgeReport(report) + (diff ? `\n\n${renderTSDiffReport(diff)}${chainsNote}` : '')
    : JSON.stringify(merged);
  return { message: text, data: merged };
});

/**
 * reconcile_chain：中观档——按「文件/宿主节点」一条命令的真跑 + 查数据 + 对账。
 * 后工具自动前置：宿主下无 detail 链时自动调用 deriveDetailChain（缓存判断——已有链即跳过），
 * 再自动发现事件文件、按链文件过滤真跑事件、逐事件判定、重建实测链、链路契约匹配。
 */
const reconcileChainHandler = wrapData(async (a) => {
  const input = a as unknown as ReconcileChainInput;
  if (!input.feature || !input.node_id) {
    throw new Error('reconcile_chain 需要 feature + node_id：指定宿主文件节点（detail 链挂在它下面）做中观档对账。');
  }
  const r = await reconcileChain({
    feature: String(input.feature),
    node_id: String(input.node_id),
    project_dir: String(input.project_dir ?? process.cwd()),
    events_files: Array.isArray(input.events_files) ? (input.events_files as string[]) : undefined,
    force: input.force === true,
    max_steps: typeof input.max_steps === 'number' ? input.max_steps : undefined,
  });
  return { message: r.message, data: r };
});

/** observe_instrument：对目标项目全自动插桩 / 还原（复用 instrumentProject/restoreInstrumented） */
const observeInstrumentHandler = wrap(async (a) => {
  const target = a.target as string | undefined;
  if (!target) {
    throw new Error('observe_instrument 需要 target 参数：传要插桩的项目目录。');
  }
  const unintrument = a.action === 'uninstrument' || a.action === 'restore';
  const dryRun = a.dry_run === true || a.dry_run === 'true' || a.dry_run === '1';
  const projectRoot = a.project_root as string | undefined;
  // 契约模式：contract_probes 非空数组时只注入声明的探针点；缺省/空数组 → 探索模式全量插桩
  const contractProbes = Array.isArray(a.contract_probes) && a.contract_probes.length > 0
    ? (a.contract_probes as string[])
    : undefined;

  if (unintrument) {
    const restored = restoreInstrumented(target);
    const cleared = clearProbeLedger(target);
    if (restored.length === 0 && !cleared) {
      return { message: 'Observe 一键全拔：未找到备份与台账，无需还原（可能从未插桩，或备份已删）。', data: [] };
    }
    return {
      message:
        `Observe 一键全拔：已还原 ${restored.length} 个文件并删除备份目录${cleared ? '，已清理探针台账' : ''}。\n` +
        restored.map((f) => `  ↺ ${f}`).join('\n'),
      data: { restored, ledger_cleared: cleared },
    };
  }

  const files = collectTsFiles(target);
  const results = await instrumentProject(target, { projectRoot, write: !dryRun, contractProbes });
  let totalSites = 0;
  let instrumented = 0;
  let skipped = 0;
  let errors = 0;
  const mode = contractProbes ? `契约模式（${contractProbes.length} 个探针）` : '探索模式（全量插桩）';
  const lines = [`Observe 插桩 [${mode}] ${dryRun ? 'DRY-RUN' : 'WRITE'} → ${target}`, `  扫描 ${files.length} 个 .ts 文件`];
  for (const r of results) {
    if (r.error) {
      errors++;
      lines.push(`  ✗ ${r.file}  ${r.error}`);
    } else if (r.sites.length > 0) {
      instrumented++;
      totalSites += r.sites.length;
      lines.push(`  + ${r.file}  ${dryRun ? '将注入' : '注入'} ${r.sites.length} 探针点`);
    } else {
      skipped++;
    }
  }
  lines.push(`  完成：${instrumented} 新插桩 / ${skipped} 已含探针跳过 / ${errors} 失败，共 ${totalSites} 探针点`);
  if (dryRun) lines.push('  DRY-RUN 未写盘。传 dry_run=false 实际改写源码（git 可兜底，幂等）。');

  // 写盘插桩成功后记账：生成探针台账 + 统计，随 data 返回供上层查看/一键全拔联动
  const data: Record<string, unknown> = { results };
  if (!dryRun && totalSites > 0) {
    const ledger = buildProbeLedger(results, target);
    const ledgerFile = saveProbeLedger(target, ledger);
    data.ledger = ledger;
    data.ledger_file = ledgerFile;
    lines.push(`  探针台账已记账 → ${ledgerFile}`);
    lines.push(`  统计：${ledgerSummary(ledger)}`);
  }
  return { message: lines.join('\n'), data };
});

// ─────────────────────────────────────────────────────────────
// ToolDef 定义：9 主工具 + 别名
// ─────────────────────────────────────────────────────────────

const TOOL_DEFS: ToolDef[] = [
  {
    name: 'get_dsl',
    title: 'Query feature data',
    description:
      '统一只读入口：通过 query 参数查询 DSL 数据。' +
      'query: dsl（完整 DSL JSON）/ features（所有 feature 列表）/ ' +
      'nodes（节点摘要列表，支持 layer/type 过滤）/ edges（边摘要列表，支持 layer 过滤）/ ' +
      'node（单个节点详情，需 node_id，含决策卡与版本史）/ ' +
      'decisions（决策卡目录，按功能线 thread 分组，支持 thread/decision_status 过滤）/ ' +
      'files（语义文件摘要列表，支持 file_layer/file_status 过滤）/ ' +
      'file（单个文件详情，需 file_id，含 expected_apis/actual_apis/deps）/ ' +
      'calls（文件调用关系，需 file_id+project_dir，查 cache.db 入/出调用）/ ' +
      'annotations（标注）/ approvals（审批）/ approval_history（审批历史，需 annotation_id）/ ' +
      'snapshots（快照）/ templates（模板）/ simulation_state（仿真状态）/ diff（对比，需 feature_a+feature_b）。' +
      'view: design（默认，活态设计）/ live（实际代码快照，仅 query=dsl/nodes/edges/node/files/file 生效，用于对比设计 vs 代码现状）。',
    inputSchema: {
      query: z
        .enum(['dsl', 'features', 'nodes', 'edges', 'node', 'decisions', 'files', 'file', 'calls', 'annotations', 'approvals', 'approval_history', 'snapshots', 'templates', 'simulation_state', 'diff'])
        .describe('查询类型：dsl=完整DSL, features=feature列表, nodes=节点摘要, edges=边摘要, node=节点详情, decisions=决策目录(按功能线分组), files=文件摘要, file=文件详情, calls=调用关系, annotations=标注, approvals=审批, approval_history=审批历史, snapshots=快照, templates=模板, simulation_state=仿真状态, diff=对比'),
      view: z.enum(['design', 'live']).default('design').describe('视图层级：design=设计视图（默认），live=实际代码快照'),
      feature: z.string().optional().describe('feature 名（nodes/edges/node/decisions/files/file/annotations/approvals 等需要）'),
      node_id: z.string().optional().describe('query=node 时：节点 ID'),
      thread: z.string().optional().describe('query=decisions 时：按功能线过滤（不传=全部，按 thread 分组输出）'),
      decision_status: z.enum(['active', 'superseded', 'draft']).optional().describe('query=decisions 时：按决策状态过滤（active=生效中/superseded=已迭代/draft=草案）'),
      file_id: z.string().optional().describe('query=file/calls 时：文件 ID（对应 SemanticFile.id = geometry Node.id）'),
      project_dir: z.string().optional().describe('query=calls 时：项目根目录（用于打开 cache.db 查询调用关系）'),
      layer: z.enum(['main', 'error', 'detail']).optional().describe('query=nodes/edges 时：按职责分层过滤'),
      type: z.string().optional().describe('query=nodes 时：按节点类型过滤（如 service/module/database/api/queue/ui）'),
      file_layer: z.string().optional().describe('query=files 时：按架构层过滤（如 api/service/data/ui）'),
      file_status: z.enum(['draft', 'in_progress', 'done']).optional().describe('query=files 时：按实现状态过滤'),
      annotation_node_id: z.string().optional().describe('query=annotations 时：按节点过滤'),
      severity: z.enum(['info', 'warning', 'critical']).optional(),
      unresolved_only: z.boolean().optional(),
      status: z.string().optional().describe('query=approvals 时：按状态过滤'),
      assignee: z.string().optional(),
      annotation_id: z.string().optional().describe('query=approval_history 时：标注 ID'),
      feature_a: z.string().optional().describe('query=diff 时：源 feature'),
      feature_b: z.string().optional().describe('query=diff 时：目标 feature'),
      view_b: z.enum(['design', 'live']).optional().describe('query=diff 时：feature_b 视图层级，默认跟随 view（design）；对比"设计 vs 代码现状"时传 live'),
    },
    handler: getDslHandler,
  },
  {
    name: 'edit_dsl',
    title: 'Update feature with batch operations',
    description:
      '统一写入口：通过 operations 列表批量执行节点/边/文件/API 的增删改、节点平移、语义绑定、状态更新，' +
      '以及标注/审批/快照/自动布局/仿真重置。按顺序执行，任一失败自动回滚（原子性）。' +
      'op: add/update/delete/move（通用），resolve（关闭标注），submit/review（审批），save/rollback/delete（快照），apply（布局），reset（仿真）；' +
      'type: node/edge/file/api/binding/status/annotation/approval/snapshot/layout/simulation。' +
      '标注/审批/快照/布局/仿真 用 data 传参（annotation.add data.text；annotation.resolve data.annotation_id；' +
      'approval.submit/review data.annotation_id；snapshot.save data.label；snapshot.rollback/delete data.snapshot_id；' +
      'layout.apply data.algo=dag|force|grid；simulation.reset 无参）。' +
      'view: design（默认，改设计视图）/ live（拒绝写入，实际代码快照只能由 import/watch 重建）。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      view: z.enum(['design', 'live']).default('design').describe('视图层级：design=设计视图（默认）；live=实际代码快照，只读，拒绝写入'),
      reason: z
        .string()
        .describe(
          '变更原因（活文档必填，经四层校验：非空/非套话/绑定具体实体/证据可回溯）。' +
            '请用一句话说明这次变更为什么发生，并引用具体实体（节点/文件 id、路径、数字指标）。',
        ),
      operations: z
        .array(
          z.object({
            op: z
              .enum(['add', 'update', 'delete', 'move', 'resolve', 'submit', 'review', 'save', 'rollback', 'apply', 'reset'])
              .describe('操作：add/update/delete/move 通用；resolve=关闭标注；submit/review=审批；save/rollback/delete=快照；apply=布局；reset=仿真'),
            type: z
              .enum(['node', 'edge', 'file', 'api', 'binding', 'status', 'annotation', 'approval', 'snapshot', 'layout', 'simulation'])
              .describe('目标类型：node/edge/file/api/binding/status 几何与语义；annotation/approval/snapshot/layout/simulation 协作与整理'),
            id: z.string().optional().describe('目标 ID（annotation/approval/snapshot/layout/simulation 可省略，用 data 传参）'),
            data: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .describe('操作列表，按顺序执行，任一失败全部回滚'),
      evidence: z
        .array(
          z.object({
            type: z
              .enum(['trace', 'diff', 'node', 'edge', 'metric'])
              .describe("证据类型，当前 L4 支持 'trace'（真实执行记录）"),
            ref: z
              .string()
              .describe("trace 证据的 ref：函数名，或 '<函数名>@token>N'（声明该函数实际 token 超 N，程序复算验证）"),
          }),
        )
        .optional()
        .describe('证据链（L4 回溯）：可选。传入后程序会到真实 trace 库（<feature>.trace.json）复算验证，查不到或不符则打回'),
    },
    handler: editDslHandler,
  },
  {
    name: 'manage_feature',
    title: 'Manage feature lifecycle',
    description:
      'feature 生命周期统一入口：create（创建）/ clone（克隆）/ template（从模板创建）/ list（列出）/ delete（删除）。' +
      'create 需 feature 名（^[a-zA-Z0-9_-]+$）；clone 需 source_feature+target_feature；template 需 template_id+feature；' +
      'delete 需 feature（同时清理设计存档 + 实际快照 + 活态视图）。',
    inputSchema: {
      action: z.enum(MANAGE_ACTIONS).describe('create/clone/template/list/delete'),
      args: z.record(z.string(), z.unknown()).optional().describe('各 action 参数（feature/title/source_feature/target_feature/template_id）'),
    },
    handler: manageFeatureHandler,
  },
  {
    name: 'render_dsl',
    title: 'Render design DSL to mindmap/HTML/SVG/Markdown',
    description:
      '渲染设计 DSL：format=mindmap（默认，现行思维导图架构：root → 功能分组 → 文件，自包含查看器 HTML；' +
      '功能分组优先读设计视图语义分组容器，其次 feature_tree 功能树）/' +
      'html（旧设计画布·星图，仅调试用，自包含单 HTML）/ svg（矢量图）/ markdown（可读设计文档）。' +
      'mindmap/svg/markdown 用 feature 从存储读取；html 模式可直接传 dsl_json 渲染，或用 feature+view 读取。',
    inputSchema: {
      feature: z.string().optional().describe('feature 名（mindmap/svg/markdown 必填；html 用 feature+view 读取）'),
      view: z.enum(['design', 'live']).default('design').describe('视图层级：design=设计视图（默认），live=实际代码快照（仅 html 用）'),
      format: z.enum(['mindmap', 'html', 'svg', 'markdown']).optional().describe('输出格式，默认 mindmap（现行思维导图架构）'),
      dsl_json: z.string().optional().describe('html 模式：完整 DSL JSON 字符串'),
      output_path: z.string().optional().describe('输出路径'),
    },
    handler: renderDslHandler,
  },
  {
    name: 'render_sandbox',
    title: 'Render the dependency-driven community workbench (brickify)',
    description:
      '可视化协作平台的**依赖驱动积木化工作台**渲染（后端数据线路的交付出口）：' +
      '扫描 project_dir → 文件级依赖图 → 目录种子积木 → 混合文件信号(AST 顶层概念簇) → ' +
      '功能社区(依赖边连通分量+内聚度) → 生成**自包含单 HTML 社区工作台**。' +
      '取代旧"按目录硬切+基名相似"启发式：每块积木=一个功能，社区=积木依赖簇，' +
      '混合文件=一文件多功能(解耦候选信号，需人/LLM 确认拆分)。' +
      '返回 HTML 文件路径，浏览器可直接打开验收。',
    inputSchema: {
      project_dir: z.string().describe('目标项目根目录（扫描依赖的源）'),
      source_root: z.string().optional().describe('源码根目录（默认 = project_dir）'),
      output_path: z.string().optional().describe('输出 HTML 路径（默认 <design-canvas>/docs/brickify_preview.html）'),
    },
    handler: wrapData(async (a) => {
      const out = await buildBrickifyPreview({
        project_dir: a.project_dir as string,
        source_root: a.source_root as string | undefined,
        out_file: a.output_path as string | undefined,
      });
      const fileUrl = `file:///${out.replace(/\\/g, '/')}`;
      return { message: `已生成依赖驱动功能社区工作台：${out}\n（浏览器打开 ${fileUrl} 查看积木社区/混合文件诊断）` };
    }),
  },
  {
    name: 'scaffold',
    title: 'Generate code skeleton from DSL',
    description:
      '从 DSL semantic 层生成代码骨架。支持语言：.go/.ts/.py/.js/.vue/.tsx。' +
      '额外生成 INVARIANTS.md 记录跨文件不变式。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      output_dir: z.string().optional(),
      overwrite: z.boolean().optional(),
      ui_framework: z.enum(['vue', 'react', 'html']).optional(),
    },
    handler: scaffoldHandler,
  },
  {
    name: 'backfill_scaffold',
    title: 'Backfill scaffold from implementation code',
    description:
      'LLM 写完代码后，解析实现文件中的 API 签名，回填到 DSL semantic.files[].actual_apis，' +
      '对比 expected_apis 输出差异报告。支持 .go/.ts/.py/.js。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      scaffold_dir: z.string().optional(),
    },
    handler: backfillHandler,
  },
  {
    name: 'consistency_check',
    title: 'Check design-code consistency',
    description:
      '对比 DSL 定义的 expected_apis 与实际代码实现，生成一致性报告（已实现/缺失/签名不匹配/代码新增），' +
      '并验证跨文件不变式。只读检查。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      code_dir: z.string().optional(),
    },
    handler: consistencyHandler,
  },
  {
    name: 'import_project',
    title: 'Import a code project as DSL',
    description:
      '扫描代码项目（.go/.ts/.py/.js 等）生成 DSL：文件节点 + 调用边 + 符号/API 语义层，写入 design-canvas 存储。' +
      '默认生成设计 DSL；live_only=true 只生成"实际视图"快照（live/ 目录，供 🎭设计/⚡实际 双视图对比）。' +
      'design_mode=true 按目录聚合成模块节点；functional_mode=true 按调用图做功能性聚合（优先级高于 design_mode）。' +
      '导入后可用 render_dsl 渲染可视化，或 diff_views 对比设计 vs 实际。',
    inputSchema: {
      project_dir: z.string().describe('目标项目根目录（绝对路径或相对 cwd）'),
      feature: z.string().describe('新 feature 名（^[a-zA-Z0-9_-]+$）'),
      title: z.string().optional().describe('显示标题（默认等于 feature）'),
      max_files: z.number().optional().describe('最多解析文件数（默认 200）'),
      include_tests: z.boolean().optional().describe('是否包含测试文件（默认 false）'),
      include_archive: z.boolean().optional().describe('是否索引归档目录 _archive/archive/_old 等（默认 false）'),
      live_only: z
        .boolean()
        .optional()
        .describe('true=仅生成实际视图快照（写 live/，不覆盖设计 DSL），默认 false=写设计 DSL'),
      live_dir: z.string().optional().describe('live_only 时实际 DSL 归属的项目根（默认 dataHome）'),
      gen_roles: z
        .boolean()
        .optional()
        .describe('true=用 LLM 为文件节点生成中文职责标题（默认 false，未配置 LLM 时静默跳过）'),
      design_mode: z.boolean().optional().describe('true=按目录聚合为模块节点（设计草图模式）'),
      functional_mode: z.boolean().optional().describe('true=按调用图做功能性聚合（跨目录功能社区，优先于 design_mode）'),
    },
    handler: wrap(async (a) => {
      // MCP 路径默认连项目级符号缓存（<project_dir>/.design-canvas/cache.db）：
      // 不连则 importProject 走无缓存路径，符号缓存永远不更新（增量 re-parse 失效）。
      // 开库失败（只读目录等）降级为无缓存导入，不阻断导入本身。
      let cacheDb;
      try {
        cacheDb = getProjectCacheDb(path.resolve(a.project_dir as string));
      } catch {
        cacheDb = undefined;
      }
      const r = await importProject({ ...(a as unknown as ImportProjectInput), cache_db: cacheDb });
      return { message: r.message };
    }),
  },
  {
    name: 'explore_code',
    title: 'Explore, analyze and understand code',
    description:
      '代码理解统一入口：通过 action 参数化执行各类分析。' +
      `action: ${EXPLORE_ACTIONS.join(' / ')}。` +
      '语义搜索/读取/影响分析/架构分层/导览/巨石分析/拆分/变形链/动画流/算法/注入回放/仿真/文件监听。' +
      'args 为各 action 的具体参数。' +
      'read 是 edit_code 的"先读后改"前置：按符号定位（symbol，+parent 消歧，+context 附带上下文）' +
      '或行区间（start/end，1-based 含端点）读文件，返回带真实行号的内容；' +
      '返回的 start/end/行号与 edit_code(op=range) 同基准（line_utils.splitKeepEnds 下标+1=行号），' +
      '可直接把 read 的行号喂给 edit_code，杜绝行号漂移改错行。' +
      'read 默认在 data.symbols 附整文件符号索引（name/kind/行号/签名，message 末尾附可读符号表，上限30截断），' +
      '一次 read 同时拿到正文+文件地图，symbols:false 可关。' +
      'search 三层路由：标识符查询（如 normalizeCode / Calc.reset）→ 精确符号索引（provider=exact，零向量开销）；' +
      '自然语言意图 → 语义向量相似度；无 embedding 配置/失败 → FTS trigram 降级。' +
      'search 必填 args.project_dir（目标项目根目录，缺省报错）+ args.query，可选 top_k；' +
      'arch_layer/diff_impact 等同样需要 project_dir。' +
      'watch 支持 impact_on_change=true：文件变更后自动生成影响报告（一行摘要入 alerts，' +
      'action=status 查看未读提醒，action=impact + seq 取全文；报告持久落盘 .design-canvas/impact/）。' +
      '改代码前建议 action=declare + files 登记预告（Impact Ledger）：改后自动对比实际波及，' +
      '计划外扩散即时报警。预告持久化 ledger.json（跨会话恢复，24h 未消费过期）；' +
      'action=ledger 查台账，violated 用 resolve_id + reason 过门处理（status 播报未处理数）。',
    inputSchema: {
      action: z.enum(EXPLORE_ACTIONS).describe('要执行的代码理解动作'),
      args: z.record(z.string(), z.unknown()).optional().describe('各 action 参数'),
    },
    handler: exploreCodeHandler,
  },
  {
    name: 'diff_views',
    title: 'Compare design view vs live code snapshot',
    description:
      '双视图对比：加载同一 feature 的 design（设计视图）和 live（实际代码快照）两个 DSL，' +
      '逐层比对文件级/符号级/API 级/依赖级变更。' +
      '输出结构化数据供 LLM 分析 + 可读摘要。' +
      '适用于：重构后验证设计一致性、代码生成后检查偏差、追踪代码演进。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      live_dir: z.string().optional().describe('live 视图的 baseDir（可选，默认 dataHome），与 import_project 的 live_dir 一致'),
    },
    handler: diffViewsHandler,
  },
  {
    name: 'archive_node',
    title: 'Archive a retiring node to the offline library',
    description:
      '节点下线：把要下线的文件/节点孤立到下线库（archive），存档完整 DSL 快照（含决策卡）+ 为什么下线，' +
      '作为历史研究材料，并从设计 DSL 移除（不再参与周边联系）。' +
      '"下线=两个文件合并"时传 merged_into 指向合并目标，目标文件 lifecycle.merged_from 记录来源，' +
      'diff 时 LLM 可据归档卡 + diff 增量做决策合并（不做自动合并，决策是语义的）。' +
      '适用：删掉废弃模块、合并重复文件、结构重构后的清理。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      file_path: z.string().describe('要下线的文件相对路径'),
      retire_reason: z.string().describe('为什么下线（必填，作为历史研究材料）'),
      merged_into: z.string().optional().describe('若下线是合并（两文件合一），填合并目标文件路径'),
    },
    handler: archiveNodeHandler,
  },
  {
    name: 'list_archive',
    title: 'List archived (retired) nodes',
    description:
      '列出某 feature 的下线库归档条目（历史研究材料）：每个条目含被下线文件、下线原因、合并去向、归档时间。' +
      'LLM 在做结构重构/删除决策前，可先查历史归档了解"以前为什么这么设计、为什么下线"。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      live_dir: z.string().optional().describe('live/base 视图的 baseDir（可选，默认 dataHome）'),
    },
    handler: listArchiveHandler,
  },
  {
    name: 'harvest_decisions',
    title: 'Harvest decision-card candidates from docs / git log / comments',
    description:
      '决策卡补录：从项目文档（docs/*.md）、git 日志、源码注释粗提取设计意图线索，生成 draft 决策卡候选（含出处 ref + 原文 evidence + 一句话总结）。' +
      '不直接写 DSL——LLM review 核对出处后，定稿（status: active）再通过决策卡工具写入 DSL，防编造。' +
      '候选带 lifecycle_hint（下线/合并/取代/拆分），供 diff 与下线库（archive_node）参考。' +
      '适用：为没有决策卡历史的现有项目/外来代码补录活文档。',
    inputSchema: {
      feature: z.string().describe('feature 名（候选挂载目标）'),
      doc_dir: z.string().optional().describe('文档目录（扫描 *.md），默认 <cwd>/docs'),
      git_root: z.string().optional().describe('git 仓库根（读 git log），默认 <cwd>'),
      limit: z.number().optional().describe('git 日志条数上限，默认 30'),
      comment_files: z.array(z.string()).optional().describe('要提取注释的源码文件（绝对路径）'),
    },
    handler: harvestDecisionsHandler,
  },
  {
    name: 'sync_contracts',
    title: 'Sync tool contracts from registry schema into DSL expected_apis',
    description:
      '契约回填（修复契约漂移）：以 server_registry 的 zod schema 为唯一事实源，把每个已注册工具的输入契约生成签名回填到 DSL semantic.files 的 expected_apis。' +
      '改了工具 schema 后跑一次，DSL 契约自动跟上。' +
      '默认只更新 DSL 中已存在且 path=src/tools/{name}.ts 的文件；include_all=true 时为缺失的工具文件补全契约节点。' +
      '只回填签名（notes 带机器生成标记），设计侧意图由 LLM 维护。',
    inputSchema: {
      feature: z.string().describe('feature 名（已存在的 DSL feature）'),
      include_all: z.boolean().optional().describe('为 DSL 中缺失的工具文件补全契约节点（默认 false）'),
    },
    handler: syncContractsHandler,
  },
  {
    name: 'harvest_closure',
    title: 'Harvest a brick with its transitive import closure',
    description:
      '积木拎取闭包（Brick Harvest Phase 1）：给定种子文件，沿 import 边算出"拎走这块积木必须连根带走的全部东西"。' +
      '输出：项目内传递闭包（带深度/带入者/import 语句证据）+ 外部依赖三分类（标准库/三方/未归类）。' +
      '与 diff_impact 正交：diff_impact 答"改这里波及谁"（importer 方向），本工具答"拎走它需要什么"（importee 方向）。' +
      'include_callers=true 时连调用方一起端走（拎服务层带生态）。前置：项目需先跑 import_project 建符号缓存。' +
      '规划见 docs/plans/2026-08-19-cross-project-brick-harvest.md。',
    inputSchema: {
      project_dir: z.string().describe('目标项目根目录（其下 .design-canvas/cache.db 是符号缓存，需先 import_project）'),
      files: z.array(z.string()).describe('种子文件（相对项目根或绝对路径，可多个）'),
      feature: z.string().optional().describe('可选 feature 名：提供时为闭包文件附加 DSL 文件节点 id'),
      include_callers: z
        .boolean()
        .optional()
        .describe('true=importer 方向也纳入闭包（连功能带调用方生态一起端走），默认 false=纯根须'),
      max_depth: z.number().optional().describe('BFS 深度上限（默认 30，传递闭包天然有界）'),
    },
    handler: wrapData(async (a) => {
      const r = harvestClosure(a as unknown as HarvestClosureInput);
      return { message: r.message, data: r };
    }),
  },
  {
    name: 'extract_contracts',
    title: 'Extract brick contracts (role/shapes/effects) for project files',
    description:
      '积木契约提取（Brick Harvest Phase 2）：给项目文件生成 BrickContract——' +
      'role（业务/功能二分：依赖方向图算法，零 token，"功能不依赖业务，业务组装功能"）、' +
      'shapes（struct/interface/class 数据形状+字段，结构化类型匹配的判定单元）、' +
      'effects（reads_config=env/flag 读取点；writes/holds/emits=静态候选 origin:ast——' +
      '模块级变量写/listen/句柄/chan send/emit 调用，待 observe 观测转正 origin:runtime）。' +
      '提供 feature 时写回 DSL 的 SemanticFile.contract（write_dsl=false 可只读预演）。' +
      'LLM 不产生事实：结构化字段只接受 AST/observe 源。' +
      '规划见 docs/plans/2026-08-19-cross-project-brick-harvest.md Phase 2.5/2.7。',
    inputSchema: {
      project_dir: z.string().describe('目标项目根目录（须先 import_project 建缓存）'),
      feature: z.string().optional().describe('提供时把 contract 写回该 feature 的 DSL（SemanticFile.contract）'),
      files: z
        .array(z.string())
        .optional()
        .describe('限定提取范围的文件（相对项目根）；缺省 = 全部已索引文件'),
      write_dsl: z.boolean().optional().describe('false=只读预演不写回，默认 true'),
    },
    handler: wrapData(async (a) => {
      const r = extractContracts(a as unknown as ExtractContractsInput);
      return { message: r.message, data: r };
    }),
  },
  {
    name: 'reconcile_effects',
    title: 'Reconcile effect candidates with observe runtime observation',
    description:
      '积木契约动静对账（Brick Harvest Phase 2c 合龙）：读 <project>/.agent/observe/events-*.jsonl 中' +
      '的 effect 事件（go-observe instrument --effects 插桩产生），与 DSL 契约候选对账——' +
      '命中转正（origin ast→runtime）、候选外新观测补进契约并记 incomplete 告警（静态漏了）、' +
      '未触发候选保持 ast（不证伪），并填充 contract.runtime（call_count/top_callers/observed_targets/last_seen）。' +
      '前置链：import_project → extract_contracts → instrument --effects → 运行项目 → 本工具。' +
      'LLM 不产生事实：只搬运 observe 观测，判定规则全部机械。',
    inputSchema: {
      project_dir: z.string().describe('被观测项目根目录（其下 .agent/observe/events-*.jsonl 是事件源）'),
      feature: z.string().describe('DSL feature 名（契约在其 SemanticFile.contract）'),
      events_files: z.array(z.string()).optional().describe('显式事件文件列表（缺省自动发现）'),
      write_dsl: z.boolean().optional().describe('false=只对账预演不写回，默认 true'),
    },
    handler: wrapData(async (a) => {
      const r = await reconcileEffects(a as unknown as ReconcileEffectsInput);
      return { message: r.message, data: r };
    }),
  },
  {
    name: 'harvest_from_url',
    title: 'Harvest bricks from a git URL or local project into the brick box',
    description:
      '积木抽取编排（Brick Harvest Phase 3）：一句"这个项目好，抽它"的完整链——' +
      '浅克隆（或本地目录原地）→ import_project 索引 → extract_contracts 契约 → ' +
      '选积木（显式 seeds 或 auto：functional+fan_in≥2+confidence≥0.7 按 fan_in 降序）→ ' +
      'harvest_closure 闭包 → 入盒三件套（files/ 快照 + contracts.json + manifest.json 聚合清单），' +
      '默认盒 <dataHome>/.design-canvas/bricks/。原项目只留 provenance 冷记录（URL+commit），不保留工作副本；' +
      '上游更新凭记录重抽即覆盖。单积木闭包>50 文件自动跳过（防整项目端走）。',
    inputSchema: {
      source: z.string().describe('git URL（浅克隆）或本地目录绝对路径（原地分析不写源项目）'),
      bricks: z
        .array(
          z.object({
            name: z.string().optional().describe('积木名（缺省 <repo>__<种子文件名>）'),
            seeds: z.array(z.string()).describe('种子文件（相对项目根）'),
          }),
        )
        .optional()
        .describe('显式积木规格（一组种子一个积木）；缺省走 auto 模式'),
      auto: z
        .object({
          max_bricks: z.number().optional().describe('最多抽几块（默认 5）'),
          min_fan_in: z.number().optional().describe('种子最低 fan_in（默认 2）'),
        })
        .optional()
        .describe('auto 模式参数（bricks 未提供时生效）'),
      max_closure: z.number().optional().describe('单积木闭包文件数上限（默认 50）'),
      box_dir: z.string().optional().describe('积木盒根目录（默认 <dataHome>/.design-canvas/bricks）'),
      write: z.boolean().optional().describe('false=dry-run 只预演不入盒，默认 true'),
    },
    handler: wrapData(async (a) => {
      const r = await harvestFromUrl(a as unknown as HarvestFromUrlInput);
      return { message: r.message, data: r };
    }),
  },
  {
    name: 'reconcile_brick',
    title: 'Reconcile brick-box contracts with observe runtime observation',
    description:
      '积木盒动静对账（Brick Harvest Phase 3R-C 工具化）：读 observe effect 事件，与积木盒 contracts.json 对账——' +
      '候选命中观测 → origin ast→runtime 转正；候选外新观测 → 补进契约 + incomplete 告警（静态漏了）；' +
      '未触发候选保持 ast（不证伪），gap_notes 登记人工归因（not_triggered/probe_gap/static_only）。' +
      '证据档案写 manifest.effect_verification（重抽保留字段——快照可重抽，运行证据只有一份）。' +
      '与 reconcile_effects（DSL 契约版）判定规则同源，对账对象是积木盒。' +
      '前置链：harvest_from_url 入盒 → instrument --effects 插桩积木快照 → 驱动运行 → 本工具。',
    inputSchema: {
      brick_dir: z.string().optional().describe('积木目录（含 contracts.json；与 brick_name 二选一）'),
      brick_name: z.string().optional().describe('积木名（搭配 box_dir：<box_dir>/<brick_name>）'),
      box_dir: z.string().optional().describe('积木盒根目录（默认 <cwd>/.design-canvas/bricks）'),
      events_files: z.array(z.string()).optional().describe('显式事件文件列表（缺省自动发现）'),
      verify_dir: z.string().optional().describe('验证项目根目录（自动发现其 .agent/observe/events-*.jsonl）'),
      gap_notes: z
        .record(z.string(), z.string())
        .optional()
        .describe('未观测候选归因（键=<文件名>|<target>，值=归因说明：not_triggered/probe_gap/static_only）'),
      known_blind_spots: z.array(z.string()).optional().describe('已知盲区（写入证据档案）'),
      method: z.string().optional().describe('对账方法描述（写入证据档案，如"instrument --effects + golog-verify 驱动"）'),
      write: z.boolean().optional().describe('false=只对账预演不写回，默认 true'),
    },
    handler: wrapData(async (a) => {
      const r = await reconcileBrick(a as unknown as ReconcileBrickInput);
      return { message: r.message, data: r };
    }),
  },
  {
    name: 'search_bricks',
    title: 'Search and browse the brick shelf (cross-project reuse catalog)',
    description:
      '积木货架（Brick Harvest Phase 4：跨项目统一检索层）——浏览/检索积木盒 .design-canvas/bricks/ 的全部积木，' +
      '"拎之前先看它要什么、给什么"。三种模式：①浏览（无参数：全部积木概况——语言/来源/规模/exposes/验证状态）；' +
      '②检索（query 关键词打分：积木名 > 形状名 > 字段名 > 人话介绍，matched 明细可追溯）；' +
      '③详情（name 精确：完整契约——形状 fields、effects 全清单、不变量断言、闭包、observe 验证档案）。' +
      '过滤：language / verified（有运行证据）/ has_invariants / zero_third_party（拎走即跑）。' +
      '数据源是盒内 manifest.json 自包含档案（跨项目资产的统一命名空间就是盒本身，不碰项目 cache.db）。' +
      '这是"我要 X 功能 → 找到积木 → 拎取拼装"价值链的检索环节。',
    inputSchema: {
      query: z.string().optional().describe('关键词检索（多词独立打分求和：命中积木名/形状名/字段名/description）'),
      language: z.enum(['go', 'typescript', 'python', 'javascript']).optional().describe('语言过滤（闭包文件扩展名推断）'),
      verified: z.boolean().optional().describe('只看有 observe 运行验证的（effect_verification 档案）'),
      has_invariants: z.boolean().optional().describe('只看有数学不变量的（acceptance.invariants）'),
      zero_third_party: z.boolean().optional().describe('只看零三方依赖的（拎走即跑）'),
      name: z.string().optional().describe('精确积木名 → 详情模式（完整契约输出）'),
      box_dir: z.string().optional().describe('积木盒根目录（默认 <cwd>/.design-canvas/bricks）'),
    },
    handler: wrapData(async (a) => {
      const r = await searchBricks(a as unknown as SearchBricksInput);
      return { message: r.message, data: r };
    }),
  },
  {
    name: 'assemble_bricks',
    title: 'Assemble a new project from boxed bricks (assembly zone)',
    description:
      '拼装区（Brick Harvest Phase 5：实码搬运与重组）——把积木盒里的已验证积木搬进一个**全新的拼装区目录**，' +
      '拼出新项目骨架。核心纪律：每次拼装一个新目录，绝不在原项目上抽取和拼装（原项目永远只读）。' +
      '布局 <target>/<积木名>/<原闭包相对路径>（积木名做顶层命名空间，永不撞路径）。' +
      'import 重接：TS/JS 零改动（闭包内相对位置不变）；Go 按闭包目录最长后缀匹配识别内部 import，' +
      '重写为 <module>/<积木名>/<后缀>，并生成 go.mod（含 require 块：版本从各积木 go_mod_requires 存档' +
      '原样取用——源项目 go.mod 原文，不猜不升版；多积木同库不同版本 MVS 取高并留 version_conflicts 警告）。' +
      '诚实边界：存档缺项/TS 依赖汇总 pending 清单由人/LLM 补；go.sum 不生成（跑 go mod tidy 补）；' +
      '跨积木闭包重叠只警告不合并；' +
      'glue 粘合代码不生成（LLM 的活）。写完 glue 编译通过 = 拼装区成为可运行新项目（可 import_project 解析、可再入盒）。',
    inputSchema: {
      bricks: z.array(z.string()).describe('要拼装的积木名列表（须已在盒中；search_bricks 可查）'),
      target_dir: z
        .string()
        .describe('拼装区目录（必须不存在或为空目录——拼装区一次性，拒绝覆盖已有内容）'),
      module: z
        .string()
        .optional()
        .describe('新项目 Go module 名（闭包含 .go 文件时必填，如 example.com/assembly-001）'),
      go_version: z.string().optional().describe('go.mod 的 go 版本声明（默认 1.25.5）'),
      box_dir: z.string().optional().describe('积木盒根目录（默认 <cwd>/.design-canvas/bricks）'),
      write: z.boolean().optional().describe('false 只预演：输出搬运计划与 import 重写预览，不落盘（默认 true）'),
    },
    handler: wrapData(async (a) => {
      const r = await assembleBricks(a as unknown as AssembleBricksInput);
      return { message: r.message, data: r };
    }),
  },
  {
    name: 'slim_brick',
    title: 'Slim a Go brick into a derived -slim brick (compiler-style dead-code pruning)',
    description:
      '积木瘦身（Brick Harvest Phase 6：效仿 Go 编译器的死代码消除）——按入盒时存档的 live 集' +
      '（slim_candidates.live_symbols_by_file，种子可达性 BFS 的事实档案）调用 go-slim 剪刀' +
      '（go/ast 声明过滤 + 包内不动点 + import 剪枝），把盒内 Go 积木剪成 <brick>-slim 衍生积木回盒。' +
      '纪律：原积木永不覆盖（衍生积木是机器产物，删除后重跑本工具可再生成）；非 Go 文件原样搬运' +
      '（embed 资产等）；无可剪内容不生成空壳。可选 verify_build：临时目录 go build ./... 当场编译验证' +
      '（需 Go 工具链+网络），结果写 slim_verification.build。四层验证剩余三层（源测试/observe/效果验收）' +
      '由人后续补——剔除生效前请人工补验。',
    inputSchema: {
      brick_name: z.string().describe('原积木名（盒内 <box_dir>/<brick_name>；须为 Go 积木且带 slim_candidates live 档案）'),
      box_dir: z.string().optional().describe('积木盒根目录（默认 <dataHome>/.design-canvas/bricks）'),
      name: z.string().optional().describe('衍生积木名（默认 <brick_name>-slim）'),
      verify_build: z
        .boolean()
        .optional()
        .describe('true：临时目录 go build ./... 编译验证（需 Go 工具链与网络拉依赖），结果写 slim_verification.build（默认 false）'),
      write: z.boolean().optional().describe('false 只预演不落盘（剪刀跑进临时目录，产出仅进报告；默认 true）'),
    },
    handler: wrapData(async (a) => {
      const r = await slimBrick(a as unknown as SlimBrickInput);
      return { message: r.message, data: r };
    }),
  },
  {
    name: 'narrate_step',
    title: 'Narrate a production-line step as a governed narrative brick',
    description:
      '叙事砖（设计观察：吸收 manim 的"声明式分镜"——一个工序只讲一件事、靠连续进/出过渡连起来）。' +
      '给定一个产线工序文件，生成"进料口→工序→出料口"分镜序列：数据形态（input/output 针脚）由契约投影' +
      '（actual_apis[0] 签名）产生，是代码事实、非 LLM 编造；分镜 facts 逐条引用真实针脚。' +
      'write=true 时用自有 MCP 抽成砖接入体系：盒内写 manifest.json（可被 search_bricks 检索）' +
      '+ DSL semantic 落 brick_narr_* 条目（思维导图「🧱 已验证积木」区出卡）。防编造纪律同契约提取：' +
      'LLM 结论只进 role.reasons/notes，不产生数据事实。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      file: z.string().describe('工序涉及文件（相对路径，语义层锚点）；从 actual_apis[0] 契约投影取输入/输出针脚'),
      title: z.string().optional().describe('工序名（缺省取该文件 responsibility）'),
      detail: z.string().optional().describe('工序人话（缺省取该文件 responsibility）'),
      write: z.boolean().optional().describe('false 只预演不落盘（不写砖不登记，默认 true）'),
    },
    handler: wrapData(async (a) => {
      const r = narrateStep(a as unknown as NarrateStepInput);
      return { message: r.message, data: r };
    }),
  },
  {
    name: 'observe_log',
    title: 'Query Observe runtime logs by file',
    description:
      '查询 Observe 运行时日志（events.jsonl）。可传 files 按文件路径过滤（精确/后缀/包含匹配），' +
      '只返回命中路径的事件；不传 files 时默认只返回偏差，all=true 才全量。' +
      '适用于：LLM 按需拉取某文件/某条链路的数据流与异常，而非全量丢出。',
    inputSchema: {
      events_file: z
        .string()
        .describe('Observe 事件文件路径（events.jsonl）。由插桩/哨兵运行时产生，如 <dataHome>/.design-canvas/observe/events.jsonl'),
      files: z
        .array(z.string())
        .optional()
        .describe('按文件路径过滤（可多个）。传相对路径/文件名片段均可，精确或后缀/包含匹配'),
      all: z
        .boolean()
        .optional()
        .describe('不传 files 时：true=列出全部事件；false=只列偏差（默认）'),
    },
    handler: observeLogHandler,
  },
  {
    name: 'observe_judge',
    title: 'Judge a batch of Observe events',
    description:
      '对一批 Observe 事件执行偏差判定（语言无关）。传 events 数组（符合 TSEvent 形状：probe/fields[err/op/benign]，可含 trace_id/frame_id）。' +
      '返回逐条判定 + 汇总（total/ok/deviation）。text=true 返回人类可读报告，否则返回 JSON。' +
      '传 decls（设计声明数组）时额外执行链路契约判定（P2）：从事件 trace 三元组重建实测调用链，' +
      '声明的调用序（decl.chain）必须是某条实测链的子序列，断裂报 chain-broken（含 trace_id 与实测窗口）。' +
      '适用于：探针语言任意，统一收敛到这一处判定，不随语言复刻规则。',
    inputSchema: {
      events: z
        .array(z.record(z.string(), z.unknown()))
        .describe('要判定的事件数组（TSEvent 形状：probe 必填，fields 含 err/op/benign；链路判定需 trace_id/frame_id）'),
      decls: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe('设计声明数组（dsl.json 的 decls 形状：rule/probe/expect/constraint/chain）。chain=["a","b","c"] 声明调用序，触发链路判定；不传则仅逐事件判定'),
      text: z.boolean().optional().describe('true=返回人类可读报告；false=返回 JSON（默认 JSON）'),
      use_llm: z.boolean().optional().describe('true=对可疑事件做 LLM 行为级复核（默认 false 纯规则秒判）'),
    },
    handler: observeJudgeHandler,
  },
  {
    name: 'reconcile_chain',
    title: 'Reconcile a host chain with its real-run observe events (meso tier)',
    description:
      '中观档对账（工具可用性复盘缺口 C）：按「文件/宿主节点」一条命令的真跑 + 查数据 + 对账，' +
      '填补宏观（整项目对账）与微观（trace-exec 纯函数子集）之间的空档。' +
      '后工具自动前置 + 缓存跳过：宿主下无 detail 链时自动调用 deriveDetailChain 建链' +
      '（已有链则命中缓存跳过派生），自动发现被观测项目事件文件（.agent/observe + .design-canvas/observe），' +
      '按链涉及文件过滤出这条链的真跑事件 → judgeEvent 逐事件判定偏差 → rebuildChains 重建实测调用链' +
      '→ 链路契约匹配（声明链须是某条实测链的子序列，mode=bare-name 近似）。' +
      '该链无任何事件时 not_run=true 并明示「先跑一遍再对账」，绝不伪造事件降级冒充成品。' +
      '用途：重构前基线 + 重构后验收对照。',
    inputSchema: {
      feature: z.string().describe('DSL feature 名'),
      node_id: z.string().describe('宿主文件节点 id（detail 链挂在它下面，作为对账的链根）'),
      project_dir: z.string().describe('被观测项目根目录（其下 .agent/observe/events-*.jsonl 是事件源）'),
      events_files: z.array(z.string()).optional().describe('显式事件文件列表（缺省自动发现）'),
      force: z.boolean().optional().describe('true=忽略缓存强制重新派生链（默认 false，已有链则跳过派生）'),
      max_steps: z.number().optional().describe('派生入链函数上限（默认 12，仅需派生时生效）'),
    },
    handler: reconcileChainHandler,
  },
  {
    name: 'observe_instrument',
    title: 'Auto-instrument or restore a TS project',
    description:
      '对目标项目全自动 AST 插桩（函数出入口/return/catch/IO 写盘），幂等（已含探针文件跳过）。' +
      'action=uninstrument|restore 一键全拔（从自动备份拷回原文件、删备份目录、清理探针台账）。' +
      'dry_run=true 只预览不写盘。写盘前自动备份，git 可兜底。' +
      '写盘插桩成功后自动生成探针台账（data.ledger：全部探针点+统计，落盘 .design-canvas/observe-ledger.json）。' +
      '契约模式：contract_probes 传探针 id 数组（如 ["store.save.writefile"]）则只注入声明的探针点；' +
      '缺省/空数组则探索模式全量插桩（挖掘隐藏问题）。',
    inputSchema: {
      action: z
        .enum(['instrument', 'uninstrument', 'restore'])
        .optional()
        .describe('instrument=插桩（默认）；uninstrument/restore=一键全拔（还原+清台账）'),
      target: z.string().describe('要插桩/还原的目标项目目录'),
      dry_run: z.boolean().optional().describe('true=只预览探针点不写盘（默认 false）'),
      contract_probes: z
        .array(z.string())
        .optional()
        .describe('契约模式探针 id 数组（如 ["store.save.writefile"]），只注入这些探针点；缺省=探索模式全量插桩'),
      project_root: z.string().optional().describe('design-canvas 根（探针实现 src/observe/probe.js 所在仓库根），用于计算相对 import 路径，默认自动推断'),
    },
    handler: observeInstrumentHandler,
  },
  {
    name: 'edit_code',
    title: 'Symbol-level code editing (AST-located)',
    description:
      '符号级语义编辑：按 文件+符号名 定位函数/方法/类/接口，AST 确定边界后整体替换/插入/删除。' +
      '这是 Agent 第一性编辑路径——不依赖行号与 old_string 文本匹配，杜绝改错行/改错函数。' +
      '安全设计：编辑后 re-parse 整个文件，解析失败自动放弃（不写盘）；' +
      'replace 要求新代码解析出同名符号（防粘贴错函数）；同名多候选时报错列出签名行号，传 parent 消歧。' +
      '写盘后自动重建该文件索引（新鲜度闭环）。' +
      'op: replace（symbol 必填 + code 完整新定义）| insert（code 新符号，symbol 可选=锚点其后插入，缺省文件末尾；新文件也走 insert）| delete（symbol 必填）| range（显式行区间：start/end 必填 + code，不依赖符号）。' +
      'range：1-based 含端点的 start/end 行号 + code=区间新内容（传空串=删除区间）；dry_run=true 只出 diff 预览 + 语法门结果不写盘；' +
      '同 replace 的语法门兜底（编辑后 re-parse，新引入语法错误 → 拒绝不写盘），并列出区间穿透的符号供复核。' +
      '定位优先 qualified_name（如 Class.method），短名兜底；Go 方法用短名 + parent（receiver 类型）消歧。',
    inputSchema: {
      project_dir: z.string().describe('项目根目录（索引归属；编辑后重建该文件索引）'),
      file: z.string().describe('目标文件（相对 project_dir 或绝对路径）'),
      op: z.enum(['replace', 'insert', 'delete', 'range']).describe('replace=替换符号；insert=插入新符号；delete=删除符号；range=显式行区间替换'),
      symbol: z
        .string()
        .optional()
        .describe('目标符号：replace/delete 必填（qualified_name 优先，短名兜底）；insert 可选（锚点符号，其后插入；缺省=文件末尾）；range 不需要'),
      parent: z.string().optional().describe('符号父级（类名 / Go receiver 类型名），同名消歧'),
      code: z.string().optional().describe('replace/insert 的新代码（完整符号定义，含声明；insert 到新文件=全文）；range=区间新内容，传空串=删除区间'),
      start: z.number().int().min(1).optional().describe('range 专用：1-based 含端点起始行号'),
      end: z.number().int().min(1).optional().describe('range 专用：1-based 含端点结束行号'),
      dry_run: z.boolean().optional().describe('range 专用：true=只出 diff 预览 + 语法门结果，不写盘'),
    },
    handler: wrap(async (a) => editCode(a as never)),
  },
  {
    name: 'rename_many',
    title: 'Batch-rename local variables with scope isolation',
    description:
      '作用域感知的批量重命名：一次解析源码、合并多处编辑偏移后逆序统一生成，避免串行改名导致的偏移错位。' +
      '对文件中多个局部变量（含形参）同时改名，自动保证同作用域不撞名（clash 项按 changed=0 跳过并列出）。' +
      '输入 items=[{id,to}]，id 来自 suggest_renames / analyze_locals 的 LocalBinding.id，to 为合法标识符。' +
      '写盘前自动检查语法的工具请配合 edit_code；本品为纯表 → 只做折叠改写并写回原文件。',
    inputSchema: {
      project_dir: z.string().describe('目标项目根目录（用于解析 file 为绝对路径）'),
      file: z.string().describe('目标文件（相对 project_dir 或绝对路径）'),
      items: z
        .array(
          z.object({
            id: z.number().describe('LocalBinding.id（来自 suggest_renames 的 candidate.id 或 analyze_locals）'),
            to: z.string().describe('新变量名（必须为合法标识符 /^[A-Za-z_$][\\w$]*$/）'),
          }),
        )
        .describe('待重命名的目标数组'),
    },
    handler: wrap(async (a) => {
      const { project_dir, file, items } = a;
      const absPath = path.isAbsolute(file as string) ? (file as string) : path.resolve(String(project_dir), String(file));
      const src = readFileSync(absPath, 'utf-8');
      const { out, applied } = await renameMany(src, items as RenameItem[], absPath);
      const done = applied.filter((x) => x.changed > 0);
      if (done.length > 0) writeFileSync(absPath, out, 'utf-8');
      const skipped = applied.filter((x) => x.changed === 0);
      return {
        message:
          `批量重命名完成：成功 ${done.length} 项${skipped.length > 0 ? `，跳过 ${skipped.length} 项（非法名/撞名/原名相同）` : ''}。` +
          (skipped.length > 0 ? ` 跳过的项：${skipped.map((s) => `${s.from}→${s.to}`).join(', ')}` : ''),
        data: applied,
      };
    }),
  },
  {
    name: 'rename_symbol',
    title: 'Cross-file module-level symbol rename',
    description:
      '跨文件符号级改名：把改一个模块级导出符号从单文件局部变量升级为跨文件安全改名。' +
      '在定义文件上发起（file 必须是该符号的声明文件），改：定义名 + 同文件内对该符号的所有引用（含 export 列表）' +
      '+ 所有 import 该符号的文件里的 import 子句远程名与无别名使用点。' +
      '支持 function/const/class/interface/type/enum 模块级符号；class/enum 值+类型双栖都改，interface/type 只改类型引用。' +
      '安全性：import 别名使用点不动；被局部遮蔽处不改；任一 importer 撞名或遇到 export * 星号转发 → 原子阻断、全部不落盘。',
    inputSchema: {
      project_dir: z.string().describe('目标项目根目录（用于解析 file 为绝对路径）'),
      file: z.string().describe('定义符号的文件（相对 project_dir 或绝对路径；必须是该符号的声明文件，而非 import 它的文件）'),
      symbol: z.string().describe('旧符号名（模块级声明名/被 import 的远程名）'),
      to: z.string().describe('新符号名（必须为合法标识符 /^[A-Za-z_$][\\w$]*$/）'),
    },
    handler: wrap(async (a) => {
      const { project_dir, file, symbol, to } = a;
      const r = await renameSymbol({ project_dir: String(project_dir), file: String(file), symbol: String(symbol), to: String(to) });
      if (!r.ok) {
        return { message: `跨文件改名被阻断：\n- ${(r.blocked || []).join('\n- ')}`, data: r };
      }
      const parts = [`跨文件改名完成：${r.symbol} → ${r.to}`];
      if (r.definition) parts.push(`\t定义文件 ${r.definition.file}（${r.definition.edits} 处编辑，${r.definition.note}）`);
      if (r.importers && r.importers.length > 0) {
        parts.push(`\t影响 ${r.importers.length} 个导入文件：`);
        for (const i of r.importers) parts.push(`\t  - ${i.file}（${i.edits} 处编辑，${i.note}）`);
      } else {
        parts.push('\t无其它文件引用该符号');
      }
      return { message: parts.join('\n'), data: r };
    }),
  },
  {
    name: 'rename_file',
    title: 'File-level rename with import reference rewrite (防文件悬空)',
    description:
      '文件级智能重命名：把改一个文件的名字/路径做成全仓一致的安全操作。' +
      '过程=算影响面(干跑只报告) → 迁移文件 → 自动改写全项目解析到该文件的 import/require 源字面量 + 重索引。' +
      '安全：只改相对导入且确实解析到被移动文件的引用，注释/字符串/无关引用不碰；目标已存在或源缺失 → 原子阻断不落盘。' +
      'dry_run=true 时只返回将被改写的引用清单，不迁移、不改写、不重索引。' +
      '文件若是目录桶(index.ts)，会提示语义变化风险需复核。',
    inputSchema: {
      project_dir: z.string().describe('目标项目根目录（用于解析 from/to 为绝对路径）'),
      from: z.string().describe('源文件（相对 project_dir 或绝对路径）'),
      to: z.string().describe('目标文件（相对 project_dir 或绝对路径）'),
      dry_run: z.boolean().optional().describe('true = 只算影响面（不迁移/不改写/不重索引）'),
    },
    handler: wrap(async (a) => {
      const { project_dir, from, to, dry_run } = a;
      const r = await renameFile({ project_dir: String(project_dir), from: String(from), to: String(to), dry_run: !!dry_run });
      if (!r.ok) {
        return { message: `文件重命名被阻断：\n- ${(r.blocked || []).join('\n- ')}`, data: r };
      }
      const parts = [r.dryRun ? `[干跑] 计划把 ${r.fromRel} → ${r.toRel}` : `文件重命名完成：${r.fromRel} → ${r.toRel}`];
      if (r.moved) parts.push(`\t已 fs 迁移 + 重索引`);
      if (r.editCount === 0) parts.push('\t无其它文件引用该文件路径');
      else {
        parts.push(`\t改写 ${r.editCount} 处 import/require 引用：`);
        for (const f of r.references) parts.push(`\t  - ${f.file}  ${f.fromSource} → ${f.toSource}`);
      }
      if (r.pending && r.pending.length > 0) for (const p of r.pending) parts.push(`\t⚠ ${p}`);
      return { message: parts.join('\n'), data: r };
    }),
  },
  {
    name: 'remove_dead_imports',
    title: 'Remove dead imports reported by dead_deps',
    description:
      '移除死 import 执行器：把 dead_deps 报告的死三方依赖（DeadDepCandidate 列表，含 source + files）' +
      '从对应文件里删掉对应的 import/require/re-export 语句。Go 与 TS/JS 各形态都支持：' +
      '单行 import、块 import（删空块壳 `import (...) `）、别名/空导入 `_`/点导入 `.`、' +
      '具名/默认/命名空间/type/副作用 import、export * / export {...} from、CommonJS require。' +
      '保守规则：只删整条 import 语句；识别不出的形态不动；动态 import("x") 等使用点绝不碰。' +
      '原子性：预读全部待改文件，任一读取失败 → 整批中止、一个都不写。' +
      'dead 参数可直接传 dead_deps 工具返回结果里的 dead 数组。' +
      'verify=true（推荐）：启用改前/改后验证闭环——改写前先跑 build+test 基线，' +
      '改写后再跑同一批验证；基线失败则一个都不改，改后回归则自动回滚原位。' +
      'verify 也可传 { commands: [{label, cmd, args, timeoutMs}] } 自定义验证命令组（缺省按项目形态探测）' +
      '：有 go.mod → go build ./... + go test ./...；有 package.json → tsc --noEmit + npm test。' +
      'verify=false/缺省 = 只执行不验证。',
    inputSchema: {
      project_dir: z.string().describe('目标项目根目录（用于把 files 解析为绝对路径）'),
      dead: z
        .array(
          z.object({
            source: z.string().describe('死三方源，如 Go import 路径或 TS 模块说明符'),
            files: z.array(z.string()).describe('导入该源的闭包文件（相对 project_dir 或绝对路径）'),
            reason: z.enum(['no_reference', 'unreachable_only']).optional().describe('dead_deps 判定的死因，仅供记录'),
          }),
        )
        .describe('dead_deps 报告的 DeadDepCandidate 列表'),
      verify: z
        .union([
          z.boolean(),
          z.object({
            commands: z
              .array(
                z.object({
                  label: z.string().describe('命令标签（写进验证详情便于排查）'),
                  cmd: z.string().describe('可执行命令名，如 go / npm / npx'),
                  args: z.array(z.string()).describe('命令参数'),
                  timeoutMs: z.number().optional().describe('单命令超时（毫秒，默认 300000）'),
                }),
              )
              .optional()
              .describe('自定义验证命令组；缺省按项目形态自动探测'),
          }),
        ])
        .optional()
        .describe('true 启用改前/改后验证闭环；{commands} 自定义验证命令；缺省只执行不验证'),
    },
    handler: wrap(async (a) => {
      const { project_dir, dead, verify } = a;
      if (!Array.isArray(dead) || dead.length === 0) {
        return { message: '无可删除的死 import（dead 列表为空）', data: { files: [], files_changed: 0, statements_removed: 0, verification: { enabled: Boolean(verify), outcome: 'no_change', baseline: null, after: null } } };
      }
      const r = removeDeadImportsWithVerify({
        project_dir: String(project_dir),
        dead,
        verify: verify as RemoveDeadImportsVerifyOptions['verify'] | undefined,
      });
      const parts = [
        `移除死 import 完成：改写 ${r.files_changed} 个文件，删除 ${r.statements_removed} 条 import 语句。`,
      ];
      if (r.verification.enabled) {
        const v = r.verification;
        const kind =
          v.outcome === 'applied_verified' ? '改前/改后验证全绿，改动落盘'
          : v.outcome === 'baseline_fail' ? '改前基线失败——拒绝执行，未改动任何文件'
          : v.outcome === 'regression_rolled_back' ? '改后验证回归——已自动回滚原位'
          : v.outcome === 'no_change' ? '无实际变更，未改动文件'
          : '项目形态不可自动验证（无 go.mod/package.json）——已执行但未验证';
        parts.push(`\t[$kind] 基线=${v.baseline?.status ?? '-'} 改后=${v.after?.status ?? '-'}`);
        if (v.detail) parts.push(`\t详情：${v.detail}`);
      }
      if (r.files.length === 0) parts.push('\t没有命中任何可操作的文件（输入 dead 清单的文件均非 TS/Go 系）。');
      for (const f of r.files) {
        const detail = f.removals.filter((x) => x.changed).map((x) => `${x.source}×${x.removed}`).join('、') || '无变更';
        parts.push(`\t- ${f.file}（${f.lang}）：${detail}`);
      }
      return { message: parts.join('\n'), data: r };
    }),
  },
  {
    name: 'refactor_pipeline',
    title: 'Run deterministic refactor pipeline (dead imports + dead statements + package migration)',
    description:
      '确定性重构管线：把可自动执行的瘦身改写串成一条链，一次调用按序执行、统一增量验证、失败只回滚到最近绿点。' +
      '入口只跑一次改前基线（build+test），其后每步基于上一步已绿的内容只跑一次改后验证——不改动的步骤不验证（性能友好）。' +
      '内置步骤：' +
      '  1) dead_imports：一键自动检测并删除死 import——未给 dead 清单时自动调用 detect_dead_imports 做文件级扫描；' +
      '     给了清单则用给定清单（可直接用 dead_deps 的 dead 数组）。复用 removeDeadImports 同源规则删除指向死源的 import/require/re-export 语句。' +
      '  2) dead_statements：自动扫描（可选 files 收敛范围）删除 return/throw/continue 后不可达语句与死分支（TS/Go）。' +
      '  3) package_migration（包改名/提级）：把缺换代的包一次性涤荡干净——全项目 import 引用面重写（prefix→to）、' +
      '     package 声明改名（v2→hub，from_test→to_test）、import 别名清洗（hubv2→hub）；可选目录物理移动。' +
      '失败语义：某步改后验证回归 → 只还原该步预读的原始内容，回到上一步绿点，前面已绿的改动保留；管线结果 ok=false。' +
      '基线失败 → 一个文件都不改。verify=true 启用验证；{commands} 自定义命令组；缺省/verify=false 仅落盘不验证（not_verifiable）。' +
      'rename 步骤需人工候选，暂不内置。' +
      'result.stages[] 含每步 outcome（applied/no_change/rolled_back/not_verifiable/skipped）+ baseline/after 验证状态。',
    inputSchema: {
      project_dir: z.string().describe('目标项目根目录'),
      steps: z
        .object({
          dead_imports: z
            .object({
              enabled: z.boolean().optional().default(false).describe('是否启用死 import 移除步骤'),
              dead: z
                .array(
                  z.object({
                    source: z.string().describe('死三方源（Go import 路径或 TS 模块说明符）'),
                    files: z.array(z.string()).describe('导入该源的文件（相对 project_dir 或绝对路径）'),
                  }),
                )
                .optional()
                .describe('已检测的死依赖清单；直接用 dead_deps 结果 dead 数组，或省略（缺省自动文件级检测死 import，实现一键）'),
            })
            .optional(),
          dead_statements: z
            .object({
              enabled: z.boolean().optional().default(false).describe('是否启用死语句删除步骤（自动扫描）'),
              files: z.array(z.string()).optional().describe('收敛到指定文件（相对或绝对路径）；缺省递归扫全部 TS/Go 源'),
            })
            .optional(),
          package_migration: z
            .object({
              enabled: z.boolean().optional().default(false).describe('是否启用包改名/提级步骤'),
              moduleBase: z.string().describe('模块根，如 github.com/acme/widget/server'),
              prefix: z.string().describe('被改写的旧 import 前缀（相对 project_dir），如 internal/hub/v2'),
              to: z.string().describe('新 import 前缀（相对 project_dir），如 internal/hub'),
              packageRename: z
                .object({
                  from: z.string().describe('旧包名，如 v2'),
                  to: z.string().describe('新包名，如 hub'),
                })
                .optional()
                .describe('顶层源文件 package 声明改名；from_test 包自动改 to_test'),
              packageRenameDir: z
                .string()
                .optional()
                .describe('package 改名作用的物理目录（相对 project_dir）；缺省取 to'),
              sourceExts: z.array(z.string()).optional().describe('参与改写的源文件扩展名（缺省 .go/.ts/.tsx…）'),
              aliases: z
                .array(
                  z.object({
                    importPath: z.string().describe('重写后的规范化 import 路径'),
                    from: z.string().describe('现别名'),
                    to: z.string().describe('清洗目标名'),
                  }),
                )
                .optional()
                .describe('import 别名清洗：声明改名 + 用法重写'),
              skipDirs: z.array(z.string()).optional().describe('跳过目录名（缺省 node_modules/.git 等）'),
              packageRenameTopLevelOnly: z
                .boolean()
                .optional()
                .describe('只改直接位于 packageRenameDir 下的源文件（缺省 true）'),
            })
            .optional(),
        })
        .describe('按序执行的步骤开关（至少启用一个才有产出）'),
      verify: z
        .union([
          z.boolean(),
          z.object({
            commands: z
              .array(
                z.object({
                  label: z.string().describe('命令标签'),
                  cmd: z.string().describe('可执行命令名，如 go / npm / npx'),
                  args: z.array(z.string()).describe('命令参数'),
                  timeoutMs: z.number().optional().describe('单命令超时（毫秒，默认 300000）'),
                }),
              )
              .optional()
              .describe('自定义验证命令组；缺省按项目形态自动探测'),
          }),
        ])
        .optional()
        .describe('true 启用统一验证闭环；{commands} 自定义命令；缺省/verify=false 仅落盘不验证'),
    },
    handler: wrap(async (a) => {
      const project_dir = String(a.project_dir);
      const steps = a.steps as
        | {
            dead_imports?: { enabled?: boolean; dead?: Array<{ source: string; files: string[] }> };
            dead_statements?: { enabled?: boolean; files?: string[] };
            package_migration?: {
              enabled?: boolean;
              moduleBase: string;
              prefix: string;
              to: string;
              packageRename?: { from: string; to: string };
              packageRenameDir?: string;
              sourceExts?: string[];
              aliases?: Array<{ importPath: string; from: string; to: string }>;
              skipDirs?: string[];
              packageRenameTopLevelOnly?: boolean;
            };
          }
        | undefined;
      const verify = a.verify as Parameters<typeof runRefactorPipeline>[0]['verify'];
      const migrate = steps?.package_migration;
      const r = await runRefactorPipeline({
        project_dir,
        steps: {
          dead_imports: steps?.dead_imports?.enabled
            ? { enabled: true, dead: steps.dead_imports.dead ?? [] }
            : undefined,
          dead_statements: steps?.dead_statements?.enabled
            ? { enabled: true, files: steps.dead_statements.files }
            : undefined,
          package_migration: migrate?.enabled
            ? {
                enabled: true,
                migrate: {
                  moduleBase: migrate.moduleBase,
                  prefix: migrate.prefix,
                  to: migrate.to,
                  packageRename: migrate.packageRename,
                  packageRenameDir: migrate.packageRenameDir,
                  sourceExts: migrate.sourceExts,
                  aliases: migrate.aliases,
                  skipDirs: migrate.skipDirs,
                  packageRenameTopLevelOnly: migrate.packageRenameTopLevelOnly,
                },
              }
            : undefined,
        },
        verify,
      });

      const parts = [
        `确定性重构管线完成：全局 ${r.ok ? '通过' : '已停（存在回滚）'}，`,
        `共 ${r.planned_steps} 步，${r.total_files_changed} 个文件被改写，`,
        `删除 ${r.total_units_removed} 单位（import 语句×文件 / 死语句文件数）。`,
        `基线=${r.baseline?.status ?? '未验证'}`,
      ];
      for (const s of r.stages) {
        const kind =
          s.outcome === 'applied' ? '已落盘并通过改后验证'
          : s.outcome === 'no_change' ? '无实际改动'
          : s.outcome === 'rolled_back' ? '改后验证回归，已回滚到绿点'
          : s.outcome === 'not_verifiable' ? '未启用验证，已落盘'
          : '未启用';
        parts.push(`\t[${s.label}] ${s.outcome}——${kind}（改动 ${s.files_changed} 文件，${s.units_removed} 单位）`);
        if (!r.ok && s.outcome === 'rolled_back') parts.push(`\t\t回滚详情：${s.detail}`);
      }
      return { message: parts.join('\n'), data: r };
    }),
  },
  {
    name: 'suggest_renames',
    title: 'Suggest semantic names for short/unmeaningful variables',
    description:
      '智能化改名建议：识别文件中短名/无意义局部变量（含形参），结合纯逻辑候选识别 + LLM 命名建议，' +
      '为每个候选给出 suggested（建议新名）与 reason（理由）。' +
      'use_llm=true（默认）调 LLM 建议；false 或未配置 LLM 时降级为仅候选识别（suggested 留空）。' +
      '返回 candidates 含 id/name/kind/parentFunction/refs/declLine/suggested/reason，' +
      '可直接把 {id, suggested} 数组传给 rename_many 完成批量改名。',
    inputSchema: {
      project_dir: z.string().describe('目标项目根目录（用于解析 file 为绝对路径）'),
      file: z.string().describe('目标文件（相对 project_dir 或绝对路径）'),
      min_len: z.number().optional().default(2).describe('短名长度阈值（默认 2，≤min_len 视为短名候选）'),
      max: z.number().optional().default(40).describe('LLM 建议的候选数量上限（其余只识别不取名）'),
      use_llm: z.boolean().optional().default(true).describe('是否用 LLM 生成命名建议（默认 true；false/未配置 LLM 则降级为仅候选识别）'),
    },
    handler: wrapData(async (a) => {
      const { project_dir, file, min_len, max, use_llm } = a;
      const absPath = path.isAbsolute(file as string) ? (file as string) : path.resolve(String(project_dir), String(file));
      const src = readFileSync(absPath, 'utf-8');
      const opts: SuggestOptions = {
        max: typeof max === 'number' ? max : undefined,
        minLen: typeof min_len === 'number' ? min_len : undefined,
        llm: use_llm === false ? null : undefined,
      };
      const result = await suggestRenames(src, absPath, opts);
      return {
        message:
          `识别到 ${result.candidates.length} 个短名/无意义变量候选；` +
          `LLM 建议：${result.llm ? '已启用' : '未启用/降级'}${result.note ? `（${result.note}）` : ''}。` +
          `建议名可直接作为 rename_many 的 items 使用。`,
        data: result,
      };
    }),
  },
  {
    name: 'find_similar_names',
    title: 'Detect confusable similar names and disambiguate',
    description:
      '相似名称检测与一键消歧：识别同一函数内"易看错"的孪生名（仅大小写不同 / 数字后缀 count-count2 / ' +
      '相邻换位 typo total-totla / 小编辑距离），按相似度连通块聚类。每个 cluster 保留最清晰名 basis，' +
      '其余为待改名 offenders；use_llm=true（默认）请 LLM 为每个 offender 建议语义化且与 basis 明显区分的新名。' +
      'use_llm=false 或未配置 LLM 时降级为仅聚类（suggested 留空）。' +
      '返回 clusters（含 offenders.suggested 与 reason）+ 可直接喂给 rename_many 的 items 数组，' +
      '实现"检测→建议→批量改名"闭环。',
    inputSchema: {
      project_dir: z.string().describe('目标项目根目录（用于解析 file 为绝对路径）'),
      file: z.string().describe('目标文件（相对 project_dir 或绝对路径）'),
      max_clusters: z.number().optional().default(20).describe('LLM 处理的最大聚类数（其余仅检测不取名）'),
      use_llm: z.boolean().optional().default(true).describe('是否用 LLM 生成消歧新名（默认 true；false/未配置 LLM 则降级为仅聚类）'),
    },
    handler: wrapData(async (a) => {
      const { project_dir, file, max_clusters, use_llm } = a;
      const absPath = path.isAbsolute(file as string) ? (file as string) : path.resolve(String(project_dir), String(file));
      const src = readFileSync(absPath, 'utf-8');
      const opts = {
        maxClusters: typeof max_clusters === 'number' ? max_clusters : undefined,
        llm: use_llm === false ? null : undefined,
      };
      const result = await suggestDisambiguations(src, absPath, opts);
      const items = disambiguationItems(result);
      return {
        message:
          `识别到 ${result.clusters.length} 个相似名聚类；` +
          `LLM 消歧：${result.llm ? '已启用' : '未启用/降级'}${result.note ? `（${result.note}）` : ''}；` +
          `可直接改名的项 ${items.length} 条，已附在 data.items 供 rename_many 使用。`,
        data: { ...result, items },
      };
    }),
  },
  {
    name: 'refactor_judge',
    title: 'LLM review gate: collect issues, decide adopt/reject, escalate the unsure to human (via context/inbox)',
    description:
      'LLM 审闭环的裁决门：接受候选问题清单，逐条裁【采纳/驳回/不确定(+置信度+理由)】，' +
      '把"拿不定主意"的（uncertain）上抛回控制台/上下文（经 alert_inbox 入箱，下一次工具响应自动附带），' +
      '其余进 decided（adopt/reject）。' +
      '这是"用工具收集问题 → 问题回吐给 LLM → 再给人审"的最小闭环，无需交互审核 UI。' +
      '用法：给我 issues（type/file/desc/severity/evidence 数组）；不传 decide → 全部判"不确定"全部上抛（等 LLM/人拍板），' +
      '或传 decide 裁决器自动路由（adopt→做/继续，reject→忽略，unsure→上抛）。' +
      '返回 result：{ decided:{adopt,reject}, escalated, decisions, meta, review_prompt }，' +
      '其中 review_prompt 可直接贴给人看。',
    inputSchema: {
      project_dir: z.string().optional().describe('目标项目根目录（用于入箱定位；可省略）'),
      issues: z
        .array(
          z.object({
            type: z.string().describe('问题类型：dead_code/dead_import/mixed_signals/package_migration…'),
            file: z.string().optional().describe('关联文件'),
            desc: z.string().describe('人话描述'),
            severity: z.enum(['low', 'medium', 'high']).optional().describe('严重度，默认 medium'),
            evidence: z.string().optional().describe('支撑证据'),
            confidence: z.number().min(0).max(1).optional().describe('预备置信度'),
          }),
        )
        .describe('候选问题清单'),
      verdicts: z
        .array(
          z.object({
            issue_id: z.string().describe('对应 issue 的 id；缺省自动补 type#序号'),
            verdict: z.enum(['adopt', 'reject', 'unsure']).describe('采纳/驳回/拿不定主意'),
            reason: z.string().describe('一句话理由'),
            confidence: z.number().min(0).max(1).optional().describe('置信度 0..1'),
          }),
        )
        .optional()
        .describe('裁决结果；不传则全部判"不确定"上抛（最小形态）'),
      escalate_to_inbox: z.boolean().optional().default(true).describe('uncertain 是否入收件箱回上下文'),
    },
    handler: wrap(async (a) => {
      const issues = (a.issues as JudgeIssue[]) ?? [];
      const verdicts = a.verdicts as JudgeDecision[] | undefined;
      const result = await runRefactorJudge({
        project_dir: a.project_dir ? String(a.project_dir) : undefined,
        issues,
        // 传了 verdicts 就用它当裁决器，否则缺省（全部上抛）
        decide: verdicts ? () => verdicts : undefined,
        escalate_to_inbox: a.escalate_to_inbox !== false,
      });
      return { message: result.review_prompt, data: result };
    }),
  },
  {
    name: 'diagnose',
    title: 'Diagnose a symptom to root cause + evidence chain + impact + fix suggestions',
    description:
      '症状诊断：输入"症状"（报错信息 / stack trace / 测试失败输出 / 行为异常描述），' +
      '输出"根因 + 证据链 + 影响面 + 修改建议 + 验证方式"。' +
      '六步流水线：症状解析（正则提取 错误类型/文件:行/符号）→ 候选定位（查 .design-canvas/cache.db 符号缓存，' +
      'exact/file/FTS/anchor 四路）→ 调用链追溯（沿 call/type_ref/import 三类边双向 BFS）→ 影响面分析（复用 diff_impact）→ ' +
      '根因聚合（规则引擎先跑，LLM 可选把证据翻成人话根因，未配置自动降级）→ 验证建议（按项目类型给命令，只建议不执行）。' +
      '前置：目标项目需先运行 import_project 建立符号缓存，否则只能给文件级线索。' +
      'anchor 可选：用户已知的线索（文件路径或函数名）帮助聚焦。',
    inputSchema: {
      project_dir: z.string().describe('被诊断项目根目录（其下 .design-canvas/cache.db 是符号缓存，需先 import_project）'),
      symptom: z.string().describe('症状：报错信息 / stack trace / 测试失败输出 / 行为异常描述'),
      symptom_type: z.enum(['error', 'test_failure', 'behavior']).optional().describe('症状类型，缺省 auto 自动识别'),
      anchor: z.string().optional().describe('可选线索：文件路径或函数名，帮助聚焦定位'),
      max_depth: z.number().optional().describe('调用链追溯深度（默认 3）'),
    },
    handler: wrapData(async (a) => {
      const input = a as unknown as DiagnoseInput;
      const out = await runDiagnosis(input);
      return { message: formatDiagnoseText(out), data: out };
    }),
  },
  {
    name: 'canvas_notes',
    title: 'Manage canvas notes: read as work orders / update status / LLM decide',
    description:
      '画布批注统一入口（收敛 read/mark/decide_canvas_notes 三工具为 1 入口，action 分派）。' +
      'action=read 读某 feature 的画布批注，解析成 agent 工单（Markdown/JSON，按 open/done/rejected 分组）——定位待办；' +
      'action=mark 批量更新批注处理状态（updates=[{id,status}]，status ∈ open|done|rejected）——闭环"工单→处理→标记"；' +
      'action=decide 内置 LLM 决策器：读 open 批注逐单决策（change/done/reject），将"批注→改动提案"自动化（LLM 经网关 Key 池调度，未配置则停用）。',
    inputSchema: {
      action: z.enum(['read', 'mark', 'decide']).describe('read=读批注成工单 | mark=更新批注状态 | decide=LLM 决策批注并出提案'),
      feature: z.string().describe('feature 名（如 design-canvas）'),
      format: z.enum(['markdown', 'json']).default('markdown').optional().describe('read 用：markdown=工单文档（默认）/ json=结构化 JSON'),
      updates: z
        .array(
          z.object({
            id: z.string().describe('批注图元 id 或批注套 groupId'),
            status: z.enum(['open', 'done', 'rejected']).describe('目标状态'),
          }),
        )
        .optional()
        .describe('mark 用：待更新状态列表'),
      project_dir: z.string().optional().describe('decide 用：项目根目录（缺省用 dsl.source_root；目标文件相对此解析）'),
      max_file_lines: z.number().optional().describe('decide 用：喂给 LLM 的目标文件最大行数（默认 300）'),
      dry_run: z.boolean().optional().describe('decide 用：true=只出决策与提案，不落批注状态'),
    },
    handler: wrapData(async (a) => {
      const action = a.action as 'read' | 'mark' | 'decide';
      const feature = typeof a.feature === 'string' ? a.feature : '';
      if (!feature) return { message: '缺少 feature', isError: true };

      if (action === 'read') {
        const resolved = resolveCanvasNoteTargets(feature);
        const digest = renderCanvasNotesDigest(feature, resolved);
        const format = a.format === 'json' ? 'json' : 'markdown';
        return {
          message:
            format === 'json'
              ? digest.json
              : `${digest.markdown}\n\n（结构 JSON 见 data.notes / 传 format=json 直接取 JSON）`,
          data: {
            feature: digest.feature,
            generated_at: digest.generated_at,
            total: digest.total,
            open: digest.open,
            done: digest.done,
            rejected: digest.rejected,
            notes: JSON.parse(digest.json).items,
          },
        };
      }

      if (action === 'mark') {
        const updates = Array.isArray(a.updates) ? (a.updates as Array<{ id: string; status: 'open' | 'done' | 'rejected' }>) : [];
        if (updates.length === 0) return { message: '缺少 updates', isError: true };
        const dsl = getDSL(feature);
        if (!dsl) return { message: `feature "${feature}" 不存在`, isError: true };
        const before = (dsl.canvas_notes ?? []).length;
        dsl.canvas_notes = markCanvasNotesStatus(dsl, updates);
        saveDSL(dsl, 'status');
        return {
          message: `已更新 ${updates.length} 条批注状态（feature=${feature}，批注数 ${before}）`,
          data: { feature, updated: updates.length, notes: before },
        };
      }

      // decide
      const r = await decideCanvasNotes({
        feature,
        project_dir: typeof a.project_dir === 'string' && a.project_dir ? a.project_dir : undefined,
        max_file_lines: typeof a.max_file_lines === 'number' ? a.max_file_lines : undefined,
        dry_run: a.dry_run === true,
      });
      const summary =
        `open 工单 ${r.open} 条 → 决策完成：` +
        r.decisions.map((d) => `${d.note_id}=${d.action}${d.pending_change_id ? `(提案 ${d.pending_change_id})` : ''}`).join('、') +
        `；已提提案 ${r.proposed} 条，落状态 ${r.applied_statuses.length} 条。`;
      return {
        message: `${summary}\n（模式：${r.note}）`,
        data: r,
      };
    }),
  },
  {
    name: 'gateway_provider',
    title: 'Manage LLM gateway providers & usage (single entry)',
    description:
      '小网关供应商 + 用量统一入口（收敛原 gateway_* 4 工具为 1 入口，action 分派）：' +
      'action=list 列出已注册供应商（key 脱敏只露尾 4 位）+ 用量汇总；' +
      'action=upsert 注册/更新一个供应商到 Key 池（同供应商多 key 入一个池，调用时加权轮询 + 失败自动切下一个 key/供应商；' +
      'OpenAI 兼容协议 base_url 形如 https://api.openai.com/v1；已存在同 id 则按传入字段合并更新）；' +
      'action=delete 删除一个供应商及其 Key 池；' +
      'action=stats 用量监视（按 供应商+key 维度的调用数/token/费用(USD)/错误/延迟及汇总；reset=true 可清零统计）。',
    inputSchema: {
      action: z.enum(['list', 'upsert', 'delete', 'stats']).describe('list=列出供应商/用量 | upsert=注册或更新供应商 | delete=删除供应商 | stats=用量统计'),
      id: z.string().optional().describe('供应商唯一 id（upsert/delete 用：字母数字-_，如 agnes / openai / my-ollama）'),
      name: z.string().optional().describe('展示名（upsert）'),
      base_url: z.string().optional().describe('OpenAI 兼容 base url，不含 /chat/completions（upsert）'),
      model: z.string().optional().describe('默认模型（upsert）'),
      keys: z.array(z.string()).optional().describe('API Key 池，多个 key 一个池（upsert）'),
      weight: z.number().optional().describe('轮询权重，默认 1（upsert）'),
      price_prompt_per_1m: z.number().optional().describe('每 1M 输入 token 价格 USD（upsert）'),
      price_completion_per_1m: z.number().optional().describe('每 1M 输出 token 价格 USD（upsert）'),
      enabled: z.boolean().optional().describe('是否启用（upsert）'),
      reset: z.boolean().optional().describe('true=清零用量统计（stats）'),
    },
    handler: wrapData(async (a) => {
      const action = a.action as 'list' | 'upsert' | 'delete' | 'stats';
      if (action === 'list') {
        return { message: '小网关供应商清单（key 已脱敏）', data: { providers: listProvidersMasked(), stats: getStats().totals } };
      }
      if (action === 'upsert') {
        const r = upsertProvider({
          id: String(a.id ?? ''),
          name: typeof a.name === 'string' ? a.name : undefined,
          base_url: typeof a.base_url === 'string' ? a.base_url : undefined,
          model: typeof a.model === 'string' ? a.model : undefined,
          keys: Array.isArray(a.keys) ? a.keys.map(String) : undefined,
          weight: typeof a.weight === 'number' ? a.weight : undefined,
          price_prompt_per_1m: typeof a.price_prompt_per_1m === 'number' ? a.price_prompt_per_1m : undefined,
          price_completion_per_1m: typeof a.price_completion_per_1m === 'number' ? a.price_completion_per_1m : undefined,
          enabled: typeof a.enabled === 'boolean' ? a.enabled : undefined,
        });
        if (!r.ok) return { message: `保存失败：${r.error}`, isError: true };
        return { message: `供应商 ${a.id} 已保存（Key 池 ${Array.isArray(a.keys) ? a.keys.length : 0} 个）`, data: { ok: true } };
      }
      if (action === 'delete') {
        const r = deleteProvider(String(a.id ?? ''));
        if (!r.ok) return { message: `删除失败：${r.error}`, isError: true };
        return { message: `供应商 ${a.id} 已删除`, data: { ok: true } };
      }
      // stats
      if (a?.reset === true) {
        resetStats();
        return { message: '用量统计已清零', data: { per_key: [], totals: getStats().totals } };
      }
      const s = getStats();
      return {
        message: `用量汇总：${s.totals.calls} 次调用 / ${s.totals.prompt_tokens + s.totals.completion_tokens} tokens / $${s.totals.cost_usd.toFixed(4)} / 错误 ${s.totals.errors}`,
        data: s,
      };
    }),
  },
  {
    name: 'read_project_docs',
    title: 'Read project docs (per-project docs/ folder)',
    description:
      '读取某 feature 的项目文档夹（<project_dir>/docs/，或受管目录 .design-canvas/docs/<feature>/）。' +
      '三种用法：不带 name= 返回清单（含 frontmatter 关联标签与预览，供 agent 挑）；带 name= 返回单篇全文；' +
      '带 targets 返回命中该目标集（功能/步骤/文件）的文档正文（与 canvas_notes action=decide 的按批关联注入同一套匹配）。' +
      '项目文档可丢进项目仓库 docs/ 作为 LLM 决策背景（需求/设计约定/约定规范），' +
      'canvas_notes action=decide 会自动按批把命中文档注入决策上下文（TOC 全量 + 命中正文封顶）。',
    inputSchema: {
      feature: z.string().describe('feature 名（如 design-canvas）'),
      project_dir: z.string().optional().describe('项目根目录（缺省用 dsl.source_root）'),
      name: z.string().optional().describe('文档 id（相对 docs/ 的路径）；给则返回该篇全文'),
      targets: z
        .object({
          features: z.array(z.string()).optional().describe('功能名集合'),
          steps: z.array(z.string()).optional().describe('步骤标题集合'),
          files: z.array(z.string()).optional().describe('文件路径集合'),
        })
        .optional()
        .describe('按批匹配目标集：返回命中文档正文'),
    },
    handler: wrapData(async (a) => {
      const feature = typeof a.feature === 'string' ? a.feature : '';
      if (!feature) return { message: '缺少 feature', isError: true };
      const dsl = getDSL(feature);
      const projectDir = typeof a.project_dir === 'string' && a.project_dir ? a.project_dir : dsl?.source_root ?? '';
      const man = listProjectDocs(projectDir, feature);
      const name = typeof a.name === 'string' && a.name ? a.name : '';
      if (name) {
        const content = readProjectDoc(projectDir, feature, name);
        if (content === null) return { message: `文档不存在：${name}`, isError: true };
        return { message: `文档 \`${name}\`（${content.split('\n').length} 行）`, data: { id: name, content } };
      }
      const targets = a.targets && typeof a.targets === 'object' ? (a.targets as DocTargetSet) : undefined;
      if (targets && ((targets.features ?? []).length > 0 || (targets.steps ?? []).length > 0 || (targets.files ?? []).length > 0)) {
        const matched = matchDocsForTargets(man, targets);
        const block = buildDocsPromptBlock(man, targets);
        return {
          message: `命中 ${matched.length}/${man.docs.length} 篇文档（frontmatter/文件名匹配）`,
          data: { dir: man.dir, total: man.docs.length, matched: matched.map((d) => d.id), block },
        };
      }
      return {
        message: `项目文档 ${man.docs.length} 篇（${man.dir ?? '未找到 docs/ 目录'}）`,
        data: {
          dir: man.dir,
          total: man.docs.length,
          docs: man.docs.map((d) => ({ id: d.id, title: d.title, lines: d.lines, tagged: d.tagged, tags: d.tags })),
        },
      };
    }),
  },
];

// ─────────────────────────────────────────────────────────────
// 注册
// ─────────────────────────────────────────────────────────────

/** 注册全部主工具到 McpServer（旧工具名别名已于 2026-08-17 全部移除） */
export function registerAllTools(server: McpServer): void {
  for (const def of TOOL_DEFS) {
    server.registerTool(def.name, { title: def.title, description: def.description, inputSchema: def.inputSchema }, async (args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      // 狗食正式统计：记录每次工具调用的成败与子动作（失败静默，不阻断主流程）
      const t0 = Date.now();
      const r = await def.handler(a);
      recordDogfoodUsage({
        ts: new Date().toISOString(),
        tool: def.name,
        action: def.name === 'explore_code'
          ? (typeof a.action === 'string' ? a.action : undefined)
          : def.name === 'edit_code'
            ? (typeof a.op === 'string' ? a.op : undefined)
            : undefined,
        ok: !r.isError,
        ms: Date.now() - t0,
        err: r.isError ? (r.text ?? '').slice(0, 200) : undefined,
      });
      // 响应注入：① 陈旧构建警告（dist 重建后进程仍跑旧代码 → 明确提示重启，防误信旧结果）
      //          ② watch 产出的未读影响提醒借力本次响应自动送达（MCP 无服务端推送的替代通道）。
      //            方向 E：本地 inbox（降级路径）+ daemon 游标拉取（权威路径）合并注入
      return textOut(r.text + staleBuildWarning() + await collectPendingAlertText(def.name), r.isError);
    });
  }
}

export { TOOL_DEFS };

