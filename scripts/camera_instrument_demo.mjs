/**
 * Camera 全自动插桩狗食演示
 *
 * 对指定项目目录全自动插桩（AST 源码级，直接改写原文件），然后运行运行哨兵，
 * 触发真实 save 路径，采集探针事件，输出插桩报告 + 采集到的事件。
 *
 * 用法（项目根，先构建）：
 *   npx tsc
 *   node scripts/camera_instrument_demo.mjs <项目目录>
 */
import { instrumentProject } from '../dist/src/camera/instrument.js';
import { enableCameraFromEnv } from '../dist/src/camera/run_sentinel.js';
import { loadTSEvents } from '../dist/src/camera/probe.js';

const target = process.argv[2];
if (!target) {
  console.error('用法: node scripts/camera_instrument_demo.mjs <项目目录>');
  process.exit(1);
}

console.log(`=== 1) 全自动插桩 ${target} ===`);
const results = await instrumentProject(target);

let totalSites = 0;
for (const r of results) {
  if (r.sites.length > 0) {
    totalSites += r.sites.length;
    console.log(`· ${r.file}  +${r.sites.length} 探针点`);
    for (const s of r.sites) {
      console.log(`    L${s.line} [${s.kind}] ${s.injected.trim().split('\n')[0]}`);
    }
  } else if (r.error) {
    console.log(`· ${r.file}  ✗ ${r.error}`);
  }
}
console.log(`共 ${results.length} 个文件，注入 ${totalSites} 个探针点`);

// 运行哨兵 + 触发真实 save 路径
const eventsFile = process.env.CAMERA_EVENTS_FILE;
if (eventsFile) {
  console.log(`\n=== 2) 运行哨兵（采集到 ${eventsFile}）===`);
  enableCameraFromEnv();
  const { SaveSink } = await import(pathToFile(target));
  const sink = new SaveSink('./.data');
  const f = sink.save('demo', '{"ok":true}');
  console.log(`运行 save → ${f}`);

  const { events } = loadTSEvents(eventsFile);
  console.log(`\n=== 3) 采集到 ${events.length} 条事件 ===`);
  for (const ev of events) {
    console.log(`· ${ev.probe}  ${JSON.stringify(ev.fields)}`);
  }
}

function pathToFile(dir) {
  return new URL(`file://${dir.replace(/\\/g, '/')}/save_sink.ts`);
}