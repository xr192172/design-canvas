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
      <span class="lv-group" title="层级收纳：控制树展开到哪一层（单个节点的圆点仍可单独折叠）">
        <span class="lv-label">层级</span>
        <button class="lv-btn" data-lv="1">功能</button>
        <button class="lv-btn" data-lv="2">子模块</button>
        <button class="lv-btn lv-on" data-lv="3">全部</button>
      </span>
      <button id="btn-add-branch" title="给选中节点（未选中则给根节点）新增一个分支">＋ 新增分支</button>
      <button id="btn-save" title="把新增节点与便签批注写回项目数据（AI 再生成时会读到）">💾 保存</button>
      <button id="btn-reset" title="重置视图">↺ 复位</button>
      <button id="btn-expand" title="展开全部">⊞ 全展开</button>
      <span id="save-state"></span>
    </div>
  </div>
  <div id="plinebar" style="display:none; position:fixed; left:16px; bottom:16px; z-index:97; background:#e3fafc; color:#0b7285; border:1px solid #15aabf; border-radius:10px; padding:8px 14px; font:12px/1.5 system-ui,sans-serif; box-shadow:0 4px 14px rgba(21,170,191,.18); max-width:min(56vw,560px);"></div>
  <div id="canvas-wrap">
    <svg id="mm" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker id="arrowDep" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" fill="#e8590c"/>
        </marker>
        <marker id="arrowFlow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" fill="#15aabf"/>
        </marker>
      </defs>
      <g id="vp">
        <g id="edges"></g>
        <g id="deplayer"></g>
        <g id="nodes"></g>
        <g id="flowlayer"></g>
        <g id="notes"></g>
      </g>
    </svg>
  </div>
  <div id="inline-ed" style="display:none;">
    <input id="inline-text" placeholder="输入文字，Enter 确定 · Esc 取消">
  </div>
  <div id="detail" style="display:none;"></div>
  <div id="docpanel" style="display:block; position:fixed; top:52px; right:16px; bottom:16px; width:300px; z-index:25; background:#ffffff; border:1px solid #dee2e6; border-top:4px solid #1971c2; border-radius:14px; box-shadow:0 10px 30px rgba(30,60,100,.16); overflow:auto; font-size:13px; color:#343a40; line-height:1.7;">
    <div id="docpanel-hd" style="display:flex; align-items:center; justify-content:space-between; padding:12px 16px 8px; position:sticky; top:0; background:#fff; border-bottom:1px solid #e9ecef; cursor:pointer;">
      <b style="font-size:14px; color:#1c7ed6;">📋 项目导读</b>
      <span id="docpanel-fold" style="color:#868e96; font-size:12px; border:1px solid #ced4da; border-radius:8px; padding:2px 9px;">收起</span>
    </div>
    <div id="docpanel-body" style="padding:12px 16px 20px; overflow:auto; max-height:calc(100vh - 140px);">
      <div id="dp-one" style="font-size:14px; font-weight:700; color:#1e1e1e; margin-bottom:6px;">…</div>
      <div id="dp-brief" style="color:#495057; margin-bottom:10px;">…</div>
      <div id="dp-feats" style="margin-bottom:6px;">…</div>
      <div id="dp-steps" style="color:#868e96; font-size:12px;">…</div>
    </div>
  </div>
  <div id="docpanel-hint" style="display:none; position:fixed; top:64px; right:16px; z-index:26; background:#e7f5ff; color:#0b7285; border:1px solid #74c0fc; border-radius:10px; padding:7px 13px; font-size:12.5px; cursor:pointer; box-shadow:0 4px 14px rgba(25,113,194,.15);">📋 项目导读</div>
  <div id="editor" style="display:none;">
    <div class="ed-title">✏️ 批注 <em id="ed-target"></em></div>
    <textarea id="ed-text" placeholder="写你的理解、纠正、问题……&#10;例如：这一步其实先查缓存；这个功能应该叫配置中心"></textarea>
    <div class="ed-btns"><button id="ed-cancel">取消</button><button id="ed-ok" class="primary">确定</button></div>
  </div>
  <div id="hint">点节点看详情 · 点左侧圆点折叠 · hover 节点点 ⊕ 新增分支 · 双击 AI 节点写批注 / 双击自己的节点改字 · <b>青色连线 + 序号 = 业务流转顺序（1→2→3）</b> · <b>加新功能：根节点写构想 → 保存 → AI 自动定位挂上去（🔮）</b></div>
  <div id="jserr" style="display:none; position:fixed; top:8px; left:50%; transform:translateX(-50%); z-index:99; background:#ffe3e3; color:#c92a2a; border:1px solid #ffa8a8; border-radius:8px; padding:8px 14px; font:12px ui-monospace,monospace; max-width:90vw; max-height:40vh; overflow:auto; white-space:pre-wrap;"></div>
  <script>
    window.addEventListener('error', function(e){ var d = document.getElementById('jserr'); if(d){ d.style.display='block'; d.textContent += '✗ ' + e.message + ' @' + (e.lineno||'?') + ':' + (e.colno||'?') + '\\n'; } });
    window.addEventListener('unhandledrejection', function(e){ var d = document.getElementById('jserr'); if(d){ d.style.display='block'; d.textContent += '✗ Promise: ' + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason) + '\\n'; } });
  </script>
  <style>
    html, body { height: 100%; overflow: hidden; }
    body { background-color: #f5faff; background-image: radial-gradient(#ced4da 1.1px, transparent 1.1px); background-size: 22px 22px; color: #1e1e1e; font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', 'Segoe UI', sans-serif; }
    .wrap { max-width: none; margin: 0; padding: 0; }
    .mm-top { display: flex; align-items: center; justify-content: space-between; padding: 10px 20px; border-bottom: 1px solid #e9ecef; background: rgba(255,255,255,.92); backdrop-filter: blur(4px); position: relative; z-index: 6; }
    .mm-top .back { font-size: 14px; font-weight: 700; color: #1e1e1e; }
    .mm-top .tools { display: flex; gap: 10px; align-items: center; }
    .mm-top button { background: #fff; color: #364fc7; font-size: 12.5px; border: 1.5px solid #a5d8ff; border-radius: 10px; padding: 6px 14px; cursor: pointer; }
    .lv-group { display: inline-flex; align-items: center; gap: 4px; background: #fff; border: 1.5px solid #a5d8ff; border-radius: 10px; padding: 2px 8px 2px 10px; }
    .lv-label { font-size: 11px; color: #748ffc; margin-right: 2px; }
    .lv-btn { border: none !important; padding: 4px 10px !important; border-radius: 6px !important; background: transparent !important; color: #748ffc !important; }
    .lv-btn.lv-on { background: #d0ebff !important; color: #1971c2 !important; font-weight: 700; }
    .mm-top button:hover:not(:disabled) { background: #e7f5ff; }
    .mm-top button:disabled { opacity: .4; cursor: not-allowed; }
    #save-state { font-size: 12px; color: #e8590c; min-width: 60px; }
    #canvas-wrap { position: absolute; inset: 52px 0 0 0; cursor: grab; }
    #canvas-wrap:active { cursor: grabbing; }
    #mm { width: 100%; height: 100%; display: block; }
    .mnode { cursor: pointer; }
    .mnode .addbtn, .mnode .delbtn { opacity: 0; transition: opacity .12s; }
    .mnode:hover .addbtn, .mnode:hover .delbtn { opacity: 1; }
    .mnode.sel rect, .mnode.sel circle { stroke: #1971c2 !important; stroke-width: 3 !important; filter: drop-shadow(0 3px 8px rgba(25,113,194,.35)); }
    .fold { cursor: pointer; }
    .fold:hover { filter: drop-shadow(0 2px 5px rgba(25,113,194,.45)); }
    .note { cursor: move; }
    .note:hover rect { stroke: #e8590c; filter: drop-shadow(0 3px 8px rgba(232,89,12,.3)); }
    #inline-ed { position: fixed; z-index: 40; transform: translate(-4px, -50%); }
    #inline-text { width: 190px; background: #fff9b2; color: #5c4400; border: 1.5px dashed #e67700; border-radius: 8px; padding: 7px 10px; font-size: 13px; font-family: inherit; outline: none; box-shadow: 0 3px 10px rgba(0,0,0,.12); }
    #inline-text:focus { border-style: solid; background: #fff3bf; }
    #detail { position: fixed; left: 20px; bottom: 20px; max-width: 520px; background: #ffffff; border: 1px solid #dee2e6; border-left: 4px solid #4dabf7; border-radius: 12px; padding: 14px 18px; font-size: 13px; line-height: 1.7; z-index: 20; box-shadow: 0 8px 24px rgba(50,60,80,.14); color: #343a40; }
    #detail b { font-size: 14.5px; color: #1e1e1e; }
    #detail .tag { font-size: 11px; color: #1971c2; border: 1px solid #a5d8ff; border-radius: 10px; padding: 1px 9px; margin-left: 10px; vertical-align: 2px; background: #e7f5ff; }
    #detail p { margin-top: 8px; color: #495057; }
    #detail .mynote { color: #e8590c; }
    #detail .files { font-size: 11px; color: #868e96; font-family: ui-monospace, Consolas, monospace; word-break: break-all; }
    #detail .danger { margin-top: 10px; background: #fff5f5; color: #e03131; font-size: 12px; border: 1px solid #ffc9c9; border-radius: 8px; padding: 5px 12px; cursor: pointer; }
    #editor { position: fixed; inset: 0; background: rgba(240,244,255,.55); backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center; z-index: 50; }
    #editor > div { width: 400px; background: #ffffff; border: 1px solid #dee2e6; border-radius: 14px; padding: 18px 20px; box-shadow: 0 10px 30px rgba(50,60,80,.18); }
    .ed-title { font-size: 14px; font-weight: 700; color: #1e1e1e; margin-bottom: 10px; }
    .ed-title em { font-style: normal; font-size: 12px; color: #e8590c; margin-left: 8px; }
    #ed-text { width: 100%; height: 90px; background: #f8f9fa; color: #343a40; border: 1px solid #ced4da; border-radius: 8px; padding: 10px; font-size: 13px; font-family: inherit; resize: vertical; }
    .ed-btns { display: flex; justify-content: flex-end; gap: 10px; margin-top: 12px; }
    .ed-btns button { background: #fff; color: #495057; font-size: 13px; border: 1px solid #ced4da; border-radius: 8px; padding: 6px 16px; cursor: pointer; }
    .ed-btns .primary { background: #a5d8ff; color: #1864ab; border-color: #4dabf7; font-weight: 700; }
    #hint { position: fixed; right: 20px; bottom: 20px; font-size: 11.5px; color: #5c6770; opacity: .92; background: rgba(255,255,255,.94); border: 1px solid #e9ecef; border-radius: 8px; padding: 5px 12px; z-index: 15; max-width: 460px; box-shadow: 0 2px 8px rgba(50,60,80,.08); }
    #hint b { color: #6741d9; }
    /* ── 工厂产线视图（PL 确认的步骤组：工序盒+针脚+正交连线）── */
    .fac-mach { fill: #fff; stroke: #0c8599; stroke-width: 1.8; }
    .fac-mach-hd { fill: #e6f4f6; }
    .fac-mach-title { font-weight: 700; fill: #0b7285; font-size: 12px; }
    .fac-pin-name { font-size: 11px; fill: #334155; }
    .fac-pin-type { font-size: 10px; fill: #0b7285; font-family: ui-monospace, Consolas, monospace; }
    .fac-pin-type-out { text-anchor: end; }
    .fac-pin-sq { fill: #0c8599; stroke: #fff; stroke-width: 1.2; }
    .fac-file { font-size: 10px; fill: #94a3b8; font-family: ui-monospace, Consolas, monospace; }
    .fac-detail { font-size: 10.5px; fill: #475569; }
    .fac-narr-hd { font-size: 9.5px; font-weight: 600; fill: #1f2937; }
    .fac-narr-title { font-size: 10.5px; font-weight: 600; fill: #155e75; }
    .fac-narr-detail { font-size: 10px; fill: #475569; }
    .fac-narr-facts { font-size: 9px; fill: #94a3b8; font-family: ui-monospace, Consolas, monospace; }
    .fac-wire { fill: none; stroke: #0c8599; stroke-width: 1.6; stroke-linejoin: round; stroke-linecap: round; }
    .fac-wirehead { fill: #0c8599; }
    .fac-slot-in { fill: #fff; stroke: #64748b; stroke-width: 1.5; }
    .fac-slot-out { fill: #eef6ff; stroke: #3b82f6; stroke-width: 1.4; }
    .fac-slot-t { font-weight: 700; font-size: 12px; fill: #334155; }
    .fac-slot-out .fac-slot-t { fill: #1d4ed8; }
    .fac-slot-sub { font-size: 10.5px; fill: #64748b; }
    .fac-bound { fill: none; stroke: #94b8c4; stroke-width: 1.2; stroke-dasharray: 4 5; }
    .fac-floor-bg { fill: #faf6ed; }
    .fac-btn { font-size: 11px; fill: #0369a1; cursor: pointer; font-weight: 700; }
    .fac-btn:hover { fill: #0c8599; }
    .fac-seq { font-size: 10px; font-weight: 700; fill: #fff; }
    .fac-seq-bg { fill: #0c8599; }
    /* 待做灰块 */
    .fac-todo { fill: #f8fafc; stroke: #94a3b8; stroke-width: 1.6; stroke-dasharray: 5 4; }
    .fac-todo-hd { fill: #f1f5f9; }
    .fac-todo .fac-mach-title { fill: #64748b; }
    .fac-todo .fac-pin-name { fill: #94a3b8; }
    .fac-todo .fac-pin-type { fill: #94a3b8; }
    .fac-todo .fac-pin-sq { fill: #cbd5e1; stroke: #f8fafc; }
    .fac-todo .fac-file { fill: #94a3b8; }
  </style>`;

  const script = `
  var FEATURE = ${JSON.stringify(feature)};
  var OV = null, ANNS = [], UNODES = [], DEPS = [], FOUNDATIONS = [], FLOWS = [], PL = {}, PLP = {};
  var TREE = null, NODE_BY_ID = {}, SEL = null, DIRTY = false;
  var VIEW = { tx: 0, ty: 0, s: 1 };
  var COLLAPSED = {};   // 会话级折叠状态：id -> true
  var DOC_W = 0;        // 右侧导读面板占位宽度（面板可见时=面板宽，收起=0）
  var INLINE = null;    // inline 编辑状态：{ parentId, editId, x, y }

  // ── 数据加载 ──
  function applyData(rs0, rs1, rs2){
    OV = rs0;
    ANNS = (rs1.annotations || []).filter(function(a){ return a.author === 'human'; });
    UNODES = rs2.user_nodes || [];
    DEPS = ((OV.mind_map && OV.mind_map.deps) || []).slice();
    FOUNDATIONS = (OV.mind_map && OV.mind_map.foundations) || [];
    FLOWS = ((OV.mind_map && OV.mind_map.flows) || []).slice();
    // 产线视图确认表（主人拍板）+ LLM 提议（候选，确认前不影响渲染）
    PL = (OV.mind_map && OV.mind_map.pipeline_like) || {};
    PLP = (OV.mind_map && OV.mind_map.pipeline_like_proposals) || {};
    // 构想的预判依赖：紫色"预判"弧（区别于真实调用证据的橙色弧）
    ((OV.mind_map && OV.mind_map.proposals) || []).forEach(function(pp){
      (pp.depends_on || []).forEach(function(d){ DEPS.push({ from: pp.title, to: d, weight: 0, _pred: true }); });
    });
    rebuild();
    setDepthLevel(1); // 默认展开到功能层：各功能先折叠为卡片，点开某个功能才展开其工厂流水线（工序盒+针脚+连线）。
    // 这样大项目首屏不渲染全部工序，避免切到其它项目时卡顿；产线仍是功能展开时的固定呈现。
    renderPipelineBar();
    pollSharedDesc();
    fillDocPanel();
    wireDocPanelToggle();
  }
  // ── 右侧导读面板 收起/唤醒 切换 ──
  function wireDocPanelToggle(){
    var p = document.getElementById('docpanel'), hint = document.getElementById('docpanel-hint');
    function showPanel(show){
      p.style.display = show ? 'block' : 'none';
      hint.style.display = show ? 'none' : 'block';
      DOC_W = show ? (p.offsetWidth + 24) : 0;
      requestAnimationFrame(fitView); // 面板宽度变化 → 重新计算可用画布
    }
    DOC_W = p.offsetWidth + 24;
    document.getElementById('docpanel-hd').onclick = function(){ showPanel(false); };
    hint.onclick = function(){ showPanel(true); };
    fillDocPanel();
  }
  // ── 右侧项目导读面板：填全局介绍（summary）+ 模块清单 + 上手步骤；点模块名定位导图 ──
  function fillDocPanel(){
    var one = OV && OV.summary && OV.summary.one_liner;
    var brief = OV && OV.summary && OV.summary.brief;
    document.getElementById('dp-one').textContent = one || FEATURE;
    document.getElementById('dp-brief').textContent = brief || '（暂无项目介绍）';
    var mm = OV && OV.mind_map;
    var feats = mm && mm.root ? (mm.root.children || []) : [];
    var fhtml = '<div style="font-weight:700;color:#1971c2;margin-top:4px;">🧩 项目模块</div>'
      + feats.map(function(f, i){
          var lab = esc(f.label), desc = esc((f.description || '').slice(0, 60));
          return '<div data-jump="'+i+'" style="display:flex;align-items:center;gap:8px;padding:7px 9px;margin:4px 0;border:1px solid #e7f0fa;border-radius:9px;cursor:pointer;background:#f7fbff;">'
            + '<span style="width:20px;height:20px;flex:0 0 20px;border-radius:50%;background:#1971c2;color:#fff;font-size:11px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;">'+(i+1)+'</span>'
            + '<div style="flex:1;min-width:0;"><div style="font-weight:600;color:#1e3a5f;">'+lab+'</div>'
            + '<div style="font-size:11px;color:#868e96;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+desc+'</div></div>'
            + (feats.length>1 ? '<span style="font-size:11px;color:#15aabf;">' + (i+1) + '</span>' : '')
            + '</div>';
        }).join('');
    document.getElementById('dp-feats').innerHTML = fhtml + '<div style="font-size:11px;color:#868e96;margin-top:6px;">点模块跳到导图 · 点模块左侧圆点在本图展开</div>';
    var st = (OV && OV.first_steps) || [];
    document.getElementById('dp-steps').innerHTML = st.length
      ? '<div style="font-weight:700;color:#0b7285;margin-top:6px;">🪜 上手步骤</div>' + st.slice(0,5).map(function(s,i){ return '<div style="padding:3px 0;">'+(i+1)+'. '+esc(s.label)+'</div>'; }).join('')
      : '';
    document.querySelectorAll('#dp-feats [data-jump]').forEach(function(el){
      el.onclick = function(){
        var i = parseInt(el.getAttribute('data-jump'), 10);
        var fn = TREE && TREE.children ? TREE.children[i] : null;
        if(!fn) return;
        // 收起其他模块、展开目标模块，并居中定位
        for(var k in COLLAPSED) delete COLLAPSED[k];
        TREE.children.forEach(function(other){ if(other !== fn && other.children.length) COLLAPSED[other.kind==='feature'?other.id:(other.id||'')] = true; });
        delete COLLAPSED[fn.id];
        layoutTree(); renderAll();
        var b = { x: fn._x, y: fn._y - 40 };
        VIEW = { tx: window.innerWidth/2 - b.x*VIEW.s, ty: 52 + (window.innerHeight-52)/2 - b.y*VIEW.s, s: VIEW.s };
        applyView();
      };
    });
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

  // ── 产线骨架注入：把功能的步骤组升级为工厂产线（工序盒+针脚+正交连线）。
  // 默认所有功能直接走产线视图——工厂流水线就是分镜的标准呈现，无需逐一拍板；
  // 仅当主人显式点过「✗ 否」（PL[label] === false）才回落为普通步骤列表。
  // 顺序就是分镜顺序（LLM 已按真实调用/数据流排出），不再用 FLOWS 重算。
  function markPipeline(){
    var fn, k, n;
    for(k in NODE_BY_ID){ n = NODE_BY_ID[k];
      if(n.kind === 'feature' && PL[n.raw.label] !== false){
        n.children.forEach(function(g){
          if(g.kind === 'stepgroup'){
            g._manualFlow = 1;
            g._factory = true;
            var st = (g.children || []).filter(function(c){ return c.kind === 'step'; });
            st.forEach(function(s, i){
              s._flowSeq = i + 1;
              s._facStep = true;
              prepareFacPins(s, i, st.length, g);
            });
          }
        });
      }
    }
  }

  // ── 工厂产线几何配置 ──
  var FAC = {
    machW: 280, hdH: 26, pinStart: 36, pinRowH: 20, pinSize: 9,
    fileH: 22, detailPadTop: 8, detailLineH: 15, detailPadBot: 10,
    padL: 12, padR: 12, machGap: 64, slotW: 100, slotH: 48, slotGap: 36,
    floorPadX: 16, floorPadTop: 40, floorPadBot: 20
  };
  // 针脚数据准备：优先用契约投影（后端从 actual_apis 签名推导、非 LLM 编造），
  // 再读 raw.inputs/outputs（未来 LLM 直接生成），否则按步骤顺序自动推导
  function prepareFacPins(s, idx, total, group){
    var raw = s.raw || {};
    var meta = raw.meta || {};
    var ins = meta.inputs || raw.inputs, outs = meta.outputs || raw.outputs;
    if(!ins || !ins.length){
      if(idx === 0) ins = [{ n: '原材料', t: 'input' }];
      else {
        var prev = group.children.filter(function(c){ return c.kind === 'step'; })[idx - 1];
        var prevOut = (prev && prev._facOuts) || [{ n: '上一步产出', t: 'data' }];
        ins = prevOut.map(function(p){ return { n: p.n, t: p.t }; });
      }
    }
    if(!outs || !outs.length){
      var outName = s.label ? s.label.replace(/[了着过]$/, '') + '结果' : '输出';
      outs = [{ n: outName, t: 'data' }];
    }
    s._facIns = ins;
    s._facOuts = outs;
  }
  function facPinCount(s){
    return Math.max((s._facIns || []).length, (s._facOuts || []).length, 1);
  }
  function facBaseH(s){
    var n = facPinCount(s);
    return FAC.hdH + (FAC.pinStart - FAC.hdH) + n * FAC.pinRowH + FAC.fileH;
  }
  function facMachH(s){
    var h = facBaseH(s);
    if(s._facOpen && s.raw){
      var d = String(s.raw.detail || s.raw.description || '');
      if(d){
        var ls = wrap(d, 20);
        h += FAC.detailPadTop + ls.length * FAC.detailLineH + FAC.detailPadBot;
      }
      // 叙事分镜面板高度：进料口/工序/出料口 三个场景，每个标题行+正文换行+事实小字
      var narr = (s.raw.meta && s.raw.meta.narration) || [];
      if(narr.length){
        narr.forEach(function(sc){
          var dl = wrap(sc.detail, 22);
          var fl = sc.facts.length ? 1 : 0; // 事实合并为一行小字
          h += 24 + dl.length * FAC.detailLineH + fl * FAC.detailLineH;
        });
        h += FAC.detailPadBot;
      }
    }
    return h;
  }
  function facPinY(m, idx){ return m.y + FAC.pinStart + idx * FAC.pinRowH + FAC.pinRowH / 2 - 2; }
  function facInX(m){ return m.x; }
  function facOutX(m){ return m.x + m.w; }
  // 工厂产线 floor 尺寸：IN槽 + 工序列 + OUT槽 水平排列
  function facFloorSize(group){
    var steps = (group.children || []).filter(function(c){ return c.kind === 'step'; });
    var maxH = 0;
    steps.forEach(function(s){ var h = facMachH(s); if(h > maxH) maxH = h; s._facH = h; });
    var n = steps.length;
    var w = FAC.slotW + FAC.slotGap + n * FAC.machW + (n - 1) * FAC.machGap + FAC.slotGap + FAC.slotW;
    var h = maxH;
    return { w: w + FAC.floorPadX * 2, h: h + FAC.floorPadTop + FAC.floorPadBot, steps: steps, maxH: maxH };
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
      if(f.children && f.children.length){
        // 真三层：功能 → [🎬 分镜组 | 🧩 子模块(社区)] → [步骤 | 文件]——结构层与讲解层分开。
        // 已确认产线的功能：steps 升级为工序盒，涉及文件入住为子卡片（第四级）
        f.children.forEach(function(g){
          var gn = { id: g.id, label: g.label, kind: g.kind, children: [], raw: g, owner: f };
          NODE_BY_ID[gn.id] = gn;
          (g.children || []).forEach(function(c){
            var cn = { id: c.id, label: c.label, kind: c.kind, children: [], raw: c, owner: f,
              _host: f, _comm: g.kind === 'community' ? g.label : null };
            NODE_BY_ID[c.id] = cn;
            (c.children || []).forEach(function(cc){
              var ccn = { id: cc.id, label: cc.label, kind: cc.kind, children: [], raw: cc, owner: f, _host: f };
              NODE_BY_ID[cc.id] = ccn;
              cn.children.push(ccn);
            });
            gn.children.push(cn);
          });
          fn.children.push(gn);
        });
      } else {
        // 旧 JSON 兜底：分镜平铺在功能下
        (f.steps || []).forEach(function(s, j){
          var sn = { id: 'f' + i + ':' + j, label: s.title, kind: 'step', children: [], raw: s, owner: f };
          NODE_BY_ID[sn.id] = sn;
          fn.children.push(sn);
        });
      }
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
    markPipeline();      // 产线工序盒：注入步骤序号 + 青色连线
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

  var MIN_H = 40;
  function nodePer(n){ return n.kind === 'step' ? 10 : (n.kind === 'root' ? 8 : ((n.kind === 'shared' || n.kind === 'file') ? 16 : 11)); }
  function nodeLines(n){ return wrap(n.label || '', nodePer(n)); }
  // 卡片介绍行：所有内容卡片直接画介绍（不用点击才知道）。描述按换行分段，
  // 以"→"开头的段是增量/借鉴标注，渲染成紫色区分"是什么"与"要变什么"
  function descLines(n){
    if(n.kind === 'root' || n.kind === 'note' || n.kind === 'user' || n.kind === 'step') return [];
    var d = n.raw && n.raw.description;
    if(!d) return [];
    var segs = String(d).split('\\n').map(function(s){ return s.trim(); }).filter(Boolean);
    var per = nodePer(n) + 4;
    var budget = (n.kind === 'feature' || n.kind === 'proposal' || n.kind === 'brick') ? 3 : 2;
    var out = [];
    for(var i = 0; i < segs.length && out.length < budget; i++){
      var isDelta = segs[i].charAt(0) === '→';
      var w = wrap(segs[i], per);
      for(var j = 0; j < w.length && out.length < budget; j++) out.push({ t: w[j], delta: isDelta });
    }
    return out;
  }
  function nodeH(n){
    var ls = nodeLines(n), ds = descLines(n);
    return Math.max(MIN_H, 22 + ls.length * 15 + (ds.length ? ds.length * 12.5 + 5 : 0));
  }
  function nodeW(n){
    var ls = nodeLines(n), ds = descLines(n), maxLen = 0;
    ls.forEach(function(ln){ if(ln.length > maxLen) maxLen = ln.length; });
    ds.forEach(function(dl){ if(dl.t.length * 0.78 > maxLen) maxLen = Math.ceil(dl.t.length * 0.78); });
    var min = n.kind === 'root' ? 120 : (n.kind === 'feature' ? 116 : 88);
    return Math.max(min, maxLen * 12.5 + 28);
  }
  function collapsed(n){ return !!COLLAPSED[n.id] && n.children.length > 0; }
  function visChildren(n){ return collapsed(n) ? [] : n.children; }
  // ── 流转顺序：按设计图层手绘流转边（file→file）排卡片，替代字母序 ──
  // 对任意层级的可见子卡列表：两端分别落在不同子卡子树里的边 → 归纳为"块级边"，
  // 参与边的子卡按链式拓扑序排前（打 1/2/3 序号徽标），孤立子卡保持原序跟后；
  // 块级边记到父节点 _flowEdges（渲染为青色连线）。链头=盒内入度 0，回边成环时按原序兜底。
  function flowOrder(p, ch){
    if(ch.length < 2 || !FLOWS.length) return;
    var owner = {};   // 文件 id → 所属子卡 id
    ch.forEach(function(c){
      (function col(m){ owner[m.id] = c.id; (m.children || []).forEach(col); })(c);
    });
    var edges = [], inChain = {}, outs = {};
    FLOWS.forEach(function(f){
      var a = owner[f.from], b = owner[f.to];
      if(a && b && a !== b){
        edges.push({ a: a, b: b, label: f.label });
        (outs[a] = outs[a] || []).push(b);
        inChain[a] = inChain[b] = true;
      }
    });
    if(!edges.length) return;
    var inDeg = {};
    ch.forEach(function(c){ inDeg[c.id] = 0; });
    edges.forEach(function(e){ inDeg[e.b]++; });
    var seen = {}, chain = [];
    function visit(id){
      if(seen[id]) return; seen[id] = true; chain.push(id);
      (outs[id] || []).forEach(visit);
    }
    ch.forEach(function(c){ if(inChain[c.id] && !inDeg[c.id]) visit(c.id); }); // 链头优先
    ch.forEach(function(c){ if(inChain[c.id] && !seen[c.id]) visit(c.id); });  // 回边成环：按原序兜底
    // 重排：链上子卡按链序在前、其余子卡原序跟后；序号徽标 + 块级连线记录
    var rest = ch.filter(function(c){ return !seen[c.id]; });
    p.children = chain.map(function(id){ return NODE_BY_ID[id]; }).concat(rest);
    chain.forEach(function(id, i){ var n = NODE_BY_ID[id]; if(n) n._flowSeq = i + 1; });
    p._flowEdges = edges.map(function(e){ return { a: NODE_BY_ID[e.a], b: NODE_BY_ID[e.b], label: e.label }; });
  }
  // 全树逐层应用：功能层（跨功能流转）→ 子模块层（本项目的核心场景）→ 文件层，同一算法分形复用
  function orderAll(n){
    if(n._manualFlow){ // 产线工序盒：步骤序号与连线已手动注入，不再用 FLOWS 重算
      visChildren(n).forEach(orderAll); return;
    }
    delete n._flowEdges;
    var vc = visChildren(n);
    vc.forEach(function(c){ delete c._flowSeq; });
    if(vc.length > 1) flowOrder(n, vc);
    vc.forEach(orderAll);
  }

  // ── 电工式正交布线（横平竖直、通道错道、出入口展宽）──
  // 同一父节点内子块间的流转边，按相对位置分四种走法（全部只走空白，不穿卡也不藏卡后）：
  //   同行相邻      → 列间隙直线水平
  //   同行回退/隔卡 → 行下通道 U 形回线
  //   相邻行        → 行间通道 Z 形（换行回扫，像文本换行）
  //   远距离        → 竖直廊道干线（列间隙/盒边距里走竖线，绕到目标行上方再落下）
  // 同通道多线自动错道（±4px 交替）；同一卡同侧多出入口横向展宽（14px 间隔）
  function routeFlows(p){
    var fes = p._flowEdges;
    if(!fes || !fes.length) return '';
    function geo(n){
      if(n._box){ var t = n._y - n._box.hh / 2; return { n: n, cx: n._x, cy: n._y, top: t, bot: t + n._box.h, left: n._x - n._box.w / 2, right: n._x + n._box.w / 2 }; }
      var h = n._h || nodeH(n), w = n._w || nodeW(n);
      return { n: n, cx: n._x, cy: n._y, top: n._y - h / 2, bot: n._y + h / 2, left: n._x - w / 2, right: n._x + w / 2 };
    }
    var sibs = visChildren(p).map(geo);
    if(!sibs.length) return '';
    if(window.__DBG__){ console.log('[routeFlows]', p.id || p.label, 'sibs:', sibs.map(function(s){ return (s.n.id||'?') + '@' + Math.round(s.top) + '-' + Math.round(s.bot); }).join(' '), '| edges:', (fes||[]).length); }
    // 行分组：y 区间相交即同行（盒中盒后子块高度差异大，区间比中心点容差稳健）
    // 注意：分组过程中增量维护 last.bot（rows 的 top/bot 汇总在分组后才有）
    var rows = [];
    sibs.slice().sort(function(a, b){ return a.top - b.top; }).forEach(function(g){
      var last = rows[rows.length - 1];
      if(last && g.top < last.bot - 0.5){ last.items.push(g); if(g.bot > last.bot) last.bot = g.bot; }
      else rows.push({ items: [g], top: g.top, bot: g.bot });
    });
    rows.forEach(function(r){
      r.top = Math.min.apply(null, r.items.map(function(i){ return i.top; }));
      r.bot = Math.max.apply(null, r.items.map(function(i){ return i.bot; }));
      r.y = (r.top + r.bot) / 2;
    });
    function rowOf(g){
      for(var i = 0; i < rows.length; i++){
        for(var k = 0; k < rows[i].items.length; k++) if(rows[i].items[k].n === g.n) return i;
      }
      return -1;
    }
    // 行间通道：chanBelow[i] 在行 i 与行 i+1 之间（末行下方）；行 0 上方单设
    var chanBelow = rows.map(function(r, i){
      return i < rows.length - 1 ? { y: (rows[i].bot + rows[i + 1].top) / 2, use: 0 } : { y: rows[i].bot + 14, use: 0 };
    });
    var chanTop0 = { y: rows[0].top - 14, use: 0 };
    function chanAbove(i){ return i > 0 ? chanBelow[i - 1] : chanTop0; }
    function laneOff(chan){ var c = chan.use++; return ((c % 2 === 0) ? -1 : 1) * Math.ceil(c / 2) * 4; }
    // 竖直廊道：相邻列间隙中点 + 盒边距外侧（远距离线的干线）
    var cols = [];
    sibs.slice().sort(function(a, b){ return a.cx - b.cx; }).forEach(function(g){
      var last = cols[cols.length - 1];
      if(last && Math.abs(last.x - g.cx) < 60) last.items.push(g);
      else cols.push({ x: g.cx, items: [g] });
    });
    cols.forEach(function(c){
      c.left = Math.min.apply(null, c.items.map(function(i){ return i.left; }));
      c.right = Math.max.apply(null, c.items.map(function(i){ return i.right; }));
    });
    var corridors = [];
    for(var ci = 0; ci < cols.length - 1; ci++) corridors.push({ x: (cols[ci].right + cols[ci + 1].left) / 2, use: 0 });
    if(p._box){
      corridors.unshift({ x: p._x - p._box.w / 2 + 8, use: 0 });
      corridors.push({ x: p._x + p._box.w / 2 - 8, use: 0 });
    } else {
      corridors.unshift({ x: Math.min.apply(null, sibs.map(function(i){ return i.left; })) - 14, use: 0 });
    }
    // 第一遍：分类
    var plans = [];
    fes.forEach(function(fe){
      if(!fe.a || !fe.b || fe.a._x == null || fe.b._x == null) return;
      var A = geo(fe.a), B = geo(fe.b);
      var ri = rowOf(A), rj = rowOf(B);
      if(ri < 0 || rj < 0) return;
      var pl = { fe: fe, A: A, B: B, ex: 'bot', en: 'top', chan: null };
      if(ri === rj){
        var blocking = rows[ri].items.filter(function(s){ return s.cx > Math.min(A.cx, B.cx) && s.cx < Math.max(A.cx, B.cx); });
        if(B.cx > A.cx && !blocking.length){ pl.ex = 'right'; pl.en = 'left'; }
        else { pl.chan = chanBelow[ri]; pl.en = 'bot'; }
      } else if(rj === ri + 1){ pl.chan = chanBelow[ri]; }
      else if(rj === ri - 1){ pl.chan = chanBelow[rj]; pl.ex = 'top'; pl.en = 'bot'; }
      else {
        pl.far = true;
        pl.chanA = chanBelow[ri];
        pl.chanB = chanAbove(rj);
        var mid = (A.cx + B.cx) / 2, best = null;
        corridors.forEach(function(co){ if(!best || Math.abs(co.x - mid) < Math.abs(best.x - mid)) best = co; });
        pl.cor = best;
        pl.corOff = ((best.use % 2 === 0) ? -1 : 1) * Math.ceil(best.use / 2) * 4; best.use++;
      }
      plans.push(pl);
      if(window.__DBG__){ console.log('  plan', (pl.A.n.id||'?'), '->', (pl.B.n.id||'?'), 'ri', ri, 'rj', rj, 'ex', pl.ex, 'en', pl.en, 'far', !!pl.far, 'chan', pl.chan ? Math.round(pl.chan.y) : (pl.chanA ? Math.round(pl.chanA.y) + '/' + Math.round(pl.chanB.y) : '-')); }
    });
    // 第二遍：出入口展宽统计（同一卡同侧多线 → 横向错开）
    var ports = {};
    plans.forEach(function(pl){
      [ [pl.A, pl.ex], [pl.B, pl.en] ].forEach(function(t){
        var key = t[0].n.id + '|' + t[1];
        (ports[key] = ports[key] || []).push(pl);
      });
    });
    function portX(g, side, pl){
      var arr = ports[g.n.id + '|' + side] || [pl];
      var off = (arr.indexOf(pl) - (arr.length - 1) / 2) * 14;
      return Math.max(g.left + 8, Math.min(g.right - 8, g.cx + off));
    }
    // 第三遍：先收集所有线段（正交 M/H/V）；标签=线牌（骑线优先 → 贴立柱 → 行上方兜底）
    var out = '', labels = [];
    plans.forEach(function(pl){
      var A = pl.A, B = pl.B, segs = [];
      function seg(x1, y1, x2, y2){ segs.push([x1, y1, x2, y2]); }
      if(pl.ex === 'right' && pl.en === 'left'){
        var yy = A.cy;
        seg(A.right, yy, B.left, yy);
      } else if(pl.far){
        var ay = pl.chanA.y + laneOff(pl.chanA), by = pl.chanB.y + laneOff(pl.chanB);
        var mx = pl.cor.x + pl.corOff;
        var ax = portX(A, 'bot', pl), bx = portX(B, 'top', pl);
        seg(ax, A.bot, ax, ay); seg(ax, ay, mx, ay); seg(mx, ay, mx, by); seg(mx, by, bx, by); seg(bx, by, bx, B.top);
      } else {
        var cy = pl.chan.y + laneOff(pl.chan);
        var x1 = portX(A, pl.ex, pl), y1 = pl.ex === 'bot' ? A.bot : A.top;
        var x2 = portX(B, pl.en, pl), y2 = pl.en === 'top' ? B.top : B.bot;
        seg(x1, y1, x1, cy); seg(x1, cy, x2, cy); seg(x2, cy, x2, y2);
      }
      pl.segs = segs;
      if(pl.fe.label){
        var w2 = pl.fe.label.length * 10.4 + 12;
        var riA = rowOf(A), rowTop = riA >= 0 ? rows[riA].top : A.top;
        var lastBot = rows[rows.length - 1].bot;
        var cands = [];
        var hRun = null;
        segs.forEach(function(s){
          var dx = Math.abs(s[2] - s[0]), dy = Math.abs(s[3] - s[1]);
          if(dy < 0.5 && dx >= 8){
            if(!hRun || dx > Math.abs(hRun[2] - hRun[0])) hRun = s;
            [0.5, 0.32, 0.68].forEach(function(fr){
              var below = s[1] > lastBot - 1; // 末行下方通道：牌挂线下侧，不折回压卡
              cands.push({ x: s[0] + (s[2] - s[0]) * fr, y: s[1], mode: below ? 'below' : 'above', pri: dx });
            });
          } else if(dx < 0.5 && dy >= 10){
            var my = (s[1] + s[3]) / 2;
            cands.push({ x: s[0] + 6 + w2 / 2, y: my, mode: 'beside', pri: dy * 0.6 });
            cands.push({ x: s[0] - 6 - w2 / 2, y: my, mode: 'beside', pri: dy * 0.6 - 1 });
          }
        });
        if(hRun){ // 骑不住线的短连接：牌放到本行上方的线槽里
          [0.5, 0.32, 0.68].forEach(function(fr){
            cands.push({ x: hRun[0] + (hRun[2] - hRun[0]) * fr, y: rowTop - 12, mode: 'above', pri: 6 });
          });
        }
        labels.push({ t: pl.fe.label, w: w2, cands: cands });
      }
    });
    // 跳线（wire hop，电路图经典手法）：不同连线的水平段与垂直段相交处，横线断开、
    // 上拱小半圆跨过竖线（半径 4.5px）——竖线保持直线，视觉上"跨过"而非"相连"
    var HOP_R = 4.5, hops = {};
    plans.forEach(function(pl, ei){
      plans.forEach(function(q, ej){
        if(ei === ej) return;
        pl.segs.forEach(function(hs){
          if(Math.abs(hs[3] - hs[1]) > 0.5) return; // 只处理水平段
          q.segs.forEach(function(vs){
            if(Math.abs(vs[2] - vs[0]) > 0.5) return; // 只处理垂直段
            var y = hs[1], x = vs[0];
            if(Math.abs(x - hs[0]) < HOP_R + 2 || Math.abs(x - hs[2]) < HOP_R + 2) return; // 太贴横线端点：不跳
            if(Math.min(vs[1], vs[3]) + HOP_R + 2 > y || Math.max(vs[1], vs[3]) - HOP_R - 2 < y) return; // 太贴竖线端点：不跳
            if(x < Math.min(hs[0], hs[2]) || x > Math.max(hs[0], hs[2])) return;
            if(y < Math.min(vs[1], vs[3]) || y > Math.max(vs[1], vs[3])) return;
            (hops[ei] = hops[ei] || []).push(x);
          });
        });
      });
    });
    // 水平段 path 片段：行进方向上逐个跨过交点（向右 sweep=1 上拱；向左 sweep=0 上拱）
    function hSegPath(x1, y, x2, ei){
      var dir = x2 >= x1 ? 1 : -1;
      var xs = (hops[ei] || []).filter(function(x){
        return dir > 0 ? (x > x1 + HOP_R + 2 && x < x2 - HOP_R - 2) : (x < x1 - HOP_R - 2 && x > x2 + HOP_R + 2);
      }).sort(function(a, b){ return dir > 0 ? a - b : b - a; });
      var d = '';
      xs.forEach(function(x){
        d += ' H ' + (x - dir * HOP_R) + ' A ' + HOP_R + ' ' + HOP_R + ' 0 0 ' + (dir > 0 ? 1 : 0) + ' ' + (x + dir * HOP_R) + ' ' + y;
      });
      return d + ' H ' + x2;
    }
    // 拼 d 输出（水平段带跳弧；箭头 marker 不受影响）
    plans.forEach(function(pl, ei){
      var segs = pl.segs;
      if(!segs.length) return;
      var d = 'M ' + segs[0][0] + ' ' + segs[0][1];
      segs.forEach(function(s){
        if(Math.abs(s[3] - s[1]) < 0.5) d += hSegPath(s[0], s[1], s[2], ei);
        else d += ' V ' + s[3];
      });
      out += '<path d="'+d+'" fill="none" stroke="#15aabf" stroke-width="1.8" opacity=".78" marker-end="url(#arrowFlow)"/>';
    });
    // 线牌全局落位：贪心选第一个不与已放牌/卡块冲突的候选（电工挂牌：先近线，冲突则顺线挪）
    var placedR = [];
    function rectOf(c, w){
      if(c.mode === 'beside') return { x1: c.x - w / 2, y1: c.y - 9, x2: c.x + w / 2, y2: c.y + 9 };
      if(c.mode === 'below') return { x1: c.x - w / 2, y1: c.y + 2, x2: c.x + w / 2, y2: c.y + 20 };
      return { x1: c.x - w / 2, y1: c.y - 20, x2: c.x + w / 2, y2: c.y - 2 };
    }
    function hitBlock(r){
      for(var i = 0; i < sibs.length; i++){
        var b = sibs[i];
        if(r.x1 < b.right - 2 && r.x2 > b.left + 2 && r.y1 < b.bot - 2 && r.y2 > b.top + 2) return true;
      }
      return false;
    }
    labels.forEach(function(L){
      L.cands.sort(function(a, b){ return b.pri - a.pri; });
      var pick = null;
      L.cands.forEach(function(c){
        if(pick) return;
        var r = rectOf(c, L.w);
        var clash = placedR.some(function(p){ return r.x1 < p.x2 - 1.5 && r.x2 > p.x1 + 1.5 && r.y1 < p.y2 - 1.5 && r.y2 > p.y1 + 1.5; });
        if(!clash && !hitBlock(r)){ pick = c; placedR.push(r); }
      });
      if(!pick){ pick = L.cands[0]; placedR.push(rectOf(pick, L.w)); } // 兜底：冲突也放（至少不丢标签）
      L.at = pick;
    });
    labels.forEach(function(L){
      var r = rectOf(L.at, L.w), lx = (r.x1 + r.x2) / 2, ly = (r.y1 + r.y2) / 2;
      out += '<rect x="'+r.x1+'" y="'+r.y1+'" width="'+L.w+'" height="18" rx="9" fill="#e3fafc" stroke="#66d9e8" stroke-width="1" opacity=".96"/>'
        + '<text x="'+lx+'" y="'+(ly + 4)+'" text-anchor="middle" font-size="10" font-weight="600" fill="#0b7285" paint-order="stroke" stroke="#ffffff" stroke-width="2.5">'+esc(L.t)+'</text>';
    });
    return out;
  }

  // ── 递归收纳盒布局（盒中盒）：root=大容器 → 功能盒 → 子模块盒 → 文件卡 ──
  // 任何有可见子级的节点都是盒（标题卡置顶 + 内容区行流式排列）；叶子是卡。
  // 归属关系完全由嵌套表达（盒内不画父子线）；行间 gap=线槽（gutter），给 FLOWS 电工布线留通道。
  // 深度分级参数：越深的盒 padding/间距越小，视觉层层收敛。
  var DEPTH_PAD = [
    { x: 22, head: 30, gap: 46, col: 22, b: 26, maxRow: 700 }, // depth0 root 大容器（模块矩阵排布）
    { x: 16, head: 34, gap: 56, col: 14, b: 36, maxRow: 660 },  // depth1 功能盒
    { x: 10, head: 18, gap: 40, col: 10, b: 16, maxRow: 620 }   // depth2 子模块盒
  ];
  function padOf(depth){ return DEPTH_PAD[Math.min(depth, DEPTH_PAD.length - 1)]; }
  function layoutTree(){
    orderAll(TREE);
    // 递归测尺：叶子=卡 {w,h}；分支=盒 {w,h}（行流式，行内垂直居中）
    function boxSize(n, depth){
      var hw = nodeW(n), hh = nodeH(n);
      n._w = hw; n._h = hh;
      var kids = visChildren(n);
      if(!kids.length){ n._box = null; return { w: hw, h: hh }; }
      var P = padOf(depth);
      // 工厂产线布局：步骤水平排列为工序盒，IN/OUT 槽在两端
      if(n._factory){
        var ff = facFloorSize(n);
        ff.steps.forEach(function(s){
          s._w = FAC.machW;
          s._h = s._facH || facMachH(s);
          s._facBaseH = facBaseH(s);
          s._box = null;
        });
        n._facFloor = ff;
        var fiW = ff.w, fiH = ff.h;
        n._box = { w: Math.max(hw, fiW) + P.x * 2, h: hh + P.head + fiH + P.b, factory: true, rows: [], hh: hh, hw: hw };
        return { w: n._box.w, h: n._box.h };
      }
      var rows = [{ items: [], w: 0, h: 0 }];
      kids.forEach(function(c){
        var cb = boxSize(c, depth + 1);
        var row = rows[rows.length - 1];
        if(row.items.length && row.w + P.col + cb.w > P.maxRow){
          rows.push({ items: [], w: 0, h: 0 });
          row = rows[rows.length - 1];
        }
        row.items.push({ c: c, w: cb.w, h: cb.h });
        row.w += (row.items.length > 1 ? P.col : 0) + cb.w;
        row.h = Math.max(row.h, cb.h);
      });
      var innerW = 0, innerH = 0;
      rows.forEach(function(r, i){ if(r.w > innerW) innerW = r.w; innerH += r.h + (i ? P.gap : 0); });
      n._box = { w: Math.max(hw, innerW) + P.x * 2, h: hh + P.head + innerH + P.b, rows: rows, hh: hh, hw: hw };
      return { w: n._box.w, h: n._box.h };
    }
    // 递归放置：盒头卡置顶居中，内容区行流式（行内垂直居中）
    function boxPlace(n, left, top, depth){
      var b = n._box;
      if(!b){ n._x = left + n._w / 2; n._y = top + n._h / 2; return; }
      n._x = left + b.w / 2;
      n._y = top + b.hh / 2;
      var P = padOf(depth);
      var ry = top + b.hh + P.head;
      // 工厂产线放置：工序水平排列
      if(b.factory){
        var ff = n._facFloor;
        var floorX = left + (b.w - ff.w) / 2 + FAC.floorPadX;
        var floorTop = ry + FAC.floorPadTop;
        n._facFloorX = floorX;
        n._facFloorTop = floorTop;
        // IN 槽
        n._facInSlot = { x: floorX, y: floorTop + (ff.maxH - FAC.slotH) / 2, w: FAC.slotW, h: FAC.slotH };
        // 工序机
        var firstMachX = floorX + FAC.slotW + FAC.slotGap;
        ff.steps.forEach(function(s, i){
          var mh = s._facH || facMachH(s);
          var m = { x: firstMachX + i * (FAC.machW + FAC.machGap), y: floorTop + (ff.maxH - mh) / 2, w: FAC.machW, h: mh, baseH: facBaseH(s) };
          s._facMach = m;
          s._x = m.x + m.w / 2;
          s._y = m.y + m.h / 2;
        });
        // OUT 槽
        var lastRight = firstMachX + (ff.steps.length - 1) * (FAC.machW + FAC.machGap) + FAC.machW;
        n._facOutSlot = { x: lastRight + FAC.slotGap, y: floorTop + (ff.maxH - FAC.slotH) / 2, w: FAC.slotW, h: FAC.slotH };
        return;
      }
      b.rows.forEach(function(row){
        var cx = left + (b.w - row.w) / 2;
        row.items.forEach(function(it){
          boxPlace(it.c, cx, ry, depth + 1);
          cx += it.w + P.col;
        });
        ry += row.h + P.gap;
      });
    }
    boxSize(TREE, 0);
    boxPlace(TREE, 0, 0, 0);
  }

  // ── 渲染 ──
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function wrap(s, n){
    s = String(s||''); var out = [];
    while(s.length > n && out.length < 4){ out.push(s.slice(0,n)); s = s.slice(n); }
    if(out.length < 4) out.push(s);
    return out;
  }
  function cssId(s){ return String(s).replace(/[^a-zA-Z0-9_-]/g,'_'); }

  // ── 工厂产线渲染：工序机（标题带+针脚行+文件底栏+展开详情）──
  function facPinSq(x, y){
    return '<rect class="fac-pin-sq" x="'+(x-FAC.pinSize/2)+'" y="'+(y-FAC.pinSize/2)+'" width="'+FAC.pinSize+'" height="'+FAC.pinSize+'" rx="2"/>';
  }
  function renderFacMachine(s){
    var m = s._facMach; if(!m) return '';
    var isOpen = !!s._facOpen;
    var ins = s._facIns || [], outs = s._facOuts || [];
    var involves = (s.raw && s.raw.meta && s.raw.meta.involves) || s.raw.involves || [];
    var g = '<g class="mnode fac-mnode'+(SEL===s.id?' sel':'')+'" data-id="'+esc(s.id)+'">';
    // 机器框
    g += '<rect class="fac-mach" x="'+m.x+'" y="'+m.y+'" width="'+m.w+'" height="'+m.h+'" rx="9"/>';
    // 标题带
    g += '<path class="fac-mach-hd" d="M'+(m.x+9)+' '+(m.y+1)+' h'+(m.w-18)+' a8 8 0 0 1 8 8 v'+(FAC.hdH-10)+' h'+(-m.w)+' v'+(-(FAC.hdH-10))+' a8 8 0 0 1 8-8 z"/>';
    g += '<text class="fac-mach-title" x="'+(m.x+12)+'" y="'+(m.y+17)+'">'+esc(s.label)+'</text>';
    // 展开按钮
    if(s.raw && (s.raw.detail || s.raw.description)){
      g += '<text class="fac-btn" data-fac="'+esc(s.id)+'" x="'+(m.x+m.w-10)+'" y="'+(m.y+17)+'" text-anchor="end">'+(isOpen?'△ 收纳':'▽ 展开')+'</text>';
    }
    // IN 针脚：方块贴左边框，名字 : 类型紧跟右侧
    ins.forEach(function(p, i){
      var py = facPinY(m, i);
      g += facPinSq(facInX(m), py);
      g += '<text x="'+(m.x+FAC.padL+FAC.pinSize)+'" y="'+(py+4)+'">'
        + '<tspan class="fac-pin-name">'+esc(p.n)+'</tspan>'
        + '<tspan class="fac-pin-type"> : '+esc(p.t)+'</tspan></text>';
    });
    // OUT 针脚：方块贴右边框，类型 : 名字右对齐
    outs.forEach(function(p, i){
      var py = facPinY(m, i);
      g += facPinSq(facOutX(m), py);
      g += '<text class="fac-pin-type-out" x="'+(m.x+m.w-FAC.padR-FAC.pinSize)+'" y="'+(py+4)+'">'
        + '<tspan class="fac-pin-type">'+esc(p.t)+' : </tspan>'
        + '<tspan class="fac-pin-name">'+esc(p.n)+'</tspan></text>';
    });
    // 文件底栏分隔线 + 文件名
    var fileY = m.y + m.baseH - FAC.fileH + 4;
    g += '<line x1="'+(m.x+10)+'" y1="'+fileY+'" x2="'+(m.x+m.w-10)+'" y2="'+fileY+'" stroke="#e2e8f0"/>';
    var fileText = involves.length ? involves.join(' · ') : '—';
    g += '<text class="fac-file" x="'+(m.x+12)+'" y="'+(m.y+m.baseH-7)+'">'+esc(fileText)+'</text>';
    // 展开详情
    if(isOpen && s.raw){
      var dy = m.y + m.baseH;
      g += '<line x1="'+(m.x+10)+'" y1="'+dy+'" x2="'+(m.x+m.w-10)+'" y2="'+dy+'" stroke="#cde6ea"/>';
      var d = String(s.raw.detail || s.raw.description || '');
      var ls = wrap(d, 20);
      ls.forEach(function(ln, li){
        g += '<text class="fac-detail" x="'+(m.x+14)+'" y="'+(dy+FAC.detailPadTop+11+li*FAC.detailLineH)+'">· '+esc(ln)+'</text>';
      });
      // 叙事分镜折叠面板（manim 式：进料口→工序→出料口；facts 逐条来自契约投影、非 LLM 编造）
      var narr = (s.raw.meta && s.raw.meta.narration) || [];
      if(narr.length){
        var nY = dy + FAC.detailPadTop + ls.length * FAC.detailLineH + FAC.detailPadBot;
        g += '<line x1="'+(m.x+10)+'" y1="'+nY+'" x2="'+(m.x+m.w-10)+'" y2="'+nY+'" stroke="#e8f0f2"/>';
        g += '<text class="fac-narr-hd" x="'+(m.x+14)+'" y="'+(nY+17)+'">▍讲述（叙事砖 · 数据=契约投影）</text>';
        nY += 24;
        narr.forEach(function(sc){
          var dl = wrap(sc.detail || '', 22);
          g += '<text class="fac-narr-title" x="'+(m.x+16)+'" y="'+(nY+11)+'">◆ '+esc(sc.title)+'</text>';
          nY += FAC.detailLineH + 2;
          dl.forEach(function(ln, li){
            g += '<text class="fac-narr-detail" x="'+(m.x+28)+'" y="'+(nY+11)+'">'+esc(ln)+'</text>';
            nY += FAC.detailLineH;
          });
          if(sc.facts.length){
            g += '<text class="fac-narr-facts" x="'+(m.x+28)+'" y="'+(nY+11)+'">'+esc(sc.facts.join('　'))+'</text>';
            nY += FAC.detailLineH + 5;
          }
        });
      }
    }
    // 序号徽标（左上角）
    if(s._flowSeq){
      g += '<g transform="translate('+(m.x+2)+','+(m.y-8)+')">'
        + '<circle class="fac-seq-bg" r="9"/>'
        + '<text class="fac-seq" y="3.5" text-anchor="middle">'+s._flowSeq+'</text></g>';
    }
    g += '</g>';
    return g;
  }

  // ── 工厂产线正交连线：水平连接（左→右），线只连针脚方块，无文字 ──
  function facOrthWire(x1, y1, x2, y2){
    var mx = (x1 + x2) / 2;
    return '<path class="fac-wire" d="M'+x1+' '+y1+' L'+mx+' '+y1+' L'+mx+' '+y2+' L'+x2+' '+y2+'"/>'
      + '<polygon class="fac-wirehead" points="'+x2+','+y2+' '+(x2-6)+','+(y2-3.5)+' '+(x2-6)+','+(y2+3.5)+'"/>';
  }
  // ── 工厂产线渲染：连线层（底板+IN/OUT槽+正交线，在节点下方）──
  function renderFactoryWires(group){
    var ff = group._facFloor; if(!ff) return '';
    var inSlot = group._facInSlot, outSlot = group._facOutSlot;
    var steps = ff.steps;
    var out = '';
    // 产线底板虚线（不透明背景在 wbox 中画，层级更高可遮挡穿线）
    var bx = group._facFloorX - FAC.floorPadX, by = group._facFloorTop - FAC.floorPadTop;
    out += '<rect class="fac-bound" x="'+bx+'" y="'+by+'" width="'+ff.w+'" height="'+ff.h+'" rx="10"/>';
    // IN 槽
    out += '<g><rect class="fac-slot-in" x="'+inSlot.x+'" y="'+inSlot.y+'" width="'+inSlot.w+'" height="'+inSlot.h+'" rx="9"/>'
      + '<text class="fac-slot-t" x="'+(inSlot.x+12)+'" y="'+(inSlot.y+20)+'">投料口</text>'
      + '<text class="fac-slot-sub" x="'+(inSlot.x+12)+'" y="'+(inSlot.y+38)+'">IN</text></g>';
    // OUT 槽
    out += '<g><rect class="fac-slot-out" x="'+outSlot.x+'" y="'+outSlot.y+'" width="'+outSlot.w+'" height="'+outSlot.h+'" rx="9"/>'
      + '<text class="fac-slot-t" x="'+(outSlot.x+12)+'" y="'+(outSlot.y+20)+'">成品出口</text>'
      + '<text class="fac-slot-sub" x="'+(outSlot.x+12)+'" y="'+(outSlot.y+38)+'">OUT</text></g>';
    // 正交连线
    if(steps.length){
      var m0 = steps[0]._facMach;
      out += facOrthWire(inSlot.x + inSlot.w, inSlot.y + inSlot.h / 2, facInX(m0), facPinY(m0, 0));
      for(var i = 0; i < steps.length - 1; i++){
        var a = steps[i]._facMach, b = steps[i+1]._facMach;
        var sa = steps[i]._facOuts || [], sb = steps[i+1]._facIns || [];
        var cnt = Math.min(sa.length, sb.length);
        if(!cnt) cnt = 1;
        for(var k = 0; k < cnt; k++){
          out += facOrthWire(facOutX(a), facPinY(a, k), facInX(b), facPinY(b, k));
        }
      }
      var last = steps[steps.length - 1]._facMach;
      out += facOrthWire(facOutX(last), facPinY(last, 0), outSlot.x, outSlot.y + outSlot.h / 2);
    }
    return out;
  }
  // ── 工厂产线渲染：机器层（工序卡白底盖住连线末端）──
  function renderFactoryMachines(group){
    var ff = group._facFloor; if(!ff) return '';
    var out = '';
    ff.steps.forEach(function(s){ out += renderFacMachine(s); });
    return out;
  }

  function renderAll(){
    var E = document.getElementById('edges'), N = document.getElementById('nodes'), G = document.getElementById('notes'), FL = document.getElementById('flowlayer');
    E.innerHTML = ''; N.innerHTML = ''; G.innerHTML = ''; FL.innerHTML = '';
    var edges = '', nodes = '', boxes = '', flowSvg = '';
    // 收纳盒底板（画在最底层，递归全树）：深度分级着色——
    //   root=大容器淡靛虚线 / 功能盒=蓝（构想紫虚线、共享绿）/ 子模块盒=青（步骤组黄）/ 更深=灰蓝
    (function wbox(n, depth){
      if(n._box){ // root 大容器也画底板（最外层包裹：项目 → 功能盒 → 子模块盒 → 文件卡）
        var bx = n._x - n._box.w / 2, by = n._y - n._box.hh / 2;
        var st, rx, sw;
        if(n._factory){
          // 工厂产线步骤组：不画黄色收纳盒，改用米色不透明底板遮挡穿线
          var fbx = n._facFloorX - FAC.floorPadX, fby = n._facFloorTop - FAC.floorPadTop;
          var ff = n._facFloor;
          if(ff) boxes += '<rect class="fac-floor-bg" x="'+fbx+'" y="'+fby+'" width="'+ff.w+'" height="'+ff.h+'" rx="10"/>';
        } else if(depth <= 0){ // root 大容器
          st = 'fill="rgba(159,176,255,.05)" stroke="#91a7ff" stroke-dasharray="14 8"'; rx = 24; sw = 2;
        } else if(depth === 1){ // 功能盒：构想=紫虚线、共享=绿、积木区=紫实线、功能=蓝
          rx = 16; sw = 1.6;
          st = n.kind === 'proposal'
            ? 'fill="rgba(208,191,255,.16)" stroke="#9775fa" stroke-dasharray="10 6"'
            : ((n.raw && n.raw.id === 'bricks')
              ? 'fill="rgba(208,191,255,.16)" stroke="#9775fa"'
              : (n.kind === 'shared'
                ? 'fill="rgba(211,249,216,.20)" stroke="#69db7c"'
                : 'fill="rgba(165,216,255,.13)" stroke="#74c0fc"'));
        } else { // 子模块盒：社区=青、步骤组=黄
          rx = 10; sw = 1.3;
          st = n.kind === 'stepgroup'
            ? 'fill="rgba(255,243,191,.22)" stroke="#f59f00"'
            : 'fill="rgba(197,246,250,.16)" stroke="#3bc9db"';
        }
        if(st) boxes += '<rect x="'+bx+'" y="'+by+'" width="'+n._box.w+'" height="'+n._box.h+'" rx="'+rx+'" '+st+' stroke-width="'+sw+'"/>';
      }
      visChildren(n).forEach(function(c){ wbox(c, depth + 1); });
    })(TREE, 0);
    (function walk(n, parent, noEdge){
      // 工厂产线步骤组：渲染产线底板+槽+连线（在 edges 层，节点之下）+ 工序机（在 nodes 层）
      if(n._factory){
        nodes += renderNode(n); // 步骤组自身的标题卡
        edges += renderFactoryWires(n);
        nodes += renderFactoryMachines(n);
        return; // 子步骤已作为工序机渲染，不再递归
      }
      if(parent && !noEdge){
        var x1 = parent._x + parent._w / 2, y1 = parent._y, x2 = n._x - n._w / 2, y2 = n._y;
        var mx = (x1 + x2) / 2;
        edges += '<path d="M '+x1+' '+y1+' C '+mx+' '+y1+', '+mx+' '+y2+', '+x2+' '+y2+'" fill="none" stroke="'+(n.kind==='user' ? 'rgba(230,119,0,.55)' : (n.kind==='feature' ? '#4dabf7' : '#adb5bd'))+'" stroke-width="'+(n.kind==='feature'?2.6:(n.kind==='user'?1.6:1.8))+'"/>';
      }
      nodes += renderNode(n);
      // 流转连线：电工式正交布线（横平竖直、错道不重叠、跳线 hop），画在顶层 flowlayer
      if(n._flowEdges){ flowSvg += routeFlows(n); }
      var skip = !!(parent && parent._box); // 盒内直属卡不画父子连线：装进盒子即归属（全层级生效）
      visChildren(n).forEach(function(c){ walk(c, n, skip); });
    })(TREE, null, false);
    N.innerHTML = boxes + nodes;
    E.innerHTML = edges;
    FL.innerHTML = flowSvg;
    renderDeps();
    // 便签：锚定目标节点右侧偏下堆叠（有 pos 用 pos）
    var perTarget = {};
    ANNS.forEach(function(a){ (perTarget[a.target_id] = perTarget[a.target_id] || []).push(a); });
    Object.keys(perTarget).forEach(function(tid){
      var t = NODE_BY_ID[tid]; if(!t || t._x == null) return; // 目标未上树（空壳清理/折叠）：便签不渲染
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
        g.innerHTML = '<rect x="0" y="'+(-h/2)+'" width="'+w+'" height="'+h+'" rx="3" fill="#fff9b2" stroke="#e67700" stroke-width="1.4"/>'
          + '<path d="M '+(w-10)+' '+(-h/2)+' L '+w+' '+(-h/2+10)+' L '+w+' '+(-h/2)+' Z" fill="#ffd43b" stroke="#e67700" stroke-width="1"/>'
          + '<text x="'+(w/2)+'" y="'+(-h/2+15)+'" text-anchor="middle" font-size="10" fill="#a05a00">✍️ 批注</text>'
          + ls2.map(function(ln, li){
              return '<text x="'+(w/2)+'" y="'+(-h/2+32+li*15)+'" text-anchor="middle" font-size="11" fill="#664d00">'+esc(ln)+'</text>';
            }).join('');
        G.appendChild(g);
        edges += '';
        E.innerHTML += '<line class="nline-'+cssId(a.id)+'" x1="'+a._x+'" y1="'+a._y+'" x2="'+(t._x + t._w/2)+'" y2="'+t._y+'" stroke="rgba(230,119,0,.5)" stroke-width="1.3" stroke-dasharray="5 4"/>';
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
      // 盒中盒布局：弧从功能盒顶部出发，绕 root 大容器上方外侧走——不穿任何盒
      var x1 = a._x, y1 = (a._box ? a._y - a._box.hh / 2 : a._y - a._h / 2) - 12;
      var x2 = b._x, y2 = (b._box ? b._y - b._box.hh / 2 : b._y - b._h / 2) - 12;
      // 扇形错开：每条弧的控制点逐条上移，弧线不互相叠压；绕行高度基于 root 大容器顶缘
      var cy = (TREE._box ? TREE._y - TREE._box.hh / 2 : TREE._y - TREE._h / 2) - 60 - (idx % 5) * 22;
      var cx = (x1 + x2) / 2;
      var sw = d._pred ? 1.6 : Math.min(1.3 + d.weight / 12, 3.6);
      var path = document.createElementNS('http://www.w3.org/2000/svg','path');
      path.setAttribute('d','M '+x1+' '+y1+' C '+cx+' '+cy+', '+cx+' '+cy+', '+x2+' '+y2);
      path.setAttribute('fill','none');
      path.setAttribute('stroke', d._pred ? 'rgba(122,78,212,.6)' : 'rgba(232,89,12,.65)');
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
        var p = bezPoint(x1, y1, cx, cy, x2, y2, cands[ci]);
        if (noClash(p)) { pt = p; break; }
      }
      if (!pt) {
        pt = bezPoint(x1, y1, cx, cy, x2, y2, 0.3);
        pt = { x: pt.x, y: pt.y - 16 * (1 + Math.floor(placedPts.length / 4)) };
      }
      placedPts.push(pt);
      var t = document.createElementNS('http://www.w3.org/2000/svg','text');
      t.setAttribute('x', pt.x); t.setAttribute('y', pt.y - 6);
      t.setAttribute('text-anchor','middle'); t.setAttribute('font-size','9.5');
      t.setAttribute('fill', d._pred ? '#5f3dc4' : '#a33d00');
      t.setAttribute('paint-order','stroke'); t.setAttribute('stroke','#ffffff'); t.setAttribute('stroke-width','3');
      t.textContent = d._pred ? '预判' : '×' + d.weight;
      G.appendChild(t);
    });
  }
  function showDep(d){
    var det = document.getElementById('detail');
    if(d._pred){
      det.innerHTML = '<b style="color:#6741d9;">🔮 预判依赖</b>'
        + '<p>' + esc(d.from) + ' <b style="color:#6741d9;">可能踩着</b> ' + esc(d.to) + '</p>'
        + '<p style="font-size:11px;color:#868e96;">构想尚未实现，这是 AI 按现有结构预判的依赖（紫色弧）；真实调用证据画橙色弧。</p>';
      det.style.display = 'block';
      return;
    }
    var via = (d.via_files && d.via_files.length)
      ? '<p class="files">主要打向：' + d.via_files.map(esc).join(' · ') + '</p>' : '';
    det.innerHTML = '<b style="color:#a33d00;">🔗 功能依赖</b>'
      + '<p>' + esc(d.from) + ' <b style="color:#a33d00;">踩着</b> ' + esc(d.to) + '（真实调用 ×' + d.weight + ' 次）</p>'
      + via
      + '<p style="font-size:11px;color:#868e96;">依赖不占树的层级（归属归归属、依赖归依赖），橙色虚线单独表达"什么撑着什么"。</p>';
    det.style.display = 'block';
  }
  function renderNode(n){
    var ls = nodeLines(n), ds = descLines(n), w = n._w, h = nodeH(n), x = n._x - w/2, y = n._y - h/2;
    var s = '<g class="mnode'+(SEL===n.id?' sel':'')+'" data-id="'+esc(n.id)+'" transform="translate('+n._x+','+n._y+')">';
    if(n.kind === 'root'){
      s += '<rect x="'+(-w/2)+'" y="'+(-h/2)+'" width="'+w+'" height="'+h+'" rx="'+(h/2)+'" fill="#a5d8ff" stroke="#1971c2" stroke-width="2.4"/>';
    } else if(n.kind === 'feature'){
      s += '<rect x="'+(-w/2)+'" y="'+(-h/2)+'" width="'+w+'" height="'+h+'" rx="13" fill="#d0ebff" stroke="#1971c2" stroke-width="2"/>';
      if(FOUNDATIONS.indexOf(n.label) >= 0){ // 底座徽章：基建不占兄弟名目，但一眼可见
        s += '<g transform="translate('+(-w/2+2)+','+(-h/2-9)+')">'
          + '<rect x="0" y="-10" width="62" height="18" rx="9" fill="#ffd8a8" stroke="#e8590c" stroke-width="1.2"/>'
          + '<text x="31" y="3" text-anchor="middle" font-size="10" font-weight="700" fill="#a33d00">🧱 底座</text></g>';
      }
      // 分镜权威标记：pending=尚未生成 AI 分镜（占位），必须醒目提示，绝不平铺成已完成的科普
      if(n.meta && n.meta.storyboard === 'pending'){
        s += '<g transform="translate('+(w/2-74)+','+(-h/2-9)+')">'
          + '<rect x="0" y="-10" width="72" height="18" rx="9" fill="#fff5f5" stroke="#e03131" stroke-width="1.3"/>'
          + '<text x="36" y="2.5" text-anchor="middle" font-size="9.5" font-weight="700" fill="#c92a2a">🤖 待AI讲解</text></g>';
      }
    } else if(n.kind === 'step'){
      s += '<rect x="'+(-w/2)+'" y="'+(-h/2)+'" width="'+w+'" height="'+h+'" rx="'+(h/2)+'" fill="#ffec99" stroke="#f08c00" stroke-width="1.4"/>';
    } else if(n.kind === 'stepgroup'){
      // 工作步骤组：把"怎么实现的"归成一组，与结构层（子模块/文件）分开
      s += '<rect x="'+(-w/2)+'" y="'+(-h/2)+'" width="'+w+'" height="'+h+'" rx="11" fill="#fff3bf" stroke="#f59f00" stroke-width="1.5"/>'
        + (n.meta && n.meta.pending
          ? '<text y="'+(-h/2+12)+'" text-anchor="middle" font-size="8.5" fill="#e03131">🤖 待生成分镜</text>'
          : '<text y="'+(-h/2+12)+'" text-anchor="middle" font-size="8.5" fill="#a06200">⚙️ 步骤</text>');
    } else if(n.kind === 'community'){
      // 子模块（聚类社区）：功能的真实构成单元，文件挂在它下面
      s += '<rect x="'+(-w/2)+'" y="'+(-h/2)+'" width="'+w+'" height="'+h+'" rx="11" fill="#c5f6fa" stroke="#0c8599" stroke-width="1.5"/>'
        + '<text y="'+(-h/2+12)+'" text-anchor="middle" font-size="8.5" fill="#0b7285">🧩 子模块</text>';
    } else if(n.kind === 'shared'){
      s += '<rect x="'+(-w/2)+'" y="'+(-h/2)+'" width="'+w+'" height="'+h+'" rx="'+(h/2)+'" fill="#d3f9d8" stroke="#2f9e44" stroke-width="1.6"/>'
        + '<text y="'+(-h/2+13)+'" text-anchor="middle" font-size="8.5" fill="#2b8a3e">🔧 共享</text>';
    } else if(n.kind === 'brick'){
      // 积木黑盒卡：治理好的外购件（紫实线——与 proposal 虚线紫区分：已存在 vs 构想）
      s += '<rect x="'+(-w/2)+'" y="'+(-h/2)+'" width="'+w+'" height="'+h+'" rx="9" fill="#e5dbff" stroke="#6741d9" stroke-width="1.8"/>'
        + '<text y="'+(-h/2+11)+'" text-anchor="middle" font-size="8" fill="#5f3dc4">🧱 积木</text>';
    } else if(n.kind === 'file'){
      // 关键文件：功能内调用热度 top 的实际功能单元，小号青蓝、左上 📄 标
      s += '<rect x="'+(-w/2)+'" y="'+(-h/2)+'" width="'+w+'" height="'+h+'" rx="8" fill="#ffffff" stroke="#94a8bd" stroke-width="1.3"/>'
        + '<text y="'+(-h/2+11)+'" text-anchor="middle" font-size="8" fill="#748393">📄 文件</text>';
    } else if(n.kind === 'proposal'){
      // 新功能构想：紫虚线（尚不存在，是主人想加的）；AI 定位挂靠现有功能或根下独立
      s += '<rect x="'+(-w/2)+'" y="'+(-h/2)+'" width="'+w+'" height="'+h+'" rx="13" fill="#e5dbff" stroke="#6741d9" stroke-width="2" stroke-dasharray="8 5"/>'
        + '<g transform="translate('+(-w/2+2)+','+(-h/2-9)+')">'
        + '<rect x="0" y="-10" width="56" height="18" rx="9" fill="#d0bfff" stroke="#5f3dc4" stroke-width="1.2"/>'
        + '<text x="28" y="3" text-anchor="middle" font-size="10" font-weight="700" fill="#4c3385">🔮 构想</text></g>';
    } else { // user：黄便签贴纸（虚线边框 + 折角）
      s += '<rect x="'+(-w/2)+'" y="'+(-h/2)+'" width="'+w+'" height="'+h+'" rx="3" fill="#fff9b2" stroke="#e67700" stroke-width="1.6"/>'
        + '<path d="M '+(-w/2+w-11)+' '+(-h/2)+' L '+(-w/2+w)+' '+(-h/2+11)+' L '+(-w/2+w)+' '+(-h/2)+' Z" fill="#ffd43b" stroke="#e67700" stroke-width="1"/>';
    }
    // 文字：标题（有介绍行时整体上移）
    var fs = n.kind === 'root' ? 14 : ((n.kind === 'feature' || n.kind === 'proposal') ? 13 : 12);
    var fw = (n.kind === 'root' || n.kind === 'feature' || n.kind === 'proposal') ? ' font-weight="700"' : '';
    var fillc = n.kind === 'user' ? '#664d00' : (n.kind === 'proposal' ? '#503c95' : (n.kind === 'brick' ? '#5f3dc4' : (n.kind === 'root' || n.kind === 'feature' ? '#1864ab' : '#343a40')));
    var lift = ds.length ? (ds.length * 12.5 + 5) / 2 : 0;
    s += ls.map(function(ln, li){
      return '<text y="'+(5 - lift + (li-(ls.length-1)/2)*15)+'" text-anchor="middle" font-size="'+fs+'"'+fw+' fill="'+fillc+'">'+esc(ln)+'</text>';
    }).join('');
    // 介绍行：小字灰蓝（"是什么"）+ 紫色增量段（"要变什么"，→ 开头）
    if(ds.length){
      s += ds.map(function(dl, li){
        var c = dl.delta ? '#7048e8' : (n.kind === 'proposal' ? '#7a6cb0' : '#5c7c9a');
        return '<text y="'+(5 - lift + (ls.length-(ls.length-1)/2)*15 + li*12.5 - 2)+'" text-anchor="middle" font-size="9.5" fill="'+c+'">'+esc(dl.t)+'</text>';
      }).join('');
    }
    // 折叠指示：左侧小圆点（有子节点才显示）
    if(n.children.length){
      var isC = collapsed(n);
      s += '<g class="fold" data-fold="'+esc(n.id)+'" transform="translate('+(-w/2-11)+',0)">'
        + '<circle r="'+(isC?7:5.5)+'" fill="'+(isC?'#1971c2':'#ffffff')+'" stroke="#1971c2" stroke-width="1.4"/>'
        + (isC ? '<text y="3.5" text-anchor="middle" font-size="9" font-weight="700" fill="#ffffff">'+n.children.length+'</text>' : '')
        + '</g>';
    }
    // 流转序号徽标：右上角青色圆底白字数字（1→2→3 业务顺序，来自设计图层的流转边）
    if(n._flowSeq){
      s += '<g transform="translate('+(w/2 - 1)+','+(-h/2 - 8)+')">'
        + '<circle r="9" fill="#0c8599" stroke="#e3fafc" stroke-width="1.6"/>'
        + '<text y="3.5" text-anchor="middle" font-size="10.5" font-weight="700" fill="#ffffff">'+n._flowSeq+'</text></g>';
    }
    // hover ⊕ 新增（所有节点）
    s += '<g class="addbtn" data-add="'+esc(n.id)+'" transform="translate('+(w/2-4)+','+(h/2+2)+')">'
      + '<circle r="9" fill="#ffffff" stroke="#1971c2" stroke-width="1.3"/>'
      + '<text y="3.5" text-anchor="middle" font-size="11" font-weight="700" fill="#1971c2">＋</text></g>';
    // user 节点 ✕ 删除
    if(n.kind === 'user'){
      s += '<g class="delbtn" data-del="'+esc(n.id)+'" transform="translate('+(w/2+2)+','+(-h/2-2)+')">'
        + '<circle r="8" fill="#fff5f5" stroke="#e03131" stroke-width="1.2"/>'
        + '<text y="3" text-anchor="middle" font-size="9.5" fill="#e03131">✕</text></g>';
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
    document.querySelectorAll('.fac-btn').forEach(function(el){
      el.addEventListener('click', function(ev){
        ev.stopPropagation();
        var id = el.getAttribute('data-fac');
        var n = NODE_BY_ID[id];
        if(n){ n._facOpen = !n._facOpen; layoutTree(); renderAll(); }
      });
    });
  }
  function toggleFold(id){ if(COLLAPSED[id]) delete COLLAPSED[id]; else COLLAPSED[id] = true; layoutTree(); renderAll(); }
  // ── 层级收纳预设：功能=只看功能层 / 子模块=展开到社区+步骤组 / 全部=展开到文件+步骤 ──
  //    单节点圆点折叠仍可用；预设是批量的"展开到第几层"，二者互不冲突（后者覆盖前者状态）
  function setDepthLevel(lv){
    COLLAPSED = {};
    if(lv === 1){
      for(var k in NODE_BY_ID){ var n = NODE_BY_ID[k]; if(n.kind === 'feature' && n.children.length) COLLAPSED[k] = true; }
    } else if(lv === 2){
      for(var k2 in NODE_BY_ID){ var n2 = NODE_BY_ID[k2];
        if((n2.kind === 'community' || n2.kind === 'stepgroup') && n2.children.length) COLLAPSED[k2] = true; }
    }
    layoutTree(); renderAll(); fitView();
    document.querySelectorAll('.lv-btn').forEach(function(b){
      b.classList.toggle('lv-on', b.getAttribute('data-lv') === String(lv));
    });
  }
  document.querySelectorAll('.lv-btn').forEach(function(b){
    b.addEventListener('click', function(){ setDepthLevel(parseInt(b.getAttribute('data-lv'), 10) || 3); });
  });
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
        depHtml += '<p style="color:#a06100;">🧱 谁踩着它：'
          + stoodOnBy.map(function(d){
              var top1 = (d.via_files && d.via_files[0]) ? '，主要打向 ' + esc(d.via_files[0]) : '';
              return esc(d.from)+'（×'+d.weight+'）'+top1;
            }).join('；')
          + (isF ? ' —— 这就是底座：自己几乎不叫别人，别人都来叫它。' : '') + '</p>';
      }
      if(standsOn.length){
        depHtml += '<p style="color:#a06100;">🧱 它踩着谁：' + standsOn.map(function(d){ return esc(d.to)+'（×'+d.weight+'）'; }).join('、') + '</p>';
      }
      det.innerHTML = '<b>'+esc(n.label)+'</b><span class="tag">'+(isF ? '底座功能' : '功能')+'</span><p>'+esc(n.raw.description||'')+'</p>'+depHtml+myNoteHtml;
    } else if(n.kind === 'step'){
      var stInv = (n.raw.meta && n.raw.meta.involves) || n.raw.involves || [];
      det.innerHTML = '<b>'+esc(n.owner.label)+' › '+esc(n.label)+'</b><span class="tag">原理步</span><p>'+esc(n.raw.description || n.raw.detail || '')+'</p>'
        + (stInv.length ? '<p class="files">'+stInv.map(esc).join(' · ')+'</p>' : '') + myNoteHtml;
    } else if(n.kind === 'stepgroup'){
      det.innerHTML = '<b>'+esc(n.owner.label)+' › ⚙️ '+esc(n.label)+'</b><span class="tag">步骤组</span>'
        + '<p>'+esc(n.raw.description||'')+'</p>'
        + (n.children.length ? '<p class="files">'+n.children.length+' 步：'+n.children.map(function(c){ return esc(c.label); }).join(' → ')+'</p>' : '')
        + '<p style="font-size:11px;color:#868e96;">讲"怎么一步步跑起来"；功能"由什么构成"看旁边的 🧩 子模块分支。</p>'
        + myNoteHtml;
    } else if(n.kind === 'community'){
      det.innerHTML = '<b style="color:#0b7285;">🧩 '+esc(n.label)+'</b><span class="tag">子模块</span>'
        + '<p>'+esc(n.raw.description||'')+'</p>'
        + (n.children.length ? '<p class="files">关键文件：'+n.children.map(function(c){ return esc(c.label); }).join(' · ')+'</p>' : '')
        + '<p style="font-size:11px;color:#868e96;">聚类真实产物：这些文件在调用关系上抱团，构成功能的这个部分。</p>'
        + myNoteHtml;
    } else if(n.kind === 'file'){
      det.innerHTML = '<b style="color:#49557a;">📄 ' + esc(n.label) + '</b><span class="tag">关键文件</span>'
        + '<p>' + esc(n.raw.description || '（暂无职责描述）') + '</p>'
        + (n._host ? '<p class="files">属于功能：' + esc(n._host.label) + (n._comm ? ' · 子模块：' + esc(n._comm) : '') + '</p>' : '')
        + (n.raw.meta && n.raw.meta.lines ? '<p class="files">' + n.raw.meta.lines + ' 行</p>' : '')
        + '<p style="font-size:11px;color:#868e96;">功能内调用热度最高的实际功能单元——功能的原理分镜最终落到这些文件上执行。</p>'
        + myNoteHtml;
    } else if(n.kind === 'proposal'){
      var pp = n.raw;
      var parentHtml = pp.parent
        ? '<p style="color:#6741d9;">AI 判断它属于「' + esc(pp.parent) + '」的子能力，已挂到该功能下。</p>'
        : '<p style="color:#6741d9;">AI 判断它是独立新功能，挂在根节点下。</p>';
      var depP = (pp.depends_on && pp.depends_on.length)
        ? '<p style="color:#5f3dc4;">🔮 预判要踩：' + pp.depends_on.map(esc).join('、') + '（紫色虚线弧）</p>' : '';
      var stepsHtml = (pp.steps && pp.steps.length)
        ? '<p style="margin-top:6px;"><b style="color:#6741d9;">实现步骤（AI 预判）：</b></p>' + pp.steps.map(function(s, i){
            return '<p>' + (i+1) + '. <b>' + esc(s.title) + '</b> — ' + esc(s.detail) + '</p>';
          }).join('')
        : '';
      det.innerHTML = '<b style="color:#5f3dc4;">🔮 ' + esc(pp.title) + '</b><span class="tag">' + (pp.mode === 'llm' ? '构想 · AI 已定位' : '构想') + '</span>'
        + '<p style="color:#495057;">' + esc(pp.desc) + '</p>'
        + parentHtml + depP + stepsHtml
        + '<p style="font-size:11px;color:#868e96;">你的原话：「' + esc(pp.raw) + '」——改原话：删除这个构想节点重写；要细化：给它加子节点后保存。</p>'
        + myNoteHtml;
    } else if(n.kind === 'brick'){
      // 积木黑盒卡详情：人话（盒内 manifest 快照）+ 暴露接口清单（契约投影）
      var apis = (n.raw.meta && n.raw.meta.apis) || [];
      var apisHtml = apis.length
        ? '<p style="margin-top:6px;"><b style="color:#5f3dc4;">对外暴露：</b></p>' + apis.map(function(a){
            return '<p class="files">▸ ' + esc(a) + '</p>';
          }).join('') + (n.raw.meta.symbols > apis.length ? '<p class="files">… 共 ' + n.raw.meta.symbols + ' 项</p>' : '')
        : '';
      det.innerHTML = '<b style="color:#5f3dc4;">🧱 ' + esc(n.label) + '</b><span class="tag">已验证积木</span>'
        + '<p style="color:#495057;">' + esc(n.raw.description || '治理好的黑盒积木') + '</p>'
        + (n.raw.meta && n.raw.meta.lines ? '<p class="files">' + n.raw.meta.lines + ' 行（盒内全体成员）</p>' : '')
        + apisHtml
        + '<p style="font-size:11px;color:#868e96;">治理好的黑盒资产：契约与行为验证记录在盒内 manifest；内部实现不进导图——出异常时再回盒深挖。</p>'
        + myNoteHtml;
    } else if(n.kind === 'shared'){
      var ub = n.raw.used_by || [];
      det.innerHTML = '<b style="color:#2b8a3e;">🔧 ' + esc(n.label) + '</b><span class="tag">共享能力</span>'
        + '<p class="files">' + esc(n.raw.file) + '</p>'
        + (n.raw.desc
            ? '<p style="color:#495057;">' + esc(n.raw.desc) + '</p>'
            : (SH_GAVEUP
                ? '<p style="font-size:11px;color:#868e96;">介绍暂不可用（AI 未配置或生成失败），调用证据不受影响。</p>'
                : '<p style="color:#e8590c;">⏳ AI 正在写介绍，生成后这里自动补上…</p>'))
        + '<p style="color:#2f9e44;">谁在用它：' + ub.map(function(u){ return esc(u.feature) + '（×' + u.count + '）'; }).join('、') + '</p>'
        + '<p style="font-size:11px;color:#868e96;">被多个功能真实调用的隐形地板——聚类会把它吸进某个大功能里，这里是按调用证据挖出来的。</p>'
        + myNoteHtml;
    } else if(n.kind === 'user'){
      det.innerHTML = '<b style="color:#e8590c;">✍️ 我写的节点</b><span class="tag">'+esc(n._anchor ? n._anchor.label : '')+'</span><p>'+esc(n.label)+'</p>'
        + '<p style="font-size:11px;color:#868e96;">双击可修改文字；保存后 AI 再生成时会作为你的理解读入。</p>';
    } else { det.style.display = 'none'; return; }
    det.style.display = 'block';
  }
  function showNote(id){
    var a = ANNS.filter(function(x){ return x.id === id; })[0];
    if(!a) return;
    var t = NODE_BY_ID[a.target_id];
    var det = document.getElementById('detail');
    det.innerHTML = '<b style="color:#e8590c;">✍️ 我的批注</b>'
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

  // ── 产线视图开关条：默认所有功能都直接是工厂流水线（工序盒+针脚+连线）。
  // 主人可点「✗ 否」把某个功能关回普通步骤列表；点「✓ 是」可改回产线。
  // 选项目前产线中的全部功能（含 LLM 提议作为判断依据展示）。
  function renderPipelineBar(){
    var bar = document.getElementById('plinebar');
    if(!bar) return;
    // 收集所有功能名：提议表的键 ∪ 树上 feature 节点（确保每个功能都能开/关产线）
    var labels = Object.keys(PLP || {});
    if(TREE){
      (function walk(ns){ (ns||[]).forEach(function(n){
        if(n.kind === 'feature' && labels.indexOf(n.raw.label) < 0) labels.push(n.raw.label);
        if(n.children) walk(n.children);
      }); })(TREE.children);
    }
    if(!labels.length){ bar.style.display = 'none'; return; }
    // 曾明确「否」的功能：给「✓ 改回产线」；从未拍板或默认产线的：给「✗ 否」关闭
    var chips = labels.map(function(l){
      var likeBtn = PL[l] === false
        ? '<button data-pl="' + esc(l) + '" data-like="1">✓ 改回产线</button>'
        : '<button data-pl="' + esc(l) + '" data-like="0">✗ 否</button>';
      return '<span style="margin:2px 6px 2px 0; display:inline-block;"><b>「' + esc(l) + '」</b>'
        + (PLP[l] ? '<span style="color:#1864ab;"> ' + esc(PLP[l]) + '</span>' : '')
        + ' ' + likeBtn + '</span>';
    }).join(' ');
    bar.innerHTML = '🏭 工厂流水线：以下功能默认已按产线呈现（工序盒+针脚+连线），可点时关闭： ' + chips;
    bar.style.display = 'block';
    var btns = bar.querySelectorAll('button[data-pl]');
    btns.forEach(function(b){
      b.onclick = function(ev){
        ev.stopPropagation();
        var label = b.getAttribute('data-pl'), like = b.getAttribute('data-like') === '1';
        b.disabled = true;
        fetch('/api/pipeline-like', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ feature: FEATURE, label: label, like: like }),
        }).then(function(r){ return r.json(); })
          .then(function(j){ if(j.success){ PL[label] = like; renderPipelineBar(); rebuild(); fitView(); } else flash('保存失败：' + (j.error || '')); })
          .catch(function(e){ b.disabled = false; flash('保存失败：' + e.message); });
      };
    });
  }

  // ── 视图：平移 / 缩放 / 自适应 / 便签拖动 ──
  var svg = document.getElementById('mm'), vp = document.getElementById('vp');
  function applyView(){ vp.setAttribute('transform','translate('+VIEW.tx+','+VIEW.ty+') scale('+VIEW.s+')'); }
  function treeBounds(){
    var b = { minX: 1e9, minY: 1e9, maxX: -1e9, maxY: -1e9 };
    (function walk(n){
      var hw = n._box ? n._box.w / 2 : n._w / 2;      // 盒子节点取盒宽（root 大容器覆盖全图）
      var top = n._box ? n._y - n._box.hh / 2 : n._y - 30;
      var bot = n._box ? top + n._box.h : n._y + 30;
      if(n._x - hw - 20 < b.minX) b.minX = n._x - hw - 20;
      if(top - 10 < b.minY) b.minY = top - 10;
      if(n._x + hw + 40 > b.maxX) b.maxX = n._x + hw + 40;
      if(bot + 10 > b.maxY) b.maxY = bot + 10;
      visChildren(n).forEach(walk);
    })(TREE);
    return b;
  }
  function fitView(){
    if(!TREE) return;
    var b = treeBounds();
    if(DEPS.length) b.minY -= 70 + Math.min(DEPS.length, 5) * 22; // 依赖弧扇形绕 root 大容器上方，视口为其留位
    var w = window.innerWidth, h = window.innerHeight - 52;
    var pad = 40;
    var rightInset = DOC_W;
    var effW = Math.max(100, w - rightInset);
    var s = Math.min((effW - pad*2) / (b.maxX - b.minX), (h - pad*2) / (b.maxY - b.minY), 1.15);
    VIEW = { s: s, tx: pad - b.minX * s + (effW - pad*2 - (b.maxX - b.minX) * s) / 2, ty: 52 + (h - (b.maxY - b.minY) * s) / 2 - b.minY * s };
    svg.setAttribute('viewBox','0 0 '+w+' '+h);
    applyView();
  }
  document.getElementById('btn-reset').onclick = fitView;
  document.getElementById('btn-expand').onclick = function(){ setDepthLevel(3); };
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
