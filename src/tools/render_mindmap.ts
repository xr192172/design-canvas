/**
 * render_mindmap —— 分层导图渲染（下钻视图，对齐"沙盘节点可下钻"心智模型）
 *
 * 消费 BrickifyResult → 生成自包含 HTML 五层可展开/折叠树：
 *   项目 → 社区 → 积木 → 积木内小簇(第2层) → 文件
 *
 * 每层节点带角色徽标（积木/契约/胶水）+ 内聚度；点 chevron 下钻一层 / 收回；
 * 顶部"全部展开/全部折叠"。自包含（内联 CSS/JS，无外网依赖），浏览器直接打开验收。
 */

import path from 'node:path';
import type { BrickifyResult, Community, BrickSubCluster, BrickifyBrick } from './brickify.js';

/** 渲染树节点（序列化进 <script>，JS 递归展开） */
export interface MNode {
  id: string;
  label: string;
  kind: 'project' | 'community' | 'brick' | 'sub' | 'file';
  role?: 'brick' | 'contract' | 'glue';
  count?: number;
  cohesion?: number; // 百分数 0..100
  degenerate?: boolean;
  note?: string;
  title?: string;
  children: MNode[];
}

const ROLE_CLS: Record<string, string> = { brick: 'r-brick', contract: 'r-contract', glue: 'r-glue' };
const ROLE_TXT: Record<string, string> = { brick: '积木(功能)', contract: '契约', glue: '胶水' };
const KIND_ICON: Record<string, string> = {
  project: '⌂',
  community: '◎',
  brick: '🧱',
  sub: '▤',
  file: '📄',
};

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function jsonForScript(o: unknown): string {
  return JSON.stringify(o).replace(/<\//g, '<\\/');
}

/** 把 BrickifyResult 归纳成五层树（社区 → 积木 → 小簇 → 文件）。 */
export function buildMindMapTree(r: BrickifyResult): MNode {
  const commOfBrick = new Map<string, string>();
  for (const c of r.communities) for (const b of c.bricks) commOfBrick.set(b, c.id);
  const bricksByComm = new Map<string, BrickifyBrick[]>();
  const orphans: BrickifyBrick[] = [];
  for (const b of r.bricks) {
    const cid = b.community;
    if (cid && !bricksByComm.has(cid)) bricksByComm.set(cid, []);
    if (cid) bricksByComm.get(cid)!.push(b);
    else orphans.push(b);
  }

  const brickNode = (b: BrickifyBrick): MNode => {
    const subs: MNode[] = b.sub_clusters.map(
      (s: BrickSubCluster): MNode => ({
        id: s.id,
        label: `${s.files[0] ? basenameOf(s.files[0]) : s.id}#${s.total} 文件`,
        kind: 'sub',
        role: s.role,
        count: s.total,
        cohesion: Math.round(s.cohesion * 100),
        degenerate: s.degenerate,
        note: degenerateNote(s),
        title: `${s.id} · ${ROLE_TXT[s.role]} · 内聚 ${Math.round(s.cohesion * 100)}%`,
        children: s.files.map(
          (f): MNode => ({
            id: f,
            label: basenameOf(f),
            kind: 'file',
            role: roleOf(f, s),
            title: f,
            children: [],
          }),
        ),
      }),
    );
    return {
      id: b.id,
      label: b.id,
      kind: 'brick',
      role: b.role,
      count: b.total,
      note: `${ROLE_TXT[b.role]}主导`,
      title: `${b.id} · ${b.total} 文件 · 主导 ${ROLE_TXT[b.role]}`,
      children: subs,
    };
  };

  const communityChildren: MNode[] = [];
  for (const c of r.communities) {
    const bs = (bricksByComm.get(c.id) ?? []).sort((x, y) => y.total - x.total || (x.id < y.id ? -1 : 1));
    communityChildren.push({
      id: cs(c),
      label: c.id,
      kind: 'community',
      count: c.bricks.length,
      cohesion: Math.round(c.cohesion * 100),
      note: `${c.internal_edges}内/${c.external_edges}界`,
      title: `社区 ${c.id} · ${c.bricks.length} 积木 · 内聚 ${Math.round(c.cohesion * 100)}%`,
      children: bs.map(brickNode),
    });
  }
  if (orphans.length > 0) {
    communityChildren.push({
      id: '__orphan__',
      label: '孤立积木（无依赖边）',
      kind: 'community',
      count: orphans.length,
      note: 'self',
      children: orphans.sort((x, y) => y.total - x.total || (x.id < y.id ? -1 : 1)).map(brickNode),
    });
  }

  return {
    id: '__root__',
    label: path.basename(r.meta.project_dir),
    kind: 'project',
    count: r.meta.scanned_files,
    note: `${r.bricks.length} 积木 · ${r.communities.length} 社区`,
    title: path.basename(r.meta.project_dir),
    children: communityChildren,
  };
}

function basenameOf(rel: string): string {
  return rel.split('/').pop() ?? rel;
}
function cs(c: Community): string {
  return `community:${c.id}`;
}
function degenerateNote(s: BrickSubCluster): string | undefined {
  return s.degenerate && s.files.length > 1 ? '整层耦合' : undefined;
}
/** 文件角色优先取所在小簇主导角色（同文件归属小簇时一致；此处按小簇主导色渲染一致性） */
function roleOf(_f: string, s: BrickSubCluster): 'brick' | 'contract' | 'glue' {
  return s.role;
}

export function renderBrickifyMindMapHtml(r: BrickifyResult): string {
  const root = buildMindMapTree(r);
  const treeJson = jsonForScript(root);
  const limHtml = r.limitations.map((l) => `- ${esc(l)}`).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>分层导图 · ${esc(path.basename(r.meta.project_dir))}</title>
<style>
:root{--bg:#fafafa;--card:#fff;--border:#e4e4e7;--text:#0a0a0a;--muted:#71717a;--guide:#e4e4e7;--ok:#16a34a;--brand:#7c3aed}
*{box-sizing:border-box}
body{margin:0;font-family:'Inter','Geist',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:var(--text);background:var(--bg)}
header{display:flex;align-items:center;gap:12px;padding:12px 18px;background:var(--card);border-bottom:1px solid var(--border);flex-wrap:wrap}
header h1{font-size:15px;margin:0;font-weight:650}
.toolbar{margin-left:auto;display:flex;gap:8px}
.btn{font-size:12px;padding:5px 11px;border:1px solid var(--border);border-radius:8px;background:var(--card);cursor:pointer}
.btn:hover{background:#f4f4f5}
.legend{display:flex;gap:10px;font-size:11px;color:var(--muted);align-items:center}
.badge{display:inline-block;padding:1px 7px;border-radius:9px;font-size:10px;line-height:1.4;font-weight:600;border:1px solid}
.brick{background:#ecfdf5;color:#15803d;border-color:#bbf7d0}
.contract{background:#eff6ff;color:#1d4ed8;border-color:#bfdbfe}
.glue{background:#fff7ed;color:#c2410c;border-color:#fed7aa}
main{padding:18px;max-width:1080px;margin:0 auto}
#tree a{display:block}
ul.tr{margin:0;padding-left:0;list-style:none}
ul.tr>li{padding-left:0}
ul.ch{margin:0;padding-left:22px;list-style:none;border-left:1px solid var(--guide);margin-left:13px;display:none}
li.open>ul.ch{display:block}
.node{display:flex;align-items:center;gap:7px;padding:4px 8px;border-radius:8px;margin:1px 0;cursor:pointer;font-size:13px;background:var(--card);border:1px solid transparent;position:relative}
.node:hover{background:#f4f4f5}
.node>.tog{width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;font-size:9px;color:var(--muted);flex-shrink:0;transition:transform .12s}
li.open>.node>.tog{transform:rotate(90deg)}
.node>.ic{flex-shrink:0;font-size:12px;width:16px;text-align:center}
.node>.nm{font-weight:600}
.node>.cnt{font-size:11px;color:var(--muted)}
.node>.coh{font-size:11px;color:var(--muted)}
.node>.coh.hi{color:var(--ok);font-weight:600}
.node>.note{font-size:11px;color:var(--muted)}
.node>.deg{font-size:10px;color:var(--ok);border:1px solid var(--border);border-radius:8px;padding:0 5px}
.node.file{font-size:12.5px;color:#333}
.node.file .nm{font-weight:500}
footer{margin-top:20px;padding:14px 18px;border-top:1px solid var(--border);background:var(--card);color:var(--muted);font-size:11px;white-space:pre-wrap;line-height:1.6}
</style>
</head>
<body>
<header>
  <h1>分层导图 · 项目 → 社区 → 积木 → 积木内小簇 → 文件</h1>
  <div class="legend">
    <span class="badge brick">功能</span><span class="badge contract">契约</span><span class="badge glue">胶水</span>
  </div>
  <div class="toolbar">
    <button class="btn" id="expandAll">全部展开</button>
    <button class="btn" id="collapseAll">全部折叠</button>
  </div>
</header>
<main>
  <div id="tree"></div>
</main>
<footer>limitations
${limHtml}</footer>
<script>
const root = ${treeJson};
const IC = ${jsonForScript(KIND_ICON)};
const RCLS = ${jsonForScript(ROLE_CLS)};
const RTXT = ${jsonForScript(ROLE_TXT)};
function badge(role){return role?'<span class="badge '+RCLS[role]+'">'+RTXT[role]+'</span>':''; }
function nodeHtml(n){
  const tog = (n.children&&n.children.length)?'<span class="tog">▸</span>':'<span class="tog"></span>';
  const ic = '<span class="ic">'+(IC[n.kind]||'•')+'</span>';
  const name = '<span class="nm"></span>'; // 真正名字由 JS 注入，防 innerHTML 转义歧义
  const cnt = n.count!=null?'<span class="cnt">· '+n.count+(n.kind==='file'?'':' 文件')+'</span>':'';
  const coh = n.cohesion!=null?('<span class="coh'+(n.cohesion===100?' hi':'')+'">· 内聚 '+n.cohesion+'%</span>'):'';
  const note = n.note?'<span class="note">· '+n.note+'</span>':'';
  const deg = n.degenerate?'<span class="deg">整层耦合</span>':'';
  return '<div class="node '+(n.kind==='file'?'file':'')+'" data-exp="0">'+tog+ic+name+cnt+coh+note+deg+badge(n.role)+'</div>';
}
function render(container, n, open){
  const li = document.createElement('li');
  li.className = open?'open':'';
  li.dataset.open = open?'1':'0';
  const div = document.createElement('div');
  div.innerHTML = nodeHtml(n);
  const nm = div.querySelector('.nm');
  nm.textContent = n.label;
  if (n.title) div.querySelector('.node').title = n.title;
  // file 节点无子节点，不参与展开
  const hasKids = n.children && n.children.length;
  const nodeEl = div.querySelector('.node');
  if (hasKids){
    nodeEl.addEventListener('click', function(ev){
      const el = li;
      const was = el.classList.toggle('open');
      el.dataset.open = was?'1':'0';
      ev.stopPropagation();
    });
    nodeEl.style.cursor='pointer';
  } else if (n.kind!=='file'){ nodeEl.style.cursor='default'; }
  li.appendChild(div);
  if (hasKids){
    const ul = document.createElement('ul');
    ul.className = 'ch';
    for (const c of n.children) ul.appendChild(render(ul, c, false));
    li.appendChild(ul);
  }
  container.appendChild(li);
  return li;
}
const tree = document.getElementById('tree');
const rootLi = render(tree, root, true);
function setAll(open){
  const walk=(li)=>{ li.classList.toggle('open', open); li.dataset.open=open?'1':'0'; for(const ul of li.children){ if(ul.tagName==='UL') for(const c of ul.children) walk(c);} };
  walk(rootLi);
}
document.getElementById('expandAll').addEventListener('click',()=>setAll(true));
document.getElementById('collapseAll').addEventListener('click',()=>setAll(false));
</script>
</body>
</html>`;
}