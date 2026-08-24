/**
 * split_stage_cli —— 拆分执行器 CLI（signal_review 最后一棒的落地入口）
 *
 * 消费 signal_review 产出的报告 JSON（形如 { signals_scanned: [...], review: { reviews: [...] } }），
 * 把复核判"采纳"的概念簇按簇切出独立文件。默认 dry-run 只出草稿；加 --apply 才真实落盘，
 * 由 derive_split 内置的编译/测试级验收 + 失败回滚兜底。
 *
 * 用法：
 *   node dist/src/tools/split_stage_cli.js --project <dir> --report <signal_review_report.json>
 *        [--source <subdir>] [--apply] [--max-symbols <n>] [--no-reexport]
 */
import fs from 'node:fs';
import path from 'node:path';
import { runSplitStage } from './split_stage.js';

function readArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const project = readArg('--project');
  const reportPath = readArg('--report');
  const source = readArg('--source');
  if (!project || !reportPath) {
    console.error('usage: split_stage_cli --project <dir> --report <signal_review_report.json> [--source <subdir>] [--apply] [--max-symbols <n>] [--no-reexport]');
    process.exit(2);
  }
  const dryRun = !process.argv.includes('--apply');
  const noReexport = process.argv.includes('--no-reexport');
  const maxSymbols = readArg('--max-symbols') ? parseInt(readArg('--max-symbols')!, 10) : undefined;

  let report: { signals_scanned: unknown; review?: unknown };
  try {
    report = JSON.parse(fs.readFileSync(path.resolve(reportPath), 'utf8'));
  } catch (e) {
    console.error(`[split-stage] 无法读取报告 ${reportPath}:`, (e as Error).message);
    process.exit(1);
  }

  const signals = (report.signals_scanned ?? []) as never[];
  const reviews = ((report.review as { reviews?: unknown })?.reviews ?? []) as never[];
  if (signals.length === 0 || reviews.length === 0) {
    console.log('[split-stage] 报告内无信号/复核结论，无可拆。');
    return;
  }

  console.log(`[split-stage] 消费 ${reviews.length} 条复核结论 → 推导采纳簇并拆分（${dryRun ? 'dry-run' : '已 apply'}）`);
  const result = await runSplitStage({
    project_dir: project,
    source_root: source,
    signals: signals as any,
    reviews: reviews as any,
    dry_run: dryRun,
    re_export_extracted: !noReexport,
    max_symbols: maxSymbols,
  });

  if (result.message) console.log(result.message);
  console.log(
    `[split-stage] 采纳 ${result.total_plans} 簇 → 拆出 ${result.total_splits} 簇，成功 ${result.applied}${result.items.some((i) => i.status === 'rolled_back') ? '，有回滚' : ''}`,
  );
  if (dryRun) {
    console.log('[split-stage] dry-run：未写文件。确认草稿后加 --apply 执行。');
  }
}

main().catch((e) => {
  console.error('[split-stage] failed:', e);
  process.exit(1);
});