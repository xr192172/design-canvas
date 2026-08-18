# Camera 抽象设计（语言无关）

> 目标：让 Camera（动态插桩 + DSL 契约筛选异常）不绑定 Go，未来可接入 TypeScript / Python / Java 等任意语言。
> 核心思路：**数据契约语言无关（JSON Schema），端口接口语义统一，判定逻辑分层复用**——确定性规则谓词与 LLM 判定是装配层能力，与探针所属语言解耦。

---

## 1. 数据流淌向（整体）

```
   探针(任何语言)                       装配层(统一判定)                    报告
┌──────────────────┐   events.jsonl   ┌────────────────────────────┐   ┌──────────────┐
│ Event 快照        │ ───────────────▶ │ ActualDSLLoader → Aggregator│──▶│ ActualDSL    │
│ (probe/fields)    │                 │                            │   │ (可再生画像)  │
└──────────────────┘                 │        Comparator           │   └──────┬───────┘
                                              │  ⇄  diff              │         │
┌──────────────────┐   dsl.json      ┌────────────────────────────┐   │         ▼
│ DesignDSL 契约    │ ───────────────▶│ DesignDSLStore (权威真相源)  │──▶│  DiffReport  │
│ (rule/probe/…)    │                 │  version + history 审计     │   │  三类偏差     │
└──────────────────┘                 └────────────────────────────┘   └──────────────┘
```

- **事件** 是探针的唯一产出，语言无关，只写 `events.jsonl`。
- **设计契约** 是判定的唯一真相源，语言无关，只读 `dsl.json`。
- **判定**（规则谓词 + LLM）是装配层能力，跨语言复用，不随探针语言而变。

---

## 2. 数据契约（JSON Schema）

定义见 `schema/camera_contract.schema.json`（draft-07）。四类核心结构：

| 结构 | 文件 | 性质 | 说明 |
|---|---|---|---|
| `Event` | events.jsonl（每行一个） | 事实 | 探针唯一产出 |
| `DesignDSLDoc`/`DSLDecl` | dsl.json | **权威真相源** | 行为级判定依据；版本化 + 审计 |
| `ActualDSLDoc`/`ProbeObs` | actual.dsl.json | 可再生·非权威 | 观测事实画像，自给自足 |
| `DiffReport`/`Deviation` | 偏差报告 | 判定结论 | 三类偏差：unobserved / violated / undesigned |

辅助：`HistoryEntry`（DSL 审计快照）、`Verdict`（规则/LLM 统一判定结果）。

### 与现有 Go 类型唯一对齐（已核对）

| Go 类型 | Schema 定义 | 关键对齐点 |
|---|---|---|
| `probe.Event` | `Event` | probe/time/source/fields 全一致 |
| `probe.DSLDecl` | `DSLDecl` | rule/probe/expect/constraint/chain（P2 链路契约）+ origin/verified_by/status 审计字段 全一致 |
| `probe.DesignDSLDoc` | `DesignDSLDoc` | version/updated_at/decls |
| `probe.HistoryEntry` | `HistoryEntry` | version/at/reason/source/decls |
| `probe.ActualDSLDoc` | `ActualDSLDoc` | generated_at/source/event_count/bad_lines/probes + chains/chains_dropped（P2 链路画像） |
| `probe.ProbeObs` | `ProbeObs` | probe/count/errs/benigns/ops/facts/events |
| `probe.ChainObs` | `ChainObs` | trace_id/sequence/errs/events（P2：trace 三元组重建调用链） |
| `probe.Deviation` | `Deviation` | kind（含 chain-broken）/rule/probe/trace_id/window/detail |
| `probe.DiffReport` | `DiffReport` | generated_at/design/actual/event_count/deviations + 三计数 |
| `probe.LLMVerdict`/`Verdict` | `Verdict` | result/rule/reason |

---

## 3. 端口接口（语言无关）

每个端口是一个**语义接口**，各语言按惯例实现。判定逻辑（Comparator + 规则谓词 + LLM 判定）只依赖这些接口，不依赖具体探针语言。

### 3.1 探针捕获端口（各语言探针实现）

```
ProbeCapture:
  emit(probe: string, fields: map[string]any, source?: string) -> void
  // 追加写 events.jsonl，自动补 time；线程安全（append-only + 短锁）
```

- 语言侧职责：在关键点埋点，捕获数据值（err、op、path、bytes、benign…）。
- 产出唯一约束：满足 `Event` schema，可被任意语言 loader 读取。

### 3.1.1 v2 分级采集与调用链作用域（2026-08-18 落地，Go/TS 双侧对齐）

v1 探针直写 events.jsonl（全量落盘），适合 conformance/调试；v2 runtime
（Go `probe.Tiered` / TS `Tiered`）按 camera_v2 决策卡分级采集，生产默认：

```
Tiered（c1 铁律：任何留存层内存占用为常数）:
  emit(event)  // 计数器(c3) + 直方图(c4) + 环形缓冲(c5)；热路径无磁盘
  counters()/histograms()/ringStats()   // 只读快照（报告用）
  catch 触发 → 错误开箱导出(c6)：同 trace_id 链路窗口 + 环境窗口
             → 每探针每分钟限速(c8，默认 10 次)，目录保留封顶(64 条)

Scope（c7 correlation ID；调用进入时生成、层层显式传递）:
  Go:   ctx, sp := probe.Enter(ctx, "svc.Handle", nil); defer sp.Exit()
        sp.Catch(err)  // 同 trace id 整条链路窗口开箱
  TS:   withScope('svc.Handle', {..}, async sp => { ... sp.catch(err) })
        // AsyncLocalStorage 按异步上下文传递（Node 惯用法，
        //   等价 Go context.Context 显式流动）
```

- trace id 流动方式按语言惯例：Go 经 `context.Context`，TS 经
  `AsyncLocalStorage`——均否决模块级全局变量（goroutine / async 下不成立）。
- Event schema 新增可选字段 `trace_id` / `frame_id` / `parent_id`：
  v1 事件省略（向后兼容），v2 作用域 API 自动填充。
- 两侧 runtime 均提供全局路由：`SetGlobalTiered`（Go）/ `setGlobalTiered`
  （TS，挂 globalThis 防 ESM 多副本），旧探针代码零改动进入 v2。

### 3.2 规则谓词端口（装配层实现，跨语言复用）

```
RulePredicate:
  predicate(event: Event) -> (result: "ok"|"deviation", reason: string)
```

- 按 `rule` id 注册（如 `design:silent-error-discard`）。
- 确定性、纯函数、无副作用——**这是设计契约的"秒判"层**，可独立测试。
- 未被注册谓词的声明只做"是否被观测"覆盖检查，不臆造违反（交 LLM 复核）。

### 3.3 LLM 判定端口（装配层实现，跨语言复用）

```
LLMJudge:
  adjudicate(event: Event, decls: DSLDecl[]) -> Verdict
  // 输入 = 事件快照 + 匹配 DSL 声明（唯一真相源，不接触项目文档）
  // 失败时调用方降级，不阻断流程
```

- 只喂"事件快照 + DSL 契约"，杜绝 LLM 接触项目文档臆测背景。
- 仅对规则秒判不掉的"可疑/待复核"事件调用，成本可控。

### 3.4 判定统一入口（Comparator）

```
Comparator:
  compare(design: DesignDSLDoc, actual: ActualDSLDoc) -> DiffReport
```

- 产出三类偏差：unobserved / violated / undesigned。
- 纯计算，语言无关，任何语言都可作为哨兵实现一份（或直接复用装配层 Go 实现）。

---

## 4. 多语言接入说明

接入一种新语言，只需做三件事（**不碰判定逻辑**）：

1. **实现探针端口**：按 `Event` schema 写 `emit()`，关键点埋点，产出 `events.jsonl`。
   - 命名约定 `probe = <module>.<site>`，跨语言全局唯一。
2. **复用装配层判定**：`events.jsonl` + `dsl.json` 喂给统一的 Comparator/LLMJudge（Go 装配层即可），无需重写判定。
3. **对齐契约语义**：内置 `SilentErrorDiscard` 的 op 语义（writefile/save/mkdirall 任何 err 非良性；remove/cleanup 仅 IsNotExist 良性）在各语言探针埋点时保持一致，否则判定会失真。

### 语言接入矩阵（规划）

| 语言 | 自动插桩 | 探针实现 | 判定装配 | 状态 |
|---|---|---|---|---|
| Go | ✅ `internal/instrument`（go/ast 全量无脑插桩） | `go-camera` probe 包 | `JudgeClient` 走 HTTP 调 TS 判定服务，未配置时降级本地 | ✅ 已落地 |
| TypeScript | ✅ `instrument.ts`（tree-sitter 全量无脑插桩，含 deep 级） | `probe.ts` | TS 判定服务（`/api/camera/judge`，判定权威） | ✅ 已落地 |
| Python | 待做（LLM 按 SPEC 自动开发） | `probe.py` | POST `/api/camera/judge` | 待做 |
| Java | 待做（LLM 按 SPEC 自动开发） | `probe.java` | POST `/api/camera/judge` | 待做 |

> **判定端口已实际下沉为独立服务**（`/api/camera/judge`，2026-08-15 PR 偏差3 落地）：各语言探针只需产出符合 `Event` schema 的事件，POST 上来即可判定，无需复刻判定规则。Go 侧 `JudgeClient` 读 `CAMERA_JUDGE_URL` 环境变量指向该服务；未设置时降级为本地 `SilentErrorDiscard` 谓词（语义与 TS 逐条对齐），保证离线/单测可用。

### 4.0 新语言接入 = LLM 自动开发 + 一致性验收（2026-08-18 落地）

新语言的插桩器**不再人工开发**：LLM 按 [`camera-conformance/SPEC.md`](../camera-conformance/SPEC.md)
（实现规范 + CLI 契约）参考 TS/Go 两份参考实现自动写出，再用统一 CLI 跑一致性验收：

```bash
node camera-conformance/verify.mjs --lang <lang>   # 静态清单/幂等/还原 三断言全绿即接入
```

- 统一 CLI 契约：Go `go-camera/cmd/instrument`、TS `camera-conformance/ts-instrument.mjs`
- 黄金样例：`camera-conformance/samples/`（TS/Go 同语义对 + expected-probes 固化基准）
- 参考实现对拍状态：TS 12 探针点 / Go 14 探针点，ALL GREEN（差异来自语言惯用，如 TS 有 catch、Go 需辅助函数）

### 4.1 插桩覆盖策略：全量无脑插桩 + 事件分级标签（2026-08-14 补记）

> 这是 Camera 的**核心纠偏**：早期只插 catch + IO 两类"关键点"，是交接时遗漏需求导致的**局部插桩**。原始需求是**全函数插桩 + 监控函数内数据流动**。

- **全量无脑插桩**：不挑点，对所有函数出入口、return、参数、返回值、catch 块、IO 写盘调用全插探针。插桩越全，观测画像越完整。
- **DSL 做筛选**：探针产出全量事件 → 装配层用 DesignDSL 的声明去匹配/判定。没被声明命中的事件即 `undesigned` 噪音，被命中的交给规则谓词/LLM 判定。**全量采集与判定筛选彻底解耦**，因此可适配任何类型、任何阶段的项目。
- **事件分级标签**：每个事件打 `level` 标签，供 LLM/判定层按需选择性读取，控制成本：

| level | 覆盖 | 用途 | 典型事件量 |
|---|---|---|---|
| `core` | 函数入口/出口/return 参数与返回值 | 发现数据/逻辑错误（核心） | 中 |
| `event` | catch 静默丢错 + IO 写盘 | 发现落盘/异常吞错问题 | 低 |
| `deep` | 函数内部关键变量赋值/分支（可选放大） | 海量场景抽样 | 高 |

- 该策略同样服务于 **dogfooding（狗食）**：给 Camera 自己插桩，运行真实路径时直接发现某一环节数据或一段代码逻辑不正确。
- **自动插桩器（2026-08-15 PR 偏差1/2 落地）**：TS 侧 `src/camera/instrument.ts`（tree-sitter）与 Go 侧 `go-camera/internal/instrument`（go/ast）均实现「全函数插桩 + deep 级放大 + 幂等标记 + 备份还原」，配合 `--dry-run` 与 `--restore` 命令，覆盖全量无脑插桩需求。

---

## 5. 验证清单（对齐 + 端到端）

- [x] Schema 与 9 个 Go 类型字段逐一对齐（见 §2 表）
- [x] Schema 为合法 JSON（draft-07）
- [x] 端到端：Go 探针产出 events.jsonl → loader → aggregator → actual.dsl.json
- [x] 端到端：actual.dsl.json + dsl.json → comparator → DiffReport（三类偏差计数正确）
- [x] 端到端：`camera-dsl actual` / `camera-dsl diff` / `camera-dsl loop` CLI 输出符合 Schema
- [x] 契约语义对齐：TS 探针埋点产出的事件能被 Go 装配层正确判定（跨语言接入试点，含真实 serve 运行抓包实证）
- [x] PR 偏差1：TS 插桩器 deep 级数据流插桩（`--enable-deep`，变量赋值/分支捕获，幂等独立标记）
- [x] PR 偏差2：Go `internal/instrument` 用 go/ast 做 Go 源码自动插桩 + `camera-dsl instrument` CLI + 6 项测试
- [x] PR 偏差3：Go `JudgeClient` 走 HTTP 调 TS 判定服务（`/api/camera/judge`），未配置时降级本地判定（4 项测试）
- [x] 工程化护栏：DSLDecl 审计字段（origin/verified_by/status）+ 验证门规则回归证据（与 Comparator 同源谓词表）+ loop 低频触发阈值（`--min-deviation-rate` / `--min-undesigned`）

---

## 6. 演进方向（记录，不阻塞当前）

- 判定端口下沉为独立服务，探针语言与判定彻底解耦。
- 事件聚合体积告警/抽样策略（海量事件时降级为统计而非全量证据）。
- 与 design-canvas MCP 工具链整合（`import_project` 自动埋点 + `render_dsl` 可视化偏差全景）。