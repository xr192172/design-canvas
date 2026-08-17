#!/usr/bin/env node
/** E2E：验证外部项目 wet-mcp 的 teach 导图渲染（专属描述/中文化/层级/社区名） */
const pw = require('playwright');

(async () => {
  const base = 'http://127.0.0.1:3000';
  const FEATURE = 'wet-mcp';
  const b = await pw.chromium.launch({ channel: 'msedge', headless: true });
  const p = await b.newPage({ viewport: { width: 1720, height: 1000 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));

  await p.goto(base + '/mindmap/' + FEATURE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);

  const kinds = await p.evaluate(() => {
    const ids = [...document.querySelectorAll('#nodes g.mnode')].map((n) => n.getAttribute('data-id') || '');
    return {
      feature: ids.filter((i) => /^f\d+$/.test(i)).length,
      community: ids.filter((i) => /:c\d+$/.test(i)).length,
      file: ids.filter((i) => i.startsWith('file_')).length,
    };
  });
  console.log('① 结构：', JSON.stringify(kinds));

  // 点开第一个社区看专属描述
  const panel = await p.evaluate(() => {
    const comm = [...document.querySelectorAll('#nodes g.mnode')].find((n) => /:c\d+$/.test(n.getAttribute('data-id') || ''));
    if (!comm) return '(无社区)';
    comm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return document.getElementById('detail').textContent.replace(/\s+/g, ' ').slice(0, 150);
  });
  console.log('② 社区面板:', panel);

  // 社区名中文化
  const zh = await p.evaluate(() => {
    const comm = [...document.querySelectorAll('#nodes g.mnode')].filter((n) => /:c\d+$/.test(n.getAttribute('data-id') || ''));
    return comm.filter((c) => /[\u4e00-\u9fff]/.test(c.textContent || '')).length;
  });
  console.log('③ 社区名中文化:', zh + '/' + (kinds.community));

  // 层级三档
  const lv = {};
  for (const [name, sel] of [['功能', '.lv-btn[data-lv="1"]'], ['子模块', '.lv-btn[data-lv="2"]'], ['全部', '.lv-btn[data-lv="3"]']]) {
    await p.click(sel);
    await p.waitForTimeout(150);
    const n = await p.evaluate(() => document.querySelectorAll('#nodes g.mnode').length);
    lv[name] = n;
  }
  console.log('④ 层级收纳 节点数:', JSON.stringify(lv));

  // 截图（子模块档）
  await p.click('.lv-btn[data-lv="2"]');
  await p.waitForTimeout(300);
  await p.screenshot({ path: 'output/import_wetmcp_lv2.png' });
  console.log('  截图已存: output/import_wetmcp_lv2.png');

  await b.close();
  console.log('JS错误:', errs.length ? errs : '无');
})().catch((e) => { console.error(e.message); process.exit(1); });