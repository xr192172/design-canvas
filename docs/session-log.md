# design-canvas 会话变更日志

> 会话级交接日志：**每次开工前先读本文件**，了解排队期间项目发生了什么。
> 粒度：一批工作一段（做了什么 / 提交哈希 / 当前状态 / 下一步）。
> 架构决策级演变记录见 [evolution.md](./evolution.md)；动画系统设计见 [animation-design.md](./animation-design.md)。

## 2026-07-25 会话（分层披露功能开工）

**本批之前的基线**（此前会话已完成）：
- 主题系统（蓝色主调 + 可配置主题）、动画可读性（粒子分层/匀速/标签胶囊/图例/速度控制/单流聚焦）
- 双视图框架（节点视图/动画视图一键切换，动画视图交互式数据步进）`fb8534c`
- 边绕障（贝塞尔族 + A* 网格路由兜底）+ 节点重叠消解，crossings=0 `fb9e9ab`
- check_monolith 单文件监控 + Louvain 社区拆分建议 + 拆分预览 DSL `ff61a45`
- import_project 重跑 ai-base：多模块 go.mod 解析 + 依赖边 LCA 分层聚合（2145→352 条，crossings 1611→6）`85085bc`

**当前进行中：分层披露（layer 系统）**
- 设计共识：节点/边按职责分三层——main（主干数据流转，默认显示）/ error（异常处理，折叠）/ detail（文件内部数据变形链，折叠）；连线只画已展开层
- detail 层载体：就地展开（复用父子嵌套 + 父节点自动 resize），不用 sub_dsl 跳页
- 长期目标：detail 层绑定真实函数 + 数据形状标注 + 输入注入（异常值触发异常路径 = 发现问题）
- 待办：F1 渲染分层 + 展开交互 → F2 自动分层推导 → F3 动画分层激活 → 测试提交

**本批完成：F1+F2+F3 分层披露全链路**
- F1 渲染分层：深层节点/边 `display:none` 起步，宿主角标（⚠error/▸detail）+ 全局层开关展开；`isLayerExpanded` / `isNodeVisible` / `edgeHostOf` 可见性判定，折叠系统与层系统正交协作
- F2 自动推导：`deriveLayers` 从 `handler.errors[].to` 推导 error 层 + host=flow.from；主干职责豁免（flow from/to/branches.to 节点不推导）；显式 layer 优先；host 失效自动丢弃
- F3 动画激活：`flowDomVisible` 门控插在 `spawnDefaultParticle` 统一入口——端点隐藏时 flow 整体不执行（无语义/无粒子/无日志），展开后下周期自动恢复；粒子/高亮已有 display 检查兜底
- DSL/schema：`Node.layer` `Node.host` `Edge.layer` 三字段 + edit_dsl 三工具支持（add/update node/edge，host 存在性校验，null 清除回 main）
- 验证：218/218 测试通过（新增层属性/推导/豁免/F3 门控用例），tsc 零错误，17 个示例 HTML 全部重渲染
- 提交：`471ebc6` feat: 分层披露三层体系
- 下一步：detail 层数据变形链——完整设计已固化在 [animation-design.md](./animation-design.md) 第 10 节（文件=数据加工车间：进料口/加工链/出料口 + 形状卡 + 输入注入质检；实施顺序 D1 静态形状卡 → D2 变形链推导 → D3 注入回放）

**追加批：巨型图可用性修复（用户反馈 ai_base 产物看不懂 + 不能缩放）**
- 根因：缩放语义没考虑巨型画布——ai_base 8480×24746 fit 后实际显示仅 3.8%，固定 5 倍上限永远放不到可读尺寸；500+ 节点全平铺（v2 决策默认展开）开局即乱麻
- 缩放屏幕感知化：`fitScale`（scale=1 的实际显示比例）驱动一切——动态上限 max(5, 3/fitScale)（可达实际 300%）、巨图滚轮大步长 1.2、标签改显示真实百分比（scale×fitScale）、巨图（fitScale<0.5）初始直接实际 100% 居中内容包围盒（zoom-reset 同目标）；顺带修 zoom-fit 的 pan 公式（原公式符号错误，fit 时偏移不可见仅因整图都在视野内）
- 巨图默认折叠（v3）：节点 >100 且无持久化折叠状态时默认折叠全部目录容器，ai_base 开局 599 节点→5 个顶层容器；展开尊重嵌套折叠（逐级披露：展开 agent-shell→22 个直接子节点，子容器仍折叠）
- 边可见性统一：toggleCollapse 的 ad-hoc 边循环全部收敛到 applyLayerVisibility 全局规则（层可见 ∧ 两端点 DOM 可见），修掉跨容器边悬空；applyLayerVisibility 跳过 contains 边（始终保持隐藏）
- 顺手修：布局按钮成功后调不存在的 loadDSL() → 改 location.reload()（与 undo/redo 同策略）
- 验证：218/218 测试；浏览器实测 ai_base 初始 5 容器/100% 可读、缩小至 6% 全览、fit/reset 正常、折叠往返 5↔22；conveyor 小图回归无损（28/29 可见，1 个为 F2 推导的 error 层节点正常折叠）
- design-canvas.json 移出版本控制（MCP 运行时 DSL）`9cd644d`

**追加批 2：嵌套布局腐坏恢复与防护** `fcb739b`
- 事故：ai_base 曾被平铺布局（dag/force）作用，子节点逃逸出容器、画布残留 2380×68000 腐坏尺寸，viewBox 与实际内容脱节
- 恢复：新增 [relayout_nested.mjs](../scripts/relayout_nested.mjs)——按 contains 边递归重排容器（复用 import_project 布局常量），回写 geometry.width/height
- 防护：[dag_layout.ts](../src/tools/dag_layout.ts) 增加 `assertFlatLayoutSafe` 守卫，含 contains 边的嵌套工程图一律拒绝 dag/force 平铺布局（浏览器 auto-save 会持久化腐坏，不可逆）
- 排布优化：import_project 货架排布（shelf layout）——依赖退化（≤2 列）且条目 ≥3 时按高度降序逐行填充，行宽目标 √(总面积×1.5)，bbox 近 3:2，避免单列堆出万 px 高塔（cross-border-scout 曾 12834px）
- 视图适配：`fitVisibleContent` 按可见节点包围盒反推 scale，跳过折叠隐藏节点防幽灵占位撑大画布
- 杂项：.gitignore 扩展（output/ 全目录、.backup/、scripts/*.tmp.mjs）；删除临时脚本
- 验证：218/218 测试，tsc 零错误

## 2026-07-26 会话（D1 静态形状卡）

**本批完成：D1 静态形状卡——detail 层数据变形链第一步**
- DSL/schema：`Node.shapes` 字段（`{in?, out?}` 各一份 AnimationValueSchema）+ design_dsl.schema.json 同步
- 渲染核心 [shape_card.ts](../src/renderer/shape_card.ts)：`schemaToHuman` 人话转换——作者手写 label 优先（D2 LLM 语义标注落点）；对象 2 层嵌套预算（超限折叠为 …）；数组不消耗深度（`字符串[][][]` 仍可读）；enum 渲染为 `(a|b)` 取值集
- 渲染集成 [html_renderer.ts](../src/renderer/html_renderer.ts)：形状卡节点默认 240 宽、动态高度（34+rows×24+10）；标签置顶；foreignObject 内嵌 HTML 行（进/出前缀 + 人话形状），pointer-events=none 不抢拖拽；样式见 styles.ts `.shape-card/.shape-row`
- 编辑支持：add_node/update_node 增加 shapes 参数 + `assertValidSchema` 递归轻校验（type 枚举 + properties/items 递归，防渲染垃圾）；update 传 null 清除
- conveyor 示例：ContextComposition 下挂 4 节点变形链演示——进料口 → ① 预算核算 → ② 顺序组装 → 出料口，3 条 detail 层链边，全程 shapes 标注进/出数据形状
- 验证：239/239 测试通过（新增 shape_card 14 用例 + 渲染/编辑/e2e 用例），tsc 零错误，conveyor.html 重渲染确认 24 处形状卡标记
- 下一步：D2 变形链推导（TreeSitter 提取函数骨架 + LLM 语义标注，自动生成 detail 层节点/边）→ D3 注入回放（进料口编辑 JSON/预设异常场景）
