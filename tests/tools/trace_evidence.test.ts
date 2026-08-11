import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { traceReasoning } from '../../src/tools/trace_reasoning';
import {
  resolveTraceEvidence,
  buildTraceResolver,
  loadTraceRecords,
} from '../../src/tools/trace_evidence';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const agentFile = path.join(fixtures, 'agent_demo.mjs');

/** 用真实 fixture 跑一次 traceReasoning，得到真实采集的 trace 记录 */
async function realTrace() {
  const r = await traceReasoning({
    entryFile: agentFile,
    entryFn: 'entry',
    input: '分析依赖',
    feature: 'evidence_test',
  });
  return r.trace;
}

describe('trace_evidence - L4 真实可复算校验', () => {
  it('真实执行过的函数 → 证据通过（存在性）', async () => {
    const records = await realTrace();
    const r = resolveTraceEvidence(records, { type: 'trace', ref: 'validate' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.actual).toBeGreaterThan(0);
  });

  it('编造/未执行的函数 → 打回', async () => {
    const records = await realTrace();
    const r = resolveTraceEvidence(records, { type: 'trace', ref: 'nonexistent_fn' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('无函数');
  });

  it('声明的 token 阈值超过实际 → 复算打回（证据与 trace 不符）', async () => {
    const records = await realTrace();
    const rec = records.find((r) => r.name === 'validate')!;
    // 声称实际 token 超一个大到不可能的值 → 复算不通过
    const r = resolveTraceEvidence(records, {
      type: 'trace',
      ref: `validate@token>${rec.tokens + 9999}`,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('复算失败');
  });

  it('声明的 token 阈值低于实际 → 复算通过', async () => {
    const records = await realTrace();
    const rec = records.find((r) => r.name === 'validate')!;
    const r = resolveTraceEvidence(records, {
      type: 'trace',
      ref: `validate@token>${Math.max(0, rec.tokens - 1)}`,
    });
    expect(r.ok).toBe(true);
  });

  it('非 trace 类型证据 → 打回', async () => {
    const records = await realTrace();
    const r = resolveTraceEvidence(records, { type: 'diff', ref: 'x' });
    expect(r.ok).toBe(false);
  });

  it('buildTraceResolver 暴露真实函数名集合供 L3/L4 复用', async () => {
    const records = await realTrace();
    const res = buildTraceResolver(records);
    expect(res.traceRefs.length).toBeGreaterThan(0);
    // 编造函数不在集合中
    expect(res.traceRefs).not.toContain('ghost_fn');
    // exists 对编造证据返回 false
    expect(res.exists({ type: 'trace', ref: 'ghost_fn' })).toBe(false);
    expect(res.exists({ type: 'trace', ref: 'compose' })).toBe(true);
  });

  it('loadTraceRecords：文件不存在返回空数组（调用方据此判无法回溯）', async () => {
    const records = loadTraceRecords(path.join(fixtures, 'ghost.trace.json'));
    expect(records).toEqual([]);
  });
});