#!/usr/bin/env node
/** 检查 teach 导图社区/文件描述专属度：模板句占比 + 抽样展示 */
const fs = require('fs');
const path = require('path');

const feature = process.argv[2] || 'design-canvas';
const file = path.join(__dirname, '..', '.design-canvas', 'mindmap', `${feature}.teach.json`);
const mm = JSON.parse(fs.readFileSync(file, 'utf-8'));

const comms = [];
const files = [];
const walk = (n) => {
  if (n.kind === 'community') comms.push(n);
  if (n.kind === 'file') files.push(n);
  (n.children || []).forEach(walk);
};
walk(mm.root);

const tpl = (d) => !d || /个文件.*的子模块/.test(d) || /^\d+ 行(\u00b7|$)/.test(d) || d === '（无描述）';
const commTpl = comms.filter((c) => tpl(c.description)).length;
const fileEmpty = files.filter((f) => !f.description).length;
const dupDesc = new Map();
for (const f of files) dupDesc.set(f.description, (dupDesc.get(f.description) || 0) + 1);
const dups = [...dupDesc.entries()].filter(([, n]) => n > 1);

console.log(`子模块: ${comms.length} 个，模板句 ${commTpl} 个，专属描述 ${comms.length - commTpl} 个`);
console.log(`文件: ${files.length} 个，空描述 ${fileEmpty} 个，重复描述组 ${dups.length} 个`);
console.log('\n── 子模块描述抽样 ──');
for (const c of comms.slice(0, 4)) console.log(`[${c.label}] ${c.description.slice(0, 70)}`);
console.log('\n── 文件描述抽样 ──');
for (const f of files.slice(0, 6)) console.log(`[${f.label}] ${(f.description || '').slice(0, 70)}`);
if (dups.length) {
  console.log('\n── 重复的描述 ──');
  for (const [d, n] of dups.slice(0, 3)) console.log(`x${n}: ${String(d).slice(0, 60)}`);
}
console.log(`\ndesc_cache 条数: ${Object.keys(mm.desc_cache || {}).length}`);
