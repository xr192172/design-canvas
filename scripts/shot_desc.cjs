#!/usr/bin/env node
/** 截图：社区节点详情面板（专属描述效果）+ 文件节点面板 */
const pw = require('playwright');

(async () => {
  const base = 'http://127.0.0.1:3000';
  const b = await pw.chromium.launch({ channel: 'msedge', headless: true });
  const p = await b.newPage({ viewport: { width: 1720, height: 1000 } });
  await p.goto(base + '/mindmap/design-canvas', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);

  // 展开到全部层级，点开第一个社区节点看面板
  await p.click('.lv-btn[data-lv="3"]');
  await p.waitForTimeout(300);
  const comm = await p.$('#nodes g.mnode[data-id$=":c0"]');
  if (comm) {
    await comm.click();
    await p.waitForTimeout(400);
    await p.screenshot({ path: 'output/desc_community.png' });
    console.log('✓ 社区面板截图 -> output/desc_community.png');
  }
  // 点一个文件节点
  const file = await p.$('#nodes g.mnode[data-id^="file_"]');
  if (file) {
    await file.click();
    await p.waitForTimeout(400);
    await p.screenshot({ path: 'output/desc_file.png' });
    console.log('✓ 文件面板截图 -> output/desc_file.png');
  }
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
