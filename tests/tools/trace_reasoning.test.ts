import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { traceReasoning } from '../../src/tools/trace_reasoning';
import { validateDSL } from '../../src/dsl/validator';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const agentFile = path.join(fixtures, 'agent_demo.mjs');

describe('traceReasoning - 零接触自动插桩', () => {
  it('真实执行自动产出可校验的 reasoning DSL', async () => {
    const result = await traceReasoning({
      entryFile: agentFile,
      entryFn: 'entry',
      input: '分析依赖',
      budget: { max_tokens: 8000, fold_at: 0.8 },
      feature: 'agent_trace_test',
    });
    // 产出可校验的完整 DSL
    const v = validateDSL(result.dsl);
    expect(v.valid).toBe(true);
    // 入口函数被追踪
    expect(result.dsl.reasoning?.entry.label).toContain('分析依赖');
    // 类方法链被拦截（内部 this.method() 调用被记录）
    const names = result.trace.map((r) => r.name);
    expect(names).toContain('process');
    expect(names).toContain('validate');
    expect(names).toContain('retrieve');
    expect(names).toContain('compose');
    // reasoning.steps 与链上函数一一对应
    expect((result.dsl.reasoning?.steps ?? []).length).toBeGreaterThanOrEqual(4);
    // 每个 step 引用真实存在的 geometry 节点
    const nodeIds = new Set(result.dsl.geometry.nodes.map((n) => n.id));
    for (const s of result.dsl.reasoning?.steps ?? []) {
      expect(nodeIds.has(s.node)).toBe(true);
    }
    // api 绑定真实函数名
    const apis = (result.dsl.reasoning?.steps ?? []).map((s) => s.api);
    expect(apis).toContain('compose');
  });

  it('token 超预算时自动生成折叠点', async () => {
    // 极小预算确保触发折叠
    const result = await traceReasoning({
      entryFile: agentFile,
      entryFn: 'entry',
      input: 'x',
      budget: { max_tokens: 40, fold_at: 0.5 }, // 阈值 20 token，链上累计 ~42，极小预算必触发折叠
    });
    const folds = result.dsl.reasoning?.folds ?? [];
    expect(folds.length).toBeGreaterThan(0);
    // 折叠的 folded 必须引用存在的 step id
    const stepIds = new Set((result.dsl.reasoning?.steps ?? []).map((s) => s.id));
    for (const f of folds) {
      for (const sid of f.folded) expect(stepIds.has(sid)).toBe(true);
      expect(f.summary).toContain('折叠');
    }
  });

  it('入口函数缺失报错', async () => {
    await expect(
      traceReasoning({ entryFile: agentFile, entryFn: 'no_such_fn', input: 'x' }),
    ).rejects.toThrow(/入口函数/);
  });

  it('文件不存在报错', async () => {
    await expect(
      traceReasoning({ entryFile: path.join(fixtures, 'ghost.mjs') }),
    ).rejects.toThrow(/不存在/);
  });
});