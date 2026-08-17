---
name: "live-doc-sentinel"
description: "开发前先维护/查阅 design-canvas 活文档，写完用 camera 哨兵自检。Invoke when starting a new development task, before writing code, and when asked to self-test/accept a task."
---

# 活文档 + 哨兵（Live Doc + Sentinel）

把 design-canvas 的「活文档」和 Camera 的「哨兵」固化成每次辅助开发时的三条固定动作，而不是事后再想起的工具。

## 核心原则

- **活文档拦方向性错误**：开发前先看图对齐，避免写到一半返工。
- **哨兵拦运行期错误**：代码跑起来后自动发现静默丢错 / 未声明探针。
- **有偏差主动报，不闷头改**：发现偏离先给用户看，由用户拍板。

## 环境探测（MCP 优先，CLI 兜底）

Camera 是 design-canvas MCP 的一部分，**优先走 MCP 工具**：

1. **MCP 工具（首选）**：design-canvas 已注册为用户级（全局）MCP，本窗口若能看到
   `design-canvas` server，直接用其工具：
   - `camera_log`：按文件 / 全量查询 Camera 运行日志
   - `camera_judge`：对一批事件做偏差判定（静默丢错 / 未声明探针）
   - `camera_instrument`：对目标项目全自动插桩 / 还原
2. **camera-dsl CLI（兜底，MCP 不可用时）**：按顺序探测：
   - 已在 PATH：直接 `camera-dsl ...`。
   - Go 模块：design-canvas 项目内 `go-camera/`，在 `go-camera` 目录下用
     `go run ./cmd/camera-dsl --project-root <projectRoot> ...`。
   - 构建的二进制：若存在 `camera-dsl(.exe)`，直接用绝对路径调用。

若当前窗口没有 design-canvas MCP server，检查 TRAE 设置 → MCP → 用户级配置是否包含
design-canvas（绝对路径指向 `dist/src/server.js`），重启 TRAE 后生效。

`<projectRoot>` 取**当前工作区项目根**（就是正在开发的那个项目）。若当前项目不是 design-canvas，判定库会落在 `<projectRoot>/.agent/camera/`，互不干扰。

## 工作流（三条固定动作）

### 1. 开工前 —— 先看 / 先画活文档

接到新需求，**第一件事不是直接写代码**，而是：

1. 查该项目是否已有对应的 design-canvas 活化文档（`design-canvas.json` / `live/` 下的 DSL，或 MCP 的 `get_dsl` / `query_feature`）。
2. 有 → 先读懂现有设计，确认本次改动与它的关系。
3. 没有 → 用 design-canvas 的 `render_dsl` / `create_feature` 先画一版，让「这次要改成什么样」先变成一张用户看得见的图，对齐后再动手。

> 对齐成本在前端花掉，而不是写到一半再返工。

### 2. 写完等你验收时 —— 跑一遍哨兵

用户要求自测 / 验收时，顺手跑一次 Camera 判定，检查：

- **静默错误丢弃**（`design:silent-error-discard`）：本该处理的 `err` 是否被悄悄吞掉。
- **未声明探针**：代码里出现了设计契约没覆盖到的路径。

命令（在对应项目根执行）：

```bash
# 查看当前生效的设计 DSL（判定依据）
camera-dsl show --project-root <projectRoot>

# 对观测事件做闭环：偏差 → 未声明探针自动提案
camera-dsl loop <events.jsonl> --project-root <projectRoot>
```

如果项目通过 serve 跑起来且接了 Camera 哨兵，也可直接看 `/api/camera/log` 或 `/api/camera/judge` 的异常事件。

### 3. 有偏差 —— 主动报给用户，不闷头改

发现偏离后：

1. 把偏差拿到画布 / 面板上给用户看（明确是「设计契约内的可判定偏差」还是「未声明探针」）。
2. 说明影响与建议，由用户拍板（`propose` → 用户 `approve`，走验证门；写盘权分离，不直接改权威 DSL）。

## 触发时机

- 开始一个新的开发任务 / 接新需求时 → 触发「开工前」。
- 用户要求自测、验收、review 时 → 触发「跑哨兵」。
- 完成一段改动、即将提交前 → 快速自查一次是否有偏离。

## 注意事项

- 不重复插桩：插桩带幂等标记（`camera:instrumented` / `camera:deep`），重复执行不会重复注入探针。
- 写盘权分离：`propose` 只写 `proposals/`，绝不直接触碰权威 `dsl.json`；只有 `approve` 走验证门后才定稿。
- 低频演进：loop 有偏差率 + 未声明探针双阈值，未达阈值不自动演进，避免频繁改动契约。
- 保持自包含：本 skill 只承载工作流约定，不存任务数据 / 敏感信息。