#!/usr/bin/env node
/**
 * design-canvas MCP server 入口
 *
 * 启动方式（stdio）：
 *   node dist/server.js
 *
 * 在 MCP client 配置中：
 *   { "mcpServers": { "design-canvas": { "command": "node", "args": ["/path/to/dist/server.js"] } } }
 *
 * 工具统一由 server_registry 注册：13 个主工具（旧工具名别名已于 2026-08-17 全部移除）。
 */

import path from 'node:path';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAllTools } from './server_registry.js';
import { importProject } from './tools/import_project.js';
import { watchProjectTool } from './tools/watch_project_tool.js';
import { listFeatures } from './storage.js';
import { resolveCanvasNoteTargets, renderCanvasNotesDigest } from './tools/derive_mind_map.js';

const SERVER_NAME = 'design-canvas';
const SERVER_VERSION = '0.1.3';

const server = new McpServer(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    capabilities: { tools: {}, resources: {} },
    instructions:
      'design-canvas：人机共享的可视化协议层。支持两种工作流：' +
      '\n\n1. 完整 DSL 模式：render_dsl 渲染并保存 → get_dsl 读取（query:"dsl"/"features" 等）' +
      '\n\n2. 增量编辑模式（推荐）：manage_feature(action=create) 创建 → edit_dsl 统一提交所有写操作 → render_dsl 渲染预览' +
      '\n   edit_dsl 通过 operations 列表批量执行（任一失败全部回滚）：' +
      '\n   - {op:"add",type:"node",id:"n1",data:{label,x,y,bg,shape,type,status,swimlane,layer,host,shapes,...}}' +
      '\n   - 决策卡字段（设计文档层）：data.attributes={参数名:值}（类型化参数表，如 budget_mb:64）+ data.decision={summary,rationale,alternatives:[{option,rejected_because}],consequences,acceptance,status,thread,tags}（决策记录：结论/理由/否决方案/后果/验收+状态 active|superseded|draft+功能线+标签）。LLM 运化设计时必填——图上短标签，点开见全卡' +
      '\n   - 决策语义化：update 时传 data.decision 自动把旧版压入 decision_history 版本栈（可配 data.decision_note 记修订说明）；query:"decisions" 按功能线分组查目录（可传 thread/decision_status 过滤），query:"node" 看单卡版本史。同类决策用同一 thread 名聚合（如"采集分层"、"错误导出"）' +
      '\n   - {op:"update"|"delete"|"move",type:"node",id:"n1",data:{...}}（move 用 data:{dx,dy} 相对平移）' +
      '\n   - {op:"add"|"update"|"delete",type:"edge",id:"e1",data:{from,to,label,edge_type,arrow,layer}}' +
      '\n   - {op:"add"|"update"|"delete",type:"file",id:"f1",data:{path,responsibility,status,...}}' +
      '\n   - {op:"add"|"update"|"delete",type:"api",id:"<file_id>",data:{signature,new_signature?,notes?}}' +
      '\n   - {op:"update",type:"binding",id:"<node_id>",data:{file_id,sync_status?}} 绑定节点与语义文件' +
      '\n   - {op:"update",type:"status",id:"<node_id>",data:{status}} 更新状态（同步 file 并重算 feature 状态）' +
      '\n\n3. 代码生成：scaffold 从设计图 semantic 层生成代码骨架（签名 + TODO + import），LLM 在骨架上填充实现。' +
      '\n\n4. 状态回填：LLM 写完代码后，调用 backfill_scaffold 自动解析实际 API 签名回填到 DSL。' +
      '\n   然后 scaffold 扫描 TODO 残留量自动推断状态，或 edit_dsl 的 status 操作手动标记。' +
      '\n   render_dsl 重新渲染后节点颜色随状态变化：灰=待实现, 橙=实现中, 绿=已完成。' +
      '\n\n5. 人审流程：人类在浏览器双击节点添加标注 → get_dsl（query:"annotations"）读取 → LLM 迭代修改 → edit_dsl(op=resolve,type=annotation) 关闭。' +
      '\n\n6. 自动布局：edit_dsl(op=apply,type=layout) 一键整理画布（data.algo=dag 拓扑排序 / force 力导向 / grid 网格对齐），避免连线混乱。' +
      '\n\n7. 仿真器：explore_code(action=run_simulation) 批量传入事件验证事件级联和条件触发 → get_dsl（query:"simulation_state"）读取当前状态 → edit_dsl(op=reset,type=simulation) 重置。' +
      '\n   仿真器是事件驱动状态机，不是动画播放器。用于验证"数据流入 → 规则触发 → 状态变化"是否符合预期。' +
      '\n\n8. 项目导入：import_project 扫描代码项目生成 DSL（文件节点+调用边+符号语义层），design_mode/functional_mode 聚合为设计草图。' +
      '\n\n9. 单文件体检：explore_code(action=check_monolith) 扫描文件行数，超阈值文件自动做 Louvain 社区发现，给出功能内聚拆分建议（仅建议不改代码）。' +
      '\n\n10. 文件索引优先（Agent 第一性路径）：查/改代码时优先 get_dsl(query:"files",feature) 拿语义文件列表（含架构层/API 数/行数），' +
      '再 query:"file" 拿单文件详情（含 API 签名+行号+deps）直达修改点。' +
      '定位符号用 explore_code(action=search)：标识符查询自动走精确符号索引（provider=exact，零向量开销），自然语言意图才走向量。' +
      '修改用 edit_code（符号级替换：文件+函数名+新函数体，AST 定位防改错行/改错函数，编辑后自动重建索引）；' +
      'Grep/Glob 仅作 fallback（DSL 未绑定的文件才全文搜索），Edit 工具仅作 edit_code 不适用场景的兜底。' +
      '绑定新鲜度由 edit_code（编辑即更新）/ import_project（全量）/ explore_code(action=watch)（增量）维护。' +
      '\n\n增量模式让你逐步完善设计，避免每次重写整个 JSON。所有修改自动保存到 .design-canvas/features/。',
  },
);

// 统一注册主工具
registerAllTools(server);

// ─────────────────────────────────────────────────────────────
// Resource：批注语义工单（订阅式返回给外部 agent）
// 模板 design-canvas://{feature}/notes —— 读时实时解析几何批注 → Markdown 工单。
// 与 read_canvas_notes 工具（显式调用）互为双通道。
// ─────────────────────────────────────────────────────────────
server.resource(
  'canvas-notes',
  new ResourceTemplate('design-canvas://{feature}/notes', {
    list: async () => {
      const resources = listFeatures()
        .filter((d) => (d.canvas_notes ?? []).length > 0)
        .map((d) => ({
          uri: `design-canvas://${d.feature}/notes`,
          name: `批注工单 · ${d.feature}`,
          mimeType: 'text/markdown',
          description: `${d.feature} 的画布批注语义工单（${(d.canvas_notes ?? []).length} 条图元）`,
        }));
      return { resources };
    },
  }),
  async (_uri, variables) => {
    const feature = String(variables.feature ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!feature) {
      return { contents: [{ uri: 'design-canvas:///notes', mimeType: 'text/markdown', text: '缺少 feature 参数。' }] };
    }
    const resolved = resolveCanvasNoteTargets(feature);
    const digest = renderCanvasNotesDigest(feature, resolved);
    return {
      contents: [{ uri: `design-canvas://${feature}/notes`, mimeType: 'text/markdown', text: digest.markdown }],
    };
  },
);

// ─────────────────────────────────────────────────────────────
// 启动钩子（常驻模式）：DC_AUTO_WATCH=1 时，启动即导入并监听工作空间
// ─────────────────────────────────────────────────────────────

/** 项目根：默认 process.cwd()，可用 DC_PROJECT_DIR 覆盖（相对 cwd 或绝对路径，语义同 serve） */
function resolveProjectDir(): string {
  const override = process.env.DC_PROJECT_DIR;
  return override ? path.resolve(process.cwd(), override) : process.cwd();
}

/** 从目录名推导合法 feature 名（^[a-zA-Z0-9_-]+$），兜底 workspace */
function deriveFeatureName(projectDir: string): string {
  const name = path.basename(path.resolve(projectDir)).replace(/[^a-zA-Z0-9_-]/g, '_');
  return name || 'workspace';
}

/**
 * 启动钩子主体：
 *   1. import_project 全量导入工作空间 → 建索引（cache.db + 设计 DSL）
 *   2. watch_project 常驻监听 → 文件变更增量保鲜 + 影响报告
 * 环境变量（与 serve.ts 约定一致）：
 *   DC_AUTO_WATCH=1            开启本钩子
 *   DC_PROJECT_DIR=<dir>       目标工作空间（默认 cwd）
 *   DC_WATCH_FEATURE=<name>    feature 名（默认取目录名）
 *   DC_WATCH_INTERVAL_MS=<ms>  reconcile 兜底扫描间隔（默认 30000）
 * 失败不致命：任何一步出错仅打日志，不影响 MCP 工具服务。
 */
async function runAutoWatchHook(): Promise<void> {
  if (process.env.DC_AUTO_WATCH !== '1') return;
  const projectDir = resolveProjectDir();
  const feature = process.env.DC_WATCH_FEATURE?.trim() || deriveFeatureName(projectDir);
  const reconcileMs = parseInt(process.env.DC_WATCH_INTERVAL_MS ?? '30000', 10) || 30000;

  try {
    const imp = await importProject({ project_dir: projectDir, feature });
    console.error(
      `[Auto Watch] 已导入工作空间 ${projectDir} → feature="${feature}" ` +
        `（解析 ${imp.files_parsed} 文件 / ${imp.symbols_found} 符号 / ${imp.dep_edges} 调用边）`,
    );
  } catch (e) {
    console.error(`[Auto Watch] 初始导入失败: ${(e as Error).message}`);
  }

  try {
    const w = await watchProjectTool({
      project_dir: projectDir,
      action: 'start',
      feature,
      impact_on_change: true,
      reconcile_interval_ms: reconcileMs,
    });
    console.error(`[Auto Watch] 常驻监听已启动: ${w.message}`);
  } catch (e) {
    console.error(`[Auto Watch] 监听启动失败: ${(e as Error).message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// 启动
// ─────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${SERVER_NAME} v${SERVER_VERSION}] MCP server started (stdio)`);
  await runAutoWatchHook();
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
