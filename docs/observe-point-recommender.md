# 观测点推荐器（observe-point-recommender）设计

> 2026-09-14 ｜ 起因：用户提问「**不做全量插装，而是先用解析出来的 AST 找到推荐的插装点，
> 只在推荐点上插装**，可以吗？等于一套"自动判断在哪打日志 + 收集 + 整理"的系统，
> 通过 AST 语义化来推荐与整理；实在不行是否要内置 LLM？」
>
> 结论先行：**可以，而且这条路只剩最后一块——"推荐器"。**
> 采集、选择性插桩、分级、台账、一键还原、事件端口**全都已经实现了**。
> 本文只设计缺的那一块，并划清 LLM 的边界。

---

## 1. ★ 体检结论：现有资产已覆盖 5/6，只缺"谁来自动生成清单"

| 环节 | 现状 | 位置 |
|---|---|---|
| **采集（事件端口）** | ✅ **已实现**：零侵入探针（未配 sink 时 no-op）、全局 sink（`globalThis`，解决多模块实例）/ `AsyncLocalStorage` 作用域、产出 `events.jsonl`（对齐 `schema/observe_contract.schema.json`） | `src/observe/probe.ts` |
| **选择性插桩** | ✅ **已实现**：`InstrumentOptions.contractProbes?: string[]` —— **非 undefined 时只注入清单里的点**（`matchContract` 精确匹配 `<mod>.<fn>.<suffix>` + 模块级过滤）；**undefined 才全量**，注释原文就叫「**探索模式**」 | `src/observe/instrument.ts` |
| **分级** | ✅ `ProbeLevel = core | event | deep`，`deep` 默认关（"事件量很大，按需放大"） | 同上 |
| **台账** | ✅ `ProbeLedger`：`buildProbeLedger` / `saveProbeLedger` / `loadProbeLedger` / `clearProbeLedger` / `ledgerSummary`（`N 探针点 · M 文件 · perKind · perLevel`） | 同上 |
| **一键还原** | ✅ `restoreInstrumented(root)` + 写盘前备份到 `.design-canvas/observe-backup/` | 同上 |
| **★ 推荐器（谁产出 contractProbes）** | ❌ **缺** —— 今天是**人工写清单**或**全量兜底** | **本文设计** |

⇒ 所以用户的方案不是"另起一套"，而是**给已有的 `contractProbes` 装一个自动产出的脑子**。

---

## 2. 三层数据流

```
① 推荐（新）         AST 语义 + 索引图  →  推荐点清单 [{key, level, score, reasons[]}]
                       ↑ 可人工覆盖/追加（清单是资产，可 review / diff / 复用）
② 插装（已有）       contractProbes = 清单里的 key  →  只插这些点（含文件级筛）
                       ↑ 插桩前自动 file_snapshot（刚落地的能力）→ 改坏也能一键撤回
③ 采集+整理（半有）  events.jsonl（已有） → 按观测点/调用链/变更点聚合 → 因果叙述
                       （judge / chain / tiered 已有雏形，但**从未被采纳**）
```

---

## 3. 推荐信号表（★ 全部来自已有资产，不必新造）

| 信号 | 来源（已有） | 为什么这类点值得观测 |
|---|---|---|
| **功能入口** | `feature_line`（功能→入口→调用节点主链） | 一个功能的主链头；跑一次就是从它进，观测收益最大 |
| **高被引用度**（in-degree / 被多少文件 import+调用） | 索引 `edges(kind='call'/'import')` + `impact_analysis` | 被调多 = 影响面广，出错是乘数级 |
| **边界/副作用点**（写盘、网络、子进程） | `instrument.ts` 的 `IO_CALLS` 表 + `extract_contracts` 的 `writes/holds/emits` | 副作用是"唯一能改坏外部世界"的地方 |
| **静默吞错**（空 catch / catch 不 rethrow） | AST catch 分支（event 级点已覆盖） | 吞错是事故最隐蔽的来源 |
| **契约缺口/漂移** | `detect_drift`（`design_stale`/`missing_impl`）、`reconcile_effects` | 声明与实测不符处，最需要实测 |
| **复杂度高地** | `code_health`（AST 分支节点计数圈复杂度） | 复杂函数是 bug 密度高地 |
| **最近改动/热点** | git 变更集（`diff_impact` 的 changed）、`detect_drift scope=changed` | 让预算跟着"正在动的地方"走（动态优先级） |
| **纯函数/转换核心** | 索引 symbol kind + 调用边 + `classify_bricks`（积木/契约/胶水） | 纯函数最好对拍 → `behavior_baseline` 的天然对象 |
| **状态载体** | AST 顶层 `let/var` + 赋值点 | 状态漂移是"难复现 bug"的根源 |

**输出**：可编辑清单 `observe-points.json`（人可增删/改 level），字段与 `contractProbes` 完全对齐：

```json
{ "points": [
  { "key": "spill.maxInlineBytes.replaced", "level": "core", "score": 0.92,
    "reasons": ["边界副作用(写盘)", "高被引用(12 处 import)", "最近改动过"] }
] }
```

**预算纪律（对齐 D 的第③条）**：`maxPoints`（按项目规模给默认值）；
超预算**按 score 截断并如实列出被截断的 N 个及原因** —— **不静默裁**，也不发明第二套存储策略。

---

## 4. LLM 的边界（回答"要不要内置 LLM"）

### ❌ 默认**不**让 LLM 决定"插哪里"

三条硬理由：
1. **不可复现**：两次给的清单不同 → **事件结构漂移** → A/B 无法对比（而观测的全部价值就在可比）。
2. **信息不占优**：能被图算出来的（in-degree / 副作用 / 复杂度 / 变更）**图算得更准更便宜**。
3. **成本**：每次改代码都要重推一遍。

### ✅ LLM 只在三个**可关、可回退、产出必须落盘**的入口用

| 入口 | 用法 | 开关 |
|---|---|---|
| **① tie-break 重排** | 规则分接近、无法区分时，对**候选列表**做重排（只动顺序，不新增点） | 可关；关掉退回规则排序 |
| **② 探索模式（真正的 LLM 场景）** | 当**你还不知道观测点在哪**时：给"现象/失败描述 + 相关文件"，让 LLM **反推候选观测点**，产出的清单**只用于下一次推荐**，不长期保留 | 默认关 |
| **③ 整理/叙述** | 把结构化日志（`events.jsonl` + `measurement`）翻成**因果叙述与根因假设** —— 这才是 LLM 最该干、也最划算的地方 | 可关；关掉仍有结构化聚合 |

**★ 一条铁律**：**LLM 的产出必须落成"清单资产"**（可 review、可 diff、可复用、可回滚），
且**关掉 LLM 后系统仍能跑**（规则结果独立成立）。理由与项目既有一致：**判据不能由被判定者自证**、
**危险的不是能力而是不可撤回**。

---

## 5. 必须配套：锚点漂移与"未命中报告"

- **做对的地方**：`contractProbes` 的 key 是 **`<mod>.<fn>.<suffix>`（符号身份）**，不是行号 —— 与
  "别用行号编辑"同一课，天然抗格式变动。
- **仍需配套**：符号**改名/移动**后 key 会失配 ⇒ 插桩时必须**报告未命中清单**：
  「清单里 5 个点没匹配上（疑似已改名/删除）→ 建议重新推荐」。
  扩展点：`ledgerSummary` 已经统计 `perKind/perLevel`，加一个 `unmatched: string[]` 即可。
  **没有这条，清单会悄悄腐烂**（而清单是资产，腐烂了就等于没有）。

---

## 6. 与既有设计/新能力的整合

| 能力 | 整合方式 |
|---|---|
| `file_snapshot`（今天刚落地的"可撤回"） | **插桩改写源码前自动快照** ⇒ 插桩改坏也能一键回滚（插桩是"改源码"这一最大副作用的对治） |
| 方案 D（语义观测点 + 采集前判定 + 预算） | **推荐器的输出就是 D 的"声明观测点"**；人工声明 = 覆盖/追加（`observe-points.json` 可手改） |
| P1「修复→规则沉淀」 | 同构：都是"把一次性动作沉淀成可复跑的资产"（那里是修复规则，这里是观测点清单） |
| 能力库（capability-registry） | 观测点清单可作为 `kind: observe-points` 的资产登记，带 acceptance（能否跑赢手写） |

---

## 7. 最小可验证用例（判据可执行，不靠感觉）

**目标**：用推荐器覆盖用户**当初的真实动机** —— 观测"上下文管理系统到底经历了什么"
（折叠细节 + 缓存命中率影响因素）。

**步骤**：
1. 以 `D:\project_develop\dsh-brain` 为 `project_dir`（压缩/缓存真身所在：`packages/conveyor-context`、
   `spill-policy`、cache 相关）跑推荐器，产出 `observe-points.json`。
2. **对照人工清单**：让熟悉该系统的作者手写"我真正想看的点"（≈10 个）作为 holdout。
3. **判据 L2**：规则推荐**命中人工清单 ≥ 80%** ⇒ 成立；< 80% ⇒ 再上 LLM 增强（tie-break/探索）后重测。
4. **判据 L4**：在推荐点上插桩，跑两轮 A/B，产出"折叠细节 + 命中率影响因素"报告，
   与现有 `cache-ab-experiment-log.md`/`context-cache-efficiency-measurement.md` 对比：
   **报告更好 ⇒ D+推荐器成立；不更好 ⇒ 承认"手写已足够"，按 B 冻结这条线。**

> 这条用例同时回答了两个悬而未决的问题：观测线该不该留、以及推荐器该不该做。

---

## 8. 待用户拍板

1. 接受"**只做推荐器 + 复用已有插桩/台账/还原**"这个范围吗？（不重写 observe 线）
2. `observe-points.json` 的落点：项目根 `.design-canvas/`？还是并入 `.design-canvas.json`？
3. LLM 三个入口默认**全关**、按需开，同意吗？
4. 是否先做 §7 那个最小用例（对 dsh-brain 跑一遍推荐器 + 人工 holdout 对照）？
