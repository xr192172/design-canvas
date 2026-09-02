/**
 * hybrid_cli —— 项目杂交预检命令行入口
 *
 * 用法: node dist/src/tools/hybrid_cli.js <rootA> <rootB> [--json <out>]
 * 输出：四维体检（符号冲突 / 功能重叠 / 依赖冲突 / 健康度）+ 融合判定 verdict。
 */
import fs from 'node:fs';
import path from 'node:path';
import { precheckHybrid, type HybridVerdict } from '../hybrid/index.js';

const VERDICT_LABEL: Record<HybridVerdict, string> = {
  ok: '可直接融合',
  fix: '需处理后融合',
  blocked: '必须先解决符号冲突',
};

const fmtSym = (defs: Array<{ file: string; signature: string }>): string =>
  defs.map((d) => `${d.file}  ${d.signature}`).join(' ; ');

export { VERDICT_LABEL, fmtSym };

function readArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const aRoot = positional[0];
  const bRoot = positional[1];
  if (!aRoot || !bRoot) {
    console.error('用法: node dist/src/tools/hybrid_cli.js <rootA> <rootB> [--json <out>]');
    process.exit(1);
  }

  const r = await precheckHybrid(aRoot, bRoot);
  const lines: string[] = [];
  lines.push(`项目杂交预检 · ${r.aRoot} ↔ ${r.bRoot}`);
  lines.push(`判定：${VERDICT_LABEL[r.verdict]}（${r.verdict}）`);
  for (const reason of r.reasons) lines.push(`  · ${reason}`);
  lines.push('');

  lines.push(`■ 符号冲突 ${r.symbolConflicts.length}（同名不同签，杂交前需改名/错位）`);
  for (const c of r.symbolConflicts) {
    lines.push(`  ! ${c.name}`);
    lines.push(`      A: ${fmtSym(c.a)}`);
    lines.push(`      B: ${fmtSym(c.b)}`);
  }
  if (r.symbolConflicts.length === 0) lines.push('  （无）');
  lines.push('');

  lines.push(`■ 功能重叠 ${r.symbolDuplicates.length}（同名同签双胞胎，可去重一个）`);
  for (const c of r.symbolDuplicates) {
    lines.push(`  = ${c.name}   A: ${c.a[0].file} ↔ B: ${c.b[0].file}`);
  }
  if (r.symbolDuplicates.length === 0) lines.push('  （无）');
  lines.push('');

  lines.push(`■ 依赖版本冲突 ${r.deps.conflicts.length}`);
  for (const c of r.deps.conflicts) lines.push(`  ! ${c.name}   ${c.version}   [${c.source}]`);
  if (r.deps.conflicts.length === 0) lines.push('  （无）');
  lines.push('');

  lines.push(`■ 依赖共享 ${r.deps.shared.length} / 仅A ${r.deps.aOnly.length} / 仅B ${r.deps.bOnly.length}`);
  if (r.deps.shared.length > 0) lines.push(`  共享: ${r.deps.shared.map((d) => d.name).join(', ')}`);
  if (r.deps.aOnly.length > 0) lines.push(`  仅A: ${r.deps.aOnly.map((d) => d.name).join(', ')}`);
  if (r.deps.bOnly.length > 0) lines.push(`  仅B: ${r.deps.bOnly.map((d) => d.name).join(', ')}`);
  lines.push('');

  lines.push('■ 健康度（第四查 · 选材体检）');
  lines.push(`  A ${r.health.a.score} 分（${r.health.a.grade}）· ${r.health.a.fileCount} 文件`);
  lines.push(`      ${r.health.a.summary}`);
  lines.push(`  B ${r.health.b.score} 分（${r.health.b.grade}）· ${r.health.b.fileCount} 文件`);
  lines.push(`      ${r.health.b.summary}`);

  const text = lines.join('\n');
  console.log(text);

  const jsonOut = readArg('--json');
  if (jsonOut) {
    const abs = path.resolve(jsonOut);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(r, null, 2), 'utf-8');
    console.log(`\n[hybrid] JSON → ${abs}`);
  }
}

// 直接执行才跑 main（被测试 import 时仅暴露 VERDICT_LABEL/fmtSym）
if (process.argv[1] && /hybrid_cli\.(js|ts)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
