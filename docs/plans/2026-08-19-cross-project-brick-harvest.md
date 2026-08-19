# 跨项目积木拎取（Brick Harvest）— 愿景与实施依据

> 日期：2026-08-19
> 来源：本窗口多轮讨论（盒中盒布局 → 局部解析 → DeepSeek Harness/Cordis 对照 → 屎山重构与语言归一化）
> 用途：沉淀"丢 N 张图 → 拎积木 → 拼新项目 / 绞杀屎山"的完整设计决策，作为后续开发依据
> 前置：思维导图盒中盒布局已落地（commit 70471b1）；本文档所有结论基于当日工具链盘点

---

## 一、愿景（早期愿景的回归与合流）

两个早期愿景在本文合流为同一条管线：

1. **拼新项目**：用户丢 N 个项目的图谱（DSL JSON）进来，说"我要 X 功能"，AI 从图中检索对应积木（社区/文件/符号），拎取、拼装成新项目。
2. **重构屎山**：老项目解析成图后，按功能重组、替换老依赖、逐块绞杀（strangler fig 模式），全程业务不断电。

**合流点**：两者共用同一前置能力——把任意项目解析成带契约的积木图。一份投入，两条战线。

## 二、概念对齐：DeepSeek Harness / Cordis 的映射

论文《A Programming Paradigm for Spatiotemporal Composability》（Cordis）核心思想与本项目映射：

| Cordis 概念 | design-canvas 对应 | 状态 |
|---|---|---|
| 万物皆插件（Everything is a plugin） | DSL 节点 = 积木注册表（功能/社区/文件，挂载卸载依赖全登记） | ✅ 结构同构 |
| 空间连续性（可逆 effect，拔插件副作用回收） | scaffold 增量映射（摘积木只动它自己的文件） | ✅ 设计时可逆 |
| 时间连续性（append-only 事件日志，换件不丢状态） | camera 事件流 + 决策卡版本栈 | ✅ 行为可回放 |
| Agent 自举（运行中自造/自换零件不崩） | MCP 工具链闭环（LLM 改 DSL → 投影代码） | ⚠️ 半闭环 |

**层次差异（诚实标注）**：Cordis 连续性是**运行时**语义（进程不重启、状态不丢）；我们目前是**设计时**语义（结构层可逆、行为可追溯）。积木复用只需设计时连续性，方向正确；运行时热插拔属 agent-shell 运行层课题，后置。

思维导图里已有的 7 条"Harness 借鉴"紫标注（compactionId 事务、shadow token 记账、tool-pairing 契约等）借鉴的是同一论文体系的会话层设计——两边本就同源。

## 三、管线就绪度盘点（2026-08-19 实测）

| 环节 | 现状 | 就绪度 |
|---|---|---|
| 1. 项目 → 图谱 | import_project：AST→符号→调用边→聚类社区→DSL，Go/TS 均支持 | ✅ 已有 |
| 2. 跨项目统一索引 | 索引按项目隔离（各自 cache.db），无统一命名空间 | ❌ 缺失 |
| 3. "我要 X" → 找到积木 | 三级检索（精确符号→语义向量→trigram）底子在，但仅单项目内 | ⚠️ 部分 |
| 4. 拎取闭包 | 拎文件必须连其 import 的一切打包；边已解析，闭包算法未成工具 | ❌ 缺失 |
| 5. 深度契约 | 签名级已有；"吃什么/吐什么/踩哪些宿主地基"（config/env/全局态/init 副作用）未提取 | ⚠️ 部分 |
| 6. 重组新项目 | scaffold 骨架投影在；缺实码搬运 + import 路径重接 | ⚠️ 部分 |

**上下文约束（必须遵守）**：全量 DSL 塞不进 LLM 上下文（单份七千+行）。"丢三张图"的真实工作方式 = 丢**摘要层**（积木人话描述 + 接口清单）→ AI 检索定位 → 按需下钻具体积木细节。摘要层（LLM 描述 + 三级检索）已有底子。

## 四、关键决策（讨论定论，勿翻案）

### 4.1 思维导图不再加嵌套功能
图是给人看的投影；**AI 的交换格式是 DSL JSON**（嵌套无上限，不存在展开收缩问题）。折叠收缩已存在。此决策已定，后续勿再往渲染层加"跨项目套层"。

### 4.2 语言归一化：统一契约层，不统一语法层
- ❌ 翻译路线（全项目先重写成 Go）：语义漂移风险、屎山无测试保护、翻译期业务冻结——一次豪赌，否决。
- ✅ 契约路线：解析契约入图，语言保持原样，Go/TS 积木同图可拼（管线已验证）。
- **Go 定位 = 终局偏好，非入场门票**：新积木默认 Go（语法表小/gofmt 统一/显式错误/快编译，对 LLM 生成友好——是"碰巧适合"，不是"专为 AI 设计"）；老积木不动，仅在重写时顺手转 Go。
- 类比：USB 统一的是接口，不要求所有设备同款芯片。

### 4.3 老依赖替换：契约匹配 + 适配器 + camera 验证
标准流程（依赖现代化）：
1. **契约提取**——积木"吃/吐/踩"清单（老依赖在"踩"清单）
2. **候选匹配**——新依赖满足同一契约即为合法替换者
3. **适配器过渡**——契约接口不变，底下垫适配器接新依赖，调用方零改动
4. **验证拆除**——camera 插桩比对行为等价（同输入→同输出序列）后拆适配器

本项目独有优势：camera 自动行为比对（传统靠人肉）。

## 五、实施路线图

### Phase 1：拎取闭包工具（算法活，量不大）✅ 2026-08-19 完成
- 输入：项目 + 文件路径（或符号）
- 输出：传递依赖闭包 + 分类（标准库 / 三方库 / 项目内部）+ 证据边
- 基础：import 边已在索引中解析
- **实现**：MCP 工具 `harvest_closure`（src/tools/harvest_closure.ts，14 号主工具）
  - 邻接表 = edges 表 import 边 ∪ 原始 imports 经 resolveImport 权威解析（复用 import_project 导出的 resolveImport/readGoModules/buildIndex，单一真相源）
  - 关键发现：Go 包导入不进 edges 表（只有 TS 相对导入建边），Go/Python 必须重走 resolveImport 解析；内部包（example.com/...）解析到项目内文件即算内部，不算外部三方
  - include_callers=true 连调用方生态一起端走
  - 测试：tests/tools/harvest_closure.test.ts 6 用例全绿（TS 闭包/证据链/callers/三分类/Go 内部包/异常路径）
  - 真实验证：design-canvas 自身 cache.db 上拎 diff_impact.ts → 11 内部文件（深度 3）+ 4 标准库 0 三方，证据链完整

### Phase 2：深度契约提取 ✅ 2026-08-20 静态阶段完成（commit 4073225）

**已落地**（静态阶段；writes/holds/emits 留待 Phase 2b camera 运行证据）：
- `extract_contracts` MCP 工具：role 依赖方向判定（种子识别 + 不动点传播，零 token）+ shapes 结构化类型提取（Go struct/interface + TS class/interface，nodes 符号行范围 + 源码解析）+ reads_config 扫描（process.env / os.Getenv）
- 契约写回 `SemanticFile.contract`（saveDSL 正规通道）；DSL schema 同步新增 BrickContract 定义
- `import_graph` 公共模块：文件级 import 邻接表，harvest_closure / extract_contracts 共用（依赖图单一真相源）
- 5 单测全绿 + 真实项目自检（storage.ts fan-in=49→functional 0.7 / server_registry.ts conf=0.65→正确落入 LLM 兜底候选 / import_project.ts 6 shapes）
- 在闭包输出上叠加：配置项/环境变量依赖、全局单例、init() 副作用、宿主框架地基接触面
- 产出"积木出厂说明书"：签名之外回答"这积木需要什么环境才能活"
- **四问决策（2026-08-20 讨论追加）**：
  1. **逆向方法论**：文件作用判定升级为动静结合——静态结构（AST）+ 运行证据（camera 事件流：被谁调/读什么 key/吐什么形状）+ 先验模式（LLM 语义索引）联合判定。三件套恰好构成逆向分析全套材料，缺的只是组合动作
  2. **业务/功能二分**（DDD 核心域 vs 支撑域）：判定以依赖方向图算法为主（功能不依赖业务，箭头永远指向功能层，零 token），LLM 语义兜底边缘案例；混合文件自动落业务侧（= 不值得拎，判定天然正确）。拼凑只检索功能文件；业务胶水层仍由 LLM 生成——分层互补而非替代。优越性核心：拎取的是"在生产跑过 N 次的代码"，生成的是"第一次运行的代码"；另享 token 经济（检索+引用 ~50 行 vs 生成 500 行）、修复杠杆（修一次全体受益）、可溯源（有出处）
  3. **契约 = 数据形状映射**：结构化类型匹配（Go interface 隐式实现 / TS 结构类型）为具体机制——契约核心产出是积木暴露/消费的结构体 schema；匹配 = 形状子类型检查；不匹配 = LLM 生成薄适配器（量小/边界清晰/可单测，恰是生成擅长的）
  4. **时空可组合性对齐**：作为契约 schema 的设计验收标准，不照搬 Cordis 运行时实现——空间可组合性 → 契约必须登记 effects 清单（写哪些外部状态/占哪些资源/发哪些事件，拔积木该回收什么设计时即知）；时间可组合性 → 跨积木状态变更必须走事件流（camera 事件流已是该形态，只需加约束）

### Phase 2.5：契约 Schema 设计草案（2026-08-20，基于三主线）

#### 设计原则
- **一切字段结构化、机器可判**（不做自由文本槽位——LLM 描述进 `notes`，判定依据进结构化字段）
- **文件级契约挂 DSL**（`SemanticFile.contract`，复用现有存储/渲染/diff 管线）；**积木级清单存独立注册表**（`.design-canvas/bricks/<name>.json`——积木是动态拎取产物，进 DSL 会膨胀）
- **提取来源必须标记**（`origin: 'ast' | 'runtime' | 'llm'`）——AST 免费且准，camera 证据贵但真，LLM 便宜但需验证；来源不同置信度不同
- **schema 自带 version**，后续演进走版本迁移而非静默变形

#### A. 文件级契约（DSL：`SemanticFile.contract?: BrickContract`）

```typescript
interface BrickContract {
  schema_version: 1;

  // ── 主线2：业务/功能二分 ──────────────────────────────
  role: {
    class: 'business' | 'functional' | 'hybrid';
    /** 判定依据：graph=依赖方向算法 / runtime=camera 证据 / llm=语义 / mixed */
    basis: 'graph' | 'runtime' | 'llm' | 'mixed';
    confidence: number;              // 0-1；< 0.7 时 Phase 3 检索降权
    reasons?: string[];              // 人话依据（如"依赖箭头全部指向 util 层"）
  };

  // ── 主线3a：数据形状（复用判定单元）────────────────────
  shapes: {
    /** 本文件导出/暴露给外界的形状 */
    exposes: ShapeSchema[];
    /** 本文件消费（参数/返回值/全局读取）的形状 */
    consumes: ShapeSchema[];
  };

  // ── 主线3b：effects 清单（空间可组合性验收单元）────────
  effects: {
    /** 写哪些外部状态（全局 var/单例字段/文件系统） */
    writes: EffectTarget[];
    /** 占用哪些资源（端口/goroutine/连接池/句柄）——拔积木须释放 */
    holds: EffectTarget[];
    /** 发出哪些事件（时间可组合性通道） */
    emits: string[];
    /** 读哪些配置项/env（积木"出厂环境要求"） */
    reads_config: string[];
  };

  // ── 主线1：运行证据（camera 动静结合）──────────────────
  runtime?: {
    /** 观测窗口内调用次数（0 = 纯静态判定，confidence 上限 0.7） */
    call_count: number;
    /** 实测高频调用方（校验静态依赖图，发现图上看不到的隐式调用） */
    top_callers: string[];
    /** 实测读过的 config key / 写过的 target——校验 effects 清单真实性 */
    observed_targets: string[];
    last_seen?: string;              // ISO 时间戳
  };

  provenance?: {
    source_project?: string;         // 外来积木溯源（本项目内为空）
    commit?: string;
    harvested_at?: string;
  };
}

interface ShapeSchema {
  name: string;                      // 如 "ContextGraph"、"User"
  kind: 'struct' | 'interface' | 'type' | 'class';
  fields: Array<{
    name: string;
    type: string;                    // 归一化类型串（"string"、"*ContextGraph"、"(int, error)"）
    required?: boolean;
  }>;
  origin: 'ast' | 'runtime' | 'llm'; // AST 提取 / camera 观测形状 / LLM 推断
  notes?: string;
}

interface EffectTarget {
  target: string;                    // 全局名/单例名/文件路径/env key
  op: 'write' | 'append' | 'delete' | 'acquire' | 'release';
  /** 回收方式（拔积木时怎么撤销）；缺省 = 不可逆，匹配时标红 */
  reversible?: string;
}
```

#### B. 积木级清单（注册表：`.design-canvas/bricks/<name>.json`）

```typescript
interface BrickManifest {
  name: string;                      // 如 "context-graph-writer"
  schema_version: 1;
  seed_files: string[];
  /** harvest_closure 的输出原样入档（内部闭包+外部三分类+证据边） */
  closure: {
    internal: string[];
    external: Array<{ source: string; class: 'stdlib' | 'third_party' | 'unresolved' }>;
  };
  /** 聚合视图：各成员文件 contract 的 shapes/effects 并集（检索货架用） */
  aggregate: {
    exposes: ShapeSchema[];
    consumes: ShapeSchema[];
    emits: string[];
    reads_config: string[];
  };
  /** 匹配记录：某次"端口需求 vs 本积木"的判定历史（可追溯为何选用/弃用） */
  matches?: Array<{
    port: string;                    // 需求方端口（接口名/形状名）
    verdict: 'exact' | 'adapt' | 'incompatible';
    adapter_file?: string;           // verdict=adapt 时生成的适配器路径
    at: string;
  }>;
}
```

#### C. 判定流水线（主线1 动静结合的实现顺序）

```
① 静态（零成本，import 时自动跑）
   AST → shapes.exposes/consumes（origin='ast'）
   依赖方向图算法 → role.class 初判（basis='graph'）
② 运行（camera 事件流，watch 累积）
   top_callers 校验依赖图 → role.basis 升级 'mixed'
   observed_targets 校验 effects 清单（漏登 = 契约不完整告警）
   runtime.call_count = 0 的文件 confidence 封顶 0.7
③ 语义（LLM，按需触发）
   仅对 confidence < 0.7 或 hybrid 文件跑 → basis 补 'llm'
   LLM 结论只进 role/reasons + notes，不进 shapes/effects
   （结构化字段只接受 AST/camera 两个可信源——LLM 不产生事实）
```

#### D. 两条验收标准（时空可组合性的落地判据）
- **空间**：拔积木模拟 = 遍历 `closure.internal` 各文件 effects，全部 target 满足 `reversible` 有值（或显式标"不可逆+影响说明"）→ 判定可安全拔除；存在未登记 effect（camera 观测到 writes 里没有的 target）→ 契约不完整，拒绝拔除
- **时间**：跨积木状态变更必须出现在双方契约里（A.emits ↔ B.writes/observed_targets）；camera 事件流中存在"绕过事件流的直接状态写入" → 违反时间可组合性，标记技术债

#### E. 与现有结构的挂接
- `SemanticFile.contract` 新字段（可选，向后兼容——老 DSL 无此字段视为"契约未提取"）
- shapes 复用 `Symbol`（kind=struct/interface/class 的条目升格为 ShapeSchema.fields）
- role.class 与 `layer` 正交：layer 是架构分层（api/service/data），role 是复用价值（functional 可拎/business 不拎）
- `reads_config` 未来可从 go flag 定义/env.Getenv/前端 config 读取点 AST 提取——Phase 2 实现范围先做 Go/TS 两语言

### Phase 3：三项目试验（端到端验收）
- 试验场：design-canvas（TS）+ agent-shell（Go）+ cross-border-scout（TS/Node），三种异构真库
- 流程：导入三项目 → 建索引 → 用户指定功能（如"LLM 调用封装"，三项目各有实现，顺便验语义去重）→ 检索、算闭包、出契约清单 → 拼新 DSL → 思维导图验收新积木盒
- 可选加验：指定一个老依赖，演示契约匹配 + 适配器替换全过程

### Phase 4：跨项目统一索引 + 摘要层
- 统一命名空间（多 cache.db 聚合或联邦检索）
- 积木货架：可浏览的接口契约目录（拎之前先看它要什么、给什么）

### Phase 5：实码搬运与重组
- scaffold 扩展：积木实码搬运 + import 路径重接 → 真正拼出新项目

## 六、验收标准（Phase 3 试验）

用户应能看到：
1. 思维导图上多出一个新积木盒（带 LLM 生成的人话介绍）
2. diff 显示只动了新积木自己的文件
3. 影响分析列出所有被波及的调用方
4. （若验依赖替换）行为等价比对报告

---

## 附：本轮已完成的渲染层工作（背景，非本文重点）

- 盒中盒递归布局 + 跳线（wire hop）已落地并全绿（正交 8/8、穿卡 0、跳线 2 处、40/40 卡入容器）
- 遗留小瑕疵（用户已知悉，低优先级）：跳线逻辑轻微问题；跨功能依赖弧在盒外呈连线状（那是依赖不是归属，归属已全靠嵌套表达）——后续可做成图层开关
