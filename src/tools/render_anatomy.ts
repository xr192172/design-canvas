/**
 * render_anatomy —— 泳道解剖视图（自顶向下：槽位 → 积木 → 簇 → 文件）
 *
 * 用户定调：像"从头设计一款软件"一样组织——先有解剖学槽位（人话、人天然认识），
 * 积木归类进槽位，从上往下逐层下钻。视觉形态对齐 mock「DSL 协作工作台」：
 *   - 泳道（槽位）自上而下 = 流水线顺序，左侧阶段牌（编号+名称+一句话）
 *   - 泳道内积木节点卡横排（人话标题+文件数+簇数+归类置信徽章）
 *   - 点击积木卡 → 详情悬窗：面包屑「槽位 › 积木」+ 簇列表（人话）→ 点簇展开文件清单
 *     （槽位→积木→簇→文件 四级下钻在一个悬窗内完成）
 *   - 空槽位如实渲染（"这个项目没有 X"本身就是信息）
 *
 * 忠实纪律：归类置信度徽章区分 llm/rule；未归类积木进独立的"未归类"泳道；
 * 交叉验证倒挂信号写进页脚 limitations。
 */

import path from 'node:path';
import fs from 'node:fs';
import type { BrickifyResult } from './brickify.js';
import { roleOfFile } from './brickify.js';
import type { ClusterNarratives } from './cluster_narrator.js';
import type { AnatomyResult } from './classify_bricks.js';

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
function jsonForScript(o: unknown): string {
  return JSON.stringify(o).replace(/<\//g, '<\\/');
}

const ROLE_BADGE: Record<string, string> = {
  brick: 'an-badge-ok',
  contract: 'an-badge-info',
  glue: 'an-badge-gray',
};
const ROLE_TXT: Record<string, string> = { brick: '功能', contract: '契约', glue: '胶水' };

export function renderAnatomyHtml(r: BrickifyResult, anatomy: AnatomyResult): string {
  const projectName = path.basename(r.meta.project_dir);
  const nar = anatomy.taxonomy;

  // 泳道 DOM：槽位自上而下 → 槽位内按积木分组 → 组内簇节点
  const lanesHtml = anatomy.slots
    .map((lane, i) => {
      const groups = lane.groups
        .map(
          (g) => `<div class="an-group">
  <div class="an-group-tag" title="积木 ${esc(g.brick)}">${esc(g.brickTitle)}<span class="an-group-id">${esc(g.brick)}/</span></div>
  ${g.clusters
    .map(
      (c) => `<div class="an-node" data-cluster="${esc(c.id)}">
  <div class="an-node-head">
    <span class="an-node-title">${esc(c.title)}</span>
    <span class="an-conf ${c.classification.mode}" title="${esc(c.classification.reason)}">${c.classification.mode === 'llm' ? Math.round(c.classification.confidence * 100) + '%' : '启发'}</span>
  </div>
  <div class="an-node-meta">${c.files} 文件 · 内聚 ${c.cohesion}%</div>
  <div class="an-node-reason" title="${esc(c.classification.reason)}">${esc(c.classification.reason.slice(0, 30))}${c.classification.reason.length > 30 ? '…' : ''}</div>
</div>`,
    )
    .join('')}
</div>`,
        )
        .join('');
      const empty = lane.groups.length === 0 ? '<div class="an-empty">（空槽——本项目没有这部分）</div>' : '';
      return `<section class="an-lane">
  <div class="an-lane-tag">
    <span class="an-lane-no">${i + 1}</span>
    <div>
      <div class="an-lane-name">${esc(lane.slot.label)}</div>
      <div class="an-lane-desc">${esc(lane.slot.desc.split('。')[0])}。</div>
    </div>
  </div>
  <div class="an-lane-body">${groups}${empty}</div>
</section>`;
    })
    .join('');

  // 未归类泳道（诚实残留）
  const uncClusterIds = new Set(anatomy.unclassified);
  const uncHtml =
    anatomy.unclassified.length > 0
      ? `<section class="an-lane unc">
  <div class="an-lane-tag">
    <span class="an-lane-no">?</span>
    <div>
      <div class="an-lane-name">未归类</div>
      <div class="an-lane-desc">启发式与 LLM 都拿不准的簇，如实上抛。</div>
    </div>
  </div>
  <div class="an-lane-body">
    ${r.bricks
      .flatMap((b) => b.sub_clusters.filter((s) => uncClusterIds.has(s.id)).map((s) => ({ b, s })))
      .map(
        ({ b, s }) => `<div class="an-node" data-cluster="${esc(s.id)}">
  <div class="an-node-head"><span class="an-node-title">${esc(s.id)}</span><span class="an-conf rule">待归类</span></div>
  <div class="an-node-meta">${s.files.length} 文件 · 积木 ${esc(b.id)}</div>
</div>`,
      )
      .join('')}
  </div>
</section>`
      : '';

  // 悬窗数据：面包屑「槽位 › 积木 › 簇」+ 簇描述 + 文件清单（点簇节点直接看文件，四级下钻）
  const laneLabelOf = new Map<string, string>();
  anatomy.slots.forEach((lane) =>
    lane.groups.forEach((g) => g.clusters.forEach((c) => laneLabelOf.set(c.id, lane.slot.label))),
  );
  const detailFixed = r.bricks.flatMap((b) =>
    b.sub_clusters.map((s) => {
      const laneView = anatomy.slots
        .flatMap((l) => l.groups.flatMap((g) => g.clusters.map((c) => ({ lane: l.slot.label, brick: g.brick, brickTitle: g.brickTitle, c }))))
        .find((x) => x.c.id === s.id);
      return {
        id: s.id,
        lane: laneLabelOf.get(s.id) ?? '未归类',
        brick: laneView?.brick ?? b.id,
        brickTitle: laneView?.brickTitle ?? b.id,
        title: laneView?.c.title ?? s.id,
        desc: laneView?.c.desc ?? '',
        reason: laneView?.c.classification.reason ?? '（未归类）',
        facts: `${s.files.length} 文件 · 内聚 ${Math.round(s.cohesion * 100)}% · 积木 ${b.id}`,
        fileList: s.files.map((f) => ({ path: f, role: roleOfFile(f) })),
      };
    }),
  );

  const limHtml = anatomy.limitations.map((l) => `- ${esc(l)}`).join('\n');
  const modeTxt =
    anatomy.meta.mode === 'llm'
      ? `LLM 归类 ${anatomy.meta.llm_ok}/${anatomy.meta.total} 簇`
      : `启发式归类（LLM 未启用）`;

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>解剖 · ${esc(projectName)}</title>
<style>
:root{--bg:#fafafa;--card:#fff;--border:#e4e4e7;--border-strong:#d4d4d8;--text:#0a0a0a;--muted:#71717a;--brand:#7c3aed;--ok:#16a34a;--info:#2563eb;--warn:#d97706;--radius:.625rem;--radius-sm:.375rem;--shadow-sm:0 1px 3px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04);--shadow:0 4px 6px -1px rgba(0,0,0,.06),0 2px 4px -2px rgba(0,0,0,.04)}
*{box-sizing:border-box}
body{margin:0;font-family:'Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:var(--text);background:var(--bg)}
header{display:flex;align-items:center;gap:14px;padding:12px 18px;background:var(--card);border-bottom:1px solid var(--border);flex-wrap:wrap;position:sticky;top:0;z-index:10}
header h1{font-size:15px;margin:0;font-weight:650}
.meta{font-size:12px;color:var(--muted)}
main{padding:18px;max-width:1160px;margin:0 auto}
.tax-desc{font-size:12px;color:var(--muted);margin-bottom:16px}
.an-lane{display:flex;gap:14px;margin-bottom:16px;background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;box-shadow:var(--shadow-sm)}
.an-lane.unc{border-style:dashed;background:#fcfcfc}
.an-lane-tag{width:150px;flex-shrink:0;display:flex;gap:10px;align-items:flex-start}
.an-lane-no{width:26px;height:26px;border-radius:8px;background:#111827;color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.an-lane.unc .an-lane-no{background:#a1a1aa}
.an-lane-name{font-size:14px;font-weight:650}
.an-lane-desc{font-size:10.5px;color:var(--muted);line-height:1.5;margin-top:3px}
.an-lane-body{flex:1;display:flex;flex-wrap:wrap;gap:12px;align-content:flex-start}
.an-group{display:flex;flex-direction:column;gap:6px}
.an-group-tag{font-size:10.5px;color:var(--muted);font-weight:600;padding-left:2px}
.an-group-id{color:#a1a1aa;font-family:ui-monospace,monospace;font-weight:400;margin-left:4px}
.an-node{width:200px;background:#fff;border:1px solid var(--border-strong);border-radius:var(--radius-sm);padding:10px 12px;cursor:pointer;transition:all .12s}
.an-node:hover{box-shadow:var(--shadow);border-color:#c9c9ce}
.an-node.sel{border-color:var(--brand);box-shadow:0 0 0 2px #7c3aed33}
.an-node-head{display:flex;align-items:center;gap:6px}
.an-node-title{font-size:12.5px;font-weight:600;line-height:1.25}
.an-conf{margin-left:auto;flex-shrink:0;font-size:9.5px;padding:2px 7px;border-radius:9px;font-weight:600;line-height:1}
.an-conf.llm{background:#f0fdf4;color:#15803d}
.an-conf.rule{background:#fffbeb;color:#b45309}
.an-node-meta{font-size:10.5px;color:var(--muted);margin-top:5px}
.an-node-reason{font-size:10px;color:#a1a1aa;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.an-empty{font-size:11.5px;color:#a1a1aa;font-style:italic;padding:8px 4px}
.panel{position:fixed;top:0;right:-440px;width:420px;height:100vh;background:#fff;border-left:1px solid var(--border);box-shadow:-8px 0 24px rgba(0,0,0,.08);transition:right .18s ease;z-index:50;display:flex;flex-direction:column}
.panel.open{right:0}
.panel-head{padding:16px 18px 12px;border-bottom:1px solid var(--border)}
.crumb{font-size:10.5px;color:var(--brand);font-weight:600;margin-bottom:6px;letter-spacing:.3px}
.panel-title{font-size:15px;font-weight:650}
.panel-desc{font-size:12.5px;color:#3f3f46;margin-top:6px;line-height:1.6}
.panel-reason{font-size:11px;color:var(--muted);margin-top:6px;font-style:italic}
.panel-body{flex:1;overflow-y:auto;padding:12px 18px}
.f-row{display:flex;align-items:center;gap:8px;padding:5px 12px;font-size:11.5px}
.f-row:hover{background:#fafafa}
.f-path{font-family:ui-monospace,'Cascadia Code',monospace;font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.f-role{margin-left:auto;flex-shrink:0}
.an-badge{display:inline-flex;padding:2px 8px;border-radius:9px;font-size:9.5px;font-weight:600;line-height:1.4}
.an-badge-ok{background:#f0fdf4;color:#15803d}
.an-badge-info{background:#eff6ff;color:#1d4ed8}
.an-badge-gray{background:#f5f5f5;color:#71717a}
.panel-close{position:absolute;top:10px;right:12px;font-size:17px;color:var(--muted);cursor:pointer;background:none;border:none;line-height:1}
.panel-close:hover{color:var(--text)}
footer{padding:14px 18px;border-top:1px solid var(--border);background:var(--card);color:var(--muted);font-size:11px;white-space:pre-wrap;line-height:1.6}
</style>
</head>
<body>
<header>
  <h1>解剖 · ${esc(nar.label)}</h1>
  <span class="meta">${esc(projectName)} · ${r.bricks.length} 积木 → ${anatomy.slots.length} 槽位 · ${modeTxt}${anatomy.unclassified.length > 0 ? ` · 未归类 ${anatomy.unclassified.length}` : ''}</span>
</header>
<main>
  <div class="tax-desc">${esc(nar.desc)}——从上往下逐层下钻：槽位 → 积木 → 簇 → 文件（点积木卡看内部）</div>
  ${lanesHtml}
  ${uncHtml}
</main>
<aside class="panel" id="panel">
  <button class="panel-close" id="pclose">×</button>
  <div class="panel-head">
    <div class="crumb" id="pcrumb"></div>
    <div class="panel-title" id="ptitle"></div>
    <div class="panel-desc" id="pdesc"></div>
    <div class="panel-reason" id="preason"></div>
  </div>
  <div class="panel-body" id="pbody"></div>
</aside>
<footer>limitations
${limHtml}</footer>
<script>
const DETAIL = ${jsonForScript(detailFixed)};
document.querySelectorAll('.an-node').forEach(el => {
  el.addEventListener('click', () => {
    const d = DETAIL.find(x => x.id === el.dataset.cluster);
    if (!d) return;
    document.querySelectorAll('.an-node').forEach(x => x.classList.remove('sel'));
    el.classList.add('sel');
    document.getElementById('pcrumb').textContent = d.lane + ' › ' + d.brick + ' › ' + d.id;
    document.getElementById('ptitle').textContent = d.title;
    document.getElementById('pdesc').textContent = d.desc || '（暂无解读）';
    document.getElementById('preason').textContent = '归类依据：' + d.reason + ' · ' + d.facts;
    const body = document.getElementById('pbody');
    body.innerHTML = d.fileList.map(f =>
      '<div class="f-row"><span class="f-path"></span>' +
      '<span class="an-badge f-role ' + ({brick:'an-badge-ok',contract:'an-badge-info',glue:'an-badge-gray'}[f.role]||'an-badge-gray') + '">' +
      ({brick:'功能',contract:'契约',glue:'胶水'}[f.role]||f.role) + '</span></div>'
    ).join('');
    body.querySelectorAll('.f-path').forEach((p, i) => { p.textContent = d.fileList[i].path; p.title = d.fileList[i].path; });
    document.getElementById('panel').classList.add('open');
  });
});
document.getElementById('pclose').addEventListener('click', () => {
  document.getElementById('panel').classList.remove('open');
  document.querySelectorAll('.an-node').forEach(x => x.classList.remove('sel'));
});
</script>
</body>
</html>`;
}

/** 落盘便捷入口。 */
export function buildAnatomyHtml(opts: {
  result: BrickifyResult;
  anatomy: AnatomyResult;
  narratives?: ClusterNarratives;
  out_file?: string;
}): string {
  const html = renderAnatomyHtml(opts.result, opts.anatomy);
  if (opts.out_file) {
    const abs = path.resolve(opts.out_file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, html, 'utf-8');
  }
  return html;
}
