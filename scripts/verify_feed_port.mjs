// D3 进料口面板浏览器验证：conveyor 示例 → 属性编辑器入口 → 面板 → 预设 → 回放报告
// 用法：npm run build && node scripts/verify_feed_port.mjs
// 纯 file:// 渲染验证（面板逻辑全部在浏览器端，不依赖 serve）；不改活态 design-canvas.json
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { renderHTML } from '../dist/src/renderer/html_renderer.js';

// 1. 渲染 conveyor 示例为自包含 HTML
const conveyor = JSON.parse(fs.readFileSync('examples/conveyor.json', 'utf-8'));
const htmlPath = path.resolve('output/conveyor_feedport.html');
fs.writeFileSync(htmlPath, renderHTML(conveyor), 'utf-8');
console.log('[render] output/conveyor_feedport.html');

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const failures = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures.push(name);
};

const HOST = 'node_context_compose'; // flow_budget_check 的 from + handler.file_id

try {
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.goto(`file:///${htmlPath.replace(/\\/g, '/')}`);
  await page.waitForSelector('svg', { timeout: 10000 });
  await page.waitForTimeout(800);
  check('页面加载无 JS 异常', consoleErrors.length === 0, consoleErrors[0] ?? '');

  // 2. 双击宿主节点 → 属性编辑器（SVG 节点直接分发 dblclick 事件）
  await page.evaluate((id) => {
    document.querySelector(`g.node[data-id="${id}"]`)
      ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  }, HOST);
  await page.waitForTimeout(300);

  const editorVisible = await page.evaluate(() =>
    !document.getElementById('prop-editor')?.classList.contains('hidden') ||
    !document.querySelector('.prop-editor:not(.replay-panel)')?.classList.contains('hidden'));
  check('属性编辑器已打开', editorVisible);

  // 3. 进料口入口行可见 + flow 计数正确（node_context_compose: flow_budget_check from=它 → 1 条）
  const rowVisible = await page.evaluate(() =>
    !document.getElementById('editor-replay-row')?.classList.contains('hidden'));
  check('进料口入口行可见', rowVisible);
  const cnt = await page.evaluate(() => document.getElementById('editor-replay-count')?.textContent);
  check('flow 计数 = 1', cnt === '1', `实际 ${cnt}`);

  // 4. 无 flow 节点（node_l0_arch）不显示入口
  await page.evaluate(() => {
    document.querySelector('g.node[data-id="node_l0_arch"]')
      ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const rowHidden = await page.evaluate(() =>
    document.getElementById('editor-replay-row')?.classList.contains('hidden'));
  check('无 flow 节点入口行隐藏', rowHidden === true);

  // 5. 回到宿主节点，打开进料口面板
  await page.evaluate((id) => {
    document.querySelector(`g.node[data-id="${id}"]`)
      ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  }, HOST);
  await page.waitForTimeout(300);
  await page.click('#editor-replay-open');
  await page.waitForTimeout(300);
  const panelVisible = await page.evaluate(() =>
    !document.getElementById('replay-panel')?.classList.contains('hidden'));
  check('进料口面板已打开', panelVisible);
  const editorClosed = await page.evaluate(() => {
    const eds = [...document.querySelectorAll('.prop-editor:not(.replay-panel)')];
    return eds.every((e) => e.classList.contains('hidden'));
  });
  check('属性编辑器已让位关闭', editorClosed);

  // 6. flow 下拉含 flow_budget_check；预设下拉含 2 条 errors
  const flowOpts = await page.evaluate(() =>
    [...document.querySelectorAll('#replay-flow option')].map((o) => o.value));
  check('flow 下拉含 flow_budget_check', flowOpts.includes('flow_budget_check'), JSON.stringify(flowOpts));
  const presetOpts = await page.evaluate(() =>
    [...document.querySelectorAll('#replay-preset option')].map((o) => o.value));
  check('预设含 ErrBudgetExceeded + panic',
    presetOpts.includes('ErrBudgetExceeded') && presetOpts.includes('panic'), JSON.stringify(presetOpts));

  // 7. 选预设 ErrBudgetExceeded → 注入值自动构造且命中 condition
  await page.selectOption('#replay-preset', 'ErrBudgetExceeded');
  await page.waitForTimeout(200);
  const injectVal = await page.evaluate(() => document.getElementById('replay-inject').value);
  let injectObj = null;
  try { injectObj = JSON.parse(injectVal); } catch { /* ignore */ }
  check('预设自动构造注入值', injectObj?.error?.code === 'BUDGET_EXCEEDED', injectVal.replace(/\s+/g, ' ').slice(0, 80));

  // 8. 回放 → 报告：已声明异常命中 + 视觉回放已执行 + 结论正常
  await page.click('#replay-run');
  await page.waitForTimeout(400);
  const report1 = await page.evaluate(() => document.getElementById('replay-report')?.innerText ?? '');
  check('报告可见', await page.evaluate(() => !document.getElementById('replay-report')?.classList.contains('hidden')));
  check('报告：已声明异常命中 ErrBudgetExceeded', report1.includes('已声明异常命中：ErrBudgetExceeded'), report1.split('\n').slice(0, 4).join(' | '));
  check('报告：视觉回放已执行', report1.includes('视觉回放已执行'));

  // 9. 手动改注入为正常值 + 预算内 value → else 分支（预算内正常组装 → node_current_round）
  await page.evaluate(() => {
    document.getElementById('replay-preset').value = '';
    document.getElementById('replay-inject').value = JSON.stringify({ compose: 'ok', tokens: 1200 });
    document.getElementById('replay-value').value = JSON.stringify({ sections: [{ tokens: 5000 }], tokenBudget: 128000 });
  });
  await page.click('#replay-run');
  await page.waitForTimeout(400);
  const report2 = await page.evaluate(() => document.getElementById('replay-report')?.innerText ?? '');
  check('报告：命中 else 分支 → node_current_round',
    report2.includes('命中分支 #2') && report2.includes('node_current_round'), report2.split('\n').slice(0, 4).join(' | '));
  check('报告：结论无问题', report2.includes('结论：回放正常'));

  // 10. 超 80% 预算 → 分支 #1（PulseEvict → node_section_queue）
  await page.evaluate(() => {
    document.getElementById('replay-value').value = JSON.stringify({ sections: [{ tokens: 110000 }], tokenBudget: 128000 });
  });
  await page.click('#replay-run');
  await page.waitForTimeout(400);
  const report3 = await page.evaluate(() => document.getElementById('replay-report')?.innerText ?? '');
  check('报告：命中分支 #1 → node_section_queue',
    report3.includes('命中分支 #1') && report3.includes('node_section_queue'), report3.split('\n').slice(0, 4).join(' | '));

  // 11. 未声明异常 → bug 警报
  await page.evaluate(() => {
    document.getElementById('replay-inject').value = JSON.stringify({ error: { code: 'NETWORK_TIMEOUT', message: '检索超时' } });
    document.getElementById('replay-value').value = '';
  });
  await page.click('#replay-run');
  await page.waitForTimeout(400);
  const report4 = await page.evaluate(() => document.getElementById('replay-report')?.innerText ?? '');
  check('报告：未声明异常警报', report4.includes('未声明异常') && report4.includes('疑似 bug'), report4.split('\n').slice(0, 5).join(' | '));
  check('报告：结论暴露问题', report4.includes('结论：暴露'));

  await page.screenshot({ path: 'output/feedport_panel.png' });
  console.log('[shot] feedport_panel.png 进料口面板+报告');

  // 12. Escape 关闭面板
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const panelClosed = await page.evaluate(() =>
    document.getElementById('replay-panel')?.classList.contains('hidden'));
  check('Escape 关闭面板', panelClosed === true);

  check('全程无 JS 异常', consoleErrors.length === 0, consoleErrors.join(' ; ').slice(0, 200));
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} 项失败:`, failures.join(' / '));
  process.exit(1);
}
console.log('\n全部断言通过');
