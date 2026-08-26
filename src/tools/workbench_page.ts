/**
 * workbench_page —— 唯一前端出口 `/workbench`（单出口）
 *
 * 用户定调（2026-08-25）：
 *   -「只保留这一个前端出口，其他前端产物全部废弃」：废弃 Hub（/、/project）、
 *     思维导图（/mindmap）、独立代码审批工作台（/code-workbench）、teach（/tour.html、
 *     /explain.html）。旧地址一律 302 → /workbench。
 *   - 载体 = DSL 协作工作台的 live 页，把全部集成收拢到这里：
 *       · 协作画布：注册表里 DSL 工作台产物（workbench_artifact）以 iframe 嵌入；
 *       · 沙盘反馈：/api/live + /api/diff-views 实时反映「设计与实际代码」的分化，
 *         代码审批执行后（写盘→重建 live），此处自动刷新体现结果（反馈进沙盘视图）；
 *       · 代码审批：右侧悬浮面板，复用 /api/code/propose|workbench|approve|reject
 *         （P3：改 → 看 diff → 点审批 → 执行），project_dir 取自 feature 的 source_root。
 *
 * 本页自包含（含壳 CSS），不再依赖 hub_page/mindmap_page/code_workbench_page（皆已废弃）。
 */

// ── 帮助 ──
function esc(s: string): string {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export function renderWorkbenchPage(): string {
  const body = `
  <style>
    :root{
      --bg:#02040d; --panel:rgba(6,11,31,.82); --line:rgba(125,211,252,.16);
      --fg:#dbe7ff; --mut:#7c8bb0; --sky:#7dd3fc; --ok:#4ade80; --bad:#f87171; --warn:#fbbf24;
    }
    *{margin:0;padding:0;box-sizing:border-box;}
    body{
      font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
      background:var(--bg);
      background-image:
        radial-gradient(ellipse 42% 30% at 72% 18%, rgba(196,181,253,.06), transparent 70%),
        radial-gradient(ellipse 38% 26% at 18% 78%, rgba(125,211,252,.05), transparent 70%);
      color:var(--fg); min-height:100vh; display:flex; flex-direction:column;
    }
    a{color:var(--sky);text-decoration:none;}
    .topbar{
      display:flex;align-items:center;gap:14px;padding:12px 22px;
      border-bottom:1px solid var(--line);background:rgba(6,11,31,.85);
      backdrop-filter:blur(8px);position:sticky;top:0;z-index:20;flex-wrap:wrap;
    }
    .logo{font-size:16px;font-weight:800;color:#e8f1ff;letter-spacing:.5px;}
    .logo span{color:var(--sky);}
    .tagline{font-size:12px;opacity:.55;margin-right:auto;}
    .ctrl{display:flex;gap:8px;align-items:center;}
    select,input[type=text],input[type=number],textarea{
      background:#0b1120;border:1px solid var(--line);color:var(--fg);
      border-radius:8px;padding:7px 10px;font-size:12.5px;
    }
    button{
      background:#0ea5e9;color:#04121f;border:none;border-radius:8px;padding:7px 13px;
      font-size:12.5px;font-weight:700;cursor:pointer;
    }
    button.ghost{background:rgba(125,211,252,.1);color:var(--sky);}
    button.ok{background:#22c55e;} button.no{background:#ef4444;}
    .rail-toggle{
      background:rgba(125,211,252,.12);color:var(--sky);border:1px solid var(--line);
      border-radius:8px;padding:7px 12px;font-size:12.5px;cursor:pointer;
    }
    .main{flex:1;display:flex;min-height:0;}
    .col{flex:1;padding:18px 22px;overflow-y:auto;display:flex;flex-direction:column;gap:16px;min-width:0;}
    .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px 16px;}
    .card h2{font-size:14px;margin-bottom:4px;color:#e8f1ff;display:flex;align-items:center;gap:8px;}
    .card .sub{font-size:12px;opacity:.55;margin-bottom:12px;}
    .iframe-wrap{border-radius:10px;overflow:hidden;border:1px solid var(--line);background:#050a18;}
    iframe{width:100%;height:520px;border:0;display:block;background:#050a18;}
    .chips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;}
    .chip{font-size:12px;padding:4px 10px;border-radius:20px;background:rgba(125,211,252,.1);color:var(--sky);}
    .chip b{font-weight:800;}
    .chip.g{background:rgba(74,222,128,.12);color:var(--ok);}
    .chip.r{background:rgba(248,113,113,.12);color:var(--bad);}
    .chip.y{background:rgba(251,191,36,.12);color:var(--warn);}
    .frows div{font-size:12px;color:#b9c7e6;padding:4px 2px;border-bottom:1px solid rgba(255,255,255,.04);display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
    .frows .fp{font-family:ui-monospace,Consolas,monospace;color:var(--fg);word-break:break-all;}
    .badge{font-size:10.5px;padding:2px 7px;border-radius:20px;font-weight:700;}
    .b-m{background:rgba(251,191,36,.15);color:var(--warn);}
    .b-a{background:rgba(74,222,128,.15);color:var(--ok);}
    .b-r{background:rgba(248,113,113,.15);color:var(--bad);}
    .b-u{background:rgba(125,211,252,.12);color:var(--mut);}
    .watch{font-size:11px;color:var(--mut);}
    .err{font-size:12px;color:var(--bad);background:rgba(248,113,113,.08);border-radius:8px;padding:8px 10px;margin-top:8px;white-space:pre-wrap;}
    .note{font-size:12px;color:var(--mut);padding:14px;text-align:center;}
    .note code{background:rgba(125,211,252,.1);padding:2px 6px;border-radius:5px;}

    /* 右侧代码审批 */
    .rail{
      width:410px;flex-shrink:0;background:var(--panel);border-left:1px solid var(--line);
      overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;min-height:0;
    }
    .rail.hidden{display:none;}
    .rail h2{font-size:14px;color:#e8f1ff;display:flex;align-items:center;gap:8px;}
    .rail .lbl{font-size:12px;opacity:.7;white-space:nowrap;width:110px;flex-shrink:0;}
    .row{display:flex;gap:8px;align-items:center;margin:7px 0;}
    textarea{font-family:ui-monospace,Consolas,monospace;width:100%;resize:vertical;}
    .tc{font-size:12px;opacity:.55;margin-bottom:4px;}
    .acard{background:rgba(2,6,19,.5);border:1px solid var(--line);border-radius:10px;padding:10px 12px;}
    .acard-top{display:flex;align-items:center;gap:8px;}
    .kind-tag{font-size:10.5px;padding:2px 8px;border-radius:20px;background:rgba(125,211,252,.15);color:var(--sky);}
    .kind-tag.rename_file{background:rgba(34,197,94,.15);color:var(--ok);}
    .alabel{font-size:13px;font-weight:700;flex:1;}
    .astat{font-size:11px;font-weight:800;letter-spacing:.5px;}
    .ameta,.asumm{font-size:11px;opacity:.55;margin-top:5px;}
    .adec{font-size:12px;color:var(--ok);margin-top:6px;white-space:pre-wrap;}
    .aerr{font-size:12px;color:var(--bad);margin-top:6px;white-space:pre-wrap;}
    .dfile{margin-top:8px;border:1px solid rgba(255,255,255,.06);border-radius:8px;overflow:hidden;}
    .dfile-head{font-size:11px;background:rgba(255,255,255,.04);padding:5px 9px;color:var(--sky);font-family:ui-monospace,Consolas,monospace;}
    .dfile code{display:block;font-family:ui-monospace,Consolas,monospace;font-size:11px;max-height:260px;overflow:auto;}
    .d{display:flex;gap:8px;padding:1px 9px;white-space:pre;line-height:1.5;font-size:11px;}
    .d .ln{color:#475569;min-width:26px;text-align:right;user-select:none;}
    .d.c{color:#b9c7e6;}
    .d.rm{background:rgba(248,113,113,.12);color:#fca5a5;}
    .d.add{background:rgba(74,222,128,.12);color:#86efac;}
    .empty{font-size:12px;opacity:.5;text-align:center;padding:14px;}
  </style>

  <div class="topbar">
    <div class="logo">design<span>·</span>canvas</div>
    <div class="tagline">协作工作台 · 唯一出口</div>
    <div class="ctrl">
      <select id="feature"></select>
      <button id="refresh" class="ghost">刷新</button>
      <button id="rebuildLive">重建沙盘</button>
    </div>
  </div>

  <div class="main">
    <div class="col">
      <div class="card">
        <h2>协作画布</h2>
        <div class="sub" id="canvasSub">选择项目后在此载入 DSL 协作工作台产物。</div>
        <div class="iframe-wrap" id="canvasWrap"><div class="note" id="canvasEmpty">尚未载入项目。</div></div>
      </div>
      <div class="card">
        <h2>沙盘反馈 <span class="watch" id="sandboxTime"></span></h2>
        <div class="sub">设计与实际代码的分化实时反映；代码审批写盘后在沙盘刷新体现结果。</div>
        <div id="sandbox">—</div>
      </div>
    </div>

    <div class="rail">
      <div style="display:flex;align-items:center;gap:8px;">
        <h2>代码审批</h2>
        <span style="flex:1"></span>
        <span id="pendCount" style="font-size:11px;color:var(--warn);font-weight:700;"></span>
      </div>
      <div id="railHint" style="font-size:12px;opacity:.55;white-space:pre-wrap;"></div>
      <div id="approval">—</div>
    </div>
  </div>
  <button id="toggleRail" class="rail-toggle" style="position:fixed;right:16px;bottom:16px;z-index:30;">收起审批</button>
  `;

  const script = `
  var $ = function(id){ return document.getElementById(id); };
  var F = null;           // 当前 feature
  var META = null;        // /api/feature-meta 结果
  var railVisible = true;

  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  // ── feature 选择器 ──
  function loadFeatures(pref){
    return fetch('/api/features').then(function(r){ return r.json(); }).then(function(j){
      var list = j.features || [];
      var sel = $('feature');
      sel.innerHTML = list.map(function(f){
        return '<option value="'+esc(f.feature)+'">'+esc(f.title||f.feature)+'（'+f.files+' 文件）</option>';
      }).join('');
      var chosen = null;
      if(pref) for(var i=0;i<list.length;i++) if(list[i].feature===pref){ chosen=list[i].feature; break; }
      if(!chosen && list.length) chosen = list[0].feature;
      if(chosen){ sel.value = chosen; activate(chosen); }
      else { $('canvasEmpty').textContent='尚未导入任何项目。'; $('canvasSub').textContent='用 design-canvas import 导入项目产生 DSL 后回来。'; }
    }).catch(function(e){ $('canvasEmpty').textContent='加载项目列表失败：'+e.message; });
  }
  $('feature').addEventListener('change', function(){ activate(this.value); });

  function activate(feature){
    F = feature; railVisible = true; $('rail').classList.remove('hidden');
    try{ localStorage.feature = feature; }catch(e){}
    $('canvasSub').textContent = '载入 '+feature+' 的协作画布…';
    $('canvasEmpty').textContent = '载入中…';
    fetch('/api/feature-meta?feature='+encodeURIComponent(F))
      .then(function(r){ return r.json(); })
      .then(function(j){
        if(!j.success){ $('canvasEmpty').textContent='feature-meta 失败：'+(j.error||''); return; }
        META = j;
        $('canvasSub').textContent = esc(j.title)+' ｜ source_root: '+(j.source_root||'（未设置）');
        if(j.workbench_artifact){
          $('canvasWrap').innerHTML = '<iframe id="wbFrame" src="'+j.workbench_artifact+'" loading="lazy"></iframe>';
        } else {
          $('canvasWrap').innerHTML = '<div class="note" id="canvasEmpty">该 feature 尚无工作台产物。<br>请跑<br><code>brickify_cli --dsl-workbench</code><br>生成后刷新加载。</div>';
        }
        loadSandbox(); loadApproval();
      })
      .catch(function(e){ $('canvasEmpty').textContent='feature-meta 请求失败：'+e.message; });
  }

  // ── 沙盘反馈：/api/live + /api/diff-views ──
  function loadSandbox(){
    $('sandbox').innerHTML = '<div class="empty">拉取沙盘与 diff…</div>';
    var t = new Date();
    Promise.all([
      fetch('/api/live?feature='+encodeURIComponent(F)).then(function(r){ return r.json(); }).catch(function(){ return null; }),
      fetch('/api/diff-views', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({feature:F})})
        .then(function(r){ return r.json(); }).catch(function(){ return null; })
    ]).then(function(results){
      var live = results[0], dv = results[1];
      $('sandboxTime').textContent = '更新于 '+String(t.getHours()).padStart(2,'0')+':'+String(t.getMinutes()).padStart(2,'0');
      if((!live || live.error || !live.feature) && (!dv || dv.error || !dv.data)){
        $('sandbox').innerHTML = '<div class="note">实际 DSL 未生成。点右上「重建沙盘」从当前代码重建 live 视图。</div>';
        return;
      }
      var s = (dv && dv.data) ? dv.data.summary : null;
      var chips = '';
      if(s){
        chips = '<div class="chips">'
          + '<span class="chip"><b>'+s.design_files+'</b> 设计文件</span>'
          + '<span class="chip"><b>'+s.live_files+'</b> 实际文件</span>'
          + '<span class="chip r"><b>'+s.added_files+'</b> +新增</span>'
          + '<span class="chip g"><b>'+s.removed_files+'</b> 移除</span>'
          + '<span class="chip y"><b>'+s.modified_files+'</b> 分化</span>'
          + '<span class="chip"><b>'+s.design_symbols+'</b>/<b>'+s.live_symbols+'</b> 符号</span>'
          + '<span class="chip y"><b>'+s.removed_edges+'</b> 边塌方</span>'
          + '<span class="chip"><b>'+s.added_edges+'</b> 新依赖</span>'
          + '</div>';
      }
      var files = (dv && dv.data && dv.data.files) || [];
      var rows = files.slice(0, 40).map(function(f){
        var tag = f.change==='modified'?'<span class="badge b-m">分化</span>'
          : f.change==='added'?'<span class="badge b-a">新增</span>'
          : f.change==='removed'?'<span class="badge b-r">移除</span>'
          : '<span class="badge b-u">一致</span>';
        return '<div><span class="fp">'+esc(f.path)+'</span> '+tag+'</div>';
      }).join('');
      $('sandbox').innerHTML = chips
        + '<div class="frows">'+(rows||'<div class="empty">两视图一致。</div>')+'</div>'
        + (files.length>40? '<div class="empty" style="padding-top:6px;">…共 '+files.length+' 个文件，前 40 个已展示</div>':'');
    }).catch(function(e){ $('sandbox').innerHTML = '<div class="err">沙盘加载失败：'+esc(e.message)+'</div>'; });
  }
  $('rebuildLive').addEventListener('click', function(){
    fetch('/api/live/rebuild?feature='+encodeURIComponent(F), {method:'POST'})
      .then(function(r){ return r.json(); })
      .then(function(j){ loadSandbox(); if(!j.success) alert('重建失败：'+j.error); })
      .catch(function(e){ alert('重建失败：'+e.message); });
  });

  // ── 代码审批（右侧面板）──
  function projectDir(){ return (META && META.source_root) || (F? F : ''); }

  function diffCard(d){
    var N = Math.max(d.before.length, d.after.length), rows = [];
    for(var i=0;i<N;i++){
      var b = d.before[i], a = d.after[i];
      if(b===a){ rows.push('<div class="d c"><span class="ln">'+(i+1)+'</span>'+esc(b)+'</div>'); }
      else {
        if(b!==undefined) rows.push('<div class="d rm"><span class="ln">'+(i+1)+'</span>-'+esc(b)+'</div>');
        if(a!==undefined) rows.push('<div class="d add"><span class="ln">'+(i+1)+'</span>+'+esc(a)+'</div>');
      }
    }
    return '<div class="dfile"><div class="dfile-head">'+esc(d.file)+'</div><code>'+
      (rows.length? rows.join('') : '<div class="d">（无内容变化）</div>') +
      '</code></div>';
  }

  function aCard(c){
    var color = c.status==='pending'?'var(--warn)':c.status==='executed'?'var(--ok)':'var(--bad)';
    var diffHtml = (c.diffs||[]).map(diffCard).join('');
    var actions = '';
    if(c.status==='pending') actions = '<div class="row" style="margin-top:8px;">'
      + '<button class="ok" data-act="approve" data-id="'+c.id+'">✓ 通过并执行</button>'
      + '<button class="no" data-act="reject" data-id="'+c.id+'">✕ 驳回</button></div>';
    return '<div class="acard" data-id="'+c.id+'">'
      + '<div class="acard-top"><span class="kind-tag '+(c.kind||'')+'">'+esc(c.kind)+'</span>'
      + '<span class="alabel">'+esc(c.label)+'</span>'
      + '<span class="astat" style="color:'+color+'">'+esc(c.status)+'</span></div>'
      + (c.summary&&c.summary.length? '<div class="asumm">'+c.summary.map(esc).join(' ／ ')+'</div>':'')
      + '<div class="ameta">'+esc(c.submitted_at)+(c.decided_at? '  ｜  '+esc(c.decided_at):'')+'</div>'
      + diffHtml
      + (c.lastError? '<div class="aerr">执行失败：'+esc(c.lastError)+'</div>':'')
      + (c.result? '<div class="adec">'+esc(c.result).replace(/\\n/g,'<br>')+'</div>':'')
      + actions + '</div>';
  }

  function loadApproval(){
    var pd = projectDir();
    if(!pd){ $('approval').innerHTML = '<div class="empty">无 project_dir，无法审批。</div>'; return; }
    $('railHint').textContent = '审批对象：'+pd+'\\n（feature 的 source_root）';
    $('approval').innerHTML = '<div class="empty">载入变更…</div>';
    fetch('/api/code/workbench?project_dir='+encodeURIComponent(pd))
      .then(function(r){ return r.json(); })
      .then(function(j){
        if(!j.success){ $('approval').innerHTML = '<div class="err">'+esc(j.error)+'</div>'; return; }
        renderApproval(j.changes||[]);
      })
      .catch(function(e){ $('approval').innerHTML = '<div class="err">'+esc(e.message)+'</div>'; });
  }

  function renderApproval(list){
    var pend = (list||[]).filter(function(c){ return c.status==='pending'; });
    var arch = (list||[]).filter(function(c){ return c.status!=='pending'; }).slice().reverse();
    $('pendCount').textContent = pend.length? pend.length+' 待审':'';
    var html = '<div class="tc">待审（'+pend.length+'）</div>'
      + (pend.map(aCard).join('') || '<div class="empty">没有待审变更。</div>')
      + '<details style="margin-top:14px;"><summary style="cursor:pointer;font-size:12px;color:var(--sky);">＋ 新建变更提案</summary>'
      + '<div class="row"><select id="kind" style="flex:1;font-size:12px;">'
      + '<option value="edit_code">行区间编辑 edit_code</option>'
      + '<option value="rename_file">移动/重命名 rename_file</option></select></div>'
      + '<div id="editFields">'
      + '<div class="row"><label class="lbl">文件</label><input id="efile" type="text" placeholder="src/tools/foo.ts"/></div>'
      + '<div class="row"><label class="lbl">起行</label><input id="estart" type="number" value="1"/></div>'
      + '<div class="row"><label class="lbl">止行</label><input id="eend" type="number" value="1"/></div>'
      + '<div class="row" style="align-items:flex-start;"><label class="lbl">新内容</label><textarea id="ecode" rows="4" placeholder="区间替换内容；空串=删除"></textarea></div></div>'
      + '<div id="renameFields" style="display:none;">'
      + '<div class="row"><label class="lbl">源 from</label><input id="rfrom" type="text" placeholder="src/a.ts"/></div>'
      + '<div class="row"><label class="lbl">目标 to</label><input id="rto" type="text" placeholder="src/b.ts"/></div></div>'
      + '<button id="proposeBtn" style="width:100%;margin-top:6px;">提交提案（干跑预览）</button>'
      + '<div id="proposeMsg" style="font-size:11px;margin-top:6px;white-space:pre-wrap;opacity:.8;"></div></details>'
      + '<div class="tc" style="margin-top:16px;">归档（'+arch.length+'）</div>'
      + (arch.map(aCard).join('') || '<div class="empty">还没有已处理记录。</div>');
    $('approval').innerHTML = html;

    $('kind').addEventListener('change', function(){
      var e = this.value==='edit_code';
      $('editFields').style.display = e?'':'none';
      $('renameFields').style.display = e?'none':'';
    });

    $('proposeBtn').addEventListener('click', function(){
      var pd = projectDir(); if(!pd) return;
      var op = { project_dir: pd }, kv = $('kind').value;
      if(kv==='edit_code'){ op.kind='edit_code'; op.op={ file:$('efile').value.trim(), start:parseInt($('estart').value,10), end:parseInt($('eend').value,10), code:$('ecode').value }; }
      else { op.kind='rename_file'; op.op={ from:$('rfrom').value.trim(), to:$('rto').value.trim() }; }
      $('proposeMsg').textContent = '干跑预览中…';
      fetch('/api/code/propose', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(op)})
        .then(function(r){ return r.json(); })
        .then(function(j){
          $('proposeMsg').textContent = j.success? '已生成提案 '+j.change.id+'（未写盘）': '预览失败：'+(j.error||'');
          loadApproval();
        })
        .catch(function(e){ $('proposeMsg').textContent='请求失败：'+e.message; });
    });
  }

  document.body.addEventListener('click', function(e){
    var btn = e.target.closest && e.target.closest('[data-act]');
    if(!btn) return;
    var act = btn.getAttribute('data-act'), id = btn.getAttribute('data-id'), pd = projectDir();
    if(!pd) return;
    if(act==='approve' && !confirm('确定通过并真正写盘这个变更吗？')) return;
    fetch('/api/code/'+act, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({project_dir:pd, id:id})})
      .then(function(r){ return r.json(); })
      .then(function(j){ loadApproval(); loadSandbox(); if(!j.success && j.error) alert('操作失败：'+j.error); })
      .catch(function(e){ alert('操作失败：'+e.message); });
  });

  $('refresh').addEventListener('click', function(){ loadFeatures(); });
  $('toggleRail').addEventListener('click', function(){
    railVisible = !railVisible;
    $('rail').classList.toggle('hidden', !railVisible);
    this.textContent = railVisible? '收起审批':'展开审批';
  });

  var pref = '';
  try{ pref = localStorage.feature || (location.hash? decodeURIComponent(location.hash.slice(1)) : ''); }catch(e){}
  loadFeatures(pref);
  `;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>design-canvas · 协作工作台</title>
</head>
<body>
${body}
<script>
(function(){
${script}
})();
</script>
</body>
</html>`;
}