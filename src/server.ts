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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAllTools } from './server_registry.js';

const SERVER_NAME = 'design-canvas';
const SERVER_VERSION = '0.1.3';

const server = new McpServer(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    capabilities: { tools: {} },
    instructions:
      'design-canvas：人机共享的可视化协议层。支持两种工作流：' +
      '\n\n1. 完整 DSL 模式：render_dsl 渲染并保存 → get_dsl 读取（query:"dsl"/"features" 等）' +
      '\n\n2. 增量编辑模式（推荐）：manage_feature(action=create) 创建 → edit_dsl 统一提交所有写操作 → render_dsl 渲染预览' +
      '\n   edit_dsl 通过 operations 列表批量执行（任一失败全部回滚）：' +
      '\n   - {op:"add",type:"node",id:"n1",data:{label,x,y,bg,shape,type,status,swimlane,layer,host,shapes,...}}' +
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
      '\n\n增量模式让你逐步完善设计，避免每次重写整个 JSON。所有修改自动保存到 .design-canvas/features/。',
  },
);

// 统一注册主工具
registerAllTools(server);

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
