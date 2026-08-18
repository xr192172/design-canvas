#!/usr/bin/env node
/**
 * 开发环境重组脚本（2026-08-18 审计执行）——幂等，可重复运行
 *
 * 一、删除 16 项（用户已确认）：
 *   三胞胎     ai-left / ai-right / ai-sandbox（main.go MD5 与彼此一致，正主在 ai-base）
 *   冗余包     deepseek-harness.zip / dsh.zip / claude-code-analysis.7z / claude-code-analysis.zip
 *   空壳残骸   deepseek-harness / ai-base-right / brain-central / project-name / backup-runtime-files
 *   测试残留   _test_idx2.db / _test_index.db
 *   已吸收     lesion-rules / project-index（能力已并入 design-canvas）
 *
 * 二、参考类收编 → ai-base/references/（并加入 ai-base/.gitignore 防污染版本库）：
 *   reasonix / sillytavern / codebase-memory-mcp-src / headroom-research /
 *   layerdivider / wet-mcp / deepseek-harness-master / claude-code-analysis（10篇分析文档）
 */
const fs = require('fs');
const path = require('path');

const ROOT = 'D:\\project_develop';
const REF_DIR = path.join(ROOT, 'ai-base', 'references');

const DELETE_DIRS = [
  'ai-left', 'ai-right', 'ai-sandbox',
  'deepseek-harness', 'ai-base-right', 'brain-central',
  'project-name', 'backup-runtime-files',
  'lesion-rules', 'project-index',
];
const DELETE_FILES = [
  'deepseek-harness.zip', 'dsh.zip',
  'claude-code-analysis.7z', 'claude-code-analysis.zip',
  '_test_idx2.db', '_test_index.db',
];
const MOVE_TO_REFS = [
  'reasonix', 'sillytavern', 'codebase-memory-mcp-src', 'headroom-research',
  'layerdivider', 'wet-mcp', 'deepseek-harness-master', 'claude-code-analysis',
];

const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };

console.log('═══ 一、删除 ═══');
for (const d of DELETE_DIRS) {
  const p = path.join(ROOT, d);
  if (exists(p)) { fs.rmSync(p, { recursive: true, force: true }); console.log(`  ✗ 已删目录 ${d}`); }
  else console.log(`  · 已不存在 ${d}（跳过）`);
}
for (const f of DELETE_FILES) {
  const p = path.join(ROOT, f);
  if (exists(p)) { fs.rmSync(p, { force: true }); console.log(`  ✗ 已删文件 ${f}`); }
  else console.log(`  · 已不存在 ${f}（跳过）`);
}

console.log('═══ 二、收编参考类 → ai-base/references/ ═══');
if (!exists(REF_DIR)) fs.mkdirSync(REF_DIR, { recursive: true });
for (const m of MOVE_TO_REFS) {
  const src = path.join(ROOT, m);
  const dst = path.join(REF_DIR, m);
  if (!exists(src)) { console.log(`  · 源不存在 ${m}（跳过）`); continue; }
  if (exists(dst)) { console.log(`  ! 目标已存在 ${m}（跳过，请人工确认）`); continue; }
  fs.renameSync(src, dst); // 同盘瞬移
  console.log(`  → ${m} 移入 ai-base/references/`);
}

// ai-base/.gitignore 追加 references/（幂等）
const gi = path.join(ROOT, 'ai-base', '.gitignore');
if (exists(gi)) {
  let txt = fs.readFileSync(gi, 'utf-8');
  if (!/^[\/\\]?references\/?\s*$/m.test(txt)) {
    txt = txt.replace(/\s*$/, '') + '\n\n# 第三方参考源码（审计 2026-08-18 收编，不进版本库）\nreferences/\n';
    fs.writeFileSync(gi, txt);
    console.log('  ✓ ai-base/.gitignore 已追加 references/');
  } else console.log('  · .gitignore 已含 references/（跳过）');
} else {
  fs.writeFileSync(gi, '# 第三方参考源码（审计 2026-08-18 收编，不进版本库）\nreferences/\n');
  console.log('  ✓ 已创建 ai-base/.gitignore（含 references/）');
}

console.log('═══ 完成 · 顶层现状 ═══');
for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (e.name.startsWith('.')) continue;
  console.log(`  ${e.isDirectory() ? '[目录]' : '[文件]'} ${e.name}`);
}
console.log('\n提示：把 TRAE/IDE 工作区根上移到 D:\\project_develop，即可单窗口同时开发 design-canvas 与 ai-base。');