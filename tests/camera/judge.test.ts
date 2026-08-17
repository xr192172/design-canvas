import { describe, it, expect } from 'vitest';
import { silentErrorDiscard, judgeEvent, impactBlastRadius, IMPACT_BLAST_RADIUS_LIMIT, impactUnplannedSpread } from '../../src/camera/judge.js';
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

describe('Camera 即时判定器 · impact-blast-radius（Step 3 合流）', () => {
  it('非 impact 探针 → ok（不干扰既有规则）', () => {
    const v = impactBlastRadius(ev({ fields: { op: 'writefile', err: '' } }));
    expect(v.result).toBe('ok');
    expect(v.reason).toContain('not an impact event');
  });

  it('impact 事件波及在阈值内 → ok', () => {
    const v = impactBlastRadius(
      ev({ probe: 'impact.report', fields: { err: '', direct_files: 1, indirect_files: 21 } }),
    );
    expect(v.result).toBe('ok');
    expect(v.reason).toContain('within threshold');
  });

  it('impact 事件波及超默认阈值 → deviation（含拆分建议）', () => {
    const v = impactBlastRadius(
      ev({ probe: 'impact.report', fields: { err: '', direct_files: 3, indirect_files: IMPACT_BLAST_RADIUS_LIMIT } }),
    );
    expect(v.result).toBe('deviation');
    expect(v.rule).toBe('design:impact-blast-radius');
    expect(v.reason).toContain('blast radius');
    expect(v.reason).toContain('consider splitting');
  });

  it('fields.threshold 可覆盖默认阈值', () => {
    // 2+3=5 > 默认 50 不超；threshold=4 时 5 > 4 → deviation
    const within = impactBlastRadius(
      ev({ probe: 'impact.report', fields: { err: '', direct_files: 2, indirect_files: 3 } }),
    );
    expect(within.result).toBe('ok');
    const over = impactBlastRadius(
      ev({ probe: 'impact.report', fields: { err: '', direct_files: 2, indirect_files: 3, threshold: 4 } }),
    );
    expect(over.result).toBe('deviation');
    expect(over.reason).toContain('threshold 4');
  });

  it('judgeEvent 默认规则含 impact 谓词：radius 超限的 impact 事件判 deviation', () => {
    const v = judgeEvent(
      ev({
        probe: 'impact.report',
        fields: { err: '', op: 'impact-report', direct_files: 10, indirect_files: 100 },
      }),
    );
    expect(v.result).toBe('deviation');
    expect(v.rule).toBe('design:impact-blast-radius');
  });

  it('judgeEvent：impact 事件带 err → silentErrorDiscard 先命中（生成失败即报警）', () => {
    const v = judgeEvent(
      ev({ probe: 'impact.report', fields: { op: 'impact-report', err: 'cache.db missing' } }),
    );
    expect(v.result).toBe('deviation');
    expect(v.rule).toBe('design:silent-error-discard');
  });

  it('judgeEvent：普通事件行为不变（默认规则追加后零回归）', () => {
    expect(judgeEvent(ev({ fields: { op: 'writefile', err: 'x' } })).rule).toBe('design:silent-error-discard');
    expect(judgeEvent(ev({ fields: { op: 'writefile', err: '' } })).result).toBe('ok');
  });
});

describe('Camera 即时判定器 · impact-unplanned-spread（Impact Ledger）', () => {
  it('非 spread 探针 → ok（不干扰既有规则）', () => {
    const v = impactUnplannedSpread(ev({ fields: { op: 'writefile', err: '' } }));
    expect(v.result).toBe('ok');
    expect(v.reason).toContain('not a spread event');
  });

  it('spread 事件无未预告文件 → ok（波及在预告面内）', () => {
    const v = impactUnplannedSpread(
      ev({ probe: 'impact.spread', fields: { err: '', expected_count: 3, actual_count: 3, unexpected_files: [] } }),
    );
    expect(v.result).toBe('ok');
    expect(v.reason).toContain('within declared preview');
  });

  it('spread 事件有未预告文件 → deviation（列出越界文件）', () => {
    const v = impactUnplannedSpread(
      ev({ probe: 'impact.spread', fields: { err: '', expected_count: 3, actual_count: 4, unexpected_files: ['src/d.ts'] } }),
    );
    expect(v.result).toBe('deviation');
    expect(v.rule).toBe('design:impact-unplanned-spread');
    expect(v.reason).toContain('src/d.ts');
    expect(v.reason).toContain('unplanned spread');
  });

  it('judgeEvent 默认规则含 spread 谓词：未预告波及判 deviation', () => {
    const v = judgeEvent(
      ev({ probe: 'impact.spread', fields: { err: '', op: 'impact-ledger', expected_count: 2, actual_count: 3, unexpected_files: ['x/y.ts'] } }),
    );
    expect(v.result).toBe('deviation');
    expect(v.rule).toBe('design:impact-unplanned-spread');
  });
});