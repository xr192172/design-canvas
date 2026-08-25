/**
 * render_dsl_workbench —— DSL 协作工作台渲染层（契约的投影）
 *
 * 用户定调（2026-08-25）：载体 = `DSL 协作工作台.zip` 的页面本身。壳照抄
 * （sidebar/toolbar/画布/minimap/审核面板/版本滑条 + 1173 行 CSS 原样快照）。
 *
 * 分层（2026-08-25 二期，参照 DataFlow-Harness 的 Backend/WebUI 分离）：
 *   契约层 workbench_data.ts —— 权威数据源（结构化 JSON，冻结 v1），
 *     也是前端窗口B 的对接物（mock → fetch 真数据）；
 *   本文件渲染层 —— 只做投影：WorkbenchData → 壳 HTML。
 *     一份契约两个消费方：本渲染器（服务端出 HTML）与前端B（浏览器出交互）。
 *
 * 数据映射（与 mock 七节点天然同构）：槽位/坐标/连线见契约层注释。
 * 忠实纪律与状态语义见契约层文件头——渲染层不重新推导任何状态。
 */

import path from 'node:path';
import fs from 'node:fs';
import type { BrickifyResult } from './brickify.js';
import type { AnatomyResult } from './classify_bricks.js';
import type { ClusterNarratives } from './cluster_narrator.js';
import { buildWorkbenchData, type WorkbenchData, type WorkbenchIssue, type WorkbenchSlot } from './workbench_data.js';
import { WORKBENCH_SHELL_CSS } from './workbench_shell_css.js';

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
function jsonForScript(o: unknown): string {
  return JSON.stringify(o).replace(/</g, '\\u003c');
}

// ─── 面板片段：从契约结构化数据生成 HTML（前端B 同样按此结构自行渲染） ───

function slotFootHtml(s: WorkbenchSlot): string {
  const groupCount = s.groups.length;
  const clusterCount = s.groups.reduce((a, g) => a + g.clusters.length, 0);
  const fileCount = s.groups.reduce((a, g) => a + g.clusters.reduce((x, c) => x + c.files, 0), 0);
  if (s.status === 'gray') return `<span class="dslw-badge dslw-badge-gray">空槽（如实）</span>`;
  if (s.status === 'focus') return `<span class="dslw-badge dslw-badge-dark">你正在这里</span>`;
  if (s.status === 'warn') return `<span class="dslw-badge dslw-badge-warn">${s.issues.length}个问题待确认</span>`;
  if (s.status === 'info') return `<span class="dslw-badge dslw-badge-info">含启发式归类</span>`;
  return `<span style="color:var(--dslw-muted-foreground);">${groupCount} 积木 · ${clusterCount} 簇 · ${fileCount} 文件</span>`;
}

function composeHtmlFor(s: WorkbenchSlot): string {
  if (s.groups.length === 0) {
    return `<div class="dslw-issue"><div class="dslw-issue-desc">空槽——本项目的结构里没有归入此槽位的簇。</div></div>`;
  }
  return s.groups
    .map(
      (g) => `<div class="dslw-param">
  <div class="dslw-param-head"><span class="dslw-param-label">${esc(g.title)}</span>
  <span style="font-family:var(--dslw-font-mono);font-size:11px;color:var(--dslw-muted-foreground);">${g.clusters.length} 簇</span></div>
  ${g.clusters
    .map(
      (c) => `<div class="dslw-param-desc" style="margin:4px 0 2px;display:flex;gap:6px;align-items:center;">
    <span style="color:var(--dslw-foreground);">· ${esc(c.title)}</span>
    <span class="dslw-badge dslw-badge-gray" style="font-size:10px;">${c.files} 文件 · 内聚 ${c.cohesion}%</span>
  </div>
  <div class="dslw-param-desc" style="font-size:11px;color:var(--dslw-muted-foreground);margin:0 0 6px 12px;">${esc(c.desc)}</div>`,
    )
    .join('')}
</div>`,
    )
    .join('');
}

function issueCardHtml(it: WorkbenchIssue): string {
  return `<div class="dslw-issue${it.severe ? ' severe' : ''}">
  <div class="dslw-issue-head">
    <span class="dslw-badge ${it.severe ? 'dslw-badge-danger' : 'dslw-badge-warn'}">${it.severe ? '需确认' : '建议'}</span>
    <span class="dslw-issue-title">${esc(it.title)}</span>
  </div>
  <div class="dslw-issue-desc">${esc(it.desc)}</div>
  <div class="dslw-issue-actions">
    <button class="dslw-issue-btn primary">采纳建议</button>
    <button class="dslw-issue-btn">忽略</button>
    <button class="dslw-issue-btn">讨论</button>
  </div>
</div>`;
}

function issuesHtmlFor(s: WorkbenchSlot): string {
  if (s.issues.length === 0) {
    return `<div class="dslw-issue"><div class="dslw-issue-desc">此槽位暂无待处理问题。</div></div>`;
  }
  return s.issues.map(issueCardHtml).join('');
}

function dataJsonFor(s: WorkbenchSlot): string {
  // 「真实数据」tab：槽位的契约结构化视图（groups+clusters 原样）
  return JSON.stringify(
    {
      slot: s.id,
      label: s.label,
      groups: s.groups.map((g) => ({
        brick: g.brick,
        title: g.title,
        clusters: g.clusters.map((c) => ({
          id: c.id,
          title: c.title,
          files: c.files,
          cohesion: c.cohesion,
          classified_by: c.classifiedBy,
          confidence: c.confidence,
          reason: c.reason,
        })),
      })),
    },
    null,
    2,
  );
}

// ─── HTML 生成 ───

export function renderDslWorkbenchHtml(
  result: BrickifyResult,
  anatomy: AnatomyResult,
  narratives: ClusterNarratives,
  projectName: string,
): string {
  const data: WorkbenchData = buildWorkbenchData(result, anatomy, narratives, projectName);
  return renderFromWorkbenchData(data, { classifyStats: data.meta.classifyStats, narrateStats: data.meta.narrateStats });
}

/** 从契约数据渲染（前端B 未来可在浏览器端做同样的事） */
export function renderFromWorkbenchData(
  data: WorkbenchData,
  stats: { classifyStats: string; narrateStats: string },
): string {
  const { meta, project, slots, paths, defaultSlot } = data;
  const ov = { title: project.title, summary: project.overview };
  const genTime = `${String(new Date(meta.generatedAt).getHours()).padStart(2, '0')}:${String(new Date(meta.generatedAt).getMinutes()).padStart(2, '0')}`;

  const nodesHtml = slots
    .map((p) => {
      const cls = p.id === defaultSlot ? ' selected' : p.status === 'focus' ? ' focus' : '';
      const dotCls = p.status === 'focus' ? 'focus-dot' : p.status;
      const txtCls = p.status === 'focus' ? 'focus-text' : p.status;
      return `<div class="dslw-node${cls}" data-slot="${p.id}" style="top:${p.y}px; left:${p.x}px;${p.w ? ` width:${p.w}px;` : ''}">
  <div class="dslw-node-status">
    <span class="dslw-status-dot ${dotCls}"></span>
    <span class="dslw-status-text ${txtCls}">${esc(p.statusText)}</span>
  </div>
  <div class="dslw-node-title-row">
    <div class="dslw-node-icon"><i data-lucide="${p.icon}"></i></div>
    <div class="dslw-node-name">${esc(p.label)}</div>
  </div>
  <div class="dslw-node-desc">${esc(p.desc)}</div>
  <div class="dslw-node-footer">${slotFootHtml(p)}</div>
</div>`;
    })
    .join('\n');

  const pathsHtml = paths
    .map(
      (p) =>
        `<path class="${p.active ? 'active flow-active' : 'flow'}" d="${p.d}" marker-end="url(#${p.active ? 'dslw-arrow-active' : 'dslw-arrow'})"/>`,
    )
    .join('\n');

  // minimap：真实节点位置（画布 60..960 × 80..460 → 150×100 内缩放）
  const mm = slots
    .map((p) => {
      const color =
        p.status === 'warn'
          ? 'var(--dslw-warning)'
          : p.status === 'info'
            ? 'var(--dslw-info)'
            : p.status === 'gray'
              ? 'var(--dslw-chart-1)'
              : p.status === 'focus'
                ? 'var(--dslw-primary)'
                : 'var(--dslw-success)';
      const left = Math.round((p.x / 960) * 138) + 4;
      const top = Math.round(((p.y - 80) / 380) * 80) + 8;
      return `<div class="mm-node" style="top:${top}px; left:${left}px; background:${color};"></div>`;
    })
    .join('\n');

  const detailJson = Object.fromEntries(
    slots.map((s) => [
      s.id,
      {
        label: s.label,
        icon: s.icon,
        status: s.status,
        statusText: s.statusText,
        subtitle: s.subtitle,
        explainWhat: s.explainWhat,
        explainWhy: s.explainWhy,
        composeCount: s.groups.reduce((a, g) => a + g.clusters.length, 0),
        issueCount: s.issues.length,
        composeHtml: composeHtmlFor(s),
        issuesHtml: issuesHtmlFor(s),
        dataJson: dataJsonFor(s),
      },
    ]),
  );

  return `<!DOCTYPE html>
<html lang="zh-CN" class="light" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DSL 协作工作台 · ${esc(meta.project)}</title>
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.3.1/dist/index.global.js"></script>
<script src="https://unpkg.com/lucide@1.8.0/dist/umd/lucide.min.js"></script>
<style>
${WORKBENCH_SHELL_CSS}
</style>
<style>
/* ── 真数据版补充样式（壳 CSS 不动，行为增量） ── */
.dslw-badge-danger{background:var(--dslw-danger-subtle);color:var(--dslw-danger-text);border:1px solid var(--dslw-danger-border)}
#toast{position:fixed;top:16px;left:50%;transform:translateX(-50%) translateY(-8px);background:var(--dslw-primary);color:var(--dslw-primary-foreground);padding:9px 20px;border-radius:20px;font-size:12.5px;font-weight:600;z-index:99;opacity:0;pointer-events:none;transition:all .25s ease;box-shadow:var(--dslw-shadow)}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.dslw-canvas.detail .dslw-node-desc{-webkit-line-clamp:unset;display:block;overflow:visible}
.dslw-node{cursor:pointer}
.dslw-node:hover{border-color:var(--dslw-border-strong)}
.dslw-codeblock{max-height:300px;overflow:auto}
</style>
</head>
<body class="min-h-screen font-sans antialiased">
<main>
<div id="toast">演示壳：本页数据来自 brickify / anatomy / narrate 真实管线快照</div>
<div class="dslw-app">

<aside class="dslw-sidebar">
  <div class="dslw-brand">
    <div class="dslw-brand-logo">D</div>
    <div class="dslw-brand-text">
      <div class="dslw-brand-name">DSL Workbench</div>
      <div class="dslw-brand-sub">可视化协作平台</div>
    </div>
  </div>
  <div class="dslw-nav-section">工作台</div>
  <a class="dslw-nav-item active">
    <i data-lucide="layout-template"></i><span>沙盘视图</span>
    <span class="dslw-nav-badge">当前</span>
  </a>
  <a class="dslw-nav-item">
    <i data-lucide="history"></i><span>版本历史</span>
  </a>
  <a class="dslw-nav-item">
    <i data-lucide="alert-circle"></i><span>问题清单</span>
    ${meta.totalIssues > 0 ? `<span class="dslw-nav-badge-num">${meta.totalIssues}</span>` : ''}
  </a>
  <a class="dslw-nav-item"><i data-lucide="code-2"></i><span>DSL 源码</span></a>
  <a class="dslw-nav-item"><i data-lucide="refresh-cw"></i><span>同步记录</span></a>
  <div class="dslw-nav-divider"></div>
  <div class="dslw-nav-section">当前项目</div>
  <div class="dslw-project-card">
    <div class="dslw-project-name">${esc(ov.title)}（${esc(meta.project)}）</div>
    <div class="dslw-project-meta">${meta.scannedFiles} 文件 · ${meta.bricks} 积木 · 生成于 ${genTime}</div>
    ${meta.totalIssues > 0 ? `<div class="dslw-project-warn"><i data-lucide="alert-triangle" style="width:12px;height:12px;"></i>待处理问题: ${meta.totalIssues}</div>` : ''}
  </div>
  <div class="dslw-sidebar-bottom">
    <div class="dslw-safe-mode">
      <div class="dslw-toggle on"></div>
      <div class="dslw-safe-mode-text">
        <div class="dslw-safe-mode-label">安全模式</div>
        <div class="dslw-safe-mode-desc">逐层确认后回写</div>
      </div>
    </div>
    <div class="dslw-user-row">
      <div class="dslw-avatar"></div>
      <div class="dslw-user-info">
        <div class="dslw-user-name">你</div>
        <div class="dslw-user-status">评审中</div>
      </div>
    </div>
  </div>
</aside>

<header class="dslw-toolbar">
  <div class="dslw-breadcrumb">
    <i data-lucide="folder"></i>
    <a href="#">我的项目</a><span class="sep">/</span>
    <a href="#">${esc(meta.project)}</a><span class="sep">/</span>
    <span class="current">沙盘视图</span>
  </div>
  <div class="dslw-toolbar-controls">
    <div class="dslw-zoom-group">
      <button class="dslw-zoom-btn" id="zoomOut" title="缩小"><i data-lucide="minus"></i></button>
      <div class="dslw-zoom-val" id="zoomVal">100%</div>
      <button class="dslw-zoom-btn" id="zoomIn" title="放大"><i data-lucide="plus"></i></button>
    </div>
    <div class="dslw-segmented">
      <button class="dslw-seg-btn active" id="viewGlobal">全局视图</button>
      <button class="dslw-seg-btn" id="viewDetail">详细视图</button>
    </div>
    <div class="dslw-toolbar-divider"></div>
    <button class="dslw-btn dslw-btn-ghost" id="btnRegen"><i data-lucide="sparkles"></i>AI 重新生成</button>
    <button class="dslw-btn dslw-btn-primary" id="btnSync"><i data-lucide="check"></i>定稿同步</button>
    <button class="dslw-btn-icon" title="更多操作"><i data-lucide="more-horizontal"></i></button>
  </div>
</header>

<section class="dslw-canvas" data-viewport-mode="app-shell" id="canvas">
  <div class="dslw-canvas-inner" data-scroll-region="primary" id="canvasInner">
    <svg class="dslw-connections" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker id="dslw-arrow" class="arrowhead" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="var(--dslw-connection)"/></marker>
        <marker id="dslw-arrow-active" class="arrowhead-active" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="var(--dslw-connection-active)"/></marker>
      </defs>
      ${pathsHtml}
    </svg>
    ${nodesHtml}
    <div class="dslw-minimap-wrap">
      <div class="dslw-minimap">
        ${mm}
        <div class="mm-viewport" style="top:8px; left:30px; width:80px; height:65px;"></div>
      </div>
      <div class="dslw-legend">
        <div class="dslw-legend-item"><span class="dslw-legend-dot" style="background:var(--dslw-success);"></span>正常</div>
        <div class="dslw-legend-item"><span class="dslw-legend-dot" style="background:var(--dslw-info);"></span>待确认</div>
        <div class="dslw-legend-item"><span class="dslw-legend-dot" style="background:var(--dslw-warning);"></span>有问题</div>
        <div class="dslw-legend-item"><span class="dslw-legend-dot" style="background:var(--dslw-primary);"></span>人机闭环</div>
        <div class="dslw-legend-item"><span class="dslw-legend-dot" style="background:var(--dslw-chart-1);"></span>空槽</div>
      </div>
    </div>
    <div class="dslw-canvas-ctrls">
      <button class="dslw-canvas-ctrl" title="全屏"><i data-lucide="maximize-2"></i></button>
      <button class="dslw-canvas-ctrl" title="帮助" style="font-size:13px;font-weight:600;">?</button>
    </div>
  </div>
</section>

<aside class="dslw-panel open" id="panel">
  <button class="dslw-panel-close" id="panelClose" title="关闭面板"><i data-lucide="x"></i></button>
  <div class="dslw-panel-header">
    <div class="dslw-panel-badge"><span class="dslw-badge" id="pBadge"></span></div>
    <div class="dslw-panel-title" id="pTitle"></div>
    <div class="dslw-panel-subtitle" id="pSubtitle"></div>
    <div class="dslw-explain-card">
      <div class="dslw-explain-title">这是什么？</div>
      <div class="dslw-explain-body" id="pWhat"></div>
      <div class="dslw-explain-title">为什么需要它？</div>
      <div class="dslw-explain-body" id="pWhy"></div>
    </div>
  </div>
  <div class="dslw-tabs">
    <button class="dslw-tab" data-tab="compose" id="tabCompose">构成</button>
    <button class="dslw-tab active" data-tab="issues" id="tabIssues">问题清单</button>
    <button class="dslw-tab" data-tab="data" id="tabData">真实数据</button>
  </div>
  <div class="dslw-panel-body" id="pBody"></div>
  <div class="dslw-feedback">
    <div class="dslw-feedback-title">提交你的看法</div>
    <div class="dslw-feedback-actions">
      <button class="dslw-fb-btn">保留</button>
      <button class="dslw-fb-btn active">修改</button>
      <button class="dslw-fb-btn">删除</button>
      <button class="dslw-fb-btn">新增</button>
    </div>
    <textarea class="dslw-feedback-textarea" placeholder="用自然语言描述你的想法，AI会理解并重新生成..."></textarea>
    <div class="dslw-feedback-foot">
      <span class="dslw-feedback-hint">提示：反馈通道建设中——当前数据为真实管线快照</span>
      <button class="dslw-feedback-send" id="btnSend"><i data-lucide="send"></i>发送</button>
    </div>
  </div>
</aside>

<footer class="dslw-bottom">
  <div class="dslw-slider-wrap">
    <span class="dslw-slider-label">管线快照</span>
    <div class="dslw-slider-track"><div class="dslw-slider-thumb"><i data-lucide="chevron-left"></i><i data-lucide="chevron-right"></i></div></div>
    <span class="dslw-slider-label right">下次扫描</span>
  </div>
  <span class="dslw-slider-hint">数据来源：brickify 聚类 + anatomy 解剖（${esc(stats.classifyStats)}）+ narrate 翻译（${esc(stats.narrateStats)}）</span>
  <div class="dslw-version-info">
    <span>${meta.scannedFiles} 文件 <span class="dslw-version-arrow">&rarr;</span> ${meta.bricks} 积木</span>
    <span class="dslw-change-count">${meta.totalIssues} 待处理信号</span>
  </div>
</footer>
</div>
</main>

<script>
const SLOTS = ${jsonForScript(detailJson)};
const DEFAULT_SLOT = '${defaultSlot}';
const panel = document.getElementById('panel');
const pBody = document.getElementById('pBody');
let curSlot = null, curTab = 'issues';

function badgeFor(s) {
  if (s.status === 'warn') return {cls: 'dslw-badge-warn', txt: '有问题'};
  if (s.status === 'info') return {cls: 'dslw-badge-info', txt: '待确认'};
  if (s.status === 'gray') return {cls: 'dslw-badge-gray', txt: '空槽'};
  if (s.status === 'focus') return {cls: 'dslw-badge-dark', txt: '人参与'};
  return {cls: 'dslw-badge-ok', txt: '正常'};
}
function renderPanel() {
  const s = SLOTS[curSlot]; if (!s) return;
  const b = badgeFor(s);
  const pb = document.getElementById('pBadge');
  pb.className = 'dslw-badge ' + b.cls; pb.textContent = b.txt;
  document.getElementById('pTitle').textContent = s.label;
  document.getElementById('pSubtitle').textContent = s.subtitle;
  document.getElementById('pWhat').textContent = s.explainWhat;
  document.getElementById('pWhy').textContent = s.explainWhy;
  document.getElementById('tabCompose').textContent = '构成 (' + s.composeCount + ')';
  document.getElementById('tabIssues').textContent = '问题清单 (' + s.issueCount + ')';
  document.querySelectorAll('.dslw-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === curTab));
  if (curTab === 'compose') pBody.innerHTML = s.composeHtml;
  else if (curTab === 'data') pBody.innerHTML = '<div class="dslw-code-label">槽位真实数据（anatomy 视图）</div><div class="dslw-codeblock">' + s.dataJson.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</div>';
  else pBody.innerHTML = s.issuesHtml;
  if (window.lucide) lucide.createIcons();
}
function selectSlot(id) {
  curSlot = id;
  document.querySelectorAll('.dslw-node').forEach(n => n.classList.toggle('selected', n.dataset.slot === id));
  curTab = (SLOTS[id] && SLOTS[id].issueCount > 0) ? 'issues' : 'compose';
  renderPanel();
  panel.classList.add('open');
}
document.querySelectorAll('.dslw-node').forEach(n => n.addEventListener('click', () => selectSlot(n.dataset.slot)));
document.getElementById('panelClose').addEventListener('click', () => {
  panel.classList.remove('open');
  document.querySelectorAll('.dslw-node').forEach(n => n.classList.remove('selected'));
});
document.querySelectorAll('.dslw-tab').forEach(t => t.addEventListener('click', () => { curTab = t.dataset.tab; renderPanel(); }));

// 缩放（真实生效——mock 是写死的 87%）
let zoom = 1;
const inner = document.getElementById('canvasInner'), zoomVal = document.getElementById('zoomVal');
function setZoom(z) { zoom = Math.max(0.4, Math.min(1.6, z)); inner.style.zoom = zoom; zoomVal.textContent = Math.round(zoom * 100) + '%'; }
document.getElementById('zoomIn').addEventListener('click', () => setZoom(zoom * 1.15));
document.getElementById('zoomOut').addEventListener('click', () => setZoom(zoom / 1.15));

// 全局↔详细视图（mock 分段是摆设，这里真切换：详细=节点描述全文）
const canvas = document.getElementById('canvas');
document.getElementById('viewGlobal').addEventListener('click', (e) => {
  canvas.classList.remove('detail');
  e.target.classList.add('active'); document.getElementById('viewDetail').classList.remove('active');
});
document.getElementById('viewDetail').addEventListener('click', (e) => {
  canvas.classList.add('detail');
  e.target.classList.add('active'); document.getElementById('viewGlobal').classList.remove('active');
});

// 演示按钮 → 如实提示（不假装执行）
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._h); toast._h = setTimeout(() => t.classList.remove('show'), 2200);
}
document.getElementById('btnRegen').addEventListener('click', () => toast('演示按钮：重新生成请跑 brickify_cli --dsl-workbench'));
document.getElementById('btnSync').addEventListener('click', () => toast('演示按钮：定稿同步走 edit_dsl / backfill_scaffold 管线'));
document.getElementById('btnSend').addEventListener('click', () => toast('反馈通道建设中——当前为真实管线只读快照'));

selectSlot(DEFAULT_SLOT);
if (window.lucide) lucide.createIcons();
</script>
</body>
</html>`;
}

/** 落盘便捷入口。 */
export function buildDslWorkbenchHtml(opts: {
  out_file: string;
  result: BrickifyResult;
  anatomy: AnatomyResult;
  narratives: ClusterNarratives;
  projectName: string;
}): string {
  const html = renderDslWorkbenchHtml(opts.result, opts.anatomy, opts.narratives, opts.projectName);
  const abs = path.resolve(opts.out_file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, html, 'utf-8');
  return html;
}
