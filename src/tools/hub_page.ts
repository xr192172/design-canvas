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

/* ─────────────────── 项目专属页：主视图 + 递进分组 ─────────────────── */

export function renderProjectPage(feature: string): string {
  const safeFeature = feature.replace(/[<>"']/g, ''); // 仅入 HTML，防注入
  const body = `
  <div id="proj-head" style="margin-bottom:26px;">
    <h1 style="font-size:24px;margin-bottom:4px;">${safeFeature}</h1>
    <p id="proj-meta" style="font-size:13px;opacity:.6;"></p>
  </div>

  <a id="map-entry" href="/${safeFeature}.html" target="_blank" rel="noopener" style="display:none;
    background:linear-gradient(135deg, rgba(125,211,252,.16), rgba(196,181,253,.12));
    border:1px solid rgba(125,211,252,.4); border-radius:18px; padding:28px 30px; margin-bottom:30px;
    transition:all .18s ease;">
    <div style="font-size:20px;font-weight:700;color:#e8f1ff;margin-bottom:6px;">🗺️ 打开项目地图</div>
    <div style="font-size:13px;opacity:.65;">全景总览 · 点节点逐级下钻（功能树 → 调用链 → 算法）</div>
  </a>
  <div id="map-missing" style="display:none;border:1px dashed rgba(125,211,252,.35);border-radius:18px;padding:24px 28px;margin-bottom:30px;font-size:13px;opacity:.75;">
    该项目还没有渲染地图。让 AI 执行 <code style="background:rgba(125,211,252,.1);padding:2px 8px;border-radius:5px;">render_dsl(feature=${safeFeature})</code> 生成。
  </div>

  <div id="groups"></div>

  <style>
    .group { margin-bottom: 30px; }
    .group-title { font-size: 13px; opacity: .65; letter-spacing: 1px; margin-bottom: 12px; display:flex; align-items:center; gap:8px; }
    .group-title .cnt { font-size: 11px; color:#7dd3fc; background:rgba(125,211,252,.12); border-radius:20px; padding:1px 9px; }
    .group-cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:14px; }
    .acard { background:rgba(6,11,31,.78); border:1px solid rgba(125,211,252,.18); border-radius:13px; padding:16px 18px; transition:all .18s ease; display:block; }
    .acard:hover { border-color:#7dd3fc; transform:translateY(-2px); box-shadow:0 8px 24px rgba(125,211,252,.1); }
    .acard h4 { font-size:15px; color:#e8f1ff; margin-bottom:5px; }
    .acard .sub { font-size:12px; opacity:.55; }
  </style>`;

  const script = `
  var FEATURE = ${JSON.stringify(feature)};
  // 递进分组：与理解链一致 —— 换个角度看 → 深入分析 → 讲解与演示
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
    // 主地图入口：feature_diagram 且就是 <feature>.html；否则任取第一个
    var mapArt = arts.filter(function(a){ return a.path === FEATURE + '.html'; })[0]
           || arts.filter(function(a){ return (a.type||'') === 'feature_diagram'; })[0];
    if(mapArt){
      var el = document.getElementById('map-entry');
      el.href = '/' + mapArt.path;
      el.style.display = 'block';
    } else {
      document.getElementById('map-missing').style.display = 'block';
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
  });`;

  return shell(safeFeature, body, script);
}
