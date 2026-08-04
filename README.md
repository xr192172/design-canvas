# design-canvas

> 人机共享的可视化协议层。LLM 输出结构化 DSL → 渲染成自包含 HTML 网页 → 人看图改 JSON → LLM 读 JSON 理解。
>
> 作为 MCP 服务对外开放，兼容所有支持 MCP 的 client（Claude Desktop / Cursor / agent-shell 等）。

---

## 这是什么

一个 **MCP server**，提供工具让 LLM 把"脑子里的图"画出来给人类看。

人类和 LLM 协作开发时最大的问题是 **需求对不齐**：LLM 输出文字描述（"传送带有 L0 / SummaryZone / SectionQueue..."），人类在脑子里渲染成图，对齐成本极高。这个工具让 LLM 直接输出结构化 DSL JSON，渲染成可交互的 HTML 网页，人在网页上看图、改 JSON、再让 LLM 读改后的 JSON 继续迭代。

**产品形式**：MCP server 接收 DSL → 渲染成自包含 HTML 文件（内联 CSS+JS，零依赖）→ 用户浏览器打开 `file:///...output/xxx.html` 看图。

## 核心特性

- **双层 DSL**：几何层（位置/样式，人编辑）+ 语义层（文件/API/依赖，LLM 编辑），id 锚定避免冲突
- **MCP 协议**：标准 MCP server，任何 MCP client 都能接入
- **自包含 HTML**：渲染产物是单个 HTML 文件，内联所有 CSS/JS，可邮件/IM 分发
- **内置 TreeSitterKernel**：AST 解析能力内置（Go/TypeScript/Python/JavaScript），支持代码回填与一致性检查，无需外部 AST 服务
- **闭环工作流**：scaffold 生成骨架 → LLM 填充实现 → backfill_scaffold 解析实际 API 回填 DSL → check_status 推断状态 → render_dsl 颜色反馈
- **双向编辑**：浏览器端拖拽/属性编辑/撤销重做/右键菜单，改动回写 DSL 并持久化
- **人端筛选**：筛选条按状态（待实现/实现中/已完成）/ 孤岛（无连线节点）一键过滤 + 聚焦模式（只看选中节点 ±1 跳上下游）——把 LLM 端的查询过滤能力还给人类用户
- **数据流追踪**：选中 detail 层函数节点 → 注入数据（JSON）→ 光点沿 AST 级调用链流动，每步浮层显示"进/出值"，分流跳边高亮——不执行代码的静态推演（L5a）
- **人审流程**：人类在浏览器双击节点添加标注，LLM 读取标注迭代，支持审批链
- **HTTP API**：`serve.ts` 提供 /api/save /api/load /api/features 及布局/生成/检查端点，浏览器端可直接调用

## 快速开始

```bash
# 安装依赖
npm install

# 构建
npm run build

# 启动 MCP server（stdio 模式）
npm start

# 在 MCP client 配置中添加：
# {
#   "mcpServers": {
#     "design-canvas": {
#       "command": "node",
#       "args": ["/path/to/design-canvas/dist/src/server.js"]
#     }
#   }
# }
```

## MCP 工具一览（29 个）

> 工具分 **高频**（LLM 常用，推荐优先暴露）和 **按需**（浏览器/人审/版本管理场景）两组。
> 所有写操作已收敛为单个 `update_feature` 工具（批量 + 原子回滚）；所有读操作收敛为 `query_feature`（9 合一）。
> 完整工具演化与偏离记录见 [docs/evolution.md](./docs/evolution.md)。

### 核心 ★

| 工具 | 用途 |
|------|------|
| `render_dsl(dsl_json, output_path?)` | DSL → 自包含 HTML 文件，返回路径 |
| `query_feature(query, ...params)` | **统一读入口**：`dsl`（读 DSL）/ `features`（列表）/ `annotations`（标注，可 node_id/severity/unresolved_only 过滤）/ `approvals` / `approval_history` / `snapshots` / `templates` / `simulation_state` / `diff`（对比两 feature） |

### 增量编辑 ★

| 工具 | 用途 |
|------|------|
| `create_feature(feature, title?)` | 创建空 feature |
| `update_feature(feature, operations[])` | **统一写入口**：节点/边/文件/API 增删改、节点平移(move)、语义绑定(binding)、状态更新(status)。批量按序执行，任一失败全部回滚 |
| `clone_feature(source, target, title?)` | 克隆 feature |

`update_feature` 操作格式：`{op, type, id, data?}`
- `op`: `add` / `update` / `delete` / `move`（move 仅节点，`data:{dx,dy}` 相对平移）
- `type`: `node` / `edge` / `file` / `api`（id=所属 file_id）/ `binding`（节点绑文件）/ `status`（状态联动）
- 示例：`{op:"add",type:"node",id:"n1",data:{label:"服务",x:100,y:100,shape:"rounded"}}`

### 代码生成 ★

| 工具 | 用途 |
|------|------|
| `scaffold(feature, output_dir?, overwrite?, ui_framework?)` | 从 semantic 层生成代码骨架（go/ts/py/js/vue/tsx + INVARIANTS.md） |
| `backfill_scaffold(feature, scaffold_dir?)` | 解析实现代码的 API 签名回填 DSL actual_apis，输出差异报告 |
| `check_status(feature, scaffold_dir?)` | 扫描 TODO 残留量自动推断状态 |
| `consistency_check(feature, code_dir?)` | 对比 expected_apis vs 实际代码，输出一致性报告（只读） |

### 工程导入（★ 代码理解）

| 工具 | 用途 |
|------|------|
| `import_project(project_dir, ...)` | 导入真实工程生成 feature 图（多模块 go.mod 解析 + 依赖边 LCA 分层聚合，SQLite 增量缓存可选） |
| `check_monolith(file_path, ...)` | 单文件监控：超阈值自动 Louvain 社区发现，给拆分建议（仅建议不改代码） |
| `derive_detail_chain(feature, file, ...)` | 变形链推导：AST 级调用图生成 detail 层节点/边（主链 + 虚线跳边 + 截断分支节点）+ 数据形状卡 + 跨文件调用标注 |
| `derive_algorithm(feature, file, ...)` | 算法控制流推导：函数内部结构解析挂载 detail 层 |
| `inject_replay(feature, ...)` | 注入回放：进料口 JSON/预设异常场景注入，静态推演暴露问题 |

### 自动布局（按需）

| 工具 | 用途 |
|------|------|
| `dag_layout(feature, direction?, ...)` | 拓扑排序布局（适合 DAG，含 contains 边时自动拒绝平铺） |
| `force_layout(feature, repulsion?, ...)` | 力导向布局（复杂网络） |
| `grid_align(feature, grid_size?)` | 网格对齐 |

### 仿真器 ★

| 工具 | 用途 |
|------|------|
| `run_simulation(feature, events[], reset_before_run?)` | 批量传入事件验证级联触发 |
| `reset_simulation(feature)` | 重置到初始状态 |

### 人审流程（按需）

| 工具 | 用途 |
|------|------|
| `add_annotation(feature, text, ...)` | LLM 主动添加标注 |
| `resolve_annotation(feature, annotation_id, note?)` | 标记标注已解决 |
| `submit_approval` / `review_annotation` | 提交审批 / 审批决策 |

### 版本快照（按需）

| 工具 | 用途 |
|------|------|
| `save_snapshot(feature, label, description?)` | 保存版本快照 |
| `rollback_snapshot(feature, snapshot_id)` | 回滚（自动备份当前状态） |
| `delete_snapshot(feature, snapshot_id)` | 删除快照 |

### 模板库（按需）

| 工具 | 用途 |
|------|------|
| `create_from_template(template_id, feature, title?)` | 从模板创建 feature（crud_service / event_driven / microservice / pipeline） |

### 导出（按需）

| 工具 | 用途 |
|------|------|
| `export_svg(feature, output_path?)` | 导出 SVG 矢量图 |
| `export_markdown(feature, output_path?)` | 导出 Markdown 设计文档 |

## HTTP API（serve.ts）

除 MCP 工具外，`npm run serve` 启动 HTTP server，浏览器端可直接调用：

- `POST /api/save` / `GET /api/load` — DSL 读写
- `GET /api/features` — 列出 feature
- `/api/layout` / `/api/scaffold` / `/api/consistency` — 布局/生成/检查能力
- 静态文件服务（output/ 目录）

## 开发路线（实际进度）

| 阶段 | 内容 | 状态 |
|------|------|------|
| 1 | DSL Schema + 类型 + 校验器 | ✅ 完成 |
| 2 | MCP server + render_dsl | ✅ 完成 |
| 3 | HTML 渲染器 | ✅ 完成 |
| 4 | 传送带示例 + e2e 测试 | ✅ 完成 |
| 5 | 一致性检查 + 代码回填（内置 TreeSitterKernel） | ✅ 完成 |
| 6 | 双向编辑（拖拽回写 + 撤销/重做 + 属性面板） | ✅ 完成 |
| 7 | 代码骨架生成（scaffold 多语言） | ✅ 完成 |
| 8 | 仿真器 + 动画系统 | ✅ 通用动画引擎 L0-L4.5（粒子流/分层/条件分支/函数绑定/异常语义/effect 注册，conveyor 已迁移）；⏳ L5 反向提取（代码→动画 DSL） |
| 9 | 分层披露（main/error/detail 三层 + 宿主角标钻入） | ✅ 完成 |
| 10 | 工程导入（import_project/check_monolith/derive_detail_chain/derive_algorithm/inject_replay） | ✅ 完成 |
| 11 | SQLite 符号缓存（schema v2 + 增量解析 + 删除侦测） | ✅ 完成 |
| 12 | MCP 工具收敛（写→update_feature，读→query_feature） | ✅ 完成 |
| 13 | 人端筛选（筛选条 + 聚焦模式） | ✅ 完成 |
| 14 | 调用边接入渲染 + 数据流追踪（AST 级调用图 → detail 层虚线跳边/分支节点 → 注入数据静态推演） | ✅ 完成（L5a 静态推演，判定精确表达待 CFG 接入） |
| 15 | 全量借鉴路线图（Diff Impact / 语义搜索 / 文件监听 / 多平台分发） | ⏳ 见 [docs/evolution.md](./docs/evolution.md) §6 |

> 设计文档原意与实际实现的偏离追溯见 [docs/evolution.md](./docs/evolution.md)。

## 示例

传送带模型示例见 [examples/conveyor.json](./examples/conveyor.json)，对应 agent-shell v2 上下文引擎的可视化。渲染产物 [output/conveyor.html](./output/conveyor.html) 可直接浏览器打开。

## 技术栈

- **MCP server**：TypeScript + [@modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- **AST 解析**：tree-sitter（Go/TypeScript/Python/JavaScript），动态检测语言包
- **渲染器**：HTML 字符串拼接（不用 React/Vite，MVP 阶段保持零构建链）
- **Schema 校验**：ajv + ajv-formats
- **测试**：vitest

## 项目背景

源自 agent-shell 项目主脑与左脑的讨论。LLM 协作开发时需求对不齐成本高，需要"共享可视化协议层"。独立项目化以便对外开放。完整背景与设计决策见 [docs/design.md](./docs/design.md)，变更追溯见 [docs/evolution.md](./docs/evolution.md)。

## License

MIT
