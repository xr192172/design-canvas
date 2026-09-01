/**
 * watch_project MCP 工具逻辑测试（S3）
 *
 * 覆盖（不依赖真实 fs.watch 异步时序，纯注册表 + 句柄生命周期）：
 *   - start：返回 watching=true，注册句柄
 *   - 重复 start：幂等，复用既有句柄（消息含"幂等"）
 *   - status：未启动 → false；已启动 → true + 带 feature/rebuild
 *   - stop：停止后 status 为 false
 *   - feature 缺省：rebuild 默认按"给了 feature 才重建"推断
 *
 * rebuild 节流器（createRebuildThrottler）：
 *   - 冷却窗口内连续 trigger 合并为一次 run（假定时器）
 *   - 运行中 trigger → 排队补跑，不丢变更
 *   - flush 立即执行并等待完成
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { watchProjectTool, closeAllActiveWatches, createRebuildThrottler } from '../../src/tools/watch_project_tool';
import { openDb } from '../../src/db/db';

const roots: string[] = [];

afterAll(() => {
  closeAllActiveWatches();
  for (const r of roots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      // Windows 文件占用，留给 OS 清理
    }
  }
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wptool-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'export function a(): void {}\n', 'utf-8');
  return root;
}

describe('watchProjectTool start/status/stop', () => {
  it('start 返回 watching=true 并注册句柄', async () => {
    const root = makeRoot();
    const r = await watchProjectTool({ project_dir: root });
    expect(r.action).toBe('start');
    expect(r.watching).toBe(true);
    expect(r.running).toBe(true);
  });

  it('重复 start 幂等复用既有句柄', async () => {
    const root = makeRoot();
    await watchProjectTool({ project_dir: root });
    const r2 = await watchProjectTool({ project_dir: root });
    expect(r2.watching).toBe(true);
    expect(r2.message).toContain('幂等');
  });

  it('status：未启动 → false；启动后 → true 且带 feature/rebuild', async () => {
    const root = makeRoot();
    const before = await watchProjectTool({ project_dir: root, action: 'status' });
    expect(before.watching).toBe(false);

    await watchProjectTool({ project_dir: root, feature: 'demo' });
    const after = await watchProjectTool({ project_dir: root, action: 'status' });
    expect(after.watching).toBe(true);
    expect(after.feature).toBe('demo');
    expect(after.rebuild).toBe(true);
  });

  it('stop 后 status 为 false', async () => {
    const root = makeRoot();
    await watchProjectTool({ project_dir: root });
    const stopped = await watchProjectTool({ project_dir: root, action: 'stop' });
    expect(stopped.watching).toBe(false);
    const st = await watchProjectTool({ project_dir: root, action: 'status' });
    expect(st.watching).toBe(false);
  });

  it('不给 feature 时 rebuild 默认 false', async () => {
    const root = makeRoot();
    const r = await watchProjectTool({ project_dir: root });
    expect(r.rebuild).toBe(false);
  });

  it('drift_on_change 透传并可从 status 回读（独立于 rebuild）', async () => {
    const root = makeRoot();
    const start = await watchProjectTool({ project_dir: root, feature: 'demo', drift_on_change: true });
    expect(start.drift_on_change).toBe(true);
    expect(start.rebuild).toBe(true); // feature 给了 → 默认 rebuild，但 drift 本就独立于 rebuild
    expect(start.message).toContain('drift 过时判定');

    const st = await watchProjectTool({ project_dir: root, action: 'status' });
    expect(st.drift_on_change).toBe(true);
    expect(st.drift_alert).toBeUndefined(); // 尚无变更，未产生 drift 结果
  });

  it('drift_on_change 但没给 feature → 不开 drift（漂移需要可定位的 DSL feature）', async () => {
    const root = makeRoot();
    const start = await watchProjectTool({ project_dir: root, drift_on_change: true });
    expect(start.rebuild).toBe(false);
    expect(start.message).not.toContain('drift 过时判定');
  });
});

describe('createRebuildThrottler 节流', () => {
  /** 假定时器驱动的节流器：手动触发到点回调，便于确定性断言 */
  function makeFakeThrottler() {
    let counter = 0;
    let callback: (() => void) | null = null;
    const run = async () => {
      counter++;
      await Promise.resolve();
    };
    const setTimer = (fn: () => void) => {
      callback = fn;
      return 1 as unknown;
    };
    const clearTimer = (id: unknown) => {
      if (id === 1) callback = null;
    };
    const t = createRebuildThrottler({ windowMs: 1, run, setTimeout: setTimer, clearTimeout: clearTimer });
    return { t, fire: () => { const cb = callback; callback = null; cb?.(); }, count: () => counter };
  }

  it('冷却窗口内连续 trigger 只触发一次 run', async () => {
    const { t, fire, count } = makeFakeThrottler();
    t.trigger();
    t.trigger();
    t.trigger();
    // 窗口内多次 trigger 合并：定时器被重置，到点只 run 一次
    fire();
    await new Promise((r) => setTimeout(r, 10));
    expect(count()).toBe(1);
  });

  it('窗口结束后再次 trigger 触发新一次 run', async () => {
    const { t, fire, count } = makeFakeThrottler();
    t.trigger();
    fire();
    await new Promise((r) => setTimeout(r, 10));
    t.trigger();
    fire();
    await new Promise((r) => setTimeout(r, 10));
    expect(count()).toBe(2);
  });

  it('run 进行中 trigger 排队补跑（不丢变更）', async () => {
    // 用可控 deferred 让 run 挂起，才能在 run 进行中触发 trigger
    let release!: () => void;
    let counter = 0;
    let callback: (() => void) | null = null;
    const run = async () => {
      counter++;
      await new Promise<void>((r) => { release = r; });
    };
    const setTimer = (fn: () => void) => { callback = fn; return 1 as unknown; };
    const clearTimer = () => { callback = null; };
    const t = createRebuildThrottler({ windowMs: 1, run, setTimeout: setTimer, clearTimeout: clearTimer });

    t.trigger();
    const cb = callback; callback = null; cb?.(); // 到点：开始第一次 run
    await new Promise((r) => setTimeout(r, 5)); // 等 running 置位（microtask）
    t.trigger(); // run 进行中再触发 → 排队
    await new Promise((r) => setTimeout(r, 5));
    expect(counter).toBe(1); // 第一次 run 尚未完成
    release(); // 放行第一次 run
    await new Promise((r) => setTimeout(r, 20)); // 等排队补跑完成
    expect(counter).toBe(2);
  });

  it('flush 立即执行并等待完成', async () => {
    const { t, count } = makeFakeThrottler();
    t.trigger();
    await t.flush();
    expect(count()).toBe(1);
    // flush 后 pending 应清空
    expect(t.pending()).toBe(false);
  });
});