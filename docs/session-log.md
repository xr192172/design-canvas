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
- 提交：（见 git log 最新一条 feat: 分层披露）
- 下一步候选：detail 层数据变形链（输入→函数→输出形状标注 + 注入异常值回放）；非开发者可读性（每个文件"做什么/数据进什么样/出什么样"）
