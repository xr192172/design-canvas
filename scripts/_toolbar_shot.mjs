// 工具栏人话化验证：主栏 + ⋯展开 两图
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: 'C:/Users/Admin/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 150)));

await page.goto('http://127.0.0.1:3000/self_analyze.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await page.click('#report-close');
await page.waitForTimeout(400);

// 只截工具栏区域
const bar = await page.locator('.canvas-toolbar').boundingBox();
await page.screenshot({ path: 'output/shots/t1_toolbar.png', clip: bar });

await page.click('#advanced-toggle');
await page.waitForTimeout(300);
const bar2 = await page.locator('.canvas-toolbar').boundingBox();
await page.screenshot({ path: 'output/shots/t2_toolbar_expanded.png', clip: bar2 });

await browser.close();
console.log('done');
