// 调试 hash fly 失效：dump 相机状态 + 手动调用
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: 'C:/Users/Admin/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

await page.goto('http://127.0.0.1:8081/self_analyze.html#fly=file_renderer_scripts_ts', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

const st = await page.evaluate(() => {
  const c = window.__canvas__;
  if (!c) return { err: 'no __canvas__' };
  return {
    scale: c.canvasState.scale,
    panX: c.canvasState.panX,
    panY: c.canvasState.panY,
    fitScale: c.canvasState.fitScale,
    maxScale: c.canvasState.maxScale,
    origVB: c.canvasState.origViewBox,
    animRaf: c.cameraAnim.raf,
  };
});
console.log('2s 后相机状态:', JSON.stringify(st));

// 手动再调一次 flyToNode，观察是否生效
const st2 = await page.evaluate(() => {
  const c = window.__canvas__;
  c.flyToNode('file_renderer_scripts_ts');
  return { scaleAfter: c.canvasState.scale, raf: c.cameraAnim.raf };
});
await page.waitForTimeout(800);
const st3 = await page.evaluate(() => {
  const c = window.__canvas__;
  return { scale: c.canvasState.scale, panX: c.canvasState.panX, panY: c.canvasState.panY, viewBox: document.getElementById('canvas').getAttribute('viewBox') };
});
console.log('手动调用后:', JSON.stringify(st2), '→', JSON.stringify(st3));

await browser.close();
