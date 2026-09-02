/**
 * lifecycle —— 长驻 MCP server 进程级稳定性兜底测试
 *
 * 直接调用 createLifecycleHandlers 的决策手柄（纯逻辑，不依赖 process 事件派发，
 * 避免 process.emit 对 unhandledRejection/uncaughtException 特殊事件的不可靠性）。
 *
 * 覆盖：
 *   - unhandledRejection 默认 keepAlive=true：仅日志、不 exit（长驻 server 不掉线）
 *   - keepAliveOnRejection=false：清理后 exit(1)
 *   - uncaughtException：日志 + 一次清理 + exit(1)
 *   - 信号：优雅清理后 exit(0)；重复触发只清一次（去抖）
 */
import { describe, it, expect } from 'vitest';
import { createLifecycleHandlers } from '../src/lifecycle';

function makeDeps(over: Record<string, unknown> = {}) {
  const logs: string[] = [];
  const exits: number[] = [];
  let cleanupCalls = 0;
  return {
    logs,
    exits,
    cleanupCalls: () => cleanupCalls,
    deps: {
      cleanup: () => { cleanupCalls++; },
      log: (m: string) => logs.push(m),
      exit: (code: number) => exits.push(code),
      ...over,
    },
  };
}

describe('createLifecycleHandlers', () => {
  it('unhandledRejection 默认 keepAlive=true：仅日志、不 exit', () => {
    const { logs, exits, deps } = makeDeps();
    const h = createLifecycleHandlers(deps);
    h.onUnhandledRejection(new Error('boom-async'));
    expect(logs.some((l) => l.includes('unhandledRejection'))).toBe(true);
    expect(exits).toEqual([]); // 长驻 server 不掉线
  });

  it('keepAliveOnRejection=false：清理后 exit(1)', () => {
    const { exits, cleanupCalls, deps } = makeDeps({ keepAliveOnRejection: false });
    const h = createLifecycleHandlers(deps);
    h.onUnhandledRejection(new Error('boom'));
    expect(exits).toEqual([1]);
    expect(cleanupCalls()).toBe(1);
  });

  it('uncaughtException：日志 + 一次清理 + exit(1)', () => {
    const { logs, exits, cleanupCalls, deps } = makeDeps();
    const h = createLifecycleHandlers(deps);
    h.onUncaughtException(new Error('boom-sync'));
    expect(exits).toEqual([1]);
    expect(cleanupCalls()).toBe(1);
    expect(logs.some((l) => l.includes('uncaughtException'))).toBe(true);
  });

  it('信号：优雅清理后 exit(0)，重复触发只清一次', () => {
    const { exits, cleanupCalls, deps } = makeDeps();
    const h = createLifecycleHandlers(deps);
    h.onSignal('SIGTERM');
    h.onSignal('SIGTERM'); // 去抖：清理不再重复（exit 幂等，仍可再退）
    expect(exits[0]).toBe(0);
    expect(cleanupCalls()).toBe(1);
  });

  it('hook 回调在决策时被触发', () => {
    const { deps } = makeDeps();
    let seen = 0;
    const h = createLifecycleHandlers(deps, { onUnhandledRejection: () => seen++ });
    h.onUnhandledRejection(new Error('x'));
    expect(seen).toBe(1);
  });
});