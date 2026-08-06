# Architecture Layer Visualization（架构分层着色）

> 类型：开发窗口实施单 · 创建：2026-08-06 · 优先级：中高
>
> 来源：[evolution.md](../evolution.md) 路线图序号 5（architecture-analyzer）+ 序号 7（Layer Visualization）。借鉴 vendor/Understand-Anything 的 `layer-detector.ts`（目录模式匹配 + 首中即止），适配本项目 TS 仓库并补充中文层名与配色。

## 0. 目标

按文件路径的**目录段/文件名模式**启发式推断每个文件所属架构层（api/service/data/ui/middleware/utility/config/types/test/entry，未匹配兜底 core），生成统一层定义；渲染器提供 **🎨 图层** 开关，一键在「语言色」与「架构层色」之间切换，并显示分层图例。

解决的核心问题：大型代码库动辄几十上百个文件，语言色只看得出"种类"，看不出"架构归属"；分层着色让"哪些文件属于同一层、层间如何划分"一眼可见。

## 1. 数据源（零新增数据管线）

| 数据 | 位置 | 说明 |
|---|---|---|
| 文件节点 | `dsl.geometry.nodes[]`（`type='file'`） | 节点 `description`/`id` 含相对路径，作为分层输入 |
| SemanticFile | `dsl.semantic.files[]` | 分层后把层名回填到 `responsibility` 前缀 |

分层是**纯函数**：`detectArchLayers(dsl)` 输入 DSL，返回加工副本（存储文件不动），为每个 file 节点写入 `arch_layer`，并生成 `dsl.layers` 供图例/着色。

## 2. 算法

`matchLayer(rel)`：把相对路径按 `/`（或 `\`）切段，去掉扩展名、统一小写，与每层的模式列表比对（`base === pattern || base === pattern + 's'`），**首中即止**（顺序敏感：更具体的层排前，如 renderer 命中 ui 而非 utility）。

层定义（id / 中文名 / 配色 / 模式）：
| id | 名称 | 色 | 关键模式 |
|---|---|---|---|
| api | API 层 | #4a7c9b | api, routes, controller, handler, endpoint... |
| service | 服务层 | #8b6fb0 | service, business, domain, logic, core... |
| data | 数据层 | #5a9e6f | model, entity, schema, db, repository, storage... |
| ui | UI 层 | #b07a8a | ui, component, view, page, renderer... |
| middleware | 中间件层 | #4a9b8c | middleware, interceptor, guard, plugin... |
| utility | 工具层 | #6a8fb0 | util, helper, lib, common, tools... |
| config | 配置层 | #c9a06c | config, setting, env, constants... |
| types | 类型层 | #4fa3c9 | types, interface, contract, dto, dsl... |
| test | 测试层 | #788291 | test, spec, __test__... |
| entry | 入口层 | #e07b5f | main, index, server, app, cmd... |
| core（兜底） | 核心层 | #65707e | 未匹配任何模式 |

## 3. 实现

- **L1 DSL 层**：`geometry.ts` Node 新增 `arch_layer?: string`；`types.ts` 新增 `ArchLayer` 接口并扩展 `DesignDSL.layers?: ArchLayer[]`
- **L2 启发式分层**：[layer_detect.ts](./src/tools/layer_detect.ts) `detectArchLayers`
- **L3 渲染层**：[html_renderer.ts](./src/renderer/html_renderer.ts) 节点加 `data-arch-layer` 属性；工具栏加 `🎨 图层` 按钮；生成 `layer-viz-css` 动态层色 CSS + `layer-legend` 图例；[styles.ts](./src/renderer/styles.ts) 补图例样式
- **L4 事件绑定**：[scripts.ts](./src/renderer/scripts.ts) `setupLayerViz` —— 按钮 ↔ `#canvas.layer-viz` 类 + 图例显隐
- **L5 接入**：[self_analyze.mjs](../scripts/self_analyze.mjs) 渲染前调 `detectArchLayers`，指标加「架构层」数
- **L6 验证**：[_l5_verify.py](../scripts/_l5_verify.py)
- **L7 工具化**：[arch_layer.ts](./src/tools/arch_layer.ts) MCP 工具 `arch_layer(feature, persist?)` + `POST /api/arch-layer`；`persist=true` 写回 feature 供渲染显示图层着色；单测 [arch_layer.test.ts](../tests/tools/arch_layer.test.ts)（4 通过）+ 冒烟 [arch_layer_smoke.mjs](../scripts/arch_layer_smoke.mjs)

## 4. 验收（✅ 全部通过）

- ✅ `detectArchLayers` 为全部 file 节点写入 `arch_layer`（self_analyze 63 个文件节点全部命中）
- ✅ 生成 `dsl.layers` 定义（self_analyze 命中 5 层：data/types/ui/utility/entry）
- ✅ 工具栏出现 `🎨 图层` 按钮，点击切换 `#canvas.layer-viz` 类 + 按钮 active 态 + 图例显隐
- ✅ 开启后节点按层色着色（data 层 computed fill = `rgb(90,158,111)` = #5a9e6f，与层定义一致）
- ✅ 图例展示层名/描述/计数，右上角悬浮
- ✅ 关闭切换还原语言色，无控制台报错

## 5. 实现备注

- 分层为**纯加工副本**，不修改存储 DSL；`arch_layer` 已存在不覆盖
- 层名同时回填到 `semantic.files[].responsibility` 前缀（职责回填，序号5）
- 层色选择深色主题协调的柔和色，避免与语言色/状态色冲突