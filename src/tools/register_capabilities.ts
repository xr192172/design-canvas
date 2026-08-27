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

// ─────────────────────────────────────────────
// 影响面/项目杂交线：规划中的全景（T9 登记，逐项实现）
// 统一 default: unimplemented —— 目前均为"已立项未实现"，全景缺口据此可视化
// 语言层面的实现顺序：先 TS 家族（解析/调用边最全），再 go/python/java
// ─────────────────────────────────────────────

/** 影响面分析：改前风险报告 —— 从变更点做反向可达闭包传播，输出受影响文件+风险排序 */
declareCapability({
  id: 'impact_analysis',
  label: '影响面分析（改前风险闭包报告）',
  desc: '从变更点（文件+符号）沿调用边/类型引用做反向可达闭包传播，输出直接/间接受影响文件与风险排序；复用 ast_parse_skeleton 的调用边；跨项目版支撑杂交验证',
  default: 'unimplemented',
  overrides: {
    typescript: 'full_ast',
    tsx: 'full_ast',
    javascript: 'full_ast',
    jsx: 'full_ast',
    go: 'full_ast',
    python: 'full_ast',
  },
  notes: {
    typescript: 'T9 已落地：依赖图三路证据(import/call/type_ref) + 符号级变更点 + 热区盘点',
    javascript: '经 TS 家族同一解析路径',
  },
});

/** 跨项目符号索引：把单仓的符号解析/改名/影响面扩到两仓（杂交的地基） */
declareCapability({
  id: 'cross_repo_symbol_index',
  label: '跨项目符号索引（两仓顶层导出交集）',
  desc: '为 rename_symbol / package_migration / impact_analysis 提供跨项目符号集合：顶层导出求交=冲突清单、求差=迁移范围；单仓索引已有，跨项目是自然扩展',
  default: 'unimplemented',
  overrides: {
    typescript: 'full_ast',
    tsx: 'full_ast',
    javascript: 'full_ast',
    jsx: 'full_ast',
    go: 'full_ast',
    python: 'full_ast',
  },
  notes: {
    typescript: 'T9 已落地：两仓顶层符号求交(冲突/双胞胎)+求差(迁移范围)，复用 impact 依赖图索引',
    javascript: '经 TS 家族同一解析路径',
  },
});

/** 杂交预检：把 X 塞进 Y 前，先回答"会不会打架" */
declareCapability({
  id: 'hybrid_precheck',
  label: '项目杂交预检（符号冲突 + 依赖冲突 + 功能重叠）',
  desc: '输入两个项目根：①顶层导出符号冲突清单（复用 cross_repo_symbol_index）②依赖并集/版本冲突（读根级 manifest package.json/go.mod/pyproject.toml/requirements.txt）③功能重叠（同名同签双胞胎=可去重的语义重复）→ 输出 verdict ok/fix/blocked',
  default: 'unimplemented',
  overrides: {
    go: 'full_ast',
    typescript: 'full_ast',
    tsx: 'full_ast',
    javascript: 'full_ast',
    jsx: 'full_ast',
    python: 'full_ast',
  },
  notes: {
    typescript: 'T9 已落地：三维体检（符号层复用 cross_repo，依赖层读根级 manifest 比版本，重叠层用双胞胎强信号）',
    javascript: '经 TS 家族同一解析路径',
  },
});

/** 行为基线：契约→金丝雀测试，验证"跑得对不对"（补动态闸只验"跑得动"的缺口） */
declareCapability({
  id: 'behavior_baseline',
  label: '行为基线（契约→金丝雀测试对比）',
  desc: '从 extract_contracts 的签名骨架生成金丝雀/属性测试，改动前后各跑一次对比行为差异；与动态闸（只验不炸）互补，是"行为级验证"闭环',
  default: 'unimplemented',
  overrides: {
    python: 'full_ast',
  },
  notes: {
    typescript: 'T9 第四阶段已落地（Python 金丝雀 harness）：capture 记录行为快照 → 改代码 → verify 逐 case 对比 → same/diff',
    python: 'T9 已落地：harness 顶层 exec 目标文件 + 规范化 repr 返回值 + stdout 痕迹 + 源码快照，真跑解释器对比',
  },
});

/** 代码健康度：选材体检 + 三层架构违规检测（用工具守护积木/契约/胶水哲学） */
declareCapability({
  id: 'code_health',
  label: '代码健康度（死代码/复杂度/分层违规）',
  desc: '死代码检测（复用调用边反查未使用导出）+ 圈复杂度 + 依赖方向违规（胶水层反向依赖积木层）；独立性强可并行；是项目杂交"选材体检"的评分依据',
  default: 'unimplemented',
  notes: {
    typescript: '立项：T9 第五阶段，死代码零成本起步',
  },
});