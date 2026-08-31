# 工具收敛清单（Tool Convergence）

> 目标：把「MCP 工具 + CLI 命令」从「数量多、归类乱」收敛为「三层分层、入口清晰、可追溯」。
> 本文是一份**持续演进的规划文档**，收敛动作按阶段推进，每阶段结束都有可验收产物。

***

## 1. 现状与问题

- **MCP 工具**：约 46 个，是对外核心能力面，面向 LLM 会话。

- **CLI 工具**：数量远超 MCP，且**性质分裂**——既有与 MCP 一一对应的「业务对偶」入口，也有大量「工程/分发/构建」和「探针/验证/一次性诊断」脚本。

- **根因**：8 个能力域（design / query / refactor / observe / judge / edit / harvest / export）是早期按 MCP 工具定的。后续 CLI 大量增加，但这些 CLI 从未按「能力域 / 操作面 / 基建」分层登记，导致两个后果：

  1. 观感上「8 个域装不下、CLI 数量不对等」；
  2. 真实问题是「三类不同性质的工具混在一起，没有入口语义」。

> **结论：问题不是「8 个域太少」，而是从未分层定性。** 因此不扩 8 域，改为三层分层 + 对偶标注。

***

## 2. 三层分层框架

### 第一层 · LLM 能力域（给 MCP 工具）

产品功能面，8 域基本保留（可微调），只登记 **MCP 工具**。

| 能力域               | 含义               | 代表 MCP 工具                                                                                                                                |
| ----------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **design** 设计编辑   | 改设计/DSL/脚手架/渲染视图 | `get_dsl` `edit_dsl` `manage_feature` `render_dsl` `render_sandbox` `scaffold` `backfill_scaffold` `diff_views`                          |
| **query** 查询理解    | 读设计/读代码/搜索定位     | `import_project` `explore_code` `read_project_docs`                                                                                      |
| **refactor** 重构治理 | 重命名/装配/瘦身/管线     | `rename_symbol` `rename_file` `rename_many` `remove_dead_imports` `refactor_pipeline` `suggest_renames` `find_similar_names` `edit_code` |
| **observe** 观测质检  | 插桩/拍照/裁决/一致性     | `camera_log` `camera_judge` `camera_instrument` `chain_recon` `consistency_check` `reconcile_brick` `reconcile_effects`                  |
| **judge** 治理裁决    | 人审闭环/问题上抛        | `refactor_judge` `mark_canvas_notes_status` `decide_canvas_notes`                                                                        |
| **harvest** 逆向采集  | 从 URL/项目反向采集     | `harvest_from_url` `harvest_closure` `harvest_decisions` `extract_contracts` `search_bricks` `assemble_bricks` `slim_brick`              |
| **export** 交付导出   | 产出给人看的产物         | `narrate_step` `archive_node` `list_archive` `read_canvas_notes`                                                                         |
| **内务**（暂归入域外）     | 配置/网关管理          | `gateway_list_providers` `gateway_upsert_provider` `gateway_delete_provider` `gateway_stats`                                             |

> 说明：上表为初版归属，纯数据可再微调，不阻塞收敛。

### 第二层 · 操作面（给 CLI 对偶工具）

同一批能力，但暴露形态是「终端/脚本」。**不新增领域**，只标注「该 CLI 是哪个能力的操作面」。

| CLI 入口                               | 对应能力域              | 说明        |
| ------------------------------------ | ------------------ | --------- |
| `brickify_cli`                       | refactor / harvest | 积木装配的终端形态 |
| `capability_cli`                     | query              | 能力矩阵自检    |
| `diagnose_cli` / `diagnose_loop_cli` | judge              | 诊断闭环终端形态  |
| `refactor_judge_cli`                 | judge              | 重构裁决终端形态  |
| `signal_review_cli`                  | judge              | 信号审批终端形态  |
| `split_stage_cli`                    | refactor           | 拆分阶段终端形态  |
| `deprecate_offline_cli`              | refactor           | 下线遗留终端形态  |
| `camera / instrument_cli`            | observe            | 插桩终终端形态   |

### 第三层 · 工程基建（不属于产品能力）

**一律不进 8 域**，独立成「开发/分发」分组。

- **分发/安装**：`install_mcp.mjs` `install_global_skill.mjs` `promote_design_canvas_mcp.mjs` `setup.mjs` `doctor` `hub.mjs`

- **构建/生成**：`rebuild_feature.mjs` `gen_anim_core_bundle.mjs` `gen_teach.cjs` `rebuild_teach.cjs`

- **探针/验证/一次性诊断**（内部质量基建，多为 dev 自检）：`probe_*.mjs` `sim_gap.mjs` `sim_l4.mjs` `agent_notes_loop.mjs` `backfill_stepflow.mjs` `dogfood/*.mjs` `_api_verify.mjs` `_regen_verify.mjs`

***

## 3. 收敛候选（按「名称相似 + 职责重叠」初筛）

> 原则：**先定性后合并**，避免伤到对外契约。每个候选都标「收益 / 风险」。

### A. 命名/职责明显重叠，可合并

| 候选组                                             | 现状     | 建议                         | 收益    | 风险     |
| ----------------------------------------------- | ------ | -------------------------- | ----- | ------ |
| `rename_symbol` / `rename_file` / `rename_many` | 三段切分   | 抽公共 `rename` 内核，3 入口收敛为参数化 | 心智负担↓ | 需保契约不变 |
| `suggest_renames` / `find_similar_names`        | 两工具重叠高 | 合并语义，输出统一                  | 减少重复  | 中      |
| `camera_log` / `chain_recon`                    | 观测两件套  | 统一 `camera_*` 前缀语义，明确分工    | 命名一致  | 低      |

### B. 疑似重复，需审计后取舍

| 候选组                                        | 现状     | 待确认                 |
| ------------------------------------------ | ------ | ------------------- |
| `render_dsl` vs `render_sandbox`           | 双渲染    | 是否职责重叠？能否参数化合一      |
| `read_canvas_notes` vs `harvest_decisions` | 都读决策材料 | 语料范围是否一致            |
| `gateway_*`(4个)                            | 网关配置   | 是否值得收敛为 1 个入口 + 子操作 |

### C. CLI 形态收敛

| 候选                      | 建议                                 |
| ----------------------- | ---------------------------------- |
| `*_cli.ts`(8个，通通后缀 cli) | 统一为「能力域 + 子命令」命名，CLI 命令与能力域名对齐     |
| 探针脚本(10+)               | 归入 `tests/` 或 `dogfood/`,退出仓库根命名空间 |

***

## 4. 合并前核验（硬性纪律，每次合并强制走完）

> **规矩**：任何一次合并**动手改代码前**，先逐项核验待合并的工具是否和设想一致。**核验不过不动手。**

每一步核验对应的问题：

1. **读源实现** —— 合并双方 handler 源码是否职责真实重叠？还是只是名字像、做的其实是两回事？
2. **对契约** —— 两个工具 inputSchema 是否有公共可抽象参数；对外工具名/参数一变，MCP 会话里的调用方契约就断，破坏面多大？
3. **找调用方** —— `grep` 哪些地方引用了这俩工具/模块（其他工具 import、测试、CLI 对偶、README / skill 文档 / `docs/tool-convergence.md` 自身）？避免漏改。
4. **查测试** —— 现有回归测试覆盖了两个工具的哪些行为？合并后哪些测试要跟着改？
5. **跑回归 + 插桩验收** —— 合并后跑全量回归；关键路径留可观测产物（插桩/日志），确认真实行为对得上。**验收通过才提交，否则回滚。**

> 核验结论记入本文件"合并记录"（第 7 节），每个候选一条：核验到哪一步、发现什么、怎么处理。

***

## 5. 分阶段推进（每阶段有可验收产物）

- **Phase 0 · 定性登记**（本文即产物）：三层框架落地，全部 MCP+CLI 归入三层 → 验收文档。

- **Phase 1 · 高确定合并**：A 组无风险合并（rename 内核、camera 前缀统一）→ 验收 diff + 回归全绿。

- **Phase 2 · 审计后取舍**：B 组逐项审计 → 每项一个小验收说明。

- **Phase 3 · CLI 命名归一**：C 组 → CLI `--help` 输出核对。

> 每个 Phase 改前需 Git 提交，改后跑全部回归测试，验收通过再提交，否则回滚。

***

## 6. 待办 / 开放问题

- [ ] 确认 B 组三处疑似重复的审计结论

- [ ] 确认 `gateway_*` 是否收敛为单入口

- [ ] 决定 `docs/` 入库范围（本文+tool-convergence 之外的 dev 稿是否也入库）

- [ ] CLI 命令命名规范（能力域前缀）是否与现有命名完全对齐

***

## 7. 合并记录

> 每次合并按「4. 合并前核验」走完五步后，在此记录一条：候选组、核验到哪一步、发现什么、怎么处理、验收结果。
>
> 格式示例：
>
> ```
> - [x] 候选组：`foo` / `bar`
>   - 核验：读源实现 ✓ / 对契约 ✓ / 找调用方 ✓ / 查测试 ✓ / 回归+插桩 ✓
>   - 发现：……
>   - 处理：……
>   - 结果：合并提交 `<hash>`，回归 `n` 无回归
> ```

