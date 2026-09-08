// bootstrap.mjs — 在线插桩入口（node --import <bootstrap> 程序）
//   1) 初始化探针全局 sink（events.jsonl，直落盘；后续可换采样器）
//   2) 注册 ESM loader hook → 运行时对后续加载模块做 scope 注入
// 环境变量：DC_EVENTS(events 路径) / DC_PROBE_URL(跨仓 probe 绝对 file URL)
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const probeAbs = fileURLToPath(new URL('../../../dist/src/observe/probe.js', import.meta.url).href);
const probeUrl = process.env.DC_PROBE_URL || pathToFileURL(probeAbs).href;
process.env.DC_PROBE_URL = probeUrl;

const { setGlobalProbeSink, TSProbeCapture } = await import(probeUrl);

const eventsPath = process.env.DC_EVENTS
  || path.join(process.env.DC_EVENTS_DIR || process.cwd(), 'events.jsonl');
console.error(`[online-probe] sink → ${eventsPath}`);
setGlobalProbeSink(new TSProbeCapture(eventsPath));

const loaderURL = new URL('./loader.mjs', import.meta.url).href;
register(loaderURL);
console.error(`[online-probe] loader registered (probe.url=${probeUrl})`);

// 目标尽量不经 entry（Windows 下 entry 可能绕过 load hook），改由 bootstrap 在注册后
// `await import` 加载，保证走 loader 钩子做在线插桩。
if (process.env.DC_TARGET) {
  await import(process.env.DC_TARGET);
}