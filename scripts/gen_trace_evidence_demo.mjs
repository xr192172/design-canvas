/**
 * gen_trace_evidence_demo：跑一次真实 trace_reasoning 插桩采集，
 * 把原始 trace 落盘到 <dataHome>/.design-canvas/live/<feature>.trace.json，
 * 作为 L4 证据回溯「真实可复算」的可验收产物。
 *
 * 用法：npm run build && node scripts/gen_trace_evidence_demo.mjs
 * 产物：数据主目录 .design-canvas/live/evidence_trace.trace.json
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { traceReasoning } from '../dist/src/tools/trace_reasoning.js';
import { getLiveDir } from '../dist/src/storage.js';
import {
  resolveTraceEvidence,
  buildTraceResolver,
  loadTraceRecords,
} from '../dist/src/tools/trace_evidence.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentFile = path.join(root, 'tests', 'fixtures', 'agent_demo.mjs');

const feature = 'evidence_trace';
const traceFile = path.join(getLiveDir(), `${feature}.trace.json`);

const result = await traceReasoning({
  entryFile: agentFile,
  entryFn: 'entry',
  input: '分析依赖：用户服务需要上下文折叠',
  feature,
  traceFile, // 落盘原始记录
});

console.log('[gen] 已采集 trace：', result.counts);

// 读回并做证据回溯自检
const records = loadTraceRecords(traceFile);
const res = buildTraceResolver(records);
const checks = [
  { label: '真实函数 validate', ev: { type: 'trace', ref: 'validate' } },
  { label: '真实函数 compose', ev: { type: 'trace', ref: 'compose' } },
  { label: '编造函数 ghost_fn', ev: { type: 'trace', ref: 'ghost_fn' } },
];
for (const c of checks) {
  const r = resolveTraceEvidence(records, c.ev);
  console.log(`   ${c.label.padEnd(20)} → ${r.ok ? '通过 ✓' : `打回 ✗ (${r.error})`}`);
}
console.log('   真实函数集合:', res.traceRefs.join(', '));
console.log('   trace 文件   :', path.relative(root, traceFile));