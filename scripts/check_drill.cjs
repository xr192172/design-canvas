#!/usr/bin/env node
/** E2E：① 功能下钻关键文件 ② 根节点写构想 → 保存 → AI 自动定位成 🔮 分支（全流程） */
const pw = require('playwright');

(async () => {
  const FEATURE = 'design-canvas';
  const base = 'http://127.0.0.1:3000';
  const b = await pw.chromium.launch({ channel: 'msedge', headless: true });
  const p = await b.newPage({ viewport: { width: 1720, height: 1000 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));

  await p.goto(base + '/mindmap/' + FEATURE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);

  // 备份现有 user_nodes，测完还原
  const backup = await p.evaluate(async () => {
    const r = await fetch('/api/user_nodes?feature=design-canvas').then((x) => x.json());
    return r.user_nodes || [];
  });

  // ① 下钻：功能节点应有关键文件子节点（📄 渲染 + 点击面板）——默认全展开，无需点 fold
  const drill = await p.evaluate(() => {
    const feats = [...document.querySelectorAll('#nodes g.mnode')].filter((n) => n.getAttribute('data-id').match(/^f\d+$/));
    return feats.map((f) => f.getAttribute('data-id'));
  });
  await p.waitForTimeout(400);
  const files = await p.evaluate(() => {
    const fs = [...document.querySelectorAll('#nodes g.mnode')].filter((n) => {
      const id = n.getAttribute('data-id');
      return id && id.startsWith('file_');
    });
    const first = fs[0];
    if (first) first.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return { count: fs.length, detail: first ? document.getElementById('detail').textContent.replace(/\s+/g, ' ').slice(0, 140) : '' };
  });
  console.log('① 下钻：功能节点数=' + drill.length, '关键文件节点=' + files.count);
  console.log('   首个文件面板:', files.detail);

  // ② 加新功能全流程：根节点 → 工具栏 ＋ 新增分支 → 输入 → 保存 → AI 定位
  await p.evaluate(() => { window.getSelection && document.getElementById('root') ; });
  await p.evaluate(() => {
    const root = document.querySelector('.mnode[data-id="root"]');
    root.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await p.click('#btn-add-branch');
  await p.fill('#inline-text', '给导图加一个导出 PDF 分享功能');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(300);
  const userBefore = await p.evaluate(() => [...document.querySelectorAll('#nodes g.mnode')].filter((n) => (n.getAttribute('data-id') || '').startsWith('u_')).length);
  console.log('② 新增构想输入后：user 节点=' + userBefore + '（应 ≥1，待保存定位）');

  await p.click('#btn-save');
  // 等待 AI 定位完成（最长 100s）
  let placed = false, proposalInfo = '';
  for (let i = 0; i < 50; i++) {
    await p.waitForTimeout(2000);
    const st = await p.evaluate(() => {
      const btn = document.getElementById('btn-save');
      const prop = [...document.querySelectorAll('#nodes g.mnode')].filter((n) => (n.getAttribute('data-id') || '').startsWith('pp:'));
      const label = document.getElementById('save-state').textContent;
      return { busy: btn.disabled, propCount: prop.length, label };
    });
    if (st.propCount > 0 && !st.busy) {
      placed = true;
      // 点构想节点看面板
      proposalInfo = await p.evaluate(() => {
        const el = [...document.querySelectorAll('#nodes g.mnode')].find((n) => (n.getAttribute('data-id') || '').startsWith('pp:'));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return document.getElementById('detail').textContent.replace(/\s+/g, ' ').slice(0, 200);
      });
      console.log('   AI 定位完成(' + ((i + 1) * 2) + 's)：状态=' + st.label);
      break;
    }
    if (!st.busy && i > 2 && st.propCount === 0) { console.log('   失败：保存已结束但无构想分支。状态=' + st.label); break; }
  }
  console.log('③ 🔮 构想分支出现:', placed);
  console.log('   构想面板:', proposalInfo);
  const leftovers = await p.evaluate(() => [...document.querySelectorAll('#nodes g.mnode')].filter((n) => (n.getAttribute('data-id') || '').match(/^u_\d+$/)).length);
  console.log('④ 原始 user 节点隐藏（被结构化替代）:', leftovers === 0 ? '是' : '否(剩' + leftovers + ')');

  // 清理：还原 user_nodes 备份 + 重跑 placeProposals（清掉测试构想）
  await p.evaluate(async (nodes) => {
    await fetch('/api/user_nodes', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feature: 'design-canvas', nodes }) });
    await fetch('/api/proposals', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feature: 'design-canvas' }) });
  }, backup);
  console.log('JS错误:', errs.length ? errs.join(' | ') : '无');
  await b.close();
  process.exit(placed && files.count > 0 && errs.length === 0 ? 0 : 1);
})().catch((e) => { console.error('E2E 失败:', e.message); process.exit(1); });
