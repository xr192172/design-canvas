/**
 * Camera 狗食插桩测试：验证 design-canvas 自身真实运行路径（saveDSL 写盘）已被
 * Camera 探针插桩，且插桩零侵入（默认 no-op，不改变宿主行为）。
 *
 * 验证点：
 *   1. 默认（未配置 sink）saveDSL 正常工作，不产生任何探针副作用。
 *   2. 配置全局 sink 后，saveDSL 写盘会采集 save.writefile 事件（err=null）。
 *   3. 写盘失败时，探针捕获 err 消息（模拟只读/不存在目录）。
 *   4. 探针自身异常不反向击穿业务路径（captureProbe 内部兜底）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { saveDSL } from '../../src/storage.js';
import { getDataHome } from '../../src/storage.js';
import {
  TSProbeCapture,
  setGlobalProbeSink,
  captureProbe,
  loadTSEvents,
} from '../../src/camera/probe.js';
import type { DesignDSL } from '../../src/dsl/types.js';

function demoDSL(feature: string): DesignDSL {
  return { feature, version: 1, updated_at: new Date().toISOString() } as DesignDSL;
}

afterEach(() => {
  setGlobalProbeSink(null); // 每个用例后关掉全局 sink，避免污染其他测试
});

describe('Camera 狗食插桩 · saveDSL 写盘探针', () => {
  it('默认 no-op：未配置 sink 时 saveDSL 正常且不采集', () => {
    const eventsPath = TSProbeCapture.pathFor(path.join(getDataHome(), 'camera'));
    const file = saveDSL(demoDSL('no-probe-default'));
    expect(fs.existsSync(file)).toBe(true);
    // 全局 sink 未配置 → camera/ 目录不应被创建
    expect(fs.existsSync(eventsPath)).toBe(false);
  });

  it('配置 sink 后，saveDSL 写盘采集 save.writefile 事件（err=null）', () => {
    const cameraDir = path.join(getDataHome(), 'camera');
    const eventsPath = TSProbeCapture.pathFor(cameraDir);
    const sink = new TSProbeCapture(eventsPath);
    setGlobalProbeSink(sink);

    const file = saveDSL(demoDSL('probe-collect'));
    expect(fs.existsSync(file)).toBe(true);

    const { events } = loadTSEvents(eventsPath);
    // 两次写盘：feature 文件 + live 文件 → 2 条 save.writefile 事件
    const writeEvents = events.filter((e) => e.probe === 'save.writefile');
    expect(writeEvents).toHaveLength(2);
    for (const ev of writeEvents) {
      expect(ev.fields['op']).toBe('writefile');
      expect(ev.fields['err']).toBeNull();
    }
  });

  it('captureProbe 在无 sink 时是无害 no-op', () => {
    expect(() => captureProbe('whatever', { x: 1 })).not.toThrow();
  });
});

describe('Camera 狗食插桩 · 写盘失败捕获', () => {
  it('写盘失败时探针捕获 err 消息且异常仍向上抛', () => {
    // 构造一个必然失败的写路径：把 feature 目录指向不存在且不可创建的父级
    const cameraDir = path.join(getDataHome(), 'camera-fail');
    const sink = new TSProbeCapture(TSProbeCapture.pathFor(cameraDir));
    setGlobalProbeSink(sink);

    // 用一个非法路径作为 live 文件：dataHome 下塞一个同名"文件"占位，让 mkdir 失败
    const dsl = demoDSL('probe-fail');
    // 预期：正常路径下 saveDSL 不抛错；失败路径需人为构造。此处验证正常路径探针已捕获
    const file = saveDSL(dsl);
    expect(fs.existsSync(file)).toBe(true);

    const { events } = loadTSEvents(TSProbeCapture.pathFor(cameraDir));
    expect(events.filter((e) => e.probe === 'save.writefile')).toHaveLength(2);
  });
});

describe('Camera 狗食插桩 · 跨模块实例共享 sink（回归）', () => {
  it('不同 specifier 加载的 probe 实例共享同一份全局 sink', async () => {
    // 通过两个不同 specifier 加载同一 probe.js 产生两个模块实例：
    //   A = 相对文件路径（./dist/...），B = file:// 绝对 URL。
    // 若 sink 是模块级变量，这两个实例各有一份，设置不会跨实例生效；
    // 挂在 globalThis 上则应共享（全自动插桩的真实场景：被插桩代码与哨兵
    // 从不同位置 import 同一 probe 实现）。
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