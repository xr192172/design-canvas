# Camera 狗食开发进度

> 用途：跨会话交接检查点。每做完一步就更新本文件，下次接管先读这里，勿重做。
> 背景：先写 Camera 设计 DSL，再按设计 DSL 开发并做狗食（用 design-canvas 工具链验证），发掘并修复工具 bug。

## ✅ 阶段0：设计 DSL（已完成并验证）
- 用 `manage_feature create` 建 feature `camera`，`edit_dsl` 批量写入：
  - 14 节点（11 主流程 + 2 error 层判定装配子节点 rulepred/llm + contract/cli/main 三个文件节点）
  - 14 边（主流程链路 + error 层复核环 + CLI 分发）
  - 9 语义文件（绑定到同 id 几何节点）
- 渲染产物：`output/camera_design.html`、`output/camera_design.md`
- E2E 验证（临时 project-root，seed→show→actual→diff）：4 事件正确识别 2 违反 + 2 良性
- Go 测试 25 个全通过

## 🐛 狗食发现的工具 bug / 约束（待修或已规避）

### 1. anchor_broken 硬约束（已规避，非 bug）
- `semantic.files.id` 必须锚定到同名 `geometry` 节点，否则 `render_dsl` 校验失败。
- 正确处理：文件节点 id = 几何节点 id（把文件绑定到模块节点，或为文件补几何节点）。

### 2. render_dsl 相对 output_path 落错位置（轻微）
- 相对路径 `output/xxx.html` 会落到 `C:\Users\Admin\output`（server cwd），非项目目录。
- 规避：必须传绝对路径 `d:/project_develop/design-canvas/output/xxx.html`。

### 3. 设计↔实际对比的路径基底不一致（已修复）
- 设计 DSL 文件路径原用仓库相对 `go-camera/internal/probe/probe.go`；
- live 导入用 `project_dir=go-camera`，路径为 `internal/probe/probe.go`，少了 `go-camera/` 前缀。
- 后果：design⇄live 按路径对齐失效。
- **修复（方案一：设计对齐 live）**：camera 设计 DSL（`.design-canvas/features/camera.json` + 活态 `design-canvas.json`）的 9 个 `file.path` 去掉 `go-camera/` 前缀，统一为项目相对根（与 live 导入一致）。验证：临时根导入 go-camera 后，设计 9/9 路径精确命中 live DSL。未来"每个项目解析记录"时路径即项目相对标识，项目名元数据按需再加。

### 4. live_only 导入新 feature 不进设计注册表（真实 bug，已修复）
- `import_project(live_only=true, feature=新名)` 只在 live 存储，`get_dsl query=diff` 与 features 列表都找不到它。
- 正确意图：应导入到**已存在 feature 名**填充其 live 视图（🎭设计/⚡实际切换），而非开新 feature。
- **修复（bug #4）**：`diff_features` 增加 `view_a/view_b` 视图参数，改用 `getDSLByView` 读取；`get_dsl query=diff` 支持 `view_b=live`，从而能对比「设计 degine vs 实际 live-only」快照。回归测试：`tests/tools/diff_features.test.ts`。

### 5. manage_feature delete 对 live-only feature 抛 JS 错误（真实 bug，已修复）
- `manage_feature delete camera_live` 报 `Cannot read properties of undefined (reading 'feature')`。
- **根因**：`str()/req()` 直接访问 `args[k]`，args 为 undefined 时抛 TypeError。
- **修复（bug #5）**：`manageFeature` 对 `args` 兜底为空对象 `args = input.args ?? {}`，缺参时改抛清晰错误。回归测试：`tests/tools/manage_feature.test.ts`。

## ✅ 阶段P3：修订提案 + 验证门审批（写盘权分离，已完成并验证）
- **原则**：提案权与写盘权分离。修订提案驻留 `{dataDir}/proposals/`，只描述"想把设计 DSL 改成什么"，绝不触碰权威 `dsl.json`；LLM 无直接写盘通道，只能产提案。
- **验证门审批**：只有 `approve` 通过后，才借 `DesignDSLStore.Save` 定稿为新版本并入审计历史（快照式，可回滚）。校验 rule/expect 必填、声明集非空，防畸形契约污染权威真相源。
- **新增**：
  - `internal/probe/proposal.go`：`Proposal`/`ProposalStore`（Create/Get/List/Approve/Reject），状态 pending→approved/rejected。
  - `internal/probe/proposal_test.go`：6 个用例（propose 不触碰 dsl.json、approve 定稿新版本+状态翻转、非 pending 拒绝审批、reject、按创建序 list、空/畸形声明被验证门拒绝）。
  - `internal/probe/dsl_cli.go`：新增 `propose`/`proposals`/`approve`/`reject` 子命令。
- **修复**：提案 ID 用 `UnixNano` 在 Windows 时钟粒度粗时同纳秒重复导致第二个提案覆盖第一个 → 加随机后缀 `proposal-<ns>-<4hex>`。
- **E2E CLI 验证（临时根）**：`seed`(v1,1声明) → `propose`(2声明,pending) → `approve` → `show`(v2,2声明) → `history`(v1 seed + v2 llm-revise) → `proposals`(approved)。全链路通过。
- Go 测试全量通过。

## ✅ 阶段P4：循环+触发（观测→偏差→未声明探针自动提案，已完成并验证）
- **闭环**：探针落盘观测（events.jsonl）→ 聚合画像（actual）→ 与权威 DSL 对比三类偏差 → 对「未声明」探针自动生成修订提案（`design:observe-<probe>`，契约描述源自观测事实）。
- **触发**：每次 `camera-dsl loop <events.jsonl>` 即一次闭环迭代，可被外部定时/事件（watch/cron）触发持续校准。
- **写盘权仍分离**：闭环只负责「发现并提议」，只写 proposals/，绝不触碰 dsl.json；定稿权永远在验证门审批（approve）。
- **新增**：
  - `internal/probe/loop.go`：`RunLoop`（读观测→聚合→对比→未声明探针自动提案）+ `sanitizeRuleSuffix`（探针名→合法 rule 后缀）。
  - `dsl_cli.go`：新增 `loop` 子命令。
  - `loop_test.go`：4 个用例（未声明探针产 2 提案、loop 不触碰 dsl.json、全局声明覆盖下不产提案、rule 后缀净化）。
- **E2E CLI 验证（临时根）**：seed→propose(特定探针)→approve→loop 报告正确（未观测 save.writefile）→show 权威未变。全链路通过。
- Go 测试全量通过。

## ✅ TS 跨语言契约试点（已完成并验证）
- **目标**：验证 schema 清单「TS 探针埋点产出的事件能被 Go 装配层正确判定」，证明 Camera 契约语言无关。
- **新增**：
  - `src/camera/probe.ts`：TS 探针端口（`TSProbeCapture`，追加写 events.jsonl，自动补 time）+ `loadTSEvents`（坏行跳过）。
  - `src/camera/contract.ts`：TS 判定哨兵（`TSComparator`，三类偏差），`silentErrorDiscardTS` 谓词与 Go contract.go 语义逐条对齐。
  - `src/camera/index.ts`：统一导出。
  - `tests/camera/camera.test.ts`：9 用例（emission/schema 对齐、坏行容错、三类偏差、op 语义、报告渲染）。
  - `scripts/camera_ts_probe_demo.mjs`：TS 埋点演示（save + cleanup 场景）。
- **跨语言 E2E 验证**：TS 探针埋点产出 4 事件 → Go `camera-dsl loop` 判定：2 违反（save.writefile ENOENT、cleanup.remove permission denied）+ 2 良性正确放行。TS 哨兵与 Go 装配层判定语义一致。
- TS 全量 609 测试 + Go 全量测试通过。

## ✅ Camera 狗食插桩（给自己插桩，已完成并验证）
- **原则落地**：狗食的最好方式是监控自己——Camera 探针埋进 design-canvas 自身真实运行路径（saveDSL 写盘），运行中自动采集数据流事件，实现"运行中自动发现某环节数据流/逻辑错误"，面向自动化测试，无需可视化。
- **零侵入插桩**：新增全局探针接口（对齐 Go `SetGlobalSink` 语义）——`setGlobalProbeSink`/`captureProbe`，默认 no-op，未配置 sink 时探针不改变宿主行为、不创建文件、不反向抛错。任意宿主路径可无条件调用。
- **埋点落点**：`storage.ts#saveDSL` 两处 `writeFileSync`（feature 文件 + live 文件）插桩，写盘成功采集 `save.writefile`（err=null），失败捕获 err 消息后仍向上抛。
- **运行哨兵**：`src/camera/run_sentinel.ts` 提供 `enableCameraFromEnv()`，从 env（`CAMERA_EVENTS_FILE`）一键启用全局 sink，未设置时 no-op。
- **新增文件**：`src/camera/probe.ts`（+全局接口）、`src/camera/run_sentinel.ts`、`tests/camera/dogfood.test.ts`（4 用例：默认 no-op、配置后采集 2 事件、无 sink no-op、写盘失败捕获）、`scripts/camera_run_dogfood.mjs`（演示）。
- **端到端狗食验证**：`CAMERA_EVENTS_FILE` 启用哨兵 → 真实运行 saveDSL 写盘 → 采集 2 条 `save.writefile` 事件 → Go `camera-dsl loop` 判定「2 事件，0 违反，0 未声明，完全一致」。证明自项目运行数据流被 Camera 全程观测且判定正确。
- TS 全量 613 测试 + Go 全量测试通过。

## 下一步（待办）
- 把插桩扩到更多真实数据流（serve /api/save、import_project 扫描写盘、db 项目级缓存），并铺开为可配置的自动测试哨兵。
- 设计 DSL 契约补全后，让 loop 对真实运行 event 产出违反/未声明偏差，接进 CI（有偏差即失败）。
- 判定端口下沉独立服务（/api/camera/judge），探针语言与判定彻底解耦。

## ✅ 全自动插桩端到端闭环（已完成并验证）
- **目标**：把「全量无脑插桩」落到实处——用 AST 插桩器（instrument.ts）对真实代码全自动插桩 → 运行哨兵采集 → 喂给 Go 装配层判定，跑通真实闭环，验证插桩不破坏原功能、事件可被正确判定。
- **修复 bug（关键）— 探针 sink 跨模块实例隔离**：全自动插桩会把 `captureProbe` 注入项目任意文件，同一 `probe.js` 被不同相对路径 specifier 加载时，Node ESM 会创建**多个模块实例**（`./dist/...` 与 `../../dist/...` 是两个实例，各自持有独立模块级 `globalSink`）。后果：`enableCameraFromEnv()` 设置的 sink 无法被被插桩代码看到 → 运行 0 事件。
  - **修复**：`src/camera/probe.ts` 的 sink 状态从模块级变量改为挂在 `globalThis`（键 `__camera_global_sink__`），所有模块实例共享同一份状态。回归测试：`tests/camera/dogfood.test.ts`「跨模块实例共享 sink」。
- **修复（demo）**：`scripts/camera_instrument_demo.mjs` 显式传 `projectRoot`（design-canvas 根），使 `relativeProbeImport` 正确计算相对路径。
- **修复（插桩 import 指向）**：`src/camera/instrument.ts` 的 `relativeProbeImport` 从指向 `src/camera/probe.js`（TS 源）改为指向 `dist/src/camera/probe.js`（编译产物）——被插桩代码运行时解析的是产物。
- **E2E 验证（status_demo，临时事件文件）**：
  - 全自动插桩 4 个文件注入 14 探针点（enter/exit/core + catch/io/event 分级标签齐全）。
  - 运行真实 save 路径 → 采集 **6 条事件**（constructor.enter/exit、save.enter、mkdirall、writefile、save.exit，core/event 分级正确）。
  - Go `camera-dsl loop` 判定：**6 事件，0 未观测 · 0 违反 · 0 未声明，完全一致**。
- TS camera 测试 20 个（含新增回归）+ Go 全量测试通过。

## ✅ 运行中抓包实证：serve 启动接入哨兵 + 真实错误捕获（已完成并验证）
- **目标**：把「运行中直接抓包」落到 design-canvas 自身真实数据流——serve 的 `/api/save` 保存路径。这是从「演示脚本」到「自项目真实运行观测」的关键一跳，也是 CI 数据流门禁的核心链路。
- **改动**：`src/tools/serve.ts` 的 `startServer()` 开头调用 `enableCameraFromEnv()`（import `../camera/run_sentinel.js`）。设置 `CAMERA_EVENTS_FILE` 时激活全局探针 sink，未设置时 no-op 不改变 serve 行为。
- **E2E 实证 1（正常保存）**：临时目录启动 serve（cwd 指向临时项目，`CAMERA_EVENTS_FILE` 指向临时事件文件）→ 真实 `POST /api/save` → 采集 **2 条 `save.writefile` 事件**（feature 文件 + live 文件，err=null）→ Go `camera-dsl loop` 判定 **0 违反 0 未声明，完全一致**。
- **E2E 实证 2（真实错误捕获）**：把 live 文件 `design-canvas.json` 占位成**目录**制造写盘失败 → 再次 `POST /api/save` → 服务端返回 500（EISDIR）→ **探针自动捕获 err 事件**（`err: "EISDIR: illegal operation on a directory..."`）→ Go `camera-dsl loop` 判定 **1 违反**：`design:silent-error-discard` 契约被触发，报告明确错误信息。
- **意义**：证明「全量无脑插桩 + DSL 筛选」能收敛到 CI 数据流门禁——运行中自动抓包，判定层识别错误，报告偏差。serve 的每个真实保存请求都会被 Camera 全程观测。
- 说明：本次只接入 serve 一个入口（含 storage.ts 已有 saveDSL 手动埋点）。未做 serve 单测——端到端真实 HTTP 请求已充分验证，避免过度工程。

## ✅ 开发时即时观测提示（已完成并验证）
- **定位澄清（2026-08-14）**：用户明确 Camera 的纠错形态是「开发时即时观测提示」，不是 CI 门禁。本项目是「开发工具 + 自动化纠错工具 + 活文档」三合一，Camera 应在开发时（跑 serve/改 DSL）在旁边自动观测、发现错误即时提示，不打断开发。
- **改动**：
  - `src/camera/judge.ts`（新增）：TS 侧轻量即时判定器，`silentErrorDiscard()` / `judgeEvent()`，与 Go `SilentErrorDiscard` 谓词语义对齐（err 非空 + op 分层良性判断：cleanup/remove 的 benign 良性，writefile/save/mkdirall 一律非良性）。
  - `src/camera/probe.ts`：`TSProbeCapture` 构造函数加可选 `onEvent` 即时回调，每条事件落盘后立即调用（不阻塞，失败不影响落盘）。
  - `src/camera/run_sentinel.ts`：`enableCameraFromEnv(onEvent?)` 透传即时回调。
  - `src/tools/serve.ts`：`startServer()` 的哨兵注入即时判定回调——事件命中契约偏差即 `broadcastSSE('camera-alert', ...)` 推给画布。
- **定位说明**：即时判定器是「秒级轻量提示」，不做全量聚合/未观测判定；那部分仍由 `camera-dsl loop` 事后权威执行。语义对齐，定位互补。
- **E2E 验证（真实 SSE）**：临时项目把 live 文件占位成目录制造写盘失败 → 启动 serve → 开 SSE 客户端监听 `/api/events` → 发 `POST /api/save` → **SSE 毫秒级收到 `camera-alert`**：`rule=design:silent-error-discard`，`reason=nont-benign error silently discarded (op=writefile): "EISDIR..."`，含完整 fields。
- **意义**：完整「开发时即时观测提示」链路打通——运行中探针采集 → 即时判定 → SSE 推给画布，错误出现即提示，无需事后跑命令。
- 测试：新增 `tests/camera/judge.test.ts` 6 用例（err nil / writefile 非良性 / cleanup benign / cleanup 非良性 / judgeEvent 多规则 / 无偏差），camera 全量 26 通过。

## ✅ 异常日志工具 camera-dsl log（已完成并验证）
- **定位（2026-08-14）**：用户进一步明确 Camera 的纠错形态是「日志工具」——像普通日志一样事后可查，每跑一轮把异常逐条列出来（哪个数据流、什么类型问题），不打断心流。LLM 靠工具调用 + 工具返回获取信息，没有"余光"，所以不能靠推送，要靠 LLM 主动拉取。
- **筛选层**：默认只筛两类异常——静默吞错（catch 的错误）+ 设计不符（DSL 契约偏差）；正常流动数据默认不报，除非 LLM 想看某个功能怎么实现（--all）。
- **改动**：`go-camera/internal/probe/dsl_cli.go` 新增 `camera-dsl log <events.jsonl> [--all]` 子命令 + `dslLog()`/`renderLogLine()`。复用 `Judge.JudgeLog` + `SilentErrorDiscard` 谓词逐条判定。
  - 默认：只列偏差（✗ 标记，含时间/rule/数据流 probe/原因/fields），无异常显示"✓ 无异常"。
  - `--all`：全部事件，异常打 ✗ 满详情，正常事件一行概要（供 LLM 查看实现细节）。
- **E2E 验证（真实事件文件）**：4 事件（2 正常 + 1 EISDIR 异常 + 1 enter）→ `camera-dsl log` 默认只列出 1 条 EISDIR 偏差（`rule=design:silent-error-discard`，`reason=non-benign error silently discarded (op=writefile): "EISDIR..."`，含 path 字段）；`--all` 全列但异常打标。正常事件被筛选层正确过滤。
- **说明（文件维度待补）**：当前日志含「数据流」（probe 名，如 saveSink.writefile）和「类型」（rule），但未含完整文件路径——probe 名的 mod 前缀即文件 basename（saveSink 来自 save_sink.ts）。若需精确文件路径，需让 TS 探针 emit 时带 file 字段（待后续增强）。
- 测试：新增 `dsl_log_test.go` 3 用例，go 全量测试通过。