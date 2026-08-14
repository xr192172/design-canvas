/**
 * server_registry：MCP 工具注册表（路线图序号 2 收敛）
 *
 * 统一注册 8 个主工具 + 旧工具别名（兼容存量会话/脚本/文档）。
 *
 * 设计：
 * - 每个工具定义 = { name, title, description, inputSchema, handler }
 * - handler(args) 返回 MCP content 数组（text + isError）
 * - ALIASES 把旧工具名映射到某个主工具的 handler + 参数适配器
 * - 主工具走强 hutong schema；explore_code/manage_feature 用宽松 record，内部强校验
 *
 * 主工具 handler 复用现有纯函数（src/tools/*.ts），不重写业务逻辑，因此
 * 500+ 单测（针对纯函数）不受影响。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { renderDsl } from './tools/render_dsl.js';
import { exportSvg, exportMarkdown } from './tools/export.js';
import { queryFeature } from './tools/query_feature.js';
import { updateFeature } from './tools/update_feature.js';
import { scaffold } from './tools/scaffold.js';
import { checkStatus } from './tools/status_tools.js';
import { backfillScaffold } from './tools/backfill.js';
import { checkConsistency } from './tools/consistency.js';
import { exploreCode, EXPLORE_ACTIONS } from './tools/explore_code.js';
import { importProject } from './tools/import_project.js';
import type { ImportProjectInput } from './tools/import_project.js';
import { manageFeature, MANAGE_ACTIONS } from './tools/manage_feature.js';
import { addAnnotationByTool, resolveAnnotation } from './tools/annotation_tools.js';
import { dagLayout, forceLayout, gridAlign } from './tools/dag_layout.js';
import { submitApproval, reviewAnnotation } from './tools/approval.js';
import { saveSnapshot, rollbackSnapshot, deleteSnapshot } from './tools/snapshot.js';
import { diffViews } from './tools/diff_views.js';
import { validateReason } from './tools/reason_validator.js';
import type { ReasonEvidenceRef } from './tools/reason_validator.js';
import { loadTraceRecords, buildTraceResolver } from './tools/trace_evidence.js';
import { getDSLByView, getLiveDir } from './storage.js';
import { queryCameraLog } from './camera/log_query.js';
import { normalizeEvents, judgeEvents, renderJudgeReport } from './camera/judge_service.js';
import {
  instrumentProject,
  collectTsFiles,
  restoreInstrumented,
} from './camera/instrument.js';
import path from 'node:path';

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

/** 包装一个同步/异步纯函数调用为 handler（统一 try/catch） */
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
        '要重建实际视图请用 explore_code action=import / watch。',
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
  return updateFeature(a as never);
});

/** manage_feature：生命周期 */
const manageFeatureHandler = wrap(async (a) => manageFeature(a as never));

/** render_dsl：渲染 HTML/SVG/Markdown（format 参数聚合三个导出；view 决定渲染设计或实际视图） */
const renderDslHandler = wrap(async (a) => {
  const format = typeof a.format === 'string' ? a.format : 'html';
  const feature = a.feature as string;
  const view = a.view === 'live' ? 'live' : 'design';
  const output_path = typeof a.output_path === 'string' ? a.output_path : undefined;
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

/** explore_code：参数化代码理解 */
const exploreCodeHandler = wrap(async (a) => {
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

/** camera_judge：对一批事件执行偏差判定（复用 normalizeEvents + judgeEvents） */
const cameraJudgeHandler = wrap(async (a) => {
  const events = a.events;
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('camera_judge 需要 events 参数：传要判定的事件数组（符合 TSEvent 形状）。');
  }
  const { events: norm, error } = normalizeEvents(events);
  if (error) throw new Error(error);
  const report = judgeEvents(norm);
  const text = a.text === true || a.text === '1' ? renderJudgeReport(report) : JSON.stringify(report);
  return { message: text, data: report };
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
  const results = await instrumentProject(target, { projectRoot, write: !dryRun });
  let totalSites = 0;
  let instrumented = 0;
  let skipped = 0;
  let errors = 0;
  const lines = [`Camera 插桩 [${dryRun ? 'DRY-RUN' : 'WRITE'}] → ${target}`, `  扫描 ${files.length} 个 .ts 文件`];
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
      'node（单个节点详情，需 node_id）/ files（语义文件摘要列表，支持 file_layer/file_status 过滤）/ ' +
      'file（单个文件详情，需 file_id，含 expected_apis/actual_apis/deps）/ ' +
      'annotations（标注）/ approvals（审批）/ approval_history（审批历史，需 annotation_id）/ ' +
      'snapshots（快照）/ templates（模板）/ simulation_state（仿真状态）/ diff（对比，需 feature_a+feature_b）。' +
      'view: design（默认，活态设计）/ live（实际代码快照，仅 query=dsl/nodes/edges/node/files/file 生效，用于对比设计 vs 代码现状）。',
    inputSchema: {
      query: z
        .enum(['dsl', 'features', 'nodes', 'edges', 'node', 'files', 'file', 'annotations', 'approvals', 'approval_history', 'snapshots', 'templates', 'simulation_state', 'diff'])
        .describe('查询类型：dsl=完整DSL, features=feature列表, nodes=节点摘要, edges=边摘要, node=节点详情, files=文件摘要, file=文件详情, annotations=标注, approvals=审批, approval_history=审批历史, snapshots=快照, templates=模板, simulation_state=仿真状态, diff=对比'),
      view: z.enum(['design', 'live']).default('design').describe('视图层级：design=设计视图（默认），live=实际代码快照'),
      feature: z.string().optional().describe('feature 名（nodes/edges/node/files/file/annotations/approvals 等需要）'),
      node_id: z.string().optional().describe('query=node 时：节点 ID'),
      file_id: z.string().optional().describe('query=file 时：文件 ID（对应 SemanticFile.id = geometry Node.id）'),
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
    title: 'Render design DSL to HTML/SVG/Markdown',
    description:
      '渲染设计 DSL：format=html（默认，自包含单 HTML，内联 CSS+JS）/ svg（矢量图）/ markdown（可读设计文档）。' +
      'html 模式可直接传 dsl_json 渲染，或用 feature+view 从存储读取。' +
      'view: design（默认，渲染设计视图「🎭 设计」）/ live（渲染实际视图「⚡ 实际」，不写回设计层）。',
    inputSchema: {
      feature: z.string().optional().describe('feature 名（html 用 feature+view 读取，或 svg/markdown 模式用）'),
      view: z.enum(['design', 'live']).default('design').describe('视图层级：design=设计视图（默认），live=实际代码快照'),
      format: z.enum(['html', 'svg', 'markdown']).optional().describe('输出格式，默认 html'),
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
    name: 'explore_code',
    title: 'Explore, analyze and understand code',
    description:
      '代码理解统一入口：通过 action 参数化执行各类分析。' +
      `action: ${EXPLORE_ACTIONS.join(' / ')}。` +
      '语义搜索/影响分析/架构分层/导览/巨石分析/拆分/变形链/动画流/算法/注入回放/仿真/文件监听。' +
      'args 为各 action 的具体参数。',
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
      '对一批 Camera 事件执行偏差判定（语言无关）。传 events 数组（符合 TSEvent 形状：probe/fields[err/op/benign]）。' +
      '返回逐条判定 + 汇总（total/ok/deviation）。text=true 返回人类可读报告，否则返回 JSON。' +
      '适用于：探针语言任意，统一收敛到这一处判定，不随语言复刻规则。',
    inputSchema: {
      events: z
        .array(z.record(z.string(), z.unknown()))
        .describe('要判定的事件数组（TSEvent 形状：probe 必填，fields 含 err/op/benign）'),
      text: z.boolean().optional().describe('true=返回人类可读报告；false=返回 JSON（默认 JSON）'),
    },
    handler: cameraJudgeHandler,
  },
  {
    name: 'camera_instrument',
    title: 'Auto-instrument or restore a TS project',
    description:
      '对目标项目全自动 AST 插桩（函数出入口/return/catch/IO 写盘），幂等（已含探针文件跳过）。' +
      'action=uninstrument|restore 一键还原（从自动备份拷回原文件并删备份目录）。' +
      'dry_run=true 只预览不写盘。写盘前自动备份，git 可兜底。',
    inputSchema: {
      action: z
        .enum(['instrument', 'uninstrument', 'restore'])
        .optional()
        .describe('instrument=插桩（默认）；uninstrument/restore=还原'),
      target: z.string().describe('要插桩/还原的目标项目目录'),
      dry_run: z.boolean().optional().describe('true=只预览探针点不写盘（默认 false）'),
      project_root: z.string().optional().describe('design-canvas 根（探针实现 src/camera/probe.js 所在仓库根），用于计算相对 import 路径，默认自动推断'),
    },
    handler: cameraInstrumentHandler,
  },
];

// ─────────────────────────────────────────────────────────────
// 别名：旧工具名 → 主工具 handler + 参数适配
// ─────────────────────────────────────────────────────────────

/**
 * 别名工具的宽松入参 schema。
 * 注意：不能传空 schema `{}`——SDK 会把 raw shape 转成 `z.object({})`，默认 strip 未知键，
 * 导致别名调用参数被清空（handler 收到 undefined）。用 `z.record` 透传任意键、不做校验，
 * 具体参数校验交给 adapter 指向的主工具 handler。
 */
const LOOSE_INPUT_SCHEMA = z.record(z.string(), z.unknown());

/** 别名定义：name 为旧工具名，target 为主工具名，adapter 把旧参数转成主工具 handler 参数 */
interface AliasDef {
  name: string;
  description: string;
  target: string;
  adapter: (args: Record<string, unknown>) => Record<string, unknown>;
}

const ALIASES: AliasDef[] = [
  // get_dsl 家族（query_feature 原名保留）
  { name: 'query_feature', description: '别名 → get_dsl', target: 'get_dsl', adapter: (a) => a },
  // edit_dsl 家族
  { name: 'update_feature', description: '别名 → edit_dsl', target: 'edit_dsl', adapter: (a) => a },
  // manage_feature 家族
  {
    name: 'create_feature',
    description: '别名 → manage_feature(action=create)',
    target: 'manage_feature',
    adapter: (a) => ({ action: 'create', args: { feature: a.feature, title: a.title } }),
  },
  {
    name: 'clone_feature',
    description: '别名 → manage_feature(action=clone)',
    target: 'manage_feature',
    adapter: (a) => ({ action: 'clone', args: { source_feature: a.source_feature, target_feature: a.target_feature, title: a.title } }),
  },
  {
    name: 'create_from_template',
    description: '别名 → manage_feature(action=template)',
    target: 'manage_feature',
    adapter: (a) => ({ action: 'template', args: { template_id: a.template_id, feature: a.feature, title: a.title } }),
  },
  // render_dsl 家族
  {
    name: 'export_svg',
    description: '别名 → render_dsl(format=svg)',
    target: 'render_dsl',
    adapter: (a) => ({ feature: a.feature, format: 'svg', output_path: a.output_path }),
  },
  {
    name: 'export_markdown',
    description: '别名 → render_dsl(format=markdown)',
    target: 'render_dsl',
    adapter: (a) => ({ feature: a.feature, format: 'markdown', output_path: a.output_path }),
  },
  // scaffold 家族
  {
    name: 'check_status',
    description: '别名 → scaffold',
    target: 'scaffold',
    adapter: (a) => a,
  },
  // explore_code 家族：把旧工具名/参数映射到 action + args
  {
    name: 'import_project',
    description: '别名 → importProject（独立工具，不再经 explore_code 分发）',
    target: 'import_project',
    adapter: (a) => a,
  },
  {
    name: 'semantic_search',
    description: '别名 → explore_code(action=semantic_search)',
    target: 'explore_code',
    adapter: (a) => ({ action: 'semantic_search', args: a }),
  },
  {
    name: 'diff_impact',
    description: '别名 → explore_code(action=diff_impact)',
    target: 'explore_code',
    adapter: (a) => ({ action: 'diff_impact', args: a }),
  },
  {
    name: 'arch_layer',
    description: '别名 → explore_code(action=arch_layer)',
    target: 'explore_code',
    adapter: (a) => ({ action: 'arch_layer', args: a }),
  },
  {
    name: 'guided_tour',
    description: '别名 → explore_code(action=guided_tour)',
    target: 'explore_code',
    adapter: (a) => ({ action: 'guided_tour', args: a }),
  },
  {
    name: 'check_monolith',
    description: '别名 → explore_code(action=check_monolith)',
    target: 'explore_code',
    adapter: (a) => ({ action: 'check_monolith', args: a }),
  },
  {
    name: 'analyze_monolith',
    description: '别名 → explore_code(action=analyze_monolith)',
    target: 'explore_code',
    adapter: (a) => ({ action: 'analyze_monolith', args: a }),
  },
  {
    name: 'derive_split',
    description: '别名 → explore_code(action=derive_split)',
    target: 'explore_code',
    adapter: (a) => ({ action: 'derive_split', args: a }),
  },
  {
    name: 'derive_detail_chain',
    description: '别名 → explore_code(action=derive_detail_chain)',
    target: 'explore_code',
    adapter: (a) => ({ action: 'derive_detail_chain', args: a }),
  },
  {
    name: 'derive_anim_flow',
    description: '别名 → explore_code(action=derive_anim_flow)',
    target: 'explore_code',
    adapter: (a) => ({ action: 'derive_anim_flow', args: a }),
  },
  {
    name: 'derive_algorithm',
    description: '别名 → explore_code(action=derive_algorithm)',
    target: 'explore_code',
    adapter: (a) => ({ action: 'derive_algorithm', args: a }),
  },
  {
    name: 'inject_replay',
    description: '别名 → explore_code(action=inject_replay)',
    target: 'explore_code',
    adapter: (a) => ({ action: 'inject_replay', args: a }),
  },
  {
    name: 'run_simulation',
    description: '别名 → explore_code(action=run_simulation)',
    target: 'explore_code',
    adapter: (a) => ({ action: 'run_simulation', args: a }),
  },
  {
    name: 'reset_simulation',
    description: '别名 → explore_code(action=reset_simulation)',
    target: 'explore_code',
    adapter: (a) => ({ action: 'reset_simulation', args: a }),
  },
  {
    name: 'watch_project',
    description: '别名 → explore_code(action=watch)',
    target: 'explore_code',
    adapter: (a) => ({ action: 'watch', args: a }),
  },
  // 尚未吸收进 edit_dsl 的旧写工具：直接复用原纯函数（后续 Step 2 并入 edit_dsl）
  {
    name: 'add_annotation',
    description: '别名 → 原 add_annotation（后续并入 edit_dsl）',
    target: 'add_annotation',
    adapter: (a) => a,
  },
  {
    name: 'resolve_annotation',
    description: '别名 → 原 resolve_annotation（后续并入 edit_dsl）',
    target: 'resolve_annotation',
    adapter: (a) => a,
  },
  {
    name: 'dag_layout',
    description: '别名 → 原 dag_layout（后续并入 edit_dsl）',
    target: 'dag_layout',
    adapter: (a) => a,
  },
  {
    name: 'force_layout',
    description: '别名 → 原 force_layout（后续并入 edit_dsl）',
    target: 'force_layout',
    adapter: (a) => a,
  },
  {
    name: 'grid_align',
    description: '别名 → 原 grid_align（后续并入 edit_dsl）',
    target: 'grid_align',
    adapter: (a) => a,
  },
  {
    name: 'submit_approval',
    description: '别名 → 原 submit_approval（后续并入 edit_dsl）',
    target: 'submit_approval',
    adapter: (a) => a,
  },
  {
    name: 'review_annotation',
    description: '别名 → 原 review_annotation（后续并入 edit_dsl）',
    target: 'review_annotation',
    adapter: (a) => a,
  },
  {
    name: 'save_snapshot',
    description: '别名 → 原 save_snapshot（后续并入 edit_dsl）',
    target: 'save_snapshot',
    adapter: (a) => a,
  },
  {
    name: 'rollback_snapshot',
    description: '别名 → 原 rollback_snapshot（后续并入 edit_dsl）',
    target: 'rollback_snapshot',
    adapter: (a) => a,
  },
  {
    name: 'delete_snapshot',
    description: '别名 → 原 delete_snapshot（后续并入 edit_dsl）',
    target: 'delete_snapshot',
    adapter: (a) => a,
  },
];

// ─────────────────────────────────────────────────────────────
// 注册
// ─────────────────────────────────────────────────────────────

/** handler 索引：target 名 → handler */
const handlerByTarget = new Map<string, ToolDef['handler']>();
for (const def of TOOL_DEFS) handlerByTarget.set(def.name, def.handler);

/** 遗留工具 handler（尚未吸收进 8 主工具，先保兼容，后续 Step 2 并入 edit_dsl） */
const LEGACY_HANDLERS: Record<string, ToolDef['handler']> = {
  import_project: wrap(async (a) => importProject(a as unknown as ImportProjectInput)),
  add_annotation: wrap(async (a) => {
    const r = addAnnotationByTool({
      feature: a.feature as string,
      text: a.text as string,
      node_id: a.node_id as string | undefined,
      type: a.type as 'comment' | 'question' | 'issue' | 'suggestion' | 'approval' | undefined,
      severity: a.severity as 'info' | 'warning' | 'critical' | undefined,
      author: a.author as string | undefined,
    });
    return { message: r.message };
  }),
  resolve_annotation: wrap(async (a) => {
    const r = resolveAnnotation({
      feature: a.feature as string,
      annotation_id: a.annotation_id as string,
      resolution_note: a.resolution_note as string | undefined,
    });
    return { message: r.message };
  }),
  dag_layout: wrap(async (a) => {
    const r = dagLayout({
      feature: a.feature as string,
      direction: a.direction as 'horizontal' | 'vertical' | undefined,
      h_gap: a.h_gap as number | undefined,
      v_gap: a.v_gap as number | undefined,
      width: a.width as number | undefined,
      respect_swimlanes: a.respect_swimlanes as boolean | undefined,
    });
    return { message: r.message };
  }),
  force_layout: wrap(async (a) => {
    const r = forceLayout({
      feature: a.feature as string,
      repulsion: a.repulsion as number | undefined,
      stiffness: a.stiffness as number | undefined,
      damping: a.damping as number | undefined,
      iterations: a.iterations as number | undefined,
      node_radius: a.node_radius as number | undefined,
      width: a.width as number | undefined,
      height: a.height as number | undefined,
    });
    return { message: r.message };
  }),
  grid_align: wrap(async (a) => {
    const r = gridAlign({ feature: a.feature as string, grid_size: a.grid_size as number | undefined });
    return { message: r.message };
  }),
  submit_approval: wrap(async (a) => {
    const r = submitApproval({
      feature: a.feature as string,
      annotation_id: a.annotation_id as string,
      assignee: a.assignee as string | undefined,
      submitter: a.submitter as string | undefined,
      comment: a.comment as string | undefined,
    });
    return { message: r.message };
  }),
  review_annotation: wrap(async (a) => {
    const r = reviewAnnotation({
      feature: a.feature as string,
      annotation_id: a.annotation_id as string,
      decision: a.decision as 'approve' | 'reject' | 'request_revision',
      reviewer: a.reviewer as string,
      comment: a.comment as string | undefined,
    });
    return { message: r.message };
  }),
  save_snapshot: wrap(async (a) => {
    const r = saveSnapshot({
      feature: a.feature as string,
      label: a.label as string,
      description: a.description as string | undefined,
    });
    return { message: r.message };
  }),
  rollback_snapshot: wrap(async (a) => {
    const r = rollbackSnapshot({
      feature: a.feature as string,
      snapshot_id: a.snapshot_id as string,
    });
    return { message: r.message };
  }),
  delete_snapshot: wrap(async (a) => {
    const r = deleteSnapshot({ feature: a.feature as string, snapshot_id: a.snapshot_id as string });
    return { message: r.message };
  }),
};
for (const [name, handler] of Object.entries(LEGACY_HANDLERS)) handlerByTarget.set(name, handler);

/** 注册全部工具（主工具 + 别名）到 McpServer */
export function registerAllTools(server: McpServer): void {
  for (const def of TOOL_DEFS) {
    server.registerTool(def.name, { title: def.title, description: def.description, inputSchema: def.inputSchema }, async (args) => {
      const r = await def.handler((args ?? {}) as Record<string, unknown>);
      return textOut(r.text, r.isError);
    });
  }
  for (const alias of ALIASES) {
    const handler = handlerByTarget.get(alias.target);
    if (!handler) throw new Error(`别名 ${alias.name} 指向未知主工具 ${alias.target}`);
    server.registerTool(
      alias.name,
      { title: alias.name, description: alias.description, inputSchema: LOOSE_INPUT_SCHEMA },
      async (args) => {
        const adapted = alias.adapter((args ?? {}) as Record<string, unknown>);
        const r = await handler(adapted);
        return textOut(r.text, r.isError);
      },
    );
  }
}

export { TOOL_DEFS, ALIASES };