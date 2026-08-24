/**
 * signal_review_cli —— 混合文件解耦信号的 LLM 复核 CLI（独立阶段，单段可启停）
 *
 * 用法：
 *   node dist/src/tools/signal_review_cli.js --project <dir> [--source <subdir>]
 *        [--json <report.json>]
 *
 * 流程：先跑 brickify 拿 mixed_files 信号 → 逐信号喂 LLM（读文件全文+注释）
 *       → 逐簇产出【采纳/驳回 + 功能名 + 证据】→ 控制台摘要 + 可选 JSON 报告。
 *
 * 判据（见 signal_review.ts）：独立使用者 / 独立演进 / 文档证据。工具函数簇 → 驳回；
 *   新旧世代并存且注释明言 → 采纳。
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildBrickify } from './brickify.js';
import { reviewSignals } from './signal_review.js';

function readArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const project = readArg('--project');
  if (!project) {
    console.error('usage: signal_review_cli --project <dir> [--source <subdir>] [--json <report.json>] [--timeout <ms>] [--only <file1>,<file2>] [--max-src <chars>]');
    process.exit(2);
  }
  const source = readArg('--source');
  const jsonOut = readArg('--json');
  const timeoutMs = readArg('--timeout') ? parseInt(readArg('--timeout')!, 10) : undefined;
  const only = readArg('--only')?.split(',') || [];
  const maxSrc = readArg('--max-src') ? parseInt(readArg('--max-src')!, 10) : undefined;

  const brick = await buildBrickify({ project_dir: project, source_root: source });
  if (brick.mixed_files.length === 0) {
    console.log(`[signal-review] 无混合文件信号（${brick.meta.scanned_files} 文件），无需复核`);
    return;
  }
  console.log(
    `[signal-review] ${brick.mixed_files.length} 个混合文件信号${only.length ? `（仅 ${only.length} 个）` : ''} → LLM 复核中…`,
  );
  const result = await reviewSignals({
    project_dir: project,
    source_root: source,
    signals: brick.mixed_files,
    timeout_ms: timeoutMs,
    max_source_chars: maxSrc,
    only: only.length ? only : undefined,
  });

  if (!result) {
    console.warn('[signal-review] LLM 不可用（未配置 apiKey）——按原始信号降级，未复核。');
    return;
  }

  console.log(
    `[signal-review] ${result.meta.total_signals} 信号 → ${result.meta.actionable} 个需拆(采纳) / ${result.meta.rejected} 个驳回`,
  );
  for (const r of result.reviews) {
    const tag = r.actionable ? '✅采纳' : '❌驳回';
    console.log(`  ${tag} ${r.file}${r.note ? `（${r.note}）` : ''}`);
    for (const cr of r.reviews) {
      console.log(`      - ${cr.adopt ? '[拆]' : '[留]'} ${cr.cluster} ${cr.adopt ? `→ ${cr.feature}` : ''} — ${cr.reason}`);
    }
  }

  if (jsonOut) {
    fs.writeFileSync(
      path.resolve(jsonOut),
      JSON.stringify({ signals_scanned: brick.mixed_files, review: result }, null, 2),
      'utf-8',
    );
    console.log(`[signal-review] JSON 报告 → ${path.resolve(jsonOut)}`);
  }
}

main().catch((e) => {
  console.error('[signal-review] failed:', e);
  process.exit(1);
});