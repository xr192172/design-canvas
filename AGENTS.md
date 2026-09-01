# AGENTS.md — design-canvas 开发约定（为 AI agent 编写）

> 本文件约束在此仓库内进行开发时，agent（Trae/Claude 等）应遵循的规则。
> 核心目标：让日常开发动作（改名/编辑/理解/清理/健康检查/引用查找）走项目自带 MCP 工具，
> 而不是用 grep+脚本手动硬改。

> 注意：本文件的「触发点总表」曾多次被外部进程还原成旧版（只剩改名表）。
> 以 git 提交历史为准；每次改动随 commit 固化。

## 触发点总表（按开发动作）

| 开发动作               | 必用工具                                   | 说明                            |
| ------------------ | -------------------------------------- | ----------------------------- |
| 改一个模块级符号名          | `rename_symbol`                        | 自动定根+闭包+跨语言，先 dry\_run 看 diff |
| 批量改多个符号            | `rename_symbols`                       | 先整体 dry-run，全部可落盘才落           |
| 改文件名并联动全仓 import   | `rename_file`                          | 防文件悬空                         |
| 单文件局部变量/形参批量改名     | `rename_many`                          | 作用域隔离                         |
| 改一段代码（函数体/range）   | `edit_code`                            | 按符号/行号定位改写                    |
| 理解一串代码/结构          | `explore_code`                         | 只读、即时答案                       |
| 清理无效 import        | `remove_dead_imports`                  | 剪刀剪 dead\_deps                |
| 看"谁引用了 X / 谁调用了 X" | `find_references`                      | 只读引用查询（改/删前看波及面）              |
| 提交前健康检查            | `consistency_check` / `sync_contracts` | 契约/一致性                        |
| 改前看影响面             | `diff_views` / `reconcile_chain`       | 波及方向                          |

## 改名约定（强制优先用工具）

当任务涉及**重命名**时，优先 `rename_*` 工具，而非 `grep + 正则` 手动替换。

**硬性流程（每次改名都执行）：**

1. 先传 `dry_run=true` 看结构化 diff（返回每个受影响文件的 `ops[{old,new}]`）。
2. 核对 diff 符合预期后，再去掉 `dry_run` 落盘。
3. 改名面向「文件主导出」时（文件名 = 符号名），`rename_symbol` 加
   `rename_file_if_matching=true` 联动改名文件。
4. 批量改名用 `rename_symbols`（先整体 dry-run 校验，全部可落盘才落盘）。

**例外（可绕过工具直接手改）：**

- 目标不是模块级符号（局部变量畅通走 `rename_many`，而不是手改）。

- 非 TS/JS/Go/Python 文件的改名，且本仓库工具不支持时。

## 工具自检（强约束）

- 本仓库 MCP 工具依赖 `dist/` 构建产物。改了 `src/` 下的代码，**必须**先
  `npm run build` 再调用工具，否则跑的是旧逻辑（STALE BUILD）。

- 每次提交前运行全量测试 `npm test`，须全部通过（当前基线 1379+）。

## 决策记录

- 工具收敛 / 命名 / 使用摩擦的决策记录在 `docs/tool-convergence.md`。

- 该文件易被外部工具还原，但每次 commit 即固化；以 git 历史为准。

