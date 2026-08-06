// npm run self-analyze：一键生成 design-canvas 自身的可导航"星图"报告
// 流水线：import_project(自身 src) → check_monolith → 关键文件 derive_detail_chain
//   → 关键函数 derive_algorithm → 渲染 output/self_analyze.html + 控制台报告
// 隔离存储 DESIGN_CANVAS_HOME=.tmp_self_analyze，全程不碰活态 design-canvas.json
// 用法：npm run self-analyze（内含 build）
import fs from 'node:fs';
import path from 'node:path';

process.env.DESIGN_CANVAS_HOME = path.resolve('.tmp_self_analyze');

const { getDSL, saveDSL } = await import('../dist/src/storage.js');
const { importProject } = await import('../dist/src/tools/import_project.js');
const { checkMonolith } = await import('../dist/src/tools/monolith.js');
const { deriveDetailChain } = await import('../dist/src/tools/derive_chain.js');
const { deriveAlgorithm } = await import('../dist/src/tools/derive_algorithm.js');
const { renderHTML } = await import('../dist/src/renderer/html_renderer.js');
const { detectArchLayers } = await import('../dist/src/tools/layer_detect.js');
const { openDb } = await import('../dist/src/db/db.js');
const { registerArtifactTo } = await import('../dist/src/tools/registry.js');

// 产物注册表：self_analyze 用隔离的 DESIGN_CANVAS_HOME，但产物落在 cwd/output，
// 需显式写往 serve 读取的 cwd/output/.registry.json，供 Hub 首页统一索引。
const REG_FILE = path.resolve('output', '.registry.json');
const regArt = (rel, meta) => { try { registerArtifactTo(REG_FILE, { path: rel, ...meta }); } catch { /* 注册失败不阻塞 */ } };

const FEATURE = 'self_analyze';
const SRC = 'src';

// 关键管线文件：detail 链展开文件内调用流水线（相对 SRC 的路径）
const CHAIN_TARGETS = [
  'tools/import_project.ts',
  'tools/derive_chain.ts',
  'tools/derive_algorithm.ts',
];
// 关键函数：算法控制流展开（文件 + 函数名）
const ALG_TARGETS = [
  { file: 'tools/import_project.ts', fn: 'importProject' },
  { file: 'tools/derive_algorithm.ts', fn: 'deriveAlgorithm' },
];

const sanitize = (s) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
// import_project 节点 id 规则：file_<sanitize(相对 project_dir 的路径)>
const fileNodeId = (rel) => `file_${sanitize(rel)}`;

// ── 1. import_project：全量导入自身 src ─────────────────────────
console.log('═══ 1/5 import_project：导入自身 src ═══');
// 符号缓存放项目根 .design-canvas/（而非 .tmp_self_analyze——那个目录跑完即删）：
// 缓存是 src/ 的派生物，跨运行复用才有增量价值；二次运行未变更文件直接命中
const cacheDb = openDb(path.resolve('.design-canvas', 'cache.db'));
const imp = await importProject({
  project_dir: SRC,
  feature: FEATURE,
  title: 'design-canvas 自我分析星图',
  cache_db: cacheDb,
});
cacheDb.close();
console.log(imp.message);

// 星图主题：自分析报告默认 star（与愿景一致；用户在画布上可切）
{
  const dsl = getDSL(FEATURE);
  dsl.theme = 'star';
  saveDSL(dsl);
}

// ── 2. check_monolith：巨石文件扫描 ─────────────────────────────
console.log('\n═══ 2/5 check_monolith：巨石文件扫描 ═══');
const mono = await checkMonolith({ project_dir: SRC, warn_lines: 300, crit_lines: 600 });
const flagged = mono.reports.filter((r) => r.status !== 'ok');
if (flagged.length === 0) {
  console.log('全部文件在阈值内（warn=300 crit=600），无巨石。');
} else {
  console.log(`${flagged.length} 个文件超阈值（warn=300 crit=600）：`);
  for (const r of flagged.sort((a, b) => b.lines - a.lines)) {
    const advice = r.communities.length >= 3 ? `可拆 ${r.communities.length} 社区` : '内聚，勿强拆';
    console.log(`  ${r.status === 'crit' ? '!!' : ' !'} ${r.path}: ${r.lines}行 ${advice}`);
  }
}

// ── 3. derive_detail_chain：关键文件调用链 ──────────────────────
console.log('\n═══ 3/5 derive_detail_chain：关键文件调用链 ═══');
for (const rel of CHAIN_TARGETS) {
  try {
    const r = await deriveDetailChain({
      feature: FEATURE,
      node_id: fileNodeId(rel),
      source_path: path.join(SRC, rel),
    });
    console.log(`  ${rel}: ${r.chain.map((c) => c.name).join(' → ') || '(空链)'}`);
  } catch (e) {
    console.log(`  ${rel}: [跳过] ${e.message.split('\n')[0]}`);
  }
}

// ── 4. derive_algorithm：关键函数控制流 ─────────────────────────
console.log('\n═══ 4/5 derive_algorithm：关键函数控制流 ═══');
for (const t of ALG_TARGETS) {
  try {
    const r = await deriveAlgorithm({
      feature: FEATURE,
      node_id: fileNodeId(t.file),
      function: t.fn,
      source_path: path.join(SRC, t.file),
    });
    const s = r.stats;
    console.log(`  ${t.fn}(): ${s.steps}步骤·${s.branches}分支·${s.loops}循环·${s.returns}return${r.truncated ? '（深层已折叠）' : ''}`);
  } catch (e) {
    console.log(`  ${t.fn}(): [跳过] ${e.message.split('\n')[0]}`);
  }
}

// ── 5. 渲染星图 HTML ────────────────────────────────────────────
console.log('\n═══ 5/5 渲染星图 ═══');
const dsl = getDSL(FEATURE);
// 架构分层（序号5/7）：按目录/文件名推断每个文件所属架构层并生成 layers 定义，供图层着色
const dslLayered = detectArchLayers(dsl);
const nNodes = dslLayered.geometry.nodes.length;
const nDeep = dslLayered.geometry.nodes.filter((n) => (n.layer || 'main') !== 'main').length;

// 导读面板数据：概况指标 + 巨石榜单（点击直达节点）+ 推荐探索路径
const topHotspots = [...flagged].sort((a, b) => b.lines - a.lines).slice(0, 5);
const report = {
  subline: `生成于 ${new Date().toLocaleString('zh-CN')} · 数据源：src/ 静态解析（tree-sitter）`,
  metrics: [
    { label: '文件', value: String(imp.files_parsed) },
    { label: '符号', value: String(imp.symbols_found) },
    { label: '依赖边', value: String(imp.dep_edges) },
    { label: '超阈值文件', value: String(flagged.length) },
    { label: '深层节点', value: String(nDeep) },
    { label: '架构层', value: String(dslLayered.layers?.length ?? 0) },
  ],
  hotspots: topHotspots.map((r) => ({
    node_id: fileNodeId(r.path),
    label: r.path,
    detail: `${r.lines} 行 · ${r.communities.length >= 3 ? `可拆 ${r.communities.length} 社区` : '内聚勿拆'}`,
    severity: r.status === 'crit' ? 'crit' : 'warn',
  })),
  tour: [
    ...(topHotspots.length > 0
      ? [{ node_id: fileNodeId(topHotspots[0].path), text: `先看最大巨石 ${topHotspots[0].path}（${topHotspots[0].lines} 行）——它为什么长这么大？` }]
      : []),
    { node_id: fileNodeId('tools/import_project.ts'), text: '点 import_project.ts 左上 ▸ 角标，展开导入流水线的 8 步调用链' },
    { node_id: fileNodeId('tools/derive_algorithm.ts'), text: '再展开 derive_algorithm.ts，钻入算法控制流：分支=◆ 循环=⬡' },
  ],
};
const html0 = renderHTML(dslLayered, {
  report,
  nav: { home_href: './index.html', home_label: '主页' },
  compact_toolbar: true,
});

// ── 报告保鲜检查（三页共用）：过期横幅 + 一键重新生成 + SSE 自动刷新 ──
const FRESHNESS_CSS = `
  .stale-bar {
    position: sticky; top: 0; z-index: 1000;
    display: flex; align-items: center; justify-content: center; gap: 12px;
    background: rgba(255, 179, 0, 0.13);
    border-bottom: 1px solid rgba(255, 179, 0, 0.45);
    color: #ffd54f; padding: 8px 16px; font-size: 13px;
    backdrop-filter: blur(6px);
  }
  .stale-bar button {
    background: rgba(255, 179, 0, 0.2); color: #ffd54f;
    border: 1px solid rgba(255, 179, 0, 0.5); border-radius: 7px;
    padding: 3px 12px; font-size: 12px; cursor: pointer;
  }
  .stale-bar button:hover:not(:disabled) { background: rgba(255, 179, 0, 0.32); }
  .stale-bar button:disabled { opacity: 0.6; cursor: wait; }
`;
const FRESHNESS_JS = `<script>
(function() {
  if (location.protocol === 'file:') return;
  fetch('/api/report_status').then(function(r){ return r.ok ? r.json() : null; }).then(function(st){
    if (!st || !st.stale) return;
    var bar = document.createElement('div');
    bar.className = 'stale-bar';
    var info = document.createElement('span');
    info.textContent = '\\u26A0 报告已过期：src/ 有 ' + st.changed_files + ' 个文件在生成后变更';
    var btn = document.createElement('button');
    btn.textContent = '重新生成';
    btn.onclick = function() {
      btn.disabled = true;
      btn.textContent = '生成中…';
      fetch('/api/regenerate', { method: 'POST' }).finally(function() { location.reload(); });
    };
    bar.appendChild(info);
    bar.appendChild(btn);
    document.body.prepend(bar);
  }).catch(function() { /* 服务未起：静默 */ });
  try {
    var es = new EventSource('/api/events');
    es.addEventListener('report-regenerated', function() { location.reload(); });
  } catch (e) {}
})();
</scr` + `ipt>`;

const html = html0
  .replace('</style>', FRESHNESS_CSS + '</style>')
  .replace('</body>', FRESHNESS_JS + '\n</body>');
fs.mkdirSync('output', { recursive: true });
const out = path.resolve('output', 'self_analyze.html');
fs.writeFileSync(out, html, 'utf-8');
regArt('self_analyze.html', { feature: FEATURE, title: '项目星图', type: 'feature_diagram', language: 'ts', status: dsl.status || 'done' });

console.log(`节点 ${nNodes}（深层 ${nDeep}）· 边 ${dsl.geometry.edges.length}`);
console.log(`\n[输出] ${out} (${(html.length / 1024).toFixed(0)}KB)`);

// ── 6. 拆分建议页（独立文档页，非画布） ─────────────────────────
console.log('\n═══ 6/7 巨石拆分建议页 ═══');

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const critCount = flagged.filter((r) => r.status === 'crit').length;
const generatedAt = new Date().toLocaleString('zh-CN');

/** Hub 子页面共享的星图风格 CSS（深空底 + 玻璃卡片） */
const HUB_REGISTRY_CSS = `
  .toolbar { display:flex; gap:10px; align-items:center; flex-wrap:wrap; max-width:1100px; margin:0 auto; padding:6px 28px 18px; }
  .toolbar input[type=text], .toolbar select { background:rgba(6,11,31,.75); border:1px solid rgba(125,211,252,.25); color:#dbe7ff; border-radius:8px; padding:7px 12px; font-size:13px; outline:none; }
  .toolbar input[type=text]{ flex:1; min-width:180px; }
  .toolbar button { background:rgba(125,211,252,.12); border:1px solid rgba(125,211,252,.25); color:#7dd3fc; border-radius:8px; padding:7px 14px; font-size:13px; cursor:pointer; }
  .toolbar .count { font-size:12px; opacity:.6; }
  #artifact-cards { max-width:1100px; margin:0 auto; padding:0 28px 40px; }
  .group { margin-bottom:22px; }
  .group-title { font-size:13px; opacity:.6; margin-bottom:10px; letter-spacing:1px; display:flex; align-items:center; gap:8px; }
  .group-title span { background:rgba(125,211,252,.15); color:#7dd3fc; border-radius:20px; padding:1px 9px; font-size:12px; }
  .group-title .tour-btn { margin-left:auto; font-size:12px; color:#7dd3fc; background:rgba(125,211,252,.1); border:1px solid rgba(125,211,252,.25); border-radius:8px; padding:3px 12px; text-decoration:none; }
  .group-title .tour-btn:hover { background:rgba(125,211,252,.2); }
  .group-cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(300px,1fr)); gap:16px; }
  .card { background:rgba(6,11,31,.75); border:1px solid rgba(125,211,252,.16); border-radius:14px; padding:18px 18px 14px; transition:all .18s ease; }
  .card:hover { border-color:#7dd3fc; transform:translateY(-2px); box-shadow:0 10px 30px rgba(125,211,252,.12); }
  .card-top { display:flex; gap:6px; align-items:center; margin-bottom:10px; }
  .card h3 { font-size:16px; margin-bottom:6px; }
  .card h3 a { color:#e8f1ff; }
  .card .meta { font-size:12px; opacity:.55; margin-bottom:8px; }
  .card .note { font-size:12px; color:#c4b5fd; background:rgba(196,181,253,.08); border-radius:8px; padding:8px 10px; margin-bottom:8px; }
  .tags { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px; min-height:4px; }
  .tag { font-size:11px; color:#7dd3fc; background:rgba(125,211,252,.1); padding:2px 8px; border-radius:20px; }
  .cchip { font-size:10px; padding:2px 8px; border-radius:20px; color:#04121f; font-weight:600; }
  .card .type { font-size:11px; opacity:.5; margin-left:auto; }
  .acts { display:flex; align-items:center; justify-content:space-between; }
  .ago { font-size:11px; opacity:.45; }
  .card .edit { font-size:12px; color:#7dd3fc; background:transparent; border:1px solid rgba(125,211,252,.25); border-radius:7px; padding:4px 10px; cursor:pointer; }
  .card .edit:hover { background:rgba(125,211,252,.12); }
  .empty { text-align:center; opacity:.6; padding:40px 0; font-size:13px; }
  .empty code { background:rgba(125,211,252,.1); padding:2px 8px; border-radius:5px; }
  .modal { display:none; position:fixed; inset:0; background:rgba(2,4,13,.7); backdrop-filter:blur(4px); align-items:center; justify-content:center; z-index:50; }
  .modal-panel { background:#0a1226; border:1px solid rgba(125,211,252,.25); border-radius:16px; padding:22px; width:min(420px,92vw); }
  .modal-panel h3 { margin-bottom:4px; }
  .modal-panel .e-path { font-size:12px; opacity:.55; margin-bottom:14px; word-break:break-all; }
  .modal-panel label { display:block; font-size:12px; opacity:.6; margin:10px 0 4px; }
  .modal-panel input, .modal-panel select, .modal-panel textarea { width:100%; background:rgba(125,211,252,.06); border:1px solid rgba(125,211,252,.2); color:#dbe7ff; border-radius:8px; padding:7px 10px; font-size:13px; outline:none; }
  .modal-panel textarea { min-height:64px; resize:vertical; }
  .modal-acts { display:flex; gap:10px; justify-content:flex-end; margin-top:16px; }
  .modal-acts button { padding:7px 16px; border-radius:8px; font-size:13px; cursor:pointer; border:1px solid rgba(125,211,252,.25); }
  #e-cancel { background:transparent; color:#dbe7ff; }
  #e-save { background:rgba(125,211,252,.15); color:#7dd3fc; }
`;

const HUB_REGISTRY_JS = `<script>
(function(){
  var STATUS_COLOR = { done:'#4ade80', in_progress:'#fbbf24', draft:'#94a3b8' };
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  var state = { list:[], q:'', status:'', grouped:true };
  function chip(label, color){ return '<span class="cchip" style="background:'+color+'">'+esc(label)+'</span>'; }
  function card(a){
    var title = a.title || a.path;
    var tags = (a.tags||[]).map(function(t){ return '<span class="tag">#'+esc(t)+'</span>'; }).join('');
    var st = a.status || 'draft';
    var lang = a.language ? chip(a.language.toUpperCase(), 'rgba(125,211,252,0.2)') : '';
    var stc = chip(st, STATUS_COLOR[st] || '#94a3b8');
    var note = a.note ? '<p class="note">'+esc(a.note)+'</p>' : '';
    return '<div class="card" data-path="'+esc(a.path)+'">'
      + '<div class="card-top">'+lang+stc+'<span class="type">'+esc(a.type||'')+'</span></div>'
      + '<h3><a href="'+esc(a.path)+'" target="_blank" rel="noopener">'+esc(title)+'</a></h3>'
      + '<p class="meta">'+esc(a.feature||'')+' · '+esc(a.path)+'</p>'
      + note
      + '<div class="tags">'+tags+'</div>'
      + '<div class="acts"><span class="ago">'+esc((a.updated_at||'').slice(0,10))+'</span><button class="edit" data-p="'+esc(a.path)+'">✎ 标记</button></div>'
      + '</div>';
  }
  function render(){
    var box = document.getElementById('artifact-cards');
    var list = state.list.filter(function(a){
      if(state.q){ var hay=(a.title+' '+a.path+' '+a.feature+' '+(a.tags||[]).join(' ')).toLowerCase(); if(hay.indexOf(state.q.toLowerCase())===-1) return false; }
      if(state.status && a.status!==state.status) return false;
      return true;
    });
    if(!list.length){ box.innerHTML = '<div class="empty">'+(state.q||state.status?'无匹配产物':'暂无注册产物，请先 <code>npm run serve</code> 并生成产物')+'</div>'; return; }
    var html = '';
    if(state.grouped){
      var byF = {};
      list.forEach(function(a){ var k=a.feature||'(未分组)'; (byF[k]=byF[k]||[]).push(a); });
      Object.keys(byF).sort().forEach(function(f){ html += '<div class="group"><div class="group-title">'+esc(f)+' <span>'+byF[f].length+'</span><a class="tour-btn" href="./tour.html?feature='+encodeURIComponent(f)+'" target="_blank">▶ 导览</a></div><div class="group-cards">'+byF[f].map(card).join('')+'</div></div>'; });
    } else { html = list.map(card).join(''); }
    box.innerHTML = html;
    box.querySelectorAll('.edit').forEach(function(b){ b.onclick = function(){ openEdit(b.getAttribute('data-p')); }; });
    var c = document.getElementById('count'); if(c) c.textContent = list.length + ' / ' + state.list.length;
  }
  function openEdit(path){
    var a = state.list.filter(function(x){ return x.path===path; })[0] || {};
    document.getElementById('e-path').textContent = path;
    document.getElementById('e-title').value = a.title || '';
    document.getElementById('e-status').value = a.status || 'draft';
    document.getElementById('e-tags').value = (a.tags||[]).join(', ');
    document.getElementById('e-note').value = a.note || '';
    document.getElementById('e-save').dataset.path = path;
    document.getElementById('edit-modal').style.display = 'flex';
  }
  function saveEdit(){
    var path = document.getElementById('e-save').dataset.path;
    var payload = { path:path, patch:{
      title: document.getElementById('e-title').value.trim(),
      status: document.getElementById('e-status').value,
      tags: document.getElementById('e-tags').value.split(',').map(function(s){ return s.trim(); }).filter(Boolean),
      note: document.getElementById('e-note').value.trim()
    }};
    fetch('/api/registry', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) })
      .then(function(r){ return r.json(); })
      .then(function(j){ if(j.success){ document.getElementById('edit-modal').style.display='none'; loadArtifacts(); } else { alert(j.error||'保存失败'); } })
      .catch(function(){ alert('保存失败：请确认已用 npm run serve 启动'); });
  }
  function loadArtifacts(){
    fetch('/api/registry').then(function(r){ return r.json(); }).then(function(j){
      state.list = j.artifacts || [];
      render();
    }).catch(function(){
      document.getElementById('artifact-cards').innerHTML = '<div class="empty">无法连接产物注册表。请先 <code>npm run serve</code>（或 <code>npm run hub</code>）启动服务后刷新。</div>';
    });
  }
  function onReady(){ document.addEventListener('DOMContentLoaded', bind); if(document.readyState!=='loading') bind(); }
  function bind(){
    document.getElementById('q').addEventListener('input', function(e){ state.q=e.target.value; render(); });
    document.getElementById('status-filter').addEventListener('change', function(e){ state.status=e.target.value; render(); });
    document.getElementById('group-toggle').addEventListener('click', function(){ state.grouped=!state.grouped; this.classList.toggle('on', state.grouped); render(); });
    document.getElementById('e-cancel').addEventListener('click', function(){ document.getElementById('edit-modal').style.display='none'; });
    document.getElementById('e-save').addEventListener('click', saveEdit);
    loadArtifacts();
  }
  onReady();
})();
</script>`;

const HUB_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    background: #02040d;
    background-image:
      radial-gradient(ellipse 42% 30% at 72% 18%, rgba(196, 181, 253, 0.06), transparent 70%),
      radial-gradient(ellipse 38% 26% at 18% 78%, rgba(125, 211, 252, 0.05), transparent 70%),
      radial-gradient(1.5px 1.5px at 25% 35%, rgba(255,255,255,0.8) 50%, transparent 51%),
      radial-gradient(1px 1px at 70% 60%, rgba(255,255,255,0.6) 50%, transparent 51%),
      radial-gradient(1.2px 1.2px at 45% 80%, rgba(255,255,255,0.5) 50%, transparent 51%);
    background-size: 100% 100%, 100% 100%, 340px 340px, 280px 280px, 240px 240px;
    color: #dbe7ff;
    min-height: 100vh;
  }
  a { color: #7dd3fc; text-decoration: none; }
  .topnav {
    display: flex; gap: 10px; align-items: center;
    padding: 14px 28px;
    border-bottom: 1px solid rgba(125, 211, 252, 0.15);
    background: rgba(6, 11, 31, 0.8);
    backdrop-filter: blur(8px);
    position: sticky; top: 0; z-index: 10;
  }
  .topnav a {
    padding: 5px 12px; border-radius: 8px; font-size: 13px;
    border: 1px solid transparent; transition: all 0.15s ease;
  }
  .topnav a:hover { border-color: #7dd3fc; background: rgba(125, 211, 252, 0.1); }
  .topnav .current { margin-left: auto; font-size: 13px; opacity: 0.6; }
  .page-head { padding: 34px 28px 10px; max-width: 1080px; margin: 0 auto; }
  .page-head h1 { font-size: 26px; margin-bottom: 6px; }
  .page-head .sub { font-size: 13px; opacity: 0.6; }
  .page-body { padding: 18px 28px 40px; max-width: 1080px; margin: 0 auto; }
`;

const monolithCards = [...flagged]
  .sort((a, b) => b.lines - a.lines)
  .map((r) => {
    const sev = r.status === 'crit' ? 'crit' : 'warn';
    const comms = r.communities.length > 0
      ? `<div class="comm-list">${r.communities
          .map(
            (c) => `<div class="comm">
              <span class="comm-name">📄 ${escHtml(c.suggested_name)}</span>
              <span class="comm-meta">${c.decls.length} 声明 · ~${c.est_lines} 行 · 内聚 ${c.internal_refs}</span>
              <div class="comm-sigs">${c.signatures.slice(0, 3).map((s) => `<code>${escHtml(s)}</code>`).join('')}${c.signatures.length > 3 ? `<span class="more">…等 ${c.signatures.length} 个</span>` : ''}</div>
            </div>`,
          )
          .join('')}</div>`
      : '';
    const inter = r.inter_edges.length > 0 ? `<div class="inter">⚠ 跨社区引用 ${r.inter_edges.length} 条（拆开需顺边搬迁）</div>` : '';
    return `<div class="mcard ${sev}">
      <div class="mcard-head">
        <span class="mpath">${escHtml(r.path)}</span>
        <span class="mbadge ${sev}">${sev === 'crit' ? '严重' : '警告'}</span>
        <span class="mlines">${r.lines} 行 · ${r.decl_count} 声明</span>
        <button class="mplan" type="button" data-path="${escHtml(r.path)}" title="生成拆分任务单（Markdown，可喂给 LLM 执行拆分）">📋 任务单</button>
        <a class="mfly" href="./self_analyze.html#fly=${escHtml(fileNodeId(r.path))}">在星图中定位 →</a>
      </div>
      <p class="msug">${escHtml(r.suggestion)}</p>
      ${comms}
      ${inter}
    </div>`;
  })
  .join('\n');

const monolithPage = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>巨石拆分建议 - design-canvas</title>
<style>${HUB_CSS}
  .mcard {
    background: rgba(6, 11, 31, 0.75);
    border: 1px solid rgba(125, 211, 252, 0.18);
    border-left: 3px solid #ffb300;
    border-radius: 12px;
    padding: 16px 20px;
    margin-bottom: 14px;
  }
  .mcard.crit { border-left-color: #ef5350; }
  .mcard-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .mpath { font-family: Consolas, monospace; font-size: 15px; font-weight: 600; }
  .mbadge { font-size: 11px; padding: 2px 8px; border-radius: 10px; }
  .mbadge.crit { background: rgba(239, 83, 80, 0.2); color: #ef9a9a; }
  .mbadge.warn { background: rgba(255, 179, 0, 0.18); color: #ffd54f; }
  .mlines { font-size: 12px; opacity: 0.65; }
  .mfly { margin-left: auto; font-size: 12px; padding: 4px 10px; border-radius: 7px; border: 1px solid rgba(125, 211, 252, 0.3); }
  .mfly:hover { background: rgba(125, 211, 252, 0.12); }
  .msug { font-size: 13px; opacity: 0.85; margin: 10px 0 4px; }
  .comm-list { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
  .comm { background: rgba(2, 4, 13, 0.6); border: 1px solid rgba(125, 211, 252, 0.12); border-radius: 9px; padding: 10px 14px; }
  .comm-name { font-size: 13px; font-weight: 600; color: #7dd3fc; }
  .comm-meta { font-size: 11px; opacity: 0.6; margin-left: 10px; }
  .comm-sigs { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px; }
  .comm-sigs code { font-size: 11px; background: rgba(125, 211, 252, 0.08); padding: 2px 7px; border-radius: 5px; }
  .comm-sigs .more { font-size: 11px; opacity: 0.5; }
  .inter { margin-top: 10px; font-size: 12px; color: #ffd54f; opacity: 0.9; }
  /* 拆分任务单 */
  .mplan { font-size: 12px; padding: 4px 10px; border-radius: 7px; border: 1px solid rgba(255, 179, 0, 0.4); background: rgba(255, 179, 0, 0.1); color: #ffd54f; cursor: pointer; }
  .mplan:hover:not(:disabled) { background: rgba(255, 179, 0, 0.22); }
  .mplan:disabled { opacity: 0.55; cursor: wait; }
  .plan-overlay { position: fixed; inset: 0; background: rgba(1, 2, 8, 0.72); z-index: 2000; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(4px); }
  .plan-modal { width: min(880px, 92vw); max-height: 84vh; background: #060b1f; border: 1px solid rgba(125, 211, 252, 0.3); border-radius: 14px; display: flex; flex-direction: column; box-shadow: 0 24px 80px rgba(0,0,0,0.5); }
  .plan-head { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid rgba(125, 211, 252, 0.15); }
  .plan-head .t { font-size: 15px; font-weight: 600; }
  .plan-head .sp { flex: 1; }
  .plan-head button { font-size: 12px; padding: 5px 13px; border-radius: 7px; border: 1px solid rgba(125, 211, 252, 0.35); background: transparent; color: #7dd3fc; cursor: pointer; }
  .plan-head button:hover { background: rgba(125, 211, 252, 0.12); }
  .plan-body { overflow: auto; padding: 16px 22px; }
  .plan-body pre { white-space: pre-wrap; word-break: break-word; font-size: 12.5px; line-height: 1.75; font-family: Consolas, 'Courier New', monospace; color: #c9dcf5; }
${FRESHNESS_CSS}
</style>
</head>
<body>
  <nav class="topnav">
    <a href="./index.html">🏠 主页</a>
    <a href="./self_analyze.html">🌌 星图</a>
    <span class="current">🪓 拆分建议</span>
  </nav>
  <div class="page-head">
    <h1>🪓 巨石文件拆分建议</h1>
    <p class="sub">阈值 警告≥300 行 / 严重≥600 行 · ${flagged.length} 个文件超阈值（${critCount} 严重）· 生成于 ${generatedAt}</p>
  </div>
  <div class="page-body">
    ${monolithCards}
  </div>
<script>
(function() {
  var offline = location.protocol === 'file:';
  document.querySelectorAll('.mplan').forEach(function(btn) {
    if (offline) {
      btn.disabled = true;
      btn.title = '需要 npm run serve（或 npm run hub）启动服务后可用';
      return;
    }
    btn.addEventListener('click', function() {
      var p = btn.getAttribute('data-path');
      btn.disabled = true;
      var orig = btn.textContent;
      btn.textContent = '生成中…';
      fetch('/api/split_plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p }),
      })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.error) { alert('生成失败：' + d.error); return; }
          showPlan(p, d.markdown, d.filename || 'split_plan.md');
        })
        .catch(function(e) { alert('生成失败：' + e.message); })
        .finally(function() { btn.disabled = false; btn.textContent = orig; });
    });
  });

  function showPlan(path, md, filename) {
    var overlay = document.createElement('div');
    overlay.className = 'plan-overlay';
    overlay.innerHTML =
      '<div class="plan-modal">' +
        '<div class="plan-head">' +
          '<span class="t">📋 拆分任务单 · ' + path + '</span>' +
          '<span class="sp"></span>' +
          '<button data-act="copy">复制</button>' +
          '<button data-act="download">下载 .md</button>' +
          '<button data-act="close">关闭 ✕</button>' +
        '</div>' +
        '<div class="plan-body"><pre></pre></div>' +
      '</div>';
    overlay.querySelector('pre').textContent = md;
    overlay.addEventListener('click', function(e) {
      var act = e.target.getAttribute && e.target.getAttribute('data-act');
      if (e.target === overlay || act === 'close') { overlay.remove(); return; }
      if (act === 'copy') {
        navigator.clipboard.writeText(md).then(function() { e.target.textContent = '已复制 ✓'; });
      } else if (act === 'download') {
        var blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
      }
    });
    document.body.appendChild(overlay);
  }
})();
</script>
${FRESHNESS_JS}
</body>
</html>`;
fs.writeFileSync(path.resolve('output', 'monolith_report.html'), monolithPage, 'utf-8');
regArt('monolith_report.html', { feature: FEATURE, title: '巨石拆分建议', type: 'report', language: 'ts', status: 'done' });
console.log(`[输出] output/monolith_report.html（${flagged.length} 个巨石卡片）`);

// ── 7. Hub 主页（项目入口：导航到各产物页） ─────────────────────
console.log('\n═══ 7/7 Hub 主页 ═══');
const hubPage = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>design-canvas 项目主页</title>
<style>${HUB_CSS}
  .hero { text-align: center; padding: 60px 28px 30px; }
  .hero h1 { font-size: 34px; letter-spacing: 1px; margin-bottom: 10px; text-shadow: 0 0 24px rgba(125, 211, 252, 0.4); }
  .hero .sub { font-size: 13px; opacity: 0.6; }
  .metrics { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; padding: 10px 28px 30px; }
  .metric { background: rgba(6, 11, 31, 0.75); border: 1px solid rgba(125, 211, 252, 0.18); border-radius: 12px; padding: 14px 22px; text-align: center; min-width: 100px; }
  .metric .v { font-size: 24px; font-weight: 700; color: #7dd3fc; }
  .metric .l { font-size: 12px; opacity: 0.65; margin-top: 3px; }
  .page-foot { text-align: center; font-size: 12px; opacity: 0.5; padding: 0 28px 40px; line-height: 1.9; }
  .page-foot code { background: rgba(125, 211, 252, 0.1); padding: 2px 8px; border-radius: 5px; }
${FRESHNESS_CSS}
${HUB_REGISTRY_CSS}
</style>
</head>
<body>
  <div class="hero">
    <h1>🌌 design-canvas</h1>
    <p class="sub">项目自我分析主页 · 生成于 ${generatedAt} · 数据源 src/ 静态解析</p>
  </div>
  <div class="metrics">
    <div class="metric"><div class="v">${imp.files_parsed}</div><div class="l">文件</div></div>
    <div class="metric"><div class="v">${imp.symbols_found}</div><div class="l">符号</div></div>
    <div class="metric"><div class="v">${imp.dep_edges}</div><div class="l">依赖边</div></div>
    <div class="metric"><div class="v">${flagged.length}</div><div class="l">超阈值文件</div></div>
    <div class="metric"><div class="v">${nDeep}</div><div class="l">深层节点</div></div>
  </div>
  <div class="toolbar">
    <input type="text" id="q" placeholder="🔍 搜索标题 / 文件 / 标签…">
    <select id="status-filter">
      <option value="">全部状态</option>
      <option value="done">done</option>
      <option value="in_progress">in_progress</option>
      <option value="draft">draft</option>
    </select>
    <button id="group-toggle" class="on">按 feature 分组</button>
    <span class="count" id="count"></span>
  </div>
  <div id="artifact-cards"><div class="empty">加载产物注册表…</div></div>
  <div class="page-foot">
    产物由生成时自动注册 + 人工打标记（点卡片「✎ 标记」）。重新生成：<code>npm run self-analyze</code> 或 <code>npm run hub</code>。
  </div>
  <div class="modal" id="edit-modal">
    <div class="modal-panel">
      <h3>✎ 编辑产物</h3>
      <div class="e-path" id="e-path"></div>
      <label>标题</label>
      <input id="e-title" type="text">
      <label>状态</label>
      <select id="e-status">
        <option value="done">done</option>
        <option value="in_progress">in_progress</option>
        <option value="draft">draft</option>
      </select>
      <label>标签（逗号分隔）</label>
      <input id="e-tags" type="text" placeholder="如: 核心, 星图, 导览">
      <label>备注</label>
      <textarea id="e-note" placeholder="给自己/团队看的说明…"></textarea>
      <div class="modal-acts">
        <button id="e-cancel">取消</button>
        <button id="e-save">保存</button>
      </div>
    </div>
  </div>
${FRESHNESS_JS}
${HUB_REGISTRY_JS}
</body>
</html>`;
fs.writeFileSync(path.resolve('output', 'index.html'), hubPage, 'utf-8');
console.log('[输出] output/index.html（Hub 主页）');

fs.rmSync('.tmp_self_analyze', { recursive: true, force: true });
console.log('[cleanup] .tmp_self_analyze removed');
