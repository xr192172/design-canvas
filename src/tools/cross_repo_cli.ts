/**
 * cross_repo_cli —— 跨项目符号索引 CLI（杂交前"会不会撞名"）
 *
 * 用法：
 *   node dist/src/tools/cross_repo_cli.js <rootA> <rootB> [--json <out>]
 *
 * 语义（求交 + 求差）：
 *   1. 冲突清单（同名不同签）：杂交前需改名/错位
 *   2. 双胞胎（同名同签）：语义重复，可去重一个
 *   3. aOnly / bOnly（求差）：只在一方的符号 = 迁移到对侧的安全候选
 *
 * 输出纯文本报告；--json 同时落结构化结果供后续 hybrid_precheck 复用。
 */

import fs from 'node:fs';
import path from 'node:path';
import { compareProjects } from '../cross_repo/index.js';

function readArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fmtSymList(defs: Array<{ file: string; signature: string }>): string {
  return defs.map((d) => `${d.file}  ${d.signature}`).join(' ; ');
}

async function main(): Promise<void> {
  const aRoot = process.argv[2];
  const bRoot = process.argv[3];
  if (!aRoot || !bRoot) {
    console.error('用法: node dist/src/tools/cross_repo_cli.js <rootA> <rootB> [--json <out>]');
    process.exit(1);
  }

  const r = await compareProjects(aRoot, bRoot);
  const lines: string[] = [];
  lines.push(`跨项目符号索引 · ${r.aRoot} ↔ ${r.bRoot}`);
  lines.push(`A：${r.aFiles} 文件 / ${r.aSymbols} 顶层符号     B：${r.bFiles} 文件 / ${r.bSymbols} 顶层符号`);
  lines.push('');

  lines.push(`■ 冲突 ${r.conflicts.length}（同名不同签，杂交前需改名/错位）`);
  for (const c of r.conflicts) {
    lines.push(`  ! ${c.name}`);
    lines.push(`      A: ${fmtSymList(c.a)}`);
    lines.push(`      B: ${fmtSymList(c.b)}`);
  }
  if (r.conflicts.length === 0) lines.push('  （无）');
  lines.push('');

  lines.push(`■ 双胞胎 ${r.duplicates.length}（同名同签，可去重一个）`);
  for (const c of r.duplicates) {
    lines.push(`  = ${c.name}   A: ${c.a[0].file} ↔ B: ${c.b[0].file}`);
  }
  if (r.duplicates.length === 0) lines.push('  （无）');
  lines.push('');

  lines.push(`■ 迁移范围：A→B 候选 ${r.aOnly.length} 个（只在一方，搬过去不撞名）`);
  if (r.aOnly.length > 0) lines.push(`  ${r.aOnly.join(', ')}`);
  lines.push('');
  lines.push(`■ 迁移范围：B→A 候选 ${r.bOnly.length} 个`);
  if (r.bOnly.length > 0) lines.push(`  ${r.bOnly.join(', ')}`);

  const text = lines.join('\n');
  console.log(text);

  const jsonOut = readArg('--json');
  if (jsonOut) {
    const abs = path.resolve(jsonOut);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(r, null, 2), 'utf-8');
    console.log(`\n[cross-repo] JSON → ${abs}`);
  }
}

main().catch((e) => {
  console.error(`[cross-repo] 失败: ${(e as Error).message}`);
  process.exit(1);
});
