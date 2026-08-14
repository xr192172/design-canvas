/**
 * Camera 狗食运行哨兵演示：真实运行 design-canvas 的 saveDSL 写盘路径，
 * 通过 CAMERA_EVENTS_FILE 启用全局探针 sink，产出真实 events.jsonl，
 * 再喂给 Go 装配层判定，验证"运行中自动发现数据流错误"。
 *
 * 用法（项目根，先构建）：
 *   npx tsc
 *   $out = Join-Path $env:TEMP "camera-dogfood-e2e-$PID"
 *   $env:CAMERA_EVENTS_FILE = "$out\events.jsonl"
 *   $env:DESIGN_CANVAS_HOME = "$out"
 *   node scripts/camera_run_dogfood.mjs
 *   go run ./go-camera/cmd/camera-dsl --project-root $out loop $out\events.jsonl
 */

import { enableCameraFromEnv } from '../dist/src/camera/run_sentinel.js';
import { saveDSL } from '../dist/src/storage.js';

// 1. 启用运行哨兵（从 env 读 CAMERA_EVENTS_FILE）
const enabled = enableCameraFromEnv();

// 2. 触发真实运行路径：saveDSL 写盘
const dsl = {
  feature: `dogfood-${Date.now().toString(36)}`,
  version: 1,
  updated_at: new Date().toISOString(),
};
const file = saveDSL(dsl);
console.log(`[camera] 哨兵启用=${enabled}`);
console.log(`[camera] saveDSL 已写盘 → ${file}`);
console.log(`[camera] events 落盘 → ${process.env.CAMERA_EVENTS_FILE}`);
console.log('接下来喂给 Go 装配层判定：camera-dsl loop <events.jsonl>');