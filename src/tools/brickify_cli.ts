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
 *   - --mindmap：项目→社区→积木→积木内小簇→文件 分层导图自包含 HTML（可展开/折叠下钻）
 *   - --workbench：簇级协作工作台 HTML（DSL 工作台样式：人话节点卡+簇间调用边+点击下钻详情悬窗）
 *   - --narrate：启用 LLM 翻译层（社区/积木/小簇 → 人话标题+描述；未配置 LLM 自动降级为事实句）
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildBrickify, ROLE_LABEL } from './brickify.js';
import { renderBrickifyWorkbenchHtml } from './render_sandbox.js';
import { renderBrickifyMindMapHtml } from './render_mindmap.js';
import { narrateClusters } from './cluster_narrator.js';
import { renderClusterWorkbenchHtml } from './render_cluster_workbench.js';
import { renderSandboxCanvasHtml } from './render_sandbox_canvas.js';
import { classifyBricks } from './classify_bricks.js';
import { renderAnatomyHtml } from './render_anatomy.js';

function readArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(name);

async function main(): Promise<void> {
  const project = readArg('--project');
  if (!project) {
    console.error('usage: brickify_cli --project <dir> [--source <subdir>] [--json <report.json>] [--out <community.html>] [--mindmap <mindmap.html>] [--workbench <wb.html>] [--sandbox <canvas.html>] [--anatomy <lanes.html>] [--narrate]');
    process.exit(2);
  }
  const source = readArg('--source');
  const jsonOut = readArg('--json');
  const htmlOut = readArg('--out');
  const mindmapOut = readArg('--mindmap');
  const workbenchOut = readArg('--workbench');
  const sandboxOut = readArg('--sandbox');
  const anatomyOut = readArg('--anatomy');
  const doNarrate = has('--narrate');

  const result = await buildBrickify({ project_dir: project, source_root: source });

  // LLM 翻译层（可选）：社区/积木/小簇 → 人话。降级安全，永不阻塞。
  let narratives = undefined;
  if (doNarrate || workbenchOut || sandboxOut || anatomyOut) {
    const srcRoot = result.meta.source_root;
    console.log('[narrate] LLM 翻译层启动（未配置则自动降级为事实句）…');
    narratives = await narrateClusters(result, srcRoot);
    console.log(
      `[narrate] 翻译完成：LLM ${narratives.meta.llm_ok}/${narratives.meta.total}` +
        (narratives.meta.degraded ? '（全部降级）' : ''),
    );
    // 翻译摘要：人话标题直接上控制台（这本身就是"看懂"的第一现场）
    for (const [id, n] of Object.entries(narratives.clusters)) {
      console.log(`  簇 ${id} → 「${n.title}」 ${n.desc.slice(0, 50)}${n.desc.length > 50 ? '…' : ''}`);
    }
    // 第0层：项目总览（项目是什么 + 功能清单，与积木一一对应）
    const ov = narratives.overview;
    console.log(`\n[overview] 项目：${ov.title}${ov.mode === 'llm' ? '' : '（待解读）'}`);
    console.log(`[overview] ${ov.desc}`);
    for (const f of ov.features) {
      console.log(`  功能 ${f.label}（${f.target}）：${f.desc}`);
    }
    console.log('');
  }
  // 摘要
  console.log(`[brickify] ${result.meta.scanned_files} 文件 → ${result.bricks.length} 块积木 → ${result.communities.length} 个社区`);
  console.log(`[brickify] 混合文件信号 ${result.mixed_files.length} 个；跨社区桥 ${countBridges(result)} 条`);
  const rt = result.meta.role_totals;
  console.log(
    `[brickify] 三层角色 积木(功能)${rt.brick} / 契约${rt.contract} / 胶水${rt.glue}`,
  );
  for (const b of result.bricks) {
    const tr = b.roles;
    if (tr.brick.length + tr.contract.length + tr.glue.length === 0) continue;
    // 第2层下钻摘要：积木内小簇数 + 退化（整层耦合）提示
    const subs = b.sub_clusters;
    const nonDegenerate = subs.filter((s) => !s.degenerate).length;
    const subInfo =
      nonDegenerate > 0
        ? ` 下钻${subs.length}簇`
        : subs.length === 1
          ? ` 下钻1簇(退化为整层耦合)`
          : ` 下钻${subs.length}簇`;
    console.log(
      `  积木 ${b.id}(${b.total}) [${ROLE_LABEL[b.role]}]: 功能${tr.brick.length}/契约${tr.contract.length}/胶水${tr.glue.length} 社区=${b.community ?? '-'}${subInfo}`,
    );
  }
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
  if (mindmapOut) {
    const html = renderBrickifyMindMapHtml(result);
    const abs = path.resolve(mindmapOut);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, html, 'utf-8');
    console.log(`[brickify] 分层导图(下钻) HTML → ${abs}`);
  }
  if (workbenchOut) {
    const html = renderClusterWorkbenchHtml(result, narratives);
    const abs = path.resolve(workbenchOut);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, html, 'utf-8');
    console.log(`[brickify] 簇级协作工作台 HTML → ${abs}`);
  }
  if (sandboxOut) {
    const html = renderSandboxCanvasHtml(result, narratives);
    const abs = path.resolve(sandboxOut);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, html, 'utf-8');
    console.log(`[brickify] 画布沙盘(mock样式真数据) HTML → ${abs}`);
  }
  if (anatomyOut) {
    const anatomy = await classifyBricks(result, narratives);
    console.log(
      `[anatomy] ${anatomy.taxonomy.label}：LLM 归类 ${anatomy.meta.llm_ok}/${anatomy.meta.total} 簇` +
        (anatomy.unclassified.length > 0 ? `，未归类 ${anatomy.unclassified.length}` : ''),
    );
    for (const lane of anatomy.slots) {
      const items = lane.groups
        .flatMap((g) => g.clusters.map((c) => `${c.title}(${c.id})`))
        .join('、');
      console.log(`  ${lane.slot.label}: ${items || '（空槽）'}`);
    }
    if (anatomy.unclassified.length > 0) {
      console.log(`  未归类: ${anatomy.unclassified.join('、')}`);
    }
    const html = renderAnatomyHtml(result, anatomy);
    const abs = path.resolve(anatomyOut);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, html, 'utf-8');
    console.log(`[brickify] 解剖泳道视图 HTML → ${abs}`);
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