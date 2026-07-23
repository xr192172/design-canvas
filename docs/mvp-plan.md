# design-canvas MVP 实施计划

## 目标

跑通端到端：LLM 输出传送带 DSL → MCP server 渲染 → 用户浏览器打开 HTML 看图。

## 阶段 1：DSL Schema + 类型定义

**交付物**：
- `schema/design_dsl.schema.json` — JSON Schema 定义
- `src/dsl/types.ts` — TypeScript 类型定义（与 schema 对齐）
- `src/dsl/validator.ts` — ajv 校验器
- `tests/dsl/validator.test.ts` — 校验器测试（合法/非法 DSL 用例）

**验收标准**：
- [ ] 合法 DSL 通过校验
- [ ] 缺必填字段（id/type/feature）报错
- [ ] geometry.nodes.id 重复时报错
- [ ] semantic.files.id 在 geometry.nodes 中找不到对应 id 时报错（锚定完整性）

## 阶段 2：MCP server 骨架 + render_dsl 工具

**交付物**：
- `package.json` — 依赖（@modelcontextprotocol/sdk / ajv / vitest）
- `tsconfig.json`
- `src/server.ts` — MCP server 入口，注册 `render_dsl` 工具
- `src/tools/render_dsl.ts` — render_dsl 工具实现
- `src/storage.ts` — DSL 持久化（`~/.design-canvas/features/<feature>.json`）
- `tests/tools/render_dsl.test.ts`

**MCP 工具签名**：
```json
{
  "name": "render_dsl",
  "description": "Render a design DSL JSON to a self-contained HTML file. Returns the file path.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "dsl_json": { "type": "string", "description": "完整的 DSL JSON 字符串" },
      "output_path": { "type": "string", "description": "可选，HTML 输出路径，默认 output/<feature>.html" }
    },
    "required": ["dsl_json"]
  }
}
```

**行为**：
1. 解析 + 校验 dsl_json（含 schema 校验 + 锚定完整性）
2. 保存 DSL 到 `<cwd>/.design-canvas/features/<feature>.json`
3. 调渲染器（阶段 3）生成 HTML
4. 写 HTML 到 output_path
5. 返回：`已渲染：<abs_path>\n（浏览器打开 file:///<abs_path> 查看）\nDSL 已保存：<abs_path>`

**验收标准**：
- [ ] MCP client 能调 render_dsl，收到返回路径
- [ ] DSL 持久化到 `<cwd>/.design-canvas/features/<feature>.json`
- [ ] 非法 DSL 返回校验错误信息
- [ ] output 目录不存在时自动创建

## 阶段 3：HTML 渲染器

**交付物**：
- `src/renderer/html_renderer.ts` — DSL → HTML 字符串
- `src/renderer/templates/page.html` — HTML 模板（含占位符）
- `src/renderer/styles.ts` — 内联 CSS
- `src/renderer/scripts.ts` — 内联 JS（导出按钮 + tooltip）
- `tests/renderer/html_renderer.test.ts`

**渲染内容（MVP）**：
- 顶部 header：feature 名 + status + 文件数
- SVG 画布：节点（矩形 + 标签）+ 边（连线 + 标签）
- 右侧 semantic 卡片区：每个 file 一张卡片
- 底部 footer：导出 DSL JSON 按钮
- hover 节点 → 显示 annotations tooltip

**布局策略**：
- 节点有 x/y → 用绝对坐标
- 节点无 x/y → 按 layout（grid/flex）自动排版（简版：网格布局，列数取 columns）

**HTML 模板关键点**：
- `<svg id="canvas" viewBox="0 0 W H">` 自适应
- 节点 `<g class="node" data-id="xxx">` 包裹 rect + text
- 边 `<path class="edge" data-id="xxx" d="M...">`
- 卡片区 `<section class="cards">` 每张 `<article class="card" data-id="xxx">`
- 内联 `window.__DSL__ = <JSON>` 供导出按钮用
- 导出按钮：序列化 DOM 上的 data-* 回 DSL JSON → `Blob` 下载

**验收标准**：
- [ ] 给定示例 DSL，生成 HTML 文件
- [ ] HTML 用浏览器打开能显示节点 + 边 + 卡片
- [ ] hover 节点显示 tooltip
- [ ] 点导出按钮下载 `<feature>.json`，内容与输入 DSL 一致
- [ ] HTML 无外部依赖（断网也能正常显示）

## 阶段 4：传送带示例 + 端到端测试

**交付物**：
- `examples/conveyor.json` — agent-shell 上下文引擎传送带模型 DSL
- `tests/e2e/conveyor.test.ts` — 端到端测试
- `README.md` 快速开始章节（含 conveyor 示例）

**传送带模型内容**（取自 agent-shell v2 上下文引擎）：
- L0 永久层（KV cache 优化）
- SummaryZone（12 条摘要目录）
- SectionQueue（FIFO 队列，非破坏性折叠）
- CurrentRound（当前轮 + DraftZone 草稿段）
- DynamicInjection（memory_retrieve 跨层检索结果）

**端到端测试**：
```typescript
test('conveyor e2e', async () => {
  const dsl = fs.readFileSync('examples/conveyor.json', 'utf-8');
  const result = await callTool('render_dsl', { dsl_json: dsl });
  expect(result.content[0].text).toContain('已渲染');
  const htmlPath = extractPath(result);
  expect(fs.existsSync(htmlPath)).toBe(true);
  const html = fs.readFileSync(htmlPath, 'utf-8');
  expect(html).toContain('<svg');
  expect(html).toContain('L0 永久层');
  expect(html).toContain('CurrentRound');
});
```

**验收标准**：
- [ ] conveyor.json 通过 schema 校验
- [ ] render_dsl 成功渲染 conveyor HTML
- [ ] HTML 在浏览器打开显示完整传送带模型
- [ ] 文档（README + design.md）描述清晰

## 后续阶段（MVP 之后）

### 阶段 5：design_check 对比 codebase

- 实现 `design_check` 工具
- 作为 codebase-memory-mcp 的 MCP client
- 对比文件存在性 / API / 依赖 / 不变式
- 输出差距报告（纯文本）

### 阶段 6：双向编辑

- HTML 加拖拽事件（dragstart/dragend）
- 节点位置变化 → 通过 SSE/WebSocket 回写 server
- server 更新 DSL 的 geometry.nodes
- LLM 下次读 DSL 时看到新位置
- 冲突策略：人改 geometry，LLM 改 semantic，互不覆盖

### 阶段 7：export_skeleton 文件骨架生成

- 实现 `export_skeleton` 工具
- 读 DSL semantic.files
- 生成每个文件的骨架：包注释 + TODO API + 占位符
- 不覆盖已存在文件

### 阶段 8：动画预览

- DSL 加 `animations` 字段
- 伪代码驱动状态机（如传送带折叠过程）
- HTML 内嵌 JS 播放动画
- 可暂停 / 步进

## 技术栈清单

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "ajv": "^8.17.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.6.0",
    "@types/node": "^20.14.0"
  }
}
```

## 目录结构（最终）

```
design-canvas/
├── package.json
├── tsconfig.json
├── README.md
├── .gitignore
├── docs/
│   ├── design.md          # 完整设计文档
│   └── mvp-plan.md        # 本文档
├── schema/
│   └── design_dsl.schema.json
├── src/
│   ├── server.ts          # MCP server 入口
│   ├── storage.ts         # DSL 持久化
│   ├── dsl/
│   │   ├── types.ts       # TypeScript 类型
│   │   └── validator.ts   # ajv 校验
│   ├── tools/
│   │   ├── render_dsl.ts
│   │   ├── get_dsl.ts
│   │   ├── list_features.ts
│   │   ├── design_check.ts
│   │   └── export_skeleton.ts
│   └── renderer/
│       ├── html_renderer.ts
│       ├── styles.ts
│       ├── scripts.ts
│       └── templates/
│           └── page.html
├── examples/
│   └── conveyor.json
├── output/
│   └── .gitkeep
└── tests/
    ├── dsl/
    │   └── validator.test.ts
    ├── tools/
    │   └── render_dsl.test.ts
    ├── renderer/
    │   └── html_renderer.test.ts
    └── e2e/
        └── conveyor.test.ts
```

