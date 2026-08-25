/**
 * render_tools_map —— 功能中心视图（统一功能注册面的多维地图）
 *
 * 用户定调：功能应该"分级放出来"，且有"很多种方向很多维度"去组织；
 * 功能暴露形态（MCP 独占/CLI 独占/双入口）也是一维。本视图以统一功能条目
 * （MCP 工具 + CLI 命令合并）为卡片，支持四个维度切换：
 *   - 能力域（设计编辑/查询理解/重构治理/观测质检/…8 域）
 *   - 分级（P0 日常高频 / P1 进阶 / P2 专家）
 *   - 解剖槽位（输入→…→人机闭环流水线位置）
 *   - 入口形态（MCP 独占 / CLI 独占 / 双入口）
 * 点击功能 → 悬窗下钻：四维标注 + 完整描述 + **实现簇清单**（确定性 import 连线）
 * → 点簇展开文件清单。功能（人话）→ 实现（代码）的桥就架在这里。
 */

import path from 'node:path';
import fs from 'node:fs';
import type { BrickifyResult } from './brickify.js';
import { roleOfFile } from './brickify.js';
import type { ToolsMapResult, MappedTool } from './classify_tools.js';

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
function jsonForScript(o: unknown): string {
  return JSON.stringify(o).replace(/<\//g, '<\\/');
}

const TIER_BADGE: Record<string, string> = { P0: 'tm-tier-p0', P1: 'tm-tier-p1', P2: 'tm-tier-p2' };
const TIER_TXT: Record<string, string> = { P0: 'P0 日常', P1: 'P1 进阶', P2: 'P2 专家' };
const KIND_BADGE: Record<string, string> = { mcp_only: 'tm-kind-mcp', cli_only: 'tm-kind-cli', both: 'tm-kind-both' };
const KIND_TXT: Record<string, string> = { mcp_only: 'MCP', cli_only: 'CLI', both: 'MCP+CLI' };

interface GroupDef {
  id: string;
  label: string;
  desc: string;
}

function groupsOf(map: ToolsMapResult, dim: 'domain' | 'tier' | 'slot' | 'kind'): GroupDef[] {
  if (dim === 'domain') return map.domains.map((d) => ({ id: d.id, label: d.label, desc: d.desc }));
  if (dim === 'tier')
    return [
      { id: 'P0', label: 'P0 日常高频', desc: '核心工作流每天都碰的能力' },
      { id: 'P1', label: 'P1 进阶', desc: '特定场景才用的能力' },
      { id: 'P2', label: 'P2 专家', desc: '低频专家操作' },
    ];
  if (dim === 'kind')
    return [
      { id: 'both', label: '双入口（MCP + CLI）', desc: 'LLM 会话和终端脚本都能用——主力功能应长这样' },
      { id: 'mcp_only', label: 'MCP 独占', desc: '只在 LLM 会话里暴露，终端不可直达' },
      { id: 'cli_only', label: 'CLI 独占', desc: '只有独立阶段脚本，LLM 会话够不着——集成候选' },
    ];
  // slot：从 taxonomy 取（render 不知道 taxonomy 对象，用 classify 的 slot id 借 label 表）
  const SLOT_LABEL: Record<string, string> = {
    intake: '输入摄取', parse: '解析转换', compute: '核心运算', store: '状态存储',
    render: '呈现输出', observe: '观测质检', review: '人机闭环',
  };
  return Object.entries(SLOT_LABEL).map(([id, label]) => ({ id, label, desc: '' }));
}

function toolCard(t: MappedTool): string {
  const bricks = [...new Set(t.implClusters.map((c) => c.brick))].slice(0, 3);
  return `<div class="tm-card" data-tool="${esc(t.name)}" data-domain="${esc(t.domain)}" data-tier="${t.tier}" data-slot="${esc(t.slot)}" data-kind="${t.kind}">
  <div class="tm-card-head">
    <span class="tm-summary">${esc(t.summary)}</span>
    <span class="tm-tier ${TIER_BADGE[t.tier]}">${TIER_TXT[t.tier]}</span>
  </div>
  <div class="tm-name">${esc(t.name)}</div>
  <div class="tm-card-foot">
    <span class="tm-kind ${KIND_BADGE[t.kind]}">${KIND_TXT[t.kind]}</span>
    <span class="tm-impl">${bricks.length > 0 ? bricks.map((b) => `<span class="tm-brick">${esc(b)}</span>`).join('') : '<span class="tm-brick none">内联</span>'}</span>
  </div>
</div>`;
}

export function renderToolsMapHtml(r: BrickifyResult, map: ToolsMapResult): string {
  const projectName = path.basename(r.meta.project_dir);

  // 四维分组的静态 DOM 都渲染，切维度只切显隐（无重排闪烁）
  const dims: Array<{ key: 'domain' | 'tier' | 'slot' | 'kind'; label: string }> = [
    { key: 'domain', label: '按能力域' },
    { key: 'tier', label: '按分级' },
    { key: 'kind', label: '按入口形态' },
    { key: 'slot', label: '按流水线槽位' },
  ];
  const sections = dims
    .map(({ key }) => {
      const groups = groupsOf(map, key);
      const blocks = groups
        .map((g) => {
          const tools = map.tools.filter((t) =>
            (key === 'domain' ? t.domain : key === 'tier' ? t.tier : key === 'kind' ? t.kind : t.slot) === g.id,
          );
          if (tools.length === 0 && key !== 'domain')
            return `<div class="tm-group" data-dim="${key}" data-g="${esc(g.id)}" style="display:none">
  <div class="tm-group-head"><span class="tm-group-label">${esc(g.label)}</span><span class="tm-count">0</span></div>
  <div class="tm-empty">（无）</div>
</div>`;
          if (tools.length === 0) return '';
          return `<div class="tm-group" data-dim="${key}" data-g="${esc(g.id)}">
  <div class="tm-group-head"><span class="tm-group-label">${esc(g.label)}</span><span class="tm-count">${tools.length}</span>${g.desc ? `<span class="tm-group-desc">${esc(g.desc)}</span>` : ''}</div>
  <div class="tm-cards">${tools.map(toolCard).join('')}</div>
</div>`;
        })
        .join('');
      return `<section class="tm-dim" data-dim="${key}" style="display:none">${blocks}</section>`;
    })
    .join('');

  // 悬窗数据：工具 → 三维 + 描述 + 实现簇 → 文件（下钻链终点）
  const clusterFiles = new Map<string, { brick: string; files: Array<{ path: string; role: string }> }>();
  for (const b of r.bricks)
    for (const s of b.sub_clusters)
      clusterFiles.set(s.id, {
        brick: b.id,
        files: s.files.map((f) => ({ path: f, role: roleOfFile(f) })),
      });

  const detail = map.tools.map((t) => ({
    name: t.name,
    summary: t.summary,
    title: t.title,
    desc: t.description,
    domain: map.domains.find((d) => d.id === t.domain)?.label ?? t.domain,
    tier: TIER_TXT[t.tier],
    slot: { intake: '输入摄取', parse: '解析转换', compute: '核心运算', store: '状态存储', render: '呈现输出', observe: '观测质检', review: '人机闭环' }[t.slot] ?? t.slot,
    kind: KIND_TXT[t.kind],
    confidence: t.confidence,
    mode: t.mode,
    clusters: t.implClusters.map((c) => ({
      id: c.cluster,
      brick: c.brick,
      files: clusterFiles.get(c.cluster)?.files ?? [],
    })),
    unmatched: t.unmatchedModules,
  }));

  const limHtml = map.limitations.map((l) => `- ${esc(l)}`).join('\n');
  const modeTxt = map.meta.mode === 'llm' ? `LLM 标注 ${map.meta.llm_ok}/${map.meta.total}` : '启发式标注（LLM 未启用）';
  const linked = map.tools.filter((t) => t.implClusters.length > 0).length;
  const nBoth = map.tools.filter((t) => t.kind === 'both').length;
  const nMcp = map.tools.filter((t) => t.kind === 'mcp_only').length;
  const nCli = map.tools.filter((t) => t.kind === 'cli_only').length;
  const metaTxt = `${map.meta.total} 个功能（双入口 ${nBoth} · MCP 独占 ${nMcp} · CLI 独占 ${nCli}）· ${linked} 个已连实现 · ${modeTxt}`;

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>功能地图 · ${esc(projectName)}</title>
<style>
:root{--bg:#fafafa;--card:#fff;--border:#e4e4e7;--border-strong:#d4d4d8;--text:#0a0a0a;--muted:#71717a;--brand:#7c3aed;--ok:#16a34a;--info:#2563eb;--warn:#d97706;--radius:.625rem;--radius-sm:.375rem;--shadow-sm:0 1px 3px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04);--shadow:0 4px 6px -1px rgba(0,0,0,.06),0 2px 4px -2px rgba(0,0,0,.04)}
*{box-sizing:border-box}
body{margin:0;font-family:'Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:var(--text);background:var(--bg)}
header{display:flex;align-items:center;gap:14px;padding:12px 18px;background:var(--card);border-bottom:1px solid var(--border);flex-wrap:wrap;position:sticky;top:0;z-index:10}
header h1{font-size:15px;margin:0;font-weight:650}
.meta{font-size:12px;color:var(--muted)}
.tabs{display:flex;gap:6px;margin-left:auto}
.tab{padding:6px 14px;border-radius:18px;border:1px solid var(--border);background:#fff;font-size:12px;font-weight:600;cursor:pointer;transition:all .12s}
.tab:hover{border-color:var(--border-strong)}
.tab.on{background:#111827;color:#fff;border-color:#111827}
main{padding:18px;max-width:1160px;margin:0 auto}
.tm-dim{display:flex;flex-direction:column;gap:14px}
.tm-group{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;box-shadow:var(--shadow-sm)}
.tm-group-head{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.tm-group-label{font-size:14px;font-weight:650}
.tm-count{font-size:11px;background:#f4f4f5;color:var(--muted);padding:2px 9px;border-radius:10px;font-weight:600}
.tm-group-desc{font-size:11px;color:var(--muted)}
.tm-cards{display:flex;flex-wrap:wrap;gap:10px}
.tm-card{width:210px;background:#fff;border:1px solid var(--border-strong);border-radius:var(--radius-sm);padding:10px 12px;cursor:pointer;transition:all .12s}
.tm-card:hover{box-shadow:var(--shadow);border-color:#c9c9ce}
.tm-card.sel{border-color:var(--brand);box-shadow:0 0 0 2px #7c3aed33}
.tm-card-head{display:flex;align-items:flex-start;gap:6px}
.tm-summary{font-size:12.5px;font-weight:600;line-height:1.3}
.tm-tier{flex-shrink:0;font-size:9.5px;padding:2px 7px;border-radius:9px;font-weight:600;line-height:1.2;margin-top:1px}
.tm-tier-p0{background:#f0fdf4;color:#15803d}
.tm-tier-p1{background:#eff6ff;color:#1d4ed8}
.tm-tier-p2{background:#fffbeb;color:#b45309}
.tm-name{font-family:ui-monospace,'Cascadia Code',monospace;font-size:10.5px;color:var(--muted);margin-top:5px}
.tm-impl{display:flex;gap:4px;flex-wrap:wrap;margin-top:6px}
.tm-brick{font-size:9.5px;background:#f4f4f5;color:#3f3f46;padding:2px 7px;border-radius:9px}
.tm-brick.none{background:#fafafa;color:#a1a1aa;font-style:italic}
.tm-empty{font-size:11.5px;color:#a1a1aa;font-style:italic;padding:4px 2px}
.panel{position:fixed;top:0;right:-440px;width:420px;height:100vh;background:#fff;border-left:1px solid var(--border);box-shadow:-8px 0 24px rgba(0,0,0,.08);transition:right .18s ease;z-index:50;display:flex;flex-direction:column}
.panel.open{right:0}
.panel-head{padding:16px 18px 12px;border-bottom:1px solid var(--border)}
.tm-name-big{font-family:ui-monospace,'Cascadia Code',monospace;font-size:11px;color:var(--brand);font-weight:600}
.panel-title{font-size:15px;font-weight:650;margin-top:2px}
.tm-dims-row{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px}
.tm-dim-badge{font-size:10px;padding:2px 8px;border-radius:9px;font-weight:600}
.tm-dim-badge.domain{background:#f5f3ff;color:#6d28d9}
.tm-dim-badge.tier{background:#eff6ff;color:#1d4ed8}
.tm-dim-badge.slot{background:#f0fdf4;color:#15803d}
.tm-dim-badge.kindb{background:#fff7ed;color:#c2410c}
.tm-card-foot{display:flex;align-items:center;gap:5px;margin-top:6px;flex-wrap:wrap}
.tm-kind{font-size:9.5px;padding:2px 7px;border-radius:9px;font-weight:600;flex-shrink:0}
.tm-kind-mcp{background:#eff6ff;color:#1d4ed8}
.tm-kind-cli{background:#fef2f2;color:#b91c1c}
.tm-kind-both{background:#f5f3ff;color:#6d28d9}
.panel-desc{font-size:12px;color:#3f3f46;margin-top:10px;line-height:1.65;max-height:180px;overflow-y:auto}
.panel-conf{font-size:10.5px;color:var(--muted);margin-top:8px}
.panel-body{flex:1;overflow-y:auto;padding:12px 18px}
.impl-title{font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.5px;margin-bottom:8px;text-transform:uppercase}
.cl-group{margin-bottom:10px;border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden}
.cl-head{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#fafafa;cursor:pointer;user-select:none}
.cl-head:hover{background:#f4f4f5}
.cl-title{font-size:12px;font-weight:600;font-family:ui-monospace,monospace}
.cl-meta{margin-left:auto;font-size:10.5px;color:var(--muted);flex-shrink:0}
.cl-files{display:none;border-top:1px solid var(--border)}
.cl-group.open .cl-files{display:block}
.f-row{display:flex;align-items:center;gap:8px;padding:4px 12px;font-size:11.5px}
.f-row:hover{background:#fafafa}
.f-path{font-family:ui-monospace,'Cascadia Code',monospace;font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.f-role{margin-left:auto;flex-shrink:0}
.an-badge{display:inline-flex;padding:2px 8px;border-radius:9px;font-size:9.5px;font-weight:600;line-height:1.4}
.an-badge-ok{background:#f0fdf4;color:#15803d}
.an-badge-info{background:#eff6ff;color:#1d4ed8}
.an-badge-gray{background:#f5f5f5;color:#71717a}
.panel-close{position:absolute;top:10px;right:12px;font-size:17px;color:var(--muted);cursor:pointer;background:none;border:none;line-height:1}
.panel-close:hover{color:var(--text)}
.unmatched{font-size:10.5px;color:#a1a1aa;font-style:italic;margin-top:8px}
footer{padding:14px 18px;border-top:1px solid var(--border);background:var(--card);color:var(--muted);font-size:11px;white-space:pre-wrap;line-height:1.6}
</style>
</head>
<body>
<header>
  <h1>功能地图 · ${esc(projectName)}</h1>
  <span class="meta">${metaTxt}</span>
  <div class="tabs">
    <button class="tab" data-dim="domain">按能力域</button>
    <button class="tab" data-dim="tier">按分级</button>
    <button class="tab" data-dim="kind">按入口形态</button>
    <button class="tab" data-dim="slot">按流水线槽位</button>
  </div>
</header>
<main>${sections}</main>
<aside class="panel" id="panel">
  <button class="panel-close" id="pclose">×</button>
  <div class="panel-head">
    <div class="tm-name-big" id="pname"></div>
    <div class="panel-title" id="ptitle"></div>
    <div class="tm-dims-row" id="pdimrow"></div>
    <div class="panel-desc" id="pdesc"></div>
    <div class="panel-conf" id="pconf"></div>
  </div>
  <div class="panel-body" id="pbody"></div>
</aside>
<footer>limitations
${limHtml}</footer>
<script>
const DETAIL = ${jsonForScript(detail)};
function showDim(key) {
  document.querySelectorAll('.tm-dim').forEach(s => { s.style.display = s.dataset.dim === key ? 'flex' : 'none'; });
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.dim === key));
  document.querySelector('.tm-dim[data-dim="' + key + '"] .tm-group')?.scrollIntoView({ block: 'start' });
}
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => showDim(t.dataset.dim)));
showDim('domain');
document.querySelectorAll('.tm-card').forEach(el => {
  el.addEventListener('click', () => {
    const d = DETAIL.find(x => x.name === el.dataset.tool);
    if (!d) return;
    document.querySelectorAll('.tm-card').forEach(x => x.classList.remove('sel'));
    el.classList.add('sel');
    document.getElementById('pname').textContent = d.name;
    document.getElementById('ptitle').textContent = d.summary;
    document.getElementById('pdimrow').innerHTML =
      '<span class="tm-dim-badge domain">' + d.domain + '</span>' +
      '<span class="tm-dim-badge tier">' + d.tier + '</span>' +
      '<span class="tm-dim-badge slot">' + d.slot + '</span>' +
      '<span class="tm-dim-badge kindb">' + d.kind + '</span>';
    document.getElementById('pdesc').textContent = d.desc || '（无注册描述）';
    document.getElementById('pconf').textContent = (d.mode === 'llm' ? 'LLM 标注 · 置信 ' + Math.round(d.confidence * 100) + '%' : '启发式标注');
    const body = document.getElementById('pbody');
    body.innerHTML =
      '<div class="impl-title">实现体（' + d.clusters.length + ' 簇）</div>' +
      (d.clusters.map(c =>
        '<div class="cl-group">' +
        '<div class="cl-head"><span class="cl-title"></span><span class="cl-meta">' + c.brick + ' · ' + c.files.length + ' 文件</span></div>' +
        '<div class="cl-files">' + c.files.map(f =>
          '<div class="f-row"><span class="f-path"></span>' +
          '<span class="an-badge f-role ' + ({brick:'an-badge-ok',contract:'an-badge-info',glue:'an-badge-gray'}[f.role]||'an-badge-gray') + '">' +
          ({brick:'功能',contract:'契约',glue:'胶水'}[f.role]||f.role) + '</span></div>'
        ).join('') + '</div></div>'
      ).join('') || '<div class="tm-empty">内联实现（无独立模块）</div>') +
      (d.unmatched.length ? '<div class="unmatched">未匹配模块：' + d.unmatched.join(', ') + '</div>' : '');
    body.querySelectorAll('.cl-group').forEach((g, ci) => {
      g.querySelector('.cl-title').textContent = d.clusters[ci].id;
      g.querySelectorAll('.f-path').forEach((p, fi) => { p.textContent = d.clusters[ci].files[fi].path; p.title = d.clusters[ci].files[fi].path; });
      g.querySelector('.cl-head').addEventListener('click', () => g.classList.toggle('open'));
    });
    document.getElementById('panel').classList.add('open');
  });
});
document.getElementById('pclose').addEventListener('click', () => {
  document.getElementById('panel').classList.remove('open');
  document.querySelectorAll('.tm-card').forEach(x => x.classList.remove('sel'));
});
</script>
</body>
</html>`;
}

/** 落盘便捷入口。 */
export function buildToolsMap(opts: {
  result: BrickifyResult;
  map: ToolsMapResult;
  out_file?: string;
}): string {
  const html = renderToolsMapHtml(opts.result, opts.map);
  if (opts.out_file) {
    const abs = path.resolve(opts.out_file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, html, 'utf-8');
  }
  return html;
}
