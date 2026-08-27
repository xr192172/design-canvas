/**
 * upgrade_rewrite_cli —— 版本升级契约差 · 局部重写闭环 CLI（阶段 D）
 *
 * 把"检测"升级为闭环：差异报告 → 局部重写建议 → 应用 → 验证 → 提交 / 回退。
 * 复用仓库既有安全网：git.ts（基线快照 / 精确提交 / 回退）+ verify_refactor.ts（验证命令组）。
 *
 * 用法：
 *   node dist/src/tools/upgrade_rewrite_cli.js <root>
 *        [--apply <edits.json>]  进入闭环：应用编辑（JSON 形如 [{file, from, to}]）
 *        [--skip-verify]         跳过验证阶段（未验证则不自动提交）
 *        [--json]                末尾输出结构化报告
 *
 * 闭环阶段：
 *   0. 前置：仅 --apply 时要求 root 为 git 仓库（回退依赖 git 还原）
 *   1. 差异报告：工具链盘点 + 语言特性超标 + 废弃/移除 API（runContractScan）
 *   2. 局部重写建议：按文件聚合成有序动作清单，标出可确定性自动改写项
 *   3. 应用（--apply）：读取 LLM/人工准备的编辑 JSON → 精确字符串替换（歧义/未命中拒绝）
 *      → 改前基线提交 → 验证（按项目形态探测，默认 build/test）→ 通过则精确提交；
 *      失败则 git 还原到改写前
 */

import fs from 'node:fs';
import path from 'node:path';
import { runContractScan } from '../version_upgrade/detect.js';
import { buildRewritePlan, applyEdits, type PlanEdit } from '../version_upgrade/rewrite.js';
import { runVerification, defaultVerifyCommands } from './verify_refactor.js';
import { isGitRepo, gitDirty, gitCommitFiles, gitCommitAll, gitRestoreFiles } from './git.js';

function readArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(name);

function print(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log(...args);
}

function main(): number {
  const root = path.resolve(process.argv[2] ?? process.cwd());
  const json = has('--json');
  const editsFile = readArg('--apply');
  const skipVerify = has('--skip-verify');
  const report: Record<string, unknown> = { root };

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    print('✗ 项目目录不存在:', root);
    return 1;
  }

  // ── 阶段 1：差异报告 ──
  print(`版本升级契约差检测：${root}`);
  const res = runContractScan(root);
  const featureCount = res.features.reduce((n, g) => n + g.hits.length, 0);
  const removedCount = res.removed.reduce((n, g) => n + g.hits.length, 0);
  const badMatch = res.scan.matches.filter((m) => m.status !== 'ok').length;
  report.contract = {
    declarations: res.scan.declarations.length,
    mismatched_runtimes: badMatch,
    feature_over_boundary: featureCount,
    removed_deprecated_api: removedCount,
  };
  print(`  工具链声明 ${res.scan.declarations.length} 项（${badMatch} 项不匹配本机）· 语言特性超标 ${featureCount} 处 · 废弃/移除 API ${removedCount} 处`);

  // ── 阶段 2：局部重写建议 ──
  const plan = buildRewritePlan(res.features, res.removed);
  if (plan.length === 0) {
    print('  无可重写的契约差（所有子项目源码均在声明版本边界内且无废弃/移除 API 使用）');
  } else {
    print(`  局部重写建议（${plan.length} 条，按文件/行序）：`);
    for (const it of plan) {
      const tag = it.auto ? '[可自动]' : '[需LLM]';
      print(`    ${tag} ${it.file}:${it.line}  ${it.kind === 'feature' ? '特性' : 'API'}「${it.label}」(since ${it.since})`);
      print(`        → ${it.suggestion}：${it.snippet}`);
    }
  }
  report.plan = plan.map((it) => ({ file: it.file, line: it.line, kind: it.kind, label: it.label, since: it.since, suggestion: it.suggestion, auto: it.auto }));

  // 仅报告模式
  if (!editsFile) {
    print('\n（仅报告模式。加 --apply <edits.json> 进入 git 验证回退闭环；编辑 JSON: [{"file":"...","from":"...","to":"..."}]）');
    if (json) print(JSON.stringify(report, null, 2));
    return 0;
  }

  // ── 阶段 3：git 验证回退闭环 ──
  print('\n━━ 闭环：应用 → 验证 → 提交/回退 ━━');

  // 0. 前置：git 仓库（回退依赖）
  if (!isGitRepo(root)) {
    print('✗ root 不是 git 仓库——闭环回退依赖 git，拒绝执行');
    return 1;
  }

  // 读取并校验编辑 JSON
  let edits: PlanEdit[];
  try {
    edits = JSON.parse(fs.readFileSync(editsFile, 'utf-8')) as PlanEdit[];
    if (!Array.isArray(edits) || edits.some((e) => !e?.file || typeof e?.from !== 'string' || typeof e?.to !== 'string')) {
      throw new Error('编辑 JSON 结构应为 [{file, from, to}, ...]');
    }
  } catch (e) {
    print('✗ 编辑文件非法:', (e as Error).message);
    return 1;
  }
  report.edits = edits;

  // 1. 基线快照（改前自动提交，用户偏好）
  if (gitDirty(root)) {
    const r = gitCommitAll(root, 'chore: baseline before upgrade-rewrite');
    report.baseline = { committed: r.committed, out: r.out };
    print(r.committed ? '✓ 基线已提交（工作区原有改动先落盘）' : `⚠ 基线提交失败（可能无用户配置）: ${r.out}`);
  } else {
    print('✓ 工作区干净，无需基线提交');
  }

  // 2. 应用编辑（先校验后落盘：歧义/未命中 → 拒绝，不改任何文件）
  let changedFiles: string[];
  try {
    const r = applyEdits(root, edits);
    changedFiles = r.changedFiles;
    print(`✓ 已应用编辑 ${r.applied} 处，实际改动文件: ${changedFiles.join('、') || '（无）'}`);
  } catch (e) {
    print('✗ 编辑校验失败，未改动任何文件:', (e as Error).message);
    return 1;
  }
  report.changed_files = changedFiles;

  // 3. 验证
  if (skipVerify) {
    print('⚠ 已跳过验证（--skip-verify）。未验证的改动不自动提交。');
    report.verify = { skipped: true };
  } else {
    const commands = defaultVerifyCommands(root);
    if (commands.length === 0) {
      print('✗ 无法识别项目形态（无 go.mod/package.json 等），无法自动验证。已回退改动。');
      gitRestoreFiles(root, changedFiles);
      report.verify = { skipped: true, reverted: true, reason: '项目形态未识别' };
    } else {
      print(`  运行验证: ${commands.map((c) => c.label).join('、')}`);
      const outcome = runVerification({ cwd: root, commands });
      report.verify = { status: outcome.status, detail: outcome.detail };
      if (outcome.status === 'pass') {
        print('✓ 验证通过');
        const msg = 'feat(upgrade): 局部重写版本升级契约差';
        const r = gitCommitFiles(root, changedFiles, msg);
        report.commit = { committed: r.committed, message: msg, out: r.out };
        print(r.committed ? `✓ 已提交: ${r.out.split(/\r?\n/)[0] ?? ''}` : `⚠ 提交失败: ${r.out}`);
      } else {
        print('✗ 验证失败，正在回退…');
        print((outcome.detail ?? '').split(/\r?\n/).filter(Boolean).slice(-15).join('\n'));
        gitRestoreFiles(root, changedFiles);
        print('✓ 已回退，项目恢复改写前状态');
        report.rollback = true;
      }
    }
  }

  if (json) print(JSON.stringify(report, null, 2));
  return 0;
}

process.exit(main());
