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

**追加批：D2 变形链推导（工具侧）** `derive_detail_chain`
- 混合来源分工落地（animation-design 10.5）：工具干机械活（骨架/调用序/类型→shapes），LLM 干语义活（update_node 填人话 label + shapes.label + 聚合细步骤）——MCP 工具内无 LLM，标注留给客户端
- 骨架提取：ts_kernel parseFile 拿函数/方法符号；调用边用文本法（`name(` 出现即连边，按 body 内首次出现位置排序邻居），复用 monolith 文本引用图经验（<3 字符名跳过）；入口自动推导 = 入度 0 + 导出优先；DFS pre-order 得调用链
- 类型 → shapes：Go（滤 ctx/error、共享类型 `a, b int`、命名多返回包 object、`[]T`/`*T`/map）、TS（`name: type`、Promise 解包、`T[]`、union 取首）、Python（`list[T]`、无注解降级"任意"、self 滤除）
- 生成：detail 节点（layer+host+description=签名原文）宿主下方一行排布（220 宽 +20 间隔，同 conveyor D1 手工布局）+ 链边；`{host}__sN_` / `__chain_` 前缀幂等重跑；max_steps 默认 12 截断，其余进 skipped 名单
- 坑：① TS kernel return_type 字段自带冒号（type_annotation 节点含 `:`）需剥净 ② clearAllFeatures 只清 features/ 目录，测试隔离还要删活态 design-canvas.json
- 验证：252/252 测试通过（新增 derive_chain 13 用例：Go/TS/Py 三语言 + 幂等 + 截断 + entry 覆盖 + 错误处理），tsc 零错误，dist 冒烟（对自身 derive_chain.ts 推导）链序/shapes 正确
- 下一步：D3 注入回放（进料口 JSON 编辑 + 预设异常场景一键注入 → 回放暴露问题）；或对真实工程（如 ai-base）跑 D2 + LLM 语义标注全流程验证

**追加批：D2 真实工程验证（ai-base media_replacer.go）+ 推导质量修复**
- 验证流程两脚本化：[derive_real_aibase.mjs](../scripts/derive_real_aibase.mjs)（建宿主 → derive → dump shapes）+ [annotate_aibase.mjs](../scripts/annotate_aibase.mjs)（LLM 语义标注 + 渲染 HTML）——分工边界清晰：工具产物进来，人话写回去
- 目标选择教训：首选 summary_zone.go 是**扁平 API 面**（13 个方法互不调用，调用图全空），变形链退化为单节点——D2 适用对象是"含调用流水线的文件"，换 media_replacer.go（ReplaceImages→replaceImage→decodeDataURL/describeImage）后链条完整
- 修复① pickEntry 偏好最长链：旧策略"入度 0 → 导出 → 行号最早"会选中无调用的构造函数（NewSummaryZone/NewStore），真流水线入口在后面的方法上；改为入度 0 候选里 DFS 链最长者优先
- 修复② 扁平文件提示：chain=1 且文件多函数时输出"该文件函数互不调用（扁平 API 面）…建议换文件或显式 entry"
- 修复③ Go `[]byte`/`[]uint8` 特判为 `{type:string, label:字节串}`——推成 array<integer> 非开发者看不懂（真实文件里 []byte 满地都是）
- LLM 语义标注实做：4 步粒度判断为合适（无需聚合）；人话 label（① 扫描消息找图片 / ② 单图换位 / ③ 解码 base64 拿字节 / ④ 生成图片描述）+ shapes.label 全覆盖；未命名多返回 r0/r1 重命名为可读键名（图片字节/扩展名）
- 视觉验证（浏览器截图）：主节点角标 ⊖4 → 点击展开 4 detail 节点一行排开，链边箭头完整，形状卡 入/出 人话文本无溢出无重叠，PASS
- 坑：冒烟脚本重跑会把"已覆盖的活态文件"再次备份，毁掉真备份——备份需幂等（活态 feature==自身或备份已存在则跳过）；ai_base 活态文件从 .design-canvas/features/ai_base.json 存档恢复（599 节点无损）
- 验证：255/255 测试通过（新增 3 用例：最长链入口/扁平提示/[]byte），tsc 零错误
- 下一步：D3 注入回放（进料口 JSON 编辑 + 预设异常场景一键注入 → 回放暴露问题）

**追加批：D3 注入回放（工具侧）** `inject_replay`
- 设计锚点 §10.4 落地为纯静态推演：注入值替代 mock_results 作为 handler result → classifyError 异常分类（declared/undeclared/none）→ 正常值走 pickBranch 分支求值；全复用 anim_core 纯函数，零风险不改 DSL
- 形状质检闭环：handler.file_id 节点声明 shapes.out 时，ajv（allErrors, strict:false——label 等非标关键字被忽略）校验注入值，违例字段逐条列出 = "DSL 漂移或数据非法" 暴露
- 预设异常场景自适应构造：声明类型名≠condition 错误码（ErrBudgetExceeded vs BUDGET_EXCEEDED）——从 condition 提取字符串字面量作错误码候选，首个命中 decl.condition 的候选胜出；全不中则降级首选形态并在报告标注
- 坑：DesignDSL 新版动画字段是 animations_v2（flows），animations 是旧版 Animation[]——vitest 不做类型检查测试照过，tsc 才拦下；TS 项目别拿 vitest 绿当类型安全证据
- 实测 [inject_replay_conveyor.mjs](../scripts/inject_replay_conveyor.mjs) 六场景全对：list_presets / preset×2 / 预算内绿分支 / 超 80% 红分支 / NETWORK_TIMEOUT 未声明异常警报；脚本 finally 自动恢复活态文件（上次备份事故的教训固化）
- 验证：271/271 测试通过（新增 inject_replay 16 用例：异常路径/分支求值/预设场景/形状质检/错误处理），tsc 零错误
- 留作后续：进料口 UI 编辑面板（双击 → JSON 编辑 → 调用 inject_replay 回放）是交互糖，引擎已就绪
- 下一步候选：进料口 UI 面板；或对 ai-base 大图跑 import→derive→annotate→inject 全链路
