// Hub 导航闭环验证：主页 ⇄ 星图 ⇄ 拆分建议页 + 紧凑工具栏 + hash 直达
import { chromium } from 'playwright';
import fs from 'node:fs';

fs.mkdirSync('output/shots', { recursive: true });
const browser = await chromium.launch({
  executablePath: 'C:/Users/Admin/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 150)));
const base = 'http://127.0.0.1:8081';

// 1. Hub 主页
await page.goto(`${base}/index.html?v=6`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.screenshot({ path: 'output/shots/h1_hub.png' });

// 2. 点星图卡 → self_analyze.html（应有导读面板 + 🏠主页 + 紧凑工具栏）
await page.click('a.big-card[href="./self_analyze.html"]');
await page.waitForTimeout(1200);
const starInfo = await page.evaluate(() => ({
  hasHome: !!document.querySelector('.home-link'),
  homeHref: document.querySelector('.home-link')?.getAttribute('href'),
  hasOverlay: !document.getElementById('report-overlay')?.classList.contains('hidden'),
  hasAdvToggle: !!document.getElementById('advanced-toggle'),
  advHidden: document.getElementById('toolbar-advanced')?.classList.contains('hidden'),
  undoVisible: !!document.getElementById('btn-undo')?.offsetParent,
  layoutVisible: !!document.getElementById('layout-dag')?.offsetParent,
}));
console.log('星图页:', JSON.stringify(starInfo));
await page.screenshot({ path: 'output/shots/h2_star_panel.png' });

// 先关导读面板（否则遮罩拦截工具栏点击）
await page.click('#report-close');
await page.waitForTimeout(400);

// 3. 点 ⋯ 展开编辑类按钮
await page.click('#advanced-toggle');
await page.waitForTimeout(300);
const advInfo = await page.evaluate(() => ({
  undoVisible: !!document.getElementById('btn-undo')?.offsetParent,
  layoutVisible: !!document.getElementById('layout-dag')?.offsetParent,
}));
console.log('⋯展开后:', JSON.stringify(advInfo));
await page.screenshot({ path: 'output/shots/h3_toolbar_adv.png' });
await page.click('#advanced-toggle'); // 收回

// 4. 点 🏠主页 → 回 index.html
await page.click('.home-link');
await page.waitForTimeout(800);
console.log('回主页 URL:', page.url());
await page.screenshot({ path: 'output/shots/h4_back_hub.png' });

// 5. 点拆分建议卡 → monolith_report.html
await page.click('a.big-card[href="./monolith_report.html"]');
await page.waitForTimeout(800);
const mInfo = await page.evaluate(() => ({
  cards: document.querySelectorAll('.mcard').length,
  firstPath: document.querySelector('.mpath')?.textContent,
  flyLinks: document.querySelectorAll('.mfly').length,
}));
console.log('拆分建议页:', JSON.stringify(mInfo));
await page.screenshot({ path: 'output/shots/h5_monolith.png', fullPage: false });

// 6. 点第一张卡的"在星图中定位" → self_analyze.html#fly=...（应跳过面板直飞节点）
await page.click('.mcard .mfly');
// 大 SVG 首帧渲染会阻塞主线程，fly 的 setTimeout 回调执行时机不固定；
// 确定性等待：hash 代码已跑（overlay 隐藏）且飞行动画完成（raf=0 且已放大）
await page.waitForFunction(() => {
  const c = window.__canvas__;
  const overlayHidden = document.getElementById('report-overlay')?.classList.contains('hidden');
  return overlayHidden && c && c.cameraAnim.raf === 0 && c.canvasState.scale > 2;
}, { timeout: 20000 });
await page.waitForTimeout(300);
const flyInfo = await page.evaluate(() => ({
  url: location.href,
  overlayHidden: document.getElementById('report-overlay')?.classList.contains('hidden'),
  viewBox: document.getElementById('canvas')?.getAttribute('viewBox'),
}));
console.log('hash 直达:', JSON.stringify(flyInfo));
await page.screenshot({ path: 'output/shots/h6_fly.png' });

await browser.close();
console.log('done');
