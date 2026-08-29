/**
 * inject_replay（D3 注入回放）测试
 *
 * 蓝本：预算检查流 flow_budget_check（原 conveyor 示例，已下线）
 *  - handler.errors: ErrBudgetExceeded(expected→draft_zone) / panic(unexpected→compose)
 *  - branches: 超80%预算→section_queue(红) / else→current_round(绿)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { clearAllFeatures, saveDSL, getDSL, getLiveDslFile } from '../../src/storage.js';
import { injectReplay } from '../../src/tools/inject_replay.js';
import { updateNode } from '../../src/tools/node_ops.js';
import type { DesignDSL } from '../../src/dsl/types.js';

function setupFixture(): void {
  const dsl: DesignDSL = {
    feature: 'f_replay',
    title: '注入回放测试',
    geometry: {
      nodes: [
        { id: 'compose', x: 0, y: 0, label: 'Compose' },
        { id: 'draft_zone', x: 0, y: 100, label: '草稿清理区', layer: 'error', host: 'compose' },
        { id: 'section_queue', x: 200, y: 0, label: 'Section 队列' },
        { id: 'current_round', x: 400, y: 0, label: '当前轮' },
      ],
      edges: [],
    },
    animations_v2: {
      version: 2,
      flows: [
        {
          id: 'flow_budget',
          trigger: { type: 'state_change', watch: 'sections' },
          from: 'compose',
          handler: {
            file_id: 'compose',
            api: 'Compose',
            input_mapping: { budget: '$value.tokenBudget' },
            errors: [
              {
                type: 'ErrBudgetExceeded',
                condition: "result.error && result.error.code === 'BUDGET_EXCEEDED'",
                severity: 'expected',
                to: 'draft_zone',
                log: 'Compose: 预算超限，走草稿清理路径',
              },
              {
                type: 'panic',
                condition: 'result.panic === true',
                severity: 'unexpected',
                to: 'compose',
                log: 'CRITICAL: Compose panicked — 潜在 bug',
              },
            ],
          },
          branches: [
            {
              condition:
                'Array.isArray(value.sections) && value.sections.reduce(function(sum, s){ return sum + (s.tokens || 0); }, 0) > (value.tokenBudget || 128000) * 0.8',
              to: 'section_queue',
              effect: 'particle_red',
            },
            {
              condition: 'else',
              to: 'current_round',
              effect: 'particle_green',
            },
          ],
        },
        {
          id: 'flow_plain',
          trigger: { type: 'periodic', interval: 1000 },
          from: 'compose',
          to: 'current_round',
        },
      ],
    },
  };
  saveDSL(dsl);
}

beforeEach(() => {
  clearAllFeatures();
  const live = getLiveDslFile();
  if (fs.existsSync(live)) fs.unlinkSync(live);
});
afterEach(() => {
  clearAllFeatures();
  const live = getLiveDslFile();
  if (fs.existsSync(live)) fs.unlinkSync(live);
});

describe('inject_replay - 异常路径', () => {
  it('已声明异常（BUDGET_EXCEEDED）→ declared + 流向声明节点', () => {
    setupFixture();
    const r = injectReplay({
      feature: 'f_replay',
      flow_id: 'flow_budget',
      inject: { error: { code: 'BUDGET_EXCEEDED', message: 'token 预算超限' } },
    });
    expect(r.classification).toBe('declared');
    expect(r.route.kind).toBe('error');
    expect(r.route.to).toBe('draft_zone');
    expect(r.route.severity).toBe('expected');
    expect(r.route.error_type).toBe('ErrBudgetExceeded');
    expect(r.message).toContain('预算超限');
  });

  it('未声明异常（NETWORK_TIMEOUT）→ undeclared + bug 警报', () => {
    setupFixture();
    const r = injectReplay({
      feature: 'f_replay',
      flow_id: 'flow_budget',
      inject: { error: { code: 'NETWORK_TIMEOUT', message: '检索超时' } },
    });
    expect(r.classification).toBe('undeclared');
    expect(r.message).toContain('未声明异常');
    expect(r.message).toContain('NETWORK_TIMEOUT');
  });

  it('panic → declared unexpected', () => {
    setupFixture();
    const r = injectReplay({
      feature: 'f_replay',
      flow_id: 'flow_budget',
      inject: { panic: true, message: 'nil pointer dereference' },
    });
    expect(r.classification).toBe('declared');
    expect(r.route.severity).toBe('unexpected');
    expect(r.route.to).toBe('compose');
    expect(r.message).toContain('panic');
  });
});

describe('inject_replay - 正常路径分支求值', () => {
  it('正常值 + 预算内 value → else 分支（current_round）', () => {
    setupFixture();
    const r = injectReplay({
      feature: 'f_replay',
      flow_id: 'flow_budget',
      inject: { compose: 'ok', tokens: 1200 },
      value: { sections: [{ tokens: 100 }], tokenBudget: 128000 },
    });
    expect(r.classification).toBe('none');
    expect(r.route.kind).toBe('branch');
    expect(r.route.to).toBe('current_round');
  });

  it('正常值 + 超 80% 预算 value → 第一分支（section_queue）', () => {
    setupFixture();
    const r = injectReplay({
      feature: 'f_replay',
      flow_id: 'flow_budget',
      inject: { compose: 'ok', tokens: 1200 },
      value: { sections: [{ tokens: 110000 }], tokenBudget: 128000 },
    });
    expect(r.classification).toBe('none');
    expect(r.route.kind).toBe('branch');
    expect(r.route.to).toBe('section_queue');
  });

  it('无 branches 的 flow → direct 流向 flow.to', () => {
    setupFixture();
    const r = injectReplay({
      feature: 'f_replay',
      flow_id: 'flow_plain',
      inject: { compose: 'ok' },
    });
    expect(r.classification).toBe('none');
    expect(r.route.kind).toBe('direct');
    expect(r.route.to).toBe('current_round');
  });
});

describe('inject_replay - 预设异常场景', () => {
  it('list_presets 列出 errors 声明', () => {
    setupFixture();
    const r = injectReplay({ feature: 'f_replay', flow_id: 'flow_budget', list_presets: true });
    expect(r.presets).toEqual(['ErrBudgetExceeded', 'panic']);
    expect(r.message).toContain('ErrBudgetExceeded');
  });

  it('preset=ErrBudgetExceeded 自动构造注入值并命中声明', () => {
    setupFixture();
    const r = injectReplay({ feature: 'f_replay', flow_id: 'flow_budget', preset: 'ErrBudgetExceeded' });
    expect(r.classification).toBe('declared');
    expect(r.route.to).toBe('draft_zone');
    expect(r.route.error_type).toBe('ErrBudgetExceeded');
  });

  it('preset=panic 自动构造 {panic:true}', () => {
    setupFixture();
    const r = injectReplay({ feature: 'f_replay', flow_id: 'flow_budget', preset: 'panic' });
    expect(r.classification).toBe('declared');
    expect(r.route.severity).toBe('unexpected');
  });

  it('preset 不存在 → 报错并列出可用预设', () => {
    setupFixture();
    expect(() =>
      injectReplay({ feature: 'f_replay', flow_id: 'flow_budget', preset: 'NoSuchError' }),
    ).toThrow(/NoSuchError.*ErrBudgetExceeded/s);
  });

  it('condition 为 message 子串匹配（indexOf）时，preset 构造 message 含字面量的值', () => {
    // 真实工程教训（ai-base decision_splitter）：condition 检查 message 包含子串，
    // 字面量进 code 字段的值永远命中不了
    setupFixture();
    const dsl = getDSL('f_replay')!;
    dsl.animations_v2!.flows![0].handler!.errors = [
      {
        type: 'ErrLLMCallFailed',
        condition: "result.error && String(result.error.message).indexOf('LLM call failed') >= 0",
        severity: 'expected',
        to: 'draft_zone',
      },
    ];
    saveDSL(dsl);
    const r = injectReplay({ feature: 'f_replay', flow_id: 'flow_budget', preset: 'ErrLLMCallFailed' });
    expect(r.classification).toBe('declared');
    expect(r.route.error_type).toBe('ErrLLMCallFailed');
  });

  it('condition 为裸字符串比较（result.error === "EOF"）时，preset 构造 error 为字面量字符串', () => {
    setupFixture();
    const dsl = getDSL('f_replay')!;
    dsl.animations_v2!.flows![0].handler!.errors = [
      {
        type: 'ErrEOF',
        condition: "result.error === 'EOF'",
        severity: 'expected',
        to: 'draft_zone',
      },
    ];
    saveDSL(dsl);
    const r = injectReplay({ feature: 'f_replay', flow_id: 'flow_budget', preset: 'ErrEOF' });
    expect(r.classification).toBe('declared');
    expect(r.route.error_type).toBe('ErrEOF');
  });
});

describe('inject_replay - 形状质检（shapes.out vs 注入值）', () => {
  it('注入值满足 shapes.out → 校验通过', () => {
    setupFixture();
    updateNode({
      feature: 'f_replay',
      node_id: 'compose',
      shapes: {
        out: {
          type: 'object',
          properties: { compose: { type: 'string' }, tokens: { type: 'integer' } },
          required: ['compose'],
        },
      },
    });
    const r = injectReplay({
      feature: 'f_replay',
      flow_id: 'flow_budget',
      inject: { compose: 'ok', tokens: 1200 },
      value: { sections: [] },
    });
    expect(r.shape_check).toBeDefined();
    expect(r.shape_check!.valid).toBe(true);
    expect(r.message).toContain('形状校验通过');
  });

  it('注入值违例（tokens 应为 integer 给了 string）→ 报告违例字段', () => {
    setupFixture();
    updateNode({
      feature: 'f_replay',
      node_id: 'compose',
      shapes: {
        out: {
          type: 'object',
          properties: { compose: { type: 'string' }, tokens: { type: 'integer' } },
          required: ['compose'],
        },
      },
    });
    const r = injectReplay({
      feature: 'f_replay',
      flow_id: 'flow_budget',
      inject: { compose: 'ok', tokens: '1200' },
      value: { sections: [] },
    });
    expect(r.shape_check).toBeDefined();
    expect(r.shape_check!.valid).toBe(false);
    expect(r.shape_check!.violations.length).toBeGreaterThan(0);
    expect(r.message).toContain('tokens');
  });

  it('节点无 shapes → 跳过校验', () => {
    setupFixture();
    const r = injectReplay({
      feature: 'f_replay',
      flow_id: 'flow_budget',
      inject: { compose: 'ok' },
      value: { sections: [] },
    });
    expect(r.shape_check).toBeUndefined();
  });
});

describe('inject_replay - 错误处理', () => {
  it('flow_id 不存在 → 报错并列出可用 flow', () => {
    setupFixture();
    expect(() => injectReplay({ feature: 'f_replay', flow_id: 'nope', inject: {} })).toThrow(
      /nope.*flow_budget/s,
    );
  });

  it('inject 与 preset 都缺 → 报错', () => {
    setupFixture();
    expect(() => injectReplay({ feature: 'f_replay', flow_id: 'flow_budget' })).toThrow(
      /inject|preset/,
    );
  });

  it('feature 不存在 → 报错', () => {
    expect(() => injectReplay({ feature: 'ghost', flow_id: 'x', inject: {} })).toThrow(/ghost/);
  });
});
