# 摄像头/探针迁移说明（copy 到 ai-base 原位置作交接）

> **2026-08-14**：摄像头/探针子系统已从 `ai-base/agent-shell/internal/probe` 迁移到
> `design-canvas/go-camera/`，作为 design-canvas 的一部分。**ai-base 原目录不再更新**。
>
> 把本文件复制到 `d:\project_develop\ai-base\agent-shell\internal\probe\GO_CAMERA_MIGRATED.md`。

## 迁移了什么

- `probe` 包全部源码（P1 完成：Sink/Event/Judge/DesignDSLStore/DSLCLI/LLMJudge）
- P2 新增：ActualDSLLoader + Aggregator + Comparator + CLI subcommand（actual/diff）
- 测试：`go test ./internal/probe/` 全部通过（19 个测试）

## 迁移后位置

- 模块根：`d:\project_develop\design-canvas\go-camera/`
- 探针包：`go-camera/internal/probe/`
- CLI 入口：`go-camera/cmd/camera-dsl/main.go`
- 数据仓库：`{projectRoot}/.agent/camera/`（设计 DSL + 观测画像）

## 解耦做了什么

1. `llm_judge.go` 的 `LLMSender` 接口从 `internal/client` 解耦为自包含的
   `LLMMessage`/`LLMResponse` 类型（接口不变，由装配层适配）。
2. 删除依赖 ai-base 的 e2e 测试（`camera_demo_test.go`、`camera_llm_e2e_test.go`）。
3. 模块路径 `go-camera`，仅依赖标准库。

## 后续方向

- P3 验证门审批（修订提案写盘权分离）
- 并入 design-canvas 主链路做代码异味探查