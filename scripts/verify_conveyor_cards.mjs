// 阶段E验证：conveyor.html 卡片同步动画（card_sync 由 animations_v2 显式 flow 驱动）
// 旧动画播放器代码已删除，此脚本确认 V2 引擎独立工作
import fs from 'node:fs';
import { chromium } from 'playwright';

const htmlPath = 'file:///' + 'd:/project_develop/design-canvas/output/conveyor.html'.replace(/\\/g, '/');
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const failures = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures.push(name);
};

try {
  await page.goto(htmlPath);
  await page.waitForSelector('svg', { timeout: 15000 });
  await page.waitForTimeout(1000);

  // 1. V2 引擎已注入
  const v2 = await page.evaluate(() => !!window.__animV2__);
  check('__animV2__ 引擎已注入', v2);

  // 2. 旧动画播放器已删除（无 animState / initAnimationPlayer 全局）
  const oldGone = await page.evaluate(() => {
    return typeof window.animState === 'undefined' &&
      typeof window.initAnimationPlayer === 'undefined' &&
      !document.getElementById('anim-panel');
  });
  check('旧动画播放器代码已移除', oldGone);

  // 3. 定位节点容器
  const q = page.locator('g.node[data-id="node_section_queue"]');
  check('node_section_queue 节点存在', (await q.count()) === 1);

  // 4. 注入 sections 状态 → 触发 card_sync 全量同步
  await page.evaluate(() => {
    window.simState = window.simState || {};
    window.simState.sections = [
      { id: 'sec_intro', status: 'active', tokens: 5000 },
      { id: 'sec_body', status: 'active', tokens: 12000 },
      { id: 'sec_old', status: 'folded', tokens: 300 },
    ];
  });
  await page.waitForTimeout(1200); // 引擎 300ms 轮询 + 动画过渡

  let cards = await page.locator('g.card-v2').count();
  check('card_sync 创建 3 张卡片', cards === 3, `实际 ${cards}`);

  // 5. 折叠卡片具有 folded class（sec_old）
  const folded = await page.locator('g.card-v2.folded').count();
  check('folded 卡片存在', folded >= 1, `实际 ${folded}`);

  await page.screenshot({ path: 'output/conveyor_cards_v1.png' });
  console.log('[shot] conveyor_cards_v1.png 3 卡片');

  // 6. 状态变更 → 淘汰一张 + 新增一张（diff 对比）
  await page.evaluate(() => {
    window.simState.sections = [
      { id: 'sec_intro', status: 'active', tokens: 5200 },
      { id: 'sec_body', status: 'active', tokens: 13000 },
      { id: 'sec_new', status: 'active', tokens: 900 },
    ];
  });
  await page.waitForTimeout(1200);
  cards = await page.locator('g.card-v2').count();
  check('状态变更后仍 3 张（sec_old 淘汰, sec_new 新增）', cards === 3, `实际 ${cards}`);
  const newCard = await page.locator('g.card-v2[data-card-id="sec_new"]').count();
  check('新卡 sec_new 已创建', newCard === 1);

  await page.screenshot({ path: 'output/conveyor_cards_v2.png' });
  console.log('[shot] conveyor_cards_v2.png 淘汰+新增');
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} 项失败:`, failures.join(' / '));
  process.exit(1);
}
console.log('\n全部断言通过');