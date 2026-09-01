#!/usr/bin/env node
/**
 * gen_agents —— 自愈生成 AGENTS.md 的「触发点总表」（方案A，2026-09）
 *
 * 背景：AGENTS.md 反复被一个外部持久进程用它的旧快照盖写（重排整表 + 把某行盖回旧值），
 * 且 IDE 打开/重启、git hook、仓库代码、GitHub Actions 都已证伪为写手。鉴别后确认是
 * 仓库之外、触发时机在 commit/agent 行动附近、持旧缓存的东西。
 *
 * 止损方案：把 AGENTS.md 变成「生成产物」。触发点总表由本文件里的 TRIGGER_ROWS 单一事实源
 * 渲染；任何外部把表盖写成什么样，下一次执行本脚本（npm run build / pre-commit）都会重建回
 * 正确版——外部想还原也还原不成。
 *
 * 用法：
 *   node scripts/gen_agents.mjs            # 重建 AGENTS.md（build 里自动执行）
 *   node scripts/gen_agents.mjs --check    # 只比对不写盘，不一致退出码 1（CI/pre-commit 用）
 *   node scripts/gen_agents.mjs --silent   # 不打印成功提示（pre-commit 内调用）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'AGENTS.md');

// ─────────────────────────────────────────────────────────────
// 唯一事实源：触发点总表（按开发动作分组）
// ─────────────────────────────────────────────────────────────
const TRIGGER_ROWS = [
  ['开发前先看 / 画活文档', '`get_dsl` / `render_design` / `edit_dsl` / `manage_feature`', '开工前对齐设计，避免方向性错误'],
  ['日常维护（补节点/改描述/加标注）', '`edit_dsl weight=routine`', '轻量写路径：跳过 L4 证据回溯，仍留 L1-L3 防空话；改架构/契约等重改用 normal 全链'],
  ['改一个模块级符号名', '`rename_symbol`', '自动定根+闭包+跨语言，先 dry_run 看 diff'],
  ['批量改多个符号', '`rename_symbols`', '先整体 dry-run，全部可落盘才落'],
  ['改**对外契约名 / MCP 工具名**', '`rename_symbols report_literals=true`', '扫旧名 snake 字面量清单，按 kind 分治(契约/历史/文档/测试/代码)；契约变更才跟文档'],
  ['改文件名并联动全仓 import', '`rename_file`', '防文件悬空'],
  ['单文件局部变量/形参批量改名', '`rename_many`', '作用域隔离'],
  ['改一段代码（函数体/range）', '`edit_code`', '按符号/行号定位改写'],
  ['理解一串代码/结构', '`explore_code`', '只读、即时答案'],
  ['清理无效 import', '`remove_dead_imports`', '剪刀剪 dead_deps'],
  ['看「谁引用了 X / 谁调用了 X」', '`find_references`', '只读引用查询；mode=field 报字段读取/构造点（加字段/改签名前必查，勿回退 grep）'],
  ['加字段/改接口签名前查波及面', '`find_references mode=field`/`mode=type field=<字段>/symbol=<类型>`', '读/构/解/声明四类 AST 分类＋行内上下文；type 模式找形如某类型的对象字面量构造候选'],
  ['跑测试/提交前回归', '`run_tests`', '结构化失败定位（filter 定向 or 全量）'],
  ['改完代码看设计是否过时/欠实现', '`detect_drift`', '一次性核对：代码变更→提示 DSL 需同步，mode=status 复读台账'],
  ['常驻盯项目漂移（安全网）', '`explore_code action=watch feature=... drift_on_change=true`', '后台监听：文件一变自动 rebuild+过时判定+主动 pushAlert'],
  ['提交前健康检查', '`consistency_check` / `sync_contracts`', '契约/一致性'],
  ['改前看影响面', '`diff_views` / `reconcile_chain`', '波及方向'],
];

// 改名场景表（静态，不随 build 频率变）
const RENAME_ROWS = [
  ['改一个模块级符号（函数/const/class/interface/type/enum）', '`rename_symbol`'],
  ['批量改多个模块级符号', '`rename_symbols`'],
  ['改文件名并联动全仓 import 引用', '`rename_file`'],
  ['单文件内局部变量/形参批量改名', '`rename_many`'],
];

/** 渲染对齐的 Markdown 表格：rows = 数组的数组；无表头时传 null head */
function renderTable(head, rows) {
  const widths = [];
  const all = head ? [head, ...rows] : rows;
  for (const r of all) {
    r.forEach((cell, i) => {
      // 中文字符按 2 列宽估，保证视觉对齐
      const w = [...cell].reduce((acc, ch) => acc + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
      widths[i] = Math.max(widths[i] ?? 0, w);
    });
  }
  const pad = (s, i) => {
    const w = [...s].reduce((acc, ch) => acc + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
    return s + ' '.repeat(widths[i] - w);
  };
  const fmt = (r) => `| ${r.map((c, i) => pad(c, i)).join(' | ')} |`;
  const sep = (i) => `| ${widths.map((w) => '-'.repeat(Math.max(w, 3))).join(' | ')} |`;
  const lines = head ? [fmt(head), sep(), ...rows.map(fmt)] : rows.map(fmt);
  return lines.join('\n');
}

function buildAgents() {
  const triggerTable = renderTable(['开发动作', '必用工具', '说明'], TRIGGER_ROWS);
  const renameTable = renderTable(['场景', '必用工具'], RENAME_ROWS);

  return `# AGENTS.md — design-canvas 开发约定（为 AI agent 编写）

> 本文件约束在此仓库内进行开发时，agent（Trae/Claude 等）应遵循的规则。
> 核心目标：让日常开发动作（改名/编辑/理解/清理/引用/测试/漂移）走项目自带 MCP 工具，
> 而不是用 grep+脚本手动硬改——那是「工具被想起」的最大障碍。

> 注意：本文件的「触发点总表」由 \`scripts/gen_agents.mjs\` 从 TRIGGER_ROWS 单一事实源生成。
> 外部进程若把它盖成旧版，下一次 \`npm run build\` / pre-commit 会自动重建回正确版。
> 改工具映射请改 TRIGGER_ROWS，不要手改本表。

## 触发点总表（按开发动作）

${triggerTable}

## 改名约定（强制优先用工具）

当任务涉及**重命名**（符号、函数、类、文件、变量、作用域内局部名）时，优先使用本仓库 MCP 暴露的
\`rename_*\` 工具，而非 \`grep + 正则\` 手动替换。

${renameTable}

**硬性流程（每次改名都执行）：**

1. 先传 \`dry_run=true\` 看结构化 diff（返回每个受影响文件的 \`ops[{old,new}]\`）。
2. 核对 diff 符合预期后，再去掉 \`dry_run\` 落盘。
3. 改名面向「文件主导出」时（文件名 = 符号名），\`rename_symbol\` 加
   \`rename_file_if_matching=true\` 联动改名文件。
4. 批量改名用 \`rename_symbols\`（先整体 dry-run 校验，全部可落盘才落盘）。

**例外（可绕过工具直接手改）：**

- 目标不是模块级符号（局部变量畅通走 \`rename_many\`，而不是手改）。

- 非 TS/JS/Go/Python 文件的改名，且本仓库工具不支持时。

## 测试约定

- 改完代码用 \`run_tests\`（filter 定向）快速确认，提交前跑全量 \`npm test\` 须全绿。

## 文档同步纪律（契约变更才跟）

- **契约变更**（工具名 / API 签名 / 对外行为 / MCP 注册名）→ 文档**必须**同步（README / AGENTS / skill / 测试断言 / 错误提示字符串），否则文档在说谎。
- **实现变更**（只改内部逻辑，对外名与行为不变）→ **不碰文档**，碰了就是制造噪音。
- 改文档 ≠ 改写历史：\`docs/tool-convergence\` 的历史决策/核验记录是事实，保留原貌，变更用**追加记录**表达，不要把旧记录改成新名。
- 改生成物先改源头：AGENTS.md 由 \`scripts/gen_agents.mjs\` 从 \`TRIGGER_ROWS\` 生成，改工具名要改源头而非生成物本体。

## 工具自检（强约束）

- 本仓库 MCP 工具依赖 \`dist/\` 构建产物。改了 \`src/\` 下的代码，**必须**先
  \`npm run build\` 再调用工具，否则跑的是旧逻辑（STALE BUILD）。

## 决策记录

- 工具收敛 / 命名 / 使用摩擦的决策记录在 \`docs/tool-convergence.md\`。

- 本文件由生成器维护，外部还原会被 \`npm run build\` / pre-commit 自动修复；以 git 提交历史为准。
`;
}

// ─────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const generated = buildAgents();
const existing = (() => {
  try {
    return readFileSync(OUT, 'utf-8');
  } catch {
    return null;
  }
})();

const upToDate = existing === generated;

if (args.includes('--check')) {
  if (!upToDate) {
    console.error('[gen_agents] AGENTS.md 与生成版不一致，请运行 `node scripts/gen_agents.mjs`。');
    process.exit(1);
  }
  process.exit(0);
}

if (!upToDate) {
  writeFileSync(OUT, generated, 'utf-8');
  if (!args.includes('--silent')) console.log('[gen_agents] AGENTS.md 已重建（触发点总表自愈）。');
} else if (!args.includes('--silent')) {
  console.log('[gen_agents] AGENTS.md 已是最新，无需重建。');
}