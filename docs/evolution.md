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
7. **L3-L5 动画能力**——条件分支 / 函数绑定 / 异常语义 / 反向提取（中低优先级）

---

## 6. 全量借鉴路线图（2026-07-24 制定）

> 背景：调研 GitHub 爆款 [CodeGraph](https://github.com/colbymchenry/codegraph)（2 万 star，代码→调用图 MCP server）和 [Understand Anything](https://github.com/Lum1104/Understand-Anything)（6.9 万 star，代码→知识图谱 Claude 插件）后，不取"差异化竞争"视角，而是**全量吸收两者优点**——所有增强方向都做，按依赖关系排序，无放弃项。

### 6.1 路线图总表

| 批次 | 序号 | 项 | 来源 | 依赖 | 状态 |
|------|------|-----|------|------|------|
| **基础设施** | 1 | SQLite 存储 + 文件 hash 增量 backfill | CodeGraph | 无 | 🚧 v1 已落地（src/db/，见 7.3） |
| | 2 | MCP 工具收敛到 ~8 个（JSON Patch 模式） | CodeGraph | 无 | ⏳ |
| | 3 | 调用边级别提取（symbol + call_edge + dependency 表） | CodeGraph | 1 | ⏳ |
| **代码理解** | 4 | Diff Impact Analysis（变更影响范围追溯） | Understand Anything | 3 | ⏳ |
| | 5 | architecture-analyzer 角色（推断架构层 + 职责回填） | Understand Anything | 3 | ⏳ |
| | 6 | Guided Tours（拓扑排序学习路径 + 动画播放列表） | Understand Anything | DSL edges | ⏳ |
| **可视化** | 7 | Layer Visualization（按 type 分层着色 + legend） | Understand Anything | 5 | ⏳ |
| | 8 | Fuzzy & Semantic Search（语义搜索"哪部分处理认证"） | Understand Anything | 无 | ⏳ |
| | 9 | Persona-Adaptive UI（角色自适应详细度） | Understand Anything | 无 | ⏳ |
| | 10 | Language Concepts（12 种编程模式上下文解释） | Understand Anything | 3 | ⏳ |
| **自动同步** | 11 | 文件监听自动同步（FSEvents/inotify） | CodeGraph | 1, 3 | ⏳ |
| | 12 | 多平台插件分发（Claude Code/Cursor/VS Code/Codex） | 两者 | MCP 已就绪 | ⏳ |
| **独有能力** | 13 | 动画系统阶段 E（conveyor 迁移） | 自有 | 无 | ⏳ |
| | 14 | L3-L5 动画（条件分支 / 函数绑定 / 异常 / 反向提取） | 自有 | 13 | ⏳ |
| | 15 | L5 反向提取增强（基于 SQLite + 调用边） | 自有 | 1, 3, 14 | ⏳ |

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

**13. 动画系统阶段 E**——conveyor.json 显式声明 card_* flow + 删除 scripts.ts 专用动画代码

**14. L3-L5 动画**——条件分支 / 函数绑定 / 异常语义 / 反向提取

**15. L5 反向提取增强**——基于 SQLite + 调用边，让反向提取更扎实；从代码提取的调用链直接驱动 L4 函数绑定动画

### 6.7 和现有规划的关系

- 原"待完成 6（阶段 E）"→ 归入序号 13
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
