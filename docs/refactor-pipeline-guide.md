# 确定性重构管线 —— 配置与运行指南

> 面向 "重构屎山" 场景的一键工具。把零散执行器串成一条自动执行链：
> **检测死代码 → 删除 → 统一增量验证 → 失败只回滚到最近绿点**。
>
> 归属仓库：`design-canvas`（人机共享可视化协议层，作为 MCP server 对外开放）。
> 当前内置语言：**TypeScript（含 JS JSX…）** 与 **Go**。

---

## 1. 它解决什么问题

给一个"积木式屎山"项目瘦身，最怕两件事：

1. **改了就坏** —— 重构助手删除 import / 语句后，项目过不了编译和测试。
2. **验证重复烧钱** —— 每个执行器各自跑"改前基线 + 改后重验"两轮全量 build，串起来会指数浪费。

本管线把**编排 + 增量验证 + 绿点回滚**上提为一条链：

- **入口只跑一次基线**（改前 build + test）。
- 之后每步都基于"上一步已绿"的盘上内容计算，所以每步**只需一次改后验证**。
- 某步改后验证回归 → **只回滚该步**，回到上一步绿点；前面已绿的改动保留。
- 基线黄 → **一个文件都不改**。

内置步骤：

| 步骤 | 作用 | 真相源 |
|---|---|---|
| `dead_imports` | 删掉指向"文件内零引用"三方源的 import / require / re-export 语句 | 未给 `dead` 清单时**自动文件级扫描**（一键）；给了就用你的清单 |
| `dead_statements` | 删掉 `return`/`throw`/`continue` 后不可达语句与死分支 | 自动扫描（可用 `files` 收敛范围） |

---

## 2. 前置条件

| 项目 | 要求 |
|---|---|
| Node.js | ≥ 18（本仓库 devDependency 均已锁版本） |
| 构建 | `npm install` 后先 `npm run build`（tsc） |
| 被重构目标 | 必须是**可构建、可测试**的项目 —— 验证闭环生效的前提 |

> **重要**：验证闭环（基线/改后/回滚）依赖目标项目能跑 `build` 和 `test`。若目标项目当前就是坏的（基线黄），管线会**拒绝执行、一个文件不改**，不会把坏地基的锅甩给首刀。

支持语言 == 验证命令自动探测：

- `go.mod` → `go build ./...` + `go test ./...`
- `package.json` → `npx tsc --noEmit` + `npm test`（若配了 test 脚本）
- 其它形态（含 Python/Java）→ 当前探测不出，返回"不可自动验证"，需人工显式给 `verify.commands`（见 §5）。

---

## 3. 接入与配置

### 3.1 方式 A：作为 MCP 工具（推荐给 LLM）

`refactor_pipeline` 已注册为 design-canvas MCP server 的工具。

```bash
cd design-canvas
npm install
npm run build        # 产出 dist/src/server.js
npm start           # 启动 MCP server（stdio 模式）
```

在 MCP client 配置（如 `.trae/mcp.json`）：

```json
{
  "mcpServers": {
    "design-canvas": {
      "command": "node",
      "args": ["<绝对路径>/design-canvas/dist/src/server.js"]
    }
  }
}
```

重启 client 后即可调用 `refactor_pipeline` 工具。

### 3.2 方式 B：作为 TS 库直接调用

```ts
import { runRefactorPipeline } from 'design-canvas/src/tools/refactor_pipeline.js';

const result = await runRefactorPipeline({
  project_dir: '/abs/path/to/your-project',
  steps: { dead_imports: { enabled: true } },
  verify: true,
});
console.log(result);
```

> 单测注入：`verifyImpl` 可注入 spy 验证执行器，不必真跑工具链（见 `tests/tools/refactor_pipeline.test.ts`）。

---

## 4. 工具参数（inputSchema）

| 字段 | 类型 | 说明 |
|---|---|---|
| `project_dir` | string | 目标项目根目录（必填，相对/绝对均可，最终 `path.resolve`） |
| `steps.dead_imports.enabled` | boolean | 开/关死 import 移除步骤（默认 false，须显式开） |
| `steps.dead_imports.dead` | `{source, files}[]` | **可选**。给定清单则直接用；省略则自动文件级检测（一键） |
| `steps.dead_statements.enabled` | boolean | 开/关死语句删除步骤 |
| `steps.dead_statements.files` | string[] | 可选，收敛扫描范围（相对/绝对路径）；缺省递归扫全部 TS/Go 源 |
| `verify` | `boolean \| {commands}` | `true`=自动探测验证命令并启用闭环；`{commands}`=自定义命令组；缺省/`false`=仅落盘不验证（结果标 `not_verifiable`） |

`dead` 清单元素格式与 `dead_deps` 报告一致：

```ts
{ "source": "lodash", "files": ["src/a.ts", "src/sub/b.ts"] }
```

---

## 5. 运行示例

### 5.1 一键（全部自动，推荐）

```json
{
  "project_dir": "/abs/path/to/your-project",
  "steps": {
    "dead_imports": { "enabled": true },
    "dead_statements": { "enabled": true }
  },
  "verify": true
}
```

管线：检测死 import + 死语句 → 删除 → 基线一次 + 每步一次改后验证。

### 5.2 自定义验证命令（目标项目形态探测不出时）

```json
{
  "project_dir": "/abs/path/to/python-project",
  "steps": { "dead_imports": { "enabled": true } },
  "verify": {
    "commands": [
      { "label": "py compile", "cmd": "python", "args": ["-m", "compileall", "-q", "."], "timeoutMs": 120000 },
      { "label": "pytest", "cmd": "python", "args": ["-m", "pytest", "-q"], "timeoutMs": 600000 }
    ]
  }
}
```

### 5.3 只查不改（先看报告再拍板）

`dead_deps`（闭包级）与 `detect_dead_imports`（文件级）是"只报告、绝不自动改写"的检测器，适合先给人类看报告：

```json
{ "project_dir": "/abs/path/to/your-project" }
```

（`detect_dead_imports` 产物结构与 `dead_imports` 的 `dead` 字段完全一致，可直接回填。）

---

## 6. 结果解读

`result` 结构：

| 字段 | 说明 |
|---|---|
| `ok` | 全程是否通过（任一改后回归回滚 → false） |
| `planned_steps` | 初始开启的步骤数 |
| `total_files_changed` | 被改写的文件数 |
| `total_units_removed` | 删除单位数（死 import 语句条数 / 死语句文件数） |
| `baseline` | 入口基线验证结果 |
| `stages[]` | 每步的 `outcome`（见下表） |

`stages[].outcome` 取值：

| 取值 | 含义 |
|---|---|
| `applied` | 已落盘且通过改后验证 |
| `no_change` | 该步无实际改动（不触发验证） |
| `not_verifiable` | 未启用验证，已落盘（不设 verify 时） |
| `rolled_back` | 改后验证回归，已回滚到上一步绿点（含 `detail`） |
| `skipped` | 该步未启用 |
| `baseline_fail` | 入口基线就黄（仅结果级 `ok=false`，阶段不产出） |

---

## 7. 保守规则与已知限制（读取前请悉知）

**宁漏报不误删**，检测信任优先，删除还过验证闭环：

- **Go**：空导入 `_` / 点导入 `.`（副作用，import 即执行）→ **恒活**，绝不误删。
- **TS**：副作用导入 `import 'x'`、re-export `export ... from`、语法不认识 → **恒活**。
- **文件级自洽判定**：某 import 的全部绑定在文件内零引用才算死；`import` 语句自身含绑定名，扫描时已剥离，不会假"出现"。
- **TS 注释里的同名出现**不剥离 → 只会多活，安全向。
- 死 import 只删"整条 import / require / re-export 语句"；语句内选择性删绑定（如 `import {a}` 里 a 死 b 活）不做，留给更细的剪枝。
- 死语句删除基于函数内控制流（`return` 后不可达）；跨函数 / 跨文件可达性**不看**——判定见文件内部，保守漏报多于误报。

> 性能提示：验证闭环用的是**全量** build + test（spawnSync 顺序跑）。步骤越多、项目越大，总耗时越长。这是"正确换取安全"的取舍。

---

## 8. 验收清单（给一把验一验）

1. **基线保护**：故意让目标项目坏掉 → 跑管线 → 结果 `ok=false`、目标文件**原封不动**。
2. **一键检测**：不提供 `dead`，仅 `steps.dead_imports.enabled=true` → 能自动删掉文件内零引用的 import，且活 import 保留。
3. **回滚**：构造某步改后验证失败 → 该步文件还原到上一步绿点，前面已绿的改动**不还原**。
4. **只查不改**：光调检测器（`detect_dead_imports`） → 只出报告，磁盘零改动。
5. 跑 `npx tsc --noEmit` 与 `npx vitest run` 全绿。

---

## 9. 扩展其它语言 —— 衔接文档

当前已注册执行器只覆盖 TypeScript 与 Go。管线骨架**已多语言化落地**：新语言实现一个
语言执行器（`isSourceFile` + `detectVerifyCommands` + 各步骤 `compute`），调用
`registerRefactorLanguage` 注册即可，`runRefactorPipeline` 会自动按项目探测拾取，**无需改管线主流程**。

给 Python / Java / Rust 等补执行器的开发契约与范例，请阅读交接文档：

👉 **[refactor-executor-contract.md](./refactor-executor-contract.md)**

它列出了已落地的语言无关执行器接口契约、注册入口、四段开发点，以及给下一个接力 AI 的目标语言实现范式（含 Python 范例）。