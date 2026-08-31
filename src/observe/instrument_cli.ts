/**
 * Observe 全自动插桩 CLI（独立入口）
 *
 * 目的：让「扩插桩覆盖」变成跑一条命令全量自动完成，取代任何手动在源码里
 * 手写 captureProbe 的做法。对目标项目所有 .ts 文件 AST 全量无脑插桩
 * （函数出入口/return/catch/IO 写盘），幂等（已含探针标记的文件跳过）。
 *
 * 用法（项目根，先构建）：
 *   node dist/src/observe/instrument_cli.js <project> [--dry-run] [--project-root <根>]
 *   node dist/src/observe/instrument_cli.js <project> --uninstrument
 *   node dist/src/observe/instrument_cli.js <project> --ledger
 *
 *   <project>       要插桩的目标项目目录（默认当前目录）
 *   --dry-run       只报告会注入的探针点，不写盘
 *   --uninstrument  一键全拔：从 .design-canvas/observe-backup 拷回所有原文件，
 *                   删除备份目录，并清理探针台账（插桩时已自动备份原文件+记账）
 *   --ledger        查看探针台账：一次插桩的全部探针点 + 统计（JSON 打印）
 *   --project-root  design-canvas 根（探针实现 src/observe/probe.js 所在仓库根），
 *                   用于计算被插桩文件 → probe.js 的相对 import 路径。默认自动推断。
 *
 * 输出：每个文件注入的探针点数 + 汇总；idempotent——重跑时已插桩文件标记为跳过。
 * 台账：写盘插桩成功后自动生成 .design-canvas/observe-ledger.json（一键全拔时联动清理）。
 * 回退：插桩写盘前会在 .design-canvas/observe-backup 自动备份原文件；--uninstrument 一键全拔。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  instrumentProject,
  collectTsFiles,
  restoreInstrumented,
  buildProbeLedger,
  saveProbeLedger,
  loadProbeLedger,
  clearProbeLedger,
  ledgerSummary,
} from './instrument.js';

const isMain = import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href;

/** 推断 design-canvas 根：向上找含 src/observe/probe.ts 的目录 */
function inferRoot(from: string): string {
  let dir = path.resolve(from);
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'src', 'observe', 'probe.ts'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(from);
}

export async function runInstrumentCLI(argv: string[]): Promise<void> {
  let target = process.cwd();
  let dryRun = false;
  let unintrument = false;
  let viewLedger = false;
  let projectRoot: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') { dryRun = true; continue; }
    if (argv[i] === '--uninstrument') { unintrument = true; continue; }
    if (argv[i] === '--ledger') { viewLedger = true; continue; }
    if (argv[i] === '--project-root' && i + 1 < argv.length) { projectRoot = argv[i + 1]; i++; continue; }
    if (argv[i].startsWith('--project-root=')) { projectRoot = argv[i].slice('--project-root='.length); continue; }
    if (argv[i].startsWith('-')) continue;
    target = argv[i];
  }

  const root = path.resolve(target);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`observe-instrument: 目标目录不存在或不是目录: ${root}`);
    process.exit(1);
  }

  // ── 查看探针台账：一次插桩的全部探针点 + 统计 ──
  if (viewLedger) {
    const ledger = loadProbeLedger(root);
    if (!ledger) {
      console.log(`=== Observe 探针台账 [${root}] ===`);
      console.log('未找到台账（可能从未插桩，或已一键全拔清理）。');
      return;
    }
    console.log(`=== Observe 探针台账 [${root}] ===`);
    console.log(`插桩时间：${ledger.instrumentedAt}`);
    console.log(`统计：${ledgerSummary(ledger)}`);
    console.log('── 明细（探针点）──');
    for (const s of ledger.sites) {
      console.log(`  ${path.relative(root, s.file) || s.file} L${s.line} [${s.kind}/${s.level}] ${s.injected.trim().split('\n')[0]}`);
    }
    return;
  }

  // ── 一键全拔：从 .design-canvas/observe-backup 拷回所有原文件，清理台账 ──
  if (unintrument) {
    const restored = restoreInstrumented(root);
    const cleared = clearProbeLedger(root);
    if (restored.length === 0 && !cleared) {
      console.log(`=== Observe 一键全拔 [${root}] ===`);
      console.log('未找到备份与台账，无需还原（可能从未插桩，或备份已删）。');
      return;
    }
    console.log(`=== Observe 一键全拔 [${root}] ===`);
    for (const f of restored) {
      console.log(`  ↺ ${path.relative(root, f) || f}`);
    }
    const lines = [`\n已还原 ${restored.length} 个文件，删除备份目录。`];
    if (cleared) lines.push('已清理探针台账。');
    else lines.push('（无台账可清理）');
    console.log(lines.join(''));
    return;
  }

  const pr = projectRoot ? path.resolve(projectRoot) : inferRoot(root);
  const mode = dryRun ? 'DRY-RUN' : 'WRITE';
  console.log(`=== Observe 全自动插桩 [${mode}] → ${root} ===`);
  console.log(`project-root=${pr}`);

  const files = collectTsFiles(root);
  console.log(`扫描到 ${files.length} 个 .ts 文件\n`);

  const results = await instrumentProject(root, { projectRoot: pr, write: !dryRun });

  let totalSites = 0;
  let instrumented = 0;
  let skipped = 0;
  let errors = 0;
  for (const r of results) {
    if (r.error) {
      errors++;
      console.log(`  ✗ ${r.file}  ${r.error}`);
    } else if (r.sites.length > 0) {
      instrumented++;
      totalSites += r.sites.length;
      if (!dryRun) {
        console.log(`  + ${r.file}  注入 ${r.sites.length} 探针点`);
      } else {
        console.log(`  + ${r.file}  将注入 ${r.sites.length} 探针点`);
        for (const s of r.sites) {
          console.log(`      L${s.line} [${s.kind}] ${s.injected.trim().split('\n')[0]}`);
        }
      }
    } else {
      skipped++;
    }
  }

  console.log(`\n完成：${instrumented} 文件新插桩 / ${skipped} 文件已含探针跳过 / ${errors} 文件失败，共 ${totalSites} 探针点`);

  // 写盘插桩成功后记账：生成探针台账 + 统计（供 --ledger 查看、一键全拔联动清理）
  if (!dryRun && totalSites > 0) {
    const ledger = buildProbeLedger(results, root);
    const ledgerFile = saveProbeLedger(root, ledger);
    console.log(`\n探针台账已记账 → ${ledgerFile}`);
    console.log(`统计：${ledgerSummary(ledger)}`);
    console.log('提示：--ledger 查看明细，--uninstrument 一键全拔并清理台账。');
  }

  if (dryRun) {
    console.log('DRY-RUN 未写盘。去掉 --dry-run 实际改写源码（git 可兜底，幂等）。');
  }
}

if (isMain) {
  runInstrumentCLI(process.argv.slice(2)).catch((e) => {
    console.error('observe-instrument:', (e as Error).message);
    process.exitCode = 1;
  });
}

export default runInstrumentCLI;