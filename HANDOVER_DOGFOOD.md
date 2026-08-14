# Design Canvas 狗食开发交接文档（v2 最终版）

> 交接日期：2026-08-14
> 交接对象：新开 TRAE 窗口的 AI Agent / 开发者
> 交接背景：原会话绑死在 `d:\project_develop\ai-base` 工作区，无法加载 design-canvas 的**项目级 MCP**，故用本文档做上下文交接。
> 使用方式：新窗口请以 `d:\project_develop\design-canvas`（稳定版）或 `d:\project_develop\design-canvas-dev`（开发版）**作为工作区打开**，先读本文件根目录的 `HANDOVER_DOGFOOD.md`（即本文档），按 §9 验证清单跑通环境，再按 §10 跑通工具闭环。**核心开发任务是 §12 Camera 系统（插桩 + DSL 真相源 + 代码异味嗅探）**；产品化方向见 §13。

---

## 1. 项目是什么（一句话）

design-canvas 是一个 **MCP server**：让 LLM 把"脑子里的图"输出为**结构化 DSL**（双层：几何 + 语义），渲染成**自包含 HTML 网页**给人看；人在网页上改图 / 改 JSON，LLM 再读回继续迭代。作为独立 MCP 服务对外开放，兼容任何 MCP client（Claude Desktop / Cursor / TRAE / agent-shell 等）。

核心文档索引：
- 定位 / 架构 / 设计决策：`README.md`、`docs/design.md`
- 实现与设计的偏离追溯、演进记录：`docs/evolution.md`
- 可视化风格规范（新渲染任务必读）：`docs/visual-style-handover.md`
- MCP 工具收敛方案：`docs/plans/2026-08-07-mcp-tool-convergence.md`
- 变更原因四层校验方案：`docs/plans/2026-08-11-live-doc-change-reason.md`

---

## 2. 开发模式：狗食开发 + git worktree 双工作树

**狗食开发（dogfooding）** = 用 Design Canvas 自己的 MCP 工具，来做 Design Canvas 的真实开发任务（建 feature、写 DSL、渲染、一致性检查等），以验证工具本身好不好用、并驱动工具迭代。**你接下来的所有开发，都要尽可能先想"这个任务能不能用 design-canvas 自己的工具完成"，能走工具就走工具**，而不是直接改代码跳过验证。

版本隔离采用 **git worktree 双工作树**（同一仓库，两个检出目录）：

| 角色 | 分支 | 目录 | 用途 |
|---|---|---|---|
| 稳定运行版 | `master` | `d:\project_develop\design-canvas` | 对外可用版本，随时可跑、可对外发布 |
| 开发版 | `dev` | `d:\project_develop\design-canvas-dev` | 在 dev 上开发，验证通过后合并回 master |

常用命令：
```bash
git worktree list                                            # 查看当前 worktree
# 在 dev 目录内：git add/commit → 然后回 master 目录执行合并
git -C d:\project_develop\design-canvas merge dev            # dev 合回 master
```
**注意**：两个目录各自独立 `npm install` / `npm run build`（`dist/` 被 gitignore 不入库，换目录 / 新 clone 后必须重建才能起 MCP）。

---

## 3. TRAE MCP 接入（关键前提，先读）

design-canvas 采用**项目级 MCP 配置**，文件在项目根的 `.trae/mcp.json`：

```json
{
  "mcpServers": {
    "design-canvas": {
      "command": "node",
      "args": ["${workspaceFolder}/dist/src/server.js"]
    }
  }
}
```

**为什么项目级而不是全局（决策记录，勿再改回全局）**：
1. git worktree 双工作树是两个目录，`${workspaceFolder}` 让每个 worktree 自动指向**自己目录**的 `dist/src/server.js`，稳定版 / 开发版隔离；
2. 配置随项目走，克隆 / 迁移 / 换机器即用；
3. MCP server 与构建产物版本对齐（改源码 → build → MCP 立即吃到新版本）；
4. 项目自包含，不污染其他项目（如 ai-base）。

**加载前提（务必遵守）**：
- 必须把 `d:\project_develop\design-canvas` 或 `d:\project_develop\design-canvas-dev` **作为 TRAE 工作区打开**。在 `ai-base` 等其他工作区，此 MCP **不会**加载。
- 打开后若 MCP 面板未出现 `design-canvas`：确认 TRAE 设置里**「启用项目级 MCP」**已开启，然后在 MCP 面板 Reload 或重启 TRAE。
- 两个 worktree 的 `.trae/mcp.json` 均已配置好（`${workspaceFolder}` 相对路径），**此文件未提交到 git，若新 clone 需重新生成**（见 §4 分发脚本）。

分发 / 管理脚本（在项目根执行）：
```bash
node scripts/install_mcp.mjs              # 写入全部已安装 client 的配置（含 TRAE）
node scripts/install_mcp.mjs --list       # 查看各平台配置路径与写入状态
node scripts/install_mcp.mjs --dry-run    # 预览将写入的内容（不落盘）
node scripts/install_mcp.mjs --target trae# 只写 TRAE
node scripts/install_mcp.mjs --check      # 只检查不写
```
支持的平台：claude / cursor / vscode / codex / copilot / gemini / windsurf / cline / trae。

---

## 4. 项目代码结构总览（帮新 agent 快速定位）

```
design-canvas/
├── src/
│   ├── server.ts              # MCP server 入口（stdio），构建产物 dist/src/server.js
│   ├── server_registry.ts     # ★ 工具注册表：9 主工具 + 33 别名的统一注册处
│   ├── storage.ts             # DSL / feature 存档的读写与原子写
│   ├── db/                    # 符号库 / 源码索引（db.ts、schema.ts、symbols.ts）
│   ├── dsl/                   # DSL 类型与校验（geometry 几何层 / semantic 语义层 / animation / simulation / reasoning / mindmap / validator）
│   ├── renderer/              # HTML 渲染器（html_renderer、shape_card、styles、animation_engine、simulation_engine、dataflow_core…）
│   │                          #   *_bundle.gen.ts 是脚本生成的内联 bundle（build 时生成）
│   ├── tools/                 # ★ 各 MCP 工具实现（每个主工具一个文件，见 §5）
│   │   ├── ts_kernel/         # TreeSitterKernel：AST 解析（cfg.ts、kernel.ts、languages.ts、loader.ts、probe.ts）
│   │   └── reason_validator.ts# edit_dsl reason 四层校验（§6）
│   └── (tools/serve.ts)       # HTTP API 服务（/api/save 等，npm run serve 启动）
├── tests/                     # vitest 测试（与 src 目录结构对应，全量 596 用例）
├── schema/design_dsl.schema.json  # DSL JSON Schema
├── scaffold/                  # scaffold 生成的骨架示例（conveyor / status_demo）
├── examples/                  # DSL 示例（conveyor.json 等）
├── docs/                      # 设计文档 / 演进记录 / 计划 / 可视化风格
├── scripts/                   # 各类 mjs 脚本（分发 / 冒烟 / 自分析 / 一次性诊断）
└── .trae/mcp.json             # TRAE 项目级 MCP 配置
```

**运行时持久化数据**（gitignore，不入库）：
- `design-canvas.json`：根目录活态设计 DSL（design 视图）
- `.design-canvas/`：feature 存档、`live/<f>.dsl.json` 代码快照等
- `output/`：渲染出的自包含 HTML 文件

---

## 5. MCP 工具收敛：9 主工具 + 33 别名 = 42

工具已从 37 个收敛为 **9 个主工具**（参数化分发），旧工具名**全部保留为别名**（兼容存量调用/会话/脚本，零破坏）。注册表：`src/server_registry.ts`。

### 9 个主工具

| 工具 | 用途 |
|---|---|
| `get_dsl` | **统一只读入口**：`query`(dsl / features / nodes / edges / node / files / file / annotations / approvals / approval_history / snapshots / templates / simulation_state / diff) + `view`(design/live) + 过滤参数 |
| `edit_dsl` | **统一写入口**：`operations[]` 批量执行节点/边/文件/API 增删改、平移(move)、语义绑定(binding)、状态更新、标注/审批/快照/自动布局/仿真重置。**按序执行，任一失败全部回滚（原子性）**。**必须带合规 reason（§6）**；`view=live` 拒绝写入（写护栏） |
| `manage_feature` | **生命周期入口**：`action`(create / clone / template / list / delete) |
| `render_dsl` | **渲染入口**：`format`(html 默认 / svg / markdown) + `view`(design/live) + `output_path` |
| `scaffold` | 从 DSL semantic 层生成代码骨架（go/ts/py/js/vue/tsx + INVARIANTS.md）+ 状态推断 |
| `backfill_scaffold` | 解析实现代码的 API 签名回填 DSL actual_apis + 差异报告 |
| `consistency_check` | expected_apis vs 实际代码一致性 + 跨文件不变式（只读） |
| `explore_code` | **代码理解入口**：`action`(import / semantic_search / diff_impact / arch_layer / guided_tour / check_monolith / analyze_monolith / derive_split / derive_detail_chain / derive_anim_flow / derive_algorithm / inject_replay / run_simulation / reset_simulation / watch) + `args` |
| `diff_views` | design vs live 双视图：文件级 / 符号级 / API 级 / 依赖级对比 |

> ⚠️ **注意**：`README.md` 仍写"8 主工具"（`diff_views` 是后加的，README 未更新）。**以 `src/server_registry.ts` 为准：当前是 9 主工具**。用户口中的"8 个工具"指旧收敛版本。建议后续把 README 工具表补上 diff_views。

### `view` 参数（design | live，三个可能落数据的工具统一显式声明）

- `design`（默认）= **活态设计 DSL**（`design-canvas.json` + feature 存档），LLM 刻意设计的主战场。对应浏览器「🎭 设计」。
- `live` = **实际代码快照**（`live/<f>.dsl.json`），**只读**，只能由 `explore_code action=import/watch` 重建。对应浏览器「⚡ 实际」。`edit_dsl view=live` 会被写护栏拒绝。
- **判别口诀**：要改的那一版 = `design`；要看的代码现状 = `live`；listen 自动更新 = `watch`（explore_code）。

### 别名（旧名 → 主工具）

- `query_feature` → get_dsl；`update_feature` → edit_dsl
- `create_feature` / `clone_feature` / `create_from_template` → manage_feature
- `export_svg` / `export_markdown` → render_dsl；`check_status` → scaffold
- `import_project` / `semantic_search` / `diff_impact` / `arch_layer` / `guided_tour` / `check_monolith` / `analyze_monolith` / `derive_split` / `derive_detail_chain` / `derive_anim_flow` / `derive_algorithm` / `inject_replay` / `run_simulation` / `reset_simulation` / `watch_project` → explore_code
- `add_annotation` / `resolve_annotation` / `dag_layout` / `force_layout` / `grid_align` / `submit_approval` / `review_annotation` / `save_snapshot` / `rollback_snapshot` / `delete_snapshot` → edit_dsl（写动作）

新会话建议直接用主工具；旧名仍可用以兼容历史调用。

---

## 6. 狗食开发必须遵守的约束

1. **edit_dsl 的 reason 必填**，过四层校验（`src/tools/reason_validator.ts`）：
   - L1 非空（≥6 可见字符）
   - L2 非套话（「更新代码 / 优化 / 修复」等黑名单）
   - L3 实体绑定（必须含 ≥1 具体实体：节点/文件 id、文件路径、数字指标）
   - L4 证据回溯（传入 evidence 需能在真实 trace 库复算；无 trace 文件则 evidence 一律打回）
   - 校验失败会返回命中层与原因，修正后重试即可。
   - 合规示例：`reason: '冒烟验证：src/service.ts 建立 服务→调用方 调用关系及语义文件'`
2. **DSL 双层结构**：几何层（位置/样式，人编辑）+ 语义层（文件/API/依赖，LLM 编辑），**id 锚定**避免冲突。语义文件必须锚定到已有节点 id。
3. **原子写**：edit_dsl operations 按序执行，任一失败全部回滚。
4. **live 视图只读**，不要手改；要重建实际视图用 `explore_code action=import / watch`。
5. **DSL 是唯一真相源**：判定 / 行为只依据「事件快照 + DSL 契约声明」，不依赖项目文档 / 注释背景。
6. **不硬编码策略**：压缩策略、融合算法、评分维度等必须走接口 / 走注册表，禁止在工具里写死。
7. **变更记录写 `docs/evolution.md`**；一次一阶段、可运行、**有可见产物**（html/svg/截图）再推进。

---

## 7. 构建与测试命令

```bash
npm install                 # 首次 / 新 worktree / 新 clone 必做
npm run build               # 生成 *_bundle.gen.ts + tsc 编译到 dist/
npm start                   # 启动 MCP server（stdio 模式）
npm run serve               # 启动 HTTP API 服务（tools/serve.ts）
npm test                    # vitest run（全量 596 用例）
npm run self-analyze        # 用本项目工具自分析（狗食）— build 后执行 scripts/self_analyze.mjs
npm run hub                 # 启动 hub.mjs（浏览器端交互入口）
```
- 单测与源文件同目录或 `tests/` 下（vitest）。
- 改代码 → `npm run build` → Reload TRAE MCP（或重启）→ 新逻辑生效。
- `scripts/*_smoke.mjs`、`scripts/_dbg_*.mjs`、`scripts/*_verify.py` 等一次性脚本不入库（gitignore），需要时本地保留 / 重新生成，**别依赖 git 分发**。

---

## 8. 当前 git 状态与未提交内容（重要）

在 master（`d:\project_develop\design-canvas`）：
- `scripts/install_mcp.mjs`：**已修复**（新增 TRAE 平台 + `${workspaceFolder}` 支持）——**已修改，未提交**
- `.trae/mcp.json`：**已生成**（项目级 MCP 配置）——**未跟踪**。`.trae/` 不在 .gitignore，**建议提交入库**，让 dev worktree 通过 git 自动获得（否则新 clone 后要重新跑 install_mcp 生成）
- `scripts/mcp_conv_smoke.mjs`：收敛冒烟脚本——**gitignored**（`scripts/*_smoke.mjs`），仅 master 本地有，不随 git 分发

`git worktree list` 确认：`D:/project_develop/design-canvas [master]` 与 `D:/project_develop/design-canvas-dev [dev]` 均存在，当前都在 commit `a88012c`。

**建议下一步（按序）**：
1. 新窗口打开 design-canvas 工作区，确认 MCP 面板出现 design-canvas、9 主工具可调用（§9）；
2. **提交** `scripts/install_mcp.mjs` + `.trae/mcp.json` 到 master（自动随 dev worktree 生效），本交接文档 `HANDOVER_DOGFOOD.md` 也建议一并提交；
3. 开始第一个狗食任务（§10）。

---

## 9. 接手验证清单（第一件事，逐项打勾）

环境自检：
- [ ] `npm run build` 通过（master / dev 各自构建）
- [ ] `node scripts/mcp_conv_smoke.mjs`（**仅 master 本地有**）→ 42 工具全注册、9 主工具端到端调用通过
- [ ] `git worktree list` 显示两个 worktree
- [ ] `npm test` 通过（可选，596 用例）

TRAE 侧：
- [ ] 当前工作区 = `d:\project_develop\design-canvas`（或 `design-canvas-dev`），**不是 ai-base**
- [ ] MCP 面板可见 `design-canvas` server，状态正常（异常则确认「启用项目级 MCP」开关 + Reload/重启）
- [ ] 能实际调用 `get_dsl`（如 `{"query": "features"}`）返回 feature 列表

---

## 10. 第一个狗食任务示例（验证工具闭环）

1. `manage_feature` action=create 建 feature（如 `dogfood_demo`）
2. `edit_dsl` 写几个节点 / 边 / 文件（**带合规 reason**，见 §6；语义文件锚定到节点 id）
3. `render_dsl` format=html 渲染到 `output/`，浏览器打开验证（人看图）
4. `get_dsl` 读回确认写入了什么
5. 进阶：`explore_code action=import` 导入真实代码目录建 live 视图 → `diff_views` 对比 design vs live → `consistency_check` 校验
6. 每一步都要有可见产物（html/svg/截图）给用户确认，再进下一步

**狗食开发节奏建议**：一次一阶段、先跑通端到端再推进；每阶段交给用户验收时附「验证清单」（看什么、期望看到什么）。

---

## 11. 常见坑

- 改 `.trae/mcp.json` 后必须 Reload / 重启 TRAE 才生效。
- Windows 下 TRAE 要求 command **不含空格**，故配置用 PATH 内 `node` 而非 node 完整路径（`C:\Program Files\nodejs\node.exe` 含空格会失败）。`install_mcp.mjs` 的 TRAE 分支已处理。
- `dist/`、`node_modules/`、`output/` 被 gitignore：换 worktree / 新 clone 后先 `npm install && npm run build` 才能起 MCP。
- `scripts/*_smoke.mjs`、`scripts/_dbg_*.mjs` 等一次性脚本不入库：需要时本地保留 / 重新生成。
- 老会话 / 文档里"8 主工具"是旧收敛版本；**当前代码为 9 主工具（含 diff_views）**。
- README 工具表缺 `diff_views`，是已知待补项（用户可接受先不改，但别以 README 为准）。
- 若 TRAE 不加载项目级 MCP，先查设置「启用项目级 MCP」，再查 `.trae/mcp.json` 是否在**当前工作区根**。

---

## 12. 核心开发主线：Camera 系统（插桩 + DSL 真相源 + 代码异味嗅探）

> **这是 2026-08-14 全天讨论定的主开发方向，也是狗食阶段要驱动完成的真实任务。** 别把它只当"工具验证"——它是产品功能本身。
> 代码在**另一个仓库**：`d:\project_develop\ai-base\agent-shell\internal\probe\`（agent-shell 内，Go）。design-canvas 工作区用 `explore_code action=import` 导入该目录，就能用设计图工具分析/设计它（§12.5）。

### 12.1 是什么（一句话）

对"被测代码"做**动态插桩**（不止覆盖率秒表，还有数据流摄像头），把运行中观察到的真实行为与「设计意图 DSL 契约」比对，识别**代码异味 / 行为偏差**。LLM 只依据「事件快照 + DSL 契约声明」判定——**DSL 是唯一真相源**，不是项目文档。

三层观察（自上而下）：
- **秒表（stopwatch）**：覆盖率级——哪段代码被执行过
- **摄像头（camera）**：数据流级——运行中真实传入 / 返回 / error 值
- **判定层**：双层——规则判定秒判确定性事件（快车道），仅可疑事件交 LLM 兜底复核（降级不阻断流程）

### 12.2 当前状态（已完成，2026-08-14）

| 模块 | 文件（agent-shell/internal/probe/） | 状态 |
|---|---|---|
| 零依赖全局探针 | `global.go`（SetGlobalSink / Capture / CaptureErr，sink 为 nil 即 no-op） | ✅ |
| 探针主体 | `probe.go`（Sink / Event） | ✅ |
| 规则判定 | `contract.go`（Judge + 确定性规则快判，首个 deviation 胜出） | ✅ |
| LLM 行为判定 | `llm_judge.go`（LLMSender / DSLDecl / LLMVerdict / LLMJudge，只喂事件快照+DSLDecl） | ✅ |
| P1 DSL 仓库 | `dsl_store.go`（DesignDSLStore：版本化 + 快照审计 `dsl.history.jsonl` + 原子写 tmp+rename） | ✅ |
| P1 CLI | `dsl_cli.go` + `main.go`（`camera-dsl show/history/rollback/seed`，纯本地、APIKey 检查前处理、剥离 --project-root） | ✅ |
| 测试 | `probe_test.go` / `camera_demo_test.go` / `dsl_store_test.go` / `llm_judge_test.go` / `camera_llm_e2e_test.go`（`go test -tags e2e -run TestCameraLLME2E`） | ✅ |

要点：契约已从 lesion-rules **解耦**——契约来源 `static-rule` → `llm-design`，规则 id → `design:silent-error-discard`，探针包零 import lesion-rules；lesion-rules 降级为 seed 清单仓库，不再做判定中心。`TaskCamera` 已注册到 `provider/router.go`，LLM 判定走 `router.ForTask(TaskCamera)`，自动记入 UsageJournal 账本。

### 12.3 下一步：工程化 P2-P4（狗食阶段的真任务）

- **P2 ActualDSLLoader + 聚合**：扫描被测代码的探针观测产物，聚合生成 `actual.dsl.json`（**观测事实画像**，可再生、非权威）；与设计 DSL（dsl.json）对比，产出偏差报告。
- **P3 修订 + 验证门**：LLM 修订只落 `revisions/` 提案区（**提案权与写盘权分离**）；验证门 = 规则回归 + LLM 复核 + e2e，审批通过后才经 camera-dsl 定稿写入 dsl.json。**LLM 无直接写盘通道**。
- **P4 循环打通 + 触发**：观测→聚合→对比→提案→验证→定稿 的演化闭环跑通；接入真实触发点（如 NREM 梦游判定路径 / agent 运行事件流），让摄像头在真实运行中自动嗅探。

完成标准：`{projectRoot}/.agent/camera/` 下 `dsl.json` + `dsl.history.jsonl` + `actual.dsl.json` + `revisions/` 四件套闭环可运行，偏差报告经 LLM 复核与 DSL 契约语义一致。

### 12.4 关键约束（硬约束，别破坏）

- LLM 判定只喂「事件快照 + DSL 契约声明」，不含项目文档 / 架构历史 / 注释背景
- 双层判定：规则快判确定性事件；可疑事件才交 LLM；降级不阻断流程
- 双层 DSL：`actual.dsl.json`（事实画像，可再生非权威）+ `dsl.json`（设计 DSL，判定唯一权威）
- 仓库 `{projectRoot}/.agent/camera/`：版本单调递增、原子写（tmp+rename）、可回滚
- 提案权与写盘权分离：LLM 修订只落 `revisions/` 提案区；写盘只走 camera-dsl（P3 后走验证门）
- camera-dsl 纯本地 CLI：在 APIKey 检查前处理、独立解析项目根、子命令剥离 `--project-root`

### 12.5 狗食怎么用它做开发（工具闭环 → 真任务）

用 design-canvas 的 MCP 工具把 Camera P2-P4 当真实开发任务完成（这也是狗食循环，§10 是入门示例）：

1. `explore_code action=import` 导入 `d:\project_develop\ai-base\agent-shell\internal\probe` 源码建 live 视图
2. `manage_feature` create feature（如 `camera_p2_actual_dsl`）
3. `edit_dsl` 把 P2 需求拆成节点/边/文件（带合规 reason，§6）
4. `scaffold` / `backfill_scaffold` 生成并回填实现骨架
5. `render_dsl` 渲染给人看（每阶段必须出可见产物）
6. 实际代码改动回 `ai-base` 工作区（agent-shell）做，`go test ./internal/probe/` 验证
7. 痛点反馈 → 迭代 design-canvas 工具本身（狗食铁律：产出「工具改进清单」）

---

## 13. 后续：design-canvas 产品化路线（次要，Camera 主线之后再考虑）

> evolution 路线图 1-16 已全部完成、product-vision 触发条件已满足，但**优先级低于 Camera 主线**，按用户节奏推进。详细依据见 `docs/evolution.md` §6 与 `docs/product-vision.md`。

### 13.1 当前路线图状态快照（evolution.md §6，1-16 全部完成）

| 序号 | 路线图项 | 状态 |
|---|---|---|
| 1 | SQLite 存储 + 文件 hash 增量 | ✅（src/db/，node:sqlite 零依赖） |
| 2 | MCP 工具收敛（9 主 + 33 别名） | ✅ |
| 3 | 调用边级别提取（AST + 跨文件） | ✅ |
| 4 | Diff Impact Analysis | ✅（**D2 渲染层标红待做**） |
| 5 | architecture-analyzer 分层回填 | ✅（已下沉到 import_project） |
| 6 | Guided Tours 拓扑导览 | ✅ |
| 7 | Layer Visualization 分层着色 | ✅ |
| 8 | Fuzzy & Semantic Search | ✅（需配 embedding，未配降级 FTS） |
| 9 | Persona-Adaptive UI 角色自适应 | ✅ |
| 10 | Language Concepts 语言模式解释 | ✅ |
| 11 | 文件监听自动同步（watch_project） | ✅ |
| 12 | 多平台插件分发（install_mcp） | ✅（8 平台 + TRAE = 9） |
| 13 | 动画阶段 E（conveyor 迁移） | ✅ |
| 14 | L3-L5 动画（分支/绑定/异常） | ✅ |
| 15 | L5 反向提取增强 | ✅ |
| 16 | 巨石分析 + 自动拆分（analyze_monolith / derive_split） | ✅ |

**结论**：evolution 路线图 1-15 主体已完成 → `product-vision.md` 的启动触发条件已满足 → **下一阶段 = 产品化**。狗食阶段的任务，就是用狗食把工具进一步磨利，为产品化铺路。

### 13.2 产品化路线（product-vision.md 批次 1-4，按序推进）

现状定位："**开发者可用**" → 目标："**非开发者好用**"（设计师 / PM / 评审人也能无门槛用）。

| 批次 | 内容 | 触发 |
|---|---|---|
| 批次 1：触屏 + 无障碍 | #2.1 触屏支持（`mousedown` → Pointer Events + `touch-action:none`）+ #2.2 prefers-reduced-motion + #2.3 首次引导 + `?` 快捷键速查 | 核心功能完成后立即 |
| 批次 2：数据安全 | #4.1 localStorage 版本迁移 + #4.2 撤销栈改增量 diff + #4.3 serve 鉴权（127 绑定 + token） | 与卡顿修复合并 |
| 批次 3：分发能力 | #3.1 导出 SVG/PNG + #3.2 分享链接（前置：serve 支持 `?feature=`）+ #3.3 iframe embed | 用户反馈"想分享"时 |
| 批次 4：UX 打磨 | #5.1 alert→toast/内联编辑 + #5.2 搜索高亮/循环跳转 + #5.3 日志分级 + #2.4 空状态引导 | 顺手做 |

每批次完成标准 = **有可见产物 + 用户验收**（对照 §10 的节奏）。

### 13.3 遗留清理项（小项，可合并进批次或独立插队）

- **文档同步**：README 工具表补 `diff_views`（当前 9 主工具，README 仍写 8）；design.md / mvp-plan.md 严重滞后，以 evolution.md + animation-design.md 为准（evolution §3.3）
- **scripts.ts 体积**：~217KB 单文件，随词典 / 动画能力独立化逐步拆分（evolution §3.3）
- **Diff Impact D2**：渲染层标红受影响节点/边 + 影响清单面板（evolution §7.5 待做）
- **语义搜索配置**：需配置 embedding（config.json `embedding` 段 / `EMBEDDING_*` env），未配置自动降级 FTS（evolution §6.4 序号 8）

### 13.4 开放问题（产品化启动时与用户拍板）

来自 product-vision §9，不影响批次 1-4，但影响长期产品形态：
1. **只读模式**——评审人只能看不能改（当前 HTML 总是可编辑）
2. **版本对比**——LLM 改了 DSL 后，人想看"改了什么"（当前无 diff 视图）
3. **节点批注讨论**——评审人在节点留言，LLM 读取回复（当前只有单次标注）
4. **LaTeX / 公式节点**——算法 / 数据流场景可能需要
5. **VSCode 插件**——vscode 内嵌预览（当前是 MCP server + 浏览器）

### 13.5 明确不做（product-vision §6.3，守住边界）

不做账号系统 / 云同步、不做多人协作实时同步、不做插件市场、不做主题编辑器、不做移动端原生 App。

### 13.6 决策原则备忘（接手后一直要守）

- design-canvas 是**独立 MCP 项目**，对外开放（硬约束，不得嵌入 agent-shell）
- **零依赖自包含 HTML** 不破（design.md 核心观点，断网也能看）
- 不硬编码策略，走接口 / 注册表
- 一次一阶段、可运行、有可见产物、用户验收后再推进
- 变更原因四层校验（§6）是活文档源头，别绕过
