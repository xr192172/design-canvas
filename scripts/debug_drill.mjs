// 钻入动效调试探针：新鲜 Playwright 上下文（无 localStorage 残留），
// 采样 viewBox + __canvas__ 内部状态，定位"点击无相机变化"的根因。
// 用法：node scripts/debug_drill.mjs
import { chromium } from 'playwright';

const URL = 'http://localhost:8080/demo_algorithm.html';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('console', (m) => console.log('[console]', m.type(), m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(600);

const vb = () => page.evaluate(() => document.getElementById('canvas').getAttribute('viewBox'));
const probe = async (label) => {
  const d = await page.evaluate(() => {
    const c = window.__canvas__;
    return {
      viewBox: document.getElementById('canvas').getAttribute('viewBox'),
      badges: document.querySelectorAll('.layer-badge').length,
      detailVisible: Array.from(document.querySelectorAll('.node[data-layer="detail"]')).filter((el) => el.style.display !== 'none').length,
      canvas: c ? {
        scale: c.canvasState.scale,
        panX: c.canvasState.panX,
        panY: c.canvasState.panY,
        fitScale: c.canvasState.fitScale,
        maxScale: c.canvasState.maxScale,
        origViewBox: c.canvasState.origViewBox,
        hasUpdateViewBox: !!c.canvasState.updateViewBox,
        expanded: Array.from(c.state.expandedLayers),
        checkpoints: Object.keys(c.cameraAnim.checkpoints),
      } : null,
      lsKeys: Object.keys(localStorage),
    };
  });
  console.log(`\n[probe:${label}]`, JSON.stringify(d, null, 1));
  return d;
};

await probe('init');

// 点角标展开
await page.evaluate(() => {
  document.querySelector('.layer-badge.layer-detail[data-host="media_replacer"]')
    .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
});
const expandSamples = [];
for (let i = 0; i < 8; i++) {
  expandSamples.push(await vb());
  await page.waitForTimeout(100);
}
console.log('\n[expand samples]', JSON.stringify(expandSamples, null, 1));
await probe('after-expand');

// 再点收起
await page.evaluate(() => {
  document.querySelector('.layer-badge.layer-detail[data-host="media_replacer"]')
    .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
});
const collapseSamples = [];
for (let i = 0; i < 8; i++) {
  collapseSamples.push(await vb());
  await page.waitForTimeout(100);
}
console.log('\n[collapse samples]', JSON.stringify(collapseSamples, null, 1));
await probe('after-collapse');

await browser.close();
