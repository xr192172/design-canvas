/**
 * 思维导图画布页（人机共笔的主视图）
 *
 * 结构（放射状，像上学时记的知识点）：
 *   中心 = 项目；一级环 = 功能圆；径向鱼骨 = 实现原理分镜步；
 *   外围 = 人工批注便签（暖色，与 AI 冷色节点区分），锚定到功能/步骤。
 *
 * 交互：拖拽平移 / 滚轮缩放 / 点节点看详情 / 给选中节点写便签 /
 *       便签拖动 / 删除 / 保存（写入 DSL.annotations，author=human）。
 * 保存后 LLM 再生成 teach 分镜时会把批注作为【主人批注】材料融入（第一层反推）。
 */

import { shell } from './hub_page.js';

export function renderMindmapPage(feature: string): string {
  const safeFeature = feature.replace(/[<>"']/g, '');
  const body = `
  <div class="mm-top">
    <a href="/project/${safeFeature}" class="back">← ${safeFeature}</a>
    <div class="tools">
      <button id="btn-add" disabled title="先点选一个功能或步骤，再添加批注">＋ 批注选中项</button>
      <button id="btn-save" title="把便签批注写回项目数据（AI 再生成时会读到）">💾 保存批注</button>
      <button id="btn-reset" title="重置视图">↺ 复位</button>
      <span id="save-state"></span>
    </div>
  </div>
  <div id="canvas-wrap">
    <svg id="mm" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="gRoot" cx="35%" cy="30%"><stop offset="0%" stop-color="#1e4e86"/><stop offset="100%" stop-color="#0d2140"/></radialGradient>
        <radialGradient id="gFeat" cx="35%" cy="30%"><stop offset="0%" stop-color="#16406b"/><stop offset="100%" stop-color="#0b1e38"/></radialGradient>
      </defs>
      <g id="vp">
        <g id="edges"></g>
        <g id="nodes"></g>
        <g id="notes"></g>
      </g>
    </svg>
  </div>
  <div id="detail" style="display:none;"></div>
  <div id="editor" style="display:none;">
    <div class="ed-title">✏️ 批注 <em id="ed-target"></em></div>
    <textarea id="ed-text" placeholder="写你的理解、纠正、问题……&#10;例如：这一步其实先查缓存；这个功能应该叫配置中心"></textarea>
    <div class="ed-btns"><button id="ed-cancel">取消</button><button id="ed-ok" class="primary">确定</button></div>
  </div>
  <div id="hint">拖拽平移 · 滚轮缩放 · 点节点看详情 · 双击节点写批注</div>`;

  const script = `
  var FEATURE = ${JSON.stringify(feature)};
  var OV = null, ANNS = [], LAYOUT = {}, SEL = null, DIRTY = false;
  var VIEW = { tx: 0, ty: 0, s: 1 };
  var CW = 1600, CH = 1100, CX = CW/2, CY = CH/2, R1 = 205, FR = 42;

  // ── 数据加载 ──
  Promise.all([
    fetch('/api/overview?feature=' + encodeURIComponent(FEATURE)).then(function(r){ return r.json(); }),
    fetch('/api/annotations?feature=' + encodeURIComponent(FEATURE)).then(function(r){ return r.json(); }).catch(function(){ return { annotations: [] }; })
  ]).then(function(rs){
    if(!rs[0].success){ document.getElementById('hint').textContent = '加载失败：' + (rs[0].error || ''); return; }
    OV = rs[0];
    ANNS = (rs[1].annotations || []).filter(function(a){ return a.author === 'human'; });
    computeLayout(); renderAll(); fitView();
  });

  // ── 布局：中心项目 → 功能环 → 径向鱼骨步 → 便签偏移 ──
  function computeLayout(){
    var feats = (OV.mind_map && OV.mind_map.root && OV.mind_map.root.children) || [];
    LAYOUT['root'] = { x: CX, y: CY, r: 54, label: OV.title || FEATURE };
    feats.forEach(function(f, i){
      var th = -Math.PI/2 + i * 2*Math.PI/Math.max(feats.length,1);
      var fx = CX + R1*Math.cos(th), fy = CY + R1*Math.sin(th);
      LAYOUT[f.id] = { x: fx, y: fy, r: FR, th: th, label: f.label, node: f, kind: 'feature' };
      (f.steps || []).forEach(function(s, j){
        var d = FR + 30 + j*54;
        LAYOUT[f.id + ':' + j] = { x: fx + d*Math.cos(th), y: fy + d*Math.sin(th), th: th, label: s.title, node: s, kind: 'step', owner: f };
      });
    });
    // 便签：有 pos 用 pos；无 pos 沿目标径向外侧 + 垂直偏移依次排开
    var perTarget = {};
    ANNS.forEach(function(a){ (perTarget[a.target_id] = perTarget[a.target_id] || []).push(a); });
    Object.keys(perTarget).forEach(function(tid){
      var list = perTarget[tid], t = LAYOUT[tid];
      if(!t) return;
      var th = t.th !== undefined ? t.th : 0;
      var px = -Math.sin(th), py = Math.cos(th); // 垂直方向
      var base = t.r ? t.r + 26 : 18;
      list.forEach(function(a, k){
        if(a.pos) { a._x = a.pos.x; a._y = a.pos.y; return; }
        var out = base + k*96;
        a._x = t.x + out*px + 60*px*0; // 垂直侧向排
        a._y = t.y + out*py;
        if(k % 2 === 1){ a._x += 54*Math.cos(th); a._y += 54*Math.sin(th); } // 隔张往径向错开
      });
    });
  }

  // ── 渲染 ──
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function wrap(s, n){
    s = String(s||''); var out = [];
    while(s.length > n && out.length < 6){ out.push(s.slice(0,n)); s = s.slice(n); }
    if(out.length < 6) out.push(s);
    return out;
  }
  function renderAll(){
    var E = document.getElementById('edges'), N = document.getElementById('nodes'), G = document.getElementById('notes');
    E.innerHTML = ''; N.innerHTML = ''; G.innerHTML = '';
    var feats = (OV.mind_map.root && OV.mind_map.root.children) || [];
    // 根 → 功能
    feats.forEach(function(f){
      var t = LAYOUT[f.id];
      E.innerHTML += '<line x1="'+CX+'" y1="'+CY+'" x2="'+t.x+'" y2="'+t.y+'" stroke="#2d4a78" stroke-width="2.4" opacity=".8"/>';
    });
    // 功能 → 步（径向）
    feats.forEach(function(f){
      (f.steps||[]).forEach(function(s, j){
        var a = LAYOUT[f.id], b = LAYOUT[f.id+':'+j];
        E.innerHTML += '<line x1="'+(a.x+FR*Math.cos(a.th))+'" y1="'+(a.y+FR*Math.sin(a.th))+'" x2="'+b.x+'" y2="'+b.y+'" stroke="#33517e" stroke-width="1.4" opacity=".6"/>';
      });
    });
    // 中心
    N.innerHTML += nodeG('root', CX, CY,
      '<circle r="54" fill="url(#gRoot)" stroke="#8ab6e8" stroke-width="2.5"/>' + centerText(LAYOUT['root'].label, 3, 13));
    // 功能圆 + 步胶囊
    feats.forEach(function(f){
      var t = LAYOUT[f.id];
      N.innerHTML += nodeG(f.id, t.x, t.y,
        '<circle r="'+FR+'" fill="url(#gFeat)" stroke="#5ba3d9" stroke-width="2"/>' + centerText(f.label, 7, 12.5)
        + (f.steps && f.steps.length ? '<text y="'+(FR+14)+'" text-anchor="middle" font-size="10" fill="#8fb7e8">⚙️ '+f.steps.length+' 步</text>' : ''));
      (f.steps||[]).forEach(function(s, j){
        var p = LAYOUT[f.id+':'+j];
        var lines = wrap(s.title, 9);
        var h = 16 + lines.length*14, w = 96;
        N.innerHTML += nodeG(f.id+':'+j, p.x, p.y,
          '<rect x="'+(-w/2)+'" y="'+(-h/2)+'" width="'+w+'" height="'+h+'" rx="'+h/2+'" fill="rgba(16,42,70,.92)" stroke="#3d7ab5" stroke-width="1.4"/>'
          + lines.map(function(ln, li){
              return '<text y="'+(4 + (li-(lines.length-1)/2)*14)+'" text-anchor="middle" font-size="11" fill="#cfe2f8">'+esc(ln)+'</text>';
            }).join(''));
      });
    });
    // 便签
    ANNS.forEach(function(a){
      if(a._x === undefined) return;
      var lines = wrap(a.text, 13);
      var w = 156, h = 24 + lines.length*16;
      var g = document.createElementNS('http://www.w3.org/2000/svg','g');
      g.setAttribute('class','note'); g.setAttribute('data-id', a.id);
      g.setAttribute('transform','translate('+a._x+','+a._y+')');
      g.innerHTML = '<rect x="'+(-w/2)+'" y="'+(-h/2)+'" width="'+w+'" height="'+h+'" rx="7" fill="rgba(251,191,36,.13)" stroke="rgba(251,191,36,.7)" stroke-width="1.6"/>'
        + '<text y="'+(-h/2+16)+'" text-anchor="middle" font-size="10.5" fill="#fbbf24">✍️ 批注</text>'
        + lines.map(function(ln, li){
            return '<text y="'+(-h/2+34+li*16)+'" text-anchor="middle" font-size="11" fill="#fde9c0">'+esc(ln)+'</text>';
          }).join('');
      G.appendChild(g);
      // 锚线（便签 → 目标）
      var t = LAYOUT[a.target_id];
      if(t) E.innerHTML += '<line class="nline-'+cssId(a.id)+'" x1="'+a._x+'" y1="'+a._y+'" x2="'+t.x+'" y2="'+t.y+'" stroke="rgba(251,191,36,.5)" stroke-width="1.4" stroke-dasharray="5 4"/>';
    });
    bindNodeEvents();
  }
  function nodeG(id, x, y, inner){
    return '<g class="mnode" data-id="'+esc(id)+'" transform="translate('+x+','+y+')">'+inner+'</g>';
  }
  function centerText(label, n, size){
    var s = String(label||''); var lines = s.length <= n ? [s] : [s.slice(0, Math.ceil(s.length/2)), s.slice(Math.ceil(s.length/2))].map(function(x){ return x.length>n-1 ? x.slice(0,n-1)+'…' : x; });
    return lines.map(function(ln, li){
      return '<text y="'+(4 + (li-(lines.length-1)/2)*16)+'" text-anchor="middle" font-size="'+size+'" font-weight="700" fill="#e8f1ff">'+esc(ln)+'</text>';
    }).join('');
  }
  function cssId(s){ return String(s).replace(/[^a-zA-Z0-9_-]/g,'_'); }

  // ── 选中 / 详情 ──
  function bindNodeEvents(){
    document.querySelectorAll('.mnode').forEach(function(el){
      el.addEventListener('click', function(ev){
        ev.stopPropagation();
        var id = el.getAttribute('data-id');
        select(id, el);
      });
      el.addEventListener('dblclick', function(ev){ ev.stopPropagation(); openEditor(el.getAttribute('data-id')); });
    });
    document.querySelectorAll('.note').forEach(function(el){
      el.addEventListener('click', function(ev){ ev.stopPropagation(); showNote(el.getAttribute('data-id')); });
    });
  }
  function select(id, el){
    SEL = id;
    document.querySelectorAll('.mnode').forEach(function(x){ x.classList.remove('sel'); });
    if(el) el.classList.add('sel');
    document.getElementById('btn-add').disabled = !LAYOUT[id] || id === 'root';
    var t = LAYOUT[id], det = document.getElementById('detail');
    if(!t){ det.style.display = 'none'; return; }
    if(t.kind === 'feature'){
      var notes = ANNS.filter(function(a){ return a.target_id === id; });
      det.innerHTML = '<b>'+esc(t.label)+'</b><span class="tag">功能</span><p>'+esc(t.node.description||'')+'</p>'
        + (notes.length ? '<p class="mynote">✍️ 我的批注：'+notes.map(function(n){ return esc(n.text); }).join(' ／ ')+'</p>' : '');
    } else if(t.kind === 'step'){
      det.innerHTML = '<b>'+esc(t.owner.label)+' › '+esc(t.label)+'</b><span class="tag">原理步</span><p>'+esc(t.node.detail||'')+'</p>'
        + (t.node.involves && t.node.involves.length ? '<p class="files">'+t.node.involves.map(esc).join(' · ')+'</p>' : '');
    } else {
      det.style.display = 'none'; return;
    }
    det.style.display = 'block';
  }
  function showNote(id){
    var a = ANNS.filter(function(x){ return x.id === id; })[0];
    if(!a) return;
    var t = LAYOUT[a.target_id];
    var det = document.getElementById('detail');
    det.innerHTML = '<b style="color:#fbbf24;">✍️ 我的批注</b>'
      + '<span class="tag">'+(t ? esc(t.label) : esc(a.target_id))+'</span>'
      + '<p>'+esc(a.text)+'</p>'
      + '<button class="danger" onclick="window.__delNote(\\''+a.id+'\\')">🗑 删除这条批注</button>';
    det.style.display = 'block';
  }
  window.__delNote = function(id){
    ANNS = ANNS.filter(function(x){ return x.id !== id; });
    DIRTY = true; computeLayout(); renderAll();
    document.getElementById('detail').style.display = 'none';
    updateSaveState();
  };

  // ── 批注编辑器 ──
  var ED_TARGET = null;
  function openEditor(targetId){
    if(!targetId || targetId === 'root' || !LAYOUT[targetId]) return;
    ED_TARGET = targetId;
    document.getElementById('ed-target').textContent = '→ ' + (LAYOUT[targetId].label || targetId);
    document.getElementById('ed-text').value = '';
    document.getElementById('editor').style.display = 'flex';
    document.getElementById('ed-text').focus();
  }
  document.getElementById('ed-cancel').onclick = function(){ document.getElementById('editor').style.display = 'none'; };
  document.getElementById('ed-ok').onclick = function(){
    var txt = document.getElementById('ed-text').value.trim();
    if(!txt || !ED_TARGET) { document.getElementById('editor').style.display = 'none'; return; }
    ANNS.push({ id: 'note_' + Date.now(), target_id: ED_TARGET, text: txt, author: 'human' });
    DIRTY = true; computeLayout(); renderAll();
    document.getElementById('editor').style.display = 'none';
    updateSaveState();
  };
  document.getElementById('btn-add').onclick = function(){ if(SEL) openEditor(SEL); };

  // ── 保存（写回 DSL.annotations） ──
  function updateSaveState(){
    var el = document.getElementById('save-state');
    el.textContent = DIRTY ? '● 有未保存的批注' : '';
  }
  document.getElementById('btn-save').onclick = function(){
    var payload = ANNS.map(function(a){ return { id: a.id, target_id: a.target_id, text: a.text, pos: { x: Math.round(a._x||0), y: Math.round(a._y||0) } }; });
    var btn = this; btn.disabled = true; btn.textContent = '保存中…';
    fetch('/api/annotations', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feature: FEATURE, notes: payload }) })
      .then(function(r){ return r.json(); })
      .then(function(j){
        btn.disabled = false; btn.textContent = '💾 保存批注';
        if(j.success){ DIRTY = false; updateSaveState(); flash('已保存 ' + payload.length + ' 条批注（AI 再生成时将读到它们）'); }
        else flash('保存失败：' + (j.error || ''));
      })
      .catch(function(e){ btn.disabled = false; btn.textContent = '💾 保存批注'; flash('保存失败：' + e.message); });
  };
  function flash(msg){
    var el = document.getElementById('save-state');
    el.textContent = msg;
    setTimeout(updateSaveState, 3200);
  }

  // ── 平移 / 缩放 / 便签拖动 ──
  var svg = document.getElementById('mm'), vp = document.getElementById('vp');
  function applyView(){ vp.setAttribute('transform','translate('+VIEW.tx+','+VIEW.ty+') scale('+VIEW.s+')'); }
  function fitView(){
    var w = window.innerWidth, h = window.innerHeight - 52;
    var s = Math.min(w/CW, h/CH) * 0.96;
    VIEW = { s: s, tx: w/2 - CX*s, ty: h/2 - CY*s };
    document.getElementById('mm').setAttribute('viewBox','0 0 '+w+' '+h);
    applyView();
  }
  document.getElementById('btn-reset').onclick = fitView;
  window.addEventListener('resize', function(){ /* 保持当前视图，仅更新 viewBox 尺寸 */ });
  svg.addEventListener('wheel', function(ev){
    ev.preventDefault();
    var k = ev.deltaY < 0 ? 1.12 : 0.89;
    var ns = Math.min(2.6, Math.max(0.25, VIEW.s * k));
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
    if(pan && !pan.moved){ SEL = null; document.getElementById('btn-add').disabled = true;
      document.querySelectorAll('.mnode').forEach(function(x){ x.classList.remove('sel'); });
      document.getElementById('detail').style.display = 'none'; }
    if(dragNote) updateSaveState();
    pan = null; dragNote = null;
  });
  `;

  return shell(`${safeFeature} · 思维导图`, body, `
  <style>
    html, body { height: 100%; overflow: hidden; }
    .mm-top { display: flex; align-items: center; justify-content: space-between; padding: 10px 20px; border-bottom: 1px solid rgba(125,211,252,.15); background: rgba(6,11,31,.85); }
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
    .mnode.sel circle, .mnode.sel rect { stroke: #7dd3fc !important; stroke-width: 3 !important; filter: drop-shadow(0 0 8px rgba(125,211,252,.5)); }
    .note { cursor: move; }
    .note:hover rect { stroke: #fbbf24; filter: drop-shadow(0 0 8px rgba(251,191,36,.35)); }
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
    #hint { position: fixed; right: 20px; bottom: 20px; font-size: 11.5px; color: #7a93b8; opacity: .8; background: rgba(6,11,31,.7); border-radius: 8px; padding: 5px 12px; z-index: 15; }
  </style>
  <script>${script}</script>`);
}
