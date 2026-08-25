/**
 * refactor_judge_cli —— LLM 审闭环裁决门的独立 CLI（单段可启停）
 *
 * 用法：
 *   node dist/src/tools/refactor_judge_cli.js --project <dir>
 *        [--issues <candidates.json>]   # 候选问题数组；缺省自动扫死 import
 *        [--json <report.json>]         # 写结构化报告
 *
 * 流程：收集候选问题 → 裁决（默认不裁决=全部"不确定"上抛；也可 --decide 缺省无）→
 *       拿不定主意的入收件箱回上下文 → 控制台摘要 + 可选 JSON。
 * 对应"用 MCP/CLI 跑裁决 → 问题回吐给 LLM → 再给人审"的闭环。
 */
import fs from 'node:fs';
import path from 'node:path';
import { detectDeadImports } from './detect_dead_imports.js';
import { runRefactorJudge, type JudgeIssue } from './refactor_judge.js';

function readArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 自动收集候选：死 import（无 ide 依赖轻量收集）。可根据需要扩展更多检测器。 */
function autoCollect(project: string): JudgeIssue[] {
  const det = detectDeadImports({ project_dir: project });
  return det.dead.map((c) => ({
    type: 'dead_import',
    file: c.files.join(', '),
    desc: `死三方依赖 ${c.source}（${c.files.length} 个文件引用但零使用）`,
    severity: c.files.length > 3 ? 'high' : 'medium',
    evidence: `source=${c.source}`,
  }));
}

async function main(): Promise<void> {
  const project = readArg('--project');
  if (!project) {
    console.error('usage: refactor_judge_cli --project <dir> [--issues <candidates.json>] [--json <report.json>]');
    process.exit(2);
  }
  const issuesArg = readArg('--issues');
  const jsonOut = readArg('--json');

  const issues: JudgeIssue[] = issuesArg
    ? (JSON.parse(fs.readFileSync(path.resolve(issuesArg), 'utf-8')) as JudgeIssue[])
    : autoCollect(project);

  if (issues.length === 0) {
    console.log(`[refactor_judge] 无候选问题（${issuesArg ? '显式清单为空' : '未发现死 import'}）——无需裁决`);
    return;
  }

  const result = await runRefactorJudge({ project_dir: path.resolve(project), issues });
  console.log(result.review_prompt);
  console.log(
    `[refactor_judge] ${result.meta.total} 候选 → 采纳 ${result.meta.adopted} / 驳回 ${result.meta.rejected} / 上抛待审 ${result.meta.unsure}`,
  );

  if (jsonOut) {
    fs.writeFileSync(path.resolve(jsonOut), JSON.stringify({ project_dir: path.resolve(project), issues, result }, null, 2), 'utf-8');
    console.log(`[refactor_judge] JSON→ ${path.resolve(jsonOut)}`);
  }
}

main().catch((e) => {
  console.error('[refactor_judge] failed:', e);
  process.exit(1);
});