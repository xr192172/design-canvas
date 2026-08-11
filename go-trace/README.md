# go-trace — 编译期插桩工具链

从 `go-lab/agent-shell`（AI base 完整副本，已 gitignore）抽取出的**自包含、可提交**的
函数级仿真采集核心。仅依赖标准库。

## 组成

| 路径 | 作用 |
|---|---|
| `tracecap/` | 运行时记录库：`TraceEntry` / `TraceExit` / `TraceExitR` / `Flush`，记录每次函数调用的入参 recap、出参 recap、估算 token 成本、调用深度与 parent，落盘为 trace JSON |
| `cmd/trace-implant/` | 编译期插桩器（`go/ast` 重写）：为目标包每个函数注入 `TraceEntry` + `defer TraceExitR` 探针，支持 `-backup` / `-restore` 幂等改写 |

## 用法（在 go-lab 实验环境内）

```bash
# 1) 插桩目标包（原地改写，先备份）
go run go-lab/agent-shell/cmd/trace-implant -dir go-lab/agent-shell/internal/context/v2 -backup

# 2) 跑驱动采集 trace（context-trace 驱动真实 V2Manager，位于 go-lab 实验环境）
TRACE_OUT=... go run go-lab/agent-shell/cmd/context-trace -rounds 14

# 3) 接入 design-canvas 仿真
node scripts/gen_trace_reasoning_demo.mjs
```

## 注意

- `cmd/trace-implant/main.go` 中 `ttcImportPath` 常量指向上一个可提取、可提交的核心，但
  `context-trace` 驱动强耦合 `go-lab/agent-shell/internal/context/v2` 引擎（驱动真实上下文
  管理），**无法独立抽取**，仍留在 go-lab 实验环境。完整复现 trace 需 go-lab 环境。
- 若目标工程不在 go-lab 内，需通过 `-replace` 或调整 `ttcImportPath` 常量指向对应
  tracecap 包的可解析 import 路径。