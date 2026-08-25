/**
 * render_dsl_workbench —— DSL 协作工作台（mock 壳 100% 保留，数据全换真）
 *
 * 用户定调（2026-08-25）：载体 = `DSL 协作工作台.zip` 的页面本身——"把我们的数据
 * 填进这里面"，而不是另造新页面。mock 是高完成度但零交互的摆设（唯一 JS 是
 * lucide.createIcons()），本模块：壳照抄（sidebar/toolbar/画布/minimap/审核面板/
 * 版本滑条 + 1173 行 CSS 原样快照），芯全换真：
 *
 * 数据映射（与 mock 七节点天然同构——taxonomy 设计时就按 mock 建的）：
 *   mock 文件扫描器  → intake  输入摄取   (60,80)
 *   mock DSL生成器   → parse   解析转换   (300,80)
 *   mock 运算处理器  → compute 核心运算   (540,180) 流水线中枢
 *   mock 新DSL输出   → store   状态存储   (780,80)
 *   mock 问题检测器  → observe 观测质检   (540,340)
 *   mock 人工审核台  → review  人机闭环   (300,320) focus"你正在这里"
 *   mock DSL回写器   → render  呈现输出   (780,340)
 *   连线：mock 8 条贝塞尔 path 原文照抄（节点坐标一致）
 *
 * 真实数据源：
 *   - 节点 = anatomy 七槽位（槽内积木分组 + 簇人话）
 *   - 问题清单 = brickify 混合文件信号（建议卡）+ anatomy limitations 倒挂（需确认卡）
 *   - sidebar 项目卡 = narrate overview（项目人话）+ 真实文件/积木/问题数
 *   - 「这是什么/为什么需要它」= 槽位判据 + 簇人话（LLM 翻译层）
 *
 * 忠实纪律：节点状态只映射确定性事实——
 *   warn=槽内有混合文件信号 · info=含 rule 降级簇(启发式归类) · gray=空槽如实
 *   · focus=review 槽(人机闭环=人参与处) · 其余 ok；
 *   版本历史导航不带假数字（数据未知就如实留白）。
 * 交互做真（mock 全是摆设）：点节点开面板/换内容、tab 切换、缩放生效、
 *   全局↔详细视图切换、演示按钮弹如实 toast。
 */

import path from 'node:path';
import fs from 'node:fs';
import type { BrickifyResult } from './brickify.js';
import type { AnatomyResult, AnatomySlotView } from './classify_bricks.js';
import type { ClusterNarratives } from './cluster_narrator.js';
import { WORKBENCH_SHELL_CSS } from './workbench_shell_css.js';

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
function jsonForScript(o: unknown): string {
  return JSON.stringify(o).replace(/</g, '\\u003c');
}

// ─── 槽位节点定义（坐标/连线 = mock 原文；id 与 taxonomy 一致） ───

interface SlotNode {
  id: string;
  label: string;
  icon: string;
  x: number;
  y: number;
  w?: number;
}

const SLOT_NODES: SlotNode[] = [
  { id: 'intake', label: '输入摄取', icon: 'scan-search', x: 60, y: 80 },
  { id: 'parse', label: '解析转换', icon: 'file-code-2', x: 300, y: 80 },
  { id: 'compute', label: '核心运算', icon: 'cpu', x: 540, y: 180 },
  { id: 'store', label: '状态存储', icon: 'database', x: 780, y: 80 },
  { id: 'render', label: '呈现输出', icon: 'file-output', x: 780, y: 340 },
  { id: 'observe', label: '观测质检', icon: 'shield-alert', x: 540, y: 340 },
  { id: 'review', label: '人机闭环', icon: 'user-check', x: 300, y: 320, w: 200 },
];

/** mock 的 8 条贝塞尔连线原文（节点坐标一致，原文照抄保形） */
const MOCK_PATHS = [
  { d: 'M240,146 C260,146 280,146 300,146', active: false },
  { d: 'M480,146 C540,146 560,146 580,160 C600,174 615,180 630,180', active: false },
  { d: 'M720,246 C780,246 810,212 870,212', active: false },
  { d: 'M630,312 L630,340', active: true },
  { d: 'M540,246 C510,246 500,280 500,320 C500,350 500,375 500,385', active: true },
  { d: 'M540,406 C525,406 512,395 502,390', active: true },
  { d: 'M870,212 C870,270 700,320 500,320', active: true },
  { d: 'M500,390 C600,390 700,406 780,406', active: false },
];

// ─── 数据装配 ───

interface SlotPanel {
  id: string;
  label: string;
  icon: string;
  status: 'ok' | 'warn' | 'info' | 'gray' | 'focus';
  statusText: string;
  badgeClass: string; // dslw-badge-warn / dslw-badge-info / dslw-badge-gray / dslw-badge-dark / ''
  badgeText: string;
  desc: string;
  subtitle: string;
  explainWhat: string;
  explainWhy: string;
  composeCount: number;
  issueCount: number;
  composeHtml: string;
  issuesHtml: string;
  dataJson: string;
  footHtml: string;
}

function buildSlots(
  result: BrickifyResult,
  anatomy: AnatomyResult,
  narratives: ClusterNarratives,
): SlotPanel[] {
  // 混合文件信号 → 按积木主槽归属（该积木簇数最多的槽）
  const brickMainSlot = new Map<string, string>();
  for (const lane of anatomy.slots) {
    for (const g of lane.groups) {
      const cur = brickMainSlot.get(g.brick);
      const curCount = cur ? (anatomy.slots.find((s) => s.slot.id === cur)?.groups.find((x) => x.brick === g.brick)?.clusters.length ?? 0) : 0;
      if (g.clusters.length > curCount) brickMainSlot.set(g.brick, lane.slot.id);
    }
  }
  const issuesBySlot = new Map<string, Array<{ severe: boolean; title: string; desc: string }>>();
  const pushIssue = (slot: string, issue: { severe: boolean; title: string; desc: string }): void => {
    const arr = issuesBySlot.get(slot) ?? [];
    arr.push(issue);
    issuesBySlot.set(slot, arr);
  };
  for (const m of result.mixed_files) {
    const brick = m.file.split('/')[0];
    const slot = brickMainSlot.get(brick) ?? 'compute';
    pushIssue(slot, {
      severe: false,
      title: `混合职责文件：${m.file}`,
      desc: `该文件内检测到 ${m.clusters.length} 个独立功能簇（${m.clusters
        .slice(0, 2)
        .map((c) => `[${c.slice(0, 4).join(', ')}${c.length > 4 ? '…' : ''}]`)
        .join(' ')}${m.clusters.length > 2 ? ' …' : ''}），不同职责挤在一个文件里，建议拆分为独立模块。`,
    });
  }
  for (const lim of anatomy.limitations) {
    pushIssue('observe', { severe: true, title: '分类与依赖分层倒挂', desc: lim });
  }

  const narrClusters = narratives.clusters ?? {};
  return SLOT_NODES.map((n) => {
    const lane = anatomy.slots.find((s) => s.slot.id === n.id) as AnatomySlotView | undefined;
    const groups = lane?.groups ?? [];
    const clusters = groups.flatMap((g) => g.clusters);
    const fileCount = clusters.reduce((a, c) => a + c.files, 0);
    const issues = issuesBySlot.get(n.id) ?? [];
    const hasRule = clusters.some((c) => c.classification.mode === 'rule');

    // 状态：只映射确定性事实
    let status: SlotPanel['status'];
    let statusText: string;
    let badgeClass = '';
    let badgeText = '';
    let footHtml: string;
    if (clusters.length === 0) {
      status = 'gray';
      statusText = '未开始';
      badgeClass = 'dslw-badge-gray';
      badgeText = '本项目没有这部分';
      footHtml = `<span class="dslw-badge dslw-badge-gray">空槽（如实）</span>`;
    } else if (n.id === 'review') {
      status = 'focus';
      statusText = '进行中';
      badgeClass = 'dslw-badge-dark';
      badgeText = '你正在这里';
      footHtml = `<span class="dslw-badge dslw-badge-dark">你正在这里</span>`;
    } else if (issues.length > 0) {
      status = 'warn';
      statusText = '有问题';
      badgeClass = 'dslw-badge-warn';
      badgeText = `${issues.length}个问题待确认`;
      footHtml = `<span class="dslw-badge dslw-badge-warn">${issues.length}个问题待确认</span>`;
    } else if (hasRule) {
      status = 'info';
      statusText = '待确认';
      badgeClass = 'dslw-badge-info';
      badgeText = '含启发式归类';
      footHtml = `<span class="dslw-badge dslw-badge-info">含启发式归类</span>`;
    } else {
      status = 'ok';
      statusText = '正常';
      footHtml = `<span style="color:var(--dslw-muted-foreground);">${groups.length} 积木 · ${clusters.length} 簇 · ${fileCount} 文件</span>`;
    }

    // 节点 desc：簇人话标题（前 3 个）
    const titles = clusters.map((c) => c.title || narrClusters[c.id]?.title || c.id);
    const desc =
      clusters.length === 0
        ? '本项目没有这部分'
        : titles.slice(0, 3).join(' · ') + (titles.length > 3 ? ` 等${titles.length}簇` : '');

    // 面板内容
    const explainWhy =
      clusters.length === 0
        ? '本项目没有这一层——流水线照样完整运行，这也是信息：说明该项目把这部分职责省略或合并到了别处。'
        : `这一层由 ${groups.length} 块积木的 ${clusters.length} 个功能簇构成：` +
          titles.slice(0, 4).map((t) => `「${t}」`).join('') +
          (titles.length > 4 ? ` 等 ${titles.length} 个。` : '。') +
          `共 ${fileCount} 个源文件在此层协同。`;

    const composeHtml =
      groups.length === 0
        ? `<div class="dslw-issue"><div class="dslw-issue-desc">空槽——本项目的结构里没有归入此槽位的簇。</div></div>`
        : groups
            .map(
              (g) => `<div class="dslw-param">
  <div class="dslw-param-head"><span class="dslw-param-label">${esc(g.brickTitle || g.brick)}</span>
  <span style="font-family:var(--dslw-font-mono);font-size:11px;color:var(--dslw-muted-foreground);">${g.clusters.length} 簇</span></div>
  ${g.clusters
    .map(
      (c) => `<div class="dslw-param-desc" style="margin:4px 0 2px;display:flex;gap:6px;align-items:center;">
    <span style="color:var(--dslw-foreground);">· ${esc(c.title || narrClusters[c.id]?.title || c.id)}</span>
    <span class="dslw-badge dslw-badge-gray" style="font-size:10px;">${c.files} 文件 · 内聚 ${c.cohesion > 1 ? Math.round(c.cohesion) : Math.round(c.cohesion * 100)}%</span>
  </div>
  <div class="dslw-param-desc" style="font-size:11px;color:var(--dslw-muted-foreground);margin:0 0 6px 12px;">${esc(c.desc || narrClusters[c.id]?.desc || c.id)}</div>`,
    )
    .join('')}
</div>`,
            )
            .join('');

    const issuesHtml =
      issues.length === 0
        ? `<div class="dslw-issue"><div class="dslw-issue-desc">此槽位暂无待处理问题。</div></div>`
        : issues
            .map(
              (it) => `<div class="dslw-issue${it.severe ? ' severe' : ''}">
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
</div>`,
            )
            .join('');

    const dataJson = JSON.stringify(
      {
        slot: n.id,
        label: n.label,
        groups: groups.map((g) => ({
          brick: g.brick,
          title: g.brickTitle,
          clusters: g.clusters.map((c) => ({
            id: c.id,
            title: c.title,
            files: c.files,
            cohesion: Math.round(c.cohesion * 100) / 100,
            classified_by: c.classification.mode,
            confidence: c.classification.confidence,
            reason: c.classification.reason,
          })),
        })),
      },
      null,
      2,
    );

    return {
      id: n.id,
      label: n.label,
      icon: n.icon,
      status,
      statusText,
      badgeClass,
      badgeText,
      desc,
      subtitle: lane?.slot.desc ?? '',
      explainWhat: lane?.slot.desc ?? '',
      explainWhy,
      composeCount: clusters.length,
      issueCount: issues.length,
      composeHtml,
      issuesHtml,
      dataJson,
      footHtml,
    };
  });
}

// ─── HTML 生成 ───

export function renderDslWorkbenchHtml(
  result: BrickifyResult,
  anatomy: AnatomyResult,
  narratives: ClusterNarratives,
  projectName: string,
): string {
  const slots = buildSlots(result, anatomy, narratives);
  const ov = narratives.overview;
  const totalIssues = result.mixed_files.length + anatomy.limitations.length;
  const now = new Date();
  const genTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  // 默认选中：问题最多的槽；无问题选中枢 compute
  const defaultSlot =
    slots.reduce((a, b) => (b.issueCount > a.issueCount ? b : a), slots[0]).issueCount > 0
      ? slots.reduce((a, b) => (b.issueCount > a.issueCount ? b : a), slots[0])
      : (slots.find((s) => s.id === 'compute') ?? slots[0]);

  const nodesHtml = SLOT_NODES.map((n) => {
    const p = slots.find((s) => s.id === n.id)!;
    const cls = n.id === defaultSlot.id ? ' selected' : p.status === 'focus' ? ' focus' : '';
    const dotCls =
      p.status === 'focus' ? 'focus-dot' : p.status === 'warn' ? 'warn' : p.status === 'info' ? 'info' : p.status === 'gray' ? 'gray' : 'ok';
    const txtCls = p.status === 'focus' ? 'focus-text' : p.status === 'warn' ? 'warn' : p.status === 'info' ? 'info' : p.status === 'gray' ? 'gray' : 'ok';
    return `<div class="dslw-node${cls}" data-slot="${n.id}" style="top:${n.y}px; left:${n.x}px;${n.w ? ` width:${n.w}px;` : ''}">
  <div class="dslw-node-status">
    <span class="dslw-status-dot ${dotCls}"></span>
    <span class="dslw-status-text ${txtCls}">${esc(p.statusText)}</span>
  </div>
  <div class="dslw-node-title-row">
    <div class="dslw-node-icon"><i data-lucide="${n.icon}"></i></div>
    <div class="dslw-node-name">${esc(n.label)}</div>
  </div>
  <div class="dslw-node-desc">${esc(p.desc)}</div>
  <div class="dslw-node-footer">${p.footHtml}</div>
</div>`;
  }).join('\n');

  const pathsHtml = MOCK_PATHS.map(
    (p) =>
      `<path class="${p.active ? 'active flow-active' : 'flow'}" d="${p.d}" marker-end="url(#${p.active ? 'dslw-arrow-active' : 'dslw-arrow'})"/>`,
  ).join('\n');

  // minimap：真实节点位置（画布 60..960 × 80..460 → 150×100 内缩放）
  const mm = SLOT_NODES.map((n) => {
    const p = slots.find((s) => s.id === n.id)!;
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
    const left = Math.round((n.x / 960) * 138) + 4;
    const top = Math.round(((n.y - 80) / 380) * 80) + 8;
    return `<div class="mm-node" style="top:${top}px; left:${left}px; background:${color};"></div>`;
  }).join('\n');

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
        composeCount: s.composeCount,
        issueCount: s.issueCount,
        composeHtml: s.composeHtml,
        issuesHtml: s.issuesHtml,
        dataJson: s.dataJson,
      },
    ]),
  );

  return `<!DOCTYPE html>
<html lang="zh-CN" class="light" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DSL 协作工作台 · ${esc(projectName)}</title>
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
    ${totalIssues > 0 ? `<span class="dslw-nav-badge-num">${totalIssues}</span>` : ''}
  </a>
  <a class="dslw-nav-item"><i data-lucide="code-2"></i><span>DSL 源码</span></a>
  <a class="dslw-nav-item"><i data-lucide="refresh-cw"></i><span>同步记录</span></a>
  <div class="dslw-nav-divider"></div>
  <div class="dslw-nav-section">当前项目</div>
  <div class="dslw-project-card">
    <div class="dslw-project-name">${esc(ov.title)}（${esc(projectName)}）</div>
    <div class="dslw-project-meta">${result.meta.scanned_files} 文件 · ${result.bricks.length} 积木 · 生成于 ${genTime}</div>
    ${totalIssues > 0 ? `<div class="dslw-project-warn"><i data-lucide="alert-triangle" style="width:12px;height:12px;"></i>待处理问题: ${totalIssues}</div>` : ''}
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
    <a href="#">${esc(projectName)}</a><span class="sep">/</span>
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
  <span class="dslw-slider-hint">数据来源：brickify 聚类 + anatomy 解剖（${anatomy.meta.mode === 'llm' ? `LLM 归类 ${anatomy.meta.llm_ok}/${anatomy.meta.total}` : '启发式归类'}）+ narrate 翻译（LLM ${narratives.meta.llm_ok}/${narratives.meta.total}）</span>
  <div class="dslw-version-info">
    <span>${result.meta.scanned_files} 文件 <span class="dslw-version-arrow">&rarr;</span> ${result.bricks.length} 积木</span>
    <span class="dslw-change-count">${totalIssues} 待处理信号</span>
  </div>
</footer>
</div>
</main>

<script>
const SLOTS = ${jsonForScript(detailJson)};
const DEFAULT_SLOT = '${defaultSlot.id}';
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
