/**
 * behavior_cli —— 行为基线命令行入口
 *
 * 用法:
 *   node dist/src/tools/behavior_cli.js capture <projectDir> --file <rel> --func <name> --cases '<json>' [--baseline <out>]
 *   node dist/src/tools/behavior_cli.js capture <projectDir> --file <rel> --func <name> --cases-file <p>   [--baseline <out>]
 *   node dist/src/tools/behavior_cli.js verify  <projectDir> --file <rel> --func <name>                   [--baseline <in>]
 *
 * capture：记录行为基线（金丝雀用例跑一次，存 JSON）
 * verify ：对当前磁盘再跑同一份 harness，与基线逐 case 对比 → same/diff
 */
import fs from 'node:fs';
import path from 'node:path';
import { captureBaseline, verifyBaseline, type BehaviorCase } from '../behavior/index.js';

function readArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 解析金丝雀样例输入（argv 依赖注入，缺省取 process.argv，便于测试注入假 argv） */
export function loadCases(argv: string[] = process.argv): BehaviorCase[] {
  const readArg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const inline = readArg('--cases');
  if (inline) {
    const arr = JSON.parse(inline) as unknown[];
    if (!Array.isArray(arr) || arr.length === 0) throw new Error('--cases 需为非空 JSON 数组（[{name,args,kwargs?}]）');
    return arr.map((c) => {
      const o = c as Record<string, unknown>;
      return { name: String(o.name), args: Array.isArray(o.args) ? o.args : [], kwargs: o.kwargs as Record<string, unknown> | undefined };
    });
  }
  const file = readArg('--cases-file');
  if (file) {
    const arr = JSON.parse(fs.readFileSync(path.resolve(file), 'utf-8')) as unknown[];
    if (!Array.isArray(arr) || arr.length === 0) throw new Error(`--cases-file 需含非空数组（${file}）`);
    return arr.map((c) => {
      const o = c as Record<string, unknown>;
      return { name: String(o.name), args: Array.isArray(o.args) ? o.args : [], kwargs: o.kwargs as Record<string, unknown> | undefined };
    });
  }
  throw new Error('capture 需要 --cases "<json>" 或 --cases-file <p> 提供金丝雀样例输入');
}

function main(): void {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const action = positional[0];
  const projectDir = positional[1];
  const file = readArg('--file');
  const func = readArg('--func');
  const baseline = readArg('--baseline');
  if (!action || !projectDir || !file || !func) {
    console.error(
      '用法:\n' +
        '  behavior capture <projectDir> --file <rel.<py|ts|js>> --func <name> --cases "<json>" [--baseline <out>]\n' +
        '  behavior verify  <projectDir> --file <rel.<py|ts|js>> --func <name> [--baseline <in>]',
    );
    process.exit(1);
  }
  const spec = { project_dir: projectDir, file, function: func, cases: [] as BehaviorCase[] };

  if (action === 'capture') {
    spec.cases = loadCases();
    const b = captureBaseline(spec, baseline);
    const lines = [
      `行为基线已记录 · ${b.spec.function} @ ${b.spec.file}`,
      `基线：${b.baseline_path}（文件哈希 ${b.file_hash}）`,
      `${b.results.length} 个 case：`,
      ...b.results.map((r) => `  ${r.case} = ${r.ok ? r.ret : `✗ ${r.error}`}`),
      '',
      '函数源码快照：',
      ...(b.source || '(unavailable)').split('\n').map((l) => `  ${l}`),
    ];
    console.log(lines.join('\n'));
    return;
  }

  if (action === 'verify') {
    const v = verifyBaseline(spec, baseline);
    const lines = [
      `行为基线对比 · ${v.diff.verdict === 'same' ? '✔ 一致' : v.diff.verdict === 'diff' ? '✗ 有差异' : '⚠ 无法对比'}`,
      v.diff.message,
      `基线文件哈希 ${v.baseline.file_hash} → 当前 ${v.run.file_hash}`,
      '',
    ];
    for (const d of v.diff.details) {
      if (d.status === 'same') {
        lines.push(`  = ${d.case}  same`);
        continue;
      }
      lines.push(`  ! ${d.case}`);
      if (d.case === '(stdout)') {
        lines.push(`    改前 stdout: ${JSON.stringify(d.before)}`);
        lines.push(`    改后 stdout: ${JSON.stringify(d.after)}`);
      } else {
        if (d.before !== undefined) lines.push(`    改前 ret: ${d.before}`);
        if (d.after !== undefined) lines.push(`    改后 ret: ${d.after}`);
        if (d.before_error !== undefined) lines.push(`    改前 error: ${d.before_error}`);
        if (d.after_error !== undefined) lines.push(`    改后 error: ${d.after_error}`);
      }
    }
    console.log(lines.join('\n'));
    return;
  }

  console.error(`未知动作：${action}（仅支持 capture / verify）`);
  process.exit(1);
}

// 直接执行才跑 main（被测试 import 时仅导出 loadCases）
if (process.argv[1] && /behavior_cli\.(js|ts)$/.test(process.argv[1])) {
  main();
}
