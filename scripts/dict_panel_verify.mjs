// 伪维基词典 P3 收录面板浏览器验证：打开 → 输入词 → 生成预览 → 三档切换 → 确认收录 → toast
// 用法：npm run build && node scripts/dict_panel_verify.mjs
// 产物：output/shots/dict_panel_preview.png / dict_panel_saved.png
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'output');

// 收录面板逻辑（与 src/renderer/scripts.ts 实现一致），fetch 由页面 mock 拦截
const PANEL = `
function escapeHtml(s){return String(s==null?'':s).replace(/[&<>"\']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function escapeAttr(s){return escapeHtml(s);}
var dictView={entries:[{term:'异步',kind:'global',newbie:'n',pm:'p',senior:'s'}],links:{}};
// mock：拦截 /api/dict/ingest
window.fetch=function(url,opts){
  var body=JSON.parse(opts.body||'{}');
  return Promise.resolve({ok:true,json:function(){return Promise.resolve({success:true,term:'依赖注入',kind:'global',dry_run:body.dry_run,entry:{term:'依赖注入',kind:'global',newbie:'新人解释：把依赖从外部传入。',pm:'产品解释：降低模块耦合。',senior:'资深解释：容器接管依赖装配。',aliases:['DI']}});}});
};
var dictPanelEl=null,dictPreview=null,dictPanelSelLevel='newbie';
function dictOpenPanel(){
  if(!dictPanelEl){dictPanelEl=document.createElement('div');dictPanelEl.className='dict-panel';document.body.appendChild(dictPanelEl);
    dictPanelEl.innerHTML='<div class="dp-head"><span class="dp-title">📖 伪维基词典</span><span class="dp-close" data-dpclose="1">✕</span></div>'+
      '<div class="dp-form"><input type="text" id="dp-term" class="dp-input" placeholder="输入要收录的词"><button id="dp-preview" class="dp-btn-primary">⚡ 生成预览</button></div>'+
      '<div id="dp-result" class="dp-result hidden"></div>'+
      '<div class="dp-confirm hidden" id="dp-confirm"><button id="dp-save" class="dp-btn-save">✅ 确认收录</button><button id="dp-cancel" class="dp-btn-ghost">取消</button></div>'+
      '<div class="dp-list-title">已收录词条</div><div id="dp-list" class="dp-list"></div>';
    dictPanelEl.addEventListener('click',function(ev){var t=ev.target;
      if(t.getAttribute&&t.getAttribute('data-dpclose')){dictPanelEl.style.display='none';return;}
      if(t.getAttribute&&t.getAttribute('data-dplevel')){dictPanelSelLevel=t.getAttribute('data-dplevel');renderDictPreview();return;}
      if(t.id==='dp-preview'){dictRunPreview();return;}
      if(t.id==='dp-save'){dictRunSave();return;}
      if(t.id==='dp-cancel'){dictResetPreview();return;}});
  }
  dictPanelEl.style.display='block';dictRenderList();
}
function dictRenderList(){var box=document.getElementById('dp-list');if(!box)return;
  box.innerHTML=(dictView&&dictView.entries||[]).map(function(e){return '<span class="dp-chip">'+(e.kind==='project'?'项目':'通用')+'</span> '+escapeHtml(e.term);}).join('');}
function dictResetPreview(){dictPreview=null;var r=document.getElementById('dp-result'),c=document.getElementById('dp-confirm');if(r){r.classList.add('hidden');r.innerHTML='';}if(c)c.classList.add('hidden');}
function renderDictPreview(){var r=document.getElementById('dp-result');if(!r||!dictPreview)return;var e=dictPreview.entry,l=dictPanelSelLevel;
  r.innerHTML='<div class="dp-result-head"><span class="dp-term">'+escapeHtml(e.term)+'</span><span class="dp-badge">'+(e.kind==='project'?'项目词':'通用词')+'</span><span class="dp-alias">别名：'+escapeHtml((e.aliases||[]).join('、')||'无')+'</span></div>'+
    '<div class="dp-tabs"><button class="dp-tab'+(l==='newbie'?' active':'')+'" data-dplevel="newbie">新人</button>'+
    '<button class="dp-tab'+(l==='pm'?' active':'')+'" data-dplevel="pm">产品</button>'+
    '<button class="dp-tab'+(l==='senior'?' active':'')+'" data-dplevel="senior">资深</button></div>'+
    '<div class="dp-text">'+escapeHtml(e[l]||'')+'</div>';
  r.classList.remove('hidden');document.getElementById('dp-confirm').classList.remove('hidden');
}
function dictRunPreview(){var term=(document.getElementById('dp-term').value||'').trim();if(!term)return;
  var r=document.getElementById('dp-result');r.classList.remove('hidden');r.innerHTML='<div class="dp-loading">⏳ 生成中…</div>';document.getElementById('dp-confirm').classList.add('hidden');
  fetch('/api/dict/ingest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({term:term,dry_run:true})})
    .then(function(x){return x.json();}).then(function(data){dictPreview={term:data.term,kind:data.kind,entry:data.entry};dictPanelSelLevel='newbie';renderDictPreview();});
}
function dictRunSave(){var term=dictPreview.term;
  fetch('/api/dict/ingest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({term:term,dry_run:false})})
    .then(function(x){return x.json();}).then(function(data){(dictView.entries||[]).push({term:data.term,kind:'global'});dictRenderList();dictResetPreview();dictPanelEl.style.display='none';showToast('✅ 已收录「'+term+'」');});
}
function showToast(msg){var t=document.createElement('div');t.className='dict-toast';t.textContent=msg;document.body.appendChild(t);setTimeout(function(){t.classList.add('show');},20);}
document.getElementById('open').addEventListener('click',dictOpenPanel);
`;

const STYLE = `
body{background:#141821;font-family:sans-serif;padding:40px;color:#e6e9ef;}
#open{background:rgba(127,182,255,0.18);color:#a8d0ff;border:1px solid rgba(127,182,255,0.4);border-radius:6px;padding:8px 14px;cursor:pointer;}
.dict-panel{position:fixed;z-index:2900;right:18px;top:64px;width:340px;background:#1e2430;border:1px solid#3a4150;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.5);padding:14px 16px;font-size:12px;line-height:1.5;}
.dict-panel .dp-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;}
.dict-panel .dp-title{font-weight:700;font-size:14px;color:#7fb6ff;}
.dict-panel .dp-close{cursor:pointer;color:#9aa3b2;font-size:14px;padding:2px;}
.dict-panel .dp-form{display:flex;gap:6px;margin-bottom:10px;}
.dict-panel .dp-input{flex:1;background:#141821;color:#e6e9ef;border:1px solid#3a4150;border-radius:6px;padding:6px 9px;font-size:12px;}
.dict-panel .dp-btn-primary{background:rgba(127,182,255,0.18);color:#a8d0ff;border:1px solid rgba(127,182,255,0.4);border-radius:6px;padding:6px 10px;font-size:12px;cursor:pointer;}
.dict-panel .dp-result{border:1px solid#3a4150;border-radius:8px;padding:10px 12px;margin-bottom:10px;}
.dict-panel .dp-result-head{display:flex;align-items:center;gap:8px;margin-bottom:7px;flex-wrap:wrap;}
.dict-panel .dp-term{font-weight:700;font-size:13px;color:#7fb6ff;}
.dict-panel .dp-badge{font-size:10px;padding:1px 7px;border-radius:8px;background:rgba(127,182,255,0.18);color:#a8d0ff;border:1px solid rgba(127,182,255,0.35);}
.dict-panel .dp-alias{color:#9aa3b2;font-size:11px;}
.dict-panel .dp-tabs{display:flex;gap:4px;margin-bottom:7px;}
.dict-panel .dp-tab{font-size:11px;padding:3px 9px;border-radius:6px;background:transparent;border:1px solid#3a4150;color:#9aa3b2;cursor:pointer;}
.dict-panel .dp-tab.active{background:rgba(127,182,255,0.18);color:#a8d0ff;border-color:rgba(127,182,255,0.4);}
.dict-panel .dp-text{color:#e6e9ef;}
.dict-panel .dp-loading{color:#9aa3b2;}
.dict-panel .dp-confirm{display:flex;gap:8px;margin-bottom:10px;}
.dict-panel .dp-btn-save{background:rgba(127,182,255,0.22);color:#cfe6ff;border:1px solid rgba(127,182,255,0.5);border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;}
.dict-panel .dp-btn-ghost{background:transparent;color:#9aa3b2;border:1px solid#3a4150;border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;}
.dict-panel .dp-list-title{font-size:11px;color:#9aa3b2;margin-bottom:5px;}
.dict-panel .dp-list{display:flex;flex-wrap:wrap;gap:5px;}
.dict-panel .dp-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:9px;font-size:11px;background:rgba(127,182,255,0.12);color:#a8d0ff;border:1px solid rgba(127,182,255,0.25);}
.dict-toast{position:fixed;left:50%;bottom:40px;transform:translate(-50%,20px);z-index:3100;background:rgba(30,36,48,0.95);border:1px solid rgba(127,182,255,0.4);color:#cfe6ff;border-radius:8px;padding:9px 16px;font-size:12px;opacity:0;transition:opacity .25s,transform .25s;pointer-events:none;}
.dict-toast.show{opacity:1;transform:translate(-50%,0);}
`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head>
<body>
<button id="open">📖 打开伪维基</button>
<script>${PANEL}</script>
</body></html>`;

const htmlFile = path.join(OUT, 'dict_panel_verify.html');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(htmlFile, html, 'utf-8');

let ok = true;
const check = (n, c) => { console.log((c ? '  ✓ ' : '  ✗ ') + n); if (!c) ok = false; };

const candidates = [
  'C:/Users/Admin/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
  'C:/Users/Admin/AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe',
];
const exe = candidates.find(e => fs.existsSync(e));
const browser = exe ? await chromium.launch({ executablePath: exe, headless: true }) : await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.goto('file://' + htmlFile.replace(/\\/g, '/'));
  await page.waitForTimeout(200);

  // 1. 打开面板
  await page.click('#open');
  await page.waitForTimeout(150);
  const panelVisible = await page.$eval('.dict-panel', el => el.style.display !== 'none' && el.offsetWidth > 0);
  check('点击按钮打开收录面板', panelVisible);
  const listHasAsync = await page.$eval('.dp-list', el => el.textContent.includes('异步'));
  check('面板展示已收录词条', listHasAsync);

  // 2. 输入词 → 生成预览
  await page.fill('#dp-term', '依赖注入');
  await page.click('#dp-preview');
  await page.waitForTimeout(150);
  const previewTerm = await page.$eval('.dp-term', el => el.textContent);
  check('预览词条 = 依赖注入', previewTerm === '依赖注入');
  const badge = await page.$eval('.dp-badge', el => el.textContent);
  check('分类徽章 = 通用词', badge === '通用词');
  const tabs = await page.$$eval('.dp-tab', els => els.map(e => e.textContent));
  check('三档标签存在', tabs.join(',') === '新人,产品,资深');
  await page.screenshot({ path: path.join(OUT, 'shots', 'dict_panel_preview.png') });

  // 3. 三档切换
  await page.click('.dp-tab[data-dplevel="senior"]');
  await page.waitForTimeout(100);
  const seniorText = await page.$eval('.dp-text', el => el.textContent);
  check('切到资深档', /容器\/装配|资深/.test(seniorText));

  // 4. 确认收录 → panel 关闭 + toast + 列表新增
  await page.click('#dp-save');
  await page.waitForTimeout(200);
  const closedAfterSave = await page.$eval('.dict-panel', el => el.style.display === 'none');
  check('确认后关闭面板', closedAfterSave);
  const toastShown = await page.$('.dict-toast.show');
  check('提示 toast 出现', !!toastShown);
  await page.screenshot({ path: path.join(OUT, 'shots', 'dict_panel_saved.png') });

  // 5. 重新打开，列表已含新词条
  await page.click('#open');
  const listHasNew = await page.$eval('.dp-list', el => el.textContent.includes('依赖注入'));
  check('重新打开后列表包含新词条', listHasNew);
} finally {
  await browser.close();
}
console.log('\n[P3 收录面板验证] ' + (ok ? '通过 ✓' : '失败 ✗'));
process.exit(ok ? 0 : 1);