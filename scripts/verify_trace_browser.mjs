/**
 * verify_trace_browser：serve 模式浏览器验证——数据流真实执行
 * 用法：先起 serve（node dist/src/tools/serve.js 3000），再 node scripts/verify_trace_browser.mjs
 * 流程：打开 trace_demo.html → 展开 detail 链 → 选中节点 → 输入真实数据 → 开始推演 → 截图
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';
const SHOT_DIR = 'output/shots';
const shots = [];
const shot = async (page, name) => {
  const p = `${SHOT_DIR}/${name}.png`;
  await page.screenshot({ path: p });
  shots.push(p);
};

const browser = await chromium.launch({
  channel: 'chrome', // 用系统 Chrome，避免 playwright 自带浏览器缺失
});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

try {
  await page.goto(`${BASE}/trace_demo.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await shot(page, 't1_loaded');

  // 展开 detail 层（全局层开关），确保链可见
  const detBtn = page.locator('#layer-detail-toggle');
  if (await detBtn.count() > 0) {
    await detBtn.click({ force: true });
    await page.waitForTimeout(500);
  }
  await shot(page, 't2_expanded');

  // 选中第一个 detail 节点
  const d1 = page.locator('.node[data-id="host_node__s1_flattenScope"]');
  if (await d1.count() > 0) {
    await d1.click({ force: true });
    await page.waitForTimeout(400);
  }
  await shot(page, 't3_selected');

  // 打开数据流面板
  const toggle = page.locator('#dataflow-toggle');
  const disabled = await toggle.isDisabled().catch(() => true);
  if (!disabled) {
    await toggle.click();
    await page.waitForTimeout(500);
    await shot(page, 't4_panel');

    // 聚焦验证：点"聚焦关键节点"（无 LLM 配置 → 后端降级启发式）
    const focusBtn = page.locator('#dataflow-focus');
    if (await focusBtn.count() > 0 && await focusBtn.isVisible().catch(() => false)) {
      await focusBtn.click();
      await page.waitForTimeout(1200);
      await shot(page, 't5_focus');
      const focusEvidence = await page.evaluate(() => {
        const panel = document.getElementById('focus-panel');
        const focused = [...document.querySelectorAll('.node.trace-focus')].map((el) => el.getAttribute('data-label'));
        const dimmed = document.querySelectorAll('.node.trace-dim').length;
        return {
          panel: panel ? panel.textContent.trim().slice(0, 300) : null,
          focusedNodes: focused,
          dimmedCount: dimmed,
        };
      });
      console.log('聚焦 DOM 证据：\n' + JSON.stringify(focusEvidence, null, 2));
      // 关闭聚焦面板，回到推演
      await page.locator('#focus-close').click().catch(() => {});
      await page.waitForTimeout(300);
    } else {
      console.log('⚠ focus 按钮不可见');
    }

    // 推演验证：重新打开面板 → 输入真实数据 → 开始
    if (!(await page.locator('#dataflow-panel').isVisible().catch(() => false))) {
      await toggle.click();
      await page.waitForTimeout(400);
    }
    const input = page.locator('#dataflow-input');
    await input.fill(JSON.stringify({ cond: 'score >= 60 && user.age > 18', scope: { score: 85, user: { age: 20 } } }, null, 2));
    await page.locator('#dataflow-start').click();
    await page.waitForTimeout(3200); // 3 步 × 800ms + 缓冲
    await shot(page, 't6_trace_done');

    // DOM 证据：播放结束后的浮层/toast 文本
    const evidence = await page.evaluate(() => {
      const bubble = document.getElementById('trace-bubble');
      const toast = document.querySelector('#toast, .toast');
      const actives = [...document.querySelectorAll('.node.trace-active')].map((el) => el.getAttribute('data-label'));
      return {
        bubble: bubble ? bubble.textContent.trim().slice(0, 300) : null,
        toast: toast ? toast.textContent.trim().slice(0, 200) : null,
        activeNodes: actives,
      };
    });
    console.log('播放后 DOM 证据：\n' + JSON.stringify(evidence, null, 2));
  } else {
    console.log('⚠ dataflow-toggle 仍禁用（未选中有效 detail 节点）');
  }
} finally {
  await browser.close();
}
console.log('截图：\n' + shots.map((s) => ' - ' + s).join('\n'));
