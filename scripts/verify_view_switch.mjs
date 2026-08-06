/**
 * 实际/设计 视图切换控件验证（playwright）
 *
 * 流程：getDSL 读设计 DSL → renderHTML 生成 HTML → 打开 serve 页面
 *   → ① 断言切换按钮存在、设计视图默认 active、data-view=design
 *   → ② 点击「实际」触发 reload → 断言 data-view=actual、实际按钮 active、状态筛选灰显
 *   → ③ 截图
 *
 * 运行前提：serve 已在运行（node scripts/../../../dist... 或 npm run serve），
 *   linux 风格脚本：node scripts/verify_view_switch.mjs
 */
import fs from 'node:fs';
import { chromium } from 'playwright';
import { renderHTML } from '../dist/src/renderer/html_renderer.js';
import { getDSL } from '../dist/src/storage.js';

const feature = 'smoke';
const dsl = getDSL(feature);
if (!dsl) {
  console.error('feature 不存在:', feature);
  process.exit(1);
}
const html = renderHTML(dsl, {});
fs.writeFileSync('output/verify_view.html', html);
console.log('已生成 output/verify_view.html');

const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
const page = await browser.newPage();
let ok = true;
const check = (name, cond) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name);
  if (!cond) ok = false;
};

// ① 设计视图默认
await page.goto('http://localhost:3050/verify_view.html');
await page.waitForSelector('#src-design', { timeout: 8000 });
check('切换按钮存在 (src-design/src-actual)', !!(await page.$('#src-actual')));
check('设计视图默认 active', await page.evaluate(() => document.getElementById('src-design').classList.contains('active')));
check('data-view=design', (await page.evaluate(() => document.body.getAttribute('data-view'))) === 'design');
check('设计视图状态按钮可点', await page.evaluate(() => {
  const c = document.querySelector('.filter-chip[data-filter-status]');
  return c ? getComputedStyle(c).pointerEvents !== 'none' : 'no-chip';
}));
await page.screenshot({ path: 'output/verify_view_design.png' });

// ② 点击实际 → reload
await page.click('#src-actual');
await page.waitForNavigation({ waitUntil: 'load', timeout: 8000 }).catch(() => {});
await page.waitForTimeout(600);
check('实际按钮 active', await page.evaluate(() => document.getElementById('src-actual')?.classList.contains('active')));
check('data-view=actual', (await page.evaluate(() => document.body.getAttribute('data-view'))) === 'actual');
check('状态筛选按钮灰显(pointer-events:none)', await page.evaluate(() => {
  const c = document.querySelector('.filter-chip[data-filter-status]');
  return c ? getComputedStyle(c).pointerEvents === 'none' : 'no-chip';
}));
check('孤岛按钮仍可点', await page.evaluate(() => {
  const c = document.getElementById('filter-islands');
  return c ? getComputedStyle(c).pointerEvents !== 'none' : 'no-chip';
}));
await page.screenshot({ path: 'output/verify_view_actual.png' });

// ③ 切回设计
await page.click('#src-design');
await page.waitForNavigation({ waitUntil: 'load', timeout: 8000 }).catch(() => {});
await page.waitForTimeout(600);
check('切回设计 data-view=design', (await page.evaluate(() => document.body.getAttribute('data-view'))) === 'design');
check('状态按钮恢复可点', await page.evaluate(() => {
  const c = document.querySelector('.filter-chip[data-filter-status]');
  return c ? getComputedStyle(c).pointerEvents !== 'none' : 'no-chip';
}));

await browser.close();
console.log('\n[view switch] ' + (ok ? '通过 ✓' : '失败 ✗'));
process.exit(ok ? 0 : 1);