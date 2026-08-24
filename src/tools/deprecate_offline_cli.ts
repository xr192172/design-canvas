/**
 * deprecate_offline_cli —— 废弃积木下线链 CLI（C 链落地入口）
 *
 * 用法：
 *   node dist/src/tools/deprecate_offline_cli.js --project <dir>
 *        [--plans ./a.ts,./legacy/b] [--files <scope>] [--apply] [--remove-file] [--no-verify]
 */
import { runDeprecateOffline } from './deprecate_offline.js';

function readArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const project = readArg('--project');
  if (!project) {
    console.error('usage: deprecate_offline_cli --project <dir> [--plans ./a.ts,./b] [--files <scope>] [--apply] [--remove-file] [--no-verify]');
    process.exit(2);
  }
  const apply = process.argv.includes('--apply');
  const removeFile = process.argv.includes('--remove-file');
  const noVerify = process.argv.includes('--no-verify');
  const plans = readArg('--plans')
    ?.split(',')
    .filter(Boolean)
    .map((source) => ({ source }));
  const files = readArg('--files')?.split(',').filter(Boolean) || undefined;

  const result = await runDeprecateOffline({
    project_dir: project,
    ...(plans ? { plans } : {}),
    ...(files ? { files } : {}),
    dry_run: !apply,
    remove_file: removeFile,
    verify: !noVerify,
  });
  if (result.message) console.log(result.message);
}

main().catch((e) => {
  console.error('[deprecate_offline] failed:', e);
  process.exit(1);
});