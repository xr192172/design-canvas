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
// 版本升级线 + 影响面/跨仓/杂交/行为/健康（自 feat/version-upgrade 移植，2026-09）
// ─────────────────────────────────────────────

/** 版本升级契约差检测：工具链声明扫描 + 语言特性/废弃 API 检测 */
declareCapability({
  id: 'version_upgrade_detection',
  label: '版本升级契约差检测（扫描 + 特性/废弃API）',
  desc: 'version_upgrade 线 detect 内核；go/java/node/python 四适配器均按方言实现工具链扫描、特性命中与废弃 API 检测',
  default: 'unimplemented',
  overrides: {
    go: 'full_ast',
    java: 'full_ast',
    python: 'full_ast',
    typescript: 'full_ast',
    tsx: 'full_ast',
    javascript: 'full_ast',
  },
  notes: {
    go: 'go adapter：go.mod / 依赖特性扫描',
    java: 'java adapter：JDK 特性 + 废弃 API',
    python: 'python adapter：版本边界特性',
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
  },
});

/** 行为基线：金丝雀 harness capture/verify 对比 */
declareCapability({
  id: 'behavior_baseline',
  label: '行为基线（契约→金丝雀测试对比）',
  desc: 'python 顶层 exec 整文件 / node 家族 transpileModule 转 CJS 整文件 require；样例输入跑一次记录快照(capture)，改后跑一次对比(verify)→判定跑得对不对',
  default: 'unimplemented',
  overrides: {
    python: 'full_ast',
    typescript: 'full_ast',
    tsx: 'full_ast',
    javascript: 'full_ast',
    jsx: 'full_ast',
  },
  notes: {
    python: '解释器直跑（顶层 exec 整文件，自包含函数）',
    typescript: 'node 家族：transpileModule → CJS require（Set/Map 排序化 repr）',
    javascript: '经 node 家族同一 harness',
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
    python: 'partial_ast',
    go: 'partial_ast',
  },
  notes: {
    typescript: '复杂度=AST 分支节点计数；未使用 import=AST 绑定+使用集比对；未使用导出/孤儿/分层=导入+调用边反查',
    javascript: '经 TS 家族同一解析路径',
    python: '复杂度/未使用 import 已 AST 化；未使用导出/孤儿/分层仍受"导出名唯一"匹配限制（重名不建边）→ partial',
    go: '复杂度已 AST 化，未使用 import 不查（编译器兜底）；未使用导出/孤儿/分层同上限制 → partial',
  },
});