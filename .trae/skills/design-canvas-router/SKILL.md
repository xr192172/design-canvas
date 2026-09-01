---
name: "design-canvas-router"
description: "design-canvas 渐进披露路由。遇到『画图/看代码/重构/对账/查真跑/自查/出图』一类诉求时，先按本 skill 分层定位『该调哪个工具、别造新工具』。与 design-canvas-mind（心智外衣）配合：mind 讲方法论，router 讲『这个问题 → 哪只手』。"
---

# design-canvas 路由 / 渐进披露

拿到一个愿望或一句含糊问题，先跑这套**分层路由**：逐层缩小，直到落到该调的那个工具。**没把握时就先查，不猜，更不为小愿望手写新工具。**

判断顺序固定为「先粗后细」——每一层都问一句，答不上再下一层。

## 第一层：这是哪类诉求？

| 你手里的愿望（听关键词） | 该去哪个出口 | 走人 |
|---|---|---|
| 要把结构/数据画成图给人类看（设计图/思维导图/架构图/流程） | **画图** | 见第二层 · A |
| 要理解一份已有代码/工程（依赖、影响面、怎么拆、算法怎么流） | **代码理解** | 见第二层 · B |
| 要从设计图生成代码 / 让实现状态回填设计 / 对比契约是否一致 | **生成/回填/一致性** | 见第二层 · C |
| 要做一次重构或改名，想安全落地不死人 | **重构防线** | 见第二层 · D |
| 要看代码『真跑起来』的行为，或用埋点对账实际 vs 设计 | **插桩/摄像头** | 见第二层 · E |
| 想知道这套工具本身多语言支持到哪、还差哪些 | **能力矩阵** | `npm run capability` / `npm run doctor` |

## 第二层：落到工具

### A · 画图
- 原始诉求是「建底 / 出图 / 全项目对账」→ `import_project` → `render_design` → `reconcile_effects`
- 只是「改一版图 / 查当前图」→ `get_dsl`（读）+ `edit_dsl`（写，批量操作，原子回滚）
- 新建/克隆/删一个 feature → `manage_feature`
- 想换输出格式（html/svg/markdown）→ `render_design format=…`
- 别手写渲染器/新布局脚本——编辑类动作都收进 `edit_dsl` 的 `operations[]`。

### B · 代码理解（全走 `explore_code`，用 `action` 分发）
| action | 当你想… |
|---|---|
| `import` | 把一份真实工程导入成 live 快照 |
| `semantic_search` | 用自然语言搜这块代码里"做了什么/在哪" |
| `diff_impact` | 改动会波及哪些文件/符号 |
| `arch_layer` | 看分层/架构 |
| `check_monolith` / `analyze_monolith` / `derive_split` | 混沌是坨屎山？哪些能拆、怎么拆 |
| `derive_detail_chain` / `derive_algorithm` | 把一条调用链/一段算法流程推导出来 |
| `inject_replay` / `run_simulation` / `reset_simulation` | 对流程做数据流仿真 |
| `watch` | 让 live 快照随代码变化自动更新 |

### C · 生成 / 回填 / 一致性
- 生成骨架 → `scaffold`
- 代码已实现，想回填 expected→actual 差异 → `backfill_scaffold`
- 纯对比契约，不写盘 → `consistency_check`（只读）

### D · 重构防线
- 安全重构/改名 → `verify_refactor` / `refactor_pipeline`（自带：基线验证 → 落盘 → 重验 → 失败回滚）
- 提级/包改名（含别名清洗）→ `package_migration`（已 AST 作用域守卫，不会误扫局部变量）
- 重构后怀疑符号失配 → 契约对账闸门（`contract_gate`）
- 提交前怕 go:embed 产物没进库 → 提交层自检（`submit_gate`）

### E · 插桩 / 摄像头
- 给代码动态插桩采集真实行为 → `src/observe/`（TS）+ `go-observe/`（Go）
- 用真跑事件对账实际 vs 设计 DSL → `reconcile_chain`（会自动前置、缓存跳过、诚实标 `not_run`）
- 审事件/判定偏差 → `log_query` → `judge` → `chain.rebuildChains`

## 第三层：都定位不到？→ 三连招

1. **先拼**：用上面已列工具即席编排能覆盖，就当场跑通，不固化。
2. **再查**：翻 `explore_code` 的 `action` 清单 / `get_dsl` 的 `query` 清单，看是不是已有参数化入口被我漏了。
3. **才造**：同一编排被**复用 ≥2 次**且是稳定流程，才来讨论固化成新工具。（一步步都会收到"先注入 mind → 先编排 → 才固化 → 诚实交付"的纪律约束。）

## 自查提示

- 我把『画图/看码/重构/对账』的诉求，落到**既有工具**了吗？（没落 = 还没定位完）
- 我为一次性小愿望写新工具/新脚本了吗？（写了 = 越界，回退）
- 无真数据时我伪造/降级冒充了吗？（伪造 = 违反诚实纪律）

> 方法论点这里够用了；每个愿望的『先注入活 DSL + 能力地图 → 先编排 → 才固化 → 诚实交付』完整纪律见 design-canvas-mind 心智外衣。