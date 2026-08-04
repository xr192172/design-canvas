#!/usr/bin/env node
/**
 * design-canvas MCP server 入口
 *
 * 启动方式（stdio）：
 *   node dist/server.js
 *
 * 在 MCP client 配置中：
 *   { "mcpServers": { "design-canvas": { "command": "node", "args": ["/path/to/dist/server.js"] } } }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { renderDsl } from './tools/render_dsl.js';
import { createFeature, cloneFeature } from './tools/feature_ops.js';
import { updateFeature } from './tools/update_feature.js';
import { scaffold } from './tools/scaffold.js';
import { checkStatus } from './tools/status_tools.js';
import { resolveAnnotation, addAnnotationByTool } from './tools/annotation_tools.js';
import { dagLayout, forceLayout, gridAlign } from './tools/dag_layout.js';
import { backfillScaffold } from './tools/backfill.js';
import { deriveDetailChain } from './tools/derive_chain.js';
import { deriveAlgorithm } from './tools/derive_algorithm.js';
import { injectReplay } from './tools/inject_replay.js';
import { checkConsistency } from './tools/consistency.js';
import { runSimulation, resetSimulation } from './tools/simulation.js';
import { exportSvg, exportMarkdown } from './tools/export.js';
import { submitApproval, reviewAnnotation } from './tools/approval.js';
import { saveSnapshot, rollbackSnapshot, deleteSnapshot } from './tools/snapshot.js';
import { createFromTemplate } from './tools/templates.js';
import { importProject } from './tools/import_project.js';
import { checkMonolith } from './tools/monolith.js';
import { queryFeature } from './tools/query_feature.js';

const SERVER_NAME = 'design-canvas';
const SERVER_VERSION = '0.1.3';

const server = new McpServer(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    capabilities: { tools: {} },
    instructions:
      'design-canvas：人机共享的可视化协议层。支持两种工作流：' +
      '\n\n1. 完整 DSL 模式：render_dsl 渲染并保存 → query_feature 读取（query:"dsl"/"features" 等）' +
      '\n\n2. 增量编辑模式（推荐）：create_feature 创建 → update_feature 统一提交所有写操作 → render_dsl 渲染预览' +
      '\n   update_feature 通过 operations 列表批量执行（任一失败全部回滚）：' +
      '\n   - {op:"add",type:"node",id:"n1",data:{label,x,y,bg,shape,type,status,swimlane,layer,host,shapes,...}}' +
      '\n   - {op:"update"|"delete"|"move",type:"node",id:"n1",data:{...}}（move 用 data:{dx,dy} 相对平移）' +
      '\n   - {op:"add"|"update"|"delete",type:"edge",id:"e1",data:{from,to,label,edge_type,arrow,layer}}' +
      '\n   - {op:"add"|"update"|"delete",type:"file",id:"f1",data:{path,responsibility,status,...}}' +
      '\n   - {op:"add"|"update"|"delete",type:"api",id:"<file_id>",data:{signature,new_signature?,notes?}}' +
      '\n   - {op:"update",type:"binding",id:"<node_id>",data:{file_id,sync_status?}} 绑定节点与语义文件' +
      '\n   - {op:"update",type:"status",id:"<node_id>",data:{status}} 更新状态（同步 file 并重算 feature 状态）' +
      '\n\n3. 代码生成：scaffold 从设计图 semantic 层生成代码骨架（签名 + TODO + import），LLM 在骨架上填充实现。' +
      '\n\n4. 状态回填：LLM 写完代码后，调用 backfill_scaffold 自动解析实际 API 签名回填到 DSL。' +
      '\n   然后 check_status 扫描 TODO 残留量自动推断状态，或 update_feature 的 status 操作手动标记。' +
      '\n   render_dsl 重新渲染后节点颜色随状态变化：灰=待实现, 橙=实现中, 绿=已完成。' +
      '\n\n5. 人审流程：人类在浏览器双击节点添加标注 → query_feature（query:"annotations"）读取 → LLM 迭代修改 → resolve_annotation 关闭。' +
      '\n\n6. 自动布局：dag_layout（拓扑排序）/ force_layout（力导向）/ grid_align（网格对齐）一键整理画布，避免连线混乱。' +
      '\n\n7. 仿真器：run_simulation 批量传入事件验证事件级联和条件触发 → query_feature（query:"simulation_state"）读取当前状态 → reset_simulation 重置。' +
      '\n   仿真器是事件驱动状态机，不是动画播放器。用于验证"数据流入 → 规则触发 → 状态变化"是否符合预期。' +
      '\n\n8. 单文件监控：check_monolith 扫描文件行数，超阈值文件自动做 Louvain 社区发现，给出功能内聚拆分建议（仅建议不改代码）。' +
      '\n\n增量模式让你逐步完善设计，避免每次重写整个 JSON。所有修改自动保存到 .design-canvas/features/。',
  },
);

// ─────────────────────────────────────────────────────────────
// render_dsl：DSL JSON → HTML 文件
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'render_dsl',
  {
    title: 'Render design DSL',
    description:
      'Render a design DSL JSON to a self-contained HTML file. ' +
      '校验 + 持久化 DSL，渲染为内联 CSS+JS 的单 HTML 文件，返回文件绝对路径。',
    inputSchema: {
      dsl_json: z
        .string()
        .describe('完整的 DSL JSON 字符串（符合 schema/design_dsl.schema.json）'),
      output_path: z
        .string()
        .optional()
        .describe('可选，HTML 输出路径，默认 output/<feature>.html'),
    },
  },
  async (args) => {
    try {
      const result = renderDsl({
        dsl_json: args.dsl_json,
        output_path: args.output_path,
      });
      return {
        content: [{ type: 'text', text: result.message }],
      };
    } catch (e) {
      return {
        content: [{ type: 'text', text: (e as Error).message }],
        isError: true,
      };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// query_feature：统一读操作入口（替代原 9 个查询工具）
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'query_feature',
  {
    title: 'Query feature data',
    description:
      '统一读操作入口：通过 query 参数查询 DSL、feature 列表、标注、审批、快照、模板、仿真状态、diff。' +
      'query: dsl（DSL JSON）/ features（所有 feature）/ annotations（标注，可 node_id/severity/unresolved_only 过滤）/ ' +
      'approvals（审批列表，可 status/assignee 过滤）/ approval_history（审批历史，需 annotation_id）/ ' +
      'snapshots（快照列表）/ templates（模板列表）/ simulation_state（仿真状态）/ diff（对比，需 feature_a+feature_b）。',
    inputSchema: {
      query: z
        .enum(['dsl', 'features', 'annotations', 'approvals', 'approval_history', 'snapshots', 'templates', 'simulation_state', 'diff'])
        .describe('查询类型'),
      feature: z.string().optional().describe('feature 名（dsl/annotations/approvals/approval_history/snapshots/simulation_state 必填）'),
      node_id: z.string().optional().describe('annotations：按节点 ID 过滤'),
      severity: z.enum(['info', 'warning', 'critical']).optional().describe('annotations：按严重程度过滤'),
      unresolved_only: z.boolean().optional().describe('annotations：只显示未解决的'),
      status: z.enum(['draft', 'pending_review', 'approved', 'rejected', 'needs_revision']).optional().describe('approvals：按状态过滤'),
      assignee: z.string().optional().describe('approvals：按指派人过滤'),
      annotation_id: z.string().optional().describe('approval_history：标注 ID'),
      feature_a: z.string().optional().describe('diff：源 feature'),
      feature_b: z.string().optional().describe('diff：目标 feature'),
    },
  },
  async (args) => {
    try {
      const result = queryFeature(args);
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// create_feature：创建新 feature
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'create_feature',
  {
    title: 'Create new feature',
    description: '创建一个新的 feature，初始化空的节点和边列表。feature 名必须匹配 ^[a-zA-Z0-9_-]+$。',
    inputSchema: {
      feature: z.string().describe('feature 名（如 user_auth, payment_flow）'),
      title: z.string().optional().describe('可选，显示标题，默认等于 feature 名'),
    },
  },
  async (args) => {
    try {
      const result = createFeature({
        feature: args.feature,
        title: args.title,
      });
      return {
        content: [{ type: 'text', text: result.message }],
      };
    } catch (e) {
      return {
        content: [{ type: 'text', text: (e as Error).message }],
        isError: true,
      };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// update_feature：统一写操作入口（替代原 16 个写工具）
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'update_feature',
  {
    title: 'Update feature with batch operations',
    description:
      '统一写操作入口：通过 operations 列表批量执行节点/边/文件/API 的增删改、节点平移、语义绑定、状态更新。' +
      '按顺序执行，任一失败自动回滚全部变更（原子性）。' +
      'op: add/update/delete/move（move 仅 node，data:{dx,dy} 相对平移）；' +
      'type: node/edge/file/api/binding/status；' +
      'id: node_id/edge_id/file_id（api 类型 id 为所属 file_id）；' +
      'data: 各操作字段（同原 add_*/update_* 工具参数）。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      operations: z
        .array(
          z.object({
            op: z.enum(['add', 'update', 'delete', 'move']).describe('操作类型：add 新增 / update 更新 / delete 删除 / move 相对平移（仅 node）'),
            type: z.enum(['node', 'edge', 'file', 'api', 'binding', 'status']).describe('目标类型：node 节点 / edge 边 / file 语义文件 / api 预期API(id=file_id) / binding 节点绑定文件(仅update, data.file_id) / status 状态更新(仅update, data.status)'),
            id: z.string().describe('目标 ID：node_id / edge_id / file_id'),
            data: z.record(z.string(), z.unknown()).optional().describe('操作数据，字段同原 add_*/update_* 工具（node: {label,x,y,bg,shape,type,status,swimlane,layer,host,shapes}；edge: {from,to,label,edge_type,arrow,layer}；file: {path,responsibility,status}；api: {signature,new_signature?,notes?}；move: {dx,dy}）'),
          }),
        )
        .describe('操作列表，按顺序执行，任一失败全部回滚'),
    },
  },
  async (args) => {
    try {
      const result = updateFeature({
        feature: args.feature,
        operations: args.operations,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// clone_feature：克隆 feature
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'clone_feature',
  {
    title: 'Clone feature',
    description: '克隆一个现有的 feature 为新的 feature，复制所有节点、边、语义层配置。可用于创建变体或备份。',
    inputSchema: {
      source_feature: z.string().describe('源 feature 名'),
      target_feature: z.string().describe('目标 feature 名（必须是新名称）'),
      title: z.string().optional().describe('新 feature 的标题，默认在原标题后加"(副本)"'),
    },
  },
  async (args) => {
    try {
      const result = cloneFeature({
        source_feature: args.source_feature,
        target_feature: args.target_feature,
        title: args.title,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// scaffold：从 DSL 生成代码骨架（增强版）
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'scaffold',
  {
    title: 'Generate code skeleton from DSL',
    description:
      '从已保存的 DSL semantic 层生成代码骨架（增强版）。' +
      '支持语言：.go/.ts/.py/.js/.vue/.tsx。' +
      '新增能力：1) 从节点 content.blocks 生成 UI 骨架（color_block → div，text → span，image → img）' +
      '2) 生成注释标记 <!-- design-canvas:node_id --> 用于 backfill 定位' +
      '3) 支持 DSL 中配置自定义模板（semantic.scaffold.templates）' +
      '4) 模板占位符：{{package}}, {{imports}}, {{apis}}, {{behavior}}, {{node_id}}, {{node_label}}, {{ui_skeleton}}。' +
      '额外生成 INVARIANTS.md 记录跨文件不变式。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      output_dir: z.string().optional().describe('输出根目录，默认 scaffold/<feature>/'),
      overwrite: z.boolean().optional().describe('是否覆盖已存在的文件，默认 false'),
      ui_framework: z.enum(['vue', 'react', 'html']).optional().describe('UI 骨架类型（覆盖 DSL 配置）'),
    },
  },
  async (args) => {
    try {
      const result = scaffold({
        feature: args.feature,
        output_dir: args.output_dir,
        overwrite: args.overwrite,
        ui_framework: args.ui_framework,
      });
      return {
        content: [{ type: 'text', text: result.message }],
      };
    } catch (e) {
      return {
        content: [{ type: 'text', text: (e as Error).message }],
        isError: true,
      };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// check_status：扫描代码文件自动推断状态
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'check_status',
  {
    title: 'Check implementation status from code',
    description:
      '扫描 scaffold 生成的代码文件，根据 TODO / NotImplementedError 残留量自动推断各文件状态。' +
      '无残留=done, ≤2个=in_progress, >2个=draft。同时更新节点状态和 feature 整体状态。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      scaffold_dir: z.string().optional().describe('scaffold 输出目录，默认 scaffold/<feature>/'),
    },
  },
  async (args) => {
    try {
      const result = checkStatus({
        feature: args.feature,
        scaffold_dir: args.scaffold_dir,
      });
      return {
        content: [{ type: 'text', text: result.message }],
      };
    } catch (e) {
      return {
        content: [{ type: 'text', text: (e as Error).message }],
        isError: true,
      };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// resolve_annotation：标记标注已解决
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'resolve_annotation',
  {
    title: 'Resolve an annotation',
    description: '标记审查标注为已解决。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      annotation_id: z.string().describe('标注 ID'),
      resolution_note: z.string().optional().describe('解决说明'),
    },
  },
  async (args) => {
    try {
      const result = resolveAnnotation({
        feature: args.feature,
        annotation_id: args.annotation_id,
        resolution_note: args.resolution_note,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// add_annotation：LLM 主动添加标注
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'add_annotation',
  {
    title: 'Add a review annotation',
    description: 'LLM 主动添加审查标注（给人类看）。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      text: z.string().describe('标注内容'),
      node_id: z.string().optional().describe('节点 ID'),
      type: z.enum(['comment', 'question', 'issue', 'suggestion', 'approval']).optional(),
      severity: z.enum(['info', 'warning', 'critical']).optional(),
      author: z.string().optional().describe('作者，默认 llm'),
    },
  },
  async (args) => {
    try {
      const result = addAnnotationByTool({
        feature: args.feature,
        text: args.text,
        node_id: args.node_id,
        type: args.type,
        severity: args.severity,
        author: args.author,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// dag_layout：自动布局（拓扑排序）
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'dag_layout',
  {
    title: 'Auto-layout DAG',
    description: '基于拓扑排序的自动布局算法。一键整理杂乱的画布，避免连线交叉。适合有向无环图。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      direction: z.enum(['horizontal', 'vertical']).optional().describe('布局方向'),
      h_gap: z.number().optional().describe('水平间距'),
      v_gap: z.number().optional().describe('垂直间距'),
      width: z.number().optional().describe('画布宽度'),
      respect_swimlanes: z.boolean().optional().describe('是否按泳道分组布局'),
    },
  },
  async (args) => {
    try {
      const result = dagLayout({
        feature: args.feature,
        direction: args.direction,
        h_gap: args.h_gap,
        v_gap: args.v_gap,
        width: args.width,
        respect_swimlanes: args.respect_swimlanes,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// import_project：扫描现有项目 → 自动生成设计图 DSL
// ─────────────────────────────────────────────────────────────
// 符号缓存（Node 22.5+ node:sqlite）：静态 import 会让旧 Node 上 server 启动即崩，
// 动态 import 把失败约束在单次工具调用内——加载失败/打开失败都退化为全量解析。
type ProjectCacheMod = typeof import('./db/db.js');
let projectCacheMod: Promise<ProjectCacheMod | null> | null = null;
function loadProjectCache(): Promise<ProjectCacheMod | null> {
  if (!projectCacheMod) projectCacheMod = import('./db/db.js').catch(() => null);
  return projectCacheMod;
}

server.registerTool(
  'import_project',
  {
    title: 'Import Project as DSL',
    description:
      '扫描一个现有代码项目（Go/TypeScript/JavaScript/Python），自动生成 design-canvas 设计图：' +
      '目录→容器节点、文件→节点（含 tree-sitter 解析的 API 签名）、import→依赖边。' +
      '降低工具门槛——新用户无需手写 DSL，指向项目目录即可得到初始架构图，随后在画布上迭代。',
    inputSchema: {
      project_dir: z.string().describe('目标项目根目录（绝对路径或相对 cwd）'),
      feature: z.string().describe('新 feature 名（^[a-zA-Z0-9_-]+$）'),
      title: z.string().optional().describe('显示标题（默认等于 feature）'),
      max_files: z.number().optional().describe('最多解析文件数（默认 200）'),
      include_tests: z.boolean().optional().describe('是否包含测试文件（默认 false）'),
    },
  },
  async (args) => {
    try {
      // 符号缓存：<project_dir>/.design-canvas/cache.db（跟着项目走，增量解析）
      let cacheDb: import('./db/db.js').Database | undefined;
      const cache = await loadProjectCache();
      if (cache) {
        try {
          cacheDb = cache.getProjectCacheDb(args.project_dir);
        } catch {
          cacheDb = undefined; // 目标目录只读等情况 → 无缓存退化
        }
      }
      const result = await importProject({
        project_dir: args.project_dir,
        feature: args.feature,
        title: args.title,
        max_files: args.max_files,
        include_tests: args.include_tests,
        cache_db: cacheDb,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// check_monolith：监控文件行数，识别单文件化风险并给出功能内聚拆分建议
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'check_monolith',
  {
    title: 'Check monolithic files & suggest splits',
    description:
      '监控文件行数：超阈值（默认 warning≥300 / critical≥600 行）的文件自动跑 tree-sitter 声明提取 + 引用图 + Louvain 社区发现，' +
      '把互相引用紧密的声明聚成"功能内聚社区"，给出拆分建议（新文件名 + 每社区声明清单 + 社区间引用边）。' +
      '三种输入模式：project_dir 扫描目录 / feature 读 semantic.files / files 显式列表。' +
      'save_preview=true 时把拆分后视图保存为新 feature（社区为子节点），render_dsl 即可预览。仅建议，不改代码。',
    inputSchema: {
      project_dir: z.string().optional().describe('模式1：扫描项目目录（与 feature/files 三选一）'),
      feature: z.string().optional().describe('模式2：从已存 feature 的 semantic.files 取文件列表'),
      base_dir: z.string().optional().describe('feature 模式下解析相对路径的项目根（默认 cwd）'),
      files: z.array(z.string()).optional().describe('模式3：显式文件路径列表'),
      warn_lines: z.number().optional().describe('warning 阈值（默认 300 行）'),
      crit_lines: z.number().optional().describe('critical 阈值（默认 600 行）'),
      max_files: z.number().optional().describe('扫描模式最多文件数（默认 200）'),
      save_preview: z.boolean().optional().describe('是否生成拆分预览 DSL 并保存为 feature（默认 false）'),
      preview_feature: z.string().optional().describe('预览 DSL 的 feature 名（默认 <feature|monolith>_split_preview）'),
    },
  },
  async (args) => {
    try {
      const result = await checkMonolith({
        project_dir: args.project_dir,
        feature: args.feature,
        base_dir: args.base_dir,
        files: args.files,
        warn_lines: args.warn_lines,
        crit_lines: args.crit_lines,
        max_files: args.max_files,
        save_preview: args.save_preview,
        preview_feature: args.preview_feature,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// force_layout：力导向布局
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'force_layout',
  {
    title: 'Force-directed Layout',
    description: '力导向布局算法（弹簧模型）。适合复杂网络图，节点自动散开减少重叠和交叉。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      repulsion: z.number().optional().describe('排斥力系数（默认 1000）'),
      stiffness: z.number().optional().describe('弹簧刚度（默认 0.1）'),
      damping: z.number().optional().describe('阻尼系数（默认 0.85）'),
      iterations: z.number().optional().describe('迭代次数（默认 500）'),
      node_radius: z.number().optional().describe('节点半径（默认 50）'),
      width: z.number().optional().describe('画布宽度'),
      height: z.number().optional().describe('画布高度'),
    },
  },
  async (args) => {
    try {
      const result = forceLayout({
        feature: args.feature,
        repulsion: args.repulsion,
        stiffness: args.stiffness,
        damping: args.damping,
        iterations: args.iterations,
        node_radius: args.node_radius,
        width: args.width,
        height: args.height,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// grid_align：网格对齐
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'grid_align',
  {
    title: 'Grid Align',
    description: '将所有节点吸附到网格点，使布局更整齐美观。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      grid_size: z.number().optional().describe('网格大小（px，默认 20）'),
    },
  },
  async (args) => {
    try {
      const result = gridAlign({
        feature: args.feature,
        grid_size: args.grid_size,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// backfill_scaffold：代码回填，解析实际代码更新 DSL
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'backfill_scaffold',
  {
    title: 'Backfill scaffold from implementation code',
    description:
      'LLM 写完代码后，自动解析实现文件中的 API 签名，回填到 DSL semantic.files[].actual_apis。' +
      '对比 expected_apis 输出差异报告（已实现 / 未实现 / 新增）。支持 .go/.ts/.py/.js。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      scaffold_dir: z.string().optional().describe('scaffold 输出目录，默认 scaffold/<feature>/'),
    },
  },
  async (args) => {
    try {
      const result = await backfillScaffold({
        feature: args.feature,
        scaffold_dir: args.scaffold_dir,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// derive_detail_chain：D2 变形链推导，TreeSitter 骨架 + 类型 → shapes
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'derive_detail_chain',
  {
    title: 'Derive detail-layer data transformation chain',
    description:
      'D2 变形链推导：从源文件提取函数骨架（TreeSitter）+ 文本法调用图，生成挂在主干节点下的 detail 层节点/链边。' +
      '参数/返回类型自动推导为 shapes 数据形状（Go 滤 ctx/error、TS 解包 Promise、Python 注解降级）。' +
      '幂等可重跑。之后请用 update_node 做语义标注（人话 label + shapes.label），并可聚合相邻细步骤。' +
      '注意调用边为文本匹配推导，同名方法可能误连，语义标注阶段需修正。支持 .go/.ts/.js/.py。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      node_id: z.string().describe('主干文件节点 id（detail 链挂在它下面）'),
      source_path: z
        .string()
        .optional()
        .describe('源文件路径（缺省取 semantic.files[node_id].path，相对 project_root）'),
      project_root: z.string().optional().describe('源文件根目录，默认当前工作目录'),
      entry: z.string().optional().describe('入口函数名（缺省自动推导：入度 0 且优先导出）'),
      max_steps: z.number().optional().describe('入链函数上限，默认 12'),
    },
  },
  async (args) => {
    try {
      const result = await deriveDetailChain({
        feature: args.feature,
        node_id: args.node_id,
        source_path: args.source_path,
        project_root: args.project_root,
        entry: args.entry,
        max_steps: args.max_steps,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// derive_algorithm：函数内算法控制流（D2 的互补：D2 看函数间，本工具看函数内）
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'derive_algorithm',
  {
    title: 'Derive intra-function algorithm control-flow graph',
    description:
      '算法控制流推导：TreeSitter 解析指定函数体，if→diamond 分支（是/否边）、for/while→hexagon 循环（进入/重复/结束边）、' +
      'return→终止节点、连续语句合并为 step，挂载为宿主节点的 detail 层。' +
      '与 derive_detail_chain 互补：D2 看函数间调用链，本工具看单个函数内部怎么运转，适合交流学习/团队对齐/项目研究。' +
      '嵌套超 max_depth 折叠为"嵌套逻辑"块；return 后的 dead code 会点名提醒。幂等可重跑。支持 .go/.ts/.js/.py。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      node_id: z.string().describe('宿主文件节点 id（算法图挂在它下面）'),
      function: z.string().describe('目标函数名（Go/TS 方法用裸名）'),
      source_path: z
        .string()
        .optional()
        .describe('源文件路径（缺省取 semantic.files[node_id].path，相对 project_root）'),
      project_root: z.string().optional().describe('源文件根目录，默认当前工作目录'),
      max_depth: z.number().optional().describe('控制流嵌套最大深度，默认 3，超出折叠'),
    },
  },
  async (args) => {
    try {
      const result = await deriveAlgorithm({
        feature: args.feature,
        node_id: args.node_id,
        function: args.function,
        source_path: args.source_path,
        project_root: args.project_root,
        max_depth: args.max_depth,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// inject_replay：D3 注入回放，静态推演一次 flow 回放暴露问题
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'inject_replay',
  {
    title: 'Inject a value and statically replay a flow',
    description:
      'D3 注入回放（质检环节）：注入一个 JSON 值替代 mock_results 作为 flow 的 handler result，静态推演回放路径。' +
      '回放语义与动画引擎 mock 模式对齐：命中 errors 声明 → 报告异常流向；结果像异常但未声明 → 未声明异常警报（疑似 bug）；' +
      '正常结果 → branches 条件求值报告命中分支。handler.file_id 节点声明了 shapes.out 时，ajv 校验注入值并报告违例字段。' +
      'preset 参数从 errors 声明自动生成注入值（自适应 condition 字面量）；list_presets=true 只列出可用预设场景。' +
      '纯静态推演，不跑真实代码、不修改 DSL，零风险。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      flow_id: z.string().describe('要回放的 flow id（animations_v2.flows[].id）'),
      inject: z.unknown().optional().describe('注入值（作为 handler result），与 preset 二选一'),
      preset: z.string().optional().describe('预设异常场景：handler.errors[].type，自动构造注入值'),
      value: z.unknown().optional().describe('分支求值的 value 上下文（缺省取 flow.mock_values[0] ?? {}）'),
      list_presets: z.boolean().optional().describe('true 时只列出可用预设场景，不执行回放'),
    },
  },
  async (args) => {
    try {
      const result = injectReplay({
        feature: args.feature,
        flow_id: args.flow_id,
        inject: args.inject,
        preset: args.preset,
        value: args.value,
        list_presets: args.list_presets,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// consistency_check：设计一致性检查
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'consistency_check',
  {
    title: 'Check design-code consistency',
    description:
      '对比 DSL 定义的 expected_apis 与实际代码中的 API 实现，生成一致性报告。' +
      '检测结果：✅ 已实现（签名完全匹配）、❌ 缺失（DSL 中有但代码中没有）、' +
      '⚠️ 签名不匹配（函数存在但参数/返回值不一致）、🆕 代码新增（代码中有但 DSL 中没有）。' +
      '同时验证跨文件不变式（multi_file_invariants）。只读检查，不修改 DSL。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      code_dir: z.string().optional().describe('代码根目录，默认 scaffold/<feature>/'),
    },
  },
  async (args) => {
    try {
      const result = await checkConsistency({
        feature: args.feature,
        code_dir: args.code_dir,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// 仿真器工具
// ─────────────────────────────────────────────────────────────

server.registerTool(
  'run_simulation',
  {
    title: 'Run simulation events',
    description:
      '运行仿真器：批量传入事件，返回最终状态 + 触发日志。' +
      '用于验证设计改动是否符合预期的事件级联和条件触发。' +
      '事件会按顺序处理，每个事件可能触发级联下游事件（emits）。' +
      '支持 reset_before_run 在运行前重置到初始状态。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      events: z.array(z.object({
        event: z.string().describe('事件名（如 user_input / turn_done / advance_conveyor）'),
        payload: z.record(z.string(), z.unknown()).optional().describe('事件载荷'),
      })).describe('要处理的事件列表'),
      reset_before_run: z.boolean().optional().describe('是否在运行前重置到初始状态'),
    },
  },
  async (args) => {
    try {
      const result = runSimulation({
        feature: args.feature,
        events: args.events,
        reset_before_run: args.reset_before_run,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

server.registerTool(
  'reset_simulation',
  {
    title: 'Reset simulation to initial state',
    description:
      '重置仿真器到 DSL 定义的初始状态，清除所有触发日志。' +
      '用于在多次测试之间恢复初始状态。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
    },
  },
  async (args) => {
    try {
      const result = resetSimulation({ feature: args.feature });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// 导出工具
// ─────────────────────────────────────────────────────────────

server.registerTool(
  'export_svg',
  {
    title: 'Export canvas as SVG',
    description:
      '将画布导出为独立 SVG 矢量文件，包含节点形状、边和标签。' +
      '可用于在文档中嵌入设计图或打印。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      output_path: z.string().optional().describe('输出路径，默认 output/<feature>.svg'),
    },
  },
  async (args) => {
    try {
      const result = exportSvg({
        feature: args.feature,
        output_path: args.output_path,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

server.registerTool(
  'export_markdown',
  {
    title: 'Export design as Markdown document',
    description:
      '从 DSL 生成 Markdown 设计文档，包含节点表、边列表、语义层、仿真器配置、标注等。' +
      '用于生成可读的设计文档，方便团队评审。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      output_path: z.string().optional().describe('输出路径，默认 output/<feature>.md'),
    },
  },
  async (args) => {
    try {
      const result = exportMarkdown({
        feature: args.feature,
        output_path: args.output_path,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// 人审/审批工作流
// ─────────────────────────────────────────────────────────────

server.registerTool(
  'submit_approval',
  {
    title: 'Submit annotation for approval',
    description:
      '将标注提交审批，状态从 draft 变为 pending_review。' +
      '可指定审批人，提交后可在 list_approvals 中查看。' +
      '审批完成前无法重复提交。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      annotation_id: z.string().describe('标注 ID'),
      assignee: z.string().optional().describe('指派给哪个审批人'),
      submitter: z.string().optional().describe('提交人（默认 llm）'),
      comment: z.string().optional().describe('提交说明'),
    },
  },
  async (args) => {
    try {
      const result = submitApproval({
        feature: args.feature,
        annotation_id: args.annotation_id,
        assignee: args.assignee,
        submitter: args.submitter,
        comment: args.comment,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

server.registerTool(
  'review_annotation',
  {
    title: 'Review an approval request',
    description:
      '审批一条标注：通过 / 驳回 / 要求修改。' +
      '只有 pending_review 状态的标注才能审批。' +
      '每次审批都会记录到审批历史（审计日志）。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      annotation_id: z.string().describe('标注 ID'),
      decision: z.enum(['approve', 'reject', 'request_revision']).describe('审批决策：approve 通过 / reject 驳回 / request_revision 要求修改'),
      reviewer: z.string().describe('审批人'),
      comment: z.string().optional().describe('审批意见'),
    },
  },
  async (args) => {
    try {
      const result = reviewAnnotation({
        feature: args.feature,
        annotation_id: args.annotation_id,
        decision: args.decision,
        reviewer: args.reviewer,
        comment: args.comment,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// 版本快照
// ─────────────────────────────────────────────────────────────

server.registerTool(
  'save_snapshot',
  {
    title: 'Save version snapshot',
    description: '保存当前 DSL 为版本快照。用于设计里程碑、评审前备份、重构前备份等场景。与 undo/redo 不同，快照是服务端持久化的设计版本。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      label: z.string().describe('快照标签（如"v1评审通过"）'),
      description: z.string().optional().describe('快照说明'),
    },
  },
  async (args) => {
    try {
      const result = saveSnapshot({ feature: args.feature, label: args.label, description: args.description });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

server.registerTool(
  'rollback_snapshot',
  {
    title: 'Rollback to snapshot',
    description: '回滚到指定快照。回滚前会自动保存当前状态为"回滚前自动备份"快照，防止数据丢失。使用 list_snapshots 查看可用快照 ID。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      snapshot_id: z.string().describe('快照 ID（时间戳格式，从 list_snapshots 获取）'),
    },
  },
  async (args) => {
    try {
      const result = rollbackSnapshot({ feature: args.feature, snapshot_id: args.snapshot_id });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

server.registerTool(
  'delete_snapshot',
  {
    title: 'Delete version snapshot',
    description: '删除指定的版本快照。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      snapshot_id: z.string().describe('快照 ID'),
    },
  },
  async (args) => {
    try {
      const result = deleteSnapshot({ feature: args.feature, snapshot_id: args.snapshot_id });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// 模板库
// ─────────────────────────────────────────────────────────────

server.registerTool(
  'create_from_template',
  {
    title: 'Create feature from template',
    description: '从预置模板创建新 feature。可用模板：crud_service（CRUD服务）、event_driven（事件驱动）、microservice（微服务拓扑）、pipeline（数据管道）。创建后可用 add_node / add_edge 继续修改。',
    inputSchema: {
      template_id: z.string().describe('模板 ID（如 crud_service）'),
      feature: z.string().describe('新 feature 名'),
      title: z.string().optional().describe('标题（默认使用模板名称）'),
    },
  },
  async (args) => {
    try {
      const result = createFromTemplate({
        template_id: args.template_id,
        feature: args.feature,
        title: args.title,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// 启动
// ─────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${SERVER_NAME} v${SERVER_VERSION}] MCP server started (stdio)`);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
