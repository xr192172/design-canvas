/**
 * diagnose_loop_cli —— 一键诊断闭环 CLI（T5）
 *
 * 把诊断工具从"只建议不执行"升级为闭环：诊断 → 修复 → 验证 → 提交。
 * 单段可启停（用户偏好 modular/stage-based）：
 *
 *   node dist/src/tools/diagnose_loop_cli.js --project <dir> --symptom "<症状>"
 *        [--apply]      跳过补丁审批直接应用（默认逐个交互确认）
 *        [--auto]       全自动：基线提交 + 审批跳过 + 验证通过自动提交
 *        [--skip-verify]跳过验证阶段（未验证则不自动提交）
 *        [--verify-timeout 300]  验证命令超时秒数
 *        [--json]       结构化输出
 *
 * 闭环阶段：
 *   0. 前置：项目必须是 git 仓库（回退依赖 git 还原）
 *   1. 基线：改前若工作区脏 → 提交 baseline 快照（用户偏好：改前自动提交）
 *   2. 诊断：runDiagnosis（规则+LLM 双引擎）
 *   3. 修复：LLM 生成行级补丁 → 白名单校验 → 展示真实 diff → 审批 → 应用
 *   4. 验证：探测项目类型跑测试（npm test / go test / pytest …）
 *   5. 提交/回退：验证通过 → 精确提交补丁文件；失败 → 还原到修复前
 *
 * 安全边界（延续 T4 证据不编造）：
 *   - 补丁只能改「根因文件 + 修复建议 target_file」白名单内的文件
 *   - LLM 只出"行号区间 + 新内容"，应用以磁盘真实内容为准（行号越界拒绝）
 *   - 审批看的是磁盘真实 diff，非 LLM 自述
 *   - 应用前保存原始内容，失败可回退
 */

import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { runDiagnosis, formatDiagnoseText } from '../diagnosis/diagnose.js';
import { generatePatch, applyPatches, revertPatches, formatPatchDiff, allowedPatchFiles } from '../diagnosis/repair.js';
import { detectKind } from '../diagnosis/verifier.js';
import { getProjectCacheDb } from '../db/db.js';
import { walkFiles } from './import_project.js';
import { syncProject } from '../db/symbols.js';
import { isGitRepo, gitDirty, gitCommitFiles, gitCommitAll, gitRestoreFiles } from './git.js';
import type { AppliedPatch } from '../diagnosis/repair.js';

function readArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(name);

function print(...args: unknown[]): void {
  console.log(...args);
}

/** 交互确认：y 通过 / 其它拒绝（--apply/--auto 时跳过） */
async function confirm(rl: ReturnType<typeof createInterface> | null, question: string): Promise<boolean> {
  if (!rl) return true;
  const ans = (await rl.question(question)).trim().toLowerCase();
  return ans === 'y' || ans === 'yes';
}

async function main(): Promise<number> {
  const project = readArg('--project');
  const symptom = readArg('--symptom');
  if (!project || !symptom) {
    console.error('usage: diagnose_loop_cli --project <dir> --symptom "<symptom>" [--apply] [--auto] [--skip-verify] [--verify-timeout 300] [--json]');
    return 2;
  }
  const auto = has('--auto');
  const apply = auto || has('--apply');
  const skipVerify = has('--skip-verify');
  const json = has('--json');
  const timeoutSec = Number(readArg('--verify-timeout') ?? 300);

  const root = path.resolve(project);
  const report: Record<string, unknown> = { project_dir: root, symptom };

  // ── 阶段 0：前置校验（回退依赖 git）
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    print('✗ 项目目录不存在:', root);
    return 1;
  }
  if (!isGitRepo(root)) {
    print('✗ 项目不是 git 仓库——闭环回退依赖 git，拒绝执行');
    return 1;
  }

  // ── 阶段 1：基线快照（改前自动提交，用户偏好）
  const baseline = { committed: false, head: '' };
  if (gitDirty(root)) {
    if (auto || (await confirm(null, '工作区有未提交改动。是否先提交基线快照后继续？[y/N] '))) {
      const r = gitCommitAll(root, 'chore: baseline before diagnose-fix');
      baseline.committed = r.committed;
      baseline.head = r.out.split(/\r?\n/)[0] ?? '';
      if (!r.committed) {
        print('⚠ 基线提交失败（可能无用户配置）：', r.out);
      } else {
        print('✓ 基线已提交:', baseline.head);
      }
    } else {
      print('✗ 用户拒绝提交基线。请先手动提交工作区改动再运行闭环');
      return 1;
    }
  } else {
    print('✓ 工作区干净，无需基线提交');
  }
  report.baseline = baseline;

  // ── 阶段 1.5：建立符号缓存（诊断依赖 cache.db；一键体验免手动跑 import_project）
  print('\n━━ 阶段 1.5/5：建立符号缓存 ━━');
  try {
    const cacheDb = getProjectCacheDb(root);
    const absFiles = walkFiles(root, false);
    const synced = await syncProject(cacheDb, root, absFiles);
    print(`✓ 符号缓存就绪：${synced.total} 文件 / ${synced.updated} 更新 / ${synced.failed} 失败（${synced.ms}ms）`);
    report.cache = { total: synced.total, updated: synced.updated, failed: synced.failed, ms: synced.ms };
  } catch (e) {
    print('⚠ 符号缓存建立失败（本轮诊断降级为无符号证据）:', (e as Error).message);
    report.cache = { error: (e as Error).message };
  }

  // ── 阶段 2：诊断
  print('\n━━ 阶段 2/5：诊断 ━━');
  const diag = await runDiagnosis({ project_dir: root, symptom, use_llm: true });
  report.diagnosis = {
    engine: diag.engine,
    root_cause: diag.root_cause,
    fix_suggestions: diag.fix_suggestions,
  };
  if (!diag.root_cause) {
    print('✗ 未定位到根因（证据不足），无法自动修复。诊断报告：');
    print(formatDiagnoseText(diag));
    return 0;
  }
  print(formatDiagnoseText(diag));

  // ── 阶段 3：修复（LLM 补丁 → 校验 → 审批 → 应用）
  print('\n━━ 阶段 3/5：修复 ━━');
  const repairInput = { project_dir: root, root_cause: diag.root_cause, fix_suggestions: diag.fix_suggestions };
  const allowed = allowedPatchFiles(repairInput);
  const plan = await generatePatch(repairInput);
  if (!plan) {
    print('✗ 无法生成自动修复补丁（未配置 LLM 或 LLM 失败）。闭环止步于诊断；可手动修复后运行项目测试验证。');
    return 0;
  }

  print('待审批补丁（修改白名单:', allowed.join('、'), '）');
  const diffs = formatPatchDiff(root, plan);
  for (const d of diffs) print(d);
  print(`补丁说明：${plan.rationale}`);

  const rl = apply ? null : createInterface({ input: stdin, output: stdout });
  try {
    if (!apply) {
      if (!(await confirm(rl, '应用以上补丁？[y/N] '))) {
        print('✗ 用户拒绝补丁，未改动任何文件。');
        return 0;
      }
    }

    const { applied, errors } = applyPatches(root, plan, allowed);
    if (errors.length > 0) {
      print('✗ 补丁校验失败，未改动任何文件：');
      for (const e of errors) print('  -', e.file, '→', e.reason);
      return 1;
    }
    const changedFiles = [...new Set(applied.map((a: AppliedPatch) => a.file))];
    print('✓ 已应用', applied.length, '个补丁，改动文件:', changedFiles.join('、'));
    report.patch = { rationale: plan.rationale, changed_files: changedFiles };
    report.applied = applied.map((a: AppliedPatch) => ({ file: a.file }));

    // ── 阶段 4：验证
    print('\n━━ 阶段 4/5：验证 ━━');
    if (skipVerify) {
      print('⚠ 已跳过验证（--skip-verify）。未验证的改动不自动提交。');
      report.verify = { skipped: true };
    } else {
      const kind = detectKind(root);
      if (!kind) {
        print('✗ 无法识别项目类型，无法自动验证。已回退补丁。');
        revertPatches(applied);
        gitRestoreFiles(root, changedFiles);
        report.verify = { skipped: true, reverted: true, reason: '项目类型未识别' };
      } else {
        print(`  运行验证命令: ${kind.test}（超时 ${timeoutSec}s）`);
        let ok = false;
        let output = '';
        try {
          output = execSync(kind.test, { cwd: root, encoding: 'utf-8', stdio: 'pipe', timeout: timeoutSec * 1000 });
          ok = true;
        } catch (e) {
          output = (e as { stdout?: string; stderr?: string; message?: string }).stdout
            ?? (e as { stderr?: string }).stderr
            ?? (e as { message?: string }).message
            ?? '未知错误';
        }
        const tail = output.split(/\r?\n/).filter(Boolean).slice(-15).join('\n');
        report.verify = { command: kind.test, ok, output_tail: tail };
        if (ok) {
          print('✓ 验证通过');
          print(tail);
        } else {
          print('✗ 验证失败，正在回退补丁…');
          print(tail);
          revertPatches(applied);
          gitRestoreFiles(root, changedFiles);
          print('✓ 已回退，项目恢复到修复前状态');
        }
      }
    }

    // ── 阶段 5：提交 / 停止
    print('\n━━ 阶段 5/5：提交 ━━');
    const verified = report.verify && (report.verify as { ok?: boolean }).ok;
    if (verified) {
      const msg = `fix(diagnose-loop): 自动修复 ${diag.root_cause?.symbol}（${diag.root_cause?.file_path}:${diag.root_cause?.line}）——${plan.rationale}`;
      if (auto || (await confirm(rl, `验证通过，提交修复？[y/N] 提交信息: ${msg}\n`))) {
        const r = gitCommitFiles(root, changedFiles, msg);
        if (r.committed) {
          print('✓ 已提交:', r.out.split(/\r?\n/)[0] ?? '');
          report.commit = { committed: true, message: msg, out: r.out };
        } else {
          print('⚠ 提交失败：', r.out);
          report.commit = { committed: false, out: r.out };
        }
      } else {
        print('⚠ 验证通过但用户拒绝提交。改动保留在工作区，请自行 review 后提交。');
        report.commit = { committed: false, reason: '用户拒绝' };
      }
    } else {
      print('未通过验证（或已跳过），未提交。');
    }
  } finally {
    rl?.close();
  }

  print('\n=== diagnose-loop 闭环完成 ===');
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  }
  return 0;
}

main().catch((e) => {
  console.error('diagnose_loop_cli 失败：', e);
  process.exit(1);
});
