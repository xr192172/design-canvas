# design-canvas 演化追溯

> 本文档追溯项目从设计文档（[design.md](./design.md) / [mvp-plan.md](./mvp-plan.md)）到实际实现的变更轨迹。
> 设计文档的**核心观点保留不变**，本文档仅记录偏离、扩展与优化。

## 1. 设计文档核心观点（不变）

以下观点源自 [design.md](./design.md)，是项目的立身之本，后续演化不得违背：

1. **人机共享的可视化协议层**——人类用鼠标操作，LLM 用文字描述，双方在同一张"活图纸"上对齐
2. **双层 DSL**——几何层（人编辑位置/样式）+ 语义层（LLM 编辑文件/API/依赖），通过 id 锚定避免冲突
3. **自包含 HTML 产物**——单 HTML 文件，内联 CSS+JS，零外部依赖，可 file:// 打开
4. **MCP 协议开放**——标准 MCP server，兼容所有 MCP client
5. **LLM 输出 DSL → 渲染 HTML → 人看图改 JSON → LLM 读 JSON 迭代**——闭环工作流

## 2. 变更追溯

### 2.1 MCP 工具契约变更

#### 设计文档规划（5 工具）

| 工具 | 用途 |
|---|---|
| `render_dsl` | DSL → HTML |
| `get_dsl` | 读取已保存 DSL |
| `list_features` | 列出 feature |
| `design_check` | 对比 codebase-memory-mcp 现状 |
| `export_skeleton` | 生成文件骨架 |

#### 实际实现（37 工具，写操作已收敛为 update_feature）

| 分组 | 工具 | 变更性质 |
|---|---|---|
| **核心渲染** | `render_dsl` / `get_dsl` / `list_features` | 对齐设计 |
| **增量编辑** | `create_feature` / `update_feature` | **收敛**——原 16 个写工具（add/update/delete node/edge/file/api、set_node_semantic、batch_*、update_status）合并为单个 `update_feature`，operations 批量提交 + 原子回滚 |
| **批量与对比** | `clone_feature` / `diff_features` | **新增**（batch_move/update_style/delete 已并入 `update_feature`） |
| **代码生成** | `scaffold`（替代 `export_skeleton`）/ `backfill_scaffold` / `check_status` / `consistency_check`（替代 `design_check`） | **改名+拆分**（update_status 已并入 `update_feature` 的 status 操作） |
| **人审流程** | `list_annotations` / `resolve_annotation` / `add_annotation` / `submit_approval` / `review_annotation` / `list_approvals` / `get_approval_history` | **新增**——设计文档只提标注，实际做了完整审批链 |
| **自动布局** | `dag_layout` / `force_layout` / `grid_align` | **新增** |
| **仿真器** | `run_simulation` / `get_simulation_state` / `reset_simulation` | **新增**——对应设计文档阶段 8 |
| **版本管理** | `save_snapshot` / `list_snapshots` / `rollback_snapshot` / `delete_snapshot` | **新增** |
| **模板库** | `list_templates` / `create_from_template` | **新增** |
| **导出** | `export_svg` / `export_markdown` | **新增**——设计文档只提导出 JSON |

#### 变更原因

- **`design_check` → `consistency_check` + `backfill_scaffold`**：原设计依赖外部 codebase-memory-mcp 作为 MCP client 调用 AST 服务。实际改为内置 TreeSitterKernel（见 2.2），因此一致性检查和代码回填拆为两个独立工具，职责更清晰
- **`export_skeleton` → `scaffold`**：增强版，支持多语言（go/ts/py/js/vue/tsx）、UI 骨架生成、自定义模板、INVARIANTS.md 生成
- **增量编辑模式**：原设计要求 LLM 每次输出完整 DSL JSON，迭代成本高。增量工具让 LLM 逐步完善设计
- **写操作收敛为 `update_feature`**：16 个写工具参数模式高度重复（feature + id + 字段），LLM 选择成本高、工具列表冗长。合并后统一为 `{op, type, id, data}` 操作格式，支持批量提交与原子回滚（任一失败恢复操作前快照），原子操作实现仍复用 `node_ops` / `edge_ops` / `file_ops` / `api_ops` / `status_tools` 模块

#### 二次收敛（37 → 8 主工具 + 33 别名，2026-08-07）

> 对应路线图 6.2 序号 2（MCP 工具收敛到 ~8 个）。完整方案见 [plans/2026-08-07-mcp-tool-convergence.md](./plans/2026-08-07-mcp-tool-convergence.md)。

| 主工具 | 聚合的旧工具 |
|---|---|
| `get_dsl` | `query_feature` |
| `edit_dsl` | `update_feature` + `add_annotation` / `resolve_annotation` / `dag_layout` / `force_layout` / `grid_align` / `submit_approval` / `review_annotation` / `save_snapshot` / `rollback_snapshot` / `delete_snapshot` |
| `manage_feature` | `create_feature` / `clone_feature` / `create_from_template` |
| `render_dsl` | `render_dsl` / `export_svg` / `export_markdown` |
| `scaffold` | `scaffold` / `check_status` |
| `backfill_scaffold` | `backfill_scaffold` |
| `consistency_check` | `consistency_check` |
| `explore_code` | `import_project` / `semantic_search` / `diff_impact` / `arch_layer` / `guided_tour` / `check_monolith` / `analyze_monolith` / `derive_split` / `derive_detail_chain` / `derive_anim_flow` / `derive_algorithm` / `inject_replay` / `run_simulation` / `reset_simulation` / `watch_project` |

关键决策：
- **收敛 = 新增主工具 + 旧名保留为别名**，不删名。`server_registry.ts` 定义 `TOOL_DEFS`（8 主工具）+ `ALIASES`（33 旧名→主工具 + 参数适配器）+ `LEGACY_HANDLERS`（尚未并入 edit_dsl 的写工具，先保兼容）。全项目 100+ 文件命中旧工具名，删名会连锁破坏存量会话/脚本/文档。
- **`view` 参数（design/live）**：`get_dsl` / `edit_dsl` / `render_dsl` 统一显式声明视图，`edit_dsl view=live` 拒绝写入（写护栏），解决"设计视图 vs 实际视图"混淆。
- **别名入参 schema 用 `z.record` 透传**：不能传空 schema `{}`，否则 SDK 转成 `z.object({})` 会 strip 未知键，导致别名接收不到参数（踩坑记录）。

### 2.2 架构决策变更

#### codebase-memory-mcp 集成 → 内置 TreeSitterKernel

**设计文档第 5 章**：design-canvas 作为 codebase-memory-mcp 的 MCP client，通过 `index` / `snippet` / `graph` / `trace` action 查询 codebase AST。

**实际实现**：在 [src/tools/ts_kernel/](../src/tools/ts_kernel/) 内置 TreeSitterKernel，动态检测 `node_modules/tree-sitter-*` 语言包，支持 Go/TypeScript/Python/JavaScript AST 解析。

**变更原因**：
- 去掉外部 MCP 依赖，design-canvas 可独立运行
- TreeSitterKernel 设计为可被 design-canvas 和 ai-base 共享（抽象接口 + 动态加载 + 优雅降级）
- backfill_scaffold 以 AST 解析为主、正则为辅，比纯外部调用更可控

**保留的集成点**：[serve.ts](../src/tools/serve.ts) 暴露 `/api/consistency` HTTP 端点，未来若接入 codebase-memory-mcp 可在此层适配，不破坏现有工具。

#### 持久化路径

**设计文档**：`~/.design-canvas/features/<feature>.json`（用户全局）

**实际实现**：`<cwd>/.design-canvas/features/<feature>.json`（按工作目录隔离）

**变更原因**：不同项目的设计图应隔离，避免 LLM 读取到无关项目的 DSL。全局路径改为按 cwd 隔离更合理。

#### HTML 模板结构

**设计文档**：`src/renderer/templates/page.html` 模板文件 + 占位符替换

**实际实现**：模板逻辑内联到 [html_renderer.ts](../src/renderer/html_renderer.ts) / [styles.ts](../src/renderer/styles.ts) / [scripts.ts](../src/renderer/scripts.ts)，无独立模板文件

**变更原因**：MVP 阶段渲染器是 HTML 字符串拼接，模板文件增加间接层但不增加灵活性。未来若迁移 React 可重新引入。

### 2.3 阶段实现进度

| 阶段 | 设计文档内容 | 实际状态 | 偏离说明 |
|---|---|---|---|
| 1 | DSL Schema + 类型 + 校验器 | ✅ 完成 | 对齐 |
| 2 | MCP server + render_dsl | ✅ 完成 | 对齐 |
| 3 | HTML 渲染器 | ✅ 完成 | 对齐（模板结构简化） |
| 4 | 传送带示例 + e2e 测试 | ✅ 完成 | 对齐 |
| 5 | design_check 对比 codebase | ✅ 完成 | 改名为 consistency_check + backfill_scaffold，内置 AST |
| 6 | 双向编辑（拖拽回写） | ✅ 完成 | 超预期——含撤销/重做、多选、右键菜单、属性编辑面板 |
| 7 | export_skeleton 文件骨架 | ✅ 完成 | 改名为 scaffold，增强多语言/UI 骨架 |
| 8 | 动画预览 | ⚠️ 部分完成 | **通用化进行中**——见 2.4 |

### 2.4 动画系统现状（迁移中）

设计文档阶段 8 原意：DSL 加 `animations` 字段，伪代码驱动状态机，HTML 内嵌 JS 播放，可暂停/步进。

**通用动画引擎已实现**（[animation_engine.ts](../src/renderer/animation_engine.ts)）：

| 阶段 | 状态 | 内容 |
|---|---|---|
| A | ✅ | DSL schema：AnimationFlow / AnimationValue / AnimationHandler / AnimationBranch 类型，DesignDSL 扩展 `animations_v2?` |
| B | ✅ | L0 默认粒子流自动推导（跳过 sim-edge / contains）+ L1 状态闪烁 + in_progress 呼吸 |
| C | ✅ | L2 显式 flow（periodic/event 触发器）+ 粒子值类型标签 + 节点 IO 提示浮层 + 仿真器事件桥接 |
| D | ✅ | 内置 effect 注册：card_create / card_fold / card_evict + triggerEffect 手动触发接口 |
| E | ✅ | conveyor.json 迁移到 L2 + 删除 scripts.ts 专用动画代码（2026-08-07） |

**阶段 E 已解决**（2026-08-07）：
1. ~~专用代码未清除~~ → 已删除 scripts.ts 中旧动画播放器（animState / initAnimationPlayer 全块）与 html_renderer.ts 旧 anim-panel UI、styles.ts 旧动画样式
2. ~~scripts.ts 体积~~ → 旧专用动画代码已删除；体积因上一阶段词典渲染代码新增而回涨至 ~217KB（非动画代码）
3. ~~缺乏声明层~~ → conveyor.json 已显式声明 5 个 L2 flow（含 card_sync 全量同步；card_create/fold/evict 由 card_sync 统一驱动），浏览器验证卡片创建/折叠/淘汰/新增均通过

**仍存在的问题**（阶段 14 待解决）：
1. **暂停/步进 UI**——通用引擎已实现 pause/resume/step，动画控制按钮已在仿真器面板接入

**已解决**（相对旧版 evolution.md 记录的问题）：
- ~~高度专用化~~ → 通用引擎不硬编码节点 ID，通过 effect 注册表扩展
- ~~动画逻辑与渲染耦合~~ → 独立 animation_engine.ts 模块，由 html_renderer.ts 注入
- ~~缺乏动画声明层~~ → animations_v2 字段已支持，conveyor.json 已有 5 个 L2 flow 验证（含 card_sync）

## 3. 当前实现 vs 设计文档对照

### 3.1 已对齐

- 双层 DSL 设计（geometry + semantic）
- 自包含 HTML 产物（内联 CSS+JS）
- MCP stdio 传输
- DSL Schema 校验 + 锚定完整性检查
- render_dsl / get_dsl / list_features 三个核心工具
- 传送带示例 + e2e 测试
- 双向编辑（阶段 6，超预期完成）

### 3.2 偏离但合理（保留）

- 增量编辑工具集（40+ 工具）——替代"每次重写整个 JSON"
- 内置 TreeSitterKernel——替代外部 codebase-memory-mcp 依赖
- scaffold 增强——多语言 + UI 骨架 + 模板
- 持久化按 cwd 隔离——替代全局路径
- serve.ts HTTP 端点——浏览器端直接调用布局/生成/检查能力

### 3.3 待对齐（需决策）

| 项 | 现状 | 待决策 |
|---|---|---|
| ~~动画系统专用化~~ | ~~硬编码 conveyor 节点 ID~~ → ✅ 通用引擎已实现，专用代码已清除 | 阶段 E 已完成 |
| 消息粒子终点处理 | 当前淡出移除（违反 project_memory 旧约束） | 保留淡出？还是恢复"转换为可拖拽容器"？ |
| 文档更新 | design.md / mvp-plan.md / README.md 严重滞后 | 更新旧文档？还是以 evolution.md + animation-design.md 为准？ |
| tmp_backfill_* 污染 | 80+ 临时目录未清理 | backfill.ts 改用 os.tmpdir() 或运行后清理 |
| scripts.ts 体积 | ~217KB 单文件（含词典渲染代码，非动画） | 后续随词典/动画能力独立化逐步拆分 |

## 4. 设计哲学演化

### 4.1 从"渲染器"到"协议层"

设计文档定位：LLM 输出 DSL → 渲染 HTML（单向）

实际演化：双向协议层——
- LLM → DSL → HTML（渲染）
- 人 → 拖拽/编辑 → DSL → LLM 读取（回写）
- serve.ts SSE 实时同步（浏览器 ↔ server ↔ LLM）

### 4.2 从"对比工具"到"闭环工作流"

设计文档阶段 5：design_check 一次性对比

实际演化：完整闭环——
1. `scaffold` 生成骨架
2. LLM 填充实现
3. `backfill_scaffold` 解析实际 API 回填 DSL
4. `check_status` 推断状态
5. `consistency_check` 验证一致性
6. `render_dsl` 颜色反馈
7. 人审 annotation + approval
8. `save_snapshot` 版本管理

### 4.3 工具数量的权衡

设计文档：5 工具（刻意收敛）

实际：40+ 工具

**保留多工具的理由**：
- serve.ts 已将能力暴露为 HTTP API，浏览器端可直接调用，工具数量是"已集成的成本"
- 增量编辑模式比"每次重写整个 JSON"体验好
- 每个工具职责单一，LLM 可按需调用

**潜在收敛方向**（待讨论）：
- 工具描述中加"分组标签"或"使用场景"提示 LLM 何时用哪组工具
- 或定义"高频工具"（render_dsl / get_dsl / create_feature / add_node / add_edge / scaffold / backfill_scaffold / check_status）和"按需工具"（其余）

## 5. 下一步对齐建议

### 已完成（2026-07-23 ~ 2026-07-24）

1. ~~**确认动画系统方向**~~——已确认：声明式 animations_v2 字段，分层精度 L0-L5。设计文档见 [animation-design.md](./animation-design.md)
2. ~~**确认消息粒子终点处理**~~——已确认：恢复可拖拽容器，定位在消息流面板内部避免遮挡
3. ~~**清理 tmp_backfill_***~~——已完成：75 个残留目录已清理，测试改用 `os.tmpdir()`
4. ~~**更新 README**~~——已完成：46 工具分 11 组，标注高频/按需
5. ~~**实现动画系统阶段 A-D**~~——已完成：DSL schema + L0-L1 默认行为 + L2 数据流执行器 + 内置 effect 注册（card_create/card_fold/card_evict）。详见 [animation-design.md](./animation-design.md) 第 8.4 节实现进度

### 待完成

6. ~~**阶段 E：conveyor.json 迁移**~~——已完成（2026-08-07）：conveyor.json 显式声明 card_sync flow + 删除 scripts.ts 专用动画代码（旧动画播放器全块）
7. **L3-L5 动画能力**——条件分支 / 函数绑定 / 异常语义 / 反向提取（中低优先级）

---

## 6. 全量借鉴路线图（2026-07-24 制定）

> 背景：调研 GitHub 爆款 [CodeGraph](https://github.com/colbymchenry/codegraph)（2 万 star，代码→调用图 MCP server）和 [Understand Anything](https://github.com/Lum1104/Understand-Anything)（6.9 万 star，代码→知识图谱 Claude 插件）后，不取"差异化竞争"视角，而是**全量吸收两者优点**——所有增强方向都做，按依赖关系排序，无放弃项。

### 6.1 路线图总表

| 批次 | 序号 | 项 | 来源 | 依赖 | 状态 |
|------|------|-----|------|------|------|
| **基础设施** | 1 | SQLite 存储 + 文件 hash 增量 backfill | CodeGraph | 无 | 🚧 v1 已落地（src/db/，见 7.3） |
| | 2 | MCP 工具收敛到 ~8 个（JSON Patch 模式） | CodeGraph | 无 | ⏳ |
| | 3 | 调用边级别提取（symbol + call_edge + dependency 表） | CodeGraph | 1 | ✅ 同文件（AST 级，self src/ 509 条）+ 跨文件（import 限定，155 条）调用边已落地；内置/外部/失败三态标记；已接入渲染（derive_detail_chain AST 级调用图 + 虚线跳边 + 跨文件标注）+ 数据流追踪（L5a 静态推演：注入数据沿链推演，每步进/出值浮层 + 分流高亮 + CFG 判定展示 if/loop 条件原文与走向） |
| **代码理解** | 4 | Diff Impact Analysis（变更影响范围追溯） | Understand Anything | 3 | ✅ 已落地（2026-08-06，见 7.5） |
| | 5 | architecture-analyzer 角色（推断架构层 + 职责回填） | Understand Anything | 3 | ⏳ |
| | 6 | Guided Tours（拓扑排序学习路径 + 动画播放列表） | Understand Anything | DSL edges | ⏳ |
| **可视化** | 7 | Layer Visualization（按 type 分层着色 + legend） | Understand Anything | 5 | ⏳ |
| | 8 | Fuzzy & Semantic Search（语义搜索"哪部分处理认证"） | Understand Anything | 无 | ✅ |
| | 9 | Persona-Adaptive UI（角色自适应详细度） | Understand Anything | 无 | ⏳ |
| | 10 | Language Concepts（12 种编程模式上下文解释） | Understand Anything | 3 | ⏳ |
| **自动同步** | 11 | 文件监听自动同步（FSEvents/inotify） | CodeGraph | 1, 3 | ✅ 已落地（2026-08-06，见 7.6） |
| | 12 | 多平台插件分发（Claude Code/Cursor/VS Code/Codex） | 两者 | MCP 已就绪 | ⏳ |
| **独有能力** | 13 | 动画系统阶段 E（conveyor 迁移） | 自有 | 无 | ✅（2026-08-07） |
| | 14 | L3-L5 动画（条件分支 / 函数绑定 / 异常 / 反向提取） | 自有 | 13 | ✅ P1 全（L4 绑定 + L3 分支 + L4.5 异常，2026-08-07 见 6.6） |
| | 15 | L5 反向提取增强（基于 SQLite + 调用边） | 自有 | 1, 3, 14 | ✅ 跨文件 L4 chain flow（2026-08-07 见 6.6） |

### 6.2 第一批：基础设施

**1. SQLite 存储 + 文件 hash 增量 backfill**
- 现状痛点：`tmp_backfill_*` 污染（80+ 临时目录，evolution.md 3.3 记录）、backfill 每次全量重跑
- 借鉴点：CodeGraph 把图存 SQLite（symbol 表 + call_edge 表 + dependency 表），每个文件记 content hash，只重解析变更文件
- 落地：`.design-canvas/cache.db` 常驻缓存，backfill 按 hash 增量；解决 tmp 污染——不再用临时目录
- 成本：中（最终选 node:sqlite 零依赖，见 7.3；backfill 核心解析逻辑不动）
- **进度（2026-07-29）**：v1 已落地 `src/db/`（schema + openDb + syncFile/syncProject/searchSymbols + 15 测试全绿）
- **进度（2026-07-30）**：self_analyze + MCP server 均已接入缓存层（schema v2 + import_project cache_db，见 7.4），二次运行 55 文件全命中；删除侦测落地（sync 顺带 prune）。待做：并发池；实时文件监听归序号 11

**2. MCP 工具收敛到 ~8 个（JSON Patch 模式）**
- 现状痛点：40+ MCP 工具（evolution.md 4.3 记录），方案 B 已规划未落地
- 借鉴点：CodeGraph 只暴露 1 个主工具 `codegraph_explore`，参数化查询
- 落地：MCP 侧收敛到 `render_dsl` / `get_dsl` / `edit_dsl`（JSON Patch RFC 6902 合并所有增量编辑） / `scaffold` / `backfill_scaffold` / `consistency_check` / `explore_code`（新增） / `manage_feature`；其余 30+ 工具降级到 serve.ts HTTP API
- 成本：低（工具描述重写 + JSON Patch 分发器）

**3. 调用边级别提取**
- 现状痛点：backfill 只到 API 签名级别，不支持调用关系
- 借鉴点：CodeGraph 做到含动态分派的调用边
- 落地：TreeSitterKernel 扩展——symbol 表 + call_edge 表 + dependency 表；先做同文件内调用，再扩跨文件；为 L4 函数绑定动画和 Diff Impact 提供基础
- 成本：高（每种语言的调用解析逻辑不同），但后续多项依赖它

### 6.3 第二批：代码理解能力

**4. Diff Impact Analysis**
- 借鉴点：Understand Anything 的 `/understand-diff` 只分析变更影响的节点
- 落地：`consistency_check --changed <files>`，基于调用边反向追溯变更文件 → 关联节点 → 下游节点 → 标红影响范围；和动画系统联动，受影响节点粒子流变红
- 依赖：序号 3（调用边）

**5. architecture-analyzer 角色**
- 借鉴点：Understand Anything 的多智能体 pipeline 中推断架构层的角色
- 落地：backfill 时推断文件所属架构层（API/Service/Data/UI/Utility）+ 职责，回填 `semantic.files[].responsibility` 和 `layer` 字段；不做完整 6 agent pipeline，只吸收这一环
- 依赖：序号 3

**6. Guided Tours**
- 借鉴点：Understand Anything 按依赖顺序生成学习路径
- 落地：DSL edges 拓扑排序生成"先看 A → 再看 B → 最后看 C"路径；动画按路径顺序逐个高亮节点；呼应动画系统"演示文稿"定位——Guided Tour 就是播放列表
- 依赖：DSL edges（已有）

### 6.4 第三批：可视化增强

**7. Layer Visualization**
- 借鉴点：Understand Anything 自动按架构层分组着色
- 落地：节点按 type/layer 自动分层，同层同色，legend 可切换显示/隐藏
- 依赖：序号 5（layer 字段回填）

**8. Fuzzy & Semantic Search**
- 借鉴点：Understand Anything 支持语义搜索（"哪部分处理认证"）
- 落地：节点搜索从当前的 label/id 模糊匹配升级为语义搜索
- 依赖：无（独立）
- 状态：✅ 已落地（2026-08-06）
  - S1 核心引擎 [semantic_search.ts](../src/tools/semantic_search.ts)：复用 cache.db 符号表，硅基流动 BAAI/bge-m3（1024 维，OpenAI 兼容 /embeddings）向量化符号（name/qualified_name/signature/file_path），query 向量化后余弦相似度 top-k；进程内向量缓存（model:sha256(text)→vec）实现"向量化一次即可复用"；未配置/调用失败自动降级 FTS trigram。
  - 配置：`<dataHome>/.design-canvas/config.json` 的 `embedding` 段（apiKey/model/baseURL/dim），环境变量 `EMBEDDING_*` 覆盖；key 复用 ai-base 记忆模块的硅基流动 key。
  - S2 渲染层：serve 新增 `POST /api/semantic-search`；画布搜索框接入——输入即触发（debounce 350ms），结果面板 + 命中节点语义高亮，点击结果 flyToNode 定位。
  - S3 MCP 工具：server.ts 注册 `semantic_search` 工具（project_dir/query/limit/min_score），返回按相似度排序的符号清单；配套单元测试 [semantic_search.test.ts](../tests/tools/semantic_search.test.ts)（纯逻辑 + FTS 降级，8 用例）+ MCP 冒烟 [sem_search_mcp_smoke.mjs](../scripts/sem_search_mcp_smoke.mjs)。
  - 冒烟验证：617 符号全量向量化，多查询准确命中对应模块，重复查询零新增 API 调用。

**9. Persona-Adaptive UI**
- 借鉴点：Understand Anything 面板按角色调整详细度
- 落地：面板按角色（新人/PM/资深开发）切换详细度
- 依赖：无（独立）

**10. Language Concepts**
- 借鉴点：Understand Anything 的 12 种编程模式上下文解释
- 落地：检测代码中的泛型/闭包/装饰器等模式，在节点上下文展示解释
- 依赖：序号 3（调用边/symbol）

### 6.5 第四批：自动同步

**11. 文件监听自动同步**
- 借鉴点：CodeGraph 的 FSEvents/inotify 监听 + 增量更新
- 落地：监听项目文件变更，自动触发 backfill 增量 + DSL 更新；配合 SQLite 缓存实现"永不 stale"
- 依赖：序号 1 + 3

**12. 多平台插件分发**
- 借鉴点：两个项目都做 Claude Code / Cursor / VS Code / Codex 等插件入口
- 落地：MCP server 已是标准协议，包装成各平台插件配置；提供一键安装脚本
- 依赖：MCP 已就绪

### 6.6 第五批：独有能力推进（不因借鉴而停）

**13. ~~动画系统阶段 E~~**——已完成（2026-08-07）：conveyor.json 显式声明 card_* flow + 删除 scripts.ts 专用动画代码

**14. L3-L5 动画**——条件分支 / 函数绑定 / 异常语义 / 反向提取

已完成 **P1 全（L4 函数绑定 + L3 条件分支 + L4.5 异常语义）**（2026-08-07）：新增 `src/tools/derive_anim_flow.ts`，补齐"生成层"——动画引擎（animation_engine.ts / anim_core.ts）运行时已支持 L3 分支、L4 绑定、L4.5 异常，但 flows 声明此前只能手写（如 examples/conveyor.json）。本工具把 `derive_detail_chain` 已提取的调用链 + CFG 自动转成 `animations_v2.flows`：
- **chain flow（L4 函数绑定）**：按调用链相邻函数对生成，`handler` 绑定调用方函数（file_id=宿主节点, api=调用方），periodic 触发
- **branch flow（L3 条件分支）**：对含 CFG 判定的函数生成，`branches` 取自 CFG 条件（去重/截断/去 entry-exit），末位 else 兜底到宿主节点；`mock_values` 从 detail 节点 `shapes.in` 属性集合生成数值/布尔极端对（false/true 覆盖两分支）
- **errors（L4.5 异常语义）**：从函数体源码扫描错误返回/抛出，注入 branch flow 的 `handler.errors`——Go `return ..., ErrXxx`（expected，particle_red 红路径）+ `panic(...)`（unexpected，node_flash_red + log）；JS/TS `throw new Xxx(...)`、Python `raise Xxx(...)`（均 unexpected）。让引擎 L4.5 异常短路（expected 红路径不报警 / unexpected 标"疑似 bug"）可被自动驱动
- **幂等**：只重建自身前缀 `${node_id}__flow_` 的 flows，保留手写 flows；依赖先跑 `derive_detail_chain` 生成 detail 节点（flow 的 from/to 引用这些节点 id）
- **MCP**：`server.ts` 注册 `derive_anim_flow` 工具（参数 feature/node_id/source_path/project_root/entry/max_steps/interval/max_cfg_branches）
- 测试：`tests/tools/derive_anim_flow.test.ts` 10 用例（依赖检查、L4/L3 生成、mock_values、L4.5 异常 expected/unexpected、幂等、错误边界），全量 493 用例通过

**15. L5 反向提取增强**——基于 SQLite + 调用边，让反向提取更扎实；从代码提取的调用链直接驱动 L4 函数绑定动画

已完成（2026-08-07）：`derive_anim_flow` 新增**跨文件 L4 chain flow**——读取 cache.db 的跨文件调用边（`kind='call'` + `metadata.cross=true`），为链上函数的跨文件调用生成 cross flow（from=调用方 detail 节点，to=宿主节点，handler 绑定调用方，value 标注目标文件#函数），让 L4 函数绑定动画跨越文件边界。新增 `max_cross` 参数（默认 3，0=关闭）；无 cache.db 时静默跳过不影响主流程。server.ts 注册 `max_cross` 参数。测试 `tests/tools/derive_anim_flow.test.ts` 13 用例（新增跨文件生成/无缓存跳过/关闭开关），全量 496 用例通过。至此序号 14/15 的 L3-L5 动画生成层全部落地。

**16. 巨石文件分析（跨文件功能社区圈定）**——基于 cache.db 调用边 + 从既存结构推导功能锚点

已完成 **P1（锚点推导 + 标签传播圈社区）**（2026-08-07）：新增 `src/tools/analyze_monolith.ts`（MCP 工具 `analyze_monolith`），补上 `check_monolith` 缺失的两块——跨文件视角 + 功能锚点机制。核心口径（用户愿景）：**社区锚点是功能/业务，不是纯代码结构**；一个功能再大再碎、甚至跨多个文件，只要被同一锚点沿调用边串起就整块聚在一起，不做"拆碎"下限。三步：
- **锚点推导（从既存结构，全自动）**：语义命名（`xxxService/Handler/Repo/…`）/ 导出入口（Go 大写、Python 非下划线顶层）/ 入度最高档（≥3，真实"功能门面"）三信号。入度归一化不再让所有被调函数成弱锚点（避免切碎）
- **标签传播圈社区**：锚点带权重沿调用边双向传染，普通函数被吸收到最强锚点社区
- **产出**：功能社区清单（锚点+符号+横跨文件+估算行数）、社区间依赖边（决定拆完 import 怎么补）、文件视图 + "多社区共占的超标文件"拆分候选。只给证据与启发，不落盘改代码

与 `check_monolith` 分工：后者是单文件内文本引用近似（Louvain），无跨文件视角、无功能锚点；前者读 cache.db 调用边做跨文件圈定。测试 `tests/tools/analyze_monolith.test.ts` 5 用例（锚点信号判定/锚点传染不切碎/跨文件聚一起+拆分候选/社区间依赖/空缓存降级），全量 501 用例通过，`tsc --noEmit` 无错误。

已完成 **P2（`derive_split` 执行拆分，MVP）**（2026-08-07）：新增 `src/tools/derive_split.ts`（MCP 工具 `derive_split`），把 analyze_monolith 圈出的社区从"多社区共占文件"抽出到新兄弟文件，接线 import，并从原文件移除。承接上一句的"自动验收闭环"落地为**语法级验收**（tree-sitter 重解析两份草稿）：
- **抽取**：按符号名/qualified_name 命中顶层函数/类；行区间合并相邻段；默认新文件 `<dir>/<basename>__split.<ext>`（可用 `new_file` 覆盖）
- **import 接线**：新文件复制原文件非自引用 import + 从原文件补被引用符号；原文件补 `import { 被抽符号 } from './<新文件>'`
- **交叉引用报告**：原文件中指向被抽符号的引用点（拆后走新文件 import）
- **验收**：`verification` 报告双文件语法 OK/FAILED + 符号对账
- **人确认**：默认 `dry_run=true` 只出草稿；设 `dry_run=false` 才写文件
- **语言范围**：TS/JS（.ts/.tsx/.js/.jsx/.mjs/.cjs，ESM 相对 import）+ Go（.go，同包拆分复制 package+import 块，无需跨文件 import）+ Python（.py，目录含 `__init__.py` 判定为包则用相对 import，否则绝对式 import）
- 测试：`tests/tools/derive_split.test.ts` 12 用例（dry_run 不落盘/抽取+移除/多符号合并/引用报告/实际写入/文件不存在/语言不支持/符号未命中 + Go 同包拆分/Go type 去重/Python 绝对 import/Python 相对 import），全量 519 用例通过，`tsc --noEmit` 无错误。自举验证 `scripts/verify_derive_split.mjs` 对项目自身 `src/tools/derive_split.ts` 抽取 3 个工具函数 dry-run 通过。

已完成 **P3（社区内子拆分编排）**（2026-08-07）：把 `analyze_monolith` 的 `community_subsplit` 评估结果接到 `derive_split`，让代码自动执行二次拆分：
- **消费评估结果**：`deriveSplit` 输入新增 `subsplit`（`CommunitySubSplitPlan[]`，与 `analyze_monolith` 的 `CommunitySubSplit` 形状兼容的本地定义以解耦），提供后进入编排模式 `runSubSplit`；仅处理 `splittable: true` 的社区，逐个类型单元（owner）自动二次拆分
- **按 owner 自动拆文件**：对每个 owner 的方法按所在文件分组，把该类型全部方法从原文件抽到以 owner 命名的兄弟文件（`<basename>_<owner>.<ext>`）；同一文件内多个 owner 逐个抽取（后一个基于前一个拆分后的内容）
- **支持方法符号抽取**：原抽取逻辑仅匹配顶层符号（`!s.parent`），无法抽取 Go receiver 方法/类方法；改为从全量符号（含 parent）按 `name`/`qualified_name` 命中，按 name 去重保留外层
- **结果汇总**：`result.subsplit` 逐条记录每次拆分的 community/owner/原文件/新文件/方法数/成功与否/失败原因（编译回滚或语法失败），message 输出逐行可读报告
- **server.ts 注册**：`derive_split` 输入新增 `subsplit`（JSON 字符串，解析后传入）与 `verify_compile`；`subsplit` 非法 JSON 先报错降级
- 测试 2 用例：Go 双 owner（TypeA/TypeB）自动拆成 `tool_TypeA.go`/`tool_TypeB.go` 且 dry_run 不落盘；非 splittable 社区被跳过。全量 519 用例通过，`tsc` 无错误。

已完成 **P3 收尾（测试级验收闭环）**（2026-08-07）：在编译级验收通过后，跑该语言的项目测试命令，验证拆分后功能正确性，失败同样自动回滚：
- **测试命令**：Go → `go test <拆分所在包>`（同包可直接引用抽走符号）；Python → `python -m pytest -q`（pytest 未安装时置 skipped 而非失败）；TS → 包用 vitest 则 `npx vitest run <文件>`，否则 `npm test`
- **跳过策略**（与编译级一致，避免误报失败）：缺 go.mod / package.json 无 test 脚本 / 项目无测试文件（Go `*_test.go`、Python `test_*.py`/`*_test.py`）时返回 `verification.test.skipped`
- **失败回滚**：测试失败把原文件恢复拆分前内容、清空新文件，`rolled_back=true`，项目保持未被拆状态
- **控制项**：`derive_split` 输入与 server.ts 新增 `verify_test`（默认 = `verify_compile`，即可独立关闭）；编排 `runSubSplit` 同样透传
- **结果暴露**：`verification.test`（command/ok/output/skipped）+ message 追加测试级验收行；dry_run 不运行
- 测试 3 用例：dry_run 不运行测试验收 / 项目无测试文件时 skipped 不失败 / 真实 Go 项目（go.mod + tool_test.go）编译+测试双通过且新文件落盘不回滚。全量 523 用例通过，`tsc` 无错误。

已完成 **P3 端到端真实验证（ai-base 项目）**（2026-08-07）：在真实项目 ai-base/agent-shell（321 文件、4422 符号、2580 依赖边）的**临时副本**上跑通一次完整自动拆分，验证评估结果与代码拆分均正确：
- **流程**：副本建立索引 → `analyze_monolith` 圈出 5 个建议再拆社区 → `derive_split` 编排（dry_run=false）自动按类型单元二次拆分 → 模块级 `go build ./...` → `go test ./...`
- **结果**：14 次拆分全部成功（Hub 47 方法 / Engine 21 方法 / PageSession 7+14 方法 / DeepRetriever 15 方法等），每次拆分均经 `go build` 编译级验收；`go build ./...` 全模块通过
- **测试级验收**：`go test ./...` 仅 1 个失败——`internal/agent/v2` 的 `TestAgentRunCancellation`（取消时序敏感，与本次拆分无关，该包未被触碰；在真实项目重跑 3/3 通过，确认为既存 flaky）
- **修复 Go 导入裁剪缺陷**：`pruneGoImports` 原先只收集 `selector_expression` 的根操作数，把 Go **类型引用**（`context.Context`/`sync.Mutex` 解析为 `qualified_type` 节点）误判为未用，导致拆分后原/新文件被裁掉整个 import 块而编译失败（`undefined: context`）。修复：遍历同时识别 `selector_expression` 与 `qualified_type`，`resolveBase` 分别下钻到根操作数/包名。以最小复现（diag_import）验证：新文件保留 `sync`、原文件保留 `context`，`go build` 通过、`rolled_back=false`
- 全量 523 用例通过，`tsc` 无错误
- **真实项目落盘（2026-08-07）**：按规划报告 `docs/split-plan-ai-base.md`（5 社区 / 14 单元），在真实 ai-base/agent-shell 上执行 `derive_split` dry_run=false 全部落盘——14/14 成功，`go build ./...` 通过；拆分触及的包（hub/v2、orchestrator、memory）`go test` 全 `ok`（browser 无测试文件）。唯一失败包 `internal/hub/v2/themes` 与本次拆分无关（其 `theme.go` 有先前未提交的二次改动 52+/4-，拆分未触碰该包）。规划/执行脚本：`plan_subsplit_ai_base.mjs` / `apply_subsplit_ai_base.mjs`

已完成 **P2.6（编译级验收闭环）**（2026-08-07）：`derive_split` 在 `dry_run=false` 落盘后跑**真实编译器**验证拆分结果，失败自动回滚，保证项目不被拆坏：
- **真实编译**：Go → `go build -o <临时目录> <包>`（输出重定向系统临时目录避免污染项目）；TS → `npx tsc --noEmit`；Python → `python -m py_compile`。缺构建清单（go.mod/tsconfig.json）时置 `verification.skipped` 跳过而非报错
- **失败回滚**：编译失败自动把原文件恢复拆分前内容、清空新文件，`rolled_back=true`，项目保持未被拆状态
- **未用 import 裁剪**（编译器阻塞项）：Go 未用 import 会使 `go build` 失败，Python 未用 import 属质量项。裁剪在接线 import 注入**之前**执行，避免把"向后兼容的再导出 import"（`from <新文件> import <抽走符号>`）误删——修复了原文件再导出行被 `prunePythonImports` 误删导致相对 import 测试失败的问题
- **接线 import 受保护**：先裁剪底层 import，再注入接线 import（再导出），保证既清掉未用 import 又保留跨文件接线
- **结果暴露**：`verification.compile`（command/ok/output/skipped）+ 顶层 `rolled_back` + message 追加编译验收行；`dry_run=true` 时置 `verification.note` 提示落盘后自动验收
- 真实验证：临时 Go 项目（module probe + go.mod）`dry_run=false` 抽取 `extractMe`，裁剪生效（新文件去 `strings`、原文件去 `fmt`），`go build` 通过且 `rolled_back=false`；以带 BOM 的 go.mod 复现编译失败路径，确认 `rolled_back=true` 自动回滚。全量 519 用例通过，`tsc` 无错误。

已完成 **P2.5（拆分候选多社区均衡度门槛）**（2026-08-07）：拆分候选此前仅判"超标 && ≥2 社区"，会把"1 个主导社区 + 零星尾随社区"的文件（如独立一次性脚本）误报为可拆。新增 `min_community_share` 参数（默认 0.2=20%）：仅当文件内 ≥2 个社区各自符号占比 ≥ 门槛才列入拆分候选，过滤误报，避免拆出碎片。server.ts 注册参数；测试 2 用例（默认门槛过滤误报 / 调低门槛后纳入）。另修正 seedDb 测试基建——`qualified_name` 误用含文件前缀的 id 导致 `ownerOf` 提取出错 owner、类型锚定钉死单社区，改为纯符号名。全量 511 用例通过。

### 6.7 和现有规划的关系

- 原"待完成 6（阶段 E）"→ 归入序号 13，已完成
- 原"待完成 7（MCP 工具分层暴露）"→ 归入序号 2，从"~12 个"收敛到"~8 个"
- 原"待完成 8（L3-L5）"→ 归入序号 14
- 原 evolution.md 3.3 的 `tmp_backfill_*` 项 → 由序号 1 解决
- 原 evolution.md 3.3 的 `scripts.ts 体积` 项 → 由序号 13 解决

---

## 7. 参考库已就位（2026-07-24）

路线图第 6 章的借鉴源已 fork 到本地，供开发窗口直接参考实现细节：

| 参考项目 | 本地路径 | 覆盖路线图项 |
|---------|---------|-------------|
| [CodeGraph](https://github.com/colbymchenry/codegraph) | `vendor/codegraph/` | 1（SQLite+hash）、2（MCP 收敛）、3（调用边）、11（文件监听） |
| [Understand Anything](https://github.com/Lum1104/Understand-Anything) | `vendor/Understand-Anything/`（sparse-checkout 核心代码） | 4（Diff Impact）、5（architecture-analyzer）、6（Guided Tours）、7（Layer）、8（语义搜索）、9（Persona）、10（Language Concepts） |

`vendor/` 已加入 `.gitignore`，不进入本项目 git 跟踪。

### 7.1 参考路径速查（按路线图项）

- **序号 1（SQLite 增量）** → `vendor/codegraph/src/db/`（schema.sql + sqlite-adapter.ts + wal-valve.ts）
- **序号 2（MCP 收敛）** → `vendor/codegraph/src/mcp/`（codegraph_explore 单工具参数化查询模式）
- **序号 3（调用边提取）** → `vendor/codegraph/codegraph-kernel/src/`（各语言 `*.rs` 解析器）+ `vendor/codegraph/src/extraction/languages/`（多语言适配层）
- **序号 4（Diff Impact）** → `vendor/Understand-Anything/packages/core/src/analyzer/`（变更影响范围追溯）
- **序号 5（architecture-analyzer）** → `vendor/Understand-Anything/understand-anything-plugin/agents/architecture-analyzer.md`
- **序号 6（Guided Tours）** → `vendor/Understand-Anything/understand-anything-plugin/agents/tour-builder.md` + `packages/core/src/analyzer/tour-generator.ts`
- **序号 7（Layer Visualization）** → `packages/core/src/analyzer/layer-detector.ts` + `packages/dashboard/src/components/LayerLegend.tsx`
- **序号 8（语义搜索）** → `packages/core/src/analyzer/`（embedding + 检索管线）
- **序号 9（Persona UI）** → `packages/dashboard/src/components/PersonaSelector.tsx`
- **序号 10（Language Concepts）** → `packages/core/src/analyzer/`（编程模式检测）
- **序号 11（文件监听）** → `vendor/codegraph/src/watcher/`（FSEvents/inotify 增量同步）

### 7.2 与 ai-base/agent-shell 的技术栈协同

design-canvas 路线图第 1 项（SQLite 缓存 + 文件 hash 增量）与 ai-base/agent-shell 的记忆系统重设计（`docs/proposal-memory-redesign.md`）技术栈同构，经验可直接复用：

| 维度 | agent-shell memory.db | design-canvas cache.db（规划） |
|------|----------------------|------------------------------|
| 嵌入方案 | modernc.org/sqlite 纯 Go，无 CGO | 同（backfill 在 Node 侧可用 better-sqlite3，但 schema/增量逻辑同构） |
| 增量机制 | content hash + dirty 集合 + 惰性同步 | 文件 hash + 只重解析变更文件（同思路） |
| 并发 | WAL + busy_timeout + 三脑共享 | 单进程，更简单 |
| 迁移 | 一次性 CLI + 幂等 | backfill 增量模式天然幂等 |

开发窗口实施序号 1 时可参考 agent-shell 的 `internal/memory/sqlite_store.go`（schema 设计 + WAL 配置 + dirty 惰性同步落地细节），避免重复踩坑。

### 7.3 调研落地结论（2026-07-29）

对两个参考库做了一轮"可直接拆 / 值得学"深挖（重点：产品化 + 展示层），结论与已落地的决策如下。

**序号 1 已实现的关键决策**（`src/db/`，15 测试全绿）：

1. **选型 node:sqlite（Node 22 内置）而非 better-sqlite3**：零原生依赖，npm 分发不踩 Windows 编译坑；实测 SQLite 3.50.2，FTS5 + trigram + 触发器 + WAL 全可用。代价是启动 stderr 一条 ExperimentalWarning（不影响 stdio JSON-RPC）。注意 vitest 1.x 的 Vite 不认识该内建模块，db.ts 用 createRequire 运行时加载绕过静态分析
2. **schema 以 CodeGraph 四表为底**：nodes / edges / files / unresolved_refs + schema_versions + project_metadata；边身份唯一索引用 `IFNULL(line,-1)` 折叠 NULL（继承 CodeGraph #1034 修复：否则 INSERT OR IGNORE 对 NULL 失效产生重复边）
3. **FTS5 + 触发器第一版就做（用户拍板）**：索引本身可随时 `rebuild` 后补，但被索引列（docstring/signature）后补 = 全量重跑提取——**可后悔的是索引，不可后悔的是数据列**，第一版把列占全。`name_segment_vocab` 是派生物化表可随时重建，推迟到序号 8
4. **分词器 unicode61 → trigram**：unicode61 把整段中文当一个 token（中文搜索全废）且不拆 camelCase；trigram 中文子串 + 标识符子串（'Config' 命中 'parseConfig'）通吃，千级文件规模索引体积可接受
5. **文件节点 UPSERT 不删除**：import 边 FK 指向文件节点，若重同步时删除文件节点，ON DELETE CASCADE 会把别的文件指向它的边带走。方案：INSERT OR IGNORE 建桩节点 + 正式同步 ON CONFLICT 回填，与文件同步顺序无关（测试已覆盖）

**可直接拆（后续项按此执行）**：

| 项 | 借鉴源 | 用在 |
|----|--------|------|
| HTTP 安全模型：绑 127.0.0.1 + 一次性 ?token= + 文件白名单/1MB 上限 + 端口占用自动 +1 重试 | UA `packages/viewer/bin/viewer.mjs` | serve.ts 加固（Hub 给人看之前必做） |
| 可展开变更文件清单的保鲜横幅（前 8 个 + "+N more"） | UA `dashboard/src/components/StalenessBanner.tsx` | 增强现有 stale-bar（低成本） |
| 8 工具职责划分 search/callers/callees/impact/node/explore/status/files + 输出预算 15000 字符 + 错误分级（可恢复错误不标 isError，防 agent 弃用工具集） | CodeGraph `src/mcp/tools.ts` | 序号 2 MCP 收敛 |
| 双轴主题（base preset × accent swatch）+ 13 种 node-* 语义色板 | UA `dashboard/src/themes/presets.ts` | 序号 7 Layer 着色直接取色板 |
| 三步曲产品化：install.sh/ps1 装 CLI → `install` 自动写 8 种 agent 的 MCP 配置 → 每项目 `init` | CodeGraph README/install.sh | 序号 12 分发 |

### 7.4 缓存层接入 self_analyze（2026-07-30）

序号 1 的第二步：让消费方真正用上 cache.db，替代全量重跑。22 测试全绿（含新增 7 个），self_analyze 二次运行 55 文件全命中。

1. **schema v2 +imports 表（原始 import 记录）**：edges 表只存【已解析的相对导入】边，而 import_project 重建依赖边需要原始 source 串（Go 包路径 / Python 点分模块）——丢了它缓存路径会静默丢包导入依赖边。v1→v2 迁移策略：**缓存是派生物，不做保留式迁移，版本落后即清空业务表全量重建**（旧 files 行没有 imports 数据，保留反而埋雷）
2. **import_project 双路径**：新增可选参数 `cache_db`。提供时 syncProject 按 content_hash 增量（未变更文件不重解析），再从 cache.db 读回符号 + imports 走原有边推导；不提供时行为与之前完全一致。50 符号截断、解析失败可见性两条路径共用同一 ingest。结果新增 `cache: { hits, reparsed, failed }` 统计并写进 message
3. **self_analyze.mjs 接入**：缓存放**项目根 `.design-canvas/cache.db`** 而非 `.tmp_self_analyze`（那个目录跑完即删，放进去增量价值归零）。缓存是 src/ 的派生物，跨运行复用才有意义；隔离要求针对的是 DSL feature 数据，不是符号缓存
4. **import_project.ts 只 import symbols.ts 不 import db.ts**（type-only 引用 Database）：symbols.ts 对 db.ts 也是 type-only 依赖，因此 MCP server 主链路运行时仍不加载 node:sqlite——Node <22.5 用户不受影响，cache_db 纯注入

**第二批（2026-07-30 下午，MCP 接入 + 删除侦测，27 测试全绿）**：

5. **MCP server 接入**：`import_project` 工具经 `getProjectCacheDb(project_dir)` 拿缓存——连接池按项目根复用（MCP 是长进程），缓存放**被分析项目的** `<project_dir>/.design-canvas/cache.db`（缓存跟着项目走，相对路径键才不撞车；与数据主目录的 cache.db 是两个独立用途）。node:sqlite 走**动态 import**：加载失败（Node <22.5）或打开失败（目标目录只读）都退化为全量解析，缓存失败绝不阻塞工具调用
6. **删除侦测（prune 模式）**：每次 sync 顺带比对 files 表与本次全量扫描列表（`pruneDeletedFiles`），清掉磁盘上已不存在文件的缓存行（nodes 级联清边与 FTS）。两个防误删约束：比对基准必须是 **max_files 截断前**的完整列表；只 prune 受支持扩展名的文件（与 sync 同域），.md 等其他工具写入的行不受影响——多工具共享项目缓存时不互踩。实时 fs 监听仍归序号 11，届时换 removeFile 实时触发

### 7.5 Diff Impact Analysis（2026-08-06，路线图序号 4）

在符号级调用图上做有向 BFS，再按 file_path 聚合回 DSL 文件级节点。只读，不修改 DSL。

1. **工具 `diff_impact(feature, project_dir, changed[], direction?, max_depth?)`**：`direction` 为 `callers`（谁调用受影响，默认）/`callees`（受影响调用了谁）/`both`；`max_depth` 默认 3。沿 `edges(kind='call')` 追溯，种子 = changed 文件里的全部符号（depth 0），结果含受影响文件（DSL `file_<rel>` id 锚定）+ 受影响符号明细 + 文本报告
2. **serve.ts 端点 `POST /api/diff-impact`**：与 MCP 工具同实现，浏览器端可直接调用
3. **数据源零新增**：复用序号 1 的 SQLite 缓存 + 序号 3 的调用边，无新数据管线
4. **验证**：402/402 测试通过（新增 6 个，覆盖 callers/callees/both/深度截断/跨文件/降级）；冒烟脚本 [diff_impact_smoke.mjs](../scripts/diff_impact_smoke.mjs)——改 `src/db/db.ts` 正确波及 `diff_impact.ts`(depth1) 与 `serve.ts`(depth2)，符合直觉
5. **降级路径**：缓存无调用边 / changed 文件不在缓存，均给出明确警告而非崩溃；缓存打开失败返回提示性空结果
6. **待做（D2）**：渲染层标红受影响节点/边 + 影响清单面板（见 [docs/plans/2026-08-06-diff-impact.md](./plans/2026-08-06-diff-impact.md)）

### 7.6 Architecture Layer Visualization（2026-08-06，路线图序号 5+7）

按文件路径目录/文件名模式启发式推断架构层，渲染器提供「🎨 图层」开关在语言色/层色间切换 + 分层图例。纯函数加工副本，不动存储 DSL。

1. **分层模块** [layer_detect.ts](../src/tools/layer_detect.ts)：`detectArchLayers(dsl)` 为每个 file 节点推断 `arch_layer` 并生成 `dsl.layers`（api/service/data/ui/middleware/utility/config/types/test/entry，未匹配兜底 core；层名回填 semantic responsibility 前缀）
2. **DSL 扩展**：Node 加 `arch_layer`；DesignDSL 加 `layers?: ArchLayer[]`
3. **渲染层**：节点 `data-arch-layer` 属性 + `🎨 图层` 按钮 + 动态层色 CSS + 右上角图例；`setupLayerViz` 绑定切换
4. **接入**：self_analyze 渲染前调 `detectArchLayers`，指标加「架构层」数
5. **验证**：63 文件节点全部着色，data 层 computed fill #5a9e6f 与层定义一致，切换往返正常，无报错。详见 [2026-08-06-arch-layer-viz.md](./plans/2026-08-06-arch-layer-viz.md)
6. **工具化（L7）**：MCP 工具 `arch_layer(feature, persist?)`（[arch_layer.ts](../src/tools/arch_layer.ts)）+ `POST /api/arch-layer`；`persist=true` 把 layering 写回 feature 供渲染显示图层着色；单测 [arch_layer.test.ts](../tests/tools/arch_layer.test.ts) 4 通过 + 冒烟 [arch_layer_smoke.mjs](../scripts/arch_layer_smoke.mjs) + HTTP 端到端验证通过

### 7.7 文件监听自动同步（2026-08-06，路线图序号 11）

项目文件变更/新增/删除 → 实时增量同步到 cache.db，可选重建"实际 DSL"（live/ 快照），实现"永不 stale"。分三阶段落地：

1. **S1 监听核心** [watch_project.ts](../src/tools/watch_project.ts)：fs.watch 递归监听（旧平台降级手动注册子目录），事件去重 + debounce 批量 `flushBatch`；`shouldSyncRel` 过滤（忽略 `.design-canvas/`/node_modules/.git 等防反馈循环 + 非源码扩展名 + 测试生成物）；增改走 `syncFile`（content_hash 增量，未变 skipped），删走 `removeFile`，批量收尾 `resolveCrossFileCalls`。单测 [watch_project.test.ts](../tests/tools/watch_project.test.ts) 8 用例 + 真实 fs.watch 冒烟 [watch_project_smoke.mjs](../scripts/watch_project_smoke.mjs)
2. **S2 双文件 DSL + 视图切换**：实际 DSL 存 `<live_dir>/.design-canvas/live/<feature>.dsl.json`（[storage.ts](../src/storage.ts) `saveLiveFeature`/`getLiveFeature`，带 `_sync.source=live`，不覆盖设计 DSL）；导入支持 `live_only`/`live_dir`（[import_project.ts](../src/tools/import_project.ts)）；serve 增 `GET /api/live`、`POST /api/live/rebuild`（[serve.ts](../src/tools/serve.ts)）；前端工具栏「🎭 设计 / ⚡ 实际」切换（localStorage `dc-view` + reload），实际视图下状态筛选按钮灰显（`body[data-view="actual"] .filter-chip[data-filter-status]`）。端到端验证 [verify_view_switch.mjs](../scripts/verify_view_switch.mjs) 10 项通过
3. **S3 MCP 工具**：server.ts 注册 `watch_project`（[watch_project_tool.ts](../src/tools/watch_project_tool.ts)），按 project_dir 维护注册表，`action=start`（幂等）/`status`/`stop`，可选按 feature 在变更后重建实际 DSL 到该项目 live/；单测 [watch_project_tool.test.ts](../tests/tools/watch_project_tool.test.ts) 5 用例 + MCP 冒烟 [watch_project_mcp_smoke.mjs](../scripts/watch_project_mcp_smoke.mjs)（真实变更→重建含新符号 beta）
4. **边界加固**（真实项目落地）：① 临时文件过滤——`SKIP_FILE_RE` 吸收 `.tmp/.temp/.crswap/.crdownload/.swp/.swo/.swx/.bak/.orig/.rej/`~/ 等编辑器临时存取（[watch_project.ts](../src/tools/watch_project.ts) 与 [import_project.ts](../src/tools/import_project.ts) 同步）；② rebuild 节流——`createRebuildThrottler`（尾随 debounce + 防并发）在冷却窗口内合并连续变更，运行中再触发排队补跑，`stop` 时 `flush` 冲刷未落库变更（[watch_project_tool.ts](../src/tools/watch_project_tool.ts)），`rebuild_window_ms` 可配，默认 2000ms；③ 定期 reconcile 兜底——`reconcileProject` 全量扫描磁盘 vs cache.db stat（size/mtime），补齐 fs.watch 漏事件（目录级整树删除 / 事件合并丢失），`scanSyncFiles` 循环遍历防深目录栈溢出，`reconcile_interval_ms` 可配（默认 0=关闭），接入 `watchProject` 定时器 + `onReconcile` 回调，`status` 暴露 `last_reconcile` 摘要

### 7.8 Guided Tours（2026-08-06，路线图序号 6）

按依赖边拓扑排序生成"先看依赖 → 再看依赖者"的学习路径，逐个高亮节点 / 串联产物。呼应动画系统"演示文稿"定位——Guided Tour 就是播放列表。只读，不修改 DSL。

1. **单 feature 拓扑导览** [guided_tour.ts](../src/tools/guided_tour.ts)：Kahn 拓扑排序（跳过 contains 边），`include_deep`（默认跳过 layer=detail/error）/`include_containers`（默认跳过 type=module）/`max_steps`（默认 40）可配；环/孤立残留补末尾不卡死。MCP 工具 `guided_tour` + `POST /api/guided-tour`；画布内播放器 [scripts.ts](../src/renderer/scripts.ts) `setupGuidedTour`（▶ 导览 → 逐个高亮叠加 `tour-step` 脉冲 + 上一步/下一步/自动播放）。单测 [guided_tour.test.ts](../tests/tools/guided_tour.test.ts) 7 用例
2. **G0 产物注册表** [registry.ts](../src/tools/registry.ts)：`<dataHome>/output/.registry.json` 统一登记生成产物（render_dsl 自动注册 + 人工打标记/编辑），供 Hub 首页动态渲染 + 为跨产物导览铺路。`GET/POST /api/registry`
3. **G1 跨 feature 串联**：`/api/tour` 支持 `features=A,B,C`（按给定顺序拼接各 feature 产物，可选 `tags` 过滤），保留 `feature=X` 单参兼容；跨产物播放器 `/tour.html?features=A,B,C`（进度点 + iframe 嵌入 + 上一步/下一步 + 当前 feature 标签）；Hub 首页新增「⛓ 串联导览」按钮一键串联全部 feature 产物。冒烟 [guided_tour_smoke.mjs](../scripts/guided_tour_smoke.mjs)
4. **G2 科普式讲解导览**：`/api/explain` 返回核心主链路讲解脚本（14 步：入口 MCP → 双层 DSL → 几何层 → 语义层 → 校验器 → 渲染器 → 画布脚本 → 自我分析 → AST 内核 → SQLite 缓存 → 实时同步 → 语义搜索 → 产物注册表 → 导览），每步含 title/narration/nodeId；播放器 `/explain.html` 左侧嵌星图 + 右侧字幕条，切步时通过 `postMessage({ source:'dc-tour', action:'fly', nodeId })` 让星图 flyToNode 定位高亮对应模块（[scripts.ts](../src/renderer/scripts.ts) 新增 message 接收器）；Hub 首页 hero 区新增「🎬 科普式讲解导览」入口按钮。
5. **Persona-Adaptive UI（角色自适应）**：`EXPLAIN_SCRIPT` 每步文案拆成三档（`newbie` 口语化 / `pm` 业务价值 / `senior` 技术实现），`/api/explain?role=` 支持筛选并返回全部角色；播放器字幕条下方新增「👤 新人 / 📊 PM / 🔧 资深」切换器，切换时本地零请求更新当前步文案并重新 postMessage 定位星图（对应路线图序号9）。
6. **角色文案 LLM 生成（DeepSeek）**：新增 [explain_gen.ts](../src/tools/explain_gen.ts)，复用 ai-base 的 LLM 文本接入（OpenAI 兼容 `/chat/completions`），默认后端 DeepSeek（`https://api.deepseek.com/v1`、模型 `deepseek-v4-flash`，`DEEPSEEK_API_KEY` 环境变量 / config.json `explain` 段），未配置 DeepSeek 时兼容 Agnes；`POST /api/explain/generate` 逐模块生成三档文案并返回可整体替换的 steps；播放器新增「✨ LLM 生成文案」按钮，成功后按 title 替换本地 narrations 并重渲染。未配置 / 网络失败时逐模块记录失败并优雅回退手写文案，不阻塞讲解。已用 deepseek-v4-flash 全量生成 14 模块三档文案验证通过（详细度梯度 newbie < pm < senior）。
7. **角色文案持久化**：生成结果落盘到 `<dataHome>/.design-canvas/explain.gen.json`（按模块标题索引，三档齐全才入库，损坏/残缺自动丢弃回退手写）。`POST /api/explain/generate` 成功后自动落盘；`GET /api/explain` 加载时优先合并已持久化文案（返回 `persisted` 计数），播放器下次打开无需重新调用 LLM 即可复用，刷新不丢。单测 [explain_gen.test.ts](../tests/tools/explain_gen.test.ts) 3 用例。

**验收**：`npm run serve` → 打开 Hub `/tour.html?features=<f1>,<f2>` 依次 iframe 播放各 feature 产物，进度点可跳转、当前 feature 标签跟随。科普式讲解：打开 Hub 的「🎬 科普式讲解导览」或直接访问 `/explain.html`，左侧星图 + 右侧字幕条，点「下一步」星图自动 flyToNode 定位高亮当前讲解模块；点「👤 新人 / 📊 PM / 🔧 资深」字幕立即切换为对应详细度文案，星图保持定位当前模块。持久化：首次打开 `/explain.html` 点「✨ LLM 生成文案」→ 按钮显示「✅ 已用 … 生成并持久化 N 个模块」；刷新页面自动显示「📦 已加载 N 个模块的持久化文案」，无需重新生成，文案与生成时一致。

### 7.9 import_project 集成架构分层（2026-08-07，路线图序号 5 补全）

把 architecture-analyzer 的分层能力下沉到导入入口，使 **backfill 一次到位**：import_project 生成的 DSL 无需再手动跑 `arch_layer`，即自动带层归属与职责回填。

1. **SemanticFile 加 `layer` 字段**（[semantic.ts](../src/dsl/semantic.ts)）：新增 `layer?: string`（架构层 id），schema [design_dsl.schema.json](../schema/design_dsl.schema.json) 的 File 定义同步加 `layer`。
2. **detectArchLayers 回填 `layer`**（[layer_detect.ts](../src/tools/layer_detect.ts)）：职责回填逻辑顺带写入 `semantic.files[].layer`（此前只回填 responsibility 前缀）。
3. **import_project 调用 detectArchLayers**（[import_project.ts](../src/tools/import_project.ts)）：组装 DSL 后、落盘（设计 DSL 或 live 实际 DSL）前调用 `detectArchLayers(dsl)`，一次性写入 `node.arch_layer` + `semantic.files[].layer` + `dsl.layers`。
4. **渲染 bug 修复**：[html_renderer.ts](../src/renderer/html_renderer.ts) 工具栏 IIFE 原先在 `errCount===0 && detCount===0` 时提前 `return ''`，导致 🎨 图层 / 🖍 影响 / ▶ 导览 按钮整体不渲染——而 import_project 生成的节点用 `arch_layer`（非 `layer`），err/det 恒为 0，图层按钮永不出现。改为条件化 err/det 按钮，其余按钮始终渲染。

**验证**：[arch_layer_smoke.mjs](../scripts/arch_layer_smoke.mjs) 增断言——import_project 后 `semantic.files[].layer` 须全部回填；实测 142 文件 layer 回填 142、生成 7 层（核心 66/工具 54/类型 7/UI 9/数据 4/入口 1/测试 1），代表性归属正确（src/db/db.ts→data、src/dsl/types.ts→types、src/renderer/html_renderer.ts→ui、src/server.ts→entry、src/tools/import_project.ts→utility）。渲染产物（[render_arch_smoke.mjs](../scripts/render_arch_smoke.mjs)）浏览器截图确认：工具栏出现 🎨 图层按钮，点击后画布按层统一着色、右上角图例显示 7 层色块+计数。

### 7.10 多平台插件分发 install_mcp（2026-08-07，路线图序号 12）

把 MCP server（已是标准协议）包装成各主流 client 的一键安装配置，免手工编辑 JSON/TOML。新增 [install_mcp.mjs](../scripts/install_mcp.mjs)：

1. **平台覆盖 8 种**：Claude Code/Desktop（`~/.claude.json`）、Cursor（`~/.cursor/mcp.json`）、VS Code（项目 `.vscode/mcp.json`）、Codex CLI（`~/.codex/config.toml`，TOML `[[mcp_servers]]`）、GitHub Copilot（`~/.github/copilot-mcp.json`）、Gemini CLI（`~/.gemini/settings.json`）、Windsurf（`~/.codeium/windsurf/mcp_config.json`）、Cline（`~/.cline/mcp_settings.json`）。
2. **安全合并**：JSON 型按 keyPath 深合并（保留已有其他 server）；TOML 型剔除同名 server 后追加。写入前把原文件备份为 `<file>.design-canvas.bak`；损坏的 JSON 按空重建（原文件已备份）。
3. **参数**：`--list`（不写，列路径/状态）/`--dry-run`/`--check`/`--target <platform>`/`--server <path>`（覆盖 server 入口，默认 `<root>/dist/src/server.js`）。`command` 用 `process.execPath` 锚定当前 node，避免 PATH 歧义。
4. **Windows 兼容**：JSON 解析容忍 UTF-8 BOM（PowerShell `Out-File utf8` 常见），避免 BOM 导致解析失败误当"损坏"重建丢配置。

**验证**：隔离 HOME（置 `USERPROFILE`）分平台实测——空文件生成 JSON/TOML 块正确；预置 `existing-tool` server 后合并保留 + 追加 design-canvas；带 BOM 的既有 JSON 合并后 existing-tool 不丢。清理测试产物。
