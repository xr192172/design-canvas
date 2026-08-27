/**
 * diagnose_cli —— 诊断工具独立 CLI（单段可启停，便于调试与脚本化）
 *
 * 用法：
 *   node dist/src/tools/diagnose_cli.js --project <dir> --symptom "<报错/行为描述>"
 *        [--type error|test_failure|behavior] [--anchor <文件|符号>] [--depth 3] [--json]
 *
 * 前置：目标项目需已运行 import_project 建立符号缓存（.design-canvas/cache.db），
 * 否则只能给文件级线索。--json 输出结构化 DiagnoseOutput，便于脚本/前端消费。
 */

import { runDiagnosis, formatDiagnoseText } from '../diagnosis/diagnose.js';
import type { SymptomType } from '../diagnosis/contract.js';

function readArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(name);

async function main(): Promise<void> {
  const project = readArg('--project');
  const symptom = readArg('--symptom');
  if (!project || !symptom) {
    console.error('usage: diagnose_cli --project <dir> --symptom "<symptom>" [--type error|test_failure|behavior] [--anchor <file|symbol>] [--depth 3] [--json]');
    process.exit(2);
  }
  const type = readArg('--type') as SymptomType | undefined;
  const anchor = readArg('--anchor');
  const depth = Number(readArg('--depth') ?? 3);

  const out = await runDiagnosis({
    project_dir: project,
    symptom,
    symptom_type: type && ['error', 'test_failure', 'behavior'].includes(type) ? type : 'auto',
    anchor,
    max_depth: Number.isFinite(depth) && depth > 0 ? depth : 3,
    use_llm: !has('--rule'),
  });

  if (has('--json')) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(formatDiagnoseText(out));
  }
}

main().catch((e) => {
  console.error('diagnose_cli 失败：', e);
  process.exit(1);
});
