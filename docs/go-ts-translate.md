# Go→TS 半自动翻译工具（`translate_go_ts`）

> 一句话定位：设计内一条**端到端可用**的 Go→TS 半自动翻译链路，已注册为 MCP 工具。
> 分工严格：**机器做"可正确机械化的"，LLM 填"语义函数体"，验证闸兜底**。
> 代码：`src/translate/`（测试 `tests/translate/`，100+ 项）。

## 如何用

- CLI：`node dist/src/translate/translate_cli.js <file.go> [--out out.ts] [--holes] [--llm]`
  - 项目级：`translate_cli.js --project <dir> [--out-dir <out>] [--llm]` —— 枚举整个 Go 项目、逐个译成 TS 模块、跨文件 import、按镜像结构落盘
- MCP：`translate_go_ts(file=…, fill, verify, maxRetries)` / 项目级 `translate_go_ts(projectDir=…, outDir=…, fill)`
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
| 项目级（多文件） | `translateGoProject`：枚举项目 `.go`、逐文件译成 TS 模块、**跨文件类型引用自动 `import { X } from './…'`**、按镜像目录结构落盘一棵 TS 工程 |
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
- 运行时 / IO / 副作用
- **项目级**：只给**类型引用**做跨文件 import（签名可编译）；函数体里的跨文件**函数调用**归 LLM；Go stdlib / 外部类型不硬解、同名顶层符号冲突不 import，均记 diagnostic

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

- **跨包 receiver 方法调用机器补齐**：`u.GetName()` 且 `User` 定义在别处时，机器补 import 译好的 `user_GetName`（目前同模块靠调用约定提示，跨包仍交 LLM）。
- **Go stdlib / 第三方类型 stub**：目前不硬解、由 verify 门禁按根因聚类如实报出 tsc 错误。
- **产物侧更彻底的 globals 收敛**：当前类型走 import、不落 globals.d.ts；若出现 `class vs function` 撞名由 B1 预检点名。

## 五、Go↔TS 转换约定表（B3，与 `src/translate/ts_codegen.ts` 的 `mapGoType`/渲染逻辑一致）

> 这份表是"机器到底把哪些 Go 写成哪个 TS"的**恒定口径**。翻译产出与这里一一对应；超出下表的就是不机械、交 LLM/note 的边界。

**标量 / 名称 1:1**

| Go | TS | 备注 |
|---|---|---|
| `int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr byte rune float32 float64` | `number` | 全部整数族折叠为 JS `number`（精度/溢出需人工按场景核） |
| `string` | `string` | |
| `bool` | `boolean` | |
| `any` / `interface{}` | `unknown` | |

**容器 / 复合**

| Go | TS | 备注 |
|---|---|---|
| `[]byte` | `Uint8Array` | 惯用字节串 |
| `[]rune` | `number[]` | |
| `[]T` | `T[]` | |
| `[N]T` | `T[]` | 定长按值近似，`N` 丢失 |
| `*T` | `T` | 指针按值语义，剥 `*` |
| `map[K]V` | `Map<K, V>` | key 吃首个顶层 `]` |
| `complex64` `complex128` | `[number, number]` | 无内建，按 [实,虚] 元组；运算需人工 |
| `(T1, T2, …)` | `[T1, T2, …]` | 多返回值 → 元组；含 `error` 时分量 `Error\|null` + note |

**语义包裹（近似 / note，不硬猜）**

| Go | TS | 备注 |
|---|---|---|
| `error` | `Error \| null` | TS 无内建，返回语义需 LLM/人审（值 or 抛异常） |
| `chan T` `<-chan T` `chan<- T` | `Channel<T>` | 自动附带一次性 `Channel<T>` 垫片；**非 Go 阻塞/select/竞态语义** |
| `func(a int) error` | `(a: number) => Error \| null` | 函数类型：逐参/返回映射，名字可省略为 `arg` |

**泛型**

| Go | TS | 备注 |
|---|---|---|
| `Name[K, V]` / `Name<K, V>` | `Name<K, V>` | 实参逐位映射；基名 `.`→`_` |
| `[T int64]` 等标量约束 | `<T extends number>` | 约束降级为 `extends`（`~T` 剥 `~`：int 族→number、string→string、bool→boolean、`[]byte`→Uint8Array） |
| `[T comparable]` / 自定义约束 | `<T>` | TS 无等价约束，`extends` 不设，另写 note |

**命名 / 形状约定（全局恒定，二选一并一致）**

| Go | TS |
|---|---|
| 顶层函数 `func F` | `export function F(...)` |
| struct `type U struct{...}` | `export interface U { Fld: T; ... }` |
| 非空接口 `type I interface{...}` | `export interface I { M(...): T; ... }` |
| named 别名 `type A = ...` | `export type A = ...` |
| **方法** `func (u *User) Greet(...)` | **独立自由函数** `export function user_Greet(u: User, ...)`（receiver 作首参，名 `← receiver 基类型 + "_" + 方法名`，防同文件多类型方法撞名） |
| 接收者方法调用 `u.Greet()` | 需译为 `user_Greet(u, ...)`（不写 `u.Greet()`） |
| 包级 `const X = ...` | `export const X = ...`（编译期常量已求值） |
| 包级 `var X = ...` | `export let X = ...` |
| 决策表 `switch(x){ case ...: ... default: ... }` | TS `switch(x){ case L:{...} default:{...} }`，判别式/case 标签机械 1:1 焊死，LLM 只填各分支动作 |

**跨文件 / 声明组织**

| 规则 |
|---|
| 类型引用 → `import { X } from './相对路径'`（就近声明，不落 globals.d.ts） |
| 自由函数调用 → 项目内定义的跨文件 free func 自动 import；方法调用暂不机器补（见候选） |
| 未用 import → `fixUnusedImports` 幂等移除；同源 import → `squashImports` 合并 |
| 同名顶层符号（跨文件 / type↔func 混同）→ 不再 import，由 B1 冲突预检点名消歧 |
| Go stdlib / 外部类型 → 不硬解，verify 门禁如实列出为 tsc 错误（按根因聚类） |