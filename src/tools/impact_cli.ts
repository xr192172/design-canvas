/**
 * impact_cli —— 影响面分析 CLI（改前风险闭包报告）
 *
 * 用法：
 *   node dist/src/tools/impact_cli.js <root> [--change <file>[::<symbol>]]... [选项]
 *   node dist/src/tools/impact_cli.js <root> --hubs [--top N]
 *
 * 变更点：
 *   --change src/core/math.ts            改整个文件
 *   --change src/core/math.ts::double    只改某个顶层导出符号（区分精度更高）
 *
 * 选项：
 *   --max-depth N   闭包最大距离（默认不限）
 *   --hubs          热区盘点模式（无变更点：全项目"改哪里风险最高"）
 *   --top N         热区只列前 N（默认 10）
 *   --json <out>    同时把结构化结果写入 JSON 文件
 *
 * 输出：受影响文件按 风险(high→low) → 距离近 → 波及半径大 排序，
 *       每行给直接引用证据（仅 depth=1）；fell_back 提示保守降级。
 */

import fs from 'node:fs';
import path from 'node:path';
import { analyzeImpact, analyzeHubs } from '../impact/index.js';
import type { ImpactChangePoint } from '../impact/index.js';

function readArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(name);

/** 解析 --change a.ts 与 --change a.ts::sym 两种形态 */
export function changePoints(): ImpactChangePoint[] {
  const out: ImpactChangePoint[] = [];
  let i = process.argv.indexOf('--change');
  while (i >= 0 && i + 1 < process.argv.length) {
    const raw = process.argv[i + 1];
    const sep = raw.indexOf('::');
    if (sep >= 0) out.push({ file: raw.slice(0, sep), symbol: raw.slice(sep + 2) });
    else out.push({ file: raw });
    i = process.argv.indexOf('--change', i + 1);
  }
  return out;
}

function intArg(name: string, def: number): number {
  const v = readArg(name);
  const n = v == null ? Number.NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function riskMark(r: string): string {
  return r === 'high' ? '⚠' : r === 'medium' ? '·' : ' ';
}

export async function renderReport(root: string, cps: ImpactChangePoint[], maxDepth: number): Promise<{ text: string; data: unknown }> {
  const r = await analyzeImpact(root, cps, maxDepth === Number.POSITIVE_INFINITY ? {} : { maxDepth });
  const lines: string[] = [];
    lines.push(`影响面报告 · ${root}`);
    lines.push(`变更点 ${r.changePoints.length} 个，受影响文件 ${r.total} 个（直接 ${r.direct}，高风险 ${r.high_risk}）`);
    if (r.fell_back) lines.push('⚠ 存在符号级消费方解析失败 → 已保守降级为"改整个文件"的闭包');
    if (r.missing.length > 0) lines.push(`⚠ 未定位到变更点（可能笔误/未索引）：${r.missing.join(', ')}`);
    lines.push('');
    if (r.files.length === 0) {
      lines.push('（零波及：该变更点没有任何文件依赖链）');
    }
    for (const f of r.files) {
      lines.push(`${riskMark(f.risk)} [${f.risk}] ${f.file}  (depth=${f.depth}, 被${f.dep_count}个文件依赖)`);
      for (const s of f.sites) {
        lines.push(`      ${s.kind.padEnd(9)} L${s.line}  ${s.detail}`);
      }
    }
    return { text: lines.join('\n'), data: r };
}

export async function renderHubs(root: string, top: number): Promise<{ text: string; data: unknown }> {
  const h = await analyzeHubs(root, top);
  const lines: string[] = [];
  lines.push(`风险热区盘点 · ${root}（${h.fileCount} 文件 / ${h.edgeCount} 依赖边）`);
  lines.push('按"被直接依赖数"排序 —— 改这些文件会炸最多下游');
  lines.push('');
  for (const f of h.files) {
    lines.push(`${riskMark(f.risk)} [${f.risk}] ${f.file}  被 ${f.dependents} 个文件依赖 / 依赖 ${f.dependencies} 个文件`);
  }
  return { text: lines.join('\n'), data: h };
}

async function main(): Promise<void> {
  const root = process.argv[2] ?? '.';
  const cps = changePoints();
  const hubs = has('--hubs');
  const maxDepth = intArg('--max-depth', Number.POSITIVE_INFINITY);

  const { text, data } = hubs
    ? await renderHubs(root, intArg('--top', 10))
    : await renderReport(root, cps, maxDepth);

  console.log(text);

  const jsonOut = readArg('--json');
  if (jsonOut) {
    const abs = path.resolve(jsonOut);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`\n[impact] JSON → ${abs}`);
  }
}

// 直接执行才跑 main（被测试 import 时仅暴露 render/changePoints）
if (process.argv[1] && /impact_cli\.(js|ts)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(`[impact] 失败: ${(e as Error).message}`);
    process.exit(1);
  });
}
