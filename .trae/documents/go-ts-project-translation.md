# 项目级 Go→TS 翻译（`translateGoProject`）

## Context

现有一个**单文件** Go→TS 半自动翻译链路（`src/translate/`，工具 `translate_go_ts`，机器做骨架、LLM 填函数体、验证闸兜底）。但它一次只处理一个 `.go` 文件，产出一个**自包含模块**——跨文件引用的类型/函数名字只是"透传"，在 TS 里会悬空。要把"翻一个 Go 项目"串起来，需要：

1. 枚举项目所有 `.go` 文件，逐个翻译成 TS 模块；
2. 让每个 TS 模块能 `import { X } from './其他模块'`，否则跨文件类型引用（比如 `func (u *User)` 的 `User` 在别的文件）在 TS 里 undefined、无法编译；
3. 按镜像目录结构输出一整棵 TS 工程（可选 LLM 填函数体）。

目标产物：`translateGoProject(projectDir, opts)` —— 一次把一个 Go 项目目录变成一棵可编译的 TS 模块树，跨文件类型引用自动 import。

## 复用的既有基建

- **符号→文件定位**：符号 cache.db `nodes` 表（`src/db/symbols.ts`），顶层符号 `WHERE name=? AND kind!='file' AND parent IS NULL` → file_path。
- **Go 包路径→本地 .go**：`project_root.ts` 的 `readGoModules` + `resolveGoImport`，已能把 `github.com/x/y/pkg` 精确落到 `./pkg/*.go`。
- **项目符号名收集**：不依赖 cache.db（保持零前置即用），直接用现有萃取器遍历所有 `.go` 得到"本文件定义的顶层符号名"集合。
- **Go import 提取**：`ts_kernel.parseFileFull` 返回该文件 `imports`（Go 用 `import_spec` + `LANG_ADAPTERS.go`）。
- **工厂**：`getProjectCacheDb`（可选，用它做符号→文件更快；没有缓存就靠萃取集合同名定位，双方都能跑）。

## 实现步骤

### 1. 枚举与逐个翻译（新增 `src/translate/project.ts`）
- `walkGoFiles(dir)`：递归找 `.go`（跳过 `_test.go`、`node_modules/_`、`dist` 等）。
- 对每个文件：`translateGoToTs(file, src)` → 得到 `units` + 每文件模块体（复用骨架渲染与验证闸）。
- 收集 `definedByName`：`name → { file, kind }`（来自每文件 unit 的 `name`，含 func/type/const；同名冲突记 diag note）。

### 2. 提取"外部类型引用"（`src/translate/referenced.ts`，纯函数可测）
- 从每个 unit 的类型串（`param.type`/`result`/`field.type`/`aliasType`/`method.*.type`/`method.result`）用标识符提取扫出名字集合。
- 过滤掉 TS 已知类型（`number/string/boolean/Error/unknown/void/Uint8Array/Map/Channel/Array/Promise/Record/` 等）与本文件的 `typeParams` 和自身 `name`。
- 剩下的 = 候选外部类型名。项目级：若该名在**其它文件**定义了 → 生成 import。

### 3. 跨文件 import 落定
- 对每个文件，把它的候选外部类型名逐个查 `definedByName`：
  - 定义在**别的文件** → 记 `import { X } from './relPath'`；相对路径用目标文件相对本文件输出目录算出（Go 包路径先经 `resolveGoImport` 落到真实文件再转相对路径）。
  - 定义在同文件/未定义（stdlib 或外部）→ 不 import；stdlib 类型（如 `bytes.Buffer`）留 note 给 LLM，不硬解。
  - 同名冲突 → 不 import + diag note（诚实标注）。

### 4. 组装 + 落盘 + 全工程 tsc 门禁（`verify=true`）
- 每文件输出：`import` 头 + 模块体（复用 `renderTsSkeleton`）；用到 `Channel<` 的文件前置一次性垫片。
- 写 `outputDir/<镜像相对路径>.ts`；可选 `fill=true` 时按文件顺序用 `fillUnitsWithRetry` 填函数体。
- **填序修正（填后 release gate）**：fill 移到 import 算定之后——每模块先用 `buildProjectCallNote` 把「本模块可直接调用的 free func + receiver→`T_f` 约定」注入每个孔 prompt，再填；填完重建 `m.ts`。从而 `--fill --verify` 时门禁跑在**填后输出**上，纯项目应 0 错。
- `verify=true` 用 TS compiler API 对**内存模块树**跑 preEmit（非 strict、跳 .d.ts），真实类型/引用/import 解析错误并入 diagnostics（不阻断）。特例跳过 TS 2355（骨架留孔固有的"缺 return"）。
- 返回汇总（`{ modules: [{file, ts, imports, callRefsRaw, units, issues}], diagnostics }`）。

### 5. 跨文件**自由函数调用** import（`callRefsRaw`）
- 用 `parseFileFull` 的 Go call 边（`call_expression`），取 `resolved=false` 的调用：
  - 裸调用 `Foo(...)` → `Foo` 候选（同包跨文件 / dot-import / 内置）；
  - 包限定 `pkg.Foo(...)` → 仅当 `pkg` 是该文件某个 Go import 的绑定别名时候选（排除方法调用 `u.GetName()`——receiver 前缀不是 import 别名）。
- 候选名只在「项目内定义为 **free func** 且在不同文件」时补 import；内置 / stdlib / 方法天然被过滤。类型 import 与函数 import 按目标文件合并成一条语句。

### 6. 出口
- `pairs.ts` 暴露 `translateGoProject`；`tool.ts` 的 `translate_go_ts` 增 `projectDir`（项目）、`tscVerify`（全工程 tsc 门禁）参数 → 走项目路径。
- CLI 加 `--project <dir> --out-dir <out> [--verify]`。
- `docs/go-ts-translate.md` 补"项目级"一节。

## 验证

- 单测（`tests/translate/project.test.ts`）：
  - 造一个小 Go 项目（2 个文件：`model/user.go` 定义 `type User struct`；`svc/app.go` 的 `func F(u *User)` 引用它），断言 app.ts 生成了 `import { User } from '../model/user'` 之类相对路径 + `User` 在签名里不再悬空。
  - 同包跨文件裸调用 + 跨包 `pkg.Foo` 限定调用 → 分别补合法相对 import；方法访问（`u.ID` / receiver 前缀非 import 别名）不误当函数 import。
  - 同名冲突/未定义 stdlib 类型走 diag note 不崩。
  - `verify=true`：纯项目 → 全工程 tsc 零错误；stdlib（`bytes.Buffer`）→ 如实列出命名空间错误。
  - walkGoFiles 跳过 `_test.go`。
- 真实冒烟：对 `dsh-brain` 某子包或自造样例跑一次 `translateGoProject`，产出一棵含跨文件 import 的 TS 树；`verify=true` 过闸。
- `tsc --noEmit` + `vitest run tests/translate/` 全绿后提交推送。

## 诚实边界（记录到此里程碑）

- **类型引用** + **自由函数调用**做跨文件 import（签名与跨文件调用能编译）；函数体里的**复杂跨文件逻辑**归 LLM（body 是孔），但填孔 prompt 已注入项目级调用约定 + A2 语义上下文（兄弟函数签名、被引类型字段词表如 `Address.broadcast`），使填后配合 import 能过门禁、且保留单播/广播等字段语义。
- 方法调用不自动补 import（`u.GetName()` 需先译成 `user_GetName(u)` 自由函数）——跨包 receiver 方法调用暂不机器覆盖；同模块方法已译成 `T_f` 并列入调用约定供 LLM 使用。
- Go `stdlib` / 外部第三方类型不硬解，留 note；verify 门禁会把这类未解析引用如实列出为 tsc 错误。
- 同名顶层符号冲突 / 循环 import：不 import + 如实 diag。
- verify 门禁是**不阻断**的诚实报告：纯项目应 0 错，stdlib/外部会列出错误；`ok` 仍以逐文件骨架闸为准。

## 应对实证反馈的 A 级改进（A1–A4）

- **A1 显式失败清单**：`translateGoProject` 返回逐单元 `report`（ok/skeleton/llm_retry_fail/skipped + 原因 + Go 源行）；outDir 落 `translation-report.jsonl/.md`。降级不再被静默吞掉。
- **A3 决策表确定性翻译**：函数体为 `switch(<disc>)` 时，萃取判别式 + case 标签 + default（`DecisionShape`），骨架机械 1:1 渲染 `switch/case`，LLM 只填分支动作；verify 断言分支数与判别式在**填后**仍等价（拦"丢分支/改判别式"）。
- **A2 跨文件语义上下文注入 fill**：把兄弟函数签名、被引类型的字段词表（broadcast/excludeRoles 等）注入单孔 prompt，避免 LLM 脑补语义（如"同 role 全发"误判）。
- **A4 填后结构化断言**：空壳检测（函数体去注释为空 → 疑似降级为空壳）+ 入参语义丢失（Go 用过的参数填后 body 未引用）；连同 A3 分支等价，把"能编译"推进到"守部分行为特征"。