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

**已落地**（静态阶段，含 effects 候选扫描；候选转正留待 camera 运行证据）：
- `extract_contracts` MCP 工具：role 依赖方向判定（种子识别 + 不动点传播，零 token）+ shapes 结构化类型提取（Go struct/interface + TS class/interface，nodes 符号行范围 + 源码解析）+ reads_config 扫描（process.env / os.Getenv）
- **effects 候选静态扫描（Phase 2b 静态半边，origin='ast'）**：writes（模块级变量赋值/自增 + 文件写删调用；`=(?![=>])` 防 `==`/`=>` 误报，Go `:=` 天然不匹配）、holds（listen/文件句柄/worker/timer/subprocess；Go 另有 goroutine/db-pool/ticker；exec 加 `(?<!\.)` 排除 db.exec 方法调用——agent-shell/db.ts 真实踩坑）、emits（Go chan send 逐行判 receive 跳过 + 关键字过滤防 `case <-ch:` 误报；TS emit/publish/postMessage）。EffectTarget 加 origin 字段：ast 候选 → camera 观测命中转 runtime
- **动静对账（Phase 2c 合龙，origin='runtime'）**：go-camera 新增 `effect` 探针级（`instrument --effects`，探索/契约模式皆可用）——collectPkgVars 收集包级 var，effectInStmt 检测四类点（包级赋值/自增 → kind=write；`ch<-v` → kind=emit chan:name；go 语句 → goroutine；Listen/sql.Open/NewTicker → hold），Capture 带 kind/target/op 与静态候选同构；已 import 探针包的文件跳过 import 注入（自初始化 sink 的 main.go 场景，camprobe redeclared 修复）。TS 侧 `reconcile_effects` 工具：流式读 events jsonl 过滤 level=effect，按文件聚合与 DSL 契约对账——命中转正（ast→runtime）、候选外补录+incomplete 告警、未触发保持 ast（不证伪），填充 contract.runtime（call_count/top_callers/observed_targets/last_seen）与 provenance.last_reconciled；hold 粒度适配（探针 listen ↔ 候选 listen:8080 前缀匹配）。e2e 验证：临时 Go 项目全链（extract_contracts 候选 → instrument --effects → go run → reconcile），Count/ErrClosed/chan:done 三候选全部转正，局部变量不进契约，5/5 机械断言通过
- 契约写回 `SemanticFile.contract`（saveDSL 正规通道）；DSL schema 同步新增 BrickContract 定义
- `import_graph` 公共模块：文件级 import 邻接表，harvest_closure / extract_contracts 共用（依赖图单一真相源）
- 8 单测全绿 + 双真实项目验证：design-canvas 自身（storage.ts 7 writes 全真：dslChangeCallback/file 写；db.ts SQL exec 误报已修）+ agent-shell Go 全库（199 文件：151 写/65 占用/16 事件；corpus_journal 的 `write file:shard | delete file:oldest` 即"拔积木回收清单"实例；chan 全为真通道 done/inbox/m.queue）
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

### Phase 2.7：五问决策（2026-08-20 第二轮：积木盒形态与自举）

1. **积木盒，不保留原项目**：积木盒 = 自包含快照（闭包文件内容 + BrickContract + BrickManifest 三件套），不是对原项目的引用。原项目降级为 provenance 冷记录（git URL + commit hash），不保留工作副本。理由：引用式随上游演化腐烂而快照不会；上游修复凭记录可重抽（修复杠杆不丢）；契约在快照内，溯源无需活项目
2. **行为内化成编排工具**：目标场景"用户说哪个项目好 → 拉取 → 解析 → 抽积木 → 入盒"是一条编排链（浅 clone → import_project → extract_contracts → 挑积木 → harvest_closure → 入盒）。原子工具已齐，Phase 3 补 `harvest_from_url` 编排层串起来，不重写
3. **一切皆插件 = 收敛终点，design-canvas 自举**：最终开发收敛成"一切皆插件"格式（对应 Cordis 映射表第一条）；design-canvas 自己成为第一个用积木机制重构的对象——Phase 2 已给自身抽了契约，dogfood 有基础，自举路径已通
4. **二分线精确化：能力 = 功能线，决策 = 业务线**：生图管线（prompt 组装/API 调用/落盘/路径管理）是功能积木，跨项目可复用；"这个页面要什么图、配什么文案、怎么布局"是业务线。CSS/主题系统/设计 token 是功能积木，只有页面级组装决策是业务。前端项目里功能线远多于直觉判断
5. **camera 插桩精度：定向补 effects 探针，不全面细化**：函数级插桩对调用链观测够用，但 Phase 2b 的 writes/holds/emits 证据给不了（函数级 Capture 不知道写了哪个全局变量/占了哪个端口）。解法是动静结合在 effects 上的应用——AST 静态筛候选点（全局赋值/单例字段写/文件写/端口监听/chan send/emit 调用）→ 只在候选点插桩 → 执行时 Capture target+值摘要。不做全量语句级插桩（爆炸，违反 bounded memory 硬约束）

### Phase 2.8：验证四层模型（2026-08-20 第三轮：不变量验收 + 人类效果锚定）

背景讨论："测试用例通过，能判断算法对吗？"（案例：3D 左移 10 厘米）——Dijkstra：测试只能证明 bug 存在，不能证明不存在。测试是点采样，正确性是全称命题。由此沉淀四层错误模型，每层一种武器：

| 错误层 | 案例（左移10cm 出错） | 武器 | 归属 |
|---|---|---|---|
| ① 语义层 | 坐标系约定错（Y-up vs Z-up）/ 需求理解错 | **人类效果验收**（眼见即锚定） | 人 |
| ② 数学层 | 变换矩阵推导本身错 | **不变量属性测试**（铁律断言 + 随机输入全域撞） | 机器 |
| ③ 集成层 | 单位传成米、轴传错、矩阵乘反序 | 契约形状匹配（当场失配）+ camera 观测实际入参 | 机器 |
| ④ 行为层 | 声明左移、代码实际右移 | **camera 动静对账**（Phase 2b 在做） | 机器 |

本轮三条关键洞察（用户提出①，为最重要沉淀）：

1. **人类效果验收是语义层主场，且是人类成本最低的验证**——"达成自己想要的效果即通过，未达成即不通过"。人不需要懂矩阵，看一眼屏幕即可判左移对错。这与协作规则"每阶段必须产出可眼见 artifact"同构：效果验收不是体系弱点的补丁，而是把人放在验证效率最高的位置。人偏好使用而非创造——"使用效果"恰好就是最自然的验收判据
2. **camera 是测谎仪，不是数学老师**：查"言行一致"（契约声明 vs 运行时观测），不查"言本身对错"——契约里"左"的定义写反了，camera 会忠实记录错误行为后绿灯通过。言行一致与言之为真是两个正交命题
3. **数学内核不自己写 = 验证手段的延伸**：three.js 矩阵被百万项目锤过二十年，抽积木复用即继承其验证履历。左移出错几乎必在①③层（约定/接线），恰是人与契约的主场；②层错误在使用成熟库的场景下概率极低

落地动作：
- `BrickManifest` 增 `acceptance` 槽位 ✅（2026-08-20 第四轮落地）：
  - `invariants[]`：数学铁律断言（name + assertion + source + ref），属性测试可执行（fast-check / Hypothesis）。来源优先级：源项目自带的属性测试文件（source-test，带 ref 可回溯）> LLM 提议 + 人确认（llm-proposed，拍板前不可当已验证事实引用——"LLM 不产生事实"纪律不变）
  - `effect_check`：人类效果验收锚点描述（"左移10厘米后，眼见物体在原位置左侧10cm"）——LLM 不可代判，语义层专属
  - **三积木首填**：cg_wal_valve 8 条（全部 source-test，钉自 vendor `__tests__/wal-deferral.test.ts`——触发/静默/基线前移防自旋/去重/终止/作用域）；ua_ignore_filter 5 条（source-test，钉自 `ignore-filter.test.ts`——默认覆盖/源码放行/反选/优先级/递归）；ua_theme_engine 4 条（llm-proposed 待拍板：纯函数性/hex 解析/幂等/token 完备性）
  - **重抽保留机制**：harvest_from_url 覆盖快照前先读旧 manifest，acceptance/matches 原样继承（人工沉淀只有一份，机器可重算字段照常刷新）；单测 + 真实 wal_valve 重抽 e2e 验证（8/8 存活，closure/harvested_at 刷新）
- 验收失败案例回流成新判据（Goodhart 解药：当验收变成目标会扭曲——判据自身必须参与进化，与"bug 变测试用例"同构）
- 画布/渲染坐标系约定写显式文档（语义锚定的最小落点，design-canvas 内一份即可）

### Phase 3：编排工具 ✅ + 三项目试验（端到端验收）

**编排工具已落地** ✅ 2026-08-20（harvest_from_url）：
- `harvest_from_url` MCP 工具：一句"这个项目好，抽它"的完整链——浅克隆（git URL）/本地目录原地 → walkFiles+syncProject 纯建索引（不走 importProject，避免写 DSL feature 污染列表）→ extract_contracts（return_contracts 内部消费契约本体，MCP 直调勿开防 token 爆）→ 选积木（显式 seeds 或 auto：functional + fan_in≥2 + confidence≥0.7 按 fan_in 降序，静态封顶恰 0.7 所以 ≥ 成立）→ harvest_closure 闭包 → 入盒三件套
- 积木盒落位（Phase 2.7 决策实现）：`<dataHome>/.design-canvas/bricks/<name>/` 下 manifest.json（BrickManifest：闭包档案+聚合契约+provenance 冷记录）+ contracts.json（闭包全体 BrickContract）+ files/（闭包文件快照）；同名重抽 = 覆盖更新（replaced 标记）；单积木闭包 >50 文件自动跳过（防整项目端走）
- 工程细节：extract_contracts/harvest_closure 经 getProjectCacheDb 连接池占住 cache.db 句柄，harvest 收尾必须 closeProjectCacheDb 释放（Windows 删临时目录 EBUSY 实测踩坑）
- 7 单测全绿：本地全链三件套/auto 选积木（fan_in=3 util 唯一够格）/dry-run/闭包超限跳过/重抽替换/种子缺失/git URL e2e（file:// 浅克隆 + commit 记录 + 临时目录清理）

**三项目试验 → Phase 3R 重构实验**（2026-08-20 启动，按重构思路推进）：

试验场改为重构视角：design-canvas（TS）+ agent-shell（Go）+ cross-border-scout（Python），三种异构真库；目标从"拼新项目"扩展为"重复检测 + 积木拎取 + 胶水绞杀盘点"（用户定位：重构出更科学的、有时空/空间连续性运行层的结构——空间连续性 = 闭包自包含拎走即跑，时空连续性 = provenance 溯源链 + 重抽保留）。

**3R-1 vendored 过滤规则** ✅ 2026-08-20：
- 问题：auto 选种混入 vendored 第三方克隆（scout 的 nodriver/crawlee-python）与 gitignore 实验克隆（design-canvas 的 go-lab/agent-shell）——前者的 fan_in 是库内部引用而非宿主复用信号，后者是索引污染（agent-shell 代码被当成 design-canvas 积木候选）
- 实现：`underVendoredRoot`（harvest_from_url.ts）——祖先目录（非项目根）携带嵌套 `go.mod`（独立 Go module，100% 信号）/ `pyproject.toml`·`setup.py`·`setup.cfg`（Python 打包件）/ LICENSE+README 并存（完整镜像特征；单 package.json 不算——monorepo 子包是一方代码）即判 vendored
- 纪律：**显式 seeds 不拦**（人的判断优先），仅 auto 机器自选受约束；被排除候选进 skipped 报告（带原因），不静默消失
- 效果：三项目候选全部换血——design-canvas 从 go-lab 假候选换成本体真候选（db/symbols.ts exposes=16、ts_kernel、llm_focus 等）；scout 从 nodriver 换成 src/llm.py（closure=12、不可逆=0）
- 单测 8/8 全绿 + tsc 通过

**3R-2 重复事实证明 + go_logging 入盒** ✅ 2026-08-20：
- 首个跨项目重复实证：agent-shell `internal/logging/` 四件套（file/logging/rotate/router.go）在 design-canvas `go-lab/agent-shell/internal/logging/` 有手工副本，四文件 MD5 **逐字节相同**——"重复不是巧合，是积木该被抽走的信号"
- `go_logging` 积木从 agent-shell 活仓库正式入盒（provenance=agent-shell@040843fc）：closure=4、exposes=5、纯 stdlib（ext 8/0/0，零三方依赖=拎走即跑）、不可逆=10（写日志天然副作用重，回收清单在契约里）
- 绞杀处置：go-lab 是 gitignore 的 go-trace 插桩实验环境（README 记录用途），不删；其作为积木来源的资格已被 3R-1 过滤规则消除——盒中快照成为唯一事实源，go-lab 仅保留插桩实验用途
- 待做：go-lab 与活仓库的漂移监控（当前零漂移）；agent-shell 侧是否反向引用盒中积木（Go module 语义下需 publish 路径，暂缓）

**3R-3 go_logging 动静对账（camera 验证积木契约）** ✅ 2026-08-20：
- 方法：积木盒快照 4 文件 → golog-verify 临时项目（module 名对齐 agent-shell + replace 指向本地 go-camera）→ 驱动 main.go 覆盖全 API 路径（InitFileLogger/SetCurrentSession/SetVerbose/SetDebug/五级日志/路由分流/批量写/Reset/Close）→ `instrument --effects` 插桩（instrument.exe 重编译）→ 运行收集 1983 行事件（含 7 类 effect）→ 对账回写
- **转正 6/10**：globalFileLogger、currentSession（file.go）+ Verbose、Debug、lastSeen、lastSeen[]（logging.go）origin ast→runtime；contracts.json 各文件填 runtime（call_count/top_callers/last_seen）
- **未观测 4/10 全部归因**（诚实分类，不硬凑）：file:filepath.Join(delete)+goroutine = not_triggered（100MB 轮转阈值未达，`go cleanupExpired` 仅在 rotateLocked 内启动）；file:r.basePath = **probe_gap**（插桩器四类检测点不含 os.Create 文件句柄——静态候选有、探针无检测点，工具改进项）；routeTable = **static_only**（包级字面量初始化被静态扫描记 write 候选，运行时只读——静态候选固有噪声）
- 已知盲区（记入档案）：Go init() 先于 main 执行，logging.init 的 3 个 effect 探针点在 sink 注册前运行观测不到（驱动侧 sink 初始化时机固有限制）
- 机制落地：BrickManifest 新增 `effect_verification` 槽（证据档案：verified_at/method/events/stats/files/known_blind_spots，未观测候选带归因 note）；harvest_from_url 重抽保留扩展（acceptance/matches/**effect_verification**——运行证据只有一份，快照可重抽证据不可重放）；contracts.json 转正 + runtime 字段照常重算
- 工程细节：插桩代码 import go-camera/probe 需 go.mod replace 指向本地模块；sink 须在驱动 main 里自初始化（`camprobe.NewSink` + `SetGlobalSink`，自引探针包用 camprobe 别名——instrument 对已 import 的文件跳过 import 注入）
- 产出：验证驱动环境保留于 `.design-canvas/tmp/golog-verify/`（可复跑）；对账脚本 `scripts/tmp-brick-reconcile.ts`（go_logging 首例，流程验证后可工具化）

**3R-4 补探针盲区（狗食闭环：发现问题就补）** ✅ 2026-08-20：
- 3R-3 暴露的 probe_gap 不是"缺一个检测点"，而是**两侧 target 不同构**：静态正则产 `file:r.basePath`（带参数后缀），探针只会产 `file-handle`（泛型名）——write 类天然同构（变量名）所以 6 个全转正，hold 类全军覆没是必然
- effects.go 重构：①新增 `callArgName`（与静态正则 `(?:"([^"]+)"|([\w.]+))` 同构：字面量→去引号 / 标识符·选择链→名字 / 下标→base / **CallExpr→函数名**（filepath.Join(dir,name)→filepath.Join，初版漏此分支被测试抓住）；②补 `Create`/`OpenFile`/`WriteFile`/`Remove`/`RemoveAll` 检测点（writeCallSelectors 新表：文件写删 → Kind=write）；③receiver 包名严格判定（`recvPkg(sel)`——GORM `db.Create`/`zip.Open`/自定义 `Listen` 不命中，与静态 `os\.` 前缀正则同构）；④target 带参数：`listen:addr`（net.Listen 取第 2 参 / ListenAndServe 第 1 参）、`db-pool:driver`、`file:路径表达式`
- 测试：fixture 扩 os.OpenFile/os.Remove + `db.Create` 负样本；断言 `listen::8080`、`file:app.log`、`file:filepath.Join` 同构 target；instrument 全测绿
- 复跑对账：**转正 7/10**（+`file:r.basePath` hold acquire ×6 精确命中），probe_gap 归零；剩余 3 个未观测全为 not_triggered×2（轮转阈值未达）+ static_only×1（包级字面量噪声）——诚实归因
- 对账脚本修正：hold 类匹配（此前只匹配 write）；已转正 runtime 的命中只计数不重复转正

**3R-5 reconcile_brick MCP 工具化（"入盒→驱动→对账→转正"成为标准流程）** ✅ 2026-08-20：
- tmp-brick-reconcile.ts 一次性脚本 → 正式 MCP 工具 `reconcile_brick`（第 14 个主工具，server_registry 注册）
- 与 reconcile_effects（DSL 契约版）判定规则同源：候选命中→origin ast→runtime 转正；候选外新观测→补进契约+incomplete 告警；未触发保持 ast 不证伪；hold 泛型名兜底（file-handle ↔ file:*，旧探针兼容）
- 对账对象：积木盒 contracts.json + manifest.effect_verification（证据档案含 gap_notes 归因、known_blind_spots、method——重抽保留字段）
- 参数设计：brick_dir 或 brick_name+box_dir 定位；events_files 显式 / verify_dir 自动发现；gap_notes 是人工归因输入（机器不臆造，如实登记）；write=false 预演
- 单测 5 场景（转正/新观测/归因/预演/无事件/缺参）+ 端到端实测：go_logging 真盒跑通（7 转正/3 归因/0 新观测，与手工脚本结果一致）；全量 836 测绿
- BrickManifest.effect_verification.files[].unobserved[].note 改可选（无归因的未观测候选合法存在）

### Phase 4：跨项目统一索引 + 摘要层
- 统一命名空间（多 cache.db 聚合或联邦检索）
- 积木货架：可浏览的接口契约目录（拎之前先看它要什么、给什么）

**4-1 积木货架 search_bricks** ✅ 2026-08-20：
- **关键决策——统一命名空间 = 盒本身**：积木盒 `.design-canvas/bricks/` 是跨项目资产（4 积木来自 4 个源项目），manifest.json 自包含档案天然统一，**不需要**多 cache.db 聚合/联邦检索——那是未入盒代码的挖掘需求（harvest_from_url dry-run 已覆盖），已入盒资产走盒内检索。避免为不存在的问题建基础设施
- `search_bricks` MCP 工具（第 15 个主工具）三模式：
  - 浏览（无参数）：全积木概况——语言（闭包扩展名投票推断）/来源/规模/exposes/effects/验证状态/description
  - 检索（query）：关键词打分 name(100/60) > shape 名(50/30) > 字段名(20) > description(15)，多词独立求和，**matched 明细可追溯**（哪个词命中了什么）
  - 详情（name 精确）：完整契约——contracts.json 实算 writes/holds 计数、effects 全清单、不变量、闭包、camera 验证档案
- 过滤四维三态（undefined 不过滤 / true 只看有 / false 只看无）：language / verified / has_invariants / zero_third_party
- `BrickManifest.description` 新槽位（LLM 生成人话一句话，**重抽保留**——与 acceptance 同类人工沉淀）；四积木已补：cg_wal_valve（WAL 写放大治理阀）/ go_logging（分级日志四件套）/ ua_ignore_filter / ua_theme_engine
- 列表模式不虚构 writes/holds 计数（manifest.aggregate 无全量清单），详情模式才从 contracts.json 实算——宁可缺省不造假
- 5 单测（浏览+语言推断/打分排序+matched/三态过滤/详情实算/异常）+ 真盒端到端（4 积木：theme accent 检索 ua_theme_engine 210 分 7 处命中；logger rotate 命中 go_logging；verified=true 过滤唯一）；全量 841 测绿

**4-2 跨项目挖掘检索评估（survey 多项目盘点是否工具化）** ✅ 2026-08-20 评估完成，结论：**不工具化**
- 场景拆解：
  - 已入盒资产的跨项目检索 → search_bricks 已覆盖（盒 = 统一命名空间，4 积木来自 4 个源项目同盒共存）
  - 未入盒代码的多项目盘点 → harvest_from_url auto + dry-run 已覆盖：每次调用输出候选积木清单（闭包规模/外部依赖三分类/聚合契约 exposes+emits+config+不可逆计数）。多项目 = LLM 编排多次单项目调用——MCP 工具的设计初衷就是 LLM 做编排层，循环调用即盘点
- 不建 survey 工具的三条理由：
  1. 多项目盘点输出 = 各项目候选清单的并集，无跨项目计算需求（不像闭包需要跨文件图计算，并集不需要专门算法）
  2. 唯一真正的跨项目语义是"同一积木多个项目都有、选哪个"——那是入盒之后 search_bricks 的 verified/provenance 维度（比较谁的 camera 验证更全、来源更可信），已覆盖
  3. survey 会在 harvest_from_url（未入盒盘点）与 search_bricks（已入盒检索）之间造第三个职责重叠工具
- 与 4-1 同原则：避免为不存在的问题建基础设施

### Phase 5：实码搬运与重组 ✅ 2026-08-20 微型验证贯通

**核心纪律（用户决策）：每次拼装一个新拼装区**——绝不在原项目上抽取和拼装，原项目（design-canvas / OCR 克隆 / 任何源）永远只读。拼装区是工作区平级一次性新目录，可 git init、可编译运行、可 import_project 解析，不满意整个删掉零残留。

**关键修正：拼装不是 scaffold 的活**。scaffold 职责是"改 DSL → 投影代码结构"（结构层）；拼装是"搬已验证实码 + 重接 import"（行为层实码），独立新工具 `assemble_bricks`（第 16 个主工具，src/tools/assemble_bricks.ts）。

布局：`<target>/<积木名>/<原闭包相对路径>`——积木名做顶层命名空间，跨积木永不撞路径。import 重接规则：
- **TS/JS 零重写**：积木=种子+传递闭包整体入盒，闭包内相对位置不变
- **Go 按闭包目录最长后缀匹配**识别内部 import（不需要知道源 module 名），重写为 `<module>/<积木名>/<后缀>`；不需要重写的（stdlib/三方）原样保留
- **Go 顶层 internal/ 段解除**：Go 的 internal 语义按路径走，不去段则积木子树外的 glue 编译期拒绝引用（实战踩坑：cmd/demo 引用 go_logging/internal/logging 报 use of internal package not allowed）。语义成立：源项目 internal 是防外部引用的封装，积木被选中拼装即成为新项目公开部件
- go.mod 生成（module + go 版本）；三方依赖**不自动 require**（汇总 pending 清单，go mod tidy / 人 / LLM 补——decline rather than guess）
- assembly.json 出生证明：积木清单、来源 commit、搬运映射、重写计数
- 跨积木闭包重叠只**警告不合并**（两份同源代码在 Go 是两个不兼容的包，静默合并=猜；正解是提升共享积木再入盒）
- glue 粘合代码不生成——粘合是 LLM 的活，工具只搬已验证实码

**实战抓到并修复的两个 Go 闭包盲区**（harvest_closure 修复）：
1. **同包 sibling 漏抽**：Go 包语义是目录内聚——同目录文件共享符号但无 import 边，纯 import 图闭包漏抽（症状：拼装区编译 undefined: ParseHunks）。修复：BFS 内 Go 文件触发同目录 .go 非 test 文件补全（ocr_diff_resolver 闭包 5→37 文件，整包是编译最小单元）
2. **go:embed 资源漏抽**：embed 数据文件（bpe_data/*.tiktoken、prompts/*）无 import 边不进符号索引（症状：编译 pattern no matching files）。修复：闭包内 .go 文件解析 //go:embed 指令（支持多模式/目录通配/all: 前缀），文件系统匹配资源入闭包（39→50 文件）

**微型拼装实战**（assembly-001-brick-demo，工作区平级目录）：
- 盒内 go_logging（agent-shell，camera 已验证）+ 新入盒 ocr_diff_resolver（OCR 招牌能力：LLM 出证据、机器出事实的行级定位）
- 54 文件搬运、12 处 Go import 重写、go mod tidy 补 25 三方（goproxy.cn 代理）、**go build 编译通过、go run 运行成功**：resolver 把 ExistingCode 证据定位到 L4-L4/L3-L3，go_logging 会话路由日志双落盘（hub.log + sessions/assembly-001-demo.log）
- **验证闭环**：import_project 解析拼装区成功入图（新项目成为正规可解析项目，可再入盒滚雪球）
- 诚实观察：Go 包=编译单元≠功能单元——resolver 只要 hunk/parser，整包闭包把 gitcmd/llm/telemetry 生态全拖进来（25 三方）。细粒度拎取（拆包重组）是 LLM 的活，工具不猜

**遗留观察（后续 Phase 5+ 可选）**：
- Go 积木重依赖治理：源项目 go.mod 的 require 版本可随盒存档（manifest.go_require），拼装时生成带版本的 require 块省去 tidy 拉新版风险
- 拼装区 git init + camera 插桩验证行为等价（依赖替换流程第 4 步的基建已就绪）

测试：assemble_bricks 12 用例（重写状态机：块内/单行/alias/最长后缀/三方撞名已知局限 + 布局/go.mod/预演/非空拒绝/异常/重叠警告/纯 TS 免 module）+ harvest_closure 新增 Go sibling 与 embed 回归；全量 854/854 绿。

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
