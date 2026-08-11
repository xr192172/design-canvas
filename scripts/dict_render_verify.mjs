// 伪维基词典 P2 浏览器交互验证：高亮 → 点击高亮词 → 弹出词卡 → 三档切换 → 互链跳转
// 用法：npm run build && node scripts/dict_render_verify.mjs
// 产物：output/shots/dict_card_closed.png / dict_card_open.png
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'output');

// 与 src/renderer/scripts.ts 中实现一致的脱敏副本，用于在真实浏览器里验证交互闭环
const ENGINE = `
function escapeHtml(s){return String(s==null?'':s).replace(/[&<>"\']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function escapeAttr(s){return escapeHtml(s);}
var dictView = {
  entries: [
    {term:'异步',kind:'global',newbie:'异步就是不等一件事做完就继续干别的，做完再回来处理结果。',
     pm:'异步让程序在等待慢操作时不白白占用资源，提升响应体验。',
     senior:'异步通过 async/await 与 Promise 处理非阻塞 I/O，避免占用主线程。'},
    {term:'Promise',kind:'global',newbie:'Promise 就像一个"将来会给结果"的承诺，到时再兑现。',
     pm:'Promise 规范了异步结果的表达方式，让协作代码更可预期。',
     senior:'Promise 是异步操作的统一容器，支持 then/catch/race 组合。'},
    {term:'缓存',kind:'global',newbie:'缓存就是把常用的东西先存起来，下次直接用，不用重新算。',
     pm:'缓存能显著降低重复计算与网络开销，提升整体性能。',
     senior:'缓存通过内存/磁盘介质暂存高频结果，需权衡一致性策略。'}
  ],
  links: { '异步':['Promise'], 'Promise':['异步'] }
};
function dictHighlightHtml(text){
  if(!text||!dictView||!dictView.entries||dictView.entries.length===0)return escapeHtml(text);
  var lower=text.toLowerCase(),spans=[];
  for(var i=0;i<dictView.entries.length;i++){var e=dictView.entries[i];
    var cands=[e.term].concat(e.aliases||[]).filter(function(t){return t&&t.length>0;});
    for(var j=0;j<cands.length;j++){var c=cands[j].toLowerCase(),from=0,idx=lower.indexOf(c,from);
      while(idx!==-1){spans.push({start:idx,end:idx+c.length,term:e.term});from=idx+c.length;idx=lower.indexOf(c,from);}}}
  if(spans.length===0)return escapeHtml(text);
  spans.sort(function(a,b){return a.start-b.start||b.end-a.end;});var merged=[];
  for(var k=0;k<spans.length;k++){var s=spans[k],last=merged[merged.length-1];
    if(last&&s.start<last.end){if(s.end>last.end)last.end=s.end;}else merged.push(s);}
  var out='',cursor=0;
  for(var m=0;m<merged.length;m++){var sp=merged[m];
    if(sp.start>cursor)out+=escapeHtml(text.slice(cursor,sp.start));
    out+='<span class="dict-term" data-dict="'+escapeAttr(sp.term)+'">'+escapeHtml(text.slice(sp.start,sp.end))+'</span>';
    cursor=sp.end;}
  if(cursor<text.length)out+=escapeHtml(text.slice(cursor));
  return out;
}
var dictCardEl=null,dictCardState={term:null,level:'newbie'};
function dictEntryByTerm(term){for(var i=0;i<dictView.entries.length;i++){if(dictView.entries[i].term===term)return dictView.entries[i];}return null;}
function dictCardLinks(term){return (dictView&&dictView.links&&dictView.links[term])||[];}
function splitHighlightsForHtml(text,srcTerm){
  if(!dictView||!dictView.entries||dictView.entries.length===0)return escapeHtml(text);
  var lower=text.toLowerCase(),spans=[];
  for(var i=0;i<dictView.entries.length;i++){var e=dictView.entries[i];
    var cands=[e.term].concat(e.aliases||[]).filter(function(t){return t&&t.length>0;});
    for(var j=0;j<cands.length;j++){var c=cands[j].toLowerCase(),from=0,idx=lower.indexOf(c,from);
      while(idx!==-1){spans.push({start:idx,end:idx+c.length,term:e.term});from=idx+c.length;idx=lower.indexOf(c,from);}}}
  if(spans.length===0)return escapeHtml(text);
  spans.sort(function(a,b){return a.start-b.start||b.end-a.end;});var merged=[];
  for(var k=0;k<spans.length;k++){var s=spans[k],last=merged[merged.length-1];
    if(last&&s.start<last.end){if(s.end>last.end)last.end=s.end;}else merged.push(s);}
  var out='',cursor=0;
  for(var m=0;m<merged.length;m++){var sp=merged[m];
    if(sp.start>cursor)out+=escapeHtml(text.slice(cursor,sp.start));
    var active=sp.term===srcTerm?' dict-link--active':'';
    out+='<span class="dict-link'+active+'" data-dict="'+escapeAttr(sp.term)+'">'+escapeHtml(text.slice(sp.start,sp.end))+'</span>';
    cursor=sp.end;}
  if(cursor<text.length)out+=escapeHtml(text.slice(cursor));
  return out;
}
function dictCardBody(entry,level,srcTerm){
  var text=entry[level]||'',html='<div class="dc-body">';
  if(!text){html+='<div style="color:#9aa3b2">该档暂无解释。</div>';}
  else{html+=splitHighlightsForHtml(text,srcTerm);}
  var links=dictCardLinks(entry.term);
  if(links.length>0){html+='<div class="dc-links"><div class="dc-links-title">🔗 相关词条</div>';
    html+=links.map(function(t){var active=t===srcTerm?' dict-link--active':'';return '<span class="dict-link'+active+'" data-dict="'+escapeAttr(t)+'">'+escapeHtml(t)+'</span>';}).join(' ');
    html+='</div>';}
  html+='</div>';return html;
}
function renderDictCard(term){
  var entry=dictEntryByTerm(term);if(!entry)return;
  dictCardState.term=term;var level=dictCardState.level;
  var kindLabel=entry.kind==='project'?'项目词':'通用词';
  var html='<div class="dc-head"><span class="dc-term">'+escapeHtml(entry.term)+'</span>'+
    '<span style="display:flex;align-items:center;gap:6px;"><span class="dc-badge">'+kindLabel+'</span>'+
    '<span class="dc-close" data-dictclose="1">✕</span></span></div>';
  html+='<div class="dc-tabs">'+
    '<button class="dc-tab'+(level==='newbie'?' active':'')+'" data-dictlevel="newbie">新人</button>'+
    '<button class="dc-tab'+(level==='pm'?' active':'')+'" data-dictlevel="pm">产品</button>'+
    '<button class="dc-tab'+(level==='senior'?' active':'')+'" data-dictlevel="senior">资深</button></div>';
  html+=dictCardBody(entry,level,null);
  dictCardEl.innerHTML=html;
}
function showDictCard(term,cx,cy){
  if(!dictEntryByTerm(term))return;
  if(!dictCardEl){dictCardEl=document.createElement('div');dictCardEl.className='dict-card';document.body.appendChild(dictCardEl);
    dictCardEl.addEventListener('click',function(ev){var t=ev.target;
      var lvl=t.getAttribute&&t.getAttribute('data-dictlevel');
      if(lvl){dictCardState.level=lvl;renderDictCard(dictCardState.term);ev.stopPropagation();return;}
      var jump=t.getAttribute&&t.getAttribute('data-dict');
      if(jump){renderDictCard(jump);ev.stopPropagation();return;}
      if(t.getAttribute&&t.getAttribute('data-dictclose')){dictCardEl.style.display='none';ev.stopPropagation();return;}
    });}
  dictCardState.level='newbie';dictCardState.term=term;renderDictCard(term);dictCardEl.style.display='block';
  var w=dictCardEl.offsetWidth||340,h=dictCardEl.offsetHeight||200,x=cx+14,y=cy+14;
  if(x+w>window.innerWidth)x=cx-w-14;if(y+h>window.innerHeight)y=cy-h-14;
  dictCardEl.style.left=x+'px';dictCardEl.style.top=y+'px';
}
document.addEventListener('click',function(ev){var t=ev.target;
  if(t&&t.getAttribute&&t.getAttribute('data-dict')&&t.className&&t.className.indexOf('dict-term')!==-1){
    showDictCard(t.getAttribute('data-dict'),ev.clientX,ev.clientY);ev.stopPropagation();return;}
  if(dictCardEl&&dictCardEl.style.display!=='none'&&!(dictCardEl.contains(t)))dictCardEl.style.display='none';
});
`;

const STYLE = `
.dict-term,.dict-link{color:#7fb6ff;cursor:pointer;border-bottom:1px dashed rgba(127,182,255,0.6);}
.dict-term:hover,.dict-link:hover{color:#a8d0ff;border-bottom-style:solid;}
.dict-card{position:fixed;z-index:3000;width:340px;background:#1e2430;border:1px solid#3a4150;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,0.45);padding:12px 14px;color:#e6e9ef;font-size:12px;line-height:1.5;}
.dict-card .dc-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;}
.dict-card .dc-term{font-weight:700;font-size:14px;color:#7fb6ff;}
.dict-card .dc-badge{font-size:10px;padding:1px 7px;border-radius:8px;background:rgba(127,182,255,0.18);color:#a8d0ff;border:1px solid rgba(127,182,255,0.35);}
.dict-card .dc-tabs{display:flex;gap:4px;margin-bottom:8px;}
.dict-card .dc-tab{font-size:11px;padding:3px 9px;border-radius:6px;background:transparent;border:1px solid#3a4150;color:#9aa3b2;cursor:pointer;}
.dict-card .dc-tab.active{background:rgba(127,182,255,0.18);color:#a8d0ff;border-color:rgba(127,182,255,0.4);}
.dict-card .dc-body{min-height:40px;max-height:220px;overflow-y:auto;}
.dict-card .dc-links{border-top:1px solid#3a4150;margin-top:8px;padding-top:6px;}
.dict-card .dc-links-title{font-size:10.5px;color:#9aa3b2;margin-bottom:3px;}
.dict-card .dc-close{cursor:pointer;color:#9aa3b2;font-size:14px;line-height:1;padding:2px;}
.dict-card .dc-close:hover{color:#ff8a80;}
body{background:#141821;font-family:sans-serif;padding:40px;color:#e6e9ef;}
#tooltip{width:420px;background:#1e2430;border:1px solid#3a4150;border-radius:8px;padding:12px;font-size:12px;line-height:1.5;}
.lc-detail div{color:#9aa3b2;}
`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head>
<body>
<div id="tooltip">
  <div class="lc-detail"><b>异步</b><div id="exp">${/* placeholder */''}</div></div>
</div>
<p style="color:#9aa3b2;font-size:12px;margin-top:20px;">模拟 tooltip：下面解释文字中的已收录词应被高亮（蓝字下划线），点击可弹出伪维基词卡。</p>
<script>${ENGINE}
document.getElementById('exp').innerHTML = dictHighlightHtml('异步通过 async/await 与 Promise 处理非阻塞 I/O，避免占用主线程。');
</script></body></html>`;

const htmlFile = path.join(OUT, 'dict_verify.html');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(htmlFile, html, 'utf-8');

let ok = true;
const check = (n, c) => { console.log((c ? '  ✓ ' : '  ✗ ') + n); if (!c) ok = false; };

// 优先复用本机已安装的完整 chromium（避免 headless shell 未下载）
const candidates = [
  'C:/Users/Admin/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
  'C:/Users/Admin/AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe',
];
const exe = candidates.find(e => fs.existsSync(e));
const browser = exe ? await chromium.launch({ executablePath: exe, headless: true }) : await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.goto('file://' + htmlFile.replace(/\\/g, '/'));
  await page.waitForTimeout(300);

  // 1. 高亮拆分：解释文字中的已收录词应包成 dict-term
  const terms = await page.$$eval('.dict-term', els => els.map(e => e.getAttribute('data-dict')));
  check('tooltip 解释中的高亮词存在', terms.length > 0);
  check('高亮命中 Promise', terms.includes('Promise'));

  // 2. 点击高亮词 → 弹出词卡
  await page.click('.dict-term[data-dict="Promise"]');
  await page.waitForTimeout(200);
  const cardVisible = await page.$eval('.dict-card', el => el.style.display !== 'none' && el.offsetWidth > 0);
  check('点击高亮词弹出词卡', cardVisible);
  const cardTerm = await page.$eval('.dict-card .dc-term', el => el.textContent);
  check('词卡标题 = Promise', cardTerm === 'Promise');
  const badge = await page.$eval('.dict-card .dc-badge', el => el.textContent);
  check('词卡徽章 = 通用词', badge === '通用词');
  const tabs = await page.$$eval('.dict-card .dc-tab', els => els.map(e => e.textContent));
  check('三档标签存在', tabs.join(',') === '新人,产品,资深');
  await page.screenshot({ path: path.join(OUT, 'shots', 'dict_card_open.png') });

  // 3. 三档切换：切到 senior 应显示技术解释
  await page.click('.dict-card .dc-tab[data-dictlevel="senior"]');
  await page.waitForTimeout(150);
  const seniorText = await page.$eval('.dict-card .dc-body', el => el.textContent);
  check('切到资深档显示技术解释', /async\/await|I\/O|Promise/.test(seniorText));

  // 4. 从 Promise 词卡跳回 异步（互链）
  await page.click('.dict-card .dc-tab[data-dictlevel="newbie"]');
  await page.waitForTimeout(100);
  const links = await page.$$eval('.dict-card .dc-links .dict-link', els => els.map(e => e.getAttribute('data-dict')));
  check('词卡互链包含 异步', links.includes('异步'));
  await page.click('.dict-card .dc-links .dict-link[data-dict="异步"]');
  await page.waitForTimeout(150);
  const jumpedTerm = await page.$eval('.dict-card .dc-term', el => el.textContent);
  check('点击互链词跳转到 异步', jumpedTerm === '异步');

  // 5. 关闭词卡
  await page.click('.dict-card .dc-close');
  await page.waitForTimeout(100);
  const closed = await page.$eval('.dict-card', el => el.style.display === 'none');
  check('点击 ✕ 关闭词卡', closed);

  await page.screenshot({ path: path.join(OUT, 'shots', 'dict_card_closed.png') });
} finally {
  await browser.close();
}
console.log('\n[P2 词典交互验证] ' + (ok ? '通过 ✓' : '失败 ✗'));
process.exit(ok ? 0 : 1);