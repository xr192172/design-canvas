/**
 * reason_validator 四层校验测试
 *
 * 覆盖四类输入：
 * - 空格 / 过短 / 空 → 拦截（L1）
 * - 套话 / 占位符（"更新代码""修复bug""优化"）→ 拦截（L2）
 * - 无具体实体（泛泛而谈）→ 拦截（L3）
 * - 编造 evidence（无法回溯）→ 拦截（L4）
 * - 真实理由（含具体实体 + 可回溯证据）→ 放行
 */

import { describe, it, expect } from 'vitest';
import { validateReason } from '../../src/tools/reason_validator';

describe('reason_validator - L1 非空', () => {
  it('空字符串拒绝', () => {
    const r = validateReason({ reason: '' });
    expect(r.ok).toBe(false);
    expect(r.layer).toBe(1);
  });

  it('纯空格拒绝', () => {
    const r = validateReason({ reason: '   ' });
    expect(r.ok).toBe(false);
    expect(r.layer).toBe(1);
  });

  it('过短（有效字符 < 6）拒绝', () => {
    const r = validateReason({ reason: '修复bug' });
    expect(r.ok).toBe(false);
    expect(r.layer).toBe(1);
  });
});

describe('reason_validator - L2 信息量（套话）', () => {
  it('纯套话"更新代码"拒绝', () => {
    const r = validateReason({ reason: '只是更新代码而已' });
    expect(r.ok).toBe(false);
    expect(r.layer).toBe(2);
  });

  it('套话"优化改进调整"拒绝', () => {
    const r = validateReason({ reason: '优化改进调整一下' });
    expect(r.ok).toBe(false);
    expect(r.layer).toBe(2);
  });

  it('含具体信息的句子不误杀（含数字指标）', () => {
    const r = validateReason({ reason: '因为支付超时比较多，把超时时间从 3s 改为 10s' });
    expect(r.ok).toBe(true);
  });
});

describe('reason_validator - L3 实体绑定', () => {
  it('泛泛而谈、无任何实体拒绝', () => {
    const r = validateReason({ reason: '为了让整体结构更清晰可读一些' });
    expect(r.ok).toBe(false);
    expect(r.layer).toBe(3);
  });

  it('含文件路径（diff 文件名）通过', () => {
    const r = validateReason({ reason: '重构 service/user.go 的鉴权逻辑，改成中间件' });
    expect(r.ok).toBe(true);
  });

  it('含数字指标通过', () => {
    const r = validateReason({ reason: '把 token 上限从 1200 提到 4000 以容纳更多上下文' });
    expect(r.ok).toBe(true);
  });

  it('绑定已知节点 id 通过', () => {
    const r = validateReason({
      reason: '把节点 checkout 的职责拆成独立服务，降低耦合',
      resolver: { entityIds: ['checkout'] },
    });
    expect(r.ok).toBe(true);
  });
});

describe('reason_validator - L4 证据回溯', () => {
  it('提供的 evidence 无法回溯时打回', () => {
    const r = validateReason({
      reason: '根据 trace 记录，checkout 节点 token 超限，需要折叠',
      evidence: [{ type: 'trace', ref: 'trace_missing_node' }],
      resolver: { entityIds: ['checkout'], exists: () => false },
    });
    expect(r.ok).toBe(false);
    expect(r.layer).toBe(4);
  });

  it('提供了 evidence 但无解析器时打回', () => {
    const r = validateReason({
      reason: '根据 trace 记录，checkout 节点 token 超限，需要折叠',
      evidence: [{ type: 'trace', ref: 'trace_x' }],
    });
    expect(r.ok).toBe(false);
    expect(r.layer).toBe(4);
  });

  it('evidence 全部可回溯时放行', () => {
    const r = validateReason({
      reason: '根据 trace 记录，checkout 节点 token 超限到 4000，需要折叠上下文',
      evidence: [{ type: 'trace', ref: 'trace_ok' }],
      resolver: { entityIds: ['checkout'], exists: () => true },
    });
    expect(r.ok).toBe(true);
  });
});

describe('reason_validator - 真实理由整体放行', () => {
  it('含实体 + 具体动机 + 可控证据的完整理由通过', () => {
    const r = validateReason({
      reason: '网关峰值延迟导致支付超时，把 user.go 的超时阈值从 3s 放宽到 10s',
      evidence: [{ type: 'diff', ref: 'user.go' }],
      resolver: { entityIds: ['user.go'], exists: (ev) => ev.ref === 'user.go' },
    });
    expect(r.ok).toBe(true);
  });
});