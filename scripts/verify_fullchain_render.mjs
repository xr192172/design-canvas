// ai_base 全链路渲染验证：容器祖先链展开 → 宿主定位 → error/detail 层展开 → DOM 断言
// 复用系统 Chrome（chromium 下载受网络限制时的降级路径）
import { chromium } from 'playwright';
import path from 'node:path';

const htmlPath = path.resolve('output/ai_base.html').replace(/\\/g, '/');
const HOST = 'file_agent-shell_internal_context_v2_decision_splitter_go';
// 宿主容器的祖先链（外→内），ai_base 巨图默认折叠全部目录容器
const ANCESTORS = [
  'dir_agent-shell',
  'dir_agent-shell_internal',
  'dir_agent-shell_internal_context',
  'dir_agent-shell_internal_context_v2',
];

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const failures = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures.push(name);
};

try {
  await page.goto(`file:///${htmlPath}`);
  await page.waitForSelector('svg', { timeout: 10000 });
  await page.waitForTimeout(800);

  // 逐级展开宿主所在容器链（外→内，折叠按钮挂在父容器节点上）
  // SVG 元素在巨图视口外 Playwright 无法滚动点击 → DOM 级事件分发
  for (const cid of ANCESTORS) {
    const ok = await page.evaluate((id) => {
      const btn = document.querySelector(`.collapse-btn[data-parent="${id}"]`);
      if (!btn) return false;
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    }, cid);
    check(`容器 ${cid} 已展开`, ok);
    await page.waitForTimeout(400);
  }

  // 搜索定位宿主节点
  await page.fill('#node-search', 'decision_splitter.go');
  await page.press('#node-search', 'Enter');
  await page.waitForTimeout(1200);
  // 视野适配：覆盖宿主（货架网格内）+ v2 容器下方的新节点条带
  await page.evaluate(() => {
    document.getElementById('canvas').setAttribute('viewBox', '2550 340 1900 1050');
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'output/fullchain_1_located.png' });
  console.log('[shot] fullchain_1_located.png 搜索定位');

  // 清除搜索置灰（Escape），恢复全量亮度；视野保持
  await page.press('#node-search', 'Escape');
  await page.waitForTimeout(300);

  // 宿主可见 + 角标（⚠3 error + ▸1 detail）
  const hostG = page.locator(`g.node[data-id="${HOST}"]`);
  check('宿主节点可见', (await hostG.count()) === 1 && (await hostG.isVisible()));
  const errBadge = page.locator(`.layer-badge.layer-error[data-host="${HOST}"]`);
  const detBadge = page.locator(`.layer-badge.layer-detail[data-host="${HOST}"]`);
  check('error 角标存在', (await errBadge.count()) === 1, await errBadge.textContent().catch(() => ''));
  check('detail 角标存在', (await detBadge.count()) === 1, await detBadge.textContent().catch(() => ''));

  // 展开 error 层（同样视口外 → DOM 分发）
  if (await errBadge.count()) {
    await page.evaluate((id) => {
      document.querySelector(`.layer-badge.layer-error[data-host="${id}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }, HOST);
    await page.waitForTimeout(600);
  }
  await page.screenshot({ path: 'output/fullchain_2_error.png' });
  console.log('[shot] fullchain_2_error.png error 层展开');

  // 展开 detail 层
  if (await detBadge.count()) {
    await page.evaluate((id) => {
      document.querySelector(`.layer-badge.layer-detail[data-host="${id}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }, HOST);
    await page.waitForTimeout(600);
  }
  await page.screenshot({ path: 'output/fullchain_3_detail.png' });
  console.log('[shot] fullchain_3_detail.png detail 层展开');

  // ── DOM 断言 ──
  for (const id of ['node_err_cfg', 'node_err_llm', 'node_err_parse']) {
    const g = page.locator(`g.node[data-id="${id}"]`);
    check(`error 节点 ${id} 展开后可见`, (await g.count()) === 1 && (await g.isVisible()));
  }
  const splitG = page.locator(`g.node[data-id="${HOST}__s1_Split"]`);
  check('detail 节点 __s1_Split 展开后可见', (await splitG.count()) === 1 && (await splitG.isVisible()));

  // 形状卡人话文本
  const cardText = await splitG.locator('.shape-card').allTextContents();
  check('形状卡含人话 label', cardText.some((t) => t.includes('决策标签列表')), JSON.stringify(cardText).slice(0, 120));

  // 下游 main 节点始终可见
  for (const id of ['node_skip_graph', 'node_graph_nodes']) {
    const g = page.locator(`g.node[data-id="${id}"]`);
    check(`main 节点 ${id} 可见`, (await g.count()) === 1 && (await g.isVisible()));
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} 项失败:`, failures.join(' / '));
  process.exit(1);
}
console.log('\n全部断言通过');
