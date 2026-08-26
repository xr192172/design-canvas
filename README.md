# design-canvas

> 人机共享的可视化协议层。LLM 输出结构化 DSL → 渲染成自包含 HTML → 人看图改 JSON → LLM 读 JSON 理解。
>
> 标准 MCP server，兼容所有支持 MCP 的 client（Claude Desktop / Cursor / VS Code / agent-shell 等）。

---

## 这是什么

Agent 与人类协作开发时最大的痛点是**需求对不齐**：LLM 输出文字描述（“传送带有 L0 / SummaryZone / SectionQueue…”），人类在脑子里渲染成图，对齐成本极高。

design-canvas 让 LLM 直接输出**结构化 DSL JSON** → 渲染成**可交互的自包含 HTML 网页**（零依赖，内联 CSS+JS）。人看图上手、改 JSON，LLM 再读改后的 JSON 继续迭代。它是一层**共享的可视化协议层**，把 Agent 的“脑子里的图”画给人类看。

**产品形式**：MCP server 接收 DSL → 渲染成单个 HTML 文件 → 浏览器打开 `file:///.../xxx.html` 看图与交互。

## 核心能力线

| 能力线 | 说明 | 代表工具 |
|---|---|---|
| **画图 / 出图** | 从结构数据生成设计图、思维导图、架构图，可交互双向编辑 | `get_dsl` / `edit_dsl` / `manage_feature` / `render_dsl` |
| **代码理解** | 工程导入、语义搜索、影响分析、架构分层、微服务拆分、算法流推导、数据流追踪 | `explore_code`（`import/semantic_search/diff_impact/arch_layer/derive_split/…`） |
| **生成 / 回填 / 一致性** | 从 DSL 生成代码骨架；解析实现回填 actual_apis；对比期望契约输出一致性报告 | `scaffold` / `backfill_scaffold` / `consistency_check` |
| **重构防线** | 重构前基线验证、重构后契约对账、提交层产物完整性自检、失败回滚的闭环 | `verify_refactor` / `refactor_pipeline` / `contract_gate` / `submit_gate` / `release tools` |
| **插桩 / 摄像头** | 对被测代码动态插桩，采集真实行为与契约比对，识别行为偏差（TS + Go 双语言链） | `src/camera/`（TS 插桩）+ `go-camera/`（Go 插桩 + probe） |
| **多语言 AST 根基** | 内置 TreeSitterKernel（Go/TypeScript/Python/JavaScript），符号/import/调用边/类型引用统一产出，支撑改造能力（提升别名清洗等） | `ts_kernel` / `package_migration` |

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

或一键分发到各主流 MCP client（Claude / Cursor / VS Code / Codex / Copilot / Gemini / Windsurf / Cline）：

```bash
node scripts/install_mcp.mjs            # 写入全部已安装 client 的配置（自动合并 + 备份）
node scripts/install_mcp.mjs --list     # 查看各平台配置路径与写入状态
node scripts/install_mcp.mjs --dry-run  # 预览将写入的内容（不落盘）
node scripts/install_mcp.mjs --target claude  # 只写指定平台
```

## MCP 工具一览（8 主工具 + 别名）

> 工具从历史版本收敛为 **8 个主工具**（参数化分发），旧工具名**全部保留为别名**指向主工具，存量会话/脚本零破坏。新会话请直接使用主工具。

| 主工具 | 用途 |
|------|------|
| `get_dsl` | **统一只读入口**：`query`(dsl/features/annotations/approvals/snapshots/templates/simulation_state/diff) + `view`(design/live) + 过滤参数 |
| `edit_dsl` | **统一写入口**：`operations[]` 批量增删改/平移/语义绑定/状态更新/标注/审批/快照/自动布局，按序执行、任一失败全量回滚（原子）。`view=live` 拒绝写入 |
| `manage_feature` | **生命周期入口**：`action`(create/clone/template/list/delete) |
| `render_dsl` | **渲染入口**：`format`(html 默认/svg/markdown) + `view`(design/live) + `output_path` |
| `scaffold` | 从 DSL 语义层生成代码骨架 + 状态推断 |
| `backfill_scaffold` | 解析实现代码 API 签名回填 actual_apis，输出差异报告 |
| `consistency_check` | 对比 expected_apis vs 实际代码，输出一致性报告 + 跨文件不变式（只读） |
| `explore_code` | **代码理解入口**：`action`(import/semantic_search/diff_impact/arch_layer/guided_tour/check_monolith/analyze_monolith/derive_split/derive_detail_chain/derive_anim_flow/derive_algorithm/inject_replay/run_simulation/reset_simulation/watch) + `args` |

### `view` 参数（design | live，默认 design）

- **design**（默认）= 设计视图：活态 DSL + feature 存档，LLM 刻意设计的主战场。对应浏览器「🎭 设计」。
- **live** = 实际视图：代码快照（只读），只能由 `explore_code action=import/watch` 重建。对应浏览器「⚡ 实际」。
- **判别口诀**：要改的那一版 = `design`；要看的代码现状 = `live`。

### 别名（旧工具名 → 主工具）

| 旧名 | 新归属 |
|---|---|
| `query_feature` | → `get_dsl` |
| `update_feature` | → `edit_dsl` |
| `create_feature` / `clone_feature` / `create_from_template` | → `manage_feature` |
| `export_svg` / `export_markdown` | → `render_dsl` |
| `check_status` | → `scaffold` |
| `import_project` / `semantic_search` / `diff_impact` / `arch_layer` / `guided_tour` / `check_monolith` / `analyze_monolith` / `derive_split` / `derive_detail_chain` / `derive_anim_flow` / `derive_algorithm` / `inject_replay` / `run_simulation` / `reset_simulation` / `watch_project` | → `explore_code` |
| `add_annotation` / `resolve_annotation` / `dag_layout` / `force_layout` / `grid_align` / `submit_approval` / `review_annotation` / `save_snapshot` / `rollback_snapshot` / `delete_snapshot` | → `edit_dsl` |

## 能力矩阵 & 多语言支持

工具基于 **168+ 语言 AST 解析器**（tree-sitter）按需拉取。核心通用根基 `ts_kernel` 对已安装语言全部全量支持（符号/import/调用边/类型引用）；部分改造类功能按语言分级落地：

- **full_ast**：Go / TypeScript / JS 家族全量；Python 视功能而定
- **regex_fallback**：少数功能对个别语言回退到正则
- **unimplemented**：未落地的「功能 × 语言」对——**可见、可排期**，而非隐藏窟窿

体检时自动扫描缺口：

```bash
npm run doctor        # 环境就绪检查 + 能力矩阵缺口自检
npm run capability    # 单独输出能力缺口（JSON / 人类可读）
```

## 测试 / 验证

```bash
npm test              # vitest 全量
npm run doctor        # 环境体检 + 能力缺口
```

## 示例

传送带模型示例见 [examples/conveyor.json](./examples/conveyor.json)（对应 agent-shell 上下文引擎可视化），构建后可用 `render_dsl`/`serve` 渲染为 HTML 浏览器查看。

## 技术栈

- **MCP server**：TypeScript + [@modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- **AST 解析**：tree-sitter（Go / TypeScript / Python / JavaScript），动态检测语言包
- **渲染器**：HTML 字符串拼接（零构建链，产物单文件自包含）
- **Schema 校验**：ajv + ajv-formats
- **测试**：vitest

## 心智 / 渐进披露

仓库内置面向 Agent 的两个 skill（`.trae/skills/`）：

- **design-canvas-router**：渐进披露路由，「遇到什么问题 → 调哪个工具」分层定位，先查再用、不为小愿望造工具。
- **design-canvas-mind**：心智外衣，注入能力地图、愿望→即席编排、后工具自动前置 + 缓存跳过、诚实交付纪律。

用这条工具链前请先穿戴它们，避免“为最小愿望手写一套新工具”。

## License

MIT