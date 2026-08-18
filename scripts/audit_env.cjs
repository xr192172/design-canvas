#!/usr/bin/env node
/** 开发环境审计：每个项目的 git 活跃度（最后提交时间/提交数/是否dirty）+ 定位线索 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = 'D:\\project_develop';
const dirs = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
  .map((d) => d.name);

const rows = [];
for (const name of dirs) {
  const p = path.join(ROOT, name);
  const r = { name, git: '无git', last: '-', commits: 0, dirty: '', readme: '' };
  try {
    r.last = execSync('git log -1 --format=%as', { cwd: p, encoding: 'utf-8' }).trim();
    r.commits = parseInt(execSync('git rev-list --count HEAD', { cwd: p, encoding: 'utf-8' }).trim(), 10);
    const st = execSync('git status --porcelain', { cwd: p, encoding: 'utf-8' }).trim();
    const lines = st ? st.split('\n') : [];
    r.dirty = lines.length ? `${lines.length}改动` : '干净';
    r.git = '有';
  } catch { /* 非 git 目录 */ }
  // README 首个非标题行作为定位线索
  for (const rn of ['README.md', 'readme.md', 'README.zh-CN.md']) {
    const rf = path.join(p, rn);
    if (fs.existsSync(rf)) {
      const lines = fs.readFileSync(rf, 'utf-8').split(/\r?\n/);
      const meaningful = lines.find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('!') && !l.startsWith('<'));
      r.readme = (meaningful || '').slice(0, 60);
      break;
    }
  }
  rows.push(r);
}

rows.sort((a, b) => (a.last < b.last ? 1 : -1));
console.log('项目'.padEnd(26), '最后提交', ' 提交数  状态     定位线索');
console.log('─'.repeat(110));
for (const r of rows) {
  console.log(r.name.padEnd(26), r.last.padEnd(10), String(r.commits).padStart(5), (r.git === '有' ? r.dirty : '无git').padEnd(7), r.readme);
}