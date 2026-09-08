// probe_boot.mjs — Agent 在线插桩的运行时启动入口（--import probe_boot）。
// 在 Agent 最早把探针挂上 globalThis.__probeScope，注入的
// `(globalThis.__probeScope?.enter ?? noop)(name,{file,args})` 就能被解析并落盘。
// 需与 tsx 联用启动有 scope 插桩的 TS 源码：
//   node --import tsx/esm --import <probe_boot> apps/cli/src/bin.ts
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const probeAbs = fileURLToPath(new URL('../../../dist/src/observe/probe.js', import.meta.url).href);
const probeUrl = process.env.DC_PROBE_URL || pathToFileURL(probeAbs).href;
const { enterScope, exitScope, setGlobalProbeSink, hasGlobalProbeSink, TSProbeCapture } = await import(probeUrl);

// 挂全局探针入口（幂等，只挂一次）
globalThis.__probeScope = globalThis.__probeScope ?? { enter: enterScope, exit: exitScope };

// 设置 sink：录 events.jsonl（DC_EVENTS 指定路径）
const eventsPath = process.env.DC_EVENTS
  || path.join(process.env.DC_EVENTS_DIR || process.cwd(), 'events.jsonl');
if (!hasGlobalProbeSink()) setGlobalProbeSink(new TSProbeCapture(eventsPath));
console.error(`[probe_boot] gl {enter/exit} + sink → ${eventsPath}`);