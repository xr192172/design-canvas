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
import { harvestClosure } from './tools/harvest_closure.js';
import type { HarvestClosureInput } from './tools/harvest_closure.js';
import { extractContracts } from './tools/extract_contracts.js';
import type { ExtractContractsInput } from './tools/extract_contracts.js';
import { validateReason } from './tools/reason_validator.js';
import type { ReasonEvidenceRef } from './tools/reason_validator.js';
import { loadTraceRecords, buildTraceResolver } from './tools/trace_evidence.js';
import { getDSLByView, getLiveDir } from './storage.js';
import { getProjectCacheDb } from './db/db.js';
import { recordDogfoodUsage } from './tools/dogfood_stats.js';
import { queryCameraLog } from './camera/log_query.js';
import { normalizeEvents, judgeEvents, judgeEventsWithLLM, renderJudgeReport } from './camera/judge_service.js';
import { TSComparator, renderTSDiffReport, type TSDLDecl, type TSDiffReport } from './camera/contract.js';
import { rebuildChains } from './camera/chain.js';
import {
  instrumentProject,
  collectTsFiles,
  restoreInstrumented,
} from './camera/instrument.js';
import path from 'node:path';
import { statSync } from 'node:fs';
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
 * 重启警告。开销 = 每调用一次 stat，可忽略。
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

/** dist 已更新（进程仍在跑旧代码）时返回重启警告，否则空串。 */
function staleBuildWarning(): string {
  if (SELF_MTIME_MS === null || SELF_PATH === null) return '';
  const cur = safeMtimeMs(SELF_PATH);
  if (cur !== null && cur > SELF_MTIME_MS) {
    return (
      '\n⚠️ STALE BUILD：dist 已在本进程启动后重建，当前响应来自旧代码——' +
      '新增工具/字段/参数可能缺失或报"未知"错误。请重启 design-canvas MCP server 后再执行写操作。'
    );
  }
  return '';
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

/** 包装一个同步/异步纯函数调用为 handler（统一 try/catch + 陈旧构建警告） */
function wrap(
  fn: (args: Record<string, unknown>) => { message: string; data?: unknown } | Promise<{ message: string; data?: unknown }>,
): ToolDef['handler'] {
  return async (args) => {
    try {
      const r = await fn(args);
      return { text: r.message + staleBuildWarning() };
    } catch (e) {
      return { text: (e as Error).message + staleBuildWarning(), isError: true };
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
      const warn = staleBuildWarning();
      if (warn) parts.push(warn);
      return { text: parts.join('\n') };
    } catch (e) {
      return { text: (e as Error).message + staleBuildWarning(), isError: true };
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

// ─────────────────────────────────────────────────────────────
// Camera 观测工具 handler（设计→开发→测试闭环的「测试」端）
// 与 design 主工具并列同一套 MCP。底层复用 camera/* 纯函数，不重写逻辑。
// ─────────────────────────────────────────────────────────────

/** camera_log：按文件/全量查询 Camera 运行日志（复用 queryCameraLog） */
const cameraLogHandler = wrap(async (a) => {
  const eventsFile = a.events_file as string | undefined;
  if (!eventsFile) {
    throw new Error('camera_log 需要 events_file 参数：传 Camera 事件文件路径（events.jsonl）。');
  }
  const files = Array.isArray(a.files) ? (a.files as string[]).filter(Boolean) : [];
  const all = a.all === true || a.all === 'true' || a.all === '1';
  const r = queryCameraLog(eventsFile, { files, all });
  const lines = [
    `Camera 日志 [${r.eventsPath}]`,
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

/** camera_judge：对一批事件执行偏差判定。decls（可选）提供时额外执行 P2 链路契约判定——
 * 重建实测调用链（trace 三元组）+ Comparator 全量对比（探针级 + 链路级），
 * 链路断裂（chain-broken）带 trace_id 与实测窗口。不传 decls 保持逐事件判定。 */
const cameraJudgeHandler = wrap(async (a) => {
  const events = a.events;
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('camera_judge 需要 events 参数：传要判定的事件数组（符合 TSEvent 形状）。');
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

/** camera_instrument：对目标项目全自动插桩 / 还原（复用 instrumentProject/restoreInstrumented） */
const cameraInstrumentHandler = wrap(async (a) => {
  const target = a.target as string | undefined;
  if (!target) {
    throw new Error('camera_instrument 需要 target 参数：传要插桩的项目目录。');
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
    if (restored.length === 0) {
      return { message: 'Camera 还原：未找到备份，无需还原（可能从未插桩，或备份已删）。', data: [] };
    }
    return {
      message: `Camera 还原：已还原 ${restored.length} 个文件并删除备份目录。\n${restored.map((f) => `  ↺ ${f}`).join('\n')}`,
      data: restored,
    };
  }

  const files = collectTsFiles(target);
  const results = await instrumentProject(target, { projectRoot, write: !dryRun, contractProbes });
  let totalSites = 0;
  let instrumented = 0;
  let skipped = 0;
  let errors = 0;
  const mode = contractProbes ? `契约模式（${contractProbes.length} 个探针）` : '探索模式（全量插桩）';
  const lines = [`Camera 插桩 [${mode}] ${dryRun ? 'DRY-RUN' : 'WRITE'} → ${target}`, `  扫描 ${files.length} 个 .ts 文件`];
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
  return { message: lines.join('\n'), data: results };
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
      '语义搜索/影响分析/架构分层/导览/巨石分析/拆分/变形链/动画流/算法/注入回放/仿真/文件监听。' +
      'args 为各 action 的具体参数。' +
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
      '积木契约提取（Brick Harvest Phase 2，静态阶段）：给项目文件生成 BrickContract——' +
      'role（业务/功能二分：依赖方向图算法，零 token，"功能不依赖业务，业务组装功能"）、' +
      'shapes（struct/interface/class 数据形状+字段，结构化类型匹配的判定单元）、' +
      'effects.reads_config（env/flag 读取点=积木出厂环境要求）。' +
      '提供 feature 时写回 DSL 的 SemanticFile.contract（write_dsl=false 可只读预演）。' +
      'writes/holds/emits 留待 camera 运行证据（Phase 2b）。LLM 不产生事实：结构化字段只接受 AST/camera 源。' +
      '规划见 docs/plans/2026-08-19-cross-project-brick-harvest.md Phase 2.5。',
    inputSchema: {
      project_dir: z.string().describe('目标项目根目录（其下 .design-canvas/cache.db 是符号缓存，需先 import_project）'),
      feature: z.string().optional().describe('提供时把 contract 写回该 feature 的 DSL（SemanticFile.contract）'),
      files: z
        .array(z.string())
        .optional()
        .describe('限定提取范围的文件（相对项目根）；缺省 = 全部已索引文件'),
      write_dsl: z.boolean().optional().describe('默认 true 写回 DSL；false = 只读预演（dry-run）'),
    },
    handler: wrapData(async (a) => {
      const r = extractContracts(a as unknown as ExtractContractsInput);
      return { message: r.message, data: r };
    }),
  },
  {
    name: 'camera_log',
    title: 'Query Camera runtime logs by file',
    description:
      '查询 Camera 运行时日志（events.jsonl）。可传 files 按文件路径过滤（精确/后缀/包含匹配），' +
      '只返回命中路径的事件；不传 files 时默认只返回偏差，all=true 才全量。' +
      '适用于：LLM 按需拉取某文件/某条链路的数据流与异常，而非全量丢出。',
    inputSchema: {
      events_file: z
        .string()
        .describe('Camera 事件文件路径（events.jsonl）。由插桩/哨兵运行时产生，如 <dataHome>/.design-canvas/camera/events.jsonl'),
      files: z
        .array(z.string())
        .optional()
        .describe('按文件路径过滤（可多个）。传相对路径/文件名片段均可，精确或后缀/包含匹配'),
      all: z
        .boolean()
        .optional()
        .describe('不传 files 时：true=列出全部事件；false=只列偏差（默认）'),
    },
    handler: cameraLogHandler,
  },
  {
    name: 'camera_judge',
    title: 'Judge a batch of Camera events',
    description:
      '对一批 Camera 事件执行偏差判定（语言无关）。传 events 数组（符合 TSEvent 形状：probe/fields[err/op/benign]，可含 trace_id/frame_id）。' +
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
    handler: cameraJudgeHandler,
  },
  {
    name: 'camera_instrument',
    title: 'Auto-instrument or restore a TS project',
    description:
      '对目标项目全自动 AST 插桩（函数出入口/return/catch/IO 写盘），幂等（已含探针文件跳过）。' +
      'action=uninstrument|restore 一键还原（从自动备份拷回原文件并删备份目录）。' +
      'dry_run=true 只预览不写盘。写盘前自动备份，git 可兜底。' +
      '契约模式：contract_probes 传探针 id 数组（如 ["store.save.writefile"]）则只注入声明的探针点；' +
      '缺省/空数组则探索模式全量插桩（挖掘隐藏问题）。',
    inputSchema: {
      action: z
        .enum(['instrument', 'uninstrument', 'restore'])
        .optional()
        .describe('instrument=插桩（默认）；uninstrument/restore=还原'),
      target: z.string().describe('要插桩/还原的目标项目目录'),
      dry_run: z.boolean().optional().describe('true=只预览探针点不写盘（默认 false）'),
      contract_probes: z
        .array(z.string())
        .optional()
        .describe('契约模式探针 id 数组（如 ["store.save.writefile"]），只注入这些探针点；缺省=探索模式全量插桩'),
      project_root: z.string().optional().describe('design-canvas 根（探针实现 src/camera/probe.js 所在仓库根），用于计算相对 import 路径，默认自动推断'),
    },
    handler: cameraInstrumentHandler,
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
      'op: replace（symbol 必填 + code 完整新定义）| insert（code 新符号，symbol 可选=锚点其后插入，缺省文件末尾；新文件也走 insert）| delete（symbol 必填）。' +
      '定位优先 qualified_name（如 Class.method），短名兜底；Go 方法用短名 + parent（receiver 类型）消歧。',
    inputSchema: {
      project_dir: z.string().describe('项目根目录（索引归属；编辑后重建该文件索引）'),
      file: z.string().describe('目标文件（相对 project_dir 或绝对路径）'),
      op: z.enum(['replace', 'insert', 'delete']).describe('replace=替换符号；insert=插入新符号；delete=删除符号'),
      symbol: z
        .string()
        .optional()
        .describe('目标符号：replace/delete 必填（qualified_name 优先，短名兜底）；insert 可选（锚点符号，其后插入；缺省=文件末尾）'),
      parent: z.string().optional().describe('符号父级（类名 / Go receiver 类型名），同名消歧'),
      code: z.string().optional().describe('replace/insert 的新代码（完整符号定义，含声明；insert 到新文件=全文）'),
    },
    handler: wrap(async (a) => editCode(a as never)),
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
      // 响应注入：watch 产出的未读影响提醒借力本次响应自动送达（MCP 无服务端推送的替代通道）。
      // 方向 E：本地 inbox（降级路径）+ daemon 游标拉取（权威路径）合并注入
      return textOut(r.text + await collectPendingAlertText(def.name), r.isError);
    });
  }
}

export { TOOL_DEFS };
