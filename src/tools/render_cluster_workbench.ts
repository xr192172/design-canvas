/**
 * render_cluster_workbench —— 簇级协作工作台（DSL 工作台样式的真数据版）
 *
 * 用户目标形态（对齐 `DSL 协作工作台.zip` 的沙盘）：
 *   - 节点卡：图标 + 人话标题 + 人话描述 + footer 徽章（文件数/内聚度/角色）
 *     ——不是文件名，是 cluster_narrator 翻译出来的"这是干嘛的"
 *   - 连线：簇间真实依赖边（file_deps 聚合，线宽∝调用量，箭头=方向）
 *   - 点击节点卡 → 右侧详情悬窗：该簇全部文件 + 每文件角色 + 事实句
 *   - 布局：社区分行（一行一社区），行内小簇横排
 *
 * 忠实纪律：卡片上的数字（文件数/内聚度/调用量）全部来自确定性管线；
 * 人话标题/描述来自 LLM 翻译（mode=rule 时标注"待翻译"，不冒充）。
 * 自包含：内联 CSS/JS，无外网依赖，浏览器直接打开验收。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { BrickifyResult, BrickSubCluster, BrickifyBrick } from './brickify.js';
import { roleOfFile } from './brickify.js';
import type { ClusterNarratives } from './cluster_narrator.js';

const ROLE_CLS: Record<string, string> = { brick: 'r-brick', contract: 'r-contract', glue: 'r-glue' };
const ROLE_TXT: Record<string, string> = { brick: '功能', contract: '契约', glue: '胶水' };

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
function jsonForScript(o: unknown): string {
  return JSON.stringify(o).replace(/<\//g, '<\\/');
}

/** 簇间边：file_deps 按簇聚合（from 文件簇 → to 文件簇），线宽∝总调用量。 */
export interface ClusterEdge {
  from: string; // cluster id
  to: string;
  count: number;
}

export function clusterEdgesOf(r: BrickifyResult): ClusterEdge[] {
  const fileToCluster = new Map<string, string>();
  for (const b of r.bricks) {
    for (const s of b.sub_clusters) for (const f of s.files) fileToCluster.set(f, s.id);
  }
  const acc = new Map<string, number>();
  for (const d of r.file_deps) {
    const a = fileToCluster.get(d.from);
    const b = fileToCluster.get(d.to);
    if (!a || !b || a === b) continue;
    const k = `${a}\u0001${b}`;
    acc.set(k, (acc.get(k) ?? 0) + d.count);
  }
  const edges: ClusterEdge[] = [];
  for (const [k, count] of acc) {
    const i = k.indexOf('\u0001');
    edges.push({ from: k.slice(0, i), to: k.slice(i + 1), count });
  }
  edges.sort((x, y) => y.count - x.count);
  return edges;
}

/** 簇卡片（沙盘节点）：人话标题 + desc + footer 徽章。 */
function clusterCard(
  s: BrickSubCluster,
  b: BrickifyBrick,
  nar: ClusterNarratives | undefined,
): string {
  const n = nar?.clusters[s.id];
  const title = n?.title ?? s.id;
  const desc = n?.desc ?? '';
  const modeBadge = n?.mode === 'llm' ? '' : '<span class="cb raw">待翻译</span>';
  const coh = Math.round(s.cohesion * 100);
  return `<div class="cnode" data-cluster="${esc(s.id)}" data-brick="${esc(b.id)}">
  <div class="cn-head">
    <span class="cn-ic">${s.degenerate && s.files.length > 1 ? '🔗' : '🧱'}</span>
    <span class="cn-title">${esc(title)}</span>
  </div>
  <div class="cn-desc">${esc(desc)}</div>
  <div class="cn-foot">
    <span class="cb">${s.files.length} 文件</span>
    <span class="cb ${coh === 100 ? 'ok' : ''}">内聚 ${coh}%</span>
    <span class="cb ${ROLE_CLS[s.role]}">${ROLE_TXT[s.role]}</span>
    ${modeBadge}
  </div>
  <div class="cn-orig" title="所属积木">${esc(b.id)}</div>
</div>`;
}

export function renderClusterWorkbenchHtml(
  r: BrickifyResult,
  narratives?: ClusterNarratives,
): string {
  const projectName = path.basename(r.meta.project_dir);
  const edges = clusterEdgesOf(r);

  // 社区分行：每社区一行，行内小簇横排（无社区归属的积木归"孤立"行）
  const brickById = new Map(r.bricks.map((b) => [b.id, b]));
  const commOfBrick = new Map<string, string>();
  for (const c of r.communities) for (const b of c.bricks) commOfBrick.set(b, c.id);

  interface Row {
    id: string;
    label: string;
    narrative?: { title: string; desc: string; mode: string };
    bricks: BrickifyBrick[];
  }
  const rows: Row[] = r.communities.map((c) => ({
    id: c.id,
    label: c.id,
    narrative: narratives?.communities[c.id],
    bricks: c.bricks.map((bid) => brickById.get(bid)).filter((x): x is BrickifyBrick => !!x),
  }));
  const orphans = r.bricks.filter((b) => !commOfBrick.has(b.id));
  if (orphans.length > 0) rows.push({ id: '__orphan__', label: '孤立积木', bricks: orphans });

  const rowsHtml = rows
    .map((row) => {
      const cards = row.bricks
        .flatMap((b) => b.sub_clusters.map((s) => ({ s, b })))
        .map(({ s, b }) => clusterCard(s, b, narratives))
        .join('');
      const nTitle = row.narrative?.title ?? row.label;
      const nDesc = row.narrative?.desc ?? '';
      const cnt = row.bricks.reduce((a, b) => a + b.total, 0);
      return `<section class="crow" data-row="${esc(row.id)}">
  <div class="crow-head">
    <span class="crow-title">${esc(nTitle)}</span>
    <span class="crow-meta">${row.bricks.length} 积木 · ${cnt} 文件</span>
    <span class="crow-desc">${esc(nDesc)}</span>
  </div>
  <div class="crow-cards">${cards}</div>
</section>`;
    })
    .join('');

  // 详情悬窗数据（点击节点卡 → 右侧面板）
  const detail = r.bricks.flatMap((b) =>
    b.sub_clusters.map((s) => ({
      id: s.id,
      brick: b.id,
      title: narratives?.clusters[s.id]?.title ?? s.id,
      desc: narratives?.clusters[s.id]?.desc ?? '',
      facts: `${s.files.length} 文件 · 内聚 ${Math.round(s.cohesion * 100)}% · 角色 ${ROLE_TXT[s.role]}${s.degenerate && s.files.length > 1 ? ' · 整层耦合' : ''}`,
      files: s.files.map((f) => ({ path: f, role: roleOfFile(f) })),
    })),
  );

  const narMeta = narratives
    ? `LLM 翻译 ${narratives.meta.llm_ok}/${narratives.meta.total}${narratives.meta.degraded ? '（全部降级为事实句）' : ''}`
    : '（未启用翻译层：--narrate）';
  const limHtml = r.limitations.map((l) => `- ${esc(l)}`).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>簇级协作工作台 · ${esc(projectName)}</title>
<style>
:root{--bg:#fafafa;--card:#fff;--border:#e4e4e7;--text:#0a0a0a;--muted:#71717a;--brand:#7c3aed;--accent:#2563eb;--ok:#16a34a}
*{box-sizing:border-box}
body{margin:0;font-family:'Inter','Geist',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:var(--text);background:var(--bg)}
header{display:flex;align-items:center;gap:14px;padding:12px 18px;background:var(--card);border-bottom:1px solid var(--border);flex-wrap:wrap;position:sticky;top:0;z-index:10}
header h1{font-size:15px;margin:0;font-weight:650}
.meta{font-size:12px;color:var(--muted)}
main{padding:18px;max-width:1160px;margin:0 auto}
.crow{margin-bottom:22px}
.crow-head{display:flex;align-items:baseline;gap:10px;margin-bottom:10px;flex-wrap:wrap}
.crow-title{font-size:15px;font-weight:650}
.crow-meta{font-size:11px;color:var(--muted)}
.crow-desc{font-size:12px;color:var(--muted);flex-basis:100%}
.crow-cards{display:flex;flex-wrap:wrap;gap:12px}
.cnode{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px 14px;width:250px;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.04);transition:box-shadow .12s,border-color .12s;position:relative}
.cnode:hover{box-shadow:0 4px 12px rgba(0,0,0,.08);border-color:#c9c9ce}
.cnode.sel{border-color:var(--brand);box-shadow:0 0 0 2px #7c3aed33}
.cn-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.cn-ic{font-size:15px}
.cn-title{font-weight:650;font-size:13.5px}
.cn-desc{font-size:12px;color:#3f3f46;line-height:1.55;margin-bottom:8px;min-height:34px}
.cn-foot{display:flex;flex-wrap:wrap;gap:5px}
.cb{font-size:10.5px;padding:2px 8px;border-radius:10px;border:1px solid var(--border);background:#fff;line-height:1;color:var(--muted)}
.cb.ok{color:var(--ok);border-color:#bbf7d0;background:#f0fdf4}
.cb.raw{color:#b45309;border-color:#fde68a;background:#fffbeb}
.cb.r-brick{color:#15803d;border-color:#bbf7d0;background:#ecfdf5}
.cb.r-contract{color:#1d4ed8;border-color:#bfdbfe;background:#eff6ff}
.cb.r-glue{color:#c2410c;border-color:#fed7aa;background:#fff7ed}
.cn-orig{margin-top:8px;font-size:10px;color:#a1a1aa;font-family:ui-monospace,monospace}
.panel{position:fixed;top:0;right:-420px;width:400px;height:100vh;background:var(--card);border-left:1px solid var(--border);box-shadow:-8px 0 24px rgba(0,0,0,.08);transition:right .18s ease;z-index:50;display:flex;flex-direction:column}
.panel.open{right:0}
.panel-head{padding:16px 18px 12px;border-bottom:1px solid var(--border)}
.panel-title{font-size:15px;font-weight:650}
.panel-desc{font-size:12.5px;color:#3f3f46;margin-top:6px;line-height:1.6}
.panel-facts{font-size:11.5px;color:var(--muted);margin-top:6px}
.panel-body{flex:1;overflow-y:auto;padding:14px 18px}
.f-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;font-size:12px;margin-bottom:2px}
.f-row:hover{background:#f4f4f5}
.f-path{font-family:ui-monospace,'Cascadia Code',monospace;font-size:11.5px}
.f-role{margin-left:auto;flex-shrink:0}
.panel-close{position:absolute;top:10px;right:12px;font-size:16px;color:var(--muted);cursor:pointer;background:none;border:none}
.panel-close:hover{color:var(--text)}
footer{padding:14px 18px;border-top:1px solid var(--border);background:var(--card);color:var(--muted);font-size:11px;white-space:pre-wrap;line-height:1.6}
.edgebar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px}
.edge{font-size:11.5px;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:5px 10px}
.edge b{font-weight:600}
.edge .ec{color:var(--muted);font-size:10.5px}
</style>
</head>
<body>
<header>
  <h1>簇级协作工作台 · ${esc(projectName)}</h1>
  <span class="meta">${r.meta.scanned_files} 文件 · ${r.bricks.length} 积木 · ${r.communities.length} 社区 · ${narMeta}</span>
</header>
<main>
  <div class="edgebar">
    ${edges.slice(0, 24).map((e) => `<span class="edge" data-e="${esc(e.from)}→${esc(e.to)}"><b>${esc(e.from)}</b> → <b>${esc(e.to)}</b> <span class="ec">${e.count} 次调用</span></span>`).join('') || '<span class="meta">簇间无调用边</span>'}
  </div>
  ${rowsHtml}
</main>
<aside class="panel" id="panel">
  <button class="panel-close" id="pclose">×</button>
  <div class="panel-head">
    <div class="panel-title" id="ptitle"></div>
    <div class="panel-desc" id="pdesc"></div>
    <div class="panel-facts" id="pfacts"></div>
  </div>
  <div class="panel-body" id="pbody"></div>
</aside>
<footer>limitations
${limHtml}</footer>
<script>
const DETAIL = ${jsonForScript(detail)};
document.querySelectorAll('.cnode').forEach(el => {
  el.addEventListener('click', () => {
    const id = el.dataset.cluster;
    const d = DETAIL.find(x => x.id === id);
    if (!d) return;
    document.querySelectorAll('.cnode').forEach(x => x.classList.remove('sel'));
    el.classList.add('sel');
    document.getElementById('ptitle').textContent = d.title;
    document.getElementById('pdesc').textContent = d.desc || '（暂无翻译，点 --narrate 启用 LLM 翻译层）';
    document.getElementById('pfacts').textContent = d.facts + ' · 所属积木 ' + d.brick;
    const body = document.getElementById('pbody');
    body.innerHTML = d.files.map(f =>
      '<div class="f-row"><span class="f-path"></span>' +
      '<span class="cb f-role ' + ({brick:'r-brick',contract:'r-contract',glue:'r-glue'}[f.role]||'') + '">' +
      ({brick:'功能',contract:'契约',glue:'胶水'}[f.role]||f.role) + '</span></div>'
    ).join('');
    body.querySelectorAll('.f-path').forEach((p, i) => { p.textContent = d.files[i].path; p.title = d.files[i].path; });
    document.getElementById('panel').classList.add('open');
  });
});
document.getElementById('pclose').addEventListener('click', () => {
  document.getElementById('panel').classList.remove('open');
  document.querySelectorAll('.cnode').forEach(x => x.classList.remove('sel'));
});
</script>
</body>
</html>`;
}

/** 落盘便捷入口：渲染 + 写文件，返回 HTML。 */
export function buildClusterWorkbench(opts: {
  result: BrickifyResult;
  narratives?: ClusterNarratives;
  out_file?: string;
}): string {
  const html = renderClusterWorkbenchHtml(opts.result, opts.narratives);
  if (opts.out_file) {
    const abs = path.resolve(opts.out_file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, html, 'utf-8');
  }
  return html;
}
