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

#### 实际实现（40+ 工具，分 7 组）

| 分组 | 工具 | 变更性质 |
|---|---|---|
| **核心渲染** | `render_dsl` / `get_dsl` / `list_features` | 对齐设计 |
| **增量编辑** | `create_feature` / `add_node` / `update_node` / `delete_node` / `add_edge` / `delete_edge` / `add_file` / `update_file` / `delete_file` / `add_expected_api` / `update_expected_api` / `delete_expected_api` / `set_node_semantic` | **新增**——替代"每次重写整个 JSON" |
| **批量操作** | `batch_move_nodes` / `batch_update_style` / `batch_delete_nodes` / `clone_feature` / `diff_features` | **新增** |
| **代码生成** | `scaffold`（替代 `export_skeleton`）/ `backfill_scaffold` / `check_status` / `update_status` / `consistency_check`（替代 `design_check`） | **改名+拆分** |
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
| E | ⏳ | conveyor.json 迁移到 L2 + 删除 scripts.ts 专用动画代码 |

**仍存在的问题**（阶段 E 待解决）：
1. **专用代码未清除**——scripts.ts 中的 `createSectionCardContainer` / `updateSectionVisuals` 等约 1550 行专用动画代码仍在运行，与通用引擎并存（双份卡片渲染逻辑）
2. **scripts.ts 体积**——171KB 未缩减，待阶段 E 删除专用代码后预期降至约 155KB
3. **暂停/步进**——通用引擎已实现 pause/resume/step，但未接入 UI 按钮

**已解决**（相对旧版 evolution.md 记录的问题）：
- ~~高度专用化~~ → 通用引擎不硬编码节点 ID，通过 effect 注册表扩展
- ~~动画逻辑与渲染耦合~~ → 独立 animation_engine.ts 模块，由 html_renderer.ts 注入
- ~~缺乏动画声明层~~ → animations_v2 字段已支持，conveyor.json 已有 3 个 L2 flow 验证

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
| ~~动画系统专用化~~ | ~~硬编码 conveyor 节点 ID~~ → ✅ 通用引擎已实现，待阶段 E 清除专用代码 | 阶段 E 删除 scripts.ts 专用动画代码 |
| 消息粒子终点处理 | 当前淡出移除（违反 project_memory 旧约束） | 保留淡出？还是恢复"转换为可拖拽容器"？ |
| 文档更新 | design.md / mvp-plan.md / README.md 严重滞后 | 更新旧文档？还是以 evolution.md + animation-design.md 为准？ |
| tmp_backfill_* 污染 | 80+ 临时目录未清理 | backfill.ts 改用 os.tmpdir() 或运行后清理 |
| scripts.ts 体积 | 171KB 单文件 | 阶段 E 删除专用动画代码后预期降至约 155KB |

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

6. **阶段 E：conveyor.json 迁移**——在 conveyor.json 显式声明 card_* flow + 删除 scripts.ts 专用动画代码（约 1550 行）
7. **MCP 工具分层暴露**——方案 B：MCP 侧收敛到 ~12 个高频工具，其余走 serve.ts HTTP
8. **L3-L5 动画能力**——条件分支 / 函数绑定 / 异常语义 / 反向提取（中低优先级）
