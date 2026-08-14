/**
 * Camera 狗食运行哨兵（可选启用）
 *
 * 让 design-canvas 自身在真实运行时自动采集 Camera 探针事件，实现"运行中
 * 自动发现数据流/逻辑错误"。零侵入：默认不启用，只有显式设置环境变量时
 * 才开启全局 sink。
 *
 * 启用方式（在入口处调用一次 enableCameraFromEnv()）：
 *   CAMERA_EVENTS_FILE=<path>   # 事件落盘路径，必设才启用
 *   CAMERA_SOURCE=<name>        # 可选，来源标记，默认 'runtime'
 *
 * 未设置 CAMERA_EVENTS_FILE 时是 no-op，不会改变宿主行为、不创建任何文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import { TSProbeCapture, setGlobalProbeSink } from './probe.js';

/** 从环境变量启用 Camera 全局探针 sink。返回是否已启用。 */
export function enableCameraFromEnv(): boolean {
  const eventsFile = process.env.CAMERA_EVENTS_FILE;
  if (!eventsFile) return false;
  const sink = new TSProbeCapture(eventsFile);
  setGlobalProbeSink(sink);
  // 幂等：确保事件文件可写（目录存在）
  fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
  return true;
}