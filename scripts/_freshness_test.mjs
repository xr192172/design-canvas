// 报告保鲜验证：过期横幅（Hub + 星图 + 拆分建议页）→ regenerate → 横幅消失
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: 'C:/Users/Admin/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 150)));
const base = 'http://127.0.0.1:3000';

// 1. Hub 主页（当前 src/storage.ts 被 touch 过，应显示过期横幅）
await page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const hub = await page.evaluate(() => ({
  hasStaleBar: !!document.querySelector('.stale-bar'),
  text: document.querySelector('.stale-bar span')?.textContent,
}));
console.log('Hub 主页:', JSON.stringify(hub));
await page.screenshot({ path: 'output/shots/f1_hub_stale.png' });

// 2. 星图页横幅
await page.goto(`${base}/self_analyze.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const star = await page.evaluate(() => !!document.querySelector('.stale-bar'));
console.log('星图页横幅:', star);

// 3. 拆分建议页横幅
await page.goto(`${base}/monolith_report.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const mono = await page.evaluate(() => !!document.querySelector('.stale-bar'));
console.log('拆分建议页横幅:', mono);
await page.screenshot({ path: 'output/shots/f2_monolith_stale.png' });

// 4. 点"重新生成"按钮 → 等页面自动刷新 → 横幅应消失
console.log('点击重新生成…');
await page.click('.stale-bar button');
await page.waitForFunction(() => !document.querySelector('.stale-bar'), { timeout: 60000 });
await page.waitForTimeout(800);
const after = await page.evaluate(() => ({
  staleBarGone: !document.querySelector('.stale-bar'),
  url: location.pathname,
}));
console.log('重新生成后:', JSON.stringify(after));
await page.screenshot({ path: 'output/shots/f3_after_regen.png' });

await browser.close();
console.log('done');
