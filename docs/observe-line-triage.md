# observe（原 camera）线体检：插桩 / 事件 / 判定 / 对账

> 2026-09-14 ｜ 起因：用户提问「我们其实有一个探针栏目，但当时设计得很激进，**到底有没有用**？
> 我感觉上来说是用不太上。就是插装——自动查找每一个文件的进出口，然后监视每一次变化。名字应该叫摄像头 camera 吧。」
> 本文**用数据回答**，并给出三个处置选项（含推荐）。与 `tool-convergence.md` §5.5/§5.6 同族。

---

## 1. 它到底是什么（先把名字与范围对齐）

- **曾用名 `camera`** —— 2026-08 已全量改名 `camera_* → observe_*`（`tool-convergence.md` §5.5，commit d7e4953）。
  用户的直觉没错：它就是"摄像头"——**给代码装进出口探针，拍下每一次运行变化**。
- **设计原话**（`src/observe/instrument.ts` 头注释）：
  > 「**全自动插桩器**（AST 源码级插桩，直接改写原文件，git 兜底）……
  > 对所有函数**出入口**、return、参数、返回值、catch 块、IO 写盘调用**全插探针，不挑点**。
  > DSL 做筛选——探针产出全量事件，装配层用 DesignDSL 声明匹配判定，没命中的即 undesigned 噪音。」
  > 分级：`core`（函数出入口，发现数据/逻辑错误）/ `event`（catch 静默丢错 + IO 写盘）/ `deep`（内部关键变量，默认不开）。
- **范围**（比"插桩"大一圈）：

| 层 | 组件 | 位置 |
|---|---|---|
| 插桩 | `instrument.ts`（TS/JS AST 全量插桩）、`go_instrument.ts`（桥 go-observe 的 go/ast 注入） | `src/observe/` |
| 事件 | 事件日志 `events.jsonl` + `log_query.ts`（查询） | `src/observe/` |
| 判定 | `judge.ts` / `judge_guard.ts` / `judge_service.ts`（逐事件判定 + 守护） | `src/observe/` |
| 链路 | `chain.ts`（重建实测调用链）、`trace.ts`（回放）、`tiered.ts`（分层） | `src/observe/` |
| 对账 | `reconcile_chain` / `reconcile_effects` / `reconcile_brick` | `src/tools/` |
| 叙事/展示 | `narrate_step` / `run_narrate` / `observe_chain_view` / `feature_line` / `export_incident` | `src/tools/` |
| Go 侧 | `go-observe/`（cmd/internal/probe，独立 Go 模块） | 仓根 |

---

## 2. 体检数据（本机唯一 dogfood 账本，2026-09-08 → 09-14）

账本：`<dataHome>/.design-canvas/dogfood/usage.jsonl`（所有 MCP 工具调用都过 `recordDogfoodUsage`）。
**样本：944 次调用，7 天。**

| 工具 | 次数 | | 工具 | 次数 |
|---|---|---|---|---|
| `explore_code` | **749** | | `detect_drift` | 6 |
| `capability_map` | 87 | | `read_project_docs` | 3 |
| `get_dsl` | 42 | | `edit_code` | 3 |
| `gateway_provider` | 14 | | `consistency_check` | 2 |
| `import_project` | 12 | | `set_design_intent` | 2 |
| `translate_go_ts` | 9 | | 其余各 1（find_references / canvas_notes / backfill_scaffold / render_design / manage_feature / extract_contracts / run_tests / annotate_functions） |
| `edit_dsl` | 7 | | | |

### ★ `observe_*` / `reconcile_*` / `narrate_*` / `feature_line`：**0 次**

**用户的直觉被数据证实。** 加上两条旁证：

1. **体量与维护面**：`src/observe/` **3,159 行** + 相关 tool 文件 **1,895 行** + `go-observe/` **~7,000 行 Go**
   （另需 `camprobe` 依赖才能编译被测 Go 工程）；**20+ 个测试文件**（`tests/observe/` 15 个 + `tests/tools/` 里的
   observe/narrate/reconcile/feature_line 若干）—— 是仓库里最重的一块"零使用"资产。
2. **已冻结**：`src/observe/` 最后一次提交 **2026-09-08**（bulk 提交 9091abb），而 `ts_kernel` 是 **09-14**
   —— 也就是说，**最近一周所有真正的开发动作都绕开了它**。

**诚实边界（别过度解读）**：
- 账本只记 **MCP 注册工具**的调用；`instrument_cli` / go-observe 的 **CLI 直跑不记账** ⇒ 不能断言"从没跑过"，
  只能说"**模型从不主动调它**"。
- 但"模型不主动用"本身就是问题：它设计了 6 条 observe 能力线、10 个工具，结果是 **0 采纳**。

---

## 3. 为什么用不上（根因，不是"功能不好"）

| 根因 | 说明 |
|---|---|
| **① 前置成本最高的一条线**（= `tool-convergence.md` §5.6 障碍 #2 的极端形态） | 要"先插桩 → 先跑起来 → 才有事件"。而 agent 的绝大多数请求是"读/改代码"，**跑不起来就没有事件**，插桩白做还给仓库引入 diff。 |
| **② 输出形态错位**（障碍 #4） | 产出是日志/事件流/分镜报告；agent 要的是"代码改好了"。要 LLM 读事件流，成本高、可信度低。 |
| **③ 原设计假设太激进** | "**全量无脑插桩**，靠 DSL 判定筛掉噪音"——把筛选成本推给了判定层与读者；现实中没人愿意为了"也许要看"而全量改写源码。 |
| **④ 它服务的是"运行时正确性"，但当前阶段的高频需求是"改对 + 可撤回"** | 我们用 7 天 944 次调用证明了：**agent 关心的是读得快、改得准、能撤回**，不是运行期对账。 |

---

## 4. 但有两块是"承重墙"，别一起删

| 组件 | 为什么不能删 |
|---|---|
| **`behavior_baseline`（金丝雀 harness：capture→改代码→verify 对拍）** | 它就是**"验证闸"**：Morph/Modelcode 的差异化卖点正是"新旧程序行为对拍"，而我们自己的判据阶梯 **L4 = 可执行验收 + 隐藏 holdout** 也需要一个执行器。 |
| **`instrument`（插桩）+ 事件流** | 是上面那道的**底座**；另外 `detect_drift`/`reconcile_*` 的"用实测校准契约"也依赖事件。 |

⇒ **结论：不是"删掉"，是"改角色"**——从"要用户先插桩的一套流程"改成"**验证动作的副产品**"。

---

## 5. 三个处置选项（推荐 C）

### A. 降级不暴露（保守）
把 observe 线从模型默认工具面移出（借 Serena 的 profile 思路：按 agent 裁剪），代码与 CLI 全留。
收益：工具面 62 → ~53，description token 直接省；零风险。**缺点：不解决"没人用"的根因。**

### B. 冻结 + 如实标注（最省事）
代码不动，README/文档标明"实验性、未验证价值"，不再投入维护。
零风险、零成本；但**维护面（20+ 测试）继续存在**，且下次有人翻到还会再问一遍。

### C. ★ 收敛为"验收执行器" + 归档展示类（推荐）
1. **保留并升级**：`instrument` + events + `behavior_baseline` + `run_tests` ⇒ 合成**一条默认的"改完就验"路径**
   （改 → 自动对拍/跑测试 → 结构化结果进返回），让它成为 refactor/`edit_code` 的**下一步**，而不是一条独立能力线。
   与 P1「修复→规则沉淀」天然接续：规则能复跑，就需要对拍来证明"这次改动没坏行为"。
2. **归档展示/叙事类**：`narrate_step` / `run_narrate` / `observe_chain_view` / `feature_line` / `export_incident`
   → **移出模型工具面**（CLI-only 或按需开启）。理由：**"给人看的分镜/看板"本来就是我们画布该干的事**，
   不该占模型的工具预算。
3. **给这条线一个判据**（对齐能力库 L0~L4）：设 30 天观察窗——若"改完就验"路径仍 0 采纳且无 holdout 通过，
   则按 B 冻结。**没有判据的"留着看看"= 维护税。**

---

## 6. 待用户拍板

1. 选 A / B / C？（推荐 C）
2. 若选 C：展示/叙事类**移出模型面**后，是留 CLI 还是移进 `_from-downloads` 归档区？
3. 是否同意给这条线设"30 天判据"（到点按数据决定冻结）？
