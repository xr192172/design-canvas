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
import { getDsl } from './tools/get_dsl.js';
import { listFeatures } from './tools/list_features.js';
import { createFeature, addNode, updateNode, deleteNode, addEdge, deleteEdge, addFile, updateFile, deleteFile, addExpectedApi, updateExpectedApi, deleteExpectedApi, setNodeSemantic, batchMoveNodes, batchUpdateStyle, batchDeleteNodes, cloneFeature, diffFeatures } from './tools/edit_dsl.js';
import { scaffold } from './tools/scaffold.js';
import { updateStatus, checkStatus } from './tools/status_tools.js';
import { listAnnotations, resolveAnnotation, addAnnotationByTool } from './tools/annotation_tools.js';
import { dagLayout, forceLayout, gridAlign } from './tools/dag_layout.js';
import { backfillScaffold } from './tools/backfill.js';
import { checkConsistency } from './tools/consistency.js';
import { runSimulation, getSimulationState, resetSimulation } from './tools/simulation.js';
import { exportSvg, exportMarkdown } from './tools/export.js';
import { submitApproval, reviewAnnotation, listApprovals, getApprovalHistory } from './tools/approval.js';
import { saveSnapshot, listSnapshots, rollbackSnapshot, deleteSnapshot } from './tools/snapshot.js';
import { listTemplates, createFromTemplate } from './tools/templates.js';

const SERVER_NAME = 'design-canvas';
const SERVER_VERSION = '0.1.3';

const server = new McpServer(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    capabilities: { tools: {} },
    instructions:
      'design-canvas：人机共享的可视化协议层。支持两种工作流：' +
      '\n\n1. 完整 DSL 模式：render_dsl 渲染并保存 → get_dsl 读取 → list_features 列出' +
      '\n\n2. 增量编辑模式（推荐）：create_feature 创建 → add_node 添加节点 → add_edge 添加边 → update_node 修改 → render_dsl 渲染预览' +
      '\n   - 节点属性：type(类型/description/status(描述)/shape(形状)/swimlane(泳道)/content(富文本内容)' +
      '\n   - 语义层：add_file 添加文件 → add_expected_api 添加API → set_node_semantic 绑定节点与文件' +
      '\n   - 批量操作：batch_move_nodes / batch_update_style / batch_delete_nodes' +
      '\n\n3. 代码生成：scaffold 从设计图 semantic 层生成代码骨架（签名 + TODO + import），LLM 在骨架上填充实现。' +
      '\n\n4. 状态回填：LLM 写完代码后，调用 backfill_scaffold 自动解析实际 API 签名回填到 DSL。' +
      '\n   然后 check_status 扫描 TODO 残留量自动推断状态，或 update_status 手动标记。' +
      '\n   render_dsl 重新渲染后节点颜色随状态变化：灰=待实现, 橙=实现中, 绿=已完成。' +
      '\n\n5. 人审流程：人类在浏览器双击节点添加标注 → list_annotations 读取 → LLM 迭代修改 → resolve_annotation 关闭。' +
      '\n\n6. 自动布局：dag_layout（拓扑排序）/ force_layout（力导向）/ grid_align（网格对齐）一键整理画布，避免连线混乱。' +
      '\n\n7. 仿真器：run_simulation 批量传入事件验证事件级联和条件触发 → get_simulation_state 读取当前状态 → reset_simulation 重置。' +
      '\n   仿真器是事件驱动状态机，不是动画播放器。用于验证"数据流入 → 规则触发 → 状态变化"是否符合预期。' +
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
// get_dsl：读取已保存的 DSL
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'get_dsl',
  {
    title: 'Get saved DSL',
    description: '读取已保存的 DSL JSON。如果 feature 不存在会返回错误。',
    inputSchema: {
      feature_name: z.string().describe('feature 名（如 user_auth）'),
    },
  },
  async (args) => {
    try {
      const result = getDsl({ feature_name: args.feature_name });
      return {
        content: [
          {
            type: 'text',
            text: `feature: ${result.feature}\n\n${result.json}`,
          },
        ],
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
// list_features：列出所有已设计的 feature
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'list_features',
  {
    title: 'List saved features',
    description: '列出当前工作目录下 .design-canvas/features/ 里的所有已设计 feature。',
    inputSchema: {},
  },
  async () => {
    const result = listFeatures();
    return {
      content: [{ type: 'text', text: result.message }],
    };
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
// add_node：添加节点
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'add_node',
  {
    title: 'Add node to feature',
    description: '向指定 feature 添加一个新节点。节点 ID 必须唯一。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      node_id: z.string().describe('节点唯一 ID'),
      label: z.string().optional().describe('节点显示标签，默认等于 node_id'),
      x: z.number().optional().describe('节点 X 坐标'),
      y: z.number().optional().describe('节点 Y 坐标'),
      width: z.number().optional().describe('节点宽度'),
      height: z.number().optional().describe('节点高度'),
      bg: z.string().optional().describe('背景色（十六进制，如 #2196F3）'),
      color: z.string().optional().describe('文字颜色'),
      border: z.string().optional().describe('边框样式'),
      borderRadius: z.number().optional().describe('圆角半径'),
      shape: z.enum(['rect', 'rounded', 'circle', 'diamond', 'freeform']).optional().describe('节点形状'),
      type: z.string().optional().describe('节点类型，如 service/module/database/api/queue/ui'),
      description: z.string().optional().describe('节点描述/备注'),
      status: z.enum(['draft', 'in_progress', 'done']).optional().describe('实现状态'),
      swimlane: z.string().optional().describe('所属泳道 ID'),
    },
  },
  async (args) => {
    try {
      const result = addNode({
        feature: args.feature,
        node_id: args.node_id,
        label: args.label,
        x: args.x,
        y: args.y,
        width: args.width,
        height: args.height,
        bg: args.bg,
        color: args.color,
        border: args.border,
        borderRadius: args.borderRadius,
        shape: args.shape,
        type: args.type,
        description: args.description,
        status: args.status,
        swimlane: args.swimlane,
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
// update_node：更新节点
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'update_node',
  {
    title: 'Update node',
    description: '更新已存在的节点属性。只传入需要修改的字段即可。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      node_id: z.string().describe('节点 ID'),
      label: z.string().optional().describe('节点显示标签'),
      x: z.number().optional().describe('节点 X 坐标'),
      y: z.number().optional().describe('节点 Y 坐标'),
      width: z.number().optional().describe('节点宽度'),
      height: z.number().optional().describe('节点高度'),
      bg: z.string().optional().describe('背景色'),
      color: z.string().optional().describe('文字颜色'),
      border: z.string().optional().describe('边框样式'),
      borderRadius: z.number().optional().describe('圆角半径'),
      shape: z.enum(['rect', 'rounded', 'circle', 'diamond', 'freeform']).optional().describe('节点形状'),
      type: z.string().optional().describe('节点类型'),
      description: z.string().optional().describe('节点描述/备注'),
      status: z.enum(['draft', 'in_progress', 'done']).optional().describe('实现状态'),
      swimlane: z.string().optional().describe('所属泳道 ID'),
    },
  },
  async (args) => {
    try {
      const result = updateNode({
        feature: args.feature,
        node_id: args.node_id,
        label: args.label,
        x: args.x,
        y: args.y,
        width: args.width,
        height: args.height,
        bg: args.bg,
        color: args.color,
        border: args.border,
        borderRadius: args.borderRadius,
        shape: args.shape,
        type: args.type,
        description: args.description,
        status: args.status,
        swimlane: args.swimlane,
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
// delete_node：删除节点
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'delete_node',
  {
    title: 'Delete node',
    description: '删除指定节点，同时删除所有与之相关的边。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      node_id: z.string().describe('节点 ID'),
    },
  },
  async (args) => {
    try {
      const result = deleteNode({
        feature: args.feature,
        node_id: args.node_id,
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
// add_edge：添加边
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'add_edge',
  {
    title: 'Add edge between nodes',
    description: '在两个已存在的节点之间添加一条边。from 和 to 必须是已存在的节点 ID。支持直线/曲线/虚线三种类型和正向/反向/双向/无箭头四种方向。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      edge_id: z.string().describe('边唯一 ID'),
      from: z.string().describe('源节点 ID'),
      to: z.string().describe('目标节点 ID'),
      label: z.string().optional().describe('边上的标签文字'),
      edge_type: z.enum(['straight', 'curve', 'dashed']).optional().describe('边类型：直线(默认)/曲线/虚线'),
      arrow: z.enum(['forward', 'reverse', 'both', 'none']).optional().describe('箭头方向：正向(默认)/反向/双向/无'),
    },
  },
  async (args) => {
    try {
      const result = addEdge({
        feature: args.feature,
        edge_id: args.edge_id,
        from: args.from,
        to: args.to,
        label: args.label,
        edge_type: args.edge_type,
        arrow: args.arrow,
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
// delete_edge：删除边
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'delete_edge',
  {
    title: 'Delete edge',
    description: '删除指定的边。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      edge_id: z.string().describe('边 ID'),
    },
  },
  async (args) => {
    try {
      const result = deleteEdge({
        feature: args.feature,
        edge_id: args.edge_id,
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
// add_file：添加语义文件
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'add_file',
  {
    title: 'Add semantic file',
    description: '向 feature 的 semantic 层添加一个新文件，定义职责和预期 API。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      file_id: z.string().describe('文件唯一 ID（建议与对应节点 ID 一致）'),
      path: z.string().describe('目标文件相对路径，如 service/user.go'),
      responsibility: z.string().describe('文件职责描述'),
      status: z.enum(['draft', 'in_progress', 'done']).optional().describe('文件状态'),
    },
  },
  async (args) => {
    try {
      const result = addFile({
        feature: args.feature,
        file_id: args.file_id,
        path: args.path,
        responsibility: args.responsibility,
        status: args.status,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// update_file：更新语义文件
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'update_file',
  {
    title: 'Update semantic file',
    description: '更新语义文件的属性，只传需要修改的字段。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      file_id: z.string().describe('文件 ID'),
      path: z.string().optional().describe('目标文件路径'),
      responsibility: z.string().optional().describe('职责描述'),
      status: z.enum(['draft', 'in_progress', 'done']).optional().describe('文件状态'),
    },
  },
  async (args) => {
    try {
      const result = updateFile({
        feature: args.feature,
        file_id: args.file_id,
        path: args.path,
        responsibility: args.responsibility,
        status: args.status,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// delete_file：删除语义文件
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'delete_file',
  {
    title: 'Delete semantic file',
    description: '删除指定的语义文件。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      file_id: z.string().describe('文件 ID'),
    },
  },
  async (args) => {
    try {
      const result = deleteFile({ feature: args.feature, file_id: args.file_id });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// add_expected_api：添加预期 API
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'add_expected_api',
  {
    title: 'Add expected API to file',
    description: '向语义文件添加一个预期 API 签名。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      file_id: z.string().describe('文件 ID'),
      signature: z.string().describe('API 签名，如 UserService.Login(username string) (string, error)'),
      notes: z.string().optional().describe('API 说明备注'),
    },
  },
  async (args) => {
    try {
      const result = addExpectedApi({
        feature: args.feature,
        file_id: args.file_id,
        signature: args.signature,
        notes: args.notes,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// update_expected_api：更新预期 API
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'update_expected_api',
  {
    title: 'Update expected API',
    description: '更新预期 API 的签名或备注。按原签名匹配。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      file_id: z.string().describe('文件 ID'),
      signature: z.string().describe('要修改的原 API 签名'),
      new_signature: z.string().optional().describe('新的 API 签名'),
      notes: z.string().optional().describe('新的备注'),
    },
  },
  async (args) => {
    try {
      const result = updateExpectedApi({
        feature: args.feature,
        file_id: args.file_id,
        signature: args.signature,
        new_signature: args.new_signature,
        notes: args.notes,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// delete_expected_api：删除预期 API
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'delete_expected_api',
  {
    title: 'Delete expected API',
    description: '从语义文件中删除指定的预期 API。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      file_id: z.string().describe('文件 ID'),
      signature: z.string().describe('要删除的 API 签名'),
    },
  },
  async (args) => {
    try {
      const result = deleteExpectedApi({
        feature: args.feature,
        file_id: args.file_id,
        signature: args.signature,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// set_node_semantic：绑定节点与语义文件
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'set_node_semantic',
  {
    title: 'Bind node to semantic file',
    description:
      '将几何层节点与语义层文件绑定，自动同步状态。' +
      '绑定后节点和文件共享同一 ID，状态变化自动联动。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      node_id: z.string().describe('节点 ID'),
      file_id: z.string().describe('文件 ID'),
      sync_status: z.boolean().optional().describe('是否同步状态，默认 true'),
    },
  },
  async (args) => {
    try {
      const result = setNodeSemantic({
        feature: args.feature,
        node_id: args.node_id,
        file_id: args.file_id,
        sync_status: args.sync_status,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// batch_move_nodes：批量移动节点
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'batch_move_nodes',
  {
    title: 'Batch move nodes',
    description: '批量移动多个节点，按偏移量 dx/dy 平移。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      node_ids: z.array(z.string()).describe('节点 ID 列表'),
      dx: z.number().describe('X 轴偏移量（px）'),
      dy: z.number().describe('Y 轴偏移量（px）'),
    },
  },
  async (args) => {
    try {
      const result = batchMoveNodes({
        feature: args.feature,
        node_ids: args.node_ids,
        dx: args.dx,
        dy: args.dy,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// batch_update_style：批量更新节点样式
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'batch_update_style',
  {
    title: 'Batch update node styles',
    description: '批量更新多个节点的样式和状态。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      node_ids: z.array(z.string()).describe('节点 ID 列表'),
      bg: z.string().optional().describe('背景色'),
      color: z.string().optional().describe('文字颜色'),
      status: z.enum(['draft', 'in_progress', 'done']).optional().describe('节点状态'),
    },
  },
  async (args) => {
    try {
      const result = batchUpdateStyle({
        feature: args.feature,
        node_ids: args.node_ids,
        bg: args.bg,
        color: args.color,
        status: args.status,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// batch_delete_nodes：批量删除节点
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'batch_delete_nodes',
  {
    title: 'Batch delete nodes',
    description: '批量删除多个节点及关联的边。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      node_ids: z.array(z.string()).describe('节点 ID 列表'),
    },
  },
  async (args) => {
    try {
      const result = batchDeleteNodes({
        feature: args.feature,
        node_ids: args.node_ids,
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

// diff_features：对比两个 feature 的差异
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'diff_features',
  {
    title: 'Diff two features',
    description: '对比两个 feature 的差异，包括节点、边、语义层、状态等的新增、删除和修改。可用于版本对比或方案对比。',
    inputSchema: {
      feature_a: z.string().describe('第一个 feature 名（基准）'),
      feature_b: z.string().describe('第二个 feature 名（对比）'),
    },
  },
  async (args) => {
    try {
      const result = diffFeatures({
        feature_a: args.feature_a,
        feature_b: args.feature_b,
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
// update_status：手动更新节点状态
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'update_status',
  {
    title: 'Update node implementation status',
    description:
      '手动更新节点/文件的实现状态。同时更新 geometry.nodes 和 semantic.files 中的状态，' +
      '并自动重新计算 feature 整体状态。render_dsl 后节点颜色会随之变化。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      node_id: z.string().describe('节点 ID'),
      status: z
        .enum(['draft', 'in_progress', 'done'])
        .describe('新状态：draft=待实现, in_progress=实现中, done=已完成'),
    },
  },
  async (args) => {
    try {
      const result = updateStatus({
        feature: args.feature,
        node_id: args.node_id,
        status: args.status,
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
// list_annotations：读取人审标注
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'list_annotations',
  {
    title: 'List review annotations',
    description: '读取人类在浏览器中添加的审查标注。LLM 应基于这些标注迭代修改设计。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      node_id: z.string().optional().describe('按节点 ID 过滤'),
      severity: z.enum(['info', 'warning', 'critical']).optional().describe('按严重程度过滤'),
      unresolved_only: z.boolean().optional().describe('只显示未解决的标注'),
    },
  },
  async (args) => {
    try {
      const result = listAnnotations({
        feature: args.feature,
        node_id: args.node_id,
        severity: args.severity,
        unresolved_only: args.unresolved_only,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
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
  'get_simulation_state',
  {
    title: 'Get simulation state',
    description:
      '读取仿真器当前状态和最近触发记录。' +
      '用于检查上一次 run_simulation 后的状态变化。' +
      '返回所有状态键值对和最近 5 条触发日志。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
    },
  },
  async (args) => {
    try {
      const result = getSimulationState({ feature: args.feature });
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

server.registerTool(
  'list_approvals',
  {
    title: 'List all approval requests',
    description:
      '列出所有审批请求，支持按状态和指派人筛选。' +
      '返回每条标注的 ID、内容、状态、指派人、节点和历史记录数。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      status: z.enum(['draft', 'pending_review', 'approved', 'rejected', 'needs_revision']).optional().describe('按状态筛选'),
      assignee: z.string().optional().describe('按指派人筛选'),
    },
  },
  async (args) => {
    try {
      const result = listApprovals({
        feature: args.feature,
        status: args.status,
        assignee: args.assignee,
      });
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

server.registerTool(
  'get_approval_history',
  {
    title: 'Get approval audit history',
    description:
      '获取单条标注的完整审批历史（审计日志）。' +
      '包含每次状态变更的操作人、时间、意见。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
      annotation_id: z.string().describe('标注 ID'),
    },
  },
  async (args) => {
    try {
      const result = getApprovalHistory({
        feature: args.feature,
        annotation_id: args.annotation_id,
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
  'list_snapshots',
  {
    title: 'List version snapshots',
    description: '列出 feature 的所有版本快照，按时间倒序排列。',
    inputSchema: {
      feature: z.string().describe('feature 名'),
    },
  },
  async (args) => {
    try {
      const result = listSnapshots({ feature: args.feature });
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
  'list_templates',
  {
    title: 'List architecture templates',
    description: '列出所有预置架构模板。模板可以快速生成设计起点，然后用增量编辑工具修改。',
  },
  async () => {
    try {
      const result = listTemplates();
      return { content: [{ type: 'text', text: result.message }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
);

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
