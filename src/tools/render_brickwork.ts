/**
 * render_brickwork —— 沙盘视图渲染（后端数据线路的渲染段）
 *
 * 消费 BrickBag（assemble_bricks 的产物）→ 生成自包含 HTML 沙盘：
 *    - 每块积木 = 一张卡片（按 total 定宽；顶条按主导侧配色）
 *    - 卡片内三侧文件计数 ±（前端蓝/后端橙/通用灰）、重复家族 chip、废弃红标
 *    - 积木间连线：similar 虚线（蓝色，线宽∝score）；call 实线（灰，箭头）
 *    - 交互：悬停高亮关联边；点击卡片 → 详细面板（文件/similar/家族/废弃证据）
 *    - 底部展示 limitations（免责）
 *
 * 自包含：内联 CSS/JS，无外网依赖；可直接浏览器打开，作为可检验的人工验收物。
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildFeatureMap } from './feature_map.js';
import { assembleBrickBagWithCall, type BrickBag, type Brick } from './brick_bag.js';
import { buildBrickify, type BrickifyResult, type Community, type MixedFileSignal } from './brickify.js';

const SIDE_LABEL: Record<string, string> = { frontend: '前端', backend: '后端', shared: '通用' };
const SIDE_COLOR: Record<string, string> = { frontend: '#2563eb', backend: '#d97706', shared: '#6b7280' };

interface RenderEdge {
  a: string;
  b: string;
  kind: 'similar' | 'call';
  width: number;
  label?: string;
  arrow?: boolean;
  meta?: string[];
}

/** 把 brick peers 归并成无向渲染边（similar 优先），供 JS 画线。 */
function toRenderEdges(bag: BrickBag): RenderEdge[] {
  const edgeMap = new Map<string, RenderEdge>();
  const key = (a: string, b: string): string => [a, b].sort().join('\u0001');
  for (const br of bag.bricks) {
    for (const p of br.peers) {
      const k = key(br.id, p.brickId);
      const cur = edgeMap.get(k);
      if (p.kind === 'similar') {
        const sp = p;
        edgeMap.set(k, {
          a: br.id,
          b: p.brickId,
          kind: 'similar',
          width: 1 + Math.round(sp.score * 4),
          label: `${Math.round(sp.score * 100)}%`,
          meta: sp.sharedBasenames.slice(0, 6),
        });
      } else if (p.kind === 'call' && cur?.kind !== 'similar') {
        const cp = p;
        edgeMap.set(k, {
          a: br.id,
          b: p.brickId,
          kind: 'call',
          width: cp.kind === 'call' ? Math.min(1 + Math.round(cp.edges / 3), 5) : 2,
          arrow: cp.direction === 'out',
        });
      }
    }
  }
  return [...edgeMap.values()];
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/** 供 <script> 内嵌的 JSON：不转义为实体（会破坏 JS），只防 `</script>` 提前闭合。 */
function jsonForScript(o: unknown): string {
  return JSON.stringify(o).replace(/<\//g, '<\\/');
}

function brickCard(b: Brick, index: number): string {
  const dom = SIDE_COLOR[b.dominant];
  const sideChips = (['frontend', 'backend', 'shared'] as const)
    .filter((s) => b.files[s].length > 0)
    .map((s) => `<span class="chip" style="background:${SIDE_COLOR[s]}1c;color:${SIDE_COLOR[s]};border-color:${SIDE_COLOR[s]}40">${SIDE_LABEL[s]} ${b.files[s].length}</span>`)
    .join('');
  const families = b.families
    .map((f) => `<span class="chip fam" title="${esc(f.files.join(', '))}">${esc(f.root)} (${f.files.length})</span>`)
    .join('');
  const dep = b.deprecation.deadImportSources > 0
    ? `<span class="chip dep" title="${esc(b.deprecation.deadSources.map((d) => `${d.source}: ${d.files.length} 文件`).join(' · '))}">废弃候选 ${b.deprecation.deadImportSources}</span>`
    : '';
  const width = Math.min(150 + b.total * 2.6, 340);
  return `<div class="brick" data-id="${esc(b.id)}" data-index="${index}" style="width:${width}px">
    <div class="bar" style="background:${dom}"></div>
    <div class="head"><span class="id">${esc(b.id)}</span></div>
    <div class="sub">${b.total} 文件 · 主导 ${SIDE_LABEL[b.dominant]}</div>
    <div class="side-chips">${sideChips || '<span class="chip">无源文件</span>'}</div>
    ${families ? `<div class="fam-row">${families}</div>` : ''}
    ${dep ? `<div class="dep-row">${dep}</div>` : ''}
  </div>`;
}

export function renderBrickworkHtml(bag: BrickBag): string {
  const edges = toRenderEdges(bag);
  const m = bag.meta;
  const cardHtml = bag.bricks.map(brickCard).join('\n');
  const limHtml = bag.limitations.map((l) => `<li>${esc(l)}</li>`).join('');
  const edgeJson = jsonForScript(edges);
  const bricksJson = jsonForScript(
    bag.bricks.map((b) => ({ id: b.id, total: b.total, files: b.files, families: b.families, peers: b.peers, deprecation: b.deprecation })),
  );

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>沙盘视图 · ${esc(path.basename(m.project_dir))}</title>
<style>
:root{
  --bg:#fafafa; --card:#fff; --border:#e4e4e7; --text:#0a0a0a; --muted:#71717a;
  --canvas:#f8f8f8; --grid:#ececee; --ring:#111827;
}
*{box-sizing:border-box}
body{margin:0;font-family:'Inter','Geist',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:var(--text);background:var(--bg)}
header{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:14px 20px;background:var(--card);border-bottom:1px solid var(--border)}
header h1{font-size:16px;margin:0;font-weight:600}
.meta{font-size:12px;color:var(--muted)}
.divider{margin:0 4px}
.legend{margin-left:auto;display:flex;gap:14px;font-size:12px;color:var(--muted)}
.legend-item{display:flex;align-items:center;gap:5px}
.sw{width:18px;height:0;border-top:2px solid}
.sw.similar{border-color:#2563eb;border-top-style:dashed}
.sw.call{border-color:#a1a1aa}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block}
main{position:relative;height:calc(100vh - 116px);overflow:auto;background:var(--canvas);
  background-image:radial-gradient(circle,var(--grid) 1px,transparent 1px);background-size:20px 20px}
#sandbox{position:relative;min-width:1000px;min-height:700px;padding:40px;display:grid;grid-auto-flow:row;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:26px;align-items:start;align-content:start}
svg#lines{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1}
.brick{position:relative;background:var(--card);border:1.5px solid var(--border);border-radius:12px;box-shadow:0 2px 6px rgba(0,0,0,.05);padding:12px 14px;transition:transform .12s,box-shadow .12s;cursor:pointer;z-index:2}
.brick:hover{box-shadow:0 8px 16px rgba(0,0,0,.1)}
.brick.dim{opacity:.25}
.brick.hit{box-shadow:0 0 0 2px var(--ring),0 8px 16px rgba(0,0,0,.12)}
.bar{position:absolute;top:0;left:0;right:0;height:4px;border-radius:12px 12px 0 0}
.head{font-size:14px;font-weight:600;margin-top:4px}
.sub{font-size:11px;color:var(--muted);margin:2px 0 8px}
.side-chips,.fam-row,.dep-row{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:5px}
.chip{font-size:10.5px;padding:2px 7px;border-radius:10px;border:1px solid var(--border);background:#fff;line-height:1}
.chip.fam{background:#f3e8ff;color:#7c3aed;border-color:#d8b4fe}/* 重复实现家族 */
.chip.dep{background:#fef2f2;color:#b91c1c;border-color:#fecaca}/* 废弃候选 */
#detail{position:fixed;top:70px;right:14px;width:340px;max-height:calc(100vh - 100px);overflow:auto;background:var(--card);border:1px solid var(--border);border-radius:12px;box-shadow:0 12px 28px rgba(0,0,0,.14);padding:16px;display:none;z-index:30}
#detail h3{margin:0 0 10px;font-size:15px}
#detail .dl{font-size:12.5px;margin-bottom:14px}
#detail .dt{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:10px 0 4px}
#detail ul{margin:0;padding-left:16px}
#detail li{font-size:12px;line-height:1.5}
#detail .close{float:right;border:none;background:#f4f4f5;border-radius:6px;width:24px;height:24px;cursor:pointer}
footer{height:48px;display:flex;align-items:center;justify-content:space-between;padding:0 20px;border-top:1px solid var(--border);background:var(--card);font-size:12px}
footer ul{margin:0;color:var(--muted);padding-left:0;list-style:none;display:flex;flex-wrap:wrap;gap:6px 18px}
</style>
</head>
<body>
<header>
  <h1>沙盘视图 · ${esc(path.basename(m.project_dir))}</h1>
  <span class="meta">${m.scanned_files} 文件 · ${bag.bricks.length} 块积木 · 语言 ${m.langs.join('/')}</span>
  <span class="divider">·</span>
  <span class="meta" style="max-width:40vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(m.source_root)}">${esc(m.source_root)}</span>
  <div class="legend">
    <span class="legend-item"><span class="sw similar"></span>相似功能(虚线)</span>
    <span class="legend-item"><span class="sw call"></span>跨功能调用(实线)</span>
    <span class="legend-item"><span class="dot" style="background:#7c3aed"></span>重复家族</span>
    <span class="legend-item"><span class="dot" style="background:#b91c1c"></span>废弃候选</span>
  </div>
</header>
<main>
  <div id="sandbox">
    ${cardHtml}
  </div>
  <svg id="lines"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#a1a1aa"/></marker></defs></svg>
</main>
<aside id="detail"><button class="close">×</button><div class="body"></div></aside>
<footer><span>${bag.bricks.length} 块积木 · 相互依赖性可在沙盘上"拼积木"式探索</span><ul>${limHtml}</ul></footer>
<script>
const EDGES=${edgeJson};
const sandbox=document.getElementById('sandbox');
const linesSvg=document.getElementById('lines');
const detail=document.getElementById('detail');
const bricks=[...document.querySelectorAll('.brick')];
const byId=new Map(bricks.map(b=>[b.dataset.id,b]));
window.__BRICKS=${bricksJson};
function center(el){const r=el.getBoundingClientRect(),c=sandbox.getBoundingClientRect();return [r.left+sandbox.scrollLeft-c.left+r.width/2, r.top+sandbox.scrollTop-c.top+r.height/2];}
function draw(){
  linesSvg.replaceChildren();
  const ns='http://www.w3.org/2000/svg';
  const defs=document.createElementNS(ns,'defs');
  const mk=document.createElementNS(ns,'marker');mk.setAttribute('id','arrow');mk.setAttribute('markerWidth','8');mk.setAttribute('markerHeight','8');mk.setAttribute('refX','7');mk.setAttribute('refY','4');mk.setAttribute('orient','auto');
  const p=document.createElementNS(ns,'path');p.setAttribute('d','M0,0 L8,4 L0,8 Z');p.setAttribute('fill','#a1a1aa');mk.appendChild(p);defs.appendChild(mk);linesSvg.appendChild(defs);
  EDGES.forEach(e=>{
    const a=byId.get(e.a),b=byId.get(e.b); if(!a||!b) return;
    const [ax,ay]=center(a),[bx,by]=center(b);
    const mx=ax+(bx-ax)/2;
    const line=document.createElementNS(ns,'path');
    line.setAttribute('d','M'+ax+','+ay+' Q'+mx+','+ay+' '+mx+','+(ay+(by-ay)/2)+' T'+bx+','+by);
    line.setAttribute('stroke',e.kind==='similar'?'#2563eb':'#a1a1aa');
    line.setAttribute('stroke-width',(e.kind==='similar'?e.width:Math.max(1,Math.min(e.width,3))).toString());
    line.setAttribute('stroke-dasharray',e.kind==='similar'?'6 6':'');
    line.setAttribute('fill','none');
    if(e.kind==='call'&&e.arrow) line.setAttribute('marker-end','url(#arrow)');
    line._edge=e;
    linesSvg.appendChild(line);
  });
}
draw();
const lines=[...linesSvg.querySelectorAll('path')];
sandbox.addEventListener('mouseover',e=>{
  const b=e.target.closest('.brick'); if(!b) return;
  const id=b.dataset.id, peers=new Set();
  EDGES.forEach(eg=>{if(eg.a===id){peers.add(eg.a);peers.add(eg.b);}else if(eg.b===id){peers.add(eg.a);peers.add(eg.b);}});
  bricks.forEach(x=>x.classList.toggle('dim',x.dataset.id!==id&&!peers.has(x.dataset.id)));
  lines.forEach(p=>{const eg=p._edge;const match=eg&&(eg.a===id||eg.b===id);
    p.setAttribute('stroke-opacity',match?'1':'.12');
    const w=eg.kind==='similar'?(match?eg.width+2:eg.width):(match?(eg.width||2)+1:(eg.width||2));
    p.setAttribute('stroke-width',String(w));});
});
sandbox.addEventListener('mouseout',e=>{
  const b=e.target.closest('.brick'); if(!b) return;
  bricks.forEach(x=>x.classList.remove('dim'));
  lines.forEach(p=>{const eg=p._edge;if(!eg)return;p.setAttribute('stroke-opacity','1');p.setAttribute('stroke-width',String(eg.kind==='similar'?eg.width:Math.max(1,Math.min(eg.width,3))));});
});
function esc2(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
function renderDetail(id){
  const brick=window.__BRICKS.find(x=>x.id===id); if(!brick){detail.style.display='none';return;}
  const ul=(a)=>a&&a.length?('<ul>'+a.map(x=>'<li>'+esc2(x)+'</li>').join('')+'</ul>'):'<span>无</span>';
  const fam=brick.families.length?('<ul>'+brick.families.map(f=>'<li><b>'+esc2(f.root)+'</b> ('+f.files.length+'): '+esc2(f.files.join(', '))+'</li>').join('')+'</ul>'):'<span>无</span>';
  const sim=brick.peers.filter(p=>p.kind==='similar');
  const simHtml=sim.length?('<ul>'+sim.map(s=>'<li>'+esc2(s.brickId)+' · 相似 '+Math.round(s.score*100)+'% · '+esc2(s.sharedBasenames.join(', '))+'</li>').join('')+'</ul>'):'<span>无</span>';
  const dep=brick.deprecation.deadImportSources?('<ul>'+brick.deprecation.deadSources.map(d=>'<li>'+esc2(d.source)+' ('+d.files.length+' 文件)</li>').join('')+'</ul>'):'<span>无</span>';
  document.querySelector('#detail .body').innerHTML=
    '<h3>'+esc2(brick.id)+' <span style="font-weight:400;font-size:12px;color:var(--muted)">'+brick.total+' 文件</span></h3>'+
    '<div class="dl"><div class="dt">前端</div>'+ul(brick.files.frontend)+
    '<div class="dt">后端</div>'+ul(brick.files.backend)+
    '<div class="dt">通用</div>'+ul(brick.files.shared)+
    '<div class="dt">重复家族</div>'+fam+
    '<div class="dt">相似积木</div>'+simHtml+
    '<div class="dt">废弃证据(死import)</div>'+dep+'</div>';
  detail.style.display='block';
}
bricks.forEach(b=>b.addEventListener('click',()=>{bricks.forEach(x=>x.classList.remove('hit'));b.classList.add('hit');renderDetail(b.dataset.id);}));
document.querySelector('#detail .close').addEventListener('click',()=>{detail.style.display='none';bricks.forEach(x=>x.classList.remove('hit'));});
</script>
</body>
</html>`;
}

/** 便捷入口：scanned feature_map → 组装积木 → 渲染自包含 HTML → 写盘，返回 HTML 路径。 */
export function buildSandboxPreview(opts: { project_dir: string; source_root?: string; out_file?: string }): string {
  const featureMap = buildFeatureMap({ project_dir: opts.project_dir, source_root: opts.source_root });
  const bag = assembleBrickBagWithCall(featureMap);
  const html = renderBrickworkHtml(bag);
  const srcRoot = path.resolve(opts.source_root ?? path.resolve(opts.project_dir));
  const out = path.resolve(opts.out_file ?? path.join(path.dirname(srcRoot), '..', 'docs', 'sandbox_preview.html'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html, 'utf-8');
  return out;
}

// ─────────────────────────────────────────────────────────────
// 可视化协作平台 · 工作台外壳渲染（后端数据线路的对接交付物）
// 消费同一 BrickBag → 渲染"DSL 协作工作台"外壳，取代静态 mock：
//   左导航挂 沙盘视图(默认)/屎山重构/问题清单/版本历史/DSL源码/同步记录
//   中央沙盘 = 可拖拽积木拼搭场（积木=功能，peers=拼接线：相似虚线/调用实线）
//   右侧详情 = 选中积木文件三侧 + 重复家族 + 相似积木 + 废弃证据
//   底部     = 版本↔AI建议 + limitations 免责
// 自包含、无外网依赖；可直接浏览器打开验收。
// ─────────────────────────────────────────────────────────────

/** ②屎山重构页：可重构候选积木清单（废弃证据 + 重复家族） */
function renderRefactorPage(bag: BrickBag): string {
  const rows = bag.bricks
    .filter((b) => b.deprecation.deadImportSources > 0 || b.families.length > 0)
    .map((b) => {
      const dead = b.deprecation.deadImportSources > 0
        ? `<div class="kb"><span class="kt">废弃证据(死import)</span><div class="kc">${b.deprecation.deadSources
            .map((d) => `<span class="tag tag-danger" data-s="${esc(d.source)}">${esc(d.source)} · ${d.files.length}文件</span>`)
            .join('')}</div></div>`
        : '';
      const fam = b.families.length
        ? `<div class="kb"><span class="kt">重复实现家族</span><div class="kc">${b.families
            .map((f) => `<span class="tag tag-fam">${esc(f.root)}(${f.files.length})</span>`)
            .join('')}</div></div>`
        : '';
      return `<div class="rcard" data-id="${esc(b.id)}">
        <div class="rt">${esc(b.id)} <span class="rm">${b.total} 文件</span></div>
        <div class="rw">${esc(SIDE_LABEL[b.dominant])}主导 · ${dead ? `废弃${b.deprecation.deadImportSources}处` : '无废弃'}${fam ? ' · 有重复族' : ''}</div>
        ${dead}${fam}
        <div class="ra"><button class="wbtn wbtn-primary">跳转沙盘选中</button></div>
      </div>`;
    })
    .join('');
  return rows || '<div class="empty">🎉 未见积木携带废弃/重复证据，屎山重构候选为空。</div>';
}

/** ③问题清单页：全积木废弃/相似/重复待办聚合 */
function renderIssuePage(bag: BrickBag): string {
  const issues: string[] = [];
  for (const b of bag.bricks) {
    if (b.deprecation.deadImportSources > 0) {
      issues.push(`<div class="rcard" data-id="${esc(b.id)}"><div class="rt" style="color:#b91c1c">${esc(b.id)} 有 ${b.deprecation.deadImportSources} 处疑似废弃 import<button class="wbtn jmp">定位</button></div><div class="rw">${b.deprecation.deadSources.map((d) => esc(d.source)).join(' · ') || '—'}</div></div>`);
    }
    for (const p of b.peers) {
      if (p.kind === 'similar') {
        issues.push(`<div class="rcard" data-id="${esc(b.id)}"><div class="rt">${esc(b.id)} ↔ ${esc(p.brickId)} 相似 ${Math.round(p.score * 100)}%<button class="wbtn jmp">定位</button></div><div class="rw">共享基名：${p.sharedBasenames.slice(0, 6).map(esc).join(', ')}</div></div>`);
      }
    }
    for (const f of b.families) {
      if (f.files.length >= 3) {
        issues.push(`<div class="rcard" data-id="${esc(b.id)}"><div class="rt">${esc(b.id)} 内 ${esc(f.root)} 重复实现族 ${f.files.length} 份<button class="wbtn jmp">定位</button></div><div class="rw">同一意图多套平行管线，疑似 AI 重复实现</div></div>`);
      }
    }
  }
  return issues.join('') || '<div class="empty">✅ 无异常，积木集合干净。</div>';
}

/** 渲染完整工作台外壳 */
export function renderWorkbenchHtml(bag: BrickBag): string {
  const m = bag.meta;
  const edges = toRenderEdges(bag);
  const projectName = path.basename(m.project_dir);
  const refactorPage = renderRefactorPage(bag);
  const issuePage = renderIssuePage(bag);
  const refactorCount = bag.bricks.filter((b) => b.deprecation.deadImportSources > 0 || b.families.length > 0).length;
  const issueCount = issuePage.length > 0 ? bag.bricks.filter((b) => b.deprecation.deadImportSources > 0 || b.peers.some((p) => p.kind === 'similar') || b.families.some((f) => f.files.length >= 3)).length : 0;
  const limHtml = bag.limitations.map((l) => `<li>${esc(l)}</li>`).join('');
  const bagJson = jsonForScript(bag.bricks);
  const edgesJson = jsonForScript(edges);

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DSL 可视化协作工作台 · ${esc(projectName)}</title>
<style>
:root{
  --wbg:#fafafa;--wfg:#0a0a0a;--wcard:#fff;--wborder:#e4e4e7;--wmuted:#71717a;--wpri:#111827;
  --wcanvas:#f8f8f8;--wgrid:#ececee;--wring:#111827;--wside:#f6f6f7;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;height:100%;overflow:hidden;min-width:1100px;font-family:'Inter','Geist',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:var(--wfg);background:var(--wbg)}
.app{display:grid;grid-template-columns:236px 1fr 348px;grid-template-rows:56px 1fr 52px;height:100vh;width:100vw}
.side{grid-column:1;grid-row:1/4;background:var(--wside);border-right:1px solid var(--wborder);padding:14px 12px;display:flex;flex-direction:column;overflow-y:auto}
.toolbar{grid-column:2/4;grid-row:1;background:var(--wcard);border-bottom:1px solid var(--wborder);display:flex;align-items:center;justify-content:space-between;padding:0 18px;gap:10px}
.canvas{grid-column:2;grid-row:2;position:relative;overflow:hidden;background:var(--wcanvas);background-image:radial-gradient(circle,var(--wgrid) 1px,transparent 1px);background-size:20px 20px}
.panel{grid-column:3;grid-row:1/3;background:var(--wcard);border-left:1px solid var(--wborder);overflow-y:auto;display:flex;flex-direction:column}
.bottom{grid-column:2/4;grid-row:3;background:var(--wcard);border-top:1px solid var(--wborder);display:flex;align-items:center;justify-content:space-between;padding:0 18px;gap:14px;font-size:12px}
/* brand & nav */
.brand{display:flex;align-items:center;gap:10px;padding:4px 8px 16px}
.logo{width:28px;height:28px;background:var(--wpri);color:#fff;border-radius:6px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex-shrink:0}
.bname{font-size:14px;font-weight:600;line-height:1.2}
.bsub{font-size:11px;color:var(--wmuted)}
.navsec{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--wmuted);padding:12px 8px 6px}
.nav{display:flex;align-items:center;gap:10px;height:38px;padding:0 10px;border-radius:6px;font-size:13px;cursor:pointer;transition:background .15s}
.nav:hover{background:#ececee}
.nav.active{background:var(--wpri);color:#fff}
.nav .badge{margin-left:auto;font-size:11px;padding:1px 8px;border-radius:10px;background:#ececee;color:var(--wmuted)}
.nav.active .badge{background:rgba(255,255,255,.2);color:#fff}
.nav .dot{margin-left:auto;width:7px;height:7px;border-radius:50%;background:#dc2626}
.navdiv{margin:8px 4px;height:1px;background:var(--wborder)}
.proj{margin:4px;padding:12px;border:1px solid var(--wborder);border-radius:8px;background:#fff}
.pn{font-size:13px;font-weight:600}
.pm{font-size:11px;color:var(--wmuted);margin-top:6px;line-height:1.5}
.sidebottom{margin-top:auto;padding-top:12px;display:flex;flex-direction:column;gap:10px}
.safemode{display:flex;align-items:flex-start;gap:10px;padding:10px;border-radius:8px;background:#ececee;font-size:11px}
.safetext{flex:1}.safetext b{display:block;font-size:12px}
.toggle{position:relative;width:32px;height:18px;background:#c7c7cb;border-radius:10px;cursor:pointer;flex-shrink:0;margin-top:2px}
.toggle::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;background:#fff;border-radius:50%;transition:transform .2s;box-shadow:0 1px 2px rgba(0,0,0,.2)}
.toggle.on{background:var(--wpri)}.toggle.on::after{transform:translateX(14px)}
.user{display:flex;align-items:center;gap:10px;padding:8px}
.avatar{width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#6b7280,#374151);flex-shrink:0}
/* toolbar */
.crumb{display:flex;align-items:center;gap:6px;font-size:13px}
.crumb .sep{color:var(--wmuted);opacity:.5}.crumb .cur{font-weight:500}
.ctrls{display:flex;align-items:center;gap:8px}
.zoom{display:flex;border:1px solid var(--wborder);border-radius:6px;overflow:hidden}
.zoom button{width:28px;height:28px;border:none;background:#fff;cursor:pointer;font-size:14px}
.zoom .zv{width:44px;display:flex;align-items:center;justify-content:center;font-size:12px;border-left:1px solid var(--wborder);border-right:1px solid var(--wborder);height:28px}
.seg{display:flex;border:1px solid var(--wborder);border-radius:6px;overflow:hidden}
.seg button{background:#fff;border:none;padding:6px 12px;font-size:12px;cursor:pointer;color:var(--wmuted)}
.seg button.active{background:var(--wpri);color:#fff}
.wbtn{display:inline-flex;align-items:center;gap:5px;padding:7px 14px;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;border:1px solid transparent;background:#fff;color:var(--wfg)}
.wbtn:hover{background:#f4f4f5}
.wbtn-primary{background:var(--wpri);color:#fff}.wbtn-primary:hover{background:#1f2937}
.wbtn-ghost{border-color:var(--wborder)}
/* canvas page switch */
.page{position:absolute;inset:0;display:none;overflow-y:auto}
.page.show{display:block}
.placeholder{padding:40px;color:var(--wmuted);font-size:13px}
.placeholder h2{color:var(--wfg);font-size:16px;margin-top:0}
/* sandbox */
svg.lines{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1}
.wnode{position:absolute;background:var(--wcard);border:1.5px solid var(--wborder);border-radius:12px;box-shadow:0 2px 6px rgba(0,0,0,.06);padding:12px 14px;cursor:grab;z-index:2;transition:box-shadow .12s;user-select:none}
.wnode:hover{box-shadow:0 8px 16px rgba(0,0,0,.12)}
.wnode.active{box-shadow:0 0 0 2px var(--wring),0 8px 16px rgba(0,0,0,.14)}
.wnode.dim{opacity:.28}
.wtopbar{position:absolute;top:0;left:0;right:0;height:4px;border-radius:12px 12px 0 0}
.wname{font-size:14px;font-weight:600;margin-top:4px}
.wsub{font-size:11px;color:var(--wmuted);margin:2px 0 8px}
.wchips{display:flex;flex-wrap:wrap;gap:5px}
.wchip{font-size:10.5px;padding:2px 7px;border-radius:10px;border:1px solid var(--wborder);line-height:1;background:#fff}
.edge-label{font-size:9px;fill:#71717a}
/* refactor/issue cards */
.rcard{background:#fff;border:1px solid var(--wborder);border-left:3px solid var(--wpri);border-radius:0 8px 8px 0;padding:12px 14px;margin:14px 18px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.rt{font-size:13px;font-weight:600;margin-bottom:6px;display:flex;align-items:center;gap:8px}
.rm{font-size:11px;color:var(--wmuted);font-weight:400}
.rw{font-size:12px;color:var(--wmuted);margin-bottom:8px}
.kb{margin-bottom:8px}
.kt{font-size:11px;font-weight:600;color:var(--wmuted);margin-bottom:4px}
.kc{display:flex;flex-wrap:wrap;gap:5px}
.tag{font-size:10.5px;padding:2px 8px;border-radius:10px;border:1px solid;line-height:1}
.tag-danger{background:#fef2f2;color:#b91c1c;border-color:#fecaca}
.tag-fam{background:#f3e8ff;color:#7c3aed;border-color:#d8b4fe}
.ra{margin-top:6px}
.jmp{margin-left:auto;padding:3px 10px;font-size:11px}
.empty{padding:40px;text-align:center;color:var(--wmuted)}
/* right panel */
.panel-head{padding:20px 20px 12px;border-bottom:1px solid var(--wborder);flex-shrink:0}
.pbadge{font-size:11px;display:inline-block}
.ptitle{font-size:18px;font-weight:600;margin:6px 0 4px}
.psub{font-size:13px;color:var(--wmuted);line-height:1.5}
.pbody{padding:16px 20px;flex:1}
.psec{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--wmuted);margin:12px 0 6px}
.pfiles{display:flex;flex-direction:column;gap:6px}
.pfiles .chip{font-size:12px;background:#fff;border:1px solid var(--wborder);border-radius:6px;padding:4px 8px;line-height:1.5}
.pty{font-size:11px;font-weight:600;margin:6px 0 2px}
.chip{font-size:11px;padding:2px 8px;border-radius:10px;border:1px solid var(--wborder);background:#fff}
.hint{font-size:11px;color:var(--wmuted);padding:0 20px 12px}
.hips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.chip.fs{background:#eff6ff;color:#1d4ed8;border-color:#bfdbfe}
.chip.bs{background:#fffbeb;color:#b45309;border-color:#fde68a}
.chip.ss{background:#f4f4f5;color:#52525b;border-color:#e4e4e7}
.chip.fam{background:#f3e8ff;color:#7c3aed;border-color:#d8b4fe}
.chip.dep{background:#fef2f2;color:#b91c1c;border-color:#fecaca}
ul.lims{margin:6px 0 0;padding-left:18px;color:var(--wmuted);display:flex;flex-wrap:wrap;gap:4px 18px}
ul.lims li{font-size:11px}
.wb-sum{font-size:11px;color:var(--wmuted)}
</style>
</head>
<body>
<div class="app">
  <!-- 左导航 -->
  <aside class="side">
    <div class="brand"><div class="logo">D</div><div><div class="bname">DSL Workbench</div><div class="bsub">可视化协作平台</div></div></div>
    <div class="navsec">工作台</div>
    <div class="nav active" data-page="sandbox">沙盘视图<span class="badge">当前</span></div>
    <div class="nav" data-page="refactor">屎山重构 <span class="badge">${refactorCount}</span></div>
    <div class="nav" data-page="issues">问题清单 ${issueCount ? '<span class="dot"></span>' : ''}</div>
    <div class="nav" data-page="versions">版本历史</div>
    <div class="nav" data-page="dsl">DSL 源码</div>
    <div class="nav" data-page="sync">同步记录</div>
    <div class="navdiv"></div>
    <div class="navsec">当前项目</div>
    <div class="proj"><div class="pn">${esc(projectName)}</div><div class="pm">${m.scanned_files} 文件 · 语言 ${m.langs.join('/')}<br/>${bag.bricks.length} 块积木 · 管线快照</div></div>
    <div class="sidebottom">
      <div class="safemode"><div class="toggle on"></div><div class="safetext"><b>安全模式</b><span style="color:var(--wmuted)">逐层确认后回写</span></div></div>
      <div class="user"><div class="avatar"></div><div><div style="font-size:12px;font-weight:500">你</div><div style="font-size:11px;color:var(--wmuted)">评审中</div></div></div>
    </div>
  </aside>

  <!-- 顶栏 -->
  <header class="toolbar">
    <div class="crumb"><span>我的项目</span><span class="sep">/</span><span>${esc(projectName)}</span><span class="sep">/</span><span class="cur">沙盘视图</span></div>
    <div class="ctrls">
      <div class="zoom"><button id="zout">−</button><div class="zv" id="zval">100%</div><button id="zin">＋</button></div>
      <div class="seg"><button class="active">全局视图</button><button>详细视图</button></div>
      <button class="wbtn wbtn-ghost">✦ AI 重新生成</button>
      <button class="wbtn wbtn-primary">✓ 定稿同步</button>
    </div>
  </header>

  <!-- 中央画布 -->
  <section class="canvas">
    <div class="page show" id="page-sandbox">
      <svg class="lines"><defs><marker id="warrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#a1a1aa"/></marker></defs></svg>
    </div>
    <div class="page" id="page-refactor"><div class="pbanner" style="padding:14px 18px;font-size:12px;color:var(--wmuted)">屎山重构 · 选中积木 → 对其文件跑确定性重构管线（废弃 import 删除 / 重复族合并）【占位锚点 → refactor_pipeline】</div>${refactorPage}</div>
    <div class="page" id="page-issues"><div class="pbanner" style="padding:14px 18px;font-size:12px;color:var(--wmuted)">问题清单 · 全积木废弃 / 相似 / 重复待办聚合</div>${issuePage}</div>
    <div class="page" id="page-versions"><div class="placeholder"><h2>版本历史</h2>沿用既有 DSL 修订 / 乐观锁 / 定稿审批流（本阶段占位）。</div></div>
    <div class="page" id="page-dsl"><div class="placeholder"><h2>DSL 源码</h2>积木数据源自 feature_map + brick_bag 投影，DSL 源码为判定真源（本阶段占位）。</div></div>
    <div class="page" id="page-sync"><div class="placeholder"><h2>同步记录</h2>沿用既有趣落盘与同步记录（本阶段占位）。</div></div>
  </section>

  <!-- 右侧详情 -->
  <aside class="panel">
    <div class="panel-head">
      <div class="pbadge"><span class="chip ss" id="dstatus">未选中</span></div>
      <div class="ptitle" id="dtitle">点击沙盘上的积木</div>
      <div class="psub" id="dsub">每一块积木 = 一个功能；点它查看前端/后端/通用文件、相似积木、重复家族与废弃证据。</div>
    </div>
    <div id="dbody" class="pbody"></div>
    <div class="hint">提示：积木可拖拽拼搭；拖到另一块旁边就是一次"合并/复用"候选，可进入屎山重构。</div>
  </aside>

  <!-- 底部 -->
  <footer class="bottom">
    <span class="wb-sum">${bag.bricks.length} 块积木 · 相互依赖可在沙盘"拼积木"式探索</span>
    <span style="display:flex;align-items:center;gap:12px;color:var(--wmuted)">当前版本 <b style="color:var(--wfg)">v1</b> → AI 建议 <b style="color:var(--wfg)">v2</b></span>
  </footer>
</div>
<script>
var BAG=${bagJson};
var EDGES=${edgesJson};
var SIDE_COUNT=[['frontend','前端','#2563eb'],['backend','后端','#d97706'],['shared','通用','#6b7280']];
var canvas=document.querySelector('.canvas');
var sandbox=document.getElementById('page-sandbox');
var svg=sandbox.querySelector('svg.lines');
var detailBody=document.getElementById('dbody');
var dtitle=document.getElementById('dtitle');
var dstatus=document.getElementById('dstatus');
var dsub=document.getElementById('dsub');
var nodes=[];
var pos={};
var Z=1.0;
var W0=236;
function nodeW(b){return Math.min(170+b.total*1.6,330);}
function chipColor(s){for(var i=0;i<SIDE_COUNT.length;i++){if(SIDE_COUNT[i][0]===s){return SIDE_COUNT[i];}}return SIDE_COUNT[2];}
function buildNode(b){
  var el=document.createElement('div');el.className='wnode';el.dataset.id=b.id;
  var w=nodeW(b);
  el.style.width=w+'px';el.style.height='110px';
  var sideChips='';for(var i=0;i<SIDE_COUNT.length;i++){var s=SIDE_COUNT[i];var n=b.files[s[0]]?b.files[s[0]].length:0;if(n>0){sideChips+='<span class="chip '+s[0]+'">'+s[1]+' '+n+'</span>';}}
  var fam='';for(var j=0;j<(b.families||[]).length;j++){var f=b.families[j];fam+='<span class="chip fam" title="'+String(f.files.join(' ')).replace(/"/g,'&quot;')+'">'+String(f.root).replace(/"/g,'&quot;')+'('+f.files.length+')</span>';}
  var dep=b.deprecation&&b.deprecation.deadImportSources>0?'<span class="chip dep">废弃 '+b.deprecation.deadImportSources+'</span>':'';
  var dom=chipColor(b.dominant)[2];
  el.innerHTML='<div class="wtopbar" style="background:'+dom+'"></div><div class="wname">'+String(b.id).replace(/[<>&]/g,function(c){return c==='<'?'&lt;':c==='>'?'&gt;':'&amp;';})+'</div><div class="wsub">'+b.total+' 文件 · 主导 '+chipColor(b.dominant)[1]+'</div><div class="wchips">'+sideChips+fam+dep+'</div>';
  el.addEventListener('mousedown',function(e){startDrag(e,b.id);e.preventDefault();});
  el.addEventListener('mouseenter',function(){focus(b.id);});
  return el;
}
var drag=null;
function startDrag(e,id){
  drag={id:id,offX:e.clientX,nx:0,offY:e.clientY,ny:0,sx:e.screenX,sy:e.screenY};
}
window.addEventListener('mousemove',function(e){
  if(!drag)return;
  var x=pos[drag.id].x+(e.clientX-drag.offX)/Z;
  var y=pos[drag.id].y+(e.clientY-drag.offY)/Z;
  drag.nx=e.clientX;drag.ny=e.clientY;
  var el=byId(drag.id);el.style.left=x+'px';el.style.top=y+'px';
});
window.addEventListener('mouseup',function(e){
  if(drag){pos[drag.id].x+=(e.clientX-drag.offX)/Z;pos[drag.id].y+=(e.clientY-drag.offY)/Z;updateCss();drag=null;draw();}
});
var byIdMap={};
function byId(id){return byIdMap[id];}
function layout(){
  var COLS=Math.max(2,Math.floor((canvas.clientWidth-W0-40)/(280)));
  var gx=272,gy=168,pad=46,i=0;
  for(i=0;i<BAG.length;i++){var br=BAG[i];var col=i%COLS,row=Math.floor(i/COLS);pos[br.id]={x:pad+col*gx,y:pad+row*gy};}
}
function updateCss(){for(var k in BAG){var br=BAG[k];var el=byId(br.id);if(el){el.style.left=pos[br.id].x+'px';el.style.top=pos[br.id].y+'px';}}}
function center(id){var el=byId(id);var r=el.getBoundingClientRect();var base=svg.getBoundingClientRect();return [r.left-base.left+r.width/2, r.top-base.top+r.height/2];}
function draw(){
  svg.replaceChildren();
  var ns='http://www.w3.org/2000/svg';
  var defs=document.createElementNS(ns,'defs');
  var mk=document.createElementNS(ns,'marker');mk.setAttribute('id','warrow');mk.setAttribute('markerWidth','8');mk.setAttribute('markerHeight','8');mk.setAttribute('refX','7');mk.setAttribute('refY','4');mk.setAttribute('orient','auto');
  var pp=document.createElementNS(ns,'path');pp.setAttribute('d','M0,0 L8,4 L0,8 Z');pp.setAttribute('fill','#a1a1aa');mk.appendChild(pp);defs.appendChild(mk);svg.appendChild(defs);
  EDGES.forEach(function(e){
    var a=byId(e.a);if(!a)return;if(!byId(e.b))return;
    var c1=center(e.a),c2=center(e.b);
    var mx=c1[0]+(c2[0]-c1[0])/2;
    var line=document.createElementNS(ns,'path');
    var d='M'+c1[0]+','+c1[1]+' Q'+mx+','+c1[1]+' '+mx+','+(c1[1]+(c2[1]-c1[1])/2)+' T'+c2[0]+','+c2[1];
    line.setAttribute('d',d);
    line.setAttribute('fill','none');
    var col=e.kind==='similar'?'#2563eb':'#a1a1aa';
    line.setAttribute('stroke',col);
    line.setAttribute('stroke-width',String(e.kind==='similar'?(1+Math.round((e.width||1)*0.8)):Math.max(1,e.width||1)));
    if(e.kind==='similar'){line.setAttribute('stroke-dasharray','6 6');}
    if(e.kind==='call'&&e.arrow){line.setAttribute('marker-end','url(#warrow)');}
    line.setAttribute('stroke-opacity','1');
    line.setAttribute('data-edge',String(e.kind));
    line._e=e;line.style.pointerEvents='none';
    svg.appendChild(line);
    if(e.kind==='similar'&&e.label){
      var tx=document.createElementNS(ns,'text');tx.setAttribute('x',String((c1[0]+c2[0])/2));tx.setAttribute('y',String((c1[1]+c2[1])/2-4));tx.setAttribute('class','edge-label');tx.textContent=e.label;svg.appendChild(tx);
    }
  });
}
function focus(id){
  var connected=new Set([id]);
  EDGES.forEach(function(e){if(e.a===id)connected.add(e.b);if(e.b===id)connected.add(e.a);});
  nodes.forEach(function(n){n.classList.toggle('active',n.dataset.id===id);n.classList.toggle('dim',!connected.has(n.dataset.id));});
  svg.querySelectorAll('path').forEach(function(p){if(!p._e)return;var mk=p._e.a===id||p._e.b===id;p.setAttribute('stroke-opacity',mk?'1':'.12');});
}
function select(id){
  var br=BAG.find(function(x){return x.id===id;});var dom=chipColor(br.dominant);
  dstatus.textContent=br.dominant==='frontend'?'前端主导':br.dominant==='backend'?'后端主导':'通用主导';
  dstatus.className='chip '+br.dominant;
  dtitle.textContent=br.id;
  dsub.textContent=br.total+' 文件 · 主导 '+dom[1];
  var h='';
  for(var i=0;i<SIDE_COUNT.length;i++){var s=SIDE_COUNT[i];var arr=br.files[s[0]]||[];h+='<div class="pty">'+s[1]+' ('+arr.length+')</div><div class="pfiles">'+arr.map(function(f){return '<span class="chip">'+String(f).replace(/[<>&]/g,function(c){return c==='<'?'&lt;':c==='>'?'&gt;':'&amp;';})+'</span>';}).join('')+(arr.length?'':'<span class="chip">无</span>')+'</div>';}
  var fam=br.families&&br.families.length?'<div class="psec">重复实现家族</div>'+br.families.map(function(f){return '<div class="pty">'+String(f.root).replace(/[<>&]/g,function(c){return c==='<'?'&lt;':c==='>'?'&gt;':'&amp;';})+' ('+f.files.length+')</div><div class="pfiles">'+f.files.map(function(x){return '<span class="chip">'+String(x).replace(/[<>&]/g,function(c){return c==='<'?'&lt;':c==='>'?'&gt;':'&amp;';})+'</span>';}).join('')+'</div>';}).join(''):'<div class="psec">重复实现家族</div><span class="chip">无</span>';
  var sim=br.peers&&br.peers.filter(function(p){return p.kind==='similar';});
  var calls=br.peers&&br.peers.filter(function(p){return p.kind==='call';});
  h+='<div class="psec">相似积木（虚线）</div>'+(sim&&sim.length?sim.map(function(s){return '<span class="chip fam">'+String(s.brickId).replace(/[<>&]/g,function(c){return c==='<'?'&lt;':c==='>'?'&gt;':'&amp;';})+' · '+Math.round(s.score*100)+'%</span>';}).join(''):'<span class="chip">无</span>');
  h+='<div class="psec">调用关系（实线）</div>'+(calls&&calls.length?calls.map(function(c){return '<span class="chip">'+String(c.brickId).replace(/[<>&]/g,function(c){return c==='<'?'&lt;':c==='>'?'&gt;':'&amp;';})+' · '+(c.direction==='out'?'→':'←')+' '+c.edges+'</span>';}).join(''):'<span class="chip">无</span>');
  h+='<div class="psec">废弃证据（死 import）</div>'+(br.deprecation&&br.deprecation.deadImportSources?'<span class="chip dep">'+br.deprecation.deadImportSources+' 处 <br/>'+br.deprecation.deadSources.map(function(d){return String(d.source).replace(/[<>&]/g,function(c){return c==='<'?'&lt;':c==='>'?'&gt;':'&amp;';})+' ×'+d.files.length;}).join(' ; ')+'</span>':'<span class="chip">无</span>');
  detailBody.innerHTML=h;
}
function redraw(){
  layout();buildNodes();draw();fit();
}
function buildNodes(){
  sandbox.querySelectorAll('.wnode').forEach(function(n){n.remove();});
  nodes=[];byIdMap={};
  for(var i=0;i<BAG.length;i++){var el=buildNode(BAG[i]);sandbox.appendChild(el);nodes.push(el);byIdMap[el.dataset.id]=el;el.style.left=pos[el.dataset.id].x+'px';el.style.top=pos[el.dataset.id].y+'px';}
}
function fit(){
  var maxX=0,maxY=0;
  for(var k in pos){maxX=Math.max(maxX,pos[k].x+240);maxY=Math.max(maxY,pos[k].y+120);}
  sandbox.style.minWidth=(maxX+40)+'px';sandbox.style.minHeight=(maxY+40)+'px';
}
document.querySelectorAll('.page').forEach(function(p){
  if(p.querySelector('.jmp')){p.querySelectorAll('.jmp').forEach(function(b){b.addEventListener('click',function(){var id=b.closest('.rcard').dataset.id;showPage('sandbox');setTimeout(function(){if(byIdMap[id]){select(id);byIdMap[id].scrollIntoView({block:'center'});byIdMap[id].classList.add('active');}},30);});});}
});
function showPage(name){
  document.querySelectorAll('.nav').forEach(function(n){n.classList.toggle('active',n.dataset.page===name);});
  document.querySelectorAll('.page').forEach(function(p){p.classList.toggle('show',p.id==='page-'+name);});
}
document.querySelectorAll('.nav').forEach(function(n){n.addEventListener('click',function(){showPage(n.dataset.page);});});
function applyZoom(){
  svg.style.setProperty('width',(canvas.clientWidth*Z)+'px');
  svg.style.setProperty('height',(canvas.clientHeight*Z)+'px');
  sandbox.style.transform='scale('+Z+')';
  sandbox.style.transformOrigin='0 0';
  document.getElementById('zval').textContent=Math.round(Z*100)+'%';
}
document.getElementById('zin').addEventListener('click',function(){Z=Math.min(1.6,Z+0.1);applyZoom();draw();});
document.getElementById('zout').addEventListener('click',function(){Z=Math.max(0.5,Z-0.1);applyZoom();draw();});
sandbox.addEventListener('click',function(e){var n=e.target.closest('.wnode');if(n){select(n.dataset.id);nodes.forEach(function(x){x.classList.toggle('active',x.dataset.id===n.dataset.id);});}});
window.addEventListener('resize',function(){redraw();});
redraw();
</script>
</body>
</html>`;
}

/** 便捷入口：scanned feature_map → BrickBag → 工作台外壳 HTML → 写盘，返回 HTML 路径。 */
export function buildWorkbenchPreview(opts: { project_dir: string; source_root?: string; out_file?: string }): string {
  const featureMap = buildFeatureMap({ project_dir: opts.project_dir, source_root: opts.source_root });
  const bag = assembleBrickBagWithCall(featureMap);
  const html = renderWorkbenchHtml(bag);
  const srcRoot = path.resolve(opts.source_root ?? path.resolve(opts.project_dir));
  const out = path.resolve(opts.out_file ?? path.join(path.dirname(srcRoot), '..', 'docs', 'workbench_preview.html'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html, 'utf-8');
  return out;
}

// ─────────────────────────────────────────────────────────────
// 依赖驱动的积木化 · 功能社区工作台（消费 BrickifyResult）
// 社区 = 积木间依赖边的无向连通分量；每块积木=功能；混合文件 = 解耦候选信号。
// 取代"按目录硬切 + 基名相似"启发式，作为思维导图式运算前的数据地基。
// ─────────────────────────────────────────────────────────────

/** 渲染依赖驱动的功能社区工作台：社区内聚 + 跨社区桥 + 混合文件诊断。自包含单 HTML。 */
export function renderBrickifyWorkbenchHtml(r: BrickifyResult): string {
  const m = r.meta;
  const projectName = path.basename(m.project_dir);

  // 社区卡片（按 size 降序，top 高亮内聚 100% 的自足社区）
  const commCards = r.communities
    .map(
      (c: Community) => `<div class="c-card${c.cohesion >= 1 ? ' self' : ''}">
        <div class="c-head">
          <span class="c-id">${esc(c.id)}</span>
          <span class="c-n">${c.bricks.length} 积木</span>
          <span class="c-coh">内聚 ${Math.round(c.cohesion * 100)}%</span>
        </div>
        <div class="c-bar"><div class="c-fill" style="width:${Math.round(c.cohesion * 100)}%"></div></div>
        <div class="c-edges">内部 ${c.internal_edges} · 边界 ${c.external_edges}</div>
        <div class="c-bricks">${c.bricks.map((b) => `<span class="chip">${esc(b)}</span>`).join('')}</div>
      </div>`,
    )
    .join('');

  // 跨社区桥（两个不同社区之间的调用边 = 高耦合连接点）
  const commOfBrick = new Map<string, string>();
  for (const c of r.communities) for (const b of c.bricks) commOfBrick.set(b, c.id);
  const bridges = r.call_edges.filter((e) => {
    const a = commOfBrick.get(e.from), b = commOfBrick.get(e.to);
    return a && b && a !== b;
  });
  const bridgeHtml =
    bridges.length > 0
      ? r.communities.length > 1
        ? bridges.slice(0, 30).map((e) => `<div class="bridge"><span class="chip">${esc(e.from)}</span> → <span class="chip">${esc(e.to)}</span> <span class="bw">${e.count} 调用</span></div>`).join('')
        : `<div class="empty">单社区工程，无跨社区桥。</div>`
      : `<div class="empty">✅ 社区间无调用边——各社区完全解耦（内聚 100%）。</div>`;

  // 混合文件诊断（一文件多功能 = 解耦候选信号）
  const mixedHtml =
    r.mixed_files.length > 0
      ? r.mixed_files.map((mf: MixedFileSignal) => `<div class="m-file" title="${esc(mf.reason)}">
          <div class="m-path">${esc(mf.file)}</div>
          <div class="m-clusters">${mf.clusters.map((c) => `<span class="chip m-clu">[${c.map(esc).join(' · ')}]</span>`).join('')}</div>
          <div class="m-reason">${esc(mf.reason)}</div>
        </div>`).join('')
      : `<div class="empty">🎉 未发现"一文件多概念簇"的混合文件——干净。</div>`;

  const limHtml = r.limitations.map((l) => `<li>${esc(l)}</li>`).join('');

  // 三层角色（积木/契约/胶水）——用户组织模型
  const rt = m.role_totals;
  const roleBadge = (role: 'brick' | 'contract' | 'glue'): string => {
    const cls = { brick: 'rb-brick', contract: 'rb-contract', glue: 'rb-glue' }[role];
    const label = { brick: '积木(功能)', contract: '契约', glue: '胶水' }[role];
    return `<span class="role-b ${cls}">${esc(label)}</span>`;
  };
  const roleRows = r.bricks
    .map((b) => `<tr>
        <td><b>${esc(b.id)}</b></td>
        <td>${roleBadge(b.role)}</td>
        <td class="role-cnt">功能 ${b.roles.brick.length} · 契约 ${b.roles.contract.length} · 胶水 ${b.roles.glue.length}</td>
        <td class="role-cnt">${b.community ? esc(b.community) : '-'}</td>
      </tr>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>功能社区工作台 · ${esc(projectName)}</title>
<style>
:root{--bg:#fafafa;--card:#fff;--border:#e4e4e7;--text:#0a0a0a;--muted:#71717a;--brand:#7c3aed;--accent:#2563eb;--danger:#b91c1c;--ok:#16a34a}
*{box-sizing:border-box}
body{margin:0;font-family:'Inter','Geist',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:var(--text);background:var(--bg)}
header{display:flex;align-items:center;flex-wrap:wrap;gap:8px 14px;padding:14px 20px;background:var(--card);border-bottom:1px solid var(--border)}
header h1{font-size:16px;margin:0;font-weight:650}
.meta{font-size:12px;color:var(--muted)}
.megacount{margin-left:auto;display:flex;gap:18px;font-size:12px}
.mc b{font-size:16px;display:block}
main{padding:22px;max-width:1200px;margin:0 auto}
section{margin-bottom:26px}
h2{font-size:14px;font-weight:650;margin:0 0 12px;display:flex;align-items:center;gap:8px}
h2 .hint{font-size:11px;color:var(--muted);font-weight:400}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.c-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.c-card.self{border-color:var(--ok);box-shadow:0 0 0 1px var(--ok) inset}
.c-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.c-id{font-weight:650;font-size:13px}
.c-n{font-size:11px;color:var(--muted)}
.c-coh{margin-left:auto;font-size:11px;color:var(--muted)}
.c-bar{height:6px;background:#e4e4e7;border-radius:3px;overflow:hidden;margin-bottom:6px}
.c-fill{height:100%;background:var(--brand)}
.c-card.self .c-fill{background:var(--ok)}
.c-edges{font-size:11px;color:var(--muted);margin-bottom:8px}
.c-bricks{display:flex;flex-wrap:wrap;gap:5px}
.chip{font-size:10.5px;padding:2px 7px;border-radius:10px;border:1px solid var(--border);background:#fff;line-height:1}
.bridges{display:flex;flex-wrap:wrap;gap:8px}
.bridge{font-size:12px;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:6px 10px;display:flex;align-items:center;gap:6px}
.bridge .bw{color:var(--muted);font-size:11px}
.m-file{background:var(--card);border:1px solid var(--danger);border-left:3px solid var(--danger);border-radius:0 8px 8px 0;padding:10px 12px;margin-bottom:10px}
.m-path{font-size:13px;font-weight:600;color:var(--danger)}
.m-clusters{display:flex;flex-wrap:wrap;gap:5px;margin:6px 0}
.m-clu{background:#fef2f2;color:#b91c1c;border-color:#fecaca}
.m-reason{font-size:11px;color:var(--muted)}
.empty{padding:16px;color:var(--muted);background:var(--card);border:1px solid var(--border);border-radius:8px;font-size:12px}
.role-table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.role-table td,.role-table th{font-size:12px;padding:8px 12px;text-align:left;border-bottom:1px solid var(--border)}
.role-table th{background:#f4f4f5;font-weight:600;color:var(--muted)}
.role-table tr:last-child td{border-bottom:none}
.role-b{display:inline-block;padding:2px 9px;border-radius:10px;font-size:10.5px;line-height:1;font-weight:600}
.rb-brick{background:#ecfdf5;color:#15803d;border:1px solid #bbf7d0}
.rb-contract{background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe}
.rb-glue{background:#fff7ed;color:#c2410c;border:1px solid #fed7aa}
.legend{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.lg{font-size:11px;display:flex;align-items:center;gap:6px;color:var(--muted)}
.role-cnt{color:var(--muted);font-size:11px}
footer{padding:16px 22px;border-top:1px solid var(--border);background:var(--card)}
footer ul{margin:0;color:var(--muted);font-size:11px;padding-left:18px;display:flex;flex-wrap:wrap;gap:4px 24px}
</style>
</head>
<body>
<header>
  <h1>功能社区工作台 · ${esc(projectName)}</h1>
  <span class="meta">${m.scanned_files} 文件 → ${r.bricks.length} 块积木 → ${r.communities.length} 个功能社区</span>
  <div class="megacount"><span class="mc"><b>${r.communities.length}</b>社区</span><span class="mc"><b>${r.mixed_files.length}</b>混合文件</span><span class="mc"><b>${bridges.length}</b>跨社区桥</span><span class="mc"><b>${rt.brick}/${rt.contract}/${rt.glue}</b>积木/契约/胶水</span></div>
</header>
<main>
  <section>
    <h2>功能社区（依赖边连通分量，取代"按目录硬切+基名相似"）<span class="hint">积木=功能；社区内聚度 = 内部边/总边</span></h2>
    <div class="grid">${commCards}</div>
  </section>
  <section>
    <h2>三层角色（积木/契约/胶水——用户组织模型）<span class="hint">积木=功能核心 · 契约=类型/接口插头 · 胶水=入口/路由/中间件接线</span></h2>
    <div class="legend">
      <span class="lg">${roleBadge('brick')}业务逻辑/数据/界面——可独立成块</span>
      <span class="lg">${roleBadge('contract')}type/interface/dto/契约——积木外露的插头</span>
      <span class="lg">${roleBadge('glue')}entry/middleware/config/api——把积木接起来的布线</span>
    </div>
    <table class="role-table">
      <tr><th>积木</th><th>主导角色</th><th>角色分布</th><th>所属社区</th></tr>
      ${roleRows}
    </table>
  </section>
  <section>
    <h2>跨社区调用（桥 = 高耦合连接点，思维导图重点）<span class="hint">桥梁通常提示应提升为共享积木</span></h2>
    <div class="bridges">${bridgeHtml}</div>
  </section>
  <section>
    <h2>混合文件诊断（一文件多功能 = 解耦候选）</h2>
    ${mixedHtml}
  </section>
</main>
<footer><ul>${limHtml}</ul></footer>
</body>
</html>`;
}

/** 便捷入口：source → 依赖图 → 混合信号 → 社区 → 工作台 HTML → 写盘，返回 HTML 路径。 */
export async function buildBrickifyPreview(opts: { project_dir: string; source_root?: string; out_file?: string }): Promise<string> {
  const result = await buildBrickify({ project_dir: opts.project_dir, source_root: opts.source_root });
  const html = renderBrickifyWorkbenchHtml(result);
  const srcRoot = path.resolve(opts.source_root ?? path.resolve(opts.project_dir));
  const out = path.resolve(opts.out_file ?? path.join(path.dirname(srcRoot), '..', 'docs', 'brickify_preview.html'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html, 'utf-8');
  return out;
}