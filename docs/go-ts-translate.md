# Go→TS 半自动翻译工具（`translate_go_ts`）

> 一句话定位：设计内一条**端到端可用**的 Go→TS 半自动翻译链路，已注册为 MCP 工具。
> 分工严格：**机器做"可正确机械化的"，LLM 填"语义函数体"，验证闸兜底**。
> 代码：`src/translate/`（测试 `tests/translate/`，69 项）。

## 如何用

- CLI：`node dist/src/translate/translate_cli.js <file.go> [--out out.ts] [--holes] [--llm]`
- MCP：`translate_go_ts(file=…, fill, verify, maxRetries)`
  - 默认：机械骨架 + 验证闸
  - `fill=true`：用 AGNES key 池 LLM 逐孔填函数体（支持纠错重试）
  - `verify=true`：对已填纯函数跑 Go↔TS 行为对拍（需 go 工具链）
- 环境变量：`AGNES_KEY_POOL`（多 key，逗号分隔）/ `AGNES_UPSTREAM_BASE`（默认指向本地 key-pool-proxy `127.0.0.1:3101`）/ `AGNES_MODEL`（默认 `agnes-2.5-flash`）

## 一、已覆盖（机器自动翻译）

**萃取 / 骨架**

| 类别 | 能力 |
|---|---|
| 函数 | 顶层函数、无返回、多返回值→TS 元组 `[number, Error\|null]`、命名返回去名 |
| 方法 | receiver→首参、命名 `${Type}_${Method}`、泛型 receiver 继承 `<T>` |
| 类型 | struct→interface、非空接口→方法签名契约、named 别名（`type X = …`）、函数类型别名真实签名 |
| 泛型 | 函数/struct/别名类型参数 `<T,…>`、可表达约束降级 `extends`（`~int\|~float64→number`、`~[]byte→Uint8Array`）、约束原文 note |
| 容器 | map→`Map<K,V>`、slice、`[]byte→Uint8Array`、`[]rune→number[]`、`[N]T→T[]`、pointer |
| 常量 | 包级 const/var **编译期常量表达式求值**（含同包引用、算术/移位/位/字符串拼接/比较/逻辑）→ `export const`；var→`export let` |
| chan（近似） | `chan T`→`Channel<T>`，自动附带一次性 `Channel<T>` 垫片（诚实标注非 Go 阻塞/select 语义） |
| 细节 | 类型表 int/uint/float/byte/rune/string/bool/any、错误传播类型、complex 如实标注 |

**验证 / 闭环**

- 语法闸（tree-sitter 解析 + hasError）+ 结构闸（签名 / 参数 / 形状）
- Go↔TS **行为对拍**（纯函数：同一批输入跑两边比对）
- LLM 单孔填（锁定签名）、**纠错重试**（坏产物 + 诊断喂回再试；tree-sitter 容错解析导致坏产物仍可解析时用 hasError 拦截）
- markdown 围栏剥除、AGNES key 池轮换（round-robin + 429/5xx 冷却，fork 自 dsh-brain/key-pool-proxy）

## 二、诚实边界（不自动，交 LLM / note）

- **函数体语义**：惯用法、error 传播方式（异常 vs 值）、复合字面量、复合值
- **并发**：`select`、async 编排、goroutine 时序、chan 阻塞语义（垫片仅近似）
- `struct` 嵌入字段提升语义（不展开，note）
- `comparable` / 自定义约束（TS 无等价，note）
- 泛型 receiver 方法体里的 `T`（自由函数形态未绑定）
- 运行时 / IO / 副作用、项目级多文件翻译——**未做**

## 三、设计原则：正确性边界（为什么这样切）

- 翻译锚点是 **trans_unit 契约**（锁定骨架 + `bodyHole` + 约束），不是一棵要 round-trip 的公共 AST。
- **机器做满「可正确机械化的」** 会缩小 LLM 决策面、给出更准的锚点（最契合 LLM）；
- **别越界硬造**——把语义（并发/error/复合值）伪装成机械产物，会让 LLM 拿着错误前提翻译，反而更差。
- 因此：类型/签名/结构/常量/别名做满；并发/副作用保持 note + LLM + 验证闸兜底。

## 四、为什么「对拍」不扩展到 const 与类型

- const 对拍：值是机器自己算出/抄出的，比较是**恒等废话**。
- 类型对拍：TS/JS 与 Go 的类型都在编译期擦除，**运行时没有"类型的值"，无实体可比**。
- 对拍只对**可运行**的纯函数有意义（`Add(1,1)→2/2`）。

## 下一步候选

- **项目级多文件翻译**（跨文件 import 边 + 目录/模块组织 + 依赖顺序）——把"翻一个文件"升级成"翻一个 Go 项目"，是一个真正的增量工程。