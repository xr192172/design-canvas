/**
 * translate_cli —— Go→TS 半自动翻译命令行入口
 *
 * 用法：
 *   node dist/src/translate/translate_cli.js <file.go> [--out <file.ts>] [--holes] [--llm]
 *
 * 无 --llm：打印目标 TS 骨架（函数体留孔）+ 验证闸结果。
 * --llm：用 AGNES key 池（AGNES_KEY_POOL）真调 LLM 逐孔填函数体，输出填充后源码。
 *   - baseURL 可经 AGNES_UPSTREAM_BASE 覆盖为本地 key-pool-proxy；model 经 AGNES_MODEL。
 * --out <file.ts>：把产出写入目标文件（默认不覆盖已存在目标）。
 * --holes：额外打印每个待填孔给 LLM 的 prompt。
 * - 骨架任一语法/结构闸不过，则整份不落盘（原子性，避免半成品）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { translateGoToTs, translateGoProject } from './pairs.js';
import { createPooledHoleTranslator } from './llm.js';
import { fillUnitsWithRetry } from './fill.js';

function readArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const file = positional[0];
  const outFile = readArg('--out');
  const wantHoles = process.argv.includes('--holes');
  const wantLlm = process.argv.includes('--llm');
  const projectDir = readArg('--project');
  const outDir = readArg('--out-dir');
  const wantVerify = process.argv.includes('--verify');
  const batchSizeRaw = readArg('--batch-size');
  const batchSize = batchSizeRaw ? Number(batchSizeRaw) : undefined;

  // 项目级模式：--project <dir> [--out-dir <out>] [--llm] [--verify] [--batch-size N]
  if (projectDir) {
    const root = path.resolve(projectDir);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      console.error(`项目目录不存在: ${root}`);
      process.exit(1);
    }
    const pr = await translateGoProject(root, {
      outDir: outDir ? path.resolve(outDir) : undefined,
      fill: wantLlm,
      verify: wantVerify,
      batchSize,
    });
    console.log(`Go 项目翻译：${pr.modules.length} 个模块`);
    for (const m of pr.modules) {
      console.log(`  ${m.tsRel}  (${m.units.length} 单元${m.imports.length ? `; import ${m.imports.length} 处` : ''})`);
    }
    if (pr.diagnostics.length) {
      console.log('── 诊断（不阻断）──');
      for (const d of pr.diagnostics) console.log(`  ${d}`);
    }
    const need = pr.report.filter((e) => e.status === 'llm_retry_fail' || e.status === 'skipped');
    console.log(`A1 失败清单：共 ${pr.report.length} 条；需处理 ${need.length} 条（llm_retry_fail/skipped）`);
    for (const e of need) console.log(`  [${e.status}] ${e.file}:${e.line} ${e.id}${e.reason ? ` — ${e.reason}` : ''}`);
    if (outDir) console.log(`已落盘到 ${path.resolve(outDir)}`);
    return;
  }

  if (!file) {
    console.error('用法: node dist/src/translate/translate_cli.js <file.go> [--out <file.ts>] [--holes] [--llm]');
    console.error('       node dist/src/translate/translate_cli.js --project <dir> [--out-dir <out>] [--llm]');
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
  if (r.issues.length) {
    console.log('── 验证闸(未过) ──');
    for (const i of r.issues) console.log(`  [${i.gate}] ${i.id}: ${i.detail}`);
    console.error('骨架未通过验证，不落盘。');
    process.exit(1);
  }
  if (r.units.length === 0) {
    console.log('（无单元可翻译）');
    return;
  }

  let output = r.output;
  if (wantLlm) {
    console.log('── 调 AGNES key 池 LLM 填孔 ──');
    const translate = createPooledHoleTranslator();
    const filled = await fillUnitsWithRetry(r.units, translate);
    const byId = new Map(filled.map((f) => [f.unit.id, f]));
    // 按原始单元顺序组装：func 用填充后源码，type 用骨架
    output = r.units
      .map((u) => {
        const f = byId.get(u.id);
        return (f?.ok ? f.filledSource : u.skeleton) ?? u.skeleton;
      })
      .join('\n\n');
    // 报告每孔验证结果
    for (const f of filled) {
      if (f.ok) console.log(`  ✓ ${f.unit.id}`);
      else console.log(`  ✗ ${f.unit.id}: ${(f.error ?? f.issues.map((i) => i.detail).join('; '))}`);
    }
  }

  console.log(wantLlm ? '── 目标 TS（LLM 已填函数体）──' : '── 目标 TS 骨架 ──');
  console.log(output);

  if (wantHoles && !wantLlm) {
    console.log('── 待填孔 prompt（LLM） ──');
    r.holePrompts.forEach((p, i) => console.log(`\n=== 孔 #${i + 1} ===\n${p}`));
  }

  if (outFile) {
    const outAbs = path.resolve(outFile);
    const finalOut = wantLlm ? output : r.output;
    if (fs.existsSync(outAbs) && !wantLlm) {
      console.error(`目标已存在，不覆盖（防止丢弃已填的函数体）：${outAbs}`);
    } else {
      fs.mkdirSync(path.dirname(outAbs), { recursive: true });
      fs.writeFileSync(outAbs, finalOut, 'utf-8');
      console.log(`已写入 ${outAbs}`);
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});