# design-canvas 设计文档

## 1. 项目背景

### 1.1 起源

这个项目源自 **agent-shell** 项目主脑（AI Agent）与左脑（另一个 AI Agent）的协作讨论。

主脑提出需求：
> 我想到和你们交流总是会有对不齐需求的地方，要不要设计一款工具，它要像图片，但不能是图片，我描述一个传送带模型，就要画出一个传送带，我说这个传送带有几个区域，就要动态渲染区域，我说每个区域有什么，就动态绘制出每个区域的特征，我说要设计一个页面，就出现一个页面，然后我说要有什么功能，就出现这个功能的区域，而且我同时还能手动挪动，调整页面的大小和形状、样式等，让它作为人机交流的桥梁。

左脑给出判断：
> 你要的不是"画图工具"，而是一个 **人机共享的可视化协议层**——人类用鼠标操作，LLM 用文字描述，双方在同一张"活图纸"上对齐。

主脑补充判断：
> 没有语义层，可视化只是画图软件；没有表达层，yaml 只是配置文件。用户要的是两者合一。

### 1.2 核心问题

人类和 LLM 协作开发时，需求对齐成本极高。LLM 输出文字描述（"系统有 A、B、C 三个模块，A 调用 B..."），人类在脑子里渲染成图，经常对不齐。

**典型场景**：
- LLM 描述"传送带模型有 L0/SummaryZone/SectionQueue/CurrentRound/DynamicInjection 五个区域"
- 人类脑补成线性流程图，但实际是嵌套结构
- 开发到一半发现理解错了，返工

**解决思路**：LLM 直接输出结构化 DSL JSON → 渲染成 HTML 网页 → 人类看图对齐 → 改 JSON → LLM 读改后的 JSON 继续迭代。

### 1.3 为什么是独立项目

不嵌进 agent-shell 的原因：
1. agent-shell 核心是上下文引擎，加可视化编辑器会分散精力
2. 这个工具价值不限于本项目，任何 LLM 辅助开发场景都能用
3. 作为 MCP server 对外开放，Claude Desktop / Cursor 等都能接入
4. 与 codebase-memory-mcp 形成"现状 + 规范"生态互补

## 2. 双层 DSL 设计（核心）

### 2.1 为什么是双层

单层 DSL 有冲突：
- **纯几何层**（x/y/width/style）：LLM 写坐标，人改位置后 LLM 再输出会覆盖人的修改
- **纯语义层**（文件/API/依赖）：没有布局信息，渲染器要自己排版，人不满意时无法手调

**双层方案**：几何层 + 语义层，通过 `id` 锚定。

- **几何层**（人编辑）：x/y/width/height/style——人拖拽调整布局，LLM 不写死坐标
- **语义层**（LLM 编辑）：path/responsibility/expected_apis/expected_deps——LLM 写目标态，人不改

人编辑位置不破坏语义，LLM 改语义不破坏布局。冲突解决靠 id 锚定。

### 2.2 DSL 示例

```json
{
  "id": "user_auth_diagram",
  "type": "feature_diagram",
  "feature": "user_auth",
  "version": "1.0.0",
  "title": "用户认证模块设计图",
  "status": "in_progress",

  "geometry": {
    "layout": "grid",
    "columns": 2,
    "nodes": [
      {
        "id": "node_user_go",
        "x": 0, "y": 0,
        "width": 400, "height": 200,
        "style": {
          "bg": "#0f3460",
          "color": "#ffffff",
          "borderRadius": 12,
          "border": "1px solid #e94560"
        }
      },
      {
        "id": "node_user_service_go",
        "x": 420, "y": 0,
        "width": 400, "height": 200,
        "style": { "bg": "#1a1a2e", "color": "#ffffff" }
      }
    ],
    "edges": [
      {
        "id": "edge_1",
        "from": "node_user_service_go",
        "to": "node_user_go",
        "label": "calls",
        "style": { "stroke": "#e94560", "strokeWidth": 2 }
      }
    ]
  },

  "semantic": {
    "files": [
      {
        "id": "node_user_go",
        "path": "internal/auth/user.go",
        "responsibility": "User struct + CRUD 方法",
        "expected_apis": [
          { "signature": "User.Login() (token string, err error)", "notes": "登录成功返回 JWT" },
          { "signature": "User.Logout() error", "notes": "登出后 token 失效" }
        ],
        "expected_deps": ["internal/db"],
        "expected_behavior": "登录成功返回 JWT token"
      },
      {
        "id": "node_user_service_go",
        "path": "internal/auth/user_service.go",
        "responsibility": "调用 user.go 的业务层",
        "expected_apis": [
          { "signature": "UserService.Authenticate(name, pwd string) (string, error)", "notes": "" }
        ],
        "expected_deps": ["internal/auth/user.go"],
        "expected_behavior": ""
      }
    ],
    "multi_file_invariants": [
      "user_service.go 必须调用 user.go 的 Login，不能直接操作 db",
      "user_test.go 覆盖率 >= 80%"
    ],
    "expected_global_behavior": [
      "登录成功返回 JWT token",
      "登出后 token 失效"
    ]
  },

  "annotations": [
    {
      "id": "anno_1",
      "target_id": "node_user_go",
      "text": "这里用 sync.RWMutex 保护 map",
      "author": "human",
      "created": "2026-07-21T10:00:00Z"
    }
  ]
}
```

### 2.3 字段说明

#### 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 图纸唯一 ID（URL 安全） |
| `type` | string | 是 | 固定 `"feature_diagram"` |
| `feature` | string | 是 | feature 名（用于 `get_dsl` / `list_features`） |
| `version` | string | 否 | DSL 版本（语义化版本号） |
| `title` | string | 否 | 人类可读标题 |
| `status` | string | 否 | `draft` / `in_progress` / `done` |
| `geometry` | object | 是 | 几何层 |
| `semantic` | object | 否 | 语义层（无则纯示意图） |
| `annotations` | array | 否 | 标注列表 |

#### geometry.nodes 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 节点 ID，语义层 file.id 通过它锚定 |
| `x`, `y` | number | 否 | 左上角坐标（px），缺省由 layout 自动排版 |
| `width`, `height` | number | 否 | 尺寸（px） |
| `style` | object | 否 | CSS 样式（bg/color/border/borderRadius 等） |

#### geometry.edges 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 边 ID |
| `from`, `to` | string | 是 | 节点 ID |
| `label` | string | 否 | 边标签（"calls" / "depends" / "imports"） |
| `style` | object | 否 | SVG stroke 样式 |

#### semantic.files 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 与 geometry.nodes.id 对应 |
| `path` | string | 是 | 目标文件相对路径 |
| `responsibility` | string | 是 | 职责描述 |
| `expected_apis` | array | 否 | 预期 API 列表 |
| `expected_deps` | array | 否 | 预期依赖路径 |
| `expected_behavior` | string | 否 | 预期行为描述 |

#### semantic.multi_file_invariants

字符串数组，每个元素是一条不变式规则（自然语言 + 可选代码引用）。`design_check` 工具会尝试用 codebase-memory-mcp 的 call graph 验证这些规则。

#### annotations 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 标注 ID |
| `target_id` | string | 是 | 指向 node.id 或 edge.id |
| `text` | string | 是 | 标注内容 |
| `author` | string | 否 | `human` / `llm` |
| `created` | string | 否 | ISO8601 时间戳 |

### 2.4 DSL 扩展点

未来可扩展（MVP 不做）：
- `animations`：动画定义（伪代码驱动流转，用于阶段 8）
- `tests`：测试用例定义（用于自动测试生成）
- `variants`：方案变体（同一 feature 的多个设计方案对比）

## 3. MCP 工具接口契约

### 3.1 `render_dsl`

**功能**：LLM 输出 DSL JSON → 渲染成自包含 HTML 文件。

**输入**：
```json
{
  "dsl_json": "<完整 DSL JSON 字符串>",
  "output_path": "<可选，默认 output/<feature>.html>"
}
```

**输出**：
```
已渲染：d:\project_develop\design-canvas\output\user_auth.html
（浏览器打开 file:///d:/project_develop/design-canvas/output/user_auth.html 查看）
DSL 已保存：d:\project_develop\design-canvas\.design-canvas\features\user_auth.json
```

**行为**：
1. 校验 DSL JSON（用 schema/design_dsl.schema.json）+ 锚定完整性检查（semantic.files.id 必须在 geometry.nodes 中存在）
2. 保存 DSL 到 `<cwd>/.design-canvas/features/<feature>.json`（项目本地持久化，按 cwd 隔离不同项目）
3. 渲染 HTML：DSL → HTML 字符串（内联 CSS+JS）→ 写文件到 output_path
4. 返回 HTML 文件绝对路径

### 3.2 `get_dsl`

**功能**：读取已保存的 DSL JSON。

**输入**：
```json
{ "feature_name": "user_auth" }
```

**输出**：DSL JSON 字符串，或错误"feature not found"。

### 3.3 `list_features`

**功能**：列出所有已设计的 feature。

**输入**：无。

**输出**：
```
已设计的 feature：
1. user_auth (in_progress, 2 文件, 1 不变式)
2. conveyor (done, 5 文件, 3 不变式)
```

### 3.4 `design_check`

**功能**：对比 DSL 目标态 vs codebase 现状，输出差距报告。

**输入**：
```json
{
  "feature_name": "user_auth",
  "codebase_path": "d:/project_develop/myproject"
}
```

**输出**：
```
[design_check] user_auth vs d:/project_develop/myproject

[ Missing ] internal/auth/user.go 不存在
[ Missing ] internal/auth/user_service.go 不存在

[ API Gap ] 期望 User.Login()，实际未实现
[ API Gap ] 期望 User.Logout()，实际未实现

[ Dep Violation ] user_service.go 不应直接依赖 internal/db（违反不变式 1）

[ Untested ] 未找到 user_test.go，覆盖率 0%（期望 >= 80%）

差距项：5 项
```

**行为**：
1. 读 DSL → 提取 semantic.files + invariants
2. 通过 codebase-memory-mcp 的 MCP 接口查 codebase AST
3. 对比：
   - 文件存在性（path 是否存在）
   - API 匹配（expected_apis 是否在 AST 中找到对应函数签名）
   - 依赖匹配（expected_deps vs 实际 call graph）
   - 不变式检查（multi_file_invariants 用规则引擎或 LLM 辅助验证）
4. 输出差距报告

**依赖**：codebase-memory-mcp 作为独立 MCP server，design-canvas 作为其 MCP client 调用。

### 3.5 `export_skeleton`

**功能**：图纸确认后，生成目标文件骨架。

**输入**：
```json
{
  "feature_name": "user_auth",
  "target_dir": "d:/project_develop/myproject"
}
```

**输出**：
```
已生成文件骨架：
- d:/project_develop/myproject/internal/auth/user.go
- d:/project_develop/myproject/internal/auth/user_service.go

每个文件包含：
- 包注释（responsibility）
- TODO 标记的 API 骨架（expected_apis）
- 依赖声明占位
```

**行为**：
1. 读 DSL → 提取 semantic.files
2. 对每个 file：
   - 创建目录
   - 生成文件内容：包注释 + TODO 标记的 API 签名 + 占位符
3. 不覆盖已存在文件（除非 `--force`）

## 4. HTML 渲染器设计

### 4.1 渲染原则

- **自包含**：单个 HTML 文件，内联所有 CSS+JS，零外部依赖
- **SVG 优先**：节点用 SVG `<rect>` / `<text>`，边用 SVG `<path>`，天然支持 hover 事件
- **语义卡片区**：画布右侧/下方列出每个 node 的语义信息（path/responsibility/expected_apis）
- **导出按钮**：HTML 底部固定按钮，点击 → 序列化当前 DOM 状态为 DSL JSON → 下载或复制到剪贴板

### 4.2 MVP 阶段渲染内容

- 几何层节点（矩形 + 标签 + tooltip）
- 几何层边（连线 + 标签）
- 语义层卡片区（每个 file 一张卡片，显示 path/responsibility/expected_apis/expected_deps）
- 标注层（点击节点弹出 annotations）
- 顶部信息条（feature 名 / status / 文件数 / 不变式数）
- 底部操作栏（导出 JSON 按钮 + 重新渲染按钮）

### 4.3 不做（MVP）

- 拖拽改位置（阶段 6）
- 内联编辑（阶段 6）
- 动画（阶段 8）
- 多人协作

### 4.4 HTML 模板结构

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>{{feature}} - design-canvas</title>
  <style>
    /* 内联 CSS：画布、节点、边、卡片、按钮样式 */
  </style>
</head>
<body>
  <header><!-- feature 名 + status --></header>
  <main>
    <svg id="canvas"><!-- 几何层节点 + 边 --></svg>
    <section id="semantic"><!-- 语义层卡片 --></section>
  </main>
  <footer>
    <button id="export-json">导出 DSL JSON</button>
  </footer>
  <script>
    /* 内联 JS：
       - DSL JSON 内嵌为 window.__DSL__
       - export 按钮事件：序列化 DOM → DSL JSON → 下载
       - tooltip 事件：hover 节点显示 annotations
    */
  </script>
</body>
</html>
```

## 5. 与 codebase-memory-mcp 集成

### 5.1 集成方式

design-canvas 的 `design_check` 工具作为 codebase-memory-mcp 的 MCP client：

```
LLM → design-canvas (MCP server)
            ↓ MCP stdio
       codebase-memory-mcp (MCP server)
            ↓
       codebase AST + call graph
```

### 5.2 调用流程

1. `design_check(feature_name, codebase_path)` 触发
2. design-canvas 读 DSL → 提取 semantic
3. design-canvas 调 codebase-memory-mcp 的 `index` 工具：
   - `index(action="search", query=path)` → 文件是否存在
   - `index(action="snippet", file=path)` → 文件 API 列表
   - `index(action="graph", file=path)` → 依赖图
4. 对比 DSL 期望 vs 现状 → 输出差距报告

### 5.3 codebase-memory-mcp 需要暴露的接口

design-canvas 依赖 codebase-memory-mcp 的以下 action：
- `search`：按路径/名称查文件
- `snippet`：取文件 AST 节点（函数/类/方法）
- `graph`：取 call graph（用于验证 multi_file_invariants）
- `trace`：取跨文件调用链

如果 codebase-memory-mcp 不支持这些 action，design-canvas 降级为"仅文件存在性检查"。

## 6. 开放性考量

### 6.1 MCP 协议兼容

- 标准 MCP server，stdio 传输
- 兼容所有 MCP client：Claude Desktop / Cursor / agent-shell / Continue 等
- 工具 schema 遵循 MCP 规范，参数描述清晰

### 6.2 DSL 开放

- DSL JSON Schema 公开（schema/design_dsl.schema.json）
- 社区可贡献示例（examples/ 目录）
- 渲染器开源，允许自定义主题

### 6.3 商业化路径（可选）

- **开源**：MCP server + 基础渲染器
- **付费**：多人协作云服务（WebSocket 实时同步）/ 企业版主题 / 自定义渲染插件
- **生态**：与 codebase-memory-mcp 联动，形成"现状 + 规范"工具链

## 7. 设计决策记录

### 7.1 为什么选 TypeScript 而不是 Go

- MCP 官方 TS SDK 最成熟
- 前端渲染（即使是 HTML 字符串）TS 更自然
- Claude Desktop / Cursor 等 MCP client 生态主要面向 TS server
- agent-shell 是 Go，但 design-canvas 独立，技术栈不绑死

### 7.2 为什么不用 React / Vite

- MVP 阶段渲染器是 HTML 字符串拼接，不需要组件化
- 自包含 HTML 产物（内联 CSS+JS）与 React 构建链冲突
- 阶段 6 双向编辑如果复杂度上升，可考虑迁移到 React

### 7.3 为什么不用 React Flow

- React Flow 偏流程图（节点+连线），design-canvas 场景是布局图（区域+特征+注释）
- SVG + 自定义布局更灵活
- 不依赖第三方拓扑库，渲染产物更轻

### 7.4 为什么 HTML 而不是 Web 服务

- 用户决策：HTML 网页最简单最合适
- 零部署成本：单 HTML 文件，file:// 协议打开
- 跨平台：浏览器即开即用
- 可分发：HTML 文件可邮件/IM 传输

### 7.5 为什么几何层 + 语义层分离

- 避免人 LLM 编辑冲突（见 2.1）
- 几何层可省略（让渲染器自动排版），但语义层必须有
- 支持纯示意图（只有几何层无语义层）和纯目标描述（只有语义层无几何层）

## 8. 与 agent-shell 的集成

### 8.1 agent-shell 作为 MCP client

agent-shell 在 bootstrap.go 中通过 stdio MCP 拉起 design-canvas server：

```go
// 伪代码
mcpClient.AddServer("design-canvas", "node", []string{
    "d:/project_develop/design-canvas/dist/server.js",
})
```

LLM 调用 `mcp__design_canvas__render_dsl` 等工具，agent-shell 转发到 design-canvas。

### 8.2 渲染产物访问

- design-canvas 写 HTML 到 `d:/project_develop/design-canvas/output/<feature>.html`
- 用户浏览器打开 `file:///d:/project_develop/design-canvas/output/<feature>.html`
- 可选：agent-shell 在 web UI 嵌入 iframe 显示渲染结果

### 8.3 与 toollist 工具联动

design-canvas 作为 MCP 工具，会自动出现在 agent-shell 的 toollist search 结果中。LLM 可以 `toollist pin("mcp__design_canvas__render_dsl", scope="session")` 固定到当前 session。

