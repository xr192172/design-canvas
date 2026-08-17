/**
 * 思维导图画布页（人机共笔的主视图）v2
 *
 * 布局：水平树（经典思维导图：根在左、分支向右展开），紧凑省空间，符合书写直觉。
 *   root → 功能 → 原理分镜步 → （任意层级）用户手写节点
 *
 * 人机共笔三类交互：
 *   1. 新增节点：hover 任意节点点 ⊕（或选中后点工具栏「＋ 新增分支」），inline 输入文字，
 *      写回 DSL.user_nodes（挂 root=新功能构想，挂功能/步骤=补充理解，可嵌套）
 *   2. 批注便签：双击 AI 节点写便签（DSL.annotations，author=human）
 *   3. 折叠：点节点左侧圆点收起/展开分支（会话级）
 *
 * AI 节点（冷色）与用户节点（暖色贴纸感）视觉区分；
 * 保存后 LLM 再生成 teach 分镜时，用户节点与批注都作为【主人批注】材料融入。
 */

import { shell } from './hub_page.js';

export function renderMindmapPage(feature: string): string {
  const safeFeature = feature.replace(/[<>"']/g, '');
  const body = `
  <div class="mm-top">
    <a href="/project/${safeFeature}" class="back">← ${safeFeature}</a>
    <div class="tools">
      <button id="btn-add-branch" title="给选中节点（未选中则给根节点）新增一个分支">＋ 新增分支</button>
      <button id="btn-save" title="把新增节点与便签批注写回项目数据（AI 再生成时会读到）">💾 保存</button>
      <button id="btn-reset" title="重置视图">↺ 复位</button>
      <button id="btn-expand" title="展开全部">⊞ 全展开</button>
      <span id="save-state"></span>
    </div>
  </div>
  <div id="canvas-wrap">
    <svg id="mm" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="gRoot" cx="35%" cy="30%"><stop offset="0%" stop-color="#1e4e86"/><stop offset="100%" stop-color="#0d2140"/></radialGradient>
        <radialGradient id="gFeat" cx="35%" cy="30%"><stop offset="0%" stop-color="#16406b"/><stop offset="100%" stop-color="#0b1e38"/></radialGradient>
        <marker id="arrowDep" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" fill="rgba(251,146,60,.9)"/>
        </marker>
      </defs>
      <g id="vp">
        <g id="edges"></g>
        <g id="deplayer"></g>
        <g id="nodes"></g>
        <g id="notes"></g>
      </g>
    </svg>
  </div>
  <div id="inline-ed" style="display:none;">
    <input id="inline-text" placeholder="输入文字，Enter 确定 · Esc 取消">
  </div>
  <div id="detail" style="display:none;"></div>
  <div id="editor" style="display:none;">
    <div class="ed-title">✏️ 批注 <em id="ed-target"></em></div>
    <textarea id="ed-text" placeholder="写你的理解、纠正、问题……&#10;例如：这一步其实先查缓存；这个功能应该叫配置中心"></textarea>
    <div class="ed-btns"><button id="ed-cancel">取消</button><button id="ed-ok" class="primary">确定</button></div>
  </div>
  <div id="hint">点节点看详情 · 点左侧圆点折叠 · hover 节点点 ⊕ 新增分支 · 双击 AI 节点写批注 / 双击自己的节点改字 · <b style="color:#d8b4fe;">加新功能：根节点写构想 → 保存 → AI 自动定位挂上去（🔮）</b></div>
  <style>
    html, body { height: 100%; overflow: hidden; }
    .wrap { max-width: none; margin: 0; padding: 0; }
    .mm-top { display: flex; align-items: center; justify-content: space-between; padding: 10px 20px; border-bottom: 1px solid rgba(125,211,252,.15); background: rgba(6,11,31,.85); position: relative; z-index: 6; }
    .mm-top .back { font-size: 14px; font-weight: 700; }
    .mm-top .tools { display: flex; gap: 10px; align-items: center; }
    .mm-top button { background: rgba(6,11,31,.7); color: #7dd3fc; font-size: 12.5px; border: 1px solid rgba(125,211,252,.35); border-radius: 8px; padding: 6px 14px; cursor: pointer; }
    .mm-top button:hover:not(:disabled) { background: rgba(125,211,252,.14); }
    .mm-top button:disabled { opacity: .4; cursor: not-allowed; }
    #save-state { font-size: 12px; color: #fbbf24; min-width: 60px; }
    #canvas-wrap { position: absolute; inset: 52px 0 0 0; cursor: grab; }
    #canvas-wrap:active { cursor: grabbing; }
    #mm { width: 100%; height: 100%; display: block; }
    .mnode { cursor: pointer; }
    .mnode .addbtn, .mnode .delbtn { opacity: 0; transition: opacity .12s; }
    .mnode:hover .addbtn, .mnode:hover .delbtn { opacity: 1; }
    .mnode.sel rect, .mnode.sel circle { stroke: #7dd3fc !important; stroke-width: 2.6 !important; filter: drop-shadow(0 0 8px rgba(125,211,252,.5)); }
    .fold { cursor: pointer; }
    .fold:hover { filter: drop-shadow(0 0 6px rgba(125,211,252,.8)); }
    .note { cursor: move; }
    .note:hover rect { stroke: #fbbf24; filter: drop-shadow(0 0 8px rgba(251,191,36,.35)); }
    #inline-ed { position: fixed; z-index: 40; transform: translate(-4px, -50%); }
    #inline-text { width: 190px; background: rgba(251,191,36,.12); color: #fde9c0; border: 1.5px dashed rgba(251,191,36,.75); border-radius: 8px; padding: 7px 10px; font-size: 13px; font-family: inherit; outline: none; }
    #inline-text:focus { border-style: solid; background: rgba(251,191,36,.18); }
    #detail { position: fixed; left: 20px; bottom: 20px; max-width: 520px; background: rgba(6,11,31,.94); border: 1px solid rgba(125,211,252,.3); border-left: 3px solid #7dd3fc; border-radius: 12px; padding: 14px 18px; font-size: 13px; line-height: 1.7; z-index: 20; box-shadow: 0 10px 30px rgba(0,0,0,.5); }
    #detail b { font-size: 14.5px; color: #e8f1ff; }
    #detail .tag { font-size: 11px; color: #7dd3fc; border: 1px solid rgba(125,211,252,.4); border-radius: 10px; padding: 1px 9px; margin-left: 10px; vertical-align: 2px; }
    #detail p { margin-top: 8px; color: #c9dcf5; }
    #detail .mynote { color: #fde9c0; }
    #detail .files { font-size: 11px; color: #7a93b8; font-family: ui-monospace, Consolas, monospace; word-break: break-all; }
    #detail .danger { margin-top: 10px; background: rgba(120,20,40,.35); color: #fda4af; font-size: 12px; border: 1px solid rgba(244,63,94,.4); border-radius: 8px; padding: 5px 12px; cursor: pointer; }
    #editor { position: fixed; inset: 0; background: rgba(2,4,13,.6); backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center; z-index: 50; }
    #editor > div { width: 400px; background: rgba(10,18,42,.98); border: 1px solid rgba(125,211,252,.35); border-radius: 14px; padding: 18px 20px; }
    .ed-title { font-size: 14px; font-weight: 700; color: #e8f1ff; margin-bottom: 10px; }
    .ed-title em { font-style: normal; font-size: 12px; color: #fbbf24; margin-left: 8px; }
    #ed-text { width: 100%; height: 90px; background: rgba(6,11,31,.9); color: #e8f1ff; border: 1px solid rgba(125,211,252,.3); border-radius: 8px; padding: 10px; font-size: 13px; font-family: inherit; resize: vertical; }
    .ed-btns { display: flex; justify-content: flex-end; gap: 10px; margin-top: 12px; }
    .ed-btns button { background: rgba(6,11,31,.8); color: #c9dcf5; font-size: 13px; border: 1px solid rgba(125,211,252,.3); border-radius: 8px; padding: 6px 16px; cursor: pointer; }
    .ed-btns .primary { background: rgba(125,211,252,.18); color: #7dd3fc; font-weight: 700; }
    #hint { position: fixed; right: 20px; bottom: 20px; font-size: 11.5px; color: #7a93b8; opacity: .85; background: rgba(6,11,31,.7); border-radius: 8px; padding: 5px 12px; z-index: 15; max-width: 460px; }
  </style>`;

  const script = `
  var FEATURE = ${JSON.stringify(feature)};
  var OV = null, ANNS = [], UNODES = [], DEPS = [], FOUNDATIONS = [];
  var TREE = null, NODE_BY_ID = {}, SEL = null, DIRTY = false;
  var VIEW = { tx: 0, ty: 0, s: 1 };
  var COLLAPSED = {};   // 会话级折叠状态：id -> true
  var INLINE = null;    // inline 编辑状态：{ parentId, editId, x, y }

  // ── 数据加载 ──
  function applyData(rs0, rs1, rs2){
    OV = rs0;
    ANNS = (rs1.annotations || []).filter(function(a){ return a.author === 'human'; });
    UNODES = rs2.user_nodes || [];
    DEPS = ((OV.mind_map && OV.mind_map.deps) || []).slice();
    FOUNDATIONS = (OV.mind_map && OV.mind_map.foundations) || [];
    // 构想的预判依赖：紫色"预判"弧（区别于真实调用证据的橙色弧）
    ((OV.mind_map && OV.mind_map.proposals) || []).forEach(function(pp){
      (pp.depends_on || []).forEach(function(d){ DEPS.push({ from: pp.title, to: d, weight: 0, _pred: true }); });
    });
    rebuild(); fitView();
    pollSharedDesc();
  }
  function fetchAll(){
    return Promise.all([
      fetch('/api/overview?feature=' + encodeURIComponent(FEATURE)).then(function(r){ return r.json(); }),
      fetch('/api/annotations?feature=' + encodeURIComponent(FEATURE)).then(function(r){ return r.json(); }).catch(function(){ return { annotations: [] }; }),
      fetch('/api/user_nodes?feature=' + encodeURIComponent(FEATURE)).then(function(r){ return r.json(); }).catch(function(){ return { user_nodes: [] }; })
    ]);
  }
  fetchAll().then(function(rs){
    if(!rs[0].success){ document.getElementById('hint').textContent = '加载失败：' + (rs[0].error || ''); return; }
    applyData(rs[0], rs[1], rs[2]);
  });

  // ── 共享能力介绍回填：首次请求触发后台 LLM 生成（页面秒开），这里轮询取结果 ——
  //    详情面板先显示"生成中"，缓存写盘后自动补上，用户无感等待
  var SH_POLL = 0, SH_GAVEUP = false;
  function pollSharedDesc(){
    var SH = (OV && OV.mind_map && OV.mind_map.shared) || [];
    if(!SH.length || SH.every(function(s){ return s.desc; })) return;
    if(SH_POLL >= 20){ SH_GAVEUP = true; refreshOpenShared(); return; } // ~60s 仍无结果：AI 未配置或生成失败
    SH_POLL++;
    setTimeout(function(){
      fetch('/api/overview?feature=' + encodeURIComponent(FEATURE)).then(function(r){ return r.json(); }).then(function(j){
        if(j.success && j.mind_map && j.mind_map.shared){
          j.mind_map.shared.forEach(function(s){
            var n = NODE_BY_ID['sf:' + s.file];
            if(n && s.desc && !n.raw.desc) n.raw.desc = s.desc;
          });
          refreshOpenShared();
          pollSharedDesc();
        }
      }).catch(function(){ pollSharedDesc(); });
    }, 3000);
  }
  function refreshOpenShared(){
    if(SEL && NODE_BY_ID[SEL] && NODE_BY_ID[SEL].kind === 'shared') select(SEL);
  }

  // ── 合成树：AI 树（root→功能→步骤）+ 用户节点（含嵌套、索引漂移按 label 兜底） ──
  function rebuild(){
    var feats = (OV.mind_map && OV.mind_map.root && OV.mind_map.root.children) || [];
    NODE_BY_ID = {};
    var root = { id: 'root', label: OV.title || FEATURE, kind: 'root', children: [] };
    NODE_BY_ID['root'] = root;
    feats.forEach(function(f, i){
      var fn = { id: 'f' + i, label: f.label, kind: 'feature', children: [], raw: f };
      NODE_BY_ID[fn.id] = fn;
      (f.steps || []).forEach(function(s, j){
        var sn = { id: 'f' + i + ':' + j, label: s.title, kind: 'step', children: [], raw: s, owner: f };
        NODE_BY_ID[sn.id] = sn;
        fn.children.push(sn);
      });
      // 关键文件子层：功能内调用热度 top6——下钻一层直达实际功能单元（watch_project_tool 这种）
      (f.children || []).forEach(function(c){
        var cn = { id: c.id, label: c.label, kind: 'file', children: [], raw: c, _host: f };
        NODE_BY_ID[cn.id] = cn;
        fn.children.push(cn);
      });
      root.children.push(fn);
    });
    // 共享能力分支：被多个功能真实调用的"隐形地板"（聚类把它们吸进大功能里不可见，
    // 这里按跨功能调用证据挖出来）。id 用文件路径，跨再生成稳定——批注锚点不漂移。
    var SH = (OV.mind_map && OV.mind_map.shared) || [];
    if(SH.length){
      var shn = { id: 'shared', label: '🧰 共享能力', kind: 'feature', children: [],
        raw: { description: '被多个功能共用的能力文件——项目真正的隐形地板，谁都要踩，但不属于任何一个功能。' } };
      NODE_BY_ID['shared'] = shn;
      SH.forEach(function(s){
        var base = s.file.split('/').pop();
        var sn = { id: 'sf:' + s.file, label: base, kind: 'shared', children: [], raw: s };
        NODE_BY_ID[sn.id] = sn;
        shn.children.push(sn);
      });
      root.children.unshift(shn); // 地板最先铺：共享能力 → 底座功能 → 业务功能
    }
    // 新功能构想分支：主人写在根节点的构想经 AI 定位（挂靠现有功能 / 根下独立）——
    // 🔮 虚线紫框与已实现功能区分；对应的原始 user node 隐藏（被结构化分支替代）
    var PR = (OV.mind_map && OV.mind_map.proposals) || [];
    var ppIds = {};
    PR.forEach(function(pp){
      ppIds[pp.id] = true;
      var pn = { id: 'pp:' + pp.id, label: pp.title, kind: 'proposal', children: [], raw: pp };
      NODE_BY_ID[pn.id] = pn;
      (pp.steps || []).forEach(function(s, j){
        var sn = { id: 'pp:' + pp.id + ':' + j, label: s.title, kind: 'step', children: [], raw: s, owner: pp };
        NODE_BY_ID[sn.id] = sn;
        pn.children.push(sn);
      });
      var host = null;
      if(pp.parent){
        for(var k in NODE_BY_ID){ var t = NODE_BY_ID[k]; if(t.kind === 'feature' && t.label === pp.parent){ host = t; break; } }
      }
      if(host){ host.children.push(pn); delete COLLAPSED[host.id]; } // AI 说它属于这里——展开宿主让主人看见
      else root.children.push(pn);
    });
    // 用户节点：重复扫描挂载（支持嵌套：父节点也是本轮新挂的 user node；
    // 已被 AI 定位成 proposal 分支的根级节点跳过，避免双份显示）
    TREE = root; // 先指向新树：resolveTarget('root') 才能挂到本轮树，而不是上一轮旧树
    var uNodeById = {};
    UNODES.forEach(function(u){ uNodeById[u.id] = { id: u.id, label: u.text, kind: 'user', children: [], raw: u }; });
    var pending = UNODES.filter(function(u){ return !ppIds[u.id]; }), guard = 0;
    while(pending.length && guard++ < 12){
      var rest = [];
      pending.forEach(function(u){
        var t = resolveTarget(u, uNodeById);
        if(t){ t.children.push(uNodeById[u.id]); NODE_BY_ID[u.id] = uNodeById[u.id]; u._anchor = t; }
        else rest.push(u);
      });
      pending = rest;
    }
    pending.forEach(function(u){ root.children.push(uNodeById[u.id]); NODE_BY_ID[u.id] = uNodeById[u.id]; u._anchor = root; }); // 孤儿挂 root，不丢数据
    TREE = root;
    layoutTree(); renderAll();
  }
  function resolveTarget(u, uNodeById){
    if(u.parent_id === 'root') return TREE;
    var n = NODE_BY_ID[u.parent_id] || uNodeById[u.parent_id];
    if(n) return n;
    if(u.parent_label){ // 分镜再生成后 f 索引漂移 → 按挂载时的文字找回
      for(var k in NODE_BY_ID){ if(NODE_BY_ID[k].label === u.parent_label) return NODE_BY_ID[k]; }
    }
    return null;
  }

  // ── 水平树布局（tidy tree：叶子行高累加，父垂直居中于子块） ──
  var LEAF_H = 36, MIN_H = 40, GAP = 14, BRANCH_GAP = 48;
  function nodeLines(n){
    var per = n.kind === 'step' ? 10 : (n.kind === 'root' ? 8 : ((n.kind === 'shared' || n.kind === 'file') ? 16 : 11));
    return wrap(n.label || '', per);
  }
  function nodeH(n){ var ls = nodeLines(n); return Math.max(MIN_H, 22 + ls.length * 15); }
  function nodeW(n){
    var ls = nodeLines(n), maxLen = 0;
    ls.forEach(function(ln){ if(ln.length > maxLen) maxLen = ln.length; });
    var min = n.kind === 'root' ? 120 : (n.kind === 'feature' ? 104 : 88);
    return Math.max(min, maxLen * 12.5 + 28);
  }
  function collapsed(n){ return !!COLLAPSED[n.id] && n.children.length > 0; }
  function visChildren(n){ return collapsed(n) ? [] : n.children; }
  function measure(n){
    var kids = visChildren(n);
    if(!kids.length){ n._h = nodeH(n); return n._h; }
    var sum = 0;
    kids.forEach(function(c){ sum += measure(c); });
    n._h = Math.max(nodeH(n), sum + GAP * (kids.length - 1));
    return n._h;
  }
  function place(n, xLeft, yTop){
    n._w = nodeW(n); n._x = xLeft + n._w / 2;
    var kids = visChildren(n);
    if(!kids.length){ n._y = yTop + nodeH(n) / 2; n._h = nodeH(n); return; }
    var cy = yTop, childH = 0;
    kids.forEach(function(c){ place(c, xLeft + n._w + BRANCH_GAP, cy); cy += c._h + GAP; childH += c._h + GAP; });
    childH -= GAP;
    var blockTop = yTop, blockH = childH;
    n._y = blockTop + blockH / 2;
  }
  function layoutTree(){ measure(TREE); place(TREE, 0, 0); }

  // ── 渲染 ──
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function wrap(s, n){
    s = String(s||''); var out = [];
    while(s.length > n && out.length < 4){ out.push(s.slice(0,n)); s = s.slice(n); }
    if(out.length < 4) out.push(s);
    return out;
  }
  function cssId(s){ return String(s).replace(/[^a-zA-Z0-9_-]/g,'_'); }
  function renderAll(){
    var E = document.getElementById('edges'), N = document.getElementById('nodes'), G = document.getElementById('notes');
    E.innerHTML = ''; N.innerHTML = ''; G.innerHTML = '';
    var edges = '', nodes = '';
    (function walk(n, parent){
      if(parent){
        var x1 = parent._x + parent._w / 2, y1 = parent._y, x2 = n._x - n._w / 2, y2 = n._y;
        var mx = (x1 + x2) / 2;
        edges += '<path d="M '+x1+' '+y1+' C '+mx+' '+y1+', '+mx+' '+y2+', '+x2+' '+y2+'" fill="none" stroke="'+(n.kind==='user' ? 'rgba(251,191,36,.5)' : '#2d4a78')+'" stroke-width="'+(n.kind==='feature'?2.6:(n.kind==='user'?1.6:1.8))+'"/>';
      }
      nodes += renderNode(n);
      visChildren(n).forEach(function(c){ walk(c, n); });
    })(TREE, null);
    E.innerHTML = edges; N.innerHTML = nodes;
    renderDeps();
    // 便签：锚定目标节点右侧偏下堆叠（有 pos 用 pos）
    var perTarget = {};
    ANNS.forEach(function(a){ (perTarget[a.target_id] = perTarget[a.target_id] || []).push(a); });
    Object.keys(perTarget).forEach(function(tid){
      var t = NODE_BY_ID[tid]; if(!t) return;
      perTarget[tid].forEach(function(a, k){
        if(a.pos){ a._x = a.pos.x; a._y = a.pos.y; }
        else {
          var ls = wrap(a.text, 12);
          a._x = t._x + t._w / 2 + 30;
          a._y = t._y + 24 + k * (28 + ls.length * 15);
        }
        var ls2 = wrap(a.text, 12), w = 160, h = 24 + ls2.length * 15;
        var g = document.createElementNS('http://www.w3.org/2000/svg','g');
        g.setAttribute('class','note'); g.setAttribute('data-id', a.id);
        g.setAttribute('transform','translate('+a._x+','+a._y+')');
        g.innerHTML = '<rect x="0" y="'+(-h/2)+'" width="'+w+'" height="'+h+'" rx="7" fill="rgba(251,191,36,.13)" stroke="rgba(251,191,36,.7)" stroke-width="1.6"/>'
          + '<text x="'+(w/2)+'" y="'+(-h/2+15)+'" text-anchor="middle" font-size="10" fill="#fbbf24">✍️ 批注</text>'
          + ls2.map(function(ln, li){
              return '<text x="'+(w/2)+'" y="'+(-h/2+32+li*15)+'" text-anchor="middle" font-size="11" fill="#fde9c0">'+esc(ln)+'</text>';
            }).join('');
        G.appendChild(g);
        edges += '';
        E.innerHTML += '<line class="nline-'+cssId(a.id)+'" x1="'+a._x+'" y1="'+a._y+'" x2="'+(t._x + t._w/2)+'" y2="'+t._y+'" stroke="rgba(251,191,36,.45)" stroke-width="1.3" stroke-dasharray="5 4"/>';
      });
    });
    bindNodeEvents();
  }
  // ── 依赖叠加层：树管归属、线管依赖（正交关系不挤一棵树）──
  // 功能间真实调用（DEPS）画为橙色虚线弧，从依赖方左缘绕过根节点外侧连到底座；粗细=调用频次
  function featureByLabel(lb){
    // 构想分支可能挂在某个功能下（非 root 直属），全树查找；真实功能仍从 root 直属取
    var top = (TREE.children || []).filter(function(c){ return c.kind === 'feature' && c.label === lb; })[0];
    if(top) return top;
    for(var k in NODE_BY_ID){ var n = NODE_BY_ID[k]; if((n.kind === 'proposal') && n.label === lb) return n; }
    return null;
  }
  function renderDeps(){
    var G = document.getElementById('deplayer');
    G.innerHTML = '';
    if(!DEPS.length || !TREE) return;
    // 贝塞尔取点（t∈[0,1]）：标签沿弧分布，避免堆在同一位置
    function bezPoint(x1,y1,cx,y1c,x2,y2,t){
      var mt = 1 - t;
      return {
        x: mt*mt*mt*x1 + 3*mt*mt*t*cx + 3*mt*t*t*cx + t*t*t*x2,
        y: mt*mt*mt*y1 + 3*mt*mt*t*y1c + 3*mt*t*t*y2 + t*t*t*y2
      };
    }
    // 标签碰撞规避：已放标签占用区，新标签在候选 t 序列中找不冲突位置
    var placedPts = [];
    function noClash(p){
      for(var k = 0; k < placedPts.length; k++){
        if(Math.abs(placedPts[k].x - p.x) < 46 && Math.abs(placedPts[k].y - p.y) < 15) return false;
      }
      return true;
    }
    DEPS.forEach(function(d, idx){
      var a = featureByLabel(d.from), b = featureByLabel(d.to);
      if(!a || !b || a === b) return;
      var x1 = a._x - a._w / 2 - 24, y1 = a._y;
      var x2 = b._x - b._w / 2 - 24, y2 = b._y;
      // 扇形错开：每条弧的控制点逐条左移，弧线不互相叠压
      var cx = TREE._x - TREE._w / 2 - 74 - (idx % 5) * 26;
      var sw = d._pred ? 1.6 : Math.min(1.3 + d.weight / 12, 3.6);
      var path = document.createElementNS('http://www.w3.org/2000/svg','path');
      path.setAttribute('d','M '+x1+' '+y1+' C '+cx+' '+y1+', '+cx+' '+y2+', '+x2+' '+y2);
      path.setAttribute('fill','none');
      path.setAttribute('stroke', d._pred ? 'rgba(192,132,252,.55)' : 'rgba(251,146,60,.6)');
      path.setAttribute('stroke-width', sw);
      path.setAttribute('stroke-dasharray','7 5');
      path.setAttribute('marker-end','url(#arrowDep)');
      path.setAttribute('data-dep', d.from + '→' + d.to);
      path.style.cursor = 'pointer';
      path.addEventListener('click', function(ev){ ev.stopPropagation(); showDep(d); });
      G.appendChild(path);
      // 透明宽 hit-area：弧线细难点中，复制一条 14px 宽透明路径捕获点击
      var hit = path.cloneNode();
      hit.setAttribute('stroke-width', '14');
      hit.setAttribute('stroke', 'transparent');
      hit.setAttribute('stroke-dasharray', 'none');
      hit.removeAttribute('marker-end');
      hit.addEventListener('click', function(ev){ ev.stopPropagation(); showDep(d); });
      G.appendChild(hit);
      // 频次小标签：候选 t 序列找不冲突位置（弧上全冲突则垂直强制偏移），保证互不压盖
      var cands = [0.3 + (idx % 3) * 0.14, 0.5, 0.42, 0.58, 0.36, 0.64, 0.24];
      var pt = null;
      for (var ci = 0; ci < cands.length; ci++) {
        var p = bezPoint(x1, y1, cx, y1, x2, y2, cands[ci]);
        if (noClash(p)) { pt = p; break; }
      }
      if (!pt) {
        pt = bezPoint(x1, y1, cx, y1, x2, y2, 0.3);
        pt = { x: pt.x, y: pt.y - 16 * (1 + Math.floor(placedPts.length / 4)) };
      }
      placedPts.push(pt);
      var t = document.createElementNS('http://www.w3.org/2000/svg','text');
      t.setAttribute('x', pt.x); t.setAttribute('y', pt.y - 6);
      t.setAttribute('text-anchor','middle'); t.setAttribute('font-size','9.5');
      t.setAttribute('fill', d._pred ? 'rgba(192,132,252,.95)' : 'rgba(251,146,60,.9)');
      t.setAttribute('paint-order','stroke'); t.setAttribute('stroke','#02040d'); t.setAttribute('stroke-width','3');
      t.textContent = d._pred ? '预判' : '×' + d.weight;
      G.appendChild(t);
    });
  }
  function showDep(d){
    var det = document.getElementById('detail');
    if(d._pred){
      det.innerHTML = '<b style="color:#c084fc;">🔮 预判依赖</b>'
        + '<p>' + esc(d.from) + ' <b style="color:#c084fc;">可能踩着</b> ' + esc(d.to) + '</p>'
        + '<p style="font-size:11px;color:#7a93b8;">构想尚未实现，这是 AI 按现有结构预判的依赖（紫色弧）；真实调用证据画橙色弧。</p>';
      det.style.display = 'block';
      return;
    }
    var via = (d.via_files && d.via_files.length)
      ? '<p class="files">主要打向：' + d.via_files.map(esc).join(' · ') + '</p>' : '';
    det.innerHTML = '<b style="color:#fb923c;">🔗 功能依赖</b>'
      + '<p>' + esc(d.from) + ' <b style="color:#fb923c;">踩着</b> ' + esc(d.to) + '（真实调用 ×' + d.weight + ' 次）</p>'
      + via
      + '<p style="font-size:11px;color:#7a93b8;">依赖不占树的层级（归属归归属、依赖归依赖），橙色虚线单独表达"什么撑着什么"。</p>';
    det.style.display = 'block';
  }
  function renderNode(n){
    var ls = nodeLines(n), w = n._w, h = nodeH(n), x = n._x - w/2, y = n._y - h/2;
    var s = '<g class="mnode'+(SEL===n.id?' sel':'')+'" data-id="'+esc(n.id)+'" transform="translate('+n._x+','+n._y+')">';
    if(n.kind === 'root'){
      s += '<rect x="'+(-w/2)+'" y="'+(-h/2)+'" width="'+w+'" height="'+h+'" rx="'+(h/2)+'" fill="url(#gRoot)" stroke="#8ab6e8" stroke-width="2.4"/>';
    } else if(n.kind === 'feature'){
      s += '<rect x="'+(-w/2)+'" y="'+(-h/2)+'" width="'+w+'" height="'+h+'" rx="13" fill="url(#gFeat)" stroke="#5ba3d9" stroke-width="2"/>';
      if(FOUNDATIONS.indexOf(n.label) >= 0){ // 底座徽章：基建不占兄弟名目，但一眼可见
        s += '<g transform="translate('+(-w/2+2)+','+(-h/2-9)+')">'
          + '<rect x="0" y="-10" width="62" height="18" rx="9" fill="rgba(251,146,60,.16)" stroke="rgba(251,146,60,.85)" stroke-width="1.2"/>'
          + '<text x="31" y="3" text-anchor="middle" font-size="10" font-weight="700" fill="#fb923c">🧱 底座</text></g>';
      }
    } else if(n.kind === 'step'){
      s += '<rect x="'+(-w/2)+'" y="'+(-h/2)+'" width="'+w+'" height="'+h+'" rx="'+(h/2)+'" fill="rgba(16,42,70,.92)" stroke="#3d7ab5" stroke-width="1.4"/>';
    } else if(n.kind === 'shared'){
      s += '<rect x="'+(-w/2)+'" y="'+(-h/2)+'" width="'+w+'" height="'+h+'" rx="'+(h/2)+'" fill="rgba(13,60,68,.9)" stroke="#2dd4bf" stroke-width="1.6"/>'
        + '<text y="'+(-h/2+13)+'" text-anchor="middle" font-size="8.5" fill="#5eead4">🔧 共享</text>';
    } else if(n.kind === 'file'){
      // 关键文件：功能内调用热度 top 的实际功能单元，小号青蓝、左上 📄 标
      s += '<rect x="'+(-w/2)+'" y="'+(-h/2)+'" width="'+w+'" height="'+h+'" rx="8" fill="rgba(15,38,63,.9)" stroke="#4c9fd8" stroke-width="1.3"/>'
        + '<text y="'+(-h/2+11)+'" text-anchor="middle" font-size="8" fill="#8ec8ef">📄 文件</text>';
    } else if(n.kind === 'proposal'){
      // 新功能构想：紫虚线（尚不存在，是主人想加的）；AI 定位挂靠现有功能或根下独立
      s += '<rect x="'+(-w/2)+'" y="'+(-h/2)+'" width="'+w+'" height="'+h+'" rx="13" fill="rgba(88,28,135,.28)" stroke="rgba(192,132,252,.9)" stroke-width="2" stroke-dasharray="8 5"/>'
        + '<g transform="translate('+(-w/2+2)+','+(-h/2-9)+')">'
        + '<rect x="0" y="-10" width="56" height="18" rx="9" fill="rgba(192,132,252,.16)" stroke="rgba(192,132,252,.85)" stroke-width="1.2"/>'
        + '<text x="28" y="3" text-anchor="middle" font-size="10" font-weight="700" fill="#d8b4fe">🔮 构想</text></g>';
    } else { // user：暖色贴纸感（虚线边框 + 折角）
      s += '<rect x="'+(-w/2)+'" y="'+(-h/2)+'" width="'+w+'" height="'+h+'" rx="9" fill="rgba(251,191,36,.10)" stroke="rgba(251,191,36,.75)" stroke-width="1.6" stroke-dasharray="7 4"/>';
    }
    // 文字
    var fs = n.kind === 'root' ? 14 : ((n.kind === 'feature' || n.kind === 'proposal') ? 13 : 12);
    var fw = (n.kind === 'root' || n.kind === 'feature' || n.kind === 'proposal') ? ' font-weight="700"' : '';
    var fillc = n.kind === 'user' ? '#fde9c0' : (n.kind === 'proposal' ? '#e9d5ff' : '#e8f1ff');
    s += ls.map(function(ln, li){
      return '<text y="'+(5 + (li-(ls.length-1)/2)*15)+'" text-anchor="middle" font-size="'+fs+'"'+fw+' fill="'+fillc+'">'+esc(ln)+'</text>';
    }).join('');
    // 折叠指示：左侧小圆点（有子节点才显示）
    if(n.children.length){
      var isC = collapsed(n);
      s += '<g class="fold" data-fold="'+esc(n.id)+'" transform="translate('+(-w/2-11)+',0)">'
        + '<circle r="'+(isC?7:5.5)+'" fill="'+(isC?'#7dd3fc':'#26456f')+'" stroke="#7dd3fc" stroke-width="1.4"/>'
        + (isC ? '<text y="3.5" text-anchor="middle" font-size="9" font-weight="700" fill="#0b1e38">'+n.children.length+'</text>' : '')
        + '</g>';
    }
    // hover ⊕ 新增（所有节点）
    s += '<g class="addbtn" data-add="'+esc(n.id)+'" transform="translate('+(w/2-4)+','+(h/2+2)+')">'
      + '<circle r="9" fill="rgba(125,211,252,.2)" stroke="#7dd3fc" stroke-width="1.3"/>'
      + '<text y="3.5" text-anchor="middle" font-size="11" font-weight="700" fill="#7dd3fc">＋</text></g>';
    // user 节点 ✕ 删除
    if(n.kind === 'user'){
      s += '<g class="delbtn" data-del="'+esc(n.id)+'" transform="translate('+(w/2+2)+','+(-h/2-2)+')">'
        + '<circle r="8" fill="rgba(120,20,40,.5)" stroke="rgba(244,63,94,.7)" stroke-width="1.2"/>'
        + '<text y="3" text-anchor="middle" font-size="9.5" fill="#fda4af">✕</text></g>';
    }
    return s + '</g>';
  }

  // ── 事件绑定 ──
  function bindNodeEvents(){
    document.querySelectorAll('.mnode').forEach(function(el){
      el.addEventListener('click', function(ev){ ev.stopPropagation(); select(el.getAttribute('data-id')); });
      el.addEventListener('dblclick', function(ev){
        ev.stopPropagation();
        var id = el.getAttribute('data-id'), n = NODE_BY_ID[id];
        if(n && n.kind === 'user') openInline(id, n.label);   // 双击自己的节点 = 改字
        else openEditor(id);                                   // 双击 AI 节点 = 批注
      });
    });
    document.querySelectorAll('.fold').forEach(function(el){
      el.addEventListener('click', function(ev){ ev.stopPropagation(); toggleFold(el.getAttribute('data-fold')); });
    });
    document.querySelectorAll('[data-add]').forEach(function(el){
      el.addEventListener('click', function(ev){ ev.stopPropagation(); openInline(el.getAttribute('data-add'), ''); });
    });
    document.querySelectorAll('[data-del]').forEach(function(el){
      el.addEventListener('click', function(ev){ ev.stopPropagation(); delUserNode(el.getAttribute('data-del')); });
    });
    document.querySelectorAll('.note').forEach(function(el){
      el.addEventListener('click', function(ev){ ev.stopPropagation(); showNote(el.getAttribute('data-id')); });
    });
  }
  function toggleFold(id){ if(COLLAPSED[id]) delete COLLAPSED[id]; else COLLAPSED[id] = true; layoutTree(); renderAll(); }
  function delUserNode(id){
    var doomed = {};
    (function mark(i){ doomed[i] = true; (NODE_BY_ID[i] ? NODE_BY_ID[i].children : []).forEach(mark); })(id);
    UNODES = UNODES.filter(function(u){ return !doomed[u.id]; });
    DIRTY = true; document.getElementById('detail').style.display = 'none';
    rebuild();
  }

  // ── inline 编辑（新增/改字） ──
  function openInline(parentId, initial){
    var p = NODE_BY_ID[parentId]; if(!p) return;
    var wx = p._x + p._w / 2 + 16, wy = p._y;
    if(initial !== ''){ var n = NODE_BY_ID[parentId]; wx = n._x - 30; wy = n._y; }
    INLINE = { parentId: parentId, editId: initial !== '' ? parentId : null };
    var box = document.getElementById('inline-ed'), inp = document.getElementById('inline-text');
    box.style.left = (wx * VIEW.s + VIEW.tx) + 'px';
    box.style.top = (wy * VIEW.s + VIEW.ty + 52) + 'px';
    box.style.display = 'block';
    inp.value = initial; inp.focus(); inp.select();
  }
  function closeInline(){ document.getElementById('inline-ed').style.display = 'none'; INLINE = null; }
  document.getElementById('inline-text').addEventListener('keydown', function(ev){
    if(ev.key === 'Enter'){
      var txt = this.value.trim();
      if(txt && INLINE){
        if(INLINE.editId){ // 改字
          var u = UNODES.filter(function(x){ return x.id === INLINE.editId; })[0];
          if(u){ u.text = txt; DIRTY = true; }
        } else { // 新增
          var p = NODE_BY_ID[INLINE.parentId];
          UNODES.push({ id: 'u_' + Date.now(), parent_id: INLINE.parentId, parent_label: p ? p.label : '', text: txt });
          DIRTY = true;
          delete COLLAPSED[INLINE.parentId];
        }
        rebuild();
      }
      closeInline();
    } else if(ev.key === 'Escape') closeInline();
  });
  document.getElementById('btn-add-branch').onclick = function(){
    var target = (SEL && NODE_BY_ID[SEL]) ? SEL : 'root';
    openInline(target, '');
  };

  // ── 选中 / 详情 ──
  function select(id){
    SEL = id;
    document.querySelectorAll('.mnode').forEach(function(x){ x.classList.remove('sel'); });
    var el = document.querySelector('.mnode[data-id="'+cssId(id)+'"]');
    if(el) el.classList.add('sel');
    var n = NODE_BY_ID[id], det = document.getElementById('detail');
    if(!n){ det.style.display = 'none'; return; }
    var notes = ANNS.filter(function(a){ return a.target_id === id; });
    var myNoteHtml = notes.length ? '<p class="mynote">✍️ 我的批注：'+notes.map(function(x){ return esc(x.text); }).join(' ／ ')+'</p>' : '';
    if(n.kind === 'feature'){
      // 依赖叠加层信息：谁踩着它（被依赖）/ 它踩着谁（依赖别人）
      var stoodOnBy = DEPS.filter(function(d){ return d.to === n.label; });
      var standsOn = DEPS.filter(function(d){ return d.from === n.label; });
      var isF = FOUNDATIONS.indexOf(n.label) >= 0;
      var depHtml = '';
      if(stoodOnBy.length){
        depHtml += '<p style="color:#fcd9a8;">🧱 谁踩着它：'
          + stoodOnBy.map(function(d){
              var top1 = (d.via_files && d.via_files[0]) ? '，主要打向 ' + esc(d.via_files[0]) : '';
              return esc(d.from)+'（×'+d.weight+'）'+top1;
            }).join('；')
          + (isF ? ' —— 这就是底座：自己几乎不叫别人，别人都来叫它。' : '') + '</p>';
      }
      if(standsOn.length){
        depHtml += '<p style="color:#fcd9a8;">🧱 它踩着谁：' + standsOn.map(function(d){ return esc(d.to)+'（×'+d.weight+'）'; }).join('、') + '</p>';
      }
      det.innerHTML = '<b>'+esc(n.label)+'</b><span class="tag">'+(isF ? '底座功能' : '功能')+'</span><p>'+esc(n.raw.description||'')+'</p>'+depHtml+myNoteHtml;
    } else if(n.kind === 'step'){
      det.innerHTML = '<b>'+esc(n.owner.label)+' › '+esc(n.label)+'</b><span class="tag">原理步</span><p>'+esc(n.raw.detail||'')+'</p>'
        + (n.raw.involves && n.raw.involves.length ? '<p class="files">'+n.raw.involves.map(esc).join(' · ')+'</p>' : '') + myNoteHtml;
    } else if(n.kind === 'file'){
      det.innerHTML = '<b style="color:#8ec8ef;">📄 ' + esc(n.label) + '</b><span class="tag">关键文件</span>'
        + '<p>' + esc(n.raw.description || '（暂无职责描述）') + '</p>'
        + (n._host ? '<p class="files">属于功能：' + esc(n._host.label) + '</p>' : '')
        + (n.raw.meta && n.raw.meta.lines ? '<p class="files">' + n.raw.meta.lines + ' 行</p>' : '')
        + '<p style="font-size:11px;color:#7a93b8;">功能内调用热度最高的实际功能单元——功能的原理分镜最终落到这些文件上执行。</p>'
        + myNoteHtml;
    } else if(n.kind === 'proposal'){
      var pp = n.raw;
      var parentHtml = pp.parent
        ? '<p style="color:#e9d5ff;">AI 判断它属于「' + esc(pp.parent) + '」的子能力，已挂到该功能下。</p>'
        : '<p style="color:#e9d5ff;">AI 判断它是独立新功能，挂在根节点下。</p>';
      var depP = (pp.depends_on && pp.depends_on.length)
        ? '<p style="color:#d8b4fe;">🔮 预判要踩：' + pp.depends_on.map(esc).join('、') + '（紫色虚线弧）</p>' : '';
      var stepsHtml = (pp.steps && pp.steps.length)
        ? '<p style="margin-top:6px;"><b style="color:#c084fc;">实现分镜（AI 预判）：</b></p>' + pp.steps.map(function(s, i){
            return '<p>' + (i+1) + '. <b>' + esc(s.title) + '</b> — ' + esc(s.detail) + '</p>';
          }).join('')
        : '';
      det.innerHTML = '<b style="color:#d8b4fe;">🔮 ' + esc(pp.title) + '</b><span class="tag">' + (pp.mode === 'llm' ? '构想 · AI 已定位' : '构想') + '</span>'
        + '<p style="color:#bae6fd;">' + esc(pp.desc) + '</p>'
        + parentHtml + depP + stepsHtml
        + '<p style="font-size:11px;color:#7a93b8;">你的原话：「' + esc(pp.raw) + '」——改原话：删除这个构想节点重写；要细化：给它加子节点后保存。</p>'
        + myNoteHtml;
    } else if(n.kind === 'shared'){
      var ub = n.raw.used_by || [];
      det.innerHTML = '<b style="color:#2dd4bf;">🔧 ' + esc(n.label) + '</b><span class="tag">共享能力</span>'
        + '<p class="files">' + esc(n.raw.file) + '</p>'
        + (n.raw.desc
            ? '<p style="color:#bae6fd;">' + esc(n.raw.desc) + '</p>'
            : (SH_GAVEUP
                ? '<p style="font-size:11px;color:#7a93b8;">介绍暂不可用（AI 未配置或生成失败），调用证据不受影响。</p>'
                : '<p style="color:#fbbf24;">⏳ AI 正在写介绍，生成后这里自动补上…</p>'))
        + '<p style="color:#99f6e4;">谁在用它：' + ub.map(function(u){ return esc(u.feature) + '（×' + u.count + '）'; }).join('、') + '</p>'
        + '<p style="font-size:11px;color:#7a93b8;">被多个功能真实调用的隐形地板——聚类会把它吸进某个大功能里，这里是按调用证据挖出来的。</p>'
        + myNoteHtml;
    } else if(n.kind === 'user'){
      det.innerHTML = '<b style="color:#fbbf24;">✍️ 我写的节点</b><span class="tag">'+esc(n._anchor ? n._anchor.label : '')+'</span><p>'+esc(n.label)+'</p>'
        + '<p style="font-size:11px;color:#7a93b8;">双击可修改文字；保存后 AI 再生成时会作为你的理解读入。</p>';
    } else { det.style.display = 'none'; return; }
    det.style.display = 'block';
  }
  function showNote(id){
    var a = ANNS.filter(function(x){ return x.id === id; })[0];
    if(!a) return;
    var t = NODE_BY_ID[a.target_id];
    var det = document.getElementById('detail');
    det.innerHTML = '<b style="color:#fbbf24;">✍️ 我的批注</b>'
      + '<span class="tag">'+(t ? esc(t.label) : esc(a.target_id))+'</span>'
      + '<p>'+esc(a.text)+'</p>'
      + '<button class="danger" onclick="window.__delNote(\\''+a.id+'\\')">🗑 删除这条批注</button>';
    det.style.display = 'block';
  }
  window.__delNote = function(id){
    ANNS = ANNS.filter(function(x){ return x.id !== id; });
    DIRTY = true; rebuild();
    document.getElementById('detail').style.display = 'none';
  };

  // ── 批注弹窗（双击 AI 节点） ──
  var ED_TARGET = null;
  function openEditor(targetId){
    if(!targetId || targetId === 'root' || !NODE_BY_ID[targetId]) return;
    ED_TARGET = targetId;
    document.getElementById('ed-target').textContent = '→ ' + (NODE_BY_ID[targetId].label || targetId);
    document.getElementById('ed-text').value = '';
    document.getElementById('editor').style.display = 'flex';
    document.getElementById('ed-text').focus();
  }
  document.getElementById('ed-cancel').onclick = function(){ document.getElementById('editor').style.display = 'none'; };
  document.getElementById('ed-ok').onclick = function(){
    var txt = document.getElementById('ed-text').value.trim();
    if(!txt || !ED_TARGET) { document.getElementById('editor').style.display = 'none'; return; }
    ANNS.push({ id: 'note_' + Date.now(), target_id: ED_TARGET, text: txt, author: 'human' });
    DIRTY = true; rebuild();
    document.getElementById('editor').style.display = 'none';
  };

  // ── 保存：批注 + 用户节点 写回 DSL ──
  function updateSaveState(){
    var el = document.getElementById('save-state');
    el.textContent = DIRTY ? '● 有未保存的修改' : '';
  }
  document.getElementById('btn-save').onclick = function(){
    var notesPayload = ANNS.map(function(a){ return { id: a.id, target_id: a.target_id, text: a.text, pos: { x: Math.round(a._x||0), y: Math.round(a._y||0) } }; });
    var nodePayload = UNODES.map(function(u){
      var t = NODE_BY_ID[u.id] && NODE_BY_ID[u.id]._anchor;
      return { id: u.id, parent_id: u.parent_id, parent_label: t ? t.label : (u.parent_label || ''), text: u.text };
    });
    var btn = this; btn.disabled = true; btn.textContent = '保存中…';
    Promise.all([
      fetch('/api/annotations', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature: FEATURE, notes: notesPayload }) }).then(function(r){ return r.json(); }),
      fetch('/api/user_nodes', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature: FEATURE, nodes: nodePayload }) }).then(function(r){ return r.json(); })
    ]).then(function(rs){
      if(rs[0].success && rs[1].success){
        DIRTY = false; updateSaveState();
        // 根级节点 = 新功能构想：保存后自动让 AI 定位融入（人出意图、LLM 出结构）
        var rootIdeas = nodePayload.filter(function(u){ return u.parent_id === 'root'; });
        if(rootIdeas.length > 0) mergeProposals(btn, rootIdeas.length);
        else { btn.disabled = false; btn.textContent = '💾 保存'; flash('已保存：'+nodePayload.length+' 个我的节点 + '+notesPayload.length+' 条批注（AI 再生成时将读到）'); }
      } else {
        btn.disabled = false; btn.textContent = '💾 保存';
        flash('保存失败：' + ((rs[0].error||'') + ' ' + (rs[1].error||'')).trim());
      }
    }).catch(function(e){ btn.disabled = false; btn.textContent = '💾 保存'; flash('保存失败：' + e.message); });
  };
  // AI 定位构想：POST /api/proposals → 重载页面数据（构想分支自动出现在 AI 判断的位置）
  function mergeProposals(btn, count){
    btn.disabled = true; btn.textContent = '🤖 AI 定位构想中…';
    fetch('/api/proposals', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feature: FEATURE }) })
      .then(function(r){ return r.json(); })
      .then(function(j){
        btn.disabled = false; btn.textContent = '💾 保存';
        if(j.success){
          fetchAll().then(function(rs){
            if(rs[0].success) applyData(rs[0], rs[1], rs[2]);
          });
          flash('AI 已定位 ' + (j.proposals || []).length + ' 个构想' + (j.mode === 'llm' ? '（智能挂靠，见 🔮 分支）' : '（LLM 不可用，直挂根节点）'));
        } else flash('定位失败：' + (j.error || ''));
      })
      .catch(function(e){ btn.disabled = false; btn.textContent = '💾 保存'; flash('定位失败：' + e.message); });
  };
  function flash(msg){
    var el = document.getElementById('save-state');
    el.textContent = msg;
    setTimeout(updateSaveState, 3600);
  }

  // ── 视图：平移 / 缩放 / 自适应 / 便签拖动 ──
  var svg = document.getElementById('mm'), vp = document.getElementById('vp');
  function applyView(){ vp.setAttribute('transform','translate('+VIEW.tx+','+VIEW.ty+') scale('+VIEW.s+')'); }
  function treeBounds(){
    var b = { minX: 1e9, minY: 1e9, maxX: -1e9, maxY: -1e9 };
    (function walk(n){
      if(n._x - n._w/2 < b.minX) b.minX = n._x - n._w/2;
      if(n._y - 30 < b.minY) b.minY = n._y - 30;
      if(n._x + n._w/2 + 60 > b.maxX) b.maxX = n._x + n._w/2 + 60;
      if(n._y + 30 > b.maxY) b.maxY = n._y + 30;
      visChildren(n).forEach(walk);
    })(TREE);
    return b;
  }
  function fitView(){
    if(!TREE) return;
    var b = treeBounds();
    if(DEPS.length) b.minX -= 110 + Math.min(DEPS.length, 5) * 26; // 依赖弧扇形绕根左侧，视口为其留位
    var w = window.innerWidth, h = window.innerHeight - 52;
    var pad = 40;
    var s = Math.min((w - pad*2) / (b.maxX - b.minX), (h - pad*2) / (b.maxY - b.minY), 1.15);
    VIEW = { s: s, tx: pad - b.minX * s + (w - pad*2 - (b.maxX - b.minX) * s) / 2, ty: 52 + (h - (b.maxY - b.minY) * s) / 2 - b.minY * s };
    svg.setAttribute('viewBox','0 0 '+w+' '+h);
    applyView();
  }
  document.getElementById('btn-reset').onclick = fitView;
  document.getElementById('btn-expand').onclick = function(){ COLLAPSED = {}; layoutTree(); renderAll(); fitView(); };
  svg.addEventListener('wheel', function(ev){
    ev.preventDefault();
    var k = ev.deltaY < 0 ? 1.12 : 0.89;
    var ns = Math.min(2.6, Math.max(0.2, VIEW.s * k));
    var mx = ev.offsetX, my = ev.offsetY;
    VIEW.tx = mx - (mx - VIEW.tx) * (ns / VIEW.s);
    VIEW.ty = my - (my - VIEW.ty) * (ns / VIEW.s);
    VIEW.s = ns; applyView();
  }, { passive: false });
  var pan = null, dragNote = null;
  svg.addEventListener('mousedown', function(ev){
    var noteEl = ev.target.closest && ev.target.closest('.note');
    if(noteEl){ dragNote = { el: noteEl, id: noteEl.getAttribute('data-id'), ox: ev.clientX, oy: ev.clientY }; return; }
    pan = { ox: ev.clientX, oy: ev.clientY, tx: VIEW.tx, ty: VIEW.ty, moved: false };
  });
  window.addEventListener('mousemove', function(ev){
    if(pan){
      var dx = ev.clientX - pan.ox, dy = ev.clientY - pan.oy;
      if(Math.abs(dx) + Math.abs(dy) > 4) pan.moved = true;
      VIEW.tx = pan.tx + dx; VIEW.ty = pan.ty + dy; applyView();
    } else if(dragNote){
      var a = ANNS.filter(function(x){ return x.id === dragNote.id; })[0];
      if(a){
        a._x += (ev.clientX - dragNote.ox) / VIEW.s;
        a._y += (ev.clientY - dragNote.oy) / VIEW.s;
        dragNote.el.setAttribute('transform','translate('+a._x+','+a._y+')');
        var line = document.querySelector('.nline-' + cssId(a.id));
        if(line){ line.setAttribute('x1', a._x); line.setAttribute('y1', a._y); }
        dragNote.ox = ev.clientX; dragNote.oy = ev.clientY;
        DIRTY = true;
      }
    }
  });
  window.addEventListener('mouseup', function(){
    if(pan && !pan.moved){ SEL = null;
      document.querySelectorAll('.mnode').forEach(function(x){ x.classList.remove('sel'); });
      document.getElementById('detail').style.display = 'none'; }
    if(dragNote) updateSaveState();
    pan = null; dragNote = null;
  });
  `;

  return shell(`${safeFeature} · 思维导图`, body, script);
}
