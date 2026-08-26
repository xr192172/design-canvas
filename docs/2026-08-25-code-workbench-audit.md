# 底层能力审计报告：LLM 编码工作台（design-canvas · 2026-08-25）

> 目标：盘点 design-canvas 作为"LLM 编码工作台"的底层能力，判定扎实度，
> 找出"解放 LLM、只有出问题才回报 LLM"所需的缺口，并给出落地顺序。
> 本页供后续 P1–P4 实施对照，实施时逐项回填状态。

## 一、结论一页

- **编辑/重构层够扎实**：`edit_code` 用符号定位 + 多重安全门，`refactor_pipeline + refactor_judge` 带人工裁决门，`ast_rename` 作用域感知防误伤。
- **短板在「自主回舱闭环」与「接线」**：缺文件级重命名、删文件工具、独立验证执行、代码级回滚；且 `monolith`/`split_stage` 等引擎未注册进 MCP，LLM 够不到。
- **取向纠正**：底层对"按行号改"是**故意反行号**（改按符号定位，更稳）；只是在"显式行区间"上可补一条。

## 二、能力账本

| 能力 | 现状 | 载体文件 | 扎实度 |
|---|---|---|---|
| 改单文件 | 符号定位 + re-parse 门 / 语法错误门 / 重复顶层符号门 / 写盘后重索引 | `src/tools/edit_code.ts` | 🟢 很扎实 |
| 符号级重命名防悬空 | 作用域感知 / LocalBinding / 宁漏不误 + 跨文件同步 | `ast_rename.ts` / `rename_symbol.ts` / `suggest_renames.ts` | 🟢 扎实 |
| 重构屎山 | 执行器编排 + 裁决门(采纳/忽略/上抛) + 瘦身/组装/对账 | `refactor_pipeline.ts` / `refactor_judge.ts` / `slim_brick.ts` / `assemble_bricks.ts` / `remove_dead_imports.ts` | 🟢 很充实 |
| 看设计状态 | 渲染 / 代码探索 / 视图 diff / 设计代码漂移告警 | `render_sandbox` / `explore_code` / `diff_views` / `watch_project_tool.ts` | 🟢 |
| **文件级重命名(改 import 引用防悬空)** | 无；只有 `removeFile` 内部删索引 + 符号级 rename | — | 🔴 真缺口 |
| **删文件工具** | 无显式 MCP 工具 | — | 🔴 缺口 |
| **显式行区间编辑** | `edit_code` 只有 symbol，无 `range` | `edit_code.ts` | 🟡 可补 |
| **通用验证执行(build/typecheck/test)** | 仅 `refactor_pipeline` 内部有 `mergeVerifyCommands/dominantVerifyCommands`，无独立自检 | `refactor_pipeline.ts` | 🔴 缺口 |
| **代码级 undo/auto-rollback** | `snapshot.ts` 只覆盖 DSL 设计态；代码改坏无自动回退 | `snapshot.ts` | 🔴 缺口 |
| **引擎接线** | `monolith`/`split_stage`/`analyze_monolith`/`package_migration`/`derive_split`/`simulation` 未注册进 `server_registry.ts` | `server_registry.ts` | 🟡 接线缺口 |

## 三、解放 LLM 的自主回舱流水线

> 触发器（来自需求："看看还缺什么功能才能解放 LLM，只有出问题才回报 LLM"）。

现在 `refactor_judge` 裁决门**默认全部判"不确定"并上抛**（保守策略，防人工环节被跳过）——这是**全回报**，与"只出问题才回报"相反。

要落地"只出问题才回报"，底层要能自己跑完：

```
改(edit/rename/refactor)
  → 自动验证(build/typecheck/test)            缺：独立 verify 工具
  → 失败 → 自动修一次 → 仍失败 → 自动回滚     缺：代码级 undo/auto-rollback
  → 全仓扫描：悬空引用/死 import/重复符号      有 remove_dead_imports；缺整仓一致性健康报告
  → 引用升级(judge) 仅对【验证失败后仍不确定 / 影响面超大】上抛
  → 其余静默，只回报「已完成 + 健康报告」
```

只有三种情况回报 LLM/人：**验证失败且自动修复/回滚也搞不定**、**judge 判不确定**、**影响面超限**。

## 四、落地顺序

- **P1 文件级智能重命名 `rename_file`** —— 最硬缺口 + 首选：算影响面(引用它的所有 import/require) → 迁移文件 → 自动改全项目引用 → 重索引 → 报无关引用清单。状态：待开工
- **P2 `edit_code` 加 `op:'range'`** —— 符号为主 + 显式行区间可选，带 diff 预览 + 语法门兜底。状态：待开工
- **P3 接可视化界面** —— 把 P1/P2/现有底层接到壳上，人看 diff + 点审批（呼应 dsl-workbench/design-canvas 可视化闭环）。状态：待开工
- **P4 自主回舱闭环** —— 独立 `verify` 工具 + 改后 auto-verify/auto-rollback + 接线开源 `monolith`/`split_stage` + judge 改为"自检吸收后只上报真问题"。状态：待开工

## 五、实施铁律（沿用工作区约定）

- 改前自动提交 Git；改后测试（含插桩）；测试通过提交 Git，否则回退原版本。
- 处理文件用 Write 而非 Edit（规避 Edit 未落盘缺陷）。
- 底层引擎新增后必须**注册进 `server_registry.ts`**，否则 LLM 够不到（接线是硬验收项）。
- 新工具统一三件套：MD 指南 + 脚本 + 元数据；写入 `ai-config/skills/` 沉淀可复用能力。