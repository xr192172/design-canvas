/**
 * translate_cli —— Go→TS 最小切片命令行入口
 *
 * 用法：
 *   node dist/src/translate/translate_cli.js <file.go> [--out <file.ts>] [--holes]
 *
 * - 默认打印目标 TS 骨架 + 验证闸结果。
 * - --out <file.ts>：把骨架写入目标文件（不覆盖已存在的目标，防止掉 LLM 填的孔）。
 * - --holes：额外打印每个待填孔给 LLM 的 prompt（验证「规范 LLM」契约）。
 * - 骨架任一语法/结构闸不过，则整份不落盘（原子性，避免半成品）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { translateGoToTs } from './pairs.js';

function readArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const file = positional[0];
  const outFile = readArg('--out');
  const wantHoles = process.argv.includes('--holes');
  if (!file) {
    console.error('用法: node dist/src/translate/translate_cli.js <file.go> [--out <file.ts>] [--holes]');
    process.exit(1);
  }
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    console.error(`源文件不存在: ${abs}`);
    process.exit(1);
  }
  const source = fs.readFileSync(abs, 'utf-8');
  const r = await translateGoToTs(abs, source);

  if (r.error) {
    console.error(`翻译失败：${r.error}`);
    process.exit(1);
  }

  console.log(`Go→TS 萃取 ${r.units.length} 个单元（含 ${r.holePrompts.length} 个待 LLM 填的孔）`);
  console.log('── 目标 TS 骨架 ──');
  console.log(r.output || '（无单元）');

  if (r.issues.length) {
    console.log('── 验证闸(未过) ──');
    for (const i of r.issues) console.log(`  [${i.gate}] ${i.id}: ${i.detail}`);
    console.error('骨架未通过验证，不落盘。');
    process.exit(1);
  }

  if (wantHoles) {
    console.log('── 待填孔 prompt（LLM） ──');
    r.holePrompts.forEach((p, i) => console.log(`\n=== 孔 #${i + 1} ===\n${p}`));
  }

  if (outFile) {
    const outAbs = path.resolve(outFile);
    if (fs.existsSync(outAbs)) {
      console.error(`目标已存在，不覆盖（防止丢弃已填的函数体）：${outAbs}`);
    } else {
      fs.mkdirSync(path.dirname(outAbs), { recursive: true });
      fs.writeFileSync(outAbs, r.output, 'utf-8');
      console.log(`已写入 ${outAbs}`);
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});