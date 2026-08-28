# design-canvas

> 人机共享的可视化协议层：LLM 输出结构化 DSL JSON → 面向人类的协作前端把它渲染成可交互图 → 人看图改 JSON → LLM 读 JSON 继续迭代。
>
> 标准 MCP server，兼容所有支持 MCP 的 client（Claude Desktop / Cursor / VS Code / Cline 等）。前端采用前后端分离，可视化协作由独立配套项目承载（见下）。

---

## 这是什么

Agent 与人类协作开发时最大的痛点是**需求对不齐**：LLM 输出文字描述（“传送带有 L0 / SummaryZone / SectionQueue…”），人类在脑子里渲染成图，对齐成本极高。

design-canvas 让 LLM 直接输出**结构化 DSL JSON**（双层：几何 + 语义，取消歧义），作为**共享的可视化协议层**，把 Agent 的“脑子里的图”用数据表达出来。可视化与交互由**分工明确的前端**接手：人替换 JSON、改 JSON，LLM 再读回继续迭代。它是一层可复用的**数据/协议提供方**，不绑定任何特定前端。

### 前端分工（前后端分离）

- 本仓库（MCP server）是**数据/协议层**：负责 DSL 的存取、代码理解、生成/回填/一致性、重构防线、插桩对账，统一以 JSON 与 MCP 工具对外——
- 可视化协作工作台是**独立的配套前端项目**，订阅本仓库产出的 DSL JSON 并渲染成交互图。
- 内置一个**精简自包含 HTML 渲染器**（`render_dsl`）作快速预览兜底：无前端环境时也能 `npm run serve` 把单张 DSL 渲染成单文件 HTML 检查。

## 核心能力线

一条主线：**任意代码 → 积木（原料端）→ 可信组合（质检端）**。两条线不冗余，是同一流水线的两段——积木线把 LLM 新写 / 开源抓来 / 现有工程的任意代码加工成「带契约插头的积木」；杂交线用验证栈（契约核对、行为对账、拼装校验、防线闸门）让拼装可信。「契约」是两线共享的唯一插头：积木线生产它，杂交线验证它。

| 能力线 | 说明 | 代表工具 |
|---|---|---|
| **可视化协议层** | 人 / LLM ↔ 契约 ↔ 代码 的双向绑定：DSL 写读编辑、设计视图 vs 代码快照对比、内置渲染兜底 | `get_dsl` / `edit_dsl` / `manage_feature` / `render_dsl` / `diff_views` |
| **代码理解** | 看懂任意代码：工程导入、语义搜索、影响分析、架构分层、微服务拆分、算法流 / 数据流推导 | `import_project` / `explore_code`（`semantic_search` / `diff_impact` / `arch_layer` / `derive_split` / …） |
| **代码积木线 · 原料端** | 任意来源代码 → 带契约插头的积木：收割 → 切块 → 抽契约 → 瘦身入箱 → 搜索 → 拼装 | `harvest_from_url` / `harvest_closure` / `brickify` / `extract_contracts` / `slim_brick` / `search_bricks` / `assemble_bricks` |
| **代码杂交线 · 质检端** | 让拼装可信：契约核对、camera 运行探针对账、行为基线、拼装校验、防线闸门（验证通过才提交，失败回滚） | `contract_gate` / `camera_instrument` / `camera_judge` / `chain_recon` / `reconcile_brick` / `verify_refactor` / `submit_gate` |
| **生成 / 回填 / 一致性** | 从 DSL 生成代码骨架；解析实现回填 actual_apis；对比期望契约输出一致性报告 | `scaffold` / `backfill_scaffold` / `consistency_check` |
| **诊断 / 审闭环** | 症状 → 根因 → 修复 → 验证 → 提交（或回退）的闭环；LLM 审裁决门 | `diagnose-loop` / `diagnose` / `refactor_judge` |
| **多语言 AST 根基** | 内置 TreeSitterKernel（Go / TypeScript / Python / JavaScript），符号 / import / 调用边 / 类型引用统一产出，支撑全部改造能力 | `ts_kernel` / `package_migration` |

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

## MCP 工具一览（34 个注册工具）

> 工具已收敛为「主工具 + 专项工具」两级：8 个主工具承担 DSL 读写 / 生命周期 / 渲染 / 代码理解的统一入口，其余为单一职责的专项工具。**旧工具名别名已于 2026-08-17 移除**，不再保留兼容别名，存量脚本请改用下方主工具名。

### 8 个主工具（统一入口）

| 主工具 | 用途 |
|------|------|
| `get_dsl` | **统一只读入口**：`query`(dsl/features/nodes/edges/node/decisions/files/file/calls/annotations/approvals/approval_history/snapshots/templates/simulation_state/diff) + `view`(design/live) + 过滤参数 |
| `edit_dsl` | **统一写入口**：`operations[]` 批量增删改/平移/语义绑定/状态更新/标注/审批/快照/自动布局，按序执行、任一失败全量回滚（原子）。`view=live` 拒绝写入 |
| `manage_feature` | **生命周期入口**：`action`(create/clone/template/list/delete) |
| `render_dsl` | **渲染入口**：`format`(mindmap/html/svg/markdown) + `view`(design/live) + `output_path` |
| `scaffold` | 从 DSL 语义层生成代码骨架 + 状态推断（`ui_framework`: vue/react/html） |
| `backfill_scaffold` | 解析实现代码 API 签名回填 actual_apis，输出差异报告 |
| `consistency_check` | 对比 expected_apis vs 实际代码，输出一致性报告 + 跨文件不变式（只读） |
| `explore_code` | **代码理解入口**：`action`(search/diff_impact/arch_layer/guided_tour/check_monolith/derive_split/derive_chain/derive_anim_flow/derive_algorithm/derive_mind_map/inject_replay/run_simulation/reset_simulation/watch) + `args` |

### `view` 参数（design | live，默认 design）

- **design**（默认）= 设计视图：活态 DSL + feature 存档，LLM 刻意设计的主战场。对应浏览器「🎭 设计」。
- **live** = 实际视图：代码快照（只读），只能由 `import_project` / `explore_code action=watch` 重建。对应浏览器「⚡ 实际」。
- **判别口诀**：要改的那一版 = `design`；要看的代码现状 = `live`。

### 其余专项工具（26 个，独立注册）

| 工具 | 能力线 | 用途 |
|------|------|------|
| `import_project` | 代码理解 | 导入代码项目为 DSL（`project_dir` + `feature`） |
| `diff_views` | 代码理解 | 对比设计视图与 live 代码快照 |
| `render_sandbox` | 代码理解 | 渲染依赖驱动的功能社区工作台（brickify 预览） |
| `harvest_closure` | 积木库 | 连同传递 import 闭包一起收割积木 |
| `harvest_from_url` | 积木库 | 从 git URL / 本地项目收割积木入箱 |
| `extract_contracts` | 积木库 | 抽取积木契约（role/shapes/effects） |
| `reconcile_effects` | 积木库 | 用 camera 运行时观察对账 effect 候选 |
| `reconcile_brick` | 积木库 | 用 camera 运行时观察对账积木契约 |
| `search_bricks` | 积木库 | 搜索积木架（跨项目复用目录），`language` 过滤 |
| `assemble_bricks` | 积木库 | 用箱装积木拼装新项目 |
| `slim_brick` | 积木库 | 把 Go 积木瘦身为 -slim 派生积木（编译器式死码剪枝） |
| `narrate_step` | 积木库 | 把流水线步骤叙述为受治理的叙述积木 |
| `camera_instrument` | 摄像头 | 自动插桩 / 还原 TS 项目（instrument/uninstrument/restore） |
| `camera_log` | 摄像头 | 按文件查询 Camera 运行时日志 |
| `camera_judge` | 摄像头 | 批量裁决 Camera 事件 |
| `chain_recon` | 摄像头 | 把宿主链与其真实运行事件对账（meso 层） |
| `edit_code` | 改造 | 符号级代码编辑（`op`: replace/insert/delete/range） |
| `rename_many` | 改造 | 批量重命名局部变量（作用域隔离） |
| `rename_symbol` | 改造 | 跨文件模块级符号重命名 |
| `rename_file` | 改造 | 文件级重命名 + import 引用改写（防文件悬空） |
| `remove_dead_imports` | 改造 | 移除 dead_deps 报告的失效 import |
| `refactor_pipeline` | 改造 | 确定性重构流水线（dead imports + dead statements + package migration） |
| `suggest_renames` | 改造 | 为短名/无意义变量建议语义化名字 |
| `find_similar_names` | 改造 | 检测易混淆相似名并消歧 |
| `refactor_judge` | 审闭环 | LLM 审裁决门：采纳/驳回/上抛不确定项给人类 |
| `diagnose` | 诊断 | 症状→根因六步流水线：症状解析→候选定位（符号缓存）→调用链追溯→影响面→根因聚合（规则+可选 LLM，未配置自动降级）→验证建议（只建议不执行） |

### 一键诊断闭环（CLI，非 MCP 工具）

`diagnose-loop` 把诊断从"只建议"升级为**闭环**：诊断 → 修复 → 验证 → 提交（或回退）。

```bash
npm run diagnose-loop -- --project <项目目录> --symptom "<症状>"
```

| 参数 | 说明 |
|---|---|
| `--project <dir>` | 目标项目（**必须是 git 仓库**，回退依赖 git 还原） |
| `--symptom "<症状>"` | 症状描述（报错信息 / 现象） |
| `--auto` | 全自动：基线提交 + 跳过补丁审批 + 验证通过自动提交 |
| `--apply` | 跳过补丁审批直接应用（仍先打印待审批真实 diff） |
| `--skip-verify` | 跳过验证阶段（未验证的改动不自动提交） |
| `--verify-timeout <秒>` | 验证命令超时（默认 300s） |

闭环五阶段：① 基线快照（改前自动提交）→ ② 建立符号缓存 → ③ 诊断（规则+LLM 双引擎）→ ④ LLM 行级补丁：修改白名单（根因文件 + 建议 target_file）+ 行号越界校验 + 审批展示磁盘真实 diff，**验证契约（测试命令 + 测试期望）喂给 LLM**，修复按验收标准生成 → ⑤ 运行项目测试验证：通过则精确提交补丁文件；失败则自动回退、项目恢复到修复前状态。

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

一个「分层上下文流水线传送带」DSL 示例：[examples/conveyor.json](./examples/conveyor.json)（含 33 节点 / 33 边、分层、标注，也用作渲染器回归测试的中坚 fixture）。构建后可用 `render_dsl`/`serve` 渲染为 HTML 浏览器预览。

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