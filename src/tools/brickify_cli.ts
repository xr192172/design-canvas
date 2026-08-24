/**
 * brickify_cli —— 依赖驱动积木化管线的独立 CLI（单段可启停，便于调试）
 *
 * 用法：
 *   node dist/src/tools/brickify_cli.js --project <dir> [--source <subdir>]
 *        [--json <report.json>] [--out <community.html>]
 *
 * 输出：
 *   - 控制台：积木/社区/混合文件/跨社区桥 摘要
 *   - --json：完整数据报告（file_deps / communities / mixed_files / call_edges）
 *   - --out ：功能社区工作台自包含 HTML（可浏览器直接打开验收）
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildBrickify } from './brickify.js';
import { renderBrickifyWorkbenchHtml } from './render_sandbox.js';

function readArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(name);

async function main(): Promise<void> {
  const project = readArg('--project');
  if (!project) {
    console.error('usage: brickify_cli --project <dir> [--source <subdir>] [--json <report.json>] [--out <community.html>]');
    process.exit(2);
  }
  const source = readArg('--source');
  const jsonOut = readArg('--json');
  const htmlOut = readArg('--out');

  const result = await buildBrickify({ project_dir: project, source_root: source });
  // 摘要
  console.log(`[brickify] ${result.meta.scanned_files} 文件 → ${result.bricks.length} 块积木 → ${result.communities.length} 个社区`);
  console.log(`[brickify] 混合文件信号 ${result.mixed_files.length} 个；跨社区桥 ${countBridges(result)} 条`);
  for (const c of result.communities) {
    console.log(`  社区 ${c.id}(${c.bricks.length}): 内聚 ${Math.round(c.cohesion * 100)}% 内部${c.internal_edges}/边界${c.external_edges}`);
  }
  if (result.mixed_files.length) {
    console.log('[brickify] 混合文件（解耦候选）：');
    for (const m of result.mixed_files) console.log(`  - ${m.file} ${m.clusters.length}簇 ${m.clusters.map((c) => `[${c.join(',')}]`).join('')}`);
  }

  if (jsonOut) {
    fs.writeFileSync(path.resolve(jsonOut), JSON.stringify(result, null, 2), 'utf-8');
    console.log(`[brickify] JSON 报告 → ${path.resolve(jsonOut)}`);
  }
  if (htmlOut) {
    const html = renderBrickifyWorkbenchHtml(result);
    const abs = path.resolve(htmlOut);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, html, 'utf-8');
    console.log(`[brickify] 社区工作台 HTML → ${abs}`);
  }
}

function countBridges(r: { call_edges: Array<{ from: string; to: string }>; communities: { id: string; bricks: string[] }[] }): number {
  const m = new Map<string, string>();
  for (const c of r.communities) for (const b of c.bricks) m.set(b, c.id);
  return r.call_edges.filter((e) => m.get(e.from) && m.get(e.to) && m.get(e.from) !== m.get(e.to)).length;
}

main().catch((e) => {
  console.error('[brickify] failed:', e);
  process.exit(1);
});