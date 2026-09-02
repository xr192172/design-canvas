#!/usr/bin/env node
/**
 * readme_tools_gate —— README「共注册 N 个 MCP 工具」数字自愈 + 新工具遗漏提示
 *
 * 背景（文档漂移）：README 谎报工具数（42 而真实 50），且新增 MCP 工具常漏登记进
 * README 工具参考。手工维护不可行（工具按分组读中文用途描述，是人工资产）。
 *
 * 本脚本（自愈 + 提示，非硬阻断）：
 *   ① 数字自愈：把 README 里「共注册 **N 个**」替换为 server_registry 真实 TOOL_DEFS 数
 *      （这是事实陈述，错即说谎 → 本脚本直接改）。
 *   ② 新工具遗漏提示：已注册但 README 工具参考章节零提及的工具 → stderr 提示补充（不 exit 1，
 *      因 README 分组表是精选，不强求全列）。
 *
 * 用法：
 *   node scripts/readme_tools_gate.mjs        # exit 0：自愈数字 + 提示遗漏（常规）
 *   node scripts/readme_tools_gate.mjs --check # 只报不改（CI 用：数字不一致 exit 1）
 *   SKIP_README_GATE=1                        # 紧急跳过
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

if (process.env.SKIP_README_GATE === '1') process.exit(0);

const root = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
const readmePath = `${root}/README.md`;
const registryPath = `${root}/src/server_registry.ts`;
const check = process.argv.includes('--check');

/** 从 server_registry 源码提取工具名集合 */
const NAME_RE = /name:\s*['"]([a-z][a-z0-9_]*)['"]/g;
export function registryToolNames(regSrc) {
  const names = new Set();
  let m;
  while ((m = NAME_RE.exec(regSrc)) !== null) names.add(m[1]);
  return names;
}

/** README 里「共注册 **N 个 MCP 工具」段落占位（缺失时外部报错） */
const CNT_RE = /共注册 \*\*(\d+) 个 MCP 工具/;

/**
 * 核心判定：对比 README 工具数占位与真实注册数，找出零提及工具。
 * @returns { claimed, actual, changed, missingFromReadme, updatedReadme }
 */
export function analyzeReadmeTools(regSrc, readme) {
  const names = registryToolNames(regSrc);
  const cntMatch = CNT_RE.exec(readme);
  if (!cntMatch) {
    throw new Error('README 未找到「共注册 **N 个 MCP 工具」——需在工具参考段落保留该占位');
  }
  const claimed = Number(cntMatch[1]);
  const actual = names.size;
  const changed = claimed !== actual;
  const updatedReadme = changed ? readme.replace(CNT_RE, (s) => s.replace(String(claimed), String(actual))) : readme;

  // README 全文中 backtick 引用的工具名集合（仅取属真实注册名的）
  const usedTools = new Set();
  for (const bt of readme.matchAll(/`([a-z][a-z0-9_]*)\)?`/g)) {
    if (names.has(bt[1])) usedTools.add(bt[1]);
  }
  const missingFromReadme = [...names].filter((n) => !usedTools.has(n));
  return { claimed, actual, changed, missingFromReadme, updatedReadme };
}

// 直接执行才跑（被测试 import 时仅导出核心函数）
if (process.argv[1] && /readme_tools_gate\.(js|mjs)$/.test(process.argv[1].replace(/\\/g, '/'))) {
  try {
    const regSrc = readFileSync(registryPath, 'utf-8');
    const readme = readFileSync(readmePath, 'utf-8');
    const { claimed, actual, changed, missingFromReadme } = analyzeReadmeTools(regSrc, readme);

    const lines = [`[readme_tools] 共注册任务：README=${claimed} → 真实=${actual}`];
    if (changed) lines.push(check ? '  ⚠ 数字漂移（--check，未修改）' : '  ✓ 已自愈数字');
    else lines.push('  ✓ 数字一致');
    if (missingFromReadme.length > 0) {
      lines.push('  · 已注册但 README 零提及（可补进工具参考分组表，非强制）：');
      lines.push('    ' + missingFromReadme.join(', '));
    }
    console.error(lines.join('\n'));

    // 写盘（非 check 且数字漂移）
    if (changed && !check) writeFileSync(readmePath, analyzeReadmeTools(regSrc, readme).updatedReadme, 'utf-8');

    if (check && changed) process.exit(1);
    process.exit(0);
  } catch (e) {
    console.error(`[readme_tools] ${e.message}`);
    process.exit(1);
  }
}