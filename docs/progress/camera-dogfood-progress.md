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

### 3. 设计↔实际对比的路径基底不一致（待决策）
- 设计 DSL 文件路径用仓库相对 `go-camera/internal/probe/probe.go`；
- 实際导入用 `project_dir=go-camera`，路径为 `internal/probe/probe.go`，少了 `go-camera/` 前缀。
- 后果：design⇄live 按路径对齐失效。需统一路径基底（设计 DSL 用与 live 导入相同的相对根）。

### 4. live_only 导入新 feature 不进设计注册表（真实 bug，已修复）
- `import_project(live_only=true, feature=新名)` 只在 live 存储，`get_dsl query=diff` 与 features 列表都找不到它。
- 正确意图：应导入到**已存在 feature 名**填充其 live 视图（🎭设计/⚡实际切换），而非开新 feature。
- **修复（bug #4）**：`diff_features` 增加 `view_a/view_b` 视图参数，改用 `getDSLByView` 读取；`get_dsl query=diff` 支持 `view_b=live`，从而能对比「设计 degine vs 实际 live-only」快照。回归测试：`tests/tools/diff_features.test.ts`。

### 5. manage_feature delete 对 live-only feature 抛 JS 错误（真实 bug，已修复）
- `manage_feature delete camera_live` 报 `Cannot read properties of undefined (reading 'feature')`。
- **根因**：`str()/req()` 直接访问 `args[k]`，args 为 undefined 时抛 TypeError。
- **修复（bug #5）**：`manageFeature` 对 `args` 兜底为空对象 `args = input.args ?? {}`，缺参时改抛清晰错误。回归测试：`tests/tools/manage_feature.test.ts`。

## 下一步（待办）
- 决策：统一设计 DSL 与 live 导入的路径基底，让 design⇄live diff 可对齐。
- 推进 P3 修订+验证门 / P4 循环+触发，及 TS 跨语言契约试点。