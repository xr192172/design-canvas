/**
 * Hub 页面（人类入口）的动态渲染
 *
 * 产品定位：用户来这里了解「自己的项目」，而不是了解 design-canvas。
 * 信息架构（层层递进）：
 *   主页 = 项目选择器（列出已导入项目 + ＋导入新项目）
 *     ↓ 点击项目卡片
 *   项目页 = 主视图（项目地图）→ 换个角度看 → 深入分析 → 讲解与报告
 *
 * 页面为静态壳 + 前端 fetch 数据（/api/features、/api/registry），
 * serve 无需预生成任何 HTML 文件。
 */

/** 公共壳：统一深空蓝视觉 */
function shell(title: string, body: string, script: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} · design-canvas</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    background: #02040d;
    background-image:
      radial-gradient(ellipse 42% 30% at 72% 18%, rgba(196, 181, 253, 0.06), transparent 70%),
      radial-gradient(ellipse 38% 26% at 18% 78%, rgba(125, 211, 252, 0.05), transparent 70%),
      radial-gradient(1.5px 1.5px at 25% 35%, rgba(255,255,255,0.8) 50%, transparent 51%),
      radial-gradient(1px 1px at 70% 60%, rgba(255,255,255,0.6) 50%, transparent 51%);
    background-size: 100% 100%, 100% 100%, 340px 340px, 280px 280px;
    color: #dbe7ff;
    min-height: 100vh;
  }
  a { color: #7dd3fc; text-decoration: none; }
  .topbar {
    display: flex; align-items: center; gap: 14px;
    padding: 16px 32px;
    border-bottom: 1px solid rgba(125, 211, 252, 0.15);
    background: rgba(6, 11, 31, 0.8);
    backdrop-filter: blur(8px);
    position: sticky; top: 0; z-index: 10;
  }
  .topbar .logo { font-size: 17px; font-weight: 700; color: #e8f1ff; letter-spacing: 0.5px; }
  .topbar .logo span { color: #7dd3fc; }
  .topbar .tagline { font-size: 12px; opacity: 0.55; }
  .topbar .back { font-size: 13px; color: #7dd3fc; margin-right: 4px; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 36px 32px 60px; }
  .empty { text-align: center; opacity: 0.6; padding: 48px 0; font-size: 14px; }
  .empty code { background: rgba(125, 211, 252, 0.1); padding: 2px 8px; border-radius: 5px; }
</style>
</head>
<body>
<div class="topbar">
  <a class="back" href="/" id="back-link">🏠 全部项目</a>
  <div class="logo">design<span>·</span>canvas</div>
  <div class="tagline">看懂任何一个代码项目</div>
</div>
<div class="wrap">
${body}
</div>
<script>
(function(){
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  window.__esc = esc;
${script}
})();
</script>
</body>
</html>`;
}

/* ───────────────────────── 主页：项目选择器 ───────────────────────── */

export function renderHomePage(): string {
  const body = `
  <h1 style="font-size:24px;margin-bottom:6px;">选择一个项目</h1>
  <p style="font-size:13px;opacity:.6;margin-bottom:28px;">点项目卡片进入专属页；点 ＋ 导入新项目（选源码目录）。</p>
  <div id="projects" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px;">
    <div class="empty">加载项目…</div>
  </div>
  <input type="file" id="dir-input" webkitdirectory multiple style="display:none">
  <div id="import-status" style="display:none;margin-top:22px;font-size:13px;color:#7dd3fc;"></div>

  <style>
    .proj-card {
      background: rgba(6,11,31,.78); border: 1px solid rgba(125,211,252,.18);
      border-radius: 14px; padding: 20px 20px 16px; cursor: pointer;
      transition: all .18s ease; display:flex; flex-direction:column; gap:10px; min-height:130px;
    }
    .proj-card:hover { border-color:#7dd3fc; transform: translateY(-2px); box-shadow: 0 10px 30px rgba(125,211,252,.12); }
    .proj-card h3 { font-size: 17px; color: #e8f1ff; }
    .proj-card .lang { font-size: 11px; color:#7dd3fc; background:rgba(125,211,252,.12); padding:2px 9px; border-radius:20px; width:fit-content; text-transform:uppercase; }
    .proj-card .stats { display:flex; gap:14px; font-size:12px; opacity:.6; margin-top:auto; }
    .proj-card.add {
      border-style: dashed; border-color: rgba(125,211,252,.35); align-items:center; justify-content:center;
      color:#7dd3fc; font-size:15px; text-align:center;
    }
    .proj-card.add:hover { background: rgba(125,211,252,.07); }
    .proj-card.add .plus { font-size: 30px; line-height: 1; margin-bottom: 6px; }
  </style>`;

  const script = `
  function fmtDate(iso){ try { return new Date(iso).toLocaleDateString('zh-CN'); } catch(e){ return ''; } }
  function loadProjects(){
    Promise.all([
      fetch('/api/features').then(function(r){ return r.json(); }),
      fetch('/api/registry').then(function(r){ return r.json(); }).catch(function(){ return { artifacts: [] }; })
    ]).then(function(args){
      var feats = args[0].features || [];
      var arts = args[1].artifacts || [];
      var box = document.getElementById('projects');
      if(!feats.length){
        box.innerHTML = '<div class="empty" style="grid-column:1/-1;">还没有项目。点下面的 ＋ 导入你的第一个项目源码目录。</div>';
      } else {
        var html = feats.map(function(f){
          var n = arts.filter(function(a){ return a.feature === f.feature; }).length;
          return '<div class="proj-card" data-f="'+__esc(f.feature)+'">'
            + (f.language ? '<span class="lang">'+__esc(f.language)+'</span>' : '')
            + '<h3>'+__esc(f.title || f.feature)+'</h3>'
            + '<div class="stats"><span>'+ (f.files||0) +' 文件</span><span>'+ (f.nodes||0) +' 节点</span>'
            + (n ? '<span>'+ n +' 产物</span>' : '')
            + (f.updated_at ? '<span>'+fmtDate(f.updated_at)+'</span>' : '')
            + '</div></div>';
        }).join('');
        box.innerHTML = html;
        box.querySelectorAll('.proj-card[data-f]').forEach(function(c){
          c.onclick = function(){ location.href = '/project/' + encodeURIComponent(c.getAttribute('data-f')); };
        });
      }
      // ＋ 导入卡片（始终在最后）
      var add = document.createElement('div');
      add.className = 'proj-card add';
      add.innerHTML = '<div class="plus">＋</div>导入项目<br><span style="font-size:12px;opacity:.6;">选择源码文件夹</span>';
      add.onclick = function(){ document.getElementById('dir-input').click(); };
      box.appendChild(add);
    }).catch(function(){
      document.getElementById('projects').innerHTML = '<div class="empty" style="grid-column:1/-1;">加载失败：请确认服务已启动。</div>';
    });
  }

  var SKIP_DIR = /(?:^|\\/)(?:node_modules|\\.git|dist|build|out|vendor|__pycache__|\\.next|target)(?:\\/|$)/;
  var BIN_EXT = /\\.(?:png|jpe?g|gif|ico|woff2?|ttf|eot|zip|tar|gz|rar|7z|pdf|mp4|mp3|exe|dll|so|dylib|db|bin|lock)$/i;
  document.getElementById('dir-input').addEventListener('change', async function(e){
    var picked = Array.from(e.target.files || []);
    if(!picked.length) return;
    var st = document.getElementById('import-status');
    st.style.display = 'block';
    st.textContent = '读取 ' + picked.length + ' 个文件…';
    var files = [];
    for(var i=0;i<picked.length;i++){
      var f = picked[i];
      var rel = f.webkitRelativePath || f.name;
      if(SKIP_DIR.test(rel) || BIN_EXT.test(rel)) continue;
      if(f.size > 1024*1024) continue;           // 单文件 > 1MB 跳过
      if(files.length >= 3000) break;             // 总量上限
      try { files.push({ path: rel, content: await f.text() }); } catch(err){ /* 读不了的跳过 */ }
    }
    if(!files.length){ st.textContent = '没有可导入的文本源码文件。'; return; }
    st.textContent = '导入解析中（' + files.length + ' 个文件）…';
    try {
      var r = await fetch('/api/import', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ files: files }) });
      var j = await r.json();
      if(j.success){ location.href = '/project/' + encodeURIComponent(j.feature); }
      else { st.textContent = '导入失败：' + (j.error || '未知错误'); }
    } catch(err){ st.textContent = '导入失败：' + err.message; }
  });

  loadProjects();`;

  return shell('选择项目', body, script);
}

/* ─────────────────── 项目专属页：小白视图（默认）+ 递进分组 ───────────────────
 * 第一屏回答新手四问（数据来自 /api/overview，LLM 未配置时规则兜底照样可用）：
 *   ❶ 这是什么软件？ → hero 卡（一句话 + 两行简介）
 *   ❷ 有哪些功能？   → 圆框功能图（功能=圆，子模块=椭圆；叶子是人话，不带文件名）
 *   ❸ 具体有什么？   → 点圆框看详情（说明 + 涉及文件）
 *   ❹ 要怎么做？     → 上手三步（guided_tour 学习路径）
 * 文件星图等专业视图降级为「开发者视图」入口，产物分组保留在下方。 */

export function renderProjectPage(feature: string): string {
  const safeFeature = feature.replace(/[<>"']/g, ''); // 仅入 HTML，防注入
  const body = `
  <div id="proj-head" style="margin-bottom:22px;display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;">
    <div>
      <h1 style="font-size:24px;margin-bottom:4px;">${safeFeature}</h1>
      <p id="proj-meta" style="font-size:13px;opacity:.6;"></p>
    </div>
    <a id="dev-view" href="/${safeFeature}.html" target="_blank" rel="noopener" style="display:none;
      font-size:13px;color:#8fb7e8;border:1px solid rgba(125,211,252,.35);border-radius:10px;padding:7px 14px;">
      🔓 开发者视图（文件星图）→</a>
  </div>

  <!-- ❶ 这是什么软件 -->
  <div class="hero" id="hero" style="display:none;">
    <div class="hero-q">❓ 这是一个什么样的软件？</div>
    <div id="hero-liner" class="hero-liner"></div>
    <div id="hero-brief" class="hero-brief"></div>
    <button id="hero-refresh" title="用 AI 重新提炼这段介绍">✨ AI 优化这段介绍</button>
  </div>

  <!-- ❷ 有哪些功能 -->
  <div id="feat-sec" style="display:none;margin-bottom:26px;">
    <div class="sec-title">🧩 它有哪些功能？<em>点圆框看说明</em></div>
    <div id="bubble-wrap" style="background:rgba(6,11,31,.6);border:1px solid rgba(125,211,252,.15);border-radius:16px;padding:8px;"></div>
    <div id="node-detail" style="display:none;margin-top:10px;background:rgba(125,211,252,.06);border-left:3px solid #7dd3fc;border-radius:8px;padding:12px 16px;font-size:13px;"></div>
  </div>

  <!-- ❹ 要怎么做 -->
  <div id="steps-sec" style="display:none;margin-bottom:30px;">
    <div class="sec-title">🚀 我要怎么开始？<em>按依赖顺序排好的入门路径</em></div>
    <div id="steps" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;"></div>
  </div>

  <div id="groups"></div>

  <style>
    .hero {
      position:relative; overflow:hidden;
      background:linear-gradient(135deg, rgba(125,211,252,.14), rgba(196,181,253,.10));
      border:1px solid rgba(125,211,252,.4); border-radius:18px;
      padding:24px 28px; margin-bottom:26px;
    }
    .hero-q { font-size:14px; color:#8fb7e8; margin-bottom:10px; font-weight:600; }
    .hero-liner { font-size:21px; font-weight:700; color:#e8f1ff; line-height:1.5; margin-bottom:8px; }
    .hero-brief { font-size:13.5px; color:#c9dcf5; opacity:.85; line-height:1.7; max-width:760px; }
    .hero button {
      position:absolute; right:18px; bottom:16px; cursor:pointer;
      background:rgba(6,11,31,.7); color:#7dd3fc; font-size:12px;
      border:1px solid rgba(125,211,252,.35); border-radius:8px; padding:5px 12px;
    }
    .hero button:hover { background:rgba(125,211,252,.14); }
    .hero button:disabled { opacity:.5; cursor:wait; }
    .sec-title { font-size:16px; font-weight:700; color:#e8f1ff; margin-bottom:12px; }
    .sec-title em { font-style:normal; font-size:12px; opacity:.5; font-weight:400; margin-left:10px; }
    .step-card { background:rgba(6,11,31,.78); border:1px solid rgba(125,211,252,.18); border-radius:13px; padding:16px 18px; }
    .step-card .no { font-size:12px; color:#7dd3fc; font-weight:700; margin-bottom:6px; }
    .step-card h4 { font-size:14.5px; color:#e8f1ff; margin-bottom:6px; word-break:break-all; }
    .step-card .why { font-size:12px; opacity:.6; line-height:1.6; }
    .group { margin-bottom: 30px; }
    .group-title { font-size: 13px; opacity: .65; letter-spacing: 1px; margin-bottom: 12px; display:flex; align-items:center; gap:8px; }
    .group-title .cnt { font-size: 11px; color:#7dd3fc; background:rgba(125,211,252,.12); border-radius:20px; padding:1px 9px; }
    .group-cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:14px; }
    .acard { background:rgba(6,11,31,.78); border:1px solid rgba(125,211,252,.18); border-radius:13px; padding:16px 18px; transition:all .18s ease; display:block; }
    .acard:hover { border-color:#7dd3fc; transform:translateY(-2px); box-shadow:0 8px 24px rgba(125,211,252,.1); }
    .acard h4 { font-size:15px; color:#e8f1ff; margin-bottom:5px; }
    .acard .sub { font-size:12px; opacity:.55; }
    #bubble-wrap svg text { font-family:inherit; cursor:pointer; }
            #bubble-wrap svg .bnode { cursor:pointer; }
            #bubble-wrap svg .bnode:hover { filter:brightness(1.35); }
            #node-detail { max-width:860px; }
            .steps-tl-title { font-size:12.5px; font-weight:700; color:#8fb7e8; margin:14px 0 8px; letter-spacing:.5px; }
            .steps-tl { position:relative; padding-left:6px; }
            .tstep { display:flex; gap:12px; position:relative; padding-bottom:14px; }
            .tstep:last-child { padding-bottom:2px; }
            .tstep:not(:last-child)::before { content:''; position:absolute; left:13px; top:30px; bottom:0; width:2px; background:rgba(125,211,252,.25); }
            .tno { flex:none; width:28px; height:28px; border-radius:50%; background:linear-gradient(135deg,#155a8a,#7dd3fc); color:#fff; font-size:12.5px; font-weight:700; display:flex; align-items:center; justify-content:center; }
            .tbody { flex:1; min-width:0; padding-top:3px; }
            .ttitle { font-size:13.5px; font-weight:700; color:#e8f1ff; margin-bottom:3px; }
            .tdetail { font-size:12.5px; color:#c9dcf5; opacity:.85; line-height:1.65; }
            .tinv { font-size:11px; color:#7a93b8; margin-top:4px; font-family:ui-monospace,Consolas,monospace; word-break:break-all; }
  </style>`;

  const script = `
  var FEATURE = ${JSON.stringify(feature)};
  var OV = null; // /api/overview 结果缓存

  // ── ❶❷❹ 小白三段式：加载概览（GET 不调 LLM，秒回；rule 兜底） ──
  function loadOverview(){
    fetch('/api/overview?feature=' + encodeURIComponent(FEATURE)).then(function(r){ return r.json(); }).then(function(j){
      if(!j.success){ return; }
      OV = j;
      // ❶ hero
      var hero = document.getElementById('hero');
      hero.style.display = 'block';
      document.getElementById('hero-liner').textContent = '「' + (j.summary.one_liner||'') + '」';
      document.getElementById('hero-brief').textContent = j.summary.brief||'';
      if(j.summary.mode === 'llm'){ document.getElementById('hero-refresh').textContent = '✨ 已是 AI 优化版'; }
      // 功能圆框：仅功能树形态显示；文件平铺（早期数据）引导重新导入
      var feats = (j.mind_map && j.mind_map.root && j.mind_map.root.children) || [];
      var isFlat = feats.length === 0 || (feats[0].kind === 'file');
      if(feats.length && !isFlat){
        document.getElementById('feat-sec').style.display = 'block';
        drawBubbles(feats);
      } else if(isFlat){
        document.getElementById('feat-sec').style.display = 'block';
        document.getElementById('bubble-wrap').innerHTML =
          '<div style="padding:26px;text-align:center;font-size:13px;opacity:.65;">' +
          '该项目是早期导入的数据（无源码快照），功能视图不可用。<br>' +
          '<a href="/" style="color:#7dd3fc;">重新导入</a> 后可自动生成功能圆框图。</div>';
      }
      // ❹ 上手步骤
      if(j.first_steps && j.first_steps.length){
        document.getElementById('steps-sec').style.display = 'block';
        document.getElementById('steps').innerHTML = j.first_steps.map(function(s, i){
          return '<div class="step-card"><div class="no">第 ' + (i+1) + ' 步</div><h4>'+__esc(s.label)+'</h4>'
            + '<div class="why">'+__esc(s.reason || (s.deps_seen && s.deps_seen.length ? '前置：' + s.deps_seen.join('、') : ''))+'</div></div>';
        }).join('');
      }
    }).catch(function(){ /* 概览失败不阻塞页面其余部分 */ });
  }

  // AI 优化按钮：POST refresh_llm（慢路径，未配置 LLM 时仍返回规则版）
  document.getElementById('hero-refresh').onclick = function(){
    var btn = this; btn.disabled = true; btn.textContent = 'AI 提炼中…';
    fetch('/api/overview', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ feature: FEATURE, refresh_llm: true }) })
      .then(function(r){ return r.json(); }).then(function(j){
        if(j.success){
          document.getElementById('hero-liner').textContent = '「' + (j.summary.one_liner||'') + '」';
          document.getElementById('hero-brief').textContent = j.summary.brief||'';
          btn.textContent = j.summary.mode === 'llm' ? '✨ 已是 AI 优化版' : '⚠️ 未配置 LLM，仍为规则版';
          if(j.mind_map && j.mind_map.root){ drawBubbles(j.mind_map.root.children || []); }
        } else { btn.textContent = '⚠️ ' + (j.error || '失败'); }
      }).catch(function(e){ btn.textContent = '⚠️ ' + e.message; })
      .finally(function(){ btn.disabled = false; });
  };

  // ── ❷ 圆框功能图：功能=圆，子模块=椭圆；file 层不出现（下钻在详情条） ──
  function drawBubbles(feats){
    feats = feats.filter(function(f){ return f && f.label; }).map(function(f){
      return f.label === '(根)' ? Object.assign({}, f, { label: '其他模块' }) : f;
    });
    if(!feats.length) return;
    var W = Math.max(720, Math.min(1040, feats.length * 230)), PAD = 16;
    var colW = W / feats.length, CX = [];
    for(var i=0;i<feats.length;i++) CX.push(PAD + colW*(i+0.5));
    var R = Math.min(46, colW*0.30);                 // 功能圆半径
    var CY = 24 + R;                                  // 圆心 y
    var maxSub = 0;
    feats.forEach(function(f){ maxSub = Math.max(maxSub, Math.min(4, ((f.children||[]).length))); });
    var SUB_H = 30, SUB_GAP = 10, SUB_Y0 = CY + R + 26;
    var H = SUB_Y0 + Math.max(1,maxSub)*(SUB_H+SUB_GAP) + 8;
    var svg = '<svg viewBox="0 0 '+W+' '+H+'" style="width:100%;height:auto;display:block;" xmlns="http://www.w3.org/2000/svg">';
    feats.forEach(function(f, i){
      var cx = CX[i];
      // 功能圆（两行内截断）
      var lines = splitLabel(f.label, 7);
      svg += '<g class="bnode" data-i="'+i+'" data-kind="feature">'
        + '<circle cx="'+cx+'" cy="'+CY+'" r="'+R+'" fill="rgba(21,58,94,.95)" stroke="#5ba3d9" stroke-width="2"/>';
      lines.forEach(function(ln, li){
        svg += '<text x="'+cx+'" y="'+(CY + 5 + (li - (lines.length-1)/2)*16 + 4)+'" text-anchor="middle" font-size="13" font-weight="700" fill="#e8f1ff">'+__esc(ln)+'</text>';
      });
      if(f.meta && f.meta.files) svg += '<text x="'+cx+'" y="'+(CY+R+13)+'" text-anchor="middle" font-size="10" fill="#7a93b8">'+f.meta.files+' 文件</text>';
              if(f.steps && f.steps.length > 1) svg += '<text x="'+cx+'" y="'+(CY-R-10)+'" text-anchor="middle" font-size="10.5" fill="#8fb7e8">⚙️ '+f.steps.length+' 步原理</text>';
      svg += '</g>';
      // 子模块椭圆（最多 4 个，多出的折叠提示）
      var subs = (f.children || []).filter(function(c){ return c && c.label; }).slice(0, 4);
      subs.forEach(function(c, si){
        var sy = SUB_Y0 + si*(SUB_H+SUB_GAP) + SUB_H/2;
        svg += '<line x1="'+cx+'" y1="'+(CY+R+16)+'" x2="'+cx+'" y2="'+(sy-SUB_H/2)+'" stroke="#3d5a8a" stroke-width="1.4" opacity=".65"/>';
        svg += '<g class="bnode" data-i="'+i+'" data-si="'+si+'" data-kind="community">'
          + '<ellipse cx="'+cx+'" cy="'+sy+'" rx="'+Math.min(colW*0.42, 92)+'" ry="'+(SUB_H/2)+'" fill="rgba(18,49,78,.9)" stroke="#3d7ab5"/>'
          + '<text x="'+cx+'" y="'+(sy+4)+'" text-anchor="middle" font-size="11.5" fill="#cfe2f8">'+__esc(trunc(c.label, 12))+'</text>'
          + '</g>';
      });
      var rest = (f.children||[]).length - subs.length;
      if(rest > 0){
        var ry = SUB_Y0 + subs.length*(SUB_H+SUB_GAP) + SUB_H/2;
        svg += '<text x="'+cx+'" y="'+(ry+4)+'" text-anchor="middle" font-size="10.5" fill="#7a93b8" class="bnode" data-i="'+i+'" data-kind="more">… 还有 '+rest+' 个子模块</text>';
      }
    });
    svg += '</svg>';
    var wrap = document.getElementById('bubble-wrap');
    wrap.innerHTML = svg;
    wrap.querySelectorAll('.bnode').forEach(function(el){
      el.addEventListener('click', function(){
        var i = +el.getAttribute('data-i'), kind = el.getAttribute('data-kind');
        var f = feats[i], det = document.getElementById('node-detail');
        if(kind === 'feature'){
          var stepsHtml = '';
          if(f.steps && f.steps.length){
            stepsHtml = '<div class="steps-tl-title">⚙️ 实现原理（AI 科普分镜）</div><div class="steps-tl">'
              + f.steps.map(function(st, si){
                  return '<div class="tstep"><div class="tno">'+(si+1)+'</div><div class="tbody">'
                    + '<div class="ttitle">'+__esc(st.title)+'</div>'
                    + '<div class="tdetail">'+__esc(st.detail)+'</div>'
                    + (st.involves && st.involves.length ? '<div class="tinv">'+ st.involves.map(__esc).join(' · ') +'</div>' : '')
                    + '</div></div>';
                }).join('')
              + '</div>';
          }
          det.innerHTML = '<b style="color:#e8f1ff;font-size:14px;">'+__esc(f.label)+'</b>'
            + '<span style="opacity:.5;font-size:11px;margin-left:8px;">功能</span>'
            + '<div style="margin-top:6px;opacity:.8;line-height:1.7;">'+__esc(f.description||'（待 AI 提炼说明）')+'</div>'
            + stepsHtml;
        } else if(kind === 'community'){
          var c = (f.children||[])[+el.getAttribute('data-si')];
          if(!c) return;
          var files = (c.children||[]).slice(0,6).map(function(x){ return x.label; });
          det.innerHTML = '<b style="color:#e8f1ff;font-size:14px;">'+__esc(f.label)+' › '+__esc(c.label)+'</b>'
            + '<div style="margin-top:6px;opacity:.8;line-height:1.7;">'+__esc(c.description||'')+'</div>'
            + (files.length ? '<div style="margin-top:6px;font-size:12px;opacity:.55;">涉及文件：'+files.map(__esc).join(' · ')+((c.children||[]).length>6?' …':'')+'</div>' : '');
        } else {
          det.innerHTML = '<b style="color:#e8f1ff;">'+__esc(f.label)+'</b><div style="margin-top:6px;opacity:.8;">'+__esc(f.description||'')+'</div>';
        }
        det.style.display = 'block';
        det.scrollIntoView({behavior:'smooth', block:'nearest'});
      });
    });
  }
  function splitLabel(s, n){
    s = String(s||''); if(s.length <= n) return [s];
    var mid = Math.ceil(s.length/2);
    var a = s.slice(0, mid), b = s.slice(mid);
    return [trunc(a, n), trunc(b, n)];
  }
  function trunc(s, n){ s = String(s||''); return s.length > n ? s.slice(0, n-1) + '…' : s; }

  // ── 开发者视图入口 + 产物递进分组（专业层，保留） ──
  var GROUPS = [
    { key:'view',    name:'🔭 换个角度看', desc:'功能树 · 思维导图 · 分层视图' },
    { key:'analysis',name:'🔬 深入分析',   desc:'巨石体检 · 拆分建议 · 影响面' },
    { key:'teach',   name:'🎬 讲解与演示', desc:'导览 · 科普 · 示例' }
  ];
  function groupKey(a){
    var t = a.type || '', hay = t + ' ' + (a.title||'') + ' ' + (a.tags||[]).join(' ');
    if(/mind|树|导图/.test(hay)) return 'view';
    if(/report|分析|拆分|影响|monolith|audit/.test(hay)) return 'analysis';
    if(/teach|explain|tour|guide|讲解|导览|demo|演示|example/.test(hay)) return 'teach';
    if(t === 'feature_diagram') return 'view';
    return 'analysis';
  }
  Promise.all([
    fetch('/api/features').then(function(r){ return r.json(); }),
    fetch('/api/registry').then(function(r){ return r.json(); }).catch(function(){ return { artifacts: [] }; })
  ]).then(function(args){
    var me = (args[0].features || []).filter(function(f){ return f.feature === FEATURE; })[0];
    if(me){
      document.querySelector('#proj-head h1').textContent = me.title || me.feature;
      var bits = [];
      if(me.files) bits.push(me.files + ' 文件');
      if(me.nodes) bits.push(me.nodes + ' 节点');
      if(me.updated_at) bits.push('更新于 ' + new Date(me.updated_at).toLocaleDateString('zh-CN'));
      document.getElementById('proj-meta').textContent = bits.join(' · ');
    }
    var arts = (args[1].artifacts || []).filter(function(a){ return a.feature === FEATURE; });
    var mapArt = arts.filter(function(a){ return a.path === FEATURE + '.html'; })[0]
           || arts.filter(function(a){ return (a.type||'') === 'feature_diagram'; })[0];
    if(mapArt){
      var el = document.getElementById('dev-view');
      el.href = '/' + mapArt.path;
      el.style.display = 'inline-block';
    }
    var rest = arts.filter(function(a){ return a !== mapArt; });
    var box = document.getElementById('groups');
    if(!rest.length){ box.innerHTML = ''; return; }
    var byG = {};
    rest.forEach(function(a){ var k = groupKey(a); (byG[k]=byG[k]||[]).push(a); });
    var html = '';
    GROUPS.forEach(function(g){
      if(!byG[g.key]) return;
      html += '<div class="group"><div class="group-title">'+g.name+' <em style="font-style:normal;font-size:12px;opacity:.5;">'+g.desc+'</em><span class="cnt">'+byG[g.key].length+'</span></div><div class="group-cards">'
        + byG[g.key].map(function(a){
            return '<a class="acard" href="/'+__esc(a.path)+'" target="_blank" rel="noopener"><h4>'+__esc(a.title || a.path)+'</h4><div class="sub">'+__esc(a.path)+'</div></a>';
          }).join('')
        + '</div></div>';
    });
    box.innerHTML = html;
  });

  loadOverview();`;

  return shell(safeFeature, body, script);
}
