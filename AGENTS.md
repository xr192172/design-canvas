# AGENTS.md — design-canvas 开发约定（为 AI agent 编写）

> 本文件约束在此仓库内进行开发时，agent（Trae/Claude 等）应遵循的规则。
> 核心目标：让日常开发动作（改名/编辑/理解/清理/引用/测试/漂移）走项目自带 MCP 工具，
> 而不是用 grep+脚本手动硬改——那是「工具被想起」的最大障碍。

> 注意：本文件的「触发点总表」由 `scripts/gen_agents.mjs` 从 TRIGGER_ROWS 单一事实源生成。
> 外部进程若把它盖成旧版，下一次 `npm run build` / pre-commit 会自动重建回正确版。
> 改工具映射请改 TRIGGER_ROWS，不要手改本表。

## 触发点总表（按开发动作）

| 开发动作                      | 必用工具                                                            | 说明                                                                              |
| ----------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 开发前先看 / 画活文档         | `get_dsl` / `render_dsl` / `edit_dsl` / `manage_feature`            | 开工前对齐设计，避免方向性错误                                                    |
| 改一个模块级符号名            | `rename_symbol`                                                     | 自动定根+闭包+跨语言，先 dry_run 看 diff                                          |
| 批量改多个符号                | `rename_symbols`                                                    | 先整体 dry-run，全部可落盘才落                                                    |
| 改文件名并联动全仓 import     | `rename_file`                                                       | 防文件悬空                                                                        |
| 单文件局部变量/形参批量改名   | `rename_many`                                                       | 作用域隔离                                                                        |
| 改一段代码（函数体/range）    | `edit_code`                                                         | 按符号/行号定位改写                                                               |
| 理解一串代码/结构             | `explore_code`                                                      | 只读、即时答案                                                                    |
| 清理无效 import               | `remove_dead_imports`                                               | 剪刀剪 dead_deps                                                                  |
| 看「谁引用了 X / 谁调用了 X」 | `find_references`                                                   | 只读引用查询；mode=field 报字段读取/构造点（加字段/改签名前必查，勿回退 grep）    |
| 加字段/改接口签名前查波及面   | `find_references mode=field`/`mode=type field=<字段>/symbol=<类型>` | 读/构/解/声明四类 AST 分类＋行内上下文；type 模式找形如某类型的对象字面量构造候选 |
| 跑测试/提交前回归             | `run_tests`                                                         | 结构化失败定位（filter 定向 or 全量）                                             |
| 改完代码看设计是否过时/欠实现 | `detect_drift`                                                      | 一次性核对：代码变更→提示 DSL 需同步，mode=status 复读台账                       |
| 常驻盯项目漂移（安全网）      | `explore_code action=watch feature=... drift_on_change=true`        | 后台监听：文件一变自动 rebuild+过时判定+主动 pushAlert                            |
| 提交前健康检查                | `consistency_check` / `sync_contracts`                              | 契约/一致性                                                                       |
| 改前看影响面                  | `diff_views` / `reconcile_chain`                                    | 波及方向                                                                          |

## 改名约定（强制优先用工具）

当任务涉及**重命名**（符号、函数、类、文件、变量、作用域内局部名）时，优先使用本仓库 MCP 暴露的
`rename_*` 工具，而非 `grep + 正则` 手动替换。

| 场景                                                     | 必用工具         |
| -------------------------------------------------------- | ---------------- |
| 改一个模块级符号（函数/const/class/interface/type/enum） | `rename_symbol`  |
| 批量改多个模块级符号                                     | `rename_symbols` |
| 改文件名并联动全仓 import 引用                           | `rename_file`    |
| 单文件内局部变量/形参批量改名                            | `rename_many`    |

**硬性流程（每次改名都执行）：**

1. 先传 `dry_run=true` 看结构化 diff（返回每个受影响文件的 `ops[{old,new}]`）。
2. 核对 diff 符合预期后，再去掉 `dry_run` 落盘。
3. 改名面向「文件主导出」时（文件名 = 符号名），`rename_symbol` 加
   `rename_file_if_matching=true` 联动改名文件。
4. 批量改名用 `rename_symbols`（先整体 dry-run 校验，全部可落盘才落盘）。

**例外（可绕过工具直接手改）：**

- 目标不是模块级符号（局部变量畅通走 `rename_many`，而不是手改）。

- 非 TS/JS/Go/Python 文件的改名，且本仓库工具不支持时。

## 测试约定

- 改完代码用 `run_tests`（filter 定向）快速确认，提交前跑全量 `npm test` 须全绿。

## 工具自检（强约束）

- 本仓库 MCP 工具依赖 `dist/` 构建产物。改了 `src/` 下的代码，**必须**先
  `npm run build` 再调用工具，否则跑的是旧逻辑（STALE BUILD）。

## 决策记录

- 工具收敛 / 命名 / 使用摩擦的决策记录在 `docs/tool-convergence.md`。

- 本文件由生成器维护，外部还原会被 `npm run build` / pre-commit 自动修复；以 git 提交历史为准。
