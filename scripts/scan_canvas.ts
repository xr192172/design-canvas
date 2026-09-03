/**
 * scan_canvas —— 只读全扫 design-canvas：聚合符号/调用边，演示"图节点→代码行→定义"可追溯链。
 * 不写任何文件/DB。用 tsx 跑： npx tsx scripts/scan_canvas.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseFileFull } from '../src/tools/ts_kernel/index.js';

const ROOT = path.resolve(process.cwd());
const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.design-canvas', '.design-canvas.bak-20260830-122215', 'scripts', 'test', 'tests']);

function walk(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(path.join(dir, e.name), out); }
    else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) out.push(path.join(dir, e.name));
  }
  return out;
}

function extractLine(src, line) {
  const l = src.split('\n')[line - 1];
  return l === undefined ? '' : l.trim();
}

async function main() {
  const files = walk(path.join(ROOT, 'src'), []);
  let syms = 0, calls = 0, unresolved = 0, types = 0, imports = 0;
  const edgeToDemo = { file: 'src/daemon/dispatch.ts', caller: 'isDaemonAvailable', calleeExpr: 'probeDaemon', targetFile: 'src/daemon/client.ts' };
  const demoCaller = { file: null, line: null, src: null, call: null };
  let targetDef = null;

  for (const abs of files) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    let src;
    try { src = fs.readFileSync(abs, 'utf-8'); } catch { continue; }
    const p = await parseFileFull(abs, src);
    if (!p) continue;
    syms += p.symbols.length; types += p.type_refs.length; imports += p.imports.length;
    for (const c of p.calls) {
      calls++;
      if (!c.resolved) { unresolved++; if (c.callee_expr && c.callee_expr.includes(edgeToDemo.calleeExpr) && rel === edgeToDemo.file) {
        demoCaller.file = rel; demoCaller.line = c.line; demoCaller.src = extractLine(src, c.line); demoCaller.call = c;
      } }
    }
    if (rel === edgeToDemo.targetFile) {
      for (const s of p.symbols) {
        if (s.name === edgeToDemo.calleeExpr || (s.name === edgeToDemo.calleeExpr && s.kind === 'function')) {
          targetDef = { file: rel, name: s.name, kind: s.kind, start: s.start_line, end: s.end_line, signature: s.signature, qn: s.qualified_name };
        }
      }
    }
  }

  console.log('=== 全扫 design-canvas (src/**) ===');
  console.log(`文件: ${files.length} | 符号: ${syms} | import: ${imports} | 调用边: ${calls} | 类型引用: ${types}`);
  console.log(`同文件已解析(resolved)调用: ${calls - unresolved} | 跨文件/未解析候选: ${unresolved}`);

  console.log('\n=== 可追溯链演示：dispatch.isDaemonAvailable → probeDaemon(client.js) ===');
  console.log(`[调用点] ${demoCaller.file}:${demoCaller.line}`);
  console.log(`  源码: ${demoCaller.src}`);
  if (demoCaller.call) console.log(`  调用: ${demoCaller.call.caller} 调 ${demoCaller.call.callee_expr} (resolved=${demoCaller.call.resolved})`);
  if (targetDef) {
    console.log(`[定义] ${targetDef.file} ${targetDef.signature}`);
    console.log(`  类型: ${targetDef.kind} | 行 ${targetDef.start}–${targetDef.end} | 全名: ${targetDef.qn}`);
  } else {
    console.log('[定义] 未在同文件符号表命中（需经 import 边解析到目标文件符号）。');
  }
}

main();