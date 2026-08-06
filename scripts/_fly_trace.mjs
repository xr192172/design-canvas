// 诊断 hash fly 被覆盖：复刻 _hub_shots 完整流程，跳转后时序采样相机状态
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: 'C:/Users/Admin/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('fly') || t.includes('相机') || t.includes('camera')) console.log('[console]', t.slice(0, 160));
});
const base = 'http://127.0.0.1:8081';

// 复刻验证脚本完整流程
await page.goto(`${base}/index.html?v=6`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.click('a.big-card[href="./self_analyze.html"]');
await page.waitForTimeout(1200);
await page.click('#report-close');
await page.waitForTimeout(400);
await page.click('.home-link');
await page.waitForTimeout(800);
await page.click('a.big-card[href="./monolith_report.html"]');
await page.waitForTimeout(800);

console.log('--- 点击 .mfly 跳转 ---');
const t0 = Date.now();
await page.click('.mcard .mfly');

// 时序采样：每 100ms 一次，持续 2.5s
for (let i = 0; i < 25; i++) {
  await page.waitForTimeout(100);
  const st = await page.evaluate(() => {
    const c = window.__canvas__;
    if (!c) return null;
    return {
      s: +c.canvasState.scale.toFixed(3),
      px: Math.round(c.canvasState.panX),
      py: Math.round(c.canvasState.panY),
      raf: c.cameraAnim.raf,
      vb: (document.getElementById('canvas')?.getAttribute('viewBox') || '').split(' ').map((v) => Math.round(+v)).join(' '),
    };
  });
  console.log(`t=${Date.now() - t0}ms`, JSON.stringify(st));
}

// 末尾手动调一次，确认 flyToNode 本身可用
const manual = await page.evaluate(() => {
  const c = window.__canvas__;
  c.flyToNode('file_renderer_scripts_ts');
  return { s: c.canvasState.scale, raf: c.cameraAnim.raf };
});
await page.waitForTimeout(800);
const after = await page.evaluate(() => {
  const c = window.__canvas__;
  return { s: +c.canvasState.scale.toFixed(3), px: Math.round(c.canvasState.panX), py: Math.round(c.canvasState.panY) };
});
console.log('手动 fly:', JSON.stringify(manual), '→', JSON.stringify(after));

await browser.close();
