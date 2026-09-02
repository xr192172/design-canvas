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

### 0. 渐进式披露（MCP 工具对外组织原则，路径 B）

> **原则**：MCP 协议 `listTools` 是扁平数组，无原生分层。渐进披露靠「**入口聚合 + action 分派**」模拟层级——先暴露入口（"我能对什么操作"），进入后才面对子操作。
>
> 判定口径：**按「操作对象」聚合，不按「实现机制」**。同一操作对象、动作互补的一组工具 → 收敛为 1 个入口 + action 枚举。
>
> - 已落地样板：`gateway_provider`（list/upsert/delete/stats）、`canvas_notes`（read/mark/decide）、`manage_feature`（create/clone/template/list/delete）。
>
> - 反面教训：`camera_*`（instrument/judge/log/chain\_recon）**不聚合**——看似同对象，实为不同抽象层（基础动作/判定/查询/编排），且被 `mcp_tools.test` 显式锚定，强行合并违背契约。

### 第一层 · LLM 能力域（给 MCP 工具）

产品功能面，8 域基本保留（可微调），只登记 **MCP 工具**。

| 能力域               | 含义               | 代表 MCP 工具                                                                                                                                |
| ----------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **design** 设计编辑   | 改设计/DSL/脚手架/渲染视图 | `get_dsl` `edit_dsl` `manage_feature` `render_design` `render_brickwork` `scaffold` `backfill_scaffold` `diff_views`                     |
| **query** 查询理解    | 读设计/读代码/搜索定位     | `import_project` `explore_code` `read_project_docs`                                                                                      |
| **refactor** 重构治理 | 重命名/装配/瘦身/管线     | `rename_symbol` `rename_file` `rename_many` `remove_dead_imports` `refactor_pipeline` `suggest_renames` `find_similar_names` `edit_code` |
| **observe** 观测质检  | 插桩/拍照/裁决/一致性     | `camera_log` `camera_judge` `camera_instrument` `chain_recon` `consistency_check` `reconcile_brick` `reconcile_effects`                  |
| **judge** 治理裁决    | 人审闭环/问题上抛        | `refactor_judge` `canvas_notes`(decide/mark)                                                                                             |
| **harvest** 逆向采集  | 从 URL/项目反向采集     | `harvest_from_url` `harvest_closure` `harvest_decisions` `extract_contracts` `search_bricks` `assemble_bricks` `slim_brick`              |
| **export** 交付导出   | 产出给人看的产物         | `narrate_step` `archive_node` `list_archive` `canvas_notes`(read)                                                                        |
| **内务**（暂归入域外）     | 配置/网关管理          | `gateway_provider`(list/upsert/delete/stats)                                                                                             |

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

### A. 命名似乎重叠 → Phase 1 已逐项核验（结论：全部不合并，详见第 7 节）

> ✅ 2026-08 核验完成：A 组三项**均是『名字像、职责不同』，判不合并**——当初的收敛设想被源实现证伪，避免无效甚至有害的合并。

| 候选组                                             | 核验结论                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `rename_symbol` / `rename_file` / `rename_many` | **不合并**。三种底层机制：单文件作用域折叠(ast\_rename) vs 跨文件符号引用图(rename\_symbol) vs 文件系统迁移+全仓 import 改写(rename\_file)。抽公共内核纯属糅合。 |
| `suggest_renames` / `find_similar_names`        | **不合并**。两种互补视角：无意义短名 vs 易混淆孪生名。两者都输出可喂 `rename_many` 的数据，是上下游配合。                                                 |
| `camera_log` / `chain_recon`                    | **不合并**。纯事件查询 vs 中观对账编排聚合。前缀统一是命名风格而非代码合并，收益有限。                                                                  |

> 从 A 组的教训看：**"名称相似"不等于"职责重叠"，收敛必须以源实现核验为准。**

### B. 疑似重复 → Phase 1 已逐项核验（详见第 7 节）

| 候选组                                        | 核验结论                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `render_dsl` vs `render_sandbox`           | **不合并**。render\_dsl=读 DSL 渲染设计稿(mindmap/html/svg/md)；render\_sandbox=扫描工程生成依赖驱动积木工作台(不读 DSL)。职能正交。 |
| `read_canvas_notes` vs `harvest_decisions` | **不合并**。画布批注工单 vs 仓库材料挖决策卡。数据源/产物都不同。                                                              |
| `gateway_*(4个)`                            | **✅ 已合并** → 收敛为单入口 `gateway_provider`（action=list/upsert/delete/stats）。唯一真实可合并项。                   |

### B2. 渐进披露（路径 B）入口聚合 — 画布批注 3→1

> 依据「2.0 渐进式披露」原则：按**操作对象**聚合。画布批注（read/mark/decide）是同一对象、动作互补，收敛为 `canvas_notes` 单入口。

| 旧工具                        | 新入口            | action   |
| -------------------------- | -------------- | -------- |
| `read_canvas_notes`        | `canvas_notes` | `read`   |
| `mark_canvas_notes_status` | `canvas_notes` | `mark`   |
| `decide_canvas_notes`      | `canvas_notes` | `decide` |

> 核验要点（详见第 7 节）：无测试锚定旧名；底层函数(derive\_mind\_map/llm\_decider)仍被 server/serve 复用 → 只动 MCP 外壳；同步更新了探针(agent\_notes\_loop/probe\_mcp\_smoke) + README×2 + 文档。

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

## 5.5 命名审计（起名 vs 实际功能）

> 逐个核验工具名与真实职能是否匹配。**结论：大部分隐喻自洽；camera 已全量子系统改名完成；render/harvest 存在新的命名摩擦（待定）。**

### ✅ 已完成的改名（2026-08，commit d7e4953）

- **camera → observe**：全量子系统改名（目录 src/camera→observe、工具 camera\_*→observe\_*、事件路径 .agent/camera→.agent/observe、go-camera→go-observe、env CAMERA\_*→OBSERVE\_*）。消除了 camera/probe/instrument/observe 命名通胀。

- **chain\_recon → reconcile\_chain**：拼写统一（recon→reconcile）。

### 起名贴切（隐喻自洽 + 直白）

| 工具                   | 实际功能          | 评级   |
| -------------------- | ------------- | ---- |
| `harvest_*`（收割）      | 从项目收割可复用代码成积木 | ✅ 贴切 |
| `brick`（积木）          | 可复用代码模块拼装项目   | ✅ 贴切 |
| `scaffold`（脚手架）      | 从 DSL 生成代码骨架  | ✅ 贴切 |
| `narrate_step`（叙述）   | 把工序生成人读分镜     | ✅ 贴切 |
| `canvas_notes`（画布批注） | 画布上的批注工单      | ✅ 贴切 |
| `archive_node`（下线归档） | 把下线节点归档保存     | ✅ 贴切 |

### 起名有摩擦（待决定是否改）

| 工具                 | 实际功能         | 摩擦点                                                 | 评级                      |
| ------------------ | ------------ | --------------------------------------------------- | ----------------------- |
| `reconcile_*`（对账）  | 用运行时观测校准契约   | "对账"偏财务术语，实际是"用观测校准"                                | ⚠️ 轻微                   |
| `chain_recon`（链对账） | 声明链 vs 实测链对账 | 与 `reconcile_*` 同义不同拼（recon vs reconcile），**拼写不统一** | ⚠️ 已改名 reconcile\_chain |

### 新发现命名摩擦（待定，2026-08）

| 名称                                           | 实际功能                                                                         | 摩擦点                                                      | 评级    |
| -------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------- | ----- |
| **`render_dsl`** **vs** **`render_sandbox`** | render\_dsl=渲染 DSL 设计稿(mindmap/svg/md)；render\_sandbox=渲染工程依赖积木工作台(brickify) | **render 一词承担两种不相关职责**（设计稿渲染 vs 代码分析可视化），与 camera 命名通胀同型 | ⚠️ 中等 |
| **`harvest_*`** **vs** **`extract_*`**       | harvest=收割积木入盒；extract=抽取契约                                                  | harvest 与 extract 语义重叠（"采集/抽取"），边界不清                     | ⚠️ 轻微 |
| `explore_code`                               | 代码理解大入口（action 参数化）                                                          | 名符其实但过于宽泛                                                | ℹ️ 观察 |

> 候选方向（如决定处理）：`render_sandbox` → `render_brickwork`（按对象改名）；`extract_contracts` 明确为"契约抽取"语义与 harvest 区分。**均需评估后单独立项。**

### 待评估增强：符号-文件联动改名

> 用户提问："重构工具不联动文件名，是不是设计缺陷？"

**结论：不是缺陷，是刻意的职责分离**（rename\_symbol 改符号、rename\_file 改路径，"宁漏不误"）。改符号 ≠ 必须改文件名（`utils.ts` 导出 `foo`、`index.ts` 聚合是合法场景）。

**但存在真实体验缺口**：当用户确实想"改主符号 + 同步文件名 + 改所有 import"（如 `UserService.ts` 的类改名 `MemberService`），需**手动两步**（先 rename\_symbol 再 rename\_file），且无工具判断"该文件是否应跟着符号改名"。

**增强建议（待立项）**：给 `rename_symbol` 加 `rename_file_if_matching=true` 参数——当符号是文件主导出（文件名=符号名）时，自动联动 `rename_file`。**不改默认行为，纯增量。**

> ✅ **已实施（2026-08）**：`rename_symbol` 已支持 `rename_file_if_matching`（联动改名，失败不阻断，仅记录理由），配套测试覆盖"文件主导出改名/非主导出不改/缺省不改"三态。

## 5.6 工具被主动使用的障碍（真实开发自省，2026-08）

> 用户在真实开发中的自省："做开发时会不会想起来用这些 MCP 工具？" **诚实结论：大部分时候不会**。本会话两次大改名（camera→observe、render\_sandbox→render\_brickwork）最终都用脚本+grep+git mv 完成，MCP 工具仅用于 dry\_run 验证。

### 障碍清单（按根因）

| # | 障碍            | 说明                                                                    |
| - | ------------- | --------------------------------------------------------------------- |
| 1 | **任务语言不对齐**   | 思考是"改这个函数名"，工具名是 `rename_symbol`——无机制让 LLM 想起它们存在                     |
| 2 | **前置状态成本高**   | 大量工具要先 `import_project` 建 DSL/缓存、要 feature、要插桩才有意义。改个符号前要花好几步准备，成本>收益 |
| 3 | **粒度太细 + 黑盒** | `rename_file` 一次只改一个文件（70 文件改名=70 次调用）；返回仅文本，看不到结构化 diff → 不透明→不信任→不用 |
| 4 | **输出形态错位**    | 大量产出 HTML 路径/JSON/Markdown 报告；LLM 要的是"直接改好代码"，报告是负担                   |
| 5 | **运行状态依赖**    | STALE BUILD——改源码不重启 server 则跑旧代码，真实开发随时咬人                             |

### 会主动用的场景（诚实）

- **纯查询**：`get_dsl` / `explore_code` / `consistency_check`（低前置、只读、即时答案）

- **单点确定性操作**：`rename_symbol`（带联动改名后实用度↑）

- **差异化场景**：活文档同步、契约回填、运行时观测（observe）——写代码时不主动想，但项目健康需要

### 改进方向（1、2、3、4 已实施，闭包边界全部补齐）

> 说明：本小节被外部工具反复还原（多次），每次 commit 即固化；语义已在 c1d4f14→…→2e726a3 持续推进，此处为最新累积状态。

1. **消除前置状态** —— ✅ **已实施**：`rename_symbol` 的 `project_dir` 变可选，自动定位项目根（git 根→manifest→文件目录，嵌套 git 安全）并按依赖闭包扩展边界。实现于 `src/tools/project_root.ts`（`resolveProjectRoot`/`expandClosure`/`realResolveImport`/`loadAliasConfig`/`resolveAliasedImport`）。
2. **输出可直接消费** —— ✅ **已实施**：`rename_symbol` 返回结构化 diff（`ops: [{pos,len,old,new}]` 可重放验证），新增 `dry_run=true`。MCP handler 渲染每处 `old→new`。
3. **闭包 importer 方向** —— ✅ **已实施**：`findExternalImporters` 有界扫 seed 根直属兄弟项目/松散文件里引用 seed 的本地文件并纳入闭包（含各自别名、裸包 workspace 互引）。防御 `NEIGHBOR_LIMIT(20)` 短路。
4. **批量操作** —— ✅ **已实施**：新增 `rename_symbols` 跨文件符号批量改名。先全部 dry\_run 算结构化 diff，任一条被阻断→整体不落盘；全部可落盘才逐条落盘。

**跨语言 import 边（扩展点）**：AST import 提取由 `ts_kernel.parseFileFull` 通用完成（`LANGUAGES` 注册表覆盖 150+ 语言）；`resolveLangImport` 按扩展名分派到 `LANG_RESOLVERS`（已注册 `.go`/`.py`），未注册语言走 `resolveGenericLangImport` 通用兜底（分隔符→路径）。**加新语言 = 给** **`LANG_RESOLVERS`** **加一条** **`[ext]→resolver`** **映射，AST 层零改动。**

**引用查找** —— ✅ **已实施（2026-08）**：新增 `find_references` 工具——改/删一个符号前查"谁引用了它"，只读不落盘，复用 rename 闭包/引用图内核。已入 AGENTS.md 触发点表。

> **结构引用扩展 mode=field（2026-09，dogfood 驱动）**：默认 symbol 模式只报"谁 import 该符号名"，对"加字段/改签名"类改动会漏掉**定义文件内部的构造点与字段读取点**。新增 `mode=field`：扫项目内 `obj.<field>`（读取点）与 `<field>:`（构造点），**含定义文件内部**。教训：上一轮做安全改核心时 agent 反射性用了 grep——一半是触发失灵，一半暴露 find\_references 真缺口；补齐后"加字段前查波及"不必再退回 grep。
>
> **升级为 AST 分类 + type 模式（2026-09 v2）**：正则版把"构造/解构/声明"全算 field-key 且漏方括号/注释噪音。改复用 ts\_kernel tree-sitter（parseAstRoot，节点带字节偏移）：`mode=field` 把每个命中按所属节点分类为 **读/构/解/声明** 四类（member\_expression→读、object→构、object\_pattern→解、property\_signature/object\_type→声明），自动跳过注释/字符串同名，补 `obj['field']` 方括号读，附行内 snippet；`scope=closure(all)` 可选（给 file 默认按闭包）。新增 `mode=type`：从 interface/type 声明解成员字段集，找与成员交叠 ≥ min\_hit 的对象字面量候选构造点（启发式，非类型求解器）。新模块 `src/tools/field_refs.ts`。

> ⚠ **当前边界**：闭包沿「import 边 / 别名边 / 邻域 importer 边（含各自别名+裸包 workspace）/ 跨语言 import 边（Go 包·Python 同包·通用兜底）」扩展——importee、importer（同工作区兄弟）、`.go`/`.py`/通用兜底语言（Java·Rust·C# 等）依赖边均已覆盖。仍未覆盖：a) 跨 drive/homedir 外更大范围项目引用（防御性不扫）；b) 语言特化 resolver 之外的厂商私有路径约定（如 Python 多个 sys.path、Go replace 指令重定向）。另：引用查找 `find_references` 目前只认 TS 系 import（邻域/跨语言引用未覆盖，可复用 expandClosure 续坡）。

**活文档漂移（detect\_drift）** —— ✅ **已实施（2026-09）**：补齐「代码变更 → 提示 DSL 过时/欠实现」的闭环缺口。复用 `checkConsistency` 引擎，叠加：git 变更作用域（`scope=changed` 默认只看工作区改动 / `since_ref`；`scope=all` 全量）、过时判定（`unexpected/mismatched` → `design_stale`，`missing` → `missing_impl`）、持久化台账（`<storageRoot>/drift/<feature>.drift.json`，`mode=status` 复读）。只读不改 DSL；同步设计仍走 `edit_dsl`（带 reason+evidence 门禁）/ `import_project`。已入 AGENTS.md 触发点表。**后台 watcher 已接线**：watch\_project 新增 `drift_on_change`（经 explore\_code action=watch），以本次 fs 变更文件为作用域自动跑 detect\_drift，过时即 pushAlert + status 取 drift\_alert 台账。

> **watcher 二轮优化（2026-09）**：drift 独立于 rebuild（盯 drift 不必全量重建 live）；状态转换去重（仅「未过时→过时」pushAlert，stale 持续期不重复轰炸）。
>
> **✅ 已实现：drift 挂周期性 reconcile 兜底**（fs.watch 丢事件时，reconcile 定期全量扫盘兜补漏改，并对有变更的文件精确补判 drift）。原设想的障碍「`ReconcileSummary` 不暴露变更文件」已解决：`ReconcileSummary.changed_files` 由 `reconcileProject` 透出；`watch_project_tool` 的 `onReconcile` 在 reconcile 有实际变更时，按 `changed_files` 以 `scope='changed'` 补判 drift（`runDriftCheck`）；reconcile 由 `setInterval(reconcile_interval_ms)` 周期触发，另暴露 `reconcileNow()` 手动兜补。**注**：`watch_project_tool.test` 已补 reconcile→drift 兜底专用用例（`reconcile_interval_ms` 周期触发 + `waitUntil` 轮询 status，无真实 fs.watch 时序依赖，flaky-free）：设计声明 b 但代码缺 b → missing\_impl，断言 `has_drift=true` + `drift_alert` 有值 + `last_reconcile` 已记录。

***

## 草丛工具评估（2026-09）——零星工具文件「转正 or 归位」

- **结论：零转正，全部归为内部实现。**「草丛」并非孤儿工具，而是已注册工具的实现/派生引擎；
  其能力已被 `get_dsl`(query=features) / `edit_dsl` / `manage_feature` / `render_brickwork` /
  `import_project` / `overview` 覆盖，转正只会继续撑大 MCP 工具面，违背本仓库收敛方向。

- `list_features` / `query_feature` / `update_feature`：`get_dsl` / `edit_dsl` 的实现（注册名≠文件名），已在豁免表。

- `feature_ops`(createFeature) / `render_workbench` / `feature_map`(buildFeatureMap) /
  `derive_feature_tree`：manage\_feature / render\_brickwork / import\_project / overview 的内部派生、
  渲染助手，主函数名 ≠ 文件名 camelCase 或为 async，天然不触发漏注册检测；本次显式加入豁免表，
  让「内部模块」边界的意图文档化。

- **遗留命名重叠（2026-09 已收口）**：`render_dsl`→`render_design`（渲染设计稿）、`render_dsl_workbench`→`render_workbench`（契约投影工作台）、`render_sandbox_canvas`→`render_dep_canvas`（依赖图画布）均已成。render 前缀下对象各异：`render_design`/`render_brickwork`/`render_workbench`/`render_dep_canvas`/`render_cluster_workbench`，职责已清晰。

## 5.7 工具边界登记：`render_design` 改名 dogfood（2026-09）

> 愿景校验：工具的目的是重构屎山代码，那么「全仓改名」这类场景就该由工具自己覆盖，而不是退化到脚本+grep。本次用一次真实的对外工具改名把边界量出来。

### 场景与结果

对**对外 MCP 契约工具** `render_dsl()`→`render_design()` 做了全仓改名，波及 **37 个文件**。改动分层如下：

| 层                   | 涉及                                                                            | 工具能覆盖吗                                | 实际手段             |
| ------------------- | ----------------------------------------------------------------------------- | ------------------------------------- | ---------------- |
| **符号层**             | camelCase `renderDsl`（函数/import 命名、接口 `RenderDslInput` 等）                     | ✅ `rename_symbol`/`rename_symbols` 擅长 | rename 类工具（理想态）  |
| **文件层**             | `render_dsl.ts`→`render_design.ts` + 全仓 import 路径 `.js` 引用                    | ✅ `rename_file` 联动                    | git mv + 精确编辑    |
| **工具注册名**           | server\_registry `name: 'render_dsl'`                                         | ⚠️ 注册名是字符串字面量，rename 不认               | 精确编辑             |
| **user-facing 字符串** | 几十处「请先 render\_dsl」错误提示、`README`/`AGENTS`(生成)/`skill`/`CONTRIBUTING`/issue 模板 | ❌ **纯字符串，rename 工具完全碰不到**             | 逐文件 replace\_all |
| **文档/测试断言**         | `tool-convergence` 历史记录（应保留）、dogfood tool 名断言、describe 字符串                    | ❌ 字符串                                 | 精确甄别             |

### 结论：能力边界缺口

1. **`rename_*`** **只认 import + camCase 符号，不认 snake 字面量（工具注册名）与 user-facing 字符串**。这类跨文件字面量同步要逐个 replace\_all，正是 5.6 障碍 #4「粒度太细+黑盒」的原样重现。
2. **历史记录需要灰名单**：改名时 `docs/tool-convergence` 的历史核验/判定记录（如「render\_sandbox 曾判 render\_dsl 不合并」）必须保留原名还原语境，不能被无脑全局替换。这要求工具支持「按语义保留的原名白名单」。
3. **生成物源头优先**：`AGENTS.md` 里的工具名由 `gen_agents.mjs` TRIGGER\_ROWS 驱动，改工具名必须改源头而非生成物本身（生成物会被 build 自愈重建）。

### 改进建议 → 已落地（2026-09）

- ✅ **冻结行保护**：`rename_symbol`（TS/Go/Python）/`rename_file` 支持管理员自配 `.design-canvas.json` 的 `rename.protect` 规则（gitignore glob + 行 marker）；命中则整笔原子阻断，绝不改写冻结行，主体文件不套。使用见 `docs/rename-protection.md`。

- ✅ **字面量感知改名**：`rename_symbols report_literals=true` 扫描旧符号 snake 变体在项目文本的字面量命中，返回清单（只报告不改）。**闭环已补（2026-09）**：`apply_literals=true` 自动替换 decision=apply 的字面量（code/docs/test）为蛇形新名，并按 kind 分层——contract(注册名)需人审、history(历史记录)保留、冻结行(.design-canvas.json protect)跳过，均不写盘，决策明细随结果返回供复核。

- ✅ **生成物识别（源头优先，2026-09）**：`rename.generated`（.design-canvas.json，glob 列表）标记生成物文件（如 AGENTS.md——由 `gen_agents.mjs` 从 TRIGGER_ROWS 生成、构建自愈覆盖）。`rename_symbols apply_literals` 命中生成物 → `decision=generated`，不落盘并提示改源头而非生成物；通用机制（不硬编码本项目文件名），对任意有生成物的项目可用。

- ✅ **注册名白名单**：命中按 `kind` 分类——`server_registry` 的 `name:`→`contract`（对外契约，清单醒目标「破坏契约需人审」），tool-convergence/docs→`history`/`docs`（保留原貌）、tests→`test`、其余→`code`；agent 据清单区分「改 / 保留 / 契约谨慎」。

- ⏳ **契约变更纪律**：已写进 AGENTS「文档同步纪律（契约变更才跟）」；工具侧由 `contract` 命中的风险提示承载「需人审」的门槛，暂不自动落盘（避免误伤历史灰名单的语义判定）。

***

## 6. 待办 / 开放问题

- [x] 决定 `drift 挂周期性 reconcile 兜底` 是否做 —— ✅ **已实现（见 detect\_drift 记录）**：`ReconcileSummary.changed_files` 透出 + `onReconcile` 按变更文件以 `scope='changed'` 精确补判 drift。

- [x] 决定 `render_dsl`/`render_sandbox` 的 render 一词职责拆分是否处理 —— ✅ **已成（2026-09）**：`render_dsl`→`render_design`（渲染设计稿）、`render_sandbox`(现 `render_brickwork`) 早成 `render_brickwork`。render 前缀下对象各异：`render_design`/`render_brickwork`/`render_workbench`/`render_dep_canvas`/`render_cluster_workbench`，职责清晰。

- [ ] 决定 `harvest_*` vs `extract_*` 语义边界是否明确

- [ ] 评估 `rename_symbol` 增加 `rename_file_if_matching` 联动改名的可行性

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

***

#### Phase 1 · A 组核验记录（2026-08）

- [x] 候选组：`rename_symbol` / `rename_file` / `rename_many`
  - 核验：读源实现 ✓（未达合并标准，账停于第 1 步）

  - 发现：三种底层机制完全不同——`renameMany`(ast\_rename.ts) 单文件作用域折叠；`renameSymbol`(rename\_symbol.ts) 跨文件符号引用图；`renameFile`(rename\_file.ts) 文件系统迁移 + 全仓 import/require 字面量改写。仅共享"改名字"语义外壳。

  - 处理：判**不合并**。抽公共内核=强制糅合三种不相关实现，制造参数开关反噬心智。

  - 结果：不改代码。已覆盖全量回归基线，无回归风险。

- [x] 候选组：`suggest_renames` / `find_similar_names`
  - 核验：读源实现 ✓

  - 发现：互补而非重复——前者面向"无意义/短名"，后者面向"易混淆孪生名"（大小写/数字后缀/换位）。两者都输出 `items` 供 `rename_many` 使用，是上下游配合关系。

  - 处理：判**不合并**。

  - 结果：不改代码。

- [x] 候选组：`camera_log` / `chain_recon`
  - 核验：读源实现 ✓

  - 发现：`camera_log`=纯事件查询（按文件过滤读 events.jsonl）；`chain_recon`=中观对账编排（派生链→过滤事件→判定偏差→链路契约匹配）。后者内部用到前者的读取能力，是编排聚合。

  - 处理：判**不合并**。`camera_*` 前缀统一属命名风格，非代码合并，收益有限。

  - 结果：不改代码。

> **Phase 1 结论：A 组无有效合并项。收敛价值转回 B/C 组（待下轮核验）。**

#### Phase 1 · B 组核验记录（2026-08）

- [x] 候选组：`render_dsl` / `render_sandbox`
  - 核验：读源实现 ✓

  - 发现：render\_dsl 读 DSL 渲染设计稿(mindmap/html/svg/markdown，用 feature 从存储读)；render\_sandbox 扫描工程生成依赖驱动积木化工作台(brickify，不读 DSL 读依赖图)。输入(feature vs project\_dir)、产物、handler 完全独立。

  - 处理：判**不合并**。

  - 结果：不改代码。

- [x] 候选组：`read_canvas_notes` / `harvest_decisions`
  - 核验：读源实现 ✓

  - 发现：read\_canvas\_notes 读**画布批注**(DSL.canvas\_notes)翻译成 agent 工单，配合 mark/decide 闭环；harvest\_decisions 从**项目文档/git log/注释**挖 draft 决策卡。数据源(docs vs 批注)、产物(工单 vs 决策卡)都不同。

  - 处理：判**不合并**。

  - 结果：不改代码。

- [x] 候选组：`gateway_list_providers` / `gateway_upsert_provider` / `gateway_delete_provider` / `gateway_stats`
  - 核验：读源实现 ✓ / 对契约 ✓ / 找调用方 ✓ / 查测试 ✓ / 回归+插桩 ✓

  - 发现：4 工具是同一实体(LLM 供应商 Key 池)的标准 CRUD+stats，底层纯函数(upsertProvider/listProvidersMasked/deleteProvider/getStats)已分离清晰。无业务调用方(仅 README×2 + 文档引用)；gateway.test.ts 只测底层纯函数不测外壳。

  - 处理：**合并**为单入口 `gateway_provider`（action=list/upsert/delete/stats 分派），对齐 `manage_feature` 的 CRUD action 先例。

  - 结果：tsc 通过；gateway 专项 28 测试全绿；**全量回归 1340/1340 无回归**；临时 DESIGN\_CANVAS\_HOME 隔离验收脚本实测 4 分支全通过(upsert→list→delete→stats)。提交 `e332888`。

> **Phase 1 小结：A 组 0 合并（全核验证伪）、B 组 1 合并（gateway 4→1）。**

#### 渐进披露 · 画布批注入口聚合（2026-08，路径 B 首个按对象聚合）

- [x] 候选组：`read_canvas_notes` / `mark_canvas_notes_status` / `decide_canvas_notes`
  - 核验：读源实现 ✓ / 对契约 ✓ / 找调用方 ✓ / 查测试 ✓ / 回归+插桩 ✓

  - 发现：三工具是**同一操作对象（画布批注/DSL.canvas\_notes）、动作互补（读/改状态/LLM 决策）**；无测试锚定旧名（grep tests 无引用）；底层纯函数(renderCanvasNotesDigest/markCanvasNotesStatus/decideCanvasNotes)仍被 server.ts/serve.ts HTTP 侧复用 → 只改 MCP 外壳安全。

  - 处理：**合并**为 `canvas_notes` 单入口（action=read|mark|decide），对齐渐进披露路径 B。

  - 结果：tsc 通过；**全量回归 1340/1340 无回归**；隔离验收脚本验证注册 + schema(action 字段) + read 分支可调不崩。并同步更新引用方：`agent_notes_loop.mjs`（4 处 tools/call + 3 处注册检查）、`probe_mcp_smoke.mjs`（1 处）、README×2、`docs/tool-convergence.md` 能力域表。

> **渐进披露小结：已落地 2 个入口样板 ——** **`gateway_provider`(4→1)、`canvas_notes`(3→1)、`manage_feature`(既有 CRUD action 先例)。**

