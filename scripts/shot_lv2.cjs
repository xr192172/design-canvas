#!/usr/bin/env node
/** 截图：子模块档视图（层级收纳 lv=2） */
const pw = require('playwright');
(async () => {
  const b = await pw.chromium.launch({ channel: 'msedge', headless: true });
  const p = await b.newPage({ viewport: { width: 1720, height: 1000 } });
  await p.goto('http://127.0.0.1:3000/mindmap/design-canvas', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.click('.lv-btn[data-lv="2"]');
  await p.waitForTimeout(400);
  await p.screenshot({ path: 'output/mindmap_lv2.png' });
  const n = await p.evaluate(() => document.querySelectorAll('#nodes g.mnode').length);
  console.log('saved output/mindmap_lv2.png, nodes=' + n);
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
