# AGENTS.md — design-canvas 开发约定（为 AI agent 编写）

> 本文件约束在此仓库内进行开发时，agent（Trae/Claude 等）应遵循的规则。
> 核心目标：让「重构/改名」走项目自带的 MCP 工具，而不是用 grep+脚本手动硬改。

## 改名约定（强制优先用工具）

当任务涉及**重命名**（符号、函数、类、文件、变量）时，优先使用本仓库 MCP 暴露的
`rename_*` 工具，而非 `grep + 正则` 手动替换：

| 场景 | 必用工具 |
| --- | --- |
| 改一个模块级符号（函数/const/class/interface/type/enum） | `rename_symbol` |
| 批量改多个模块级符号 | `rename_symbols` |
| 改文件名并联动全仓 import 引用 | `rename_file` |
| 单文件内局部变量/形参批量改名 | `rename_many` |

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
- 每次提交前运行全量测试 `npm test`，须全部通过（当前基线 1376+）。

## 决策记录

- 工具收敛 / 命名 / 使用摩擦的决策记录在 `docs/tool-convergence.md`。
- 该文件易被外部工具还原，但每次 commit 即固化；以 git 历史为准。