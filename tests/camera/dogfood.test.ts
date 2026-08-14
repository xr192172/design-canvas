/**
 * Camera 狗食插桩测试。
 *
 * 早期这里通过手动埋进 storage.ts 的探针验证 saveDSL/saveLiveFeature 写盘路径。
 * 全自动插桩（instrument）就绪后，手写探针已删除，扩插桩只走一条命令：
 *   node dist/src/camera/instrument_cli.js <project> [--dry-run]
 * 本测试改为验证：
 *   1. 全自动插桩能覆盖 design-canvas 自身写盘源文件（storage.ts 应被注入
 *      enter/exit/io 探针点，dry-run 不写盘）。
 *   2. captureProbe 在无 sink 时是无害 no-op（插桩零侵入）。
 *   3. 跨模块实例共享同一份全局 sink（真实插桩场景：被插桩代码与哨兵从不同
 *      specifier 加载同一 probe 实现）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { instrumentFile } from '../../src/camera/instrument.js';
import {
  TSProbeCapture,
  setGlobalProbeSink,
  captureProbe,
  loadTSEvents,
} from '../../src/camera/probe.js';
import { getDataHome } from '../../src/storage.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');

describe('Camera 狗食插桩 · 全自动插桩覆盖自身写盘路径', () => {
  it('storage.ts 被全自动插桩注入 enter/io 探针点（dry-run）', async () => {
    const file = path.join(PROJECT_ROOT, 'src', 'storage.ts');
    expect(fs.existsSync(file)).toBe(true);
    const res = await instrumentFile(file, { projectRoot: PROJECT_ROOT, write: false });
    expect(res.error).toBeUndefined();
    // 写盘路径 saveDSL/saveLiveFeature 走 fs.writeFileSync → 必然命中 io 探针
    expect(res.sites.some((s) => s.kind === 'io')).toBe(true);
    // 函数出入口也应被插桩
    expect(res.sites.some((s) => s.kind === 'enter')).toBe(true);
    expect(res.sites.some((s) => s.kind === 'exit')).toBe(true);
    // 探针事件带 file 字段（相对项目根），供日志按文件过滤
    for (const s of res.sites) {
      expect(s.injected).toContain('file:');
    }
  });

  it('dry-run 不写盘：源文件保持原样', async () => {
    const file = path.join(PROJECT_ROOT, 'src', 'storage.ts');
    const before = fs.readFileSync(file, 'utf-8');
    await instrumentFile(file, { projectRoot: PROJECT_ROOT, write: false });
    const after = fs.readFileSync(file, 'utf-8');
    expect(after).toBe(before);
    expect(after).not.toContain('camera:instrumented');
  });
});

describe('Camera 狗食插桩 · 零侵入', () => {
  it('captureProbe 在无 sink 时是无害 no-op', () => {
    expect(() => captureProbe('whatever', { x: 1 })).not.toThrow();
  });
});

describe('Camera 狗食插桩 · 跨模块实例共享 sink（回归）', () => {
  it('不同 specifier 加载的 probe 实例共享同一份全局 sink', async () => {
    const modA = await import('../../dist/src/camera/probe.js');
    const modB = await import(pathToFileURL(path.resolve('dist/src/camera/probe.js')).href);

    const eventsPath = path.join(getDataHome(), 'camera-shared');
    const sink = new TSProbeCapture(TSProbeCapture.pathFor(eventsPath));
    // 用实例 A 设置 sink
    modA.setGlobalProbeSink(sink);

    // 用实例 B 的 captureProbe 采集（应命中 A 设置的全局 sink）
    modB.captureProbe('shared.test', { via: 'modB' });
    const { events } = loadTSEvents(TSProbeCapture.pathFor(eventsPath));
    expect(events).toHaveLength(1);
    expect(events[0].probe).toBe('shared.test');
    expect(events[0].fields['via']).toBe('modB');
  });
});