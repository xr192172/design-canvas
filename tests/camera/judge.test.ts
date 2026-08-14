import { describe, it, expect } from 'vitest';
import { silentErrorDiscard, judgeEvent } from '../../src/camera/judge.js';
import type { TSEvent } from '../../src/camera/probe.js';

function ev(over: Partial<TSEvent> = {}): TSEvent {
  return { probe: 'save.writefile', time: '2026-08-14T00:00:00Z', source: 'static-rule', fields: {}, ...over };
}

describe('Camera 即时判定器 · silent-error-discard', () => {
  it('err 为空 → ok', () => {
    const v = silentErrorDiscard(ev({ fields: { op: 'writefile', err: '' } }));
    expect(v.result).toBe('ok');
  });

  it('writefile 非良性 err → deviation', () => {
    const v = silentErrorDiscard(ev({ fields: { op: 'writefile', err: 'EISDIR: illegal operation' } }));
    expect(v.result).toBe('deviation');
    expect(v.rule).toBe('design:silent-error-discard');
    expect(v.reason).toContain('writefile');
  });

  it('cleanup 且 benign=true → ok', () => {
    const v = silentErrorDiscard(ev({ probe: 'cleanup.rm', fields: { op: 'cleanup', err: 'ENOENT', benign: true } }));
    expect(v.result).toBe('ok');
  });

  it('cleanup 但 non-benign → deviation', () => {
    const v = silentErrorDiscard(ev({ probe: 'cleanup.rm', fields: { op: 'cleanup', err: 'EPERM', benign: false } }));
    expect(v.result).toBe('deviation');
  });
});

describe('Camera 即时判定器 · judgeEvent', () => {
  it('多条规则，首条命中偏差即返回', () => {
    const v = judgeEvent(ev({ fields: { op: 'writefile', err: 'boom' } }));
    expect(v.result).toBe('deviation');
    expect(v.rule).toBe('design:silent-error-discard');
  });

  it('无偏差 → ok', () => {
    const v = judgeEvent(ev({ fields: { op: 'writefile', err: '' } }));
    expect(v.result).toBe('ok');
  });
});