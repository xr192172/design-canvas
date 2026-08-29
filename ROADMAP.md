# 后续开发路径 · ROADMAP

> 本文档固化 2026-08-28 两轮讨论的结论（竞品策略 / 许可与变现 / 前端缺陷审计 / 批注层设计 / LSP 级前端路径），防止上下文压缩丢失决策依据。开发时以此为准，如有变更先更新本文档。

***

## 0. 项目定位与当前完成度

* **一句话主线**：任意代码 → 积木（原料端）→ 可信组合（质检端），「契约」是两线共享的唯一插头。

* **完成度自评**：内部工具 ≈ 88%；作为开源产品 ≈ 62%。

* **当前梯度**：**T2 上沿 / T1 门槛**——代码与技术含量够 T1，卡在"发布运营"而非"开发"。

* **进 T1 缺的**（按优先级）：

  1. 外部真实用户（零用户是最大项）
  2. 发 npm 包 + GitHub Release 节奏
  3. 英文 README（国际开源基本盘）
  4. 5 分钟上手路径（demo 视频 / 教程）
  5. 社区（issue/PR/讨论）+ roadmap 对外可见

***

## 1. 前端竞品策略盘点（四类原型）

| 原型                | 代表                                                              | 特点                                           | 结论                 |
| ----------------- | --------------------------------------------------------------- | -------------------------------------------- | ------------------ |
| ① 图即码渲染           | Mermaid / D2 / PlantUML                                         | LLM 吐文本 → 静态 SVG，只读、零交互、无 schema 感知          | 双向绑定无从谈起           |
| ② 无限画布 + Agent 入画 | Cowart / tldraw / Teal Draw / brainboard / Fairies              | Agent 是画布里的合作者，"指哪打哪"；核心方法论=**结构化输出优于视觉生成**  | 与我们的核心假设一致         |
| ③ 活体流程图           | TDAD / Agent Canvas / React Flow 系                              | 产品=绿过红挂的流水线图，强于流程状态可视化，弱于真实代码结构              | 适合管线，不适合真实代码       |
| ④ 编辑器级语言服务        | Monaco/CodeMirror + LSP（RML Playground / monaco-graphql / mxls） | DSL 是可编辑可校验的活文档：schema 驱动补全、实时校验、hover、重命名重构 | **"LSP 级前端"的落地形态** |

### 我们前端的位置：2.5 类（结构化 IR 渲染 + 面板）

* 核心卖点独有：免连线·数据名匹配、版本对比 + 契约 diff、探针真回放、运行时契约回写、代码审批流。

* 交互模型是"渲染-查看-按钮"单向的，不是"编辑-校验-重构"双向的——这就是"还是有点那个"的根因。

### 画布选型决策（重要，勿再纠结）

* **不用 tldraw 重写**。理由：

  1. **价值错位**：tldraw 免费给的是无限画布交互外壳（平移/缩放/选择/拖拽/撤销），但数据名匹配、自动布局、契约 diff、探针回放、审批流全要自己写；它强的（自由手绘/随意摆放）恰恰是我们最少用到的。
  2. **重建成本**：现有前端已跑通真实数据全链路（后端 API → IR 归一化 → 渲染 + 探针回放 + 审批），换库=推倒重来且 shape 模型与语义自动布局冲突。
  3. **许可证硬伤**：tldraw 4.0（2025-09）改为**源码可用 + 商业许可**，生产要么付费（约 $6000/年）要么带水印 hobby 版；brainboard 已在"patch tldraw v5 绕过许可强制"（踩红线）。与开源/自持许可冲突。

* **不用 Excalidraw**：MIT 合规但同样价值错位。

* **采纳"无限画布"洞察为批注模式**：自研手写批注层（不依赖任何画布库），许可证完全自持。

***

## 2. 许可与变现模型

* **采用"源码可用 + 商业许可"（tldraw 模式）**。个人/非商业免费，企业商用需买许可。

* **具体分法（推荐）**：

  * MCP server 核心（协议层/数据层）：**MIT**——最大化采用率，别人能放心集成协议层。

  * 前端 dsl-workbench（产品层）：**双许可**——免费个人版 + 商业许可。像 tldraw 一样，前端是"产品"，协议层是"生态"。

* **变现阶梯**（按推荐序）：

  1. GitHub Sponsors / Buy Me a Coffee（为爱发电的直接变现）
  2. 企业商业许可
  3. 可选 Pro 便利功能（非核心）

* **不做广告位**：本地开发者工具（MCP server + 本地网页）没有广告网络流量、无分成；广告位伤信任（目标用户最恨广告）。最多 footer 放一个不刺眼的"赞助支持"入口。

* 因为画布自研，**许可证完全由我们自己定**，无外部约束。

***

## 3. 前端缺陷与 mock 占位审计（2026-08-28 现状）

| 类型        | 位置                                  | 问题                                                               |
| --------- | ----------------------------------- | ---------------------------------------------------------------- |
| 死数据       | `dsl-workbench/index.html` L50      | `最后扫描: 3分钟前` 硬编码，**无任何 JS 更新**（`#side-issue-count` 是真实的，JS 动态更新） |
| mock 数据源  | `dsl-workbench/src/data/sources.ts` | 内置 `conveyor`（raw/conveyor.json 静态快照）+ `mock`（纯手搓"骨架示例·用户系统"）    |
| mock 探针   | `dsl-workbench/src/main.ts` \~L430  | `runProbeMock` 后端不可达时本地模拟轨迹（诚实标注"模拟"，但用户看到假回放）                   |
| 无前端校验     | 整个前端                                | DSL 合法性只有后端知道，画布看不到"图背后的 JSON 有没有错"                              |
| 只读为主      | 画布 / DSL 源码视图                       | 编辑走后端审批流，缺"改了立刻见图变"的即时反馈                                         |
| 数据名匹配是启发式 | 渲染层                                 | 字符串匹配标悬空/重名，无真引用图谱                                               |
| 空状态生硬     | `main.ts` \~L1307                   | 后端不可达"未绑定代码目录"是合理但粗糙的兜底                                          |

**批注功能现状**：`annotations` 是 DSL 层字段（`{target_id, text, author}`），渲染在**右侧节点面板**当"节点注记问题"（`views.ts`）。是**文本注记**，不是画布手绘。画布目前只有"拖动节点调整流程"。

***

## 4. 后续开发路径（分阶段，每步可验收）

### 阶段 A · 许可与发布准备（先做，直接决定 GitHub 观感）

* [ ] 写双许可文案：MCP 核心 MIT + 前端双许可（LICENSE + 商用条款页）

* [ ] 前端 dsl-workbench：`git init` + 建 GitHub repo（当前**无 remote**）+ README + license + 去掉 `private: true`

* [ ] 主仓库 README 从"独立配套前端项目"链到前端仓库

* [ ] 演示图已换成真实前端截图（`assets/demo-workbench.png`，完成）

### 阶段 B · LSP 级前端（核心，跟画布选型正交）

* [x] **P0 浏览器内实时校验**：后端 `validator.ts` + schema 搬到前端，DSL 一变化画布当场标红 schema 错误。地基，改动最小。（完成）

* [x] **P1 DSL 源码视图可编辑**：只读文本 → 可编辑文本域 + 实时校验 + 应用/重置 + 脏标记。（完成）

* [x] **P2 数据名引用图谱**：把启发式数据名匹配升级为真引用图谱——注册表点数据名高亮所有产出/消费它的节点（定义蓝边实线 / 引用琥珀虚线）+ 画相关 flow 边 + 右侧面板列出引用位置可点击定位（= go-to-def / 引用）。（完成）

* [x] **P3 重命名重构**：改一个数据名 → 全图谱同步 + 走审批流回写 DSL/代码。实现：后端 `code_workbench.ts` 新增 `dsl_rename` 变更类型（`collectDslRenameEdits` 算影响面：产出节点 label/title + 所有承载该数据名的引用边；propose 干跑预览 → approve 真改 DSL）；前端引用图谱面板内嵌重命名表单（填新名 → 提交审批 → 干跑影响面 diff → 通过回写 / 驳回），通过后重拉后端 DSL 刷新画布/注册表。`verify_p3.py` 自动化闭环：propose→approve 后端回写 ✓ / reject 不改 DSL ✓ / 恢复原值 ✓。（完成）

### 阶段 C · 批注层（tldraw 视觉语言，自研手写）

* [x] DSL 新增 `canvas_notes` 字段（不进语义模型）：schema 定义 `CanvasNote`（highlight/arrow/sticky/text，世界坐标），后端 `serve.ts` 新增 `GET/POST /api/canvas-notes` 读写该字段，只动批注不动语义模型。（完成）

* [x] 手绘工具六件套：选择 / 抓手 / 画笔（高亮笔）/ 箭头 / 便签 / 文本，画布左上角迷你悬浮工具栏（含调色板 + 删除/清空/计数）。SVG 覆盖层挂 world 内 nodes 之上（z-index 30），批注模式关闭时 pointer-events:none 完全隔离；批注坐标=世界坐标随画布缩放平移；文本图元深墨文字+白底芯片+所选颜色左侧色条保证任意调色板下可读。持久化：防抖 800ms 写后端 + 进入时加载恢复；`verify_c.py` 自动化闭环：六件套创建 ✓ / 后端同步 ✓ / 重载恢复 ✓ / 清空还原 ✓。（完成）

* [x] 视觉语言（部分完成）：高亮笔琥珀半透明**双层笔触 + 45° 斜纹 pattern**（乘性混合，斜头马克笔质感）、便签纸黄**微旋转（按 id 稳定散列 ±1.8°）+ 右上折角 + 细阴影**、**圈注红色虚线椭圆**（浅红填充 + `stroke-dasharray`）、文本深墨白底芯片。`verify_c_visual.py` 聚焦放大截图确认斜纹/折角/虚线全部生效。（高亮斜刷 / 便签旋转+折角+阴影 / 圈注红虚线 完成）

* [ ] 视觉语言·点阵底：画布背景由浅灰线格改为 tldraw 风**点阵**（canvas 级背景改造，非批注层范围，单独排期）

* [x] LLM 通过后端读取批注照改 → 走现有审批流回写（人画"需求"，LLM 改"代码"，批注=中间语言）：语义化契约回传（`canvas_notes` status + `derive_mind_map` 语义工单 digest + MCP 双通道：`design-canvas://{feature}/notes` Resource 订阅 + `read_canvas_notes`/`mark_canvas_notes_status`/`decide_canvas_notes` 工具显式调用）；`decide_canvas_notes` = 内置 LLM 决策内核（`llm_decider.ts`）读 open 工单 → 逐单决策（change 映射 `code_workbench` 审批流 propose 干跑 / done 标已处理 / reject 标已驳回），LLM / mock / 规则降级三模式（mock 确定性验证接线，规则降级无 key 时诚实分类不伪造代码）。`agent_notes_loop.mjs` 双模式端到端验收：mock 18/18、真实 LLM（AGNES agnes-2.0-flash）16/16 —— 真实 LLM 对信息不足工单诚实 reject（引用 chain.ts 真实常量 512/4096/128、识别 server.ts 目标不匹配），未编造代码。（完成）

* [x] 项目文档注入（`project_docs.ts`，按批关联注入）：每项目一个文档夹（`<project_dir>/docs/`，兜底受管目录 `.design-canvas/docs/<feature>/`）丢 `.md` 即被索引；frontmatter 写 `files/steps/features` 精确关联、未标记文档按文件名关键词兜底匹配。`decide_canvas_notes` 决策一批工单时汇总批内涉及节点 → 只注入命中文档正文（TOC 全量 + 正文封顶 5 篇/300 行），token 省噪音小。双通道：`design-canvas://{feature}/docs` Resource（订阅式清单）+ `read_project_docs` 工具（清单/按名读正文/按 targets 匹配）。验收：清单/匹配/注入/Resource 全通；真实 LLM 借助文档后阈值类工单从 reject 转 done（"信息性备注，阈值需人工评估"）、目标错位识别更准。（完成）

* **决策（2026-08-28）**：批注层 vs 右侧「提交你的看法」→ **双通道并存**。批注=画布视觉标记（已真持久化 canvas\_notes），看法=针对节点的文本指令（当前 mock，属阶段 D 清理对象）。两者是「人→AI 改代码」的同族反馈通道但形态不同，统一收敛推迟到「LLM 读批注照改」落地时再议。

* [ ] mockup 已出（本会话 widget），实现时对照

### 阶段 D · 清理死数据与 mock

* [ ] 删/动态化 `index.html` L50 "最后扫描: 3分钟前"

* [ ] 明确 mock 来源切换路径，或接入后端后默认隐藏

* [ ] `runProbeMock` 保持诚实标注，但考虑加"未接后端"全局提示

### 阶段 E · 发布节奏

* [ ] 发 npm 包（MCP server）+ GitHub Release

* [ ] 英文 README

* [ ] 一份可跟做的 demo 视频

* [ ] 找 3\~5 个真实用户跑一轮收集 issue

***

## 5. 已知约束与坑（勿踩）

* **TRAE 沙箱不能写** **`D:\project_develop\dsl-workbench`**（Vite 要写 `vite.config.ts.timestamp-*.mjs` 临时文件被拦；`.git/index.lock` 也差点被拦）。运行/构建前端需要：把该目录加进沙箱允许列表，或用工作区副本（`design-canvas-main/dsl-workbench-tmp`）方式跑。

* **CI 测试依赖**：LLM 相关用例已在 `dict_gen.test.ts` 用 dummy env mock（fetch 已 mock）；macOS 需显式 `actions/setup-go`（已加）。

* **tldraw 许可证**：本项目不引入（见 §1），避免与开源/自持许可冲突。

* **前端暂不按竞品改**：先发后改，等真实用户反馈再动视觉；只借鉴"批注层"交互。

***

## 6. 待办（当前挂起，勿丢）

* [ ] 主仓库未提交改动：README（能力线表 + 演示图 + 前端分工）、CI（setup-go + LLM env mock）、测试（dict\_gen/derive\_split）、LICENSE、CONTRIBUTING.md、两个 issue 模板、`assets/demo-workbench.png`、本 ROADMAP.md

* [ ] 前端 dsl-workbench 未提交 WIP：`api.ts`（live 后端胶水 + 代码审批 M2 + trace-exec）等 +674 行

* [ ] 前端尚无 git remote / README / license

**四层导航链路遗留（详见 §7.4）**：

* [ ] 分镜缓存 key 升级为「功能名 + 文件集哈希/dsl\_rev」，分组变化自动失效，避免陈旧分镜复用

* [ ] L1 摘要「intro」模板前缀清理（前端 adapter 拼接残留）

* [ ] derive\_feature_tree 日志「17 个功能」off-by-one 修正（实际 16）

***

## 7. 后端数据审计与四层导航链路（2026-08-28）

> 背景：四层下钻（软件介绍 → 功能 → 实现路径 → 文件）在 dsl-workbench 落地后，审计后端
> 分类数据「是否对得上实际项目、符合人类阅读习惯」。结论：目录级功能合理，但存在**准大桶**
> 与**错位**。执行 A-E 全量调整 + F/G 管线修复，浏览器端到端验收通过。

### 7.1 审计发现（按严重度）

| # | 问题 | 说明 |
|---|------|------|
| A | tools 大桶 | tools/ 159 文件常被关键词匹配吞进单个「查询」功能，需按能力域拆分 |
| B | 真目录缺失 | dsl/db/daemon/storage 等纯定义/配置目录不生成功能，凭空消失 |
| C | 噪音社区标签 | 聚类锚点把数据结构名（MinHeap/Trie…）当社区名，LLM 直译「最小堆」仍是噪音 |
| D | 分镜降级无兜底 | LLM 失败即降级「1 文件 1 步」且无重试；camera 分镜需补全 |
| E | 文件归属漂移 | 文件按社区归属被跨目录拉走（camera/diagnosis 被拉进 tools 功能） |
| F | 查询解析准大桶 | ts\_kernel 内核、python\_refactor 子项目被误并，43 文件需瘦身 |
| G | L3 involves 错位 | 未引用文件按轮转硬塞步骤，与步骤语义对不上 |

### 7.2 已修（代码位置）

* **A 能力域拆分**：`derive_feature_tree.ts` `TOOL_DOMAINS`（9 域 design/query/refactor/observe/judge/edit/harvest/export/kernel），显式文件名清单优先 + 关键词兜底。
* **B 目录补全**：`isInfraPath` + 零社区目录直挂补功能（dsl/db/daemon/storage/ts\_kernel）。
* **C 标签清洗**：`NOISE_COMMUNITY_RE` 统一替换为「内部组件」。
* **D 分镜重试 + 分镜缓存**：`derive_mind_map.ts` 3 并发 mapLimit + 失败 4s 重试；分镜缓存 key=功能名 + steps≥3 复用，desc\_cache/community\_zh 按稳定锚点复用。
* **E 目录优先归属**：文件按自身目录/能力域归属，社区归属仅兜底。
* **F 查询解析瘦身**：ts\_kernel→工具内核(6)、python\_refactor→重构、annotation\_tools→设计，43→34 文件。
* **G involves 语义对齐**：`fileTokenSet`/`stepSimilarity` 词元相似度归属未引用文件，替代轮转分发。

### 7.3 重跑与验收（2026-08-28 已通过）

* 重跑链：`deriveFeatureTree`（feature\_tree 落 DSL）→ `deriveMindMap teach`（LLM 分镜）。
* 结果：DSL feature\_tree **16 个功能** · 200/200 文件完整归属（社区成员文件重叠，按语义层去重计）；每功能 3~8 步分镜。
* 浏览器实测四层导航（dsl-workbench :5174 连后端 :8123）：L1 软件介绍单节点（16 功能 · 200 文件）→ L2 16 功能 4×4 网格 + 拟人化描述 → L3 查询解析 6 步（入口扫描→推导功能树→思维导图→分类标注→术语字典→执行查询）→ L4 推导功能树 6 文件全带 `tools/` 前缀、语义贴合。
* Git：`e0b28e3`（A+B 前半）/ `8faf73b`（B+C+D+E）/ `c9a4d26`（F+G）。

### 7.4 遗留与后续（挂起）

* [ ] **分镜缓存 key 升级**（重要）：当前 key=功能名，若只改文件分组（名不变、文件集变）会复用**陈旧分镜**。升级为「功能名 + 该功能文件集哈希 / dsl\_rev」，分组变化自动失效重生成，分组不变则跳过 LLM。
* [ ] **L1「intro」前缀清理**：后端 overview one\_liner 本身干净（`design-canvas：由 16 个功能…`），「intro」是前端 adapter 拼接的模板前缀，应清成一句人话。
* [ ] **derive_feature_tree 日志 off-by-one**：message 报「17 个功能」而 DSL 实际 16，纠正日志计数。
* [ ] **export 域落位抽查**：export/render\_mindmap/registry/capability\_matrix/overview 等已并回能力矩阵/设计工作台，抽查落位合理性（已验证 200/200 无丢失）。

### 7.5 出边/入边保留 + 两期落地 + 画线方案改版（2026-08-28 已定）

* **结论：出边/入边设定保留并增强**（用户拍板）。新数据没体现「出边/入边调度」不是删掉它的理由——正是管线可能**少了、漏了这一步**的信号，所以保留设定并补上「推导 + 提示」能力。

* **一期（前端可见化，已完成）**：L3 步骤卡直接渲染 IN/OUT 针脚（`NavPin`：人话名 n + 来源类型简写 t；投影自涉及文件 API 签名，非编造），无针脚时面板给出「无法判断数据流向」的保守提示。

* **二期（后端真推导 + 前端缺口检测，已完成）**：
  * 后端 `deriveStepFlow`（`design-canvas/src/tools/derive_mind_map.ts`）按「数据形态名」保守匹配跨步连线（`TeachFlowEdge`）与管线缺口（`TeachGap`）：
    * `in_missing` 无入边 / `out_missing` 无出边 / `in_no_source` 入边无产出者 / `out_no_consumer` 出边无消费方。
    * 当前 teach 数据推导结果：**16 功能 · 0 连线 · 66 缺口**——连线 0 条是保守策略（跨步同数据名几乎无命中），缺口 66 条即「疑漏一步」的线索。
  * 前端：步骤卡右上角「疑漏步」警示角标（`unlink` 图标，悬停看原因），点击进面板看缺口明细；`backfill_stepflow.mjs` 幂等回填 gaps/flowEdges 到 teach JSON（不重生成 LLM 描述）。

* **画线方案改版（用户新思路，已实现）**：**不做连线，改做「上下游一度邻居高亮」**——点击某节点，不再画依赖线，而是把上游一度节点染蓝、下游一度节点染红，无关节点轻度虚化（`dslw-node-hl-in/out/dim`）；无连线时不高亮也不虚化。比画线干净、不铺满底图，与「埋点」哲学一致。

* **全视图高亮打通（用户决策：所有视图都要，已实现）**：点击高亮按「当前视图 edges」通用生效，逐层补齐数据源后 L1-L4 全覆盖：
  * L1 根视图：单介绍卡，无邻居可高亮（天然无需处理）。
  * L2 功能视图：跨功能边 `deriveCrossFeatureFlow`（唯一产出功能 → 消费功能）→ 根 `meta.crossEdges` → `featuresViewOf` 接 cross 边，点功能卡高亮上下游功能。
  * L3 步骤视图：跨步边 `deriveStepFlow`（同数据身份 + 唯一产出者）→ stepgroup `meta.flowEdges` → `stepsViewOf` 接 flow 边。
  * L4 文件视图（本轮新增）：逐文件针脚 `projectFileDataShape`（单文件单独投影「吃什么/吐什么」）挂 step `meta.filePins`；文件级边 `deriveFileFlow`（功能内全部文件跨步骤去重收集 → 唯一产出者「产出→消费」，方向不限）挂 stepgroup `meta.fileEdges`；`fileViewOf` 只保留两端都在本视图的边 → 点文件卡高亮同步骤内上下游文件。当前推导：**16 功能 · 跨步 13 条 · 跨功能 17 条 · 文件级 17 条**（缺口 413 条偏多是投影噪声，后续收敛）。
  * 实测（probe_hl_views.py）：L2 点功能 1 in / 14 dim；L3 点 s2 1 out / 5 dim；L4 点 tiered.ts → 下游 trace.ts 染红，文件卡渲染出/入针脚，0 控制台错误。

* **遗留**：跨步/文件级连线命中率仍保守（同数据身份 + 唯一产出者双重过滤）——若想让步骤/文件间真实连线更密，需提升针脚语义身份（如统一类型清洗规则 / 允许跨功能匹配 / 放宽唯一产出者到「功能内」而非「全局」）。文件级边的可见范围受限于「单步骤文件视图」——跨步骤的文件流（step2 文件 → step5 文件）不会在任一 L4 单步视图里亮起，如需全局文件依赖图需另建「全局文件图」视图。

