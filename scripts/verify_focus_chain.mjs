/**
 * verify_focus_chain：xf_chain 聚焦验证——判定点高亮 + 非关键节点压缩
 * 用法：serve 运行中，node scripts/verify_focus_chain.mjs
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const shot = async (name) => page.screenshot({ path: `output/shots/${name}.png` });

try {
  await page.goto('http://localhost:3000/xf_trace.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  // 展开 detail 层
  const detBtn = page.locator('#layer-detail-toggle');
  if (await detBtn.count() > 0) await detBtn.click({ force: true });
  await page.waitForTimeout(500);

  // 选中链上第一个 detail 节点（宿主链入口）
  const entry = page.locator('.node[data-layer="detail"]').first();
  await entry.click({ force: true });
  await page.waitForTimeout(300);

  const toggle = page.locator('#dataflow-toggle');
  const toggleDisabled = await toggle.isDisabled().catch(() => true);
  if (toggleDisabled) {
    console.log('⚠ toggle 禁用');
  } else {
    await toggle.click();
    await page.waitForTimeout(500);

    const focusBtn = page.locator('#dataflow-focus');
    const focusVisible = await focusBtn.isVisible().catch(() => false);
    if (!focusVisible) {
      console.log('⚠ focus 不可见');
    } else {
      await focusBtn.click();
      await page.waitForTimeout(1500);
      await shot('f1_focus_chain');

      const ev = await page.evaluate(() => {
        const panel = document.getElementById('focus-panel');
        const focused = [...document.querySelectorAll('.node.trace-focus')].map((el) => el.getAttribute('data-label'));
        const dimmed = document.querySelectorAll('.node.trace-dim').length;
        return {
          panelTitle: panel ? panel.querySelector('.focus-panel-title').textContent.trim() : null,
          rows: panel ? [...panel.querySelectorAll('.focus-row')].map((r) => r.textContent.trim()) : [],
          focusedCount: focused.length,
          focused,
          dimmedCount: dimmed,
        };
      });
      console.log('xf_chain 聚焦 DOM 证据：\n' + JSON.stringify(ev, null, 2));
    }
  }
} finally {
  await browser.close();
}
