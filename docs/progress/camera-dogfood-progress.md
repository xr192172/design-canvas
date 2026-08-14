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

## 下一步（待办）
- 判定端口下沉为独立服务（`/api/camera/judge`），探针语言与判定彻底解耦。
- 事件聚合体积告警/抽样策略（海量事件降级为统计）。
- 与 design-canvas MCP 工具链整合（import_project 自动埋点 + render_dsl 可视化偏差全景）。