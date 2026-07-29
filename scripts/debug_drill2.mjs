// 钻入目标相机诊断：直接从 __DSL__ 读宿主+深层孩子坐标，手算 cameraFitNodes 应有的包围盒
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto('http://localhost:8080/demo_algorithm.html', { waitUntil: 'load' });
await page.waitForTimeout(500);

const d = await page.evaluate(() => {
  const nodes = window.__DSL__.geometry.nodes;
  const host = nodes.find((n) => n.id === 'media_replacer');
  const kids = nodes.filter((n) => n.host === 'media_replacer' && (n.layer || 'main') !== 'main');
  const all = [host].concat(kids);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const rows = all.map((n) => {
    const x = n.x || 0, y = n.y || 0, w = n.width || 120, h = n.height || 60;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
    return { id: n.id, x: n.x, y: n.y, w: n.width, h: n.height };
  });
  const svg = document.getElementById('canvas');
  const rect = svg.getBoundingClientRect();
  const fw = maxX - minX + 120, fh = maxY - minY + 120;
  const fitScale = window.__canvas__.canvasState.fitScale;
  const sd = Math.min(rect.width / fw, rect.height / fh, 1.2);
  return {
    count: all.length,
    bbox: { minX, minY, maxX, maxY },
    fw, fh,
    svgRect: { w: rect.width, h: rect.height },
    fitScale,
    sd,
    targetScale: sd / fitScale,
    currentScale: window.__canvas__.canvasState.scale,
    rows,
  };
});
console.log(JSON.stringify(d, null, 1));
await browser.close();
