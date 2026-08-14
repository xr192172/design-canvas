/**
 * Camera 跨语言契约试点 · TS 探针埋点演示
 *
 * 在 TS 侧埋点（模拟 status_demo 的 save 路径），产出 events.jsonl，证明：
 *   1. TS 探针按 Event schema 产出观测（语言无关）。
 *   2. 同一份 events.jsonl 可被 Go 装配层（camera-dsl loop）正确判定。
 *
 * 用法（在项目根）：
 *   node scripts/camera_ts_probe_demo.mjs <outDir>
 *   go run ./go-camera/cmd/camera-dsl --project-root <outDir> loop <outDir>/events.jsonl
 */

import { TSProbeCapture } from '../dist/src/camera/index.js';

const outDir = process.argv[2] || '.agent/camera-ts-demo';
const probe = new TSProbeCapture(TSProbeCapture.pathFor(outDir));

// ── 埋点：save 路径（写文件） ──
probe.emit('save.writefile', { op: 'writefile', err: null }); // 正常
probe.emit('save.writefile', { op: 'writefile', err: 'ENOENT' }); // 违反：写文件错误被静默丢弃

// ── 埋点：cleanup 路径（清理） ──
probe.emit('cleanup.remove', { op: 'remove', err: 'not exist', benign: true }); // 良性
probe.emit('cleanup.remove', { op: 'remove', err: 'permission denied' }); // 违反：非良性清理错误

console.log(`已埋点产出 events.jsonl → ${TSProbeCapture.pathFor(outDir)}`);
console.log('接下来可喂给 Go 装配层判定：');
console.log(`  go run ./go-camera/cmd/camera-dsl --project-root ${outDir} loop ${TSProbeCapture.pathFor(outDir)}`);