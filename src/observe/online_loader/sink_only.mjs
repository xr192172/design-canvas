// sink_only.mjs — 仅初始化探针全局 sink，不注册 loader。
// 用于"源码已插桩"后：`node --import sink_only --import tsx/esm <index>.ts` 跑插桩后的源码，
// 让注入的 enterScope/exitScope 能落 events.jsonl（与 probe.js 同模块实例共享 globalThis）。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const probeAbs = fileURLToPath(new URL('../../../dist/src/observe/probe.js', import.meta.url).href);
const probeUrl = process.env.DC_PROBE_URL || pathToFileURL(probeAbs).href;
const { setGlobalProbeSink, TSProbeCapture } = await import(probeUrl);

const eventsPath = process.env.DC_EVENTS
  || path.join(process.env.DC_EVENTS_DIR || process.cwd(), 'events.jsonl');
console.error(`[sink] ${eventsPath}`);
setGlobalProbeSink(new TSProbeCapture(eventsPath));