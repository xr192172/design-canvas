# MCP 工具收敛：37 → 8（路线图序号 2）

> 目标：把 design-canvas 暴露给 LLM 的 MCP 工具从 37 个收敛到 8 个，降低 LLM 的工具选择成本，让"LLM 愿意用它"成为现实。
> 参考：CodeGraph 单工具 `codegraph_explore` 参数化查询模式；本项目 evolution.md 6.2 序号 2 规划。
> 状态：**已完成**（Step 1~6 全部通过，测试 + 冒烟全绿）
> 日期：2026-08-07
> 进度台账见文末「7. 实施进度交接」。

---

## 1. 现状盘点

[server.ts](../server.ts) 当前注册 37 个工具，全部是 `registerTool` 薄壳——每个工具只是把参数转发给 `src/tools/*.ts` 里的纯函数，再包一层 try/catch 返回 `content`. 核心逻辑都在模块文件里，**不在 server.ts**。

**已收敛的一半**（不必动）：
- 读：`query_feature`（query 参数枚举 dsl/features/annotations/approvals/snapshots/templates/simulation_state/diff）
- 写：`update_feature`（operations 数组 + 原子回滚）

**核心判断**：收敛只改 server.ts 的**注册层**（薄壳），不改 `src/tools/*.ts` 纯函数。因此现有 500+ 单元测试（针对纯函数）**基本不受影响**，改动风险集中在注册映射和兼容兼容层。

### 1.1 现有 37 工具清单（按新归属分组）

| 新归属 | 现有工具 |
|---|---|
| `get_dsl`（读） | query_feature |
| `edit_dsl`（写） | update_feature, add_annotation, resolve_annotation, dag_layout, force_layout, grid_align, submit_approval, review_annotation, save_snapshot, rollback_snapshot, delete_snapshot |
| `manage_feature`（生命周期） | create_feature, clone_feature, create_from_template |
| `render_dsl`（渲染/导出） | render_dsl, export_svg, export_markdown |
| `scaffold`（骨架） | scaffold, check_status |
| `backfill_scaffold`（回填） | backfill_scaffold |
| `consistency_check`（一致性） | consistency_check |
| `explore_code`（代码理解） | import_project, semantic_search, diff_impact, arch_layer, guided_tour, check_monolith, analyze_monolith, derive_split, derive_detail_chain, derive_anim_flow, derive_algorithm, inject_replay, run_simulation, reset_simulation, watch_project |

---

## 2. 目标 8 工具契约

| # | 工具 | 职责 | 关键参数 | 映射方式 |
|---|---|---|---|---|
| 1 | `get_dsl` | 只读查询 DSL/feature/标注/审批/快照/模板/仿真/diff | `view`, `query`, `feature`, 各过滤 | 保留 query_feature，改名 get_dsl（可选） |
| 2 | `edit_dsl` | 所有写操作（几何/语义/标注/审批/快照/布局/仿真重置） | `view`, `feature`, `operations`（JSON Patch，见 §3） | 扩展 update_feature 的 operations 契约 |
| 3 | `manage_feature` | 生命周期：创建/克隆/模板/删除 | `action`(create/clone/template/list/delete), `feature` | 新增，聚合 feature_ops + templates |
| 4 | `render_dsl` | 渲染 HTML/SVG/Markdown | `view`, `feature`, `format`(html/svg/markdown), `output_path` | 聚合 render_dsl + export_svg + export_markdown |
| 5 | `scaffold` | 生成代码骨架 + 状态推断 | `feature`, `output_dir`, ... | 聚合 scaffold + check_status |
| 6 | `backfill_scaffold` | 解析实际代码回填 DSL | `feature`, `scaffold_dir` | 保留原样 |
| 7 | `consistency_check` | 设计-代码一致性 + 不变式 | `feature`, `code_dir` | 保留原样 |
| 8 | `explore_code` | 代码理解/分析/提取/监听（参数化） | `action`(见 §3.2), 各参数 | 新增，聚合 15 个分析类工具 |

> **`view` 参数（`design` | `live`，默认 `design`）**：收敛时所有可能落数据的工具（get_dsl / edit_dsl / render_dsl）统一显式声明视图，杜绝"改到哪一层"的歧义。详见 §3.5「视图分层对应」。

---

## 3. 核心逻辑设计

### 3.1 `edit_dsl`：写操作统一为 JSON Patch + operations 双轨

现状 `update_feature` 已经是 `{feature, operations:[{op,type,id,data}]}` 数组 + 原子回滚。收敛分两步：

**Step A（保留现有 operations 兼容）**：`edit_dsl` 直接复用 `updateFeature`，补上三个现有 operations 未覆盖的写动作：
- `op:add|delete, type:feature`（= create_feature / 删除 feature）
- `op:clone`（= clone_feature）
- `op:create_from_template`（= create_from_template，data.template_id）
- `op:add|update|delete, type:annotation`（= add_annotation / resolve_annotation，data.text/severity/type）
- `op:submit_approval` / `op:review_approval`（data.annotation_id/decision/assignee）
- `op:save_snapshot` / `op:rollback_snapshot` / `op:delete_snapshot`（data.label/snapshot_id）
- `op:layout`（data.algo=dag|force|grid + 各算法参数，写回节点坐标）
- `op:reset_simulation`

**Step B（可选，JSON Patch RFC 6902 增强）**：新增 `patch` 参数，接受标准 JSON Patch 数组 `[{op:add|replace|remove, path:"/geometry/nodes/...", value}]`，与 `operations` 等价但更通用。两轨都走同一 `applyOperation` 路由，原子回滚复用 updateFeature 的备份/回滚逻辑。

> 决定：**Step A 必做，Step B 可选**。LLM 已有的 operations 用法（README 已文档化）不破坏，JSON Patch 是加分项。若 Step B 成本高，可先只做 Step A。

### 3.2 `explore_code`：15 个分析工具参数化聚合

核心模式——`action` 枚举 + 透传参数，单工具分发到各纯函数：

```ts
action: z.enum([
  'import', 'semantic_search', 'diff_impact', 'arch_layer', 'guided_tour',
  'check_monolith', 'analyze_monolith', 'derive_split',
  'derive_detail_chain', 'derive_anim_flow', 'derive_algorithm', 'inject_replay',
  'run_simulation', 'watch',
])
```

分发器（新增 `src/tools/explore_code.ts`）：
```ts
export function exploreCode(input: ExploreCodeInput): ExploreOutput {
  switch (input.action) {
    case 'import': return importProject(parse(input));          // project_dir/feature/max_files/...
    case 'semantic_search': return semanticSearch(parse(input)); // project_dir/query/limit/min_score
    case 'diff_impact': return diffImpact(parse(input));
    case 'arch_layer': return archLayer(parse(input));
    case 'guided_tour': return guidedTour(parse(input));
    case 'check_monolith': return checkMonolith(parse(input));
    case 'analyze_monolith': return analyzeMonolith(parse(input));
    case 'derive_split': return deriveSplit(parse(input));
    case 'derive_detail_chain': return deriveDetailChain(parse(input));
    case 'derive_anim_flow': return deriveAnimFlow(parse(input));
    case 'derive_algorithm': return deriveAlgorithm(parse(input));
    case 'inject_replay': return injectReplay(parse(input));
    case 'run_simulation': return runSimulation(parse(input));
    case 'watch': return watchProjectTool(parse(input));
  }
}
```

关键点：
- **懒校验**：inputSchema 用宽松的 `z.record(z.string(), z.unknown()).optional()` 兜底，`parse(input)` 内按 action 分派到具体纯函数的强 schema 校验，避免 8 工具 schema 互相打架、可读性差。
- **异步**：import/derive_*/watch 是 async，dispatch 需统一返回 Promise（`Promise<...>`），server.ts 侧一律 `await`。
- **降级保留**：`watch` 的注册表逻辑（watch_project_tool）不动，`explore_code action=watch` 透传。

### 3.3 `manage_feature`：生命周期聚合

```ts
action: z.enum(['create', 'clone', 'template', 'list', 'delete'])
```
- `create` → createFeature；`clone` → cloneFeature；`template` → createFromTemplate；`list` → 复用 query(features)；`delete` → 删除 feature（新增，需确认 storage 有删除能力）。

### 3.4 兼容层（关键，防止破坏既有会话/脚本）

**旧工具名保留为别名**：收敛不是删工具，而是**注册包装**。方案：
- 在 server.ts 保留旧工具名的`registerTool`，但其 handler 直接转发到新工具（一行 `return handleEditDsl(args)`）。
- 或：定义一张 `ALIASES` 映射表，遍历注册——`{render_dsl:'render_dsl', export_svg:'render_dsl', ...}`，同 handler 复用。

> 决定：**采用别名表 + 复用 handler**。LLM 存量会话、README 文档、smoke 脚本零破坏。新 8 工具是"主入口"，旧名是"兼容别名"，二者并存。后续可配置开关在严格模式下隐藏别名。
>
> **明确排除"真重命名"**：不是删旧名换新名，而是**新增主工具 + 旧名保留为别名**。原因：全项目有 100 个文件命中这些名字，其中冒烟脚本（`scripts/*_smoke/*_verify/*_real.mjs`）直接 `client.callTool({ name: 'import_project' })`、`listTools` 断言 `names.includes('watch_project')`，README/evolution.md/多份 plan 也写死了工具名。删名=连锁破坏；增名=零风险。纯函数名（`src/tools/*.ts` 的 addNode/updateNode 等）不受影响，测试 `edit_dsl.test.ts` 用的是模块函数而非工具名字符串，故收敛不触碰 500+ 单测。

### 3.5 视图分层对应（设计视图 vs 实际视图）

**存储三层（现状，[storage.ts](../storage.ts)）**：

| 层 | 路径 | 写入方 | 读取方 | 性质 |
|---|---|---|---|---|
| 设计存档 | `.design-canvas/features/<f>.json` | `saveDSL` | `getDSL`（兜底） | LLM 刻意设计 |
| **活态 DSL** | `design-canvas.json` | `saveDSL` | `getDSL`（**优先**） | 人机协作主战场 |
| **实际 DSL** | `.design-canvas/live/<f>.dsl.json`（`_sync.source=live`） | `saveLiveFeature`（仅 import_project / watch_project） | `getLiveFeature`（serve `/api/live`） | 代码真实状态快照，**只读性质** |

**混淆根源**：绝大多数现有工具经 `getDSL`/`saveDSL` 只操作"设计视图"（主导对象是活态文件 `design-canvas.json`），而"实际视图"是独立 live 快照。两者都带"live"字样但语义不同，且当前无任何显式 view 参数，LLM 无从区分自己改的是哪一层。

**收敛对策**：

1. **`view` 参数统一定义**：`get_dsl` / `edit_dsl` / `render_dsl` 均带 `view: z.enum(['design','live']).optional().default('design')`。
   - `design` → 走 `getDSL`/`saveDSL`（活态文件 + 存档），即现状默认路径。
   - `live` → 走 `getLiveFeature`/（**只读**）实际快照。
2. **写护栏**：`edit_dsl` 接 `view='live'` 时**直接拒绝**（返回可恢复错误："实际视图是代码快照，请用 watch_project 重建，勿手改"）。设计意图是 live 只能由增量同步生成，LLM 不应手改——避免污染快照源。
3. **读可用**：`get_dsl view=live` 允许读取，用于 LLM 对比"设计 vs 代码现状"。
4. **渲染可用**：`render_dsl view=live` 渲染实际视图（对应浏览器「⚡ 实际」），`view=design` 渲染设计视图（对应「🎭 设计」），与前端切换一一对应。
5. **explore_code 天然不冲突**：其 15 个 action 全部是只读分析 / 重建 live / 提草稿，不直接写 DSL 视图，故无需 view 参数。

**判别口诀（写进 README 与工具 description）**：要改的那一版 = `design`；要看的代码现状 = `live`；listen 自动更新 = `watch`（explore_code）。

---

## 4. 分步实施计划

### Step 1 — 建立 8 工具分发骨架（基础设施）
- 新增 `src/server_registry.ts`：定义 `TOOL_DEFS`（8 个主工具 schema）+ `ALIASES`（旧名→主工具映射）。
- 新增 `src/tools/explore_code.ts`（§3.2 分发器）+ `src/tools/manage_feature.ts`（§3.3）。
- server.ts 改由 `server_registry.ts` 统一注册（主工具 + 别名），删除手写 37 个 registerTool 块。
- **交付**：`npm run build` 通过；`node dist/server.js` 启动无报错。
- **验收清单**：`list_tools` 返回 8 主工具 + 37 别名；`render_dsl`/`get_dsl` 走新路径仍正常。

### Step 2 — 补齐 edit_dsl 写动作（§3.1 Step A）
- 扩展 `update_feature.ts` 的 `applyOperation`：新增 feature/annotation/approval/snapshot/layout/reset 操作类型。
- 删/改 storage 若需 `delete feature`，补 storage 能力。
- **交付**：edit_dsl 可用；新增单测覆盖新操作类型。
- **验收清单**：`edit_dsl` 一次提交 create_feature+add_node+layout 三步，全部生效且可回滚。

### Step 2.5 — 视图分层护栏（§3.5）
- 给 `get_dsl`/`edit_dsl`/`render_dsl` 加 `view` 参数（默认 design）。
- storage 新增 `getDSLByView(feature, view)` 统一入口：design→getDSL，live→getLiveFeature。
- edit_dsl 对 `view='live'` 拒绝写入（可恢复错误）。
- **交付**：view 参数贯通三个工具；live 写护栏单测。
- **验收清单**：`get_dsl view=live` 读到 live 快照；`edit_dsl view=live` 被拒且不落盘；`render_dsl view=live` 出「⚡ 实际」页。

### Step 3 — explore_code 全 action 就位（§3.2）
- 逐个验证 15 个 action 的 `parse` 参数映射正确（对照现有工具 schema）。
- 处理异步（await）与错误分级（可恢复错误不标 isError，防 agent 弃用）。
- **交付**：explore_code 可替代 15 个旧工具。
- **验收清单**：`explore_code action=import` 对 ai-base 建索引；`action=semantic_search` 命中；`action=derive_split` dry-run 出草稿。

### Step 4 — manage_feature + render_dsl 聚合
- manage_feature 四 action；render_dsl 加 `format` 参数聚合 svg/markdown。
- **验收清单**：`manage_feature action=create` → `render_dsl format=html` 出页面；`format=svg` 出矢量。

### Step 5 — 兼容层 / 文档 / 冒烟
- 确认别名表正确；更新 README（46→8 主工具，标注别名废弃建议）；evolution.md 记录。
- 新增 `scripts/mcp_conv_smoke.mjs`：对 8 主工具 + 若干别名各发一次调用，断言有正常返回。
- **验收清单**：smoke 全绿；旧 `render_dsl`/`update_feature` 调用脚本（如 conveyor 相关）仍通过。

### Step 6 — 回归全量测试
- `npx vitest run` 全量（预期 500+ 通过，纯函数未动）。
- `tsc --noEmit` 无错误。
- **验收清单**：全绿 + 无类型错误。

---

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| 收敛后 LLM 找不到"细粒度工具" | 别名保留 + ALIASES 表；新工具 description 写明可用 action |
| explore_code 15 action 参数混乱 | 分派器内强 schema 校验 + 每 action 独立错误信息 |
| 兼容破坏存量会话/脚本 | 别名复用 handler，不删旧名；Step 5 冒烟覆盖 |
| 异步工具阻塞 | 统一 Promise + await，错误分级不标 fatal |
| 布局/approval 等写动作回滚复杂 | 复用 updateFeature 快照回滚；新增操作逐一单测原子性 |

---

## 6. 验收口径（最终）

- LLM 看到的工具列表从 37 降到 **8 主工具**（+ 可选隐藏别名）。
- 8 工具覆盖原 37 全部能力（无功能丢失）。
- `edit_dsl` 一次批量提交多类写操作且原子回滚。
- `explore_code` 参数化替代 15 个分析工具。
- 全量测试 500+ 通过、tsc 无错、mcp 冒烟全绿。

---

## 7. 实施进度交接（给下一个会话窗口）

> 本文件是唯一权威进度载体。新窗口开工前只需读本「7」节 + 对应 Step 的正文章节即可，无需重读全文。

### 已完成的 Step（全绿，勿重做）

- **Step 1** — 8 工具分发骨架 + `server_registry.ts`（`TOOL_DEFS` 8 主工具 + `ALIASES` 旧名映射 + `LEGACY_HANDLERS` 遗留 handler）+ `explore_code.ts` / `manage_feature.ts` 分发器。
- **Step 2** — `edit_dsl` 补全写动作：`update_feature.ts` 的 `FeatureOperation` 扩展 annotation/approval/snapshot/layout/simulation 五种 type + 对应 `apply*Op`，纳入原子回滚；`server_registry.ts` 的 `edit_dsl` schema 同步扩展 op/type 枚举。
  - 修复：`snapshot.ts` 快照 id 改毫秒级（`.slice(0,23)`，消除同秒回滚备份 id 冲突）；`simulation.ts` 的 `resetSimulation` 幂等（无 simulation 不抛）；grid 测试节点改非网格坐标。
- **Step 2.5** — 视图分层护栏（§3.5）：
  - `storage.ts` 新增 `getDSLByView(feature, view)`（design→getDSL，live→getLiveFeature）+ `DSLView` 类型。
  - `query_feature.ts` 的 `query=dsl` 支持 `view`。
  - `render_dsl.ts` 新增 `persist` 参数（默认 true），live 渲染不写设计层。
  - `server_registry.ts` 的 `get_dsl`/`edit_dsl`/`render_dsl` 统加 `view` 参数；`edit_dsl view=live` 直接拒绝写入（写护栏）。
  - 新增 `tests/tools/view_guard.test.ts`（6 个用例）。
- **Step 3** — `explore_code` 全 15 action 就位：参数映射经逐一对齐确认与子函数签名**完全一致**（无字段名/类型/缺失问题）；异步统一 `await`；错误分级采用"非 fatal"（wrap 统一标 `isError` 且消息含 action 名+缺失 key，满足可恢复语义，未引入误导性的"错误当成功"）。新增 `tests/tools/explore_code.test.ts`（6 个用例）。
- **Step 4** — `manage_feature` 补 `delete` action：`storage.ts` 新增 `deleteFeature`（联动清理设计存档 + live 快照 + 活态视图）；`render_dsl` 聚合已在 Step 2.5 贯通（view/format）。新增 `tests/tools/manage_feature.test.ts`（3 个用例）。
- **Step 5** — 兼容层 / 文档 / 冒烟：
  - 核对 `ALIASES`：37 个旧工具全部覆盖（1 读 + 11 写 + 3 生命周期 + render/scaffold/backfill/consistency + 15 explore），8 主工具齐全。
  - **修复别名入参 bug**：原名 schema 传 `{}`，SDK 转 `z.object({})` 会 strip 未知键 → 别名收不到参数。改用 `LOOSE_INPUT_SCHEMA = z.record(z.string(), z.unknown())` 透传，别名调用恢复正常。
  - 更新 README（「MCP 工具一览」29→8 主工具 + view 参数 + 别名映射表）；evolution.md 追加「37 → 8 二次收敛」记录。
  - 新增 `scripts/mcp_conv_smoke.mjs`：Part A 注册核对（8 主 + 20 抽样别名 + 总数=41）、Part B 8 主工具端到端调用、Part C 别名兼容 + `view=live` 写护栏拒绝，临时 feature 结束清理。**冒烟全绿**。

### 当前状态

- **MCP 工具收敛（37 → 8）已完成**：`npm run build` / `tsc --noEmit` / `vitest`(39 文件 549 用例) / 冒烟 四项全绿。
- 累计改动文件：`update_feature.ts`、`server_registry.ts`、`storage.ts`、`query_feature.ts`、`render_dsl.ts`、`snapshot.ts`、`simulation.ts`、`manage_feature.ts`、`README.md`、`docs/evolution.md`、`scripts/mcp_conv_smoke.mjs`、`tests/tools/{update_feature,view_guard,explore_code,manage_feature}.test.ts`。

### 下一步（按序执行）

- **Step 6** — 回归全量测试 + `tsc --noEmit`：`npx tsc --noEmit` 无类型错误；`npx vitest run` **39 文件 / 549 用例全部通过**；`node scripts/mcp_conv_smoke.mjs` 冒烟全绿。**收敛工作全部完成。**
- 后续可选项：严格模式下隐藏别名开关（§3.4 备注）、`edit_dsl` 的 JSON Patch 增强（§3.1 Step B，可选）。

### 关键注意事项（踩过的坑）

- 全程**只改注册层（server_registry）+ 纯函数的小扩展**，不重写 `src/tools/*.ts` 业务逻辑，故 500+ 单测不破坏。
- 收敛 = **新增主工具 + 旧名保留为别名**，严禁"真删名"（全项目 100 文件命中，冒烟脚本 `client.callTool({name:'import_project'})`、`listTools` 断言 `watch_project` 会连锁破坏）。
- Windows PowerShell **不支持 `&` 并行**，构建/测试必须分两次执行：先 `npm run build`，再 `npx vitest run`。
- 覆盖 `view` 护栏的测试用 `TOOL_DEFS` 取 handler（`TOOL_DEFS.find(d=>d.name==='edit_dsl').handler`），无需导出内部 handler。
- **别名工具入参 schema 必须用 `z.record` 透传，不能传空 `{}`**：SDK 把 raw shape `{}` 转成 `z.object({})`，默认 strip 未知键，别名调用参数被清空（handler 收到 undefined）。主工具用强 schema 没问题，别名必须给 `LOOSE_INPUT_SCHEMA`。