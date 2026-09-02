/**
 * health_cli —— 代码健康度 CLI（死代码 / 复杂度 / 分层违规）
 *
 * 用法：
 *   node dist/src/tools/health_cli.js <root> [--threshold N] [--top N] [--json <out>]
 *
 * 选项：
 *   --threshold N  圈复杂度阈值（默认 10）
 *   --top N        复杂度清单最多列前 N（默认 10）
 *   --json <out>   同时把完整报告写入 JSON 文件
 *
 * 输出：健康分/等级 + 分层统计 + 问题清单（按严重度）+ 最高复杂度 Top。
 *       问题行前缀：✗ error / ! warn / · info。
 */

import fs from 'node:fs';
import path from 'node:path';
import { analyzeHealth } from '../health/index.js';

function readArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function intArg(name: string, def: number): number {
  const v = readArg(name);
  const n = v == null ? Number.NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

const SEV_MARK: Record<string, string> = { error: '✗', warn: '!', info: '·' };

async function main(): Promise<void> {
  const root = process.argv[2] ?? '.';
  const r = await analyzeHealth(root, {
    complexityThreshold: intArg('--threshold', 10),
    top: intArg('--top', 10),
  });

  const lines: string[] = [];
  lines.push(`代码健康度报告 · ${r.root}`);
  lines.push(`${r.fileCount} 个文件 → 健康分 ${r.score}（${r.grade}）`);
  lines.push(
    `分层：胶水 ${r.layers.glue} / 积木 ${r.layers.brick} / 契约 ${r.layers.contract} / 分层违规 ${r.layers.violations}`,
  );
  lines.push(r.summary);
  lines.push('');
  lines.push('—— 问题清单 ——');
  if (r.issues.length === 0) {
    lines.push('（无问题）');
  }
  for (const i of r.issues) {
    const loc = `${i.file}${i.line ? `:${i.line}` : ''}${i.symbol ? ` ${i.symbol}` : ''}`;
    lines.push(`${SEV_MARK[i.severity]} [${i.kind}] ${loc}`);
    lines.push(`      ${i.message}`);
  }
  lines.push('');
  lines.push(`—— 最高复杂度 Top ${r.complexity.length} ——`);
  for (const c of r.complexity) {
    lines.push(`  ${c.complexity}  ${c.file}:${c.line}  ${c.symbol}`);
  }
  console.log(lines.join('\n'));

  const jsonOut = readArg('--json');
  if (jsonOut) {
    const abs = path.resolve(jsonOut);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(r, null, 2), 'utf-8');
    console.log(`\n[health] JSON → ${abs}`);
  }
}

main().catch((e) => {
  console.error(`[health] 失败: ${(e as Error).message}`);
  process.exit(1);
});
