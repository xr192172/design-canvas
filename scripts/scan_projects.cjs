#!/usr/bin/env node
/** 扫描 D:\project_develop 下每个子项目的源码规模（与 import_project SKIP_DIRS 对齐），供挑选导入对象 */
const fs = require('fs');
const path = require('path');

const ROOT = 'D:\\project_develop';
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'output', '__pycache__', '.next', '.nuxt', '.venv', 'venv', '.idea', '.vscode', '.backup', 'scaffold', '.design-canvas', '.claude', '.agent', '.camera', '.project-index', '.test-queue', 'coverage', 'target', 'docs', 'tests', '.github', 'site', 'public', 'node_modules/.cache', '.agent']);
const SKIP_FILE = /\.(map|min\.js|lock|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|zip|7z|gz|tar|exe|dll|so|pyc|db|sqlite|7z|blend|webp)$/;
// 只统计这些源码扩展名
const SRC_RE = /\.(ts|tsx|js|mjs|cjs|jsx|py|go|rs|java|kt|c|cpp|h|hpp|cs|vue|svelte)$/;

function scan(dir, baseName) {
  let files = 0, lines = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const fp = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(fp);
      } else if (SRC_RE.test(e.name) && !SKIP_FILE.test(e.name)) {
        files++;
        try {
          const c = fs.readFileSync(fp, 'utf-8');
          lines += c.split('\n').length;
        } catch { /* 二进制/乱码跳过 */ }
      }
    }
  }
  return { files, lines };
}

const results = [];
for (const name of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!name.isDirectory() || name.name.startsWith('.') || name.name === 'tools') continue;
  if (name.name === 'design-canvas') continue; // 已是主项目
  const p = path.join(ROOT, name.name);
  const { files, lines } = scan(p, name.name);
  if (files > 0) results.push({ name: name.name, files, lines });
}
results.sort((a, b) => b.files - a.files);
console.log('项目源码规模（已排除依赖/虚拟环境/构建产物）:');
for (const r of results) console.log(`  ${r.name.padEnd(24)} ${String(r.files).padStart(4)} 文件  ${String(r.lines).padStart(7)} 行`);
console.log(`\n共 ${results.length} 个候选项目`);