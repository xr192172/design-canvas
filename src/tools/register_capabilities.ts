/**
 * register_capabilities —— 现有多语言功能的支持度登记（能力矩阵的数据填充）
 *
 * 每个登记项声明：功能 id / 默认支持度 / 逐语言覆盖。
 * 依据来自各工具的既有实现（实测分支点），不是臆造：
 *   - package_migration 的 cleanAlias：Go/TS 家族/Python 已走 AST 作用域守卫；
 *     其余语言仍回退正则（cleanAliasRegex）。
 *   - rename_symbol / contract_gate / extract_contracts：只实现了 go + ts 两条分支。
 *   - version_upgrade 线（detect/gate）：工具链扫描 + 特性/废弃 API 检测四语言齐备；
 *     静态闸 python/java 全量、go/js 降级项目级构建；动态闸 python 全量、java 部分、go/js 未实现。
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

/** 符号改名：仅实现 TS 家族（TS_EXTS 中文名解析 + import/reexport 边） */
declareCapability({
  id: 'rename_symbol',
  label: '符号改名（作用域解析 + 跨文件 import 边）',
  desc: '当前只实现 TS 家族（typescript/tsx/javascript/jsx 及其扩展）；Go/Python 走别的路子',
  default: 'unimplemented',
  overrides: {
    typescript: 'full_ast',
    tsx: 'full_ast',
    javascript: 'full_ast',
    jsx: 'full_ast',
  },
  notes: {
    go: 'Go 改名走 refactor_pipeline / rename_file 等其他线',
    python: 'Python 改名尚未接 rename_symbol',
  },
});

/** 契约对账闸门：go 分支 + JS/TS 家族（非 go 一律走 TS 逻辑，JS 是 TS 子集语法兼容） */
declareCapability({
  id: 'contract_gate',
  label: '契约对账闸门（重构后裸标识符定义源检查）',
  desc: 'go 单独分支；ts/tsx/js/jsx/mjs/cjs 走同一套 TS 逻辑（语法兼容）；python/其他语言未纳入',
  default: 'unimplemented',
  overrides: {
    go: 'full_ast',
    typescript: 'full_ast',
    tsx: 'full_ast',
    javascript: 'full_ast',
    jsx: 'full_ast',
  },
});

/** 契约提取（签名/env 对账）：go 分支 + 非 go 一律走 TS 逻辑 */
declareCapability({
  id: 'extract_contracts',
  label: '契约提取（签名 + 环境符号）',
  desc: 'go 单独分支；非 go（含 js 家族）走同一套 TS 提取逻辑；python 语法差异大未专门适配',
  default: 'partial_ast',
  overrides: {
    go: 'full_ast',
    typescript: 'full_ast',
    tsx: 'full_ast',
    javascript: 'full_ast',
    jsx: 'full_ast',
    python: 'unimplemented',
  },
});

// ─────────────────────────────────────────────
// version_upgrade 线：版本升级契约差检测（detect / gate 通用内核 + 适配器）
// 语言代号映射：适配器的 java→'java'、node→JS/TS 家族、go→'go'、python→'python'
// ─────────────────────────────────────────────

/** 阶段 A/B/C：工具链声明扫描 + 语言特性超标 + 废弃/移除 API 检测 —— 四适配器均已实现 */
declareCapability({
  id: 'version_upgrade_detection',
  label: '版本升级契约差检测（扫描 + 特性/废弃API）',
  desc: 'version_upgrade 线 detect 内核；Java/Node/Go/Python 四适配器均按方言实现',
  default: 'unimplemented',
  overrides: {
    java: 'full_ast',
    go: 'full_ast',
    python: 'full_ast',
    typescript: 'full_ast',
    tsx: 'full_ast',
    javascript: 'full_ast',
    jsx: 'full_ast',
  },
  notes: {
    typescript: 'Node 适配器（sourceExts 含 .ts/.tsx/.js/.jsx/.mjs/.cjs）覆盖 JS/TS 家族',
    javascript: 'Node 适配器（sourceExts 含 .ts/.tsx/.js/.jsx/.mjs/.cjs）覆盖 JS/TS 家族',
  },
});

/** 阶段 D：静态闸编译级校验 —— Python/Java 逐文件按声明版本编译；Go/Node 降级为项目级构建验证 */
declareCapability({
  id: 'static_gate',
  label: '静态闸（编译级契约差）',
  desc: 'python: ast.parse(feature_version)；java: javac --release；go/node: 无单文件按版本编译，仅项目级构建验证',
  default: 'unimplemented',
  overrides: {
    python: 'full_ast',
    java: 'full_ast',
    go: 'partial_ast',
    typescript: 'partial_ast',
    tsx: 'partial_ast',
    javascript: 'partial_ast',
    jsx: 'partial_ast',
  },
  notes: {
    go: '无单文件按版本编译手段，静态闸降级为 go build/test（项目级验证）',
    javascript: '无单文件按版本编译手段，静态闸降级为 tsc/项目级构建验证',
  },
});

/** 阶段 E：动态闸运行级探针 —— Python 全量可运行探测；Java 仅自包含 main 类；Go/Node 暂未实现 */
declareCapability({
  id: 'dynamic_gate',
  label: '动态闸（运行级契约差）',
  desc: 'python: 解释器真跑捕获运行时异常；java: javac+java 运行自包含 main 类；go/node: 暂未实现',
  default: 'unimplemented',
  overrides: {
    python: 'full_ast',
    java: 'partial_ast',
  },
  notes: {
    java: '仅自包含且带 main 入口的类可做运行探测，其余 skipped',
    go: '动态闸待实现',
    javascript: '动态闸待实现',
  },
});