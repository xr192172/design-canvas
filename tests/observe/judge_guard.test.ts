/**
 * Observe 实时判定守卫测试：verify serve 内嵌开关 OBSERVE_GUARD 的行为。
 *
 * 验证点：
 *   1. 默认关闭（OBSERVE_GUARD 未设/非 1）时 judgeGuardLog 是纯 no-op。
 *   2. 开启后，偏差事件打印到 console.error，正常事件不打印。
 *   3. 开启后打印内容包含 rule/probe。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { judgeGuardLog, judgeGuardEnabled } from '../../src/observe/judge_guard.js';

function ev(probe: string, fields: Record<string, unknown>) {
  return { probe, time: '2026-08-14T00:00:00Z', source: 'runtime', fields };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OBSERVE_GUARD;
});

describe('Observe 实时判定守卫 · 开关', () => {
  it('默认关闭：OBSERVE_GUARD 未设置时 judgeGuardEnabled 为 false', () => {
    expect(judgeGuardEnabled()).toBe(false);
  });

  it('OBSERVE_GUARD=1 时开启', () => {
    process.env.OBSERVE_GUARD = '1';
    expect(judgeGuardEnabled()).toBe(true);
  });

  it('OBSERVE_GUARD=0 时关闭', () => {
    process.env.OBSERVE_GUARD = '0';
    expect(judgeGuardEnabled()).toBe(false);
  });
});

describe('Observe 实时判定守卫 · 打印', () => {
  it('关闭时不打印任何偏差', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    judgeGuardLog(ev('save.writefile', { op: 'writefile', err: 'boom' }));
    expect(spy).not.toHaveBeenCalled();
  });

  it('开启后偏差事件打印，含 rule 与 probe', () => {
    process.env.OBSERVE_GUARD = '1';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    judgeGuardLog(ev('save.writefile', { op: 'writefile', err: 'EISDIR' }));
    expect(spy).toHaveBeenCalledTimes(1);
    const text = String(spy.mock.calls[0][0]);
    expect(text).toContain('observe-guard');
    expect(text).toContain('design:silent-error-discard');
    expect(text).toContain('save.writefile');
  });

  it('开启后正常事件（无 err）不打印', () => {
    process.env.OBSERVE_GUARD = '1';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    judgeGuardLog(ev('save.enter', { op: 'enter' }));
    judgeGuardLog(ev('cleanup.rm', { op: 'cleanup', err: 'ENOENT', benign: true }));
    expect(spy).not.toHaveBeenCalled();
  });
});