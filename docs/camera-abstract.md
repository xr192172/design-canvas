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
| `probe.DSLDecl` | `DSLDecl` | rule/probe/expect/constraint 全一致 |
| `probe.DesignDSLDoc` | `DesignDSLDoc` | version/updated_at/decls |
| `probe.HistoryEntry` | `HistoryEntry` | version/at/reason/source/decls |
| `probe.ActualDSLDoc` | `ActualDSLDoc` | generated_at/source/event_count/bad_lines/probes |
| `probe.ProbeObs` | `ProbeObs` | probe/count/errs/benigns/ops/facts/events |
| `probe.Deviation` | `Deviation` | kind/rule/probe/detail |
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

| 语言 | 探针实现 | 判定装配 | 状态 |
|---|---|---|---|
| Go | `go-camera` probe 包 | Go 装配层 | ✅ 已落地 |
| TypeScript | `probe.ts`（ts_kernel 已有符号探测基础） | 复用 Go 装配层 or TS 哨兵 | 待做 |
| Python | `probe.py` | 复用 Go 装配层 | 待做 |
| Java | `probe.java` | 复用 Go 装配层 | 待做 |

> 判定端口可下沉为独立服务（`/api/camera/judge`），使探针语言与判定装配彻底解耦——后续可演进，当前单进程内复用即可。

---

## 5. 验证清单（对齐 + 端到端）

- [x] Schema 与 9 个 Go 类型字段逐一对齐（见 §2 表）
- [x] Schema 为合法 JSON（draft-07）
- [ ] 端到端：Go 探针产出 events.jsonl → loader → aggregator → actual.dsl.json
- [ ] 端到端：actual.dsl.json + dsl.json → comparator → DiffReport（三类偏差计数正确）
- [ ] 端到端：`camera-dsl actual` / `camera-dsl diff` CLI 输出符合 Schema
- [ ] 契约语义对齐：TS 探针埋点产出的事件能被 Go 装配层正确判定（跨语言接入试点）

---

## 6. 演进方向（记录，不阻塞当前）

- 判定端口下沉为独立服务，探针语言与判定彻底解耦。
- 事件聚合体积告警/抽样策略（海量事件时降级为统计而非全量证据）。
- 与 design-canvas MCP 工具链整合（`import_project` 自动埋点 + `render_dsl` 可视化偏差全景）。