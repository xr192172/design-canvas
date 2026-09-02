/**
 * register_capabilities —— 现有多语言功能的支持度登记（能力矩阵的数据填充）
 *
 * 每个登记项声明：功能 id / 默认支持度 / 逐语言覆盖。
 * 依据来自各工具的既有实现（实测分支点），不是臆造：
 *   - package_migration 的 cleanAlias：Go/TS 家族/Python 已走 AST 作用域守卫；
 *     其余语言仍回退正则（cleanAliasRegex）。
 *   - rename_symbol / contract_gate / extract_contracts：只实现了 go + ts 两条分支。
 *   - ts_kernel 的 parseFileFull：对 LANGUAGES 里"已安装"的语言做 符号/import/调用边/类型引用
 *     四产出，是通用 AST 根基（full_ast 覆盖全部已装语言）。
 *
 * 未来新功能：在本文件追加 `declareCapability({...})` 即可自动进入矩阵，
 * 无需改动 audit 主流程。
 */

import { declareCapability } from './capability_matrix.js';

/** 通用性：一棵语言解析产出的能力（符号/import/调用边/类型引用）——凡是 ts_kernel 能解析的语言都 full_ast */
declareCapability({
  id: 'ast_parse_skeleton',
  label: '符号/import/调用边/类型引用 提取',
  desc: 'ts_kernel parseFileFull 的四产出；凡装了解析器的语言都全量支持',
  default: 'full_ast',
});

/** 包改名/提级：别名清洗已 AST 化，仅 Go/TS 家族/Python 走守卫，其余回退正则 */
declareCapability({
  id: 'package_migration',
  label: '包改名/提级（含别名清洗）',
  desc: '别名清洗 AST 作用域守卫：Go/TS 家族/Python 全量；其余语言正则回退',
  default: 'regex_fallback',
  overrides: {
    go: 'full_ast',
    typescript: 'full_ast',
    tsx: 'full_ast',
    javascript: 'full_ast',
    jsx: 'full_ast',
    python: 'full_ast',
  },
  notes: {
    go: 'collectGoImportAliasEdits / collectGoSelectorEdits（AST 守卫）',
    typescript: 'collectTsBinds / collectTsUsage',
    python: 'collectPyBinds / collectPyUsage',
    javascript: '经由 tsAliasEdits 同一路径（import_statement 结构一致）',
  },
});

/** 符号改名：TS 家族全量；Go/Python/C#/Java 支持模块级符号 + 跨文件引用 */
declareCapability({
  id: 'rename_symbol',
  label: '符号改名（作用域解析 + 跨文件 import 边）',
  desc: 'TS 家族（作用域解析 + import/reexport 边）全量；Go 同包+跨包 pkg.Sym；Python 模块级+跨模块 X.sym；C#/Java 命名空间级类型跨文件（同包裸引用+跨包限定引用）；C/C++ def+头文件声明+#include 调用点联动',
  default: 'unimplemented',
  overrides: {
    typescript: 'full_ast',
    tsx: 'full_ast',
    javascript: 'full_ast',
    jsx: 'full_ast',
    go: 'full_ast',
    python: 'full_ast',
    java: 'full_ast',
    c_sharp: 'full_ast',
    c: 'full_ast',
  },
  notes: {
    typescript: '值/类型双栖 + import 边 + 别名 + 局部遮蔽',
    go: '同包 function/type/const + 跨包 pkg.Sym 引用（经 import 本地名判连，前缀隔离不误改）',
    python: '模块级 function/class + 同模块裸引用 + 跨模块 X.sym 引用（import 本地名判连）',
    java: '顶层 class/interface/enum/record + 同包裸引用 + 跨包 pkg.Type 限定引用（scoped_type_identifier）',
    c_sharp: '顶层 class/interface/struct/enum/record + 同命名空间裸引用 + 跨命名空间 Name.Type 限定引用（qualified_name）',
    c: '函数/类型定义 + 原型声明(头文件) + `#include` 该头文件的调用点裸引用联动',
  },
});

/** 契约对账闸门：go / python / java / cs / c / JS 家族各走本族分支 */
declareCapability({
  id: 'contract_gate',
  label: '契约对账闸门（重构后裸标识符定义源检查）',
  desc: 'go/python/java/cs/c 各自分支；ts/tsx/js/jsx/mjs/cjs 走同一套 TS 逻辑（语法兼容）',
  default: 'unimplemented',
  overrides: {
    go: 'full_ast',
    typescript: 'full_ast',
    tsx: 'full_ast',
    javascript: 'full_ast',
    jsx: 'full_ast',
    python: 'full_ast',
    java: 'full_ast',
    c_sharp: 'full_ast',
    c: 'full_ast',
  },
  notes: {
    java: 'import 末段/同包类型/方法形参为定义源；System 等内建白名单',
    c_sharp: 'using 末段/别名/同命名空间类型/方法形参为定义源；System 等内建白名单',
    c: '全局函数/struct/typedef/全局变量/形参为定义源（struct 成员访问左侧不误报）',
  },
});

/** 契约提取（签名/env 对账）：go / python / JS 家族各走本族；其余回退 TS 逻辑 */
declareCapability({
  id: 'extract_contracts',
  label: '契约提取（签名 + 环境符号）',
  desc: 'go 单独分支；非 go(含 js 家族)走 TS 提取逻辑；python 走本族分支（shape 注解属性 + env/config + effect 候选）',
  default: 'partial_ast',
  overrides: {
    go: 'full_ast',
    typescript: 'full_ast',
    tsx: 'full_ast',
    javascript: 'full_ast',
    jsx: 'full_ast',
    python: 'full_ast',
  },
  notes: {
    python: 'shapes 注解属性 + reads_config(PY_ENV) + writes/holds/emits 候选（PY 正则）',
  },
});

// ─────────────────────────────────────────────
// 版本升级线 + 影响面/跨仓/杂交/行为/健康（自 feat/version-upgrade 移植，2026-09）
// ─────────────────────────────────────────────

/** 版本升级契约差检测：工具链声明扫描 + 语言特性/废弃 API 检测 */
declareCapability({
  id: 'version_upgrade_detection',
  label: '版本升级契约差检测（扫描 + 特性/废弃API）',
  desc: 'version_upgrade 线 detect 内核；go/java/node/python/csharp/c 六适配器均按方言实现工具链扫描、特性命中与废弃 API 检测',
  default: 'unimplemented',
  overrides: {
    go: 'full_ast',
    java: 'full_ast',
    python: 'full_ast',
    c_sharp: 'full_ast',
    c: 'full_ast',
    typescript: 'full_ast',
    tsx: 'full_ast',
    javascript: 'full_ast',
  },
  notes: {
    go: 'go adapter：go.mod / 依赖特性扫描',
    java: 'java adapter：JDK 特性 + 废弃 API',
    python: 'python adapter：版本边界特性',
    c_sharp: 'csharp adapter：global.json SDK / Directory.Build.props LangVersion·TargetFramework + C# 语言版本特性/废弃 API',
    c: 'c adapter：Makefile/CMakeLists -std=cXX / CMAKE_C_STANDARD + C 标准特性/废弃 API',
    typescript: 'node adapter：ts/package.json 特性（统称 node 家族）',
    javascript: '经 node adapter 同一路径',
  },
});

/** 影响面分析：改前风险闭包 */
declareCapability({
  id: 'impact_analysis',
  label: '影响面分析（改前风险闭包报告）',
  desc: '从变更点（文件+可选顶层符号）沿调用边/类型引用做反向可达闭包，输出直接/间接受影响文件与风险排序',
  default: 'unimplemented',
  overrides: {
    typescript: 'full_ast',
    tsx: 'full_ast',
    javascript: 'full_ast',
    jsx: 'full_ast',
    go: 'full_ast',
    python: 'full_ast',
    java: 'full_ast',
    c_sharp: 'full_ast',
    c: 'full_ast',
  },
  notes: {
    go: '跨文件前缀调用 `pkg.Symbol` 经 import bindings 精确连边，重名不漏（2026-09 升级）',
    python: 'import 绑定 + from-import 支持；裸名仍全局唯一匹配',
    java: '经 ts_kernel parseFileFull 通用调用边/限定引用',
    c_sharp: '经 ts_kernel 通用调用边（invocation_expression）',
    c: '经 ts_kernel include/调用边（import_nodes+call_expression 新补）',
  },
});

/** 跨项目符号索引：两仓顶层导出交集/差集 */
declareCapability({
  id: 'cross_repo_symbol_index',
  label: '跨项目符号索引（两仓顶层导出交集）',
  desc: '两仓顶层符号求交=冲突(同名不同签)/双胞胎(同名同签)、求差=迁移范围；复用 impact 依赖索引',
  default: 'unimplemented',
  overrides: {
    typescript: 'full_ast',
    tsx: 'full_ast',
    javascript: 'full_ast',
    jsx: 'full_ast',
    go: 'full_ast',
    python: 'full_ast',
    java: 'full_ast',
    c_sharp: 'full_ast',
    c: 'full_ast',
  },
});

/** 项目杂交预检：符号冲突 + 依赖冲突 + 功能重叠 */
declareCapability({
  id: 'hybrid_precheck',
  label: '项目杂交预检（符号冲突 + 依赖冲突 + 功能重叠）',
  desc: '两个项目根：①顶层导出符号冲突（复用 cross_repo_symbol_index）②依赖版本冲突（读根级 manifest）③功能重叠（同名同签双胞胎）→ verdict ok/fix/blocked',
  default: 'unimplemented',
  overrides: {
    go: 'full_ast',
    typescript: 'full_ast',
    tsx: 'full_ast',
    javascript: 'full_ast',
    jsx: 'full_ast',
    python: 'full_ast',
    java: 'full_ast',
    c_sharp: 'full_ast',
    c: 'full_ast',
  },
});

/** 行为基线：金丝雀 harness capture/verify 对比 */
declareCapability({
  id: 'behavior_baseline',
  label: '行为基线（契约→金丝雀测试对比）',
  desc: 'python 顶层 exec 整文件 / node 家族 transpileModule 转 CJS 整文件 require；Go/Java/C# 反射 harness、C 类型化调用 harness（go run/javac+java/dotnet run/cc 编译，缺工具链报不可用）；样例输入跑一次记录快照(capture)，改后跑一次对比(verify)→判定跑得对不对',
  default: 'unimplemented',
  overrides: {
    python: 'full_ast',
    typescript: 'full_ast',
    tsx: 'full_ast',
    javascript: 'full_ast',
    jsx: 'full_ast',
    go: 'full_ast',
    java: 'full_ast',
    c_sharp: 'full_ast',
    c: 'full_ast',
  },
  notes: {
    python: '解释器直跑（顶层 exec 整文件，自包含函数）',
    typescript: 'node 家族：transpileModule → CJS require（Set/Map 排序化 repr）',
    javascript: '经 node 家族同一 harness',
    go: '反射+go run 临时模块；自包含、基本类型参/返',
    java: '反射+javac 临时包；静态方法按名反射调用，基本类型参数强转',
    c_sharp: '反射+dotnet run 临时工程；静态方法按名反射调用',
    c: '类型化调用 harness：源码正则推断参数类型→生成 main 逐 case 调用→cc/gcc 编译运行（缺工具链报不可用；代码生成纯函数已单测）',
  },
});

/** 代码健康度：死代码 + 复杂度 + 分层违规 */
declareCapability({
  id: 'code_health',
  label: '代码健康度（死代码/复杂度/分层违规）',
  desc: '死代码检测（未使用导出/import/孤儿文件）+ 圈复杂度（AST 分支节点计数）+ 分层违规（积木/契约/胶水反向依赖）',
  default: 'unimplemented',
  overrides: {
    typescript: 'full_ast',
    tsx: 'full_ast',
    javascript: 'full_ast',
    jsx: 'full_ast',
    java: 'full_ast',
    c_sharp: 'full_ast',
    c: 'full_ast',
    python: 'partial_ast',
    go: 'partial_ast',
  },
  notes: {
    typescript: '复杂度=AST 分支节点计数；未使用 import=AST 绑定+使用集比对；未使用导出/孤儿/分层=导入+调用边反查',
    javascript: '经 TS 家族同一解析路径',
    java: '复杂度(正则回退)+未使用 import(AST 绑定: import_declaration)+未使用导出/孤儿/分层(导入+调用边反查)',
    c_sharp: '复杂度+未使用导出/孤儿/分层(导入+调用边反查)；unused_import 不查（using 是命名空间导入，语义同 include，非 per-name）',
    c: '复杂度+未使用导出/孤儿/分层(导入+调用边反查)；unused_import 不查（include 是 include-guard 语义，同 Go）',
    python: '复杂度/未使用 import 已 AST 化；未使用导出/孤儿/分层仍受"导出名唯一"匹配限制（重名不建边）→ partial',
    go: '复杂度已 AST 化，未使用 import 不查（编译器兜底）；未使用导出/孤儿/分层同上限制 → partial',
  },
});