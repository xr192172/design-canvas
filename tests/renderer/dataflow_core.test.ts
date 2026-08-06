/**
 * 数据流追踪核心逻辑测试（L5a 静态推演）
 *
 * 覆盖：
 * - mockValue：各类型 schema → 示例值（string/number/integer/boolean/array/object/null）
 * - buildDataTrace：detail 子图（链边 + 跳边）→ 步骤序列 + in/out 值传递 + 分流标注
 * - 无调用链 / 环路防御
 */

import { describe, it, expect } from 'vitest';
import {
  mockValue,
  buildDataTrace,
  collectJudgements,
  flattenScope,
  evaluateCond,
  applyJudgements,
} from '../../src/renderer/dataflow_core';

// ─────────────────────────────────────────────────────────────
// mockValue
// ─────────────────────────────────────────────────────────────

describe('mockValue - schema → 示例值', () => {
  it('基本类型', () => {
    expect(mockValue({ type: 'string' })).toBe('示例文本');
    expect(mockValue({ type: 'string', label: '令牌' })).toBe('示例令牌');
    expect(mockValue({ type: 'number' })).toBe(42.5);
    expect(mockValue({ type: 'integer' })).toBe(7);
    expect(mockValue({ type: 'boolean' })).toBe(true);
    expect(mockValue({ type: 'null' })).toBeNull();
  });

  it('array：递归生成两个示例项', () => {
    expect(mockValue({ type: 'array', items: { type: 'integer' } })).toEqual([7, 7]);
    expect(mockValue({ type: 'array' })).toEqual([null, null]);
  });

  it('object：properties 逐字段递归', () => {
    const v = mockValue({
      type: 'object',
      properties: { id: { type: 'integer' }, name: { type: 'string' } },
    });
    expect(v).toEqual({ id: 7, name: '示例文本' });
  });

  it('object 无 properties：label 兜底', () => {
    expect(mockValue({ type: 'object', label: 'Composition' })).toEqual({ Composition: '值' });
    expect(mockValue({ type: 'object' })).toEqual({ 示例: '值' });
  });

  it('非法/缺省 → null', () => {
    expect(mockValue(null)).toBeNull();
    expect(mockValue(undefined)).toBeNull();
    expect(mockValue({ type: 'unknown_xyz' })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// buildDataTrace
// ─────────────────────────────────────────────────────────────

function fixtureNodes() {
  return [
    {
      id: 'host__s1_Entry',
      label: '① Entry',
      layer: 'detail',
      host: 'host',
      shapes: {
        in: { type: 'object', properties: { token: { type: 'string' } } },
        out: { type: 'string' },
      },
    },
    {
      id: 'host__s2_stepA',
      label: '② stepA',
      layer: 'detail',
      host: 'host',
      shapes: { in: { type: 'string' }, out: { type: 'integer' } },
    },
    {
      id: 'host__s3_stepB',
      label: '③ stepB',
      layer: 'detail',
      host: 'host',
      shapes: { in: { type: 'integer' }, out: { type: 'boolean' } },
    },
  ];
}

function fixtureEdges() {
  return [
    { id: 'host__chain_1', from: 'host__s1_Entry', to: 'host__s2_stepA' },
    { id: 'host__chain_2', from: 'host__s2_stepA', to: 'host__s3_stepB' },
    { id: 'host__branch_j1', from: 'host__s1_Entry', to: 'host__s3_stepB', label: '分支', type: 'dashed' },
  ];
}

// ─────────────────────────────────────────────────────────────
// collectJudgements - CFG 判定提取
// ─────────────────────────────────────────────────────────────

function cfgFixture() {
  const nodes = [
    { id: 'host__alg_n1', label: '▶ Compose', style: { shape: 'circle' }, description: 'entry · 源码第 1 行' },
    { id: 'host__alg_n2', label: '检查预算', style: { shape: 'diamond' }, description: 'branch · 源码第 8 行\n条件：over == true' },
    { id: 'host__alg_n3', label: '返回错误', style: { shape: 'rounded' } },
    { id: 'host__alg_n4', label: '组装', style: { shape: 'rounded' } },
    { id: 'host__alg_n5', label: '遍历 sections', style: { shape: 'hexagon' }, description: 'loop · 源码第 12 行\n条件：i < len(sections)' },
    { id: 'host__alg_n6', label: '结束', style: { shape: 'circle' } },
  ];
  const edges = [
    { id: 'host__alge_0', from: 'host__alg_n1', to: 'host__alg_n2' },
    { id: 'host__alge_1', from: 'host__alg_n2', to: 'host__alg_n3', label: '是' },
    { id: 'host__alge_2', from: 'host__alg_n2', to: 'host__alg_n4', label: '否' },
    { id: 'host__alge_3', from: 'host__alg_n4', to: 'host__alg_n5' },
    { id: 'host__alge_4', from: 'host__alg_n5', to: 'host__alg_n6', label: '重复' },
  ];
  return { nodes, edges };
}

describe('collectJudgements - CFG 判定精确化', () => {
  it('按 entry ▶函数名 关联，收集 branch/loop 的条件与走向', () => {
    const { nodes, edges } = cfgFixture();
    const js = collectJudgements(nodes, edges, 'host', 'Compose');

    expect(js).toHaveLength(2);
    // branch：条件原文 + 是/否走向
    expect(js[0].cond).toBe('over == true');
    expect(js[0].branches).toEqual([
      { via: '是', to: '返回错误' },
      { via: '否', to: '组装' },
    ]);
    // loop：嵌套判定也收集（BFS 深入）
    expect(js[1].cond).toBe('i < len(sections)');
    expect(js[1].branches[0].via).toBe('重复');
  });

  it('无 CFG（宿主无 __alg_ 节点）→ 空', () => {
    expect(collectJudgements([], [], 'host', 'Compose')).toEqual([]);
    expect(collectJudgements(cfgFixture().nodes, [], 'host', 'Compose')).toEqual([]);
  });

  it('entry 不存在（函数名不匹配）→ 空', () => {
    const { nodes, edges } = cfgFixture();
    expect(collectJudgements(nodes, edges, 'host', 'Ghost')).toEqual([]);
  });

  it('无 host/funcName → 空', () => {
    const { nodes, edges } = cfgFixture();
    expect(collectJudgements(nodes, edges, '', 'Compose')).toEqual([]);
    expect(collectJudgements(nodes, edges, 'host', '')).toEqual([]);
  });

  it('跨文件追加前缀（{host}__sx1_{fn}__alg_）也能收集判定', () => {
    // derive_chain 跨文件追加：外部函数 detail 节点 id {host}__sx1_OtherFn，
    // 其 CFG 节点 id {host}__sx1_OtherFn__alg_*（含 __alg_ → 放宽后统一识别）
    const nodes = [
      { id: 'host__sx1_OtherFn__alg_e1', label: '▶ OtherFn', style: { shape: 'circle' } },
      { id: 'host__sx1_OtherFn__alg_b1', label: '数量判断', style: { shape: 'diamond' }, description: 'branch\n条件：config.count > 3' },
      { id: 'host__sx1_OtherFn__alg_r1', label: '返回真', style: { shape: 'rounded' } },
      { id: 'host__sx1_OtherFn__alg_r2', label: '返回假', style: { shape: 'rounded' } },
    ];
    const edges = [
      { id: 'host__sx1_OtherFn__alge_0', from: 'host__sx1_OtherFn__alg_e1', to: 'host__sx1_OtherFn__alg_b1' },
      { id: 'host__sx1_OtherFn__alge_1', from: 'host__sx1_OtherFn__alg_b1', to: 'host__sx1_OtherFn__alg_r1', label: '是' },
      { id: 'host__sx1_OtherFn__alge_2', from: 'host__sx1_OtherFn__alg_b1', to: 'host__sx1_OtherFn__alg_r2', label: '否' },
    ];
    const js = collectJudgements(nodes, edges, 'host', 'OtherFn');
    expect(js).toHaveLength(1);
    expect(js[0].cond).toBe('config.count > 3');
    expect(js[0].branches).toEqual([
      { via: '是', to: '返回真' },
      { via: '否', to: '返回假' },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────
// buildDataTrace
// ─────────────────────────────────────────────────────────────

describe('buildDataTrace - 沿调用链推演', () => {
  it('链式传递：上一步 out → 下一步 in；跳边标注分流', () => {
    const trace = buildDataTrace(fixtureNodes(), fixtureEdges(), 'host__s1_Entry', { token: 'abc' });

    expect(trace.steps.map((s) => s.nodeId)).toEqual(['host__s1_Entry', 'host__s2_stepA', 'host__s3_stepB']);
    // 第一步：用户注入值 → 入口 in；out = mock(shapes.out=string)
    expect(trace.steps[0].inValue).toEqual({ token: 'abc' });
    expect(trace.steps[0].outValue).toBe('示例文本');
    // 分流标注：Entry 有跳边 → stepB
    expect(trace.steps[0].note).toContain('数据分流');
    expect(trace.steps[0].note).toContain('stepB');
    // 第二步：in = 上一步 out；out = mock(integer)
    expect(trace.steps[1].inValue).toBe('示例文本');
    expect(trace.steps[1].outValue).toBe(7);
    // 第三步
    expect(trace.steps[2].inValue).toBe(7);
    expect(trace.steps[2].outValue).toBe(true);
    // 跳边高亮列表
    expect(trace.branchEdgeIds).toEqual(['host__branch_j1']);
  });

  it('节点无 shapes.out → out 继承 in（透传）', () => {
    const nodes = [
      { id: 'h__s1_A', label: 'A', layer: 'detail', host: 'h' },
      { id: 'h__s2_B', label: 'B', layer: 'detail', host: 'h', shapes: { out: { type: 'integer' } } },
    ];
    const edges = [{ id: 'h__chain_1', from: 'h__s1_A', to: 'h__s2_B' }];
    const trace = buildDataTrace(nodes, edges, 'h__s1_A', 99);
    expect(trace.steps[0].outValue).toBe(99); // 无 out schema → 继承 in
    expect(trace.steps[1].inValue).toBe(99);
    expect(trace.steps[1].outValue).toBe(7);
  });

  it('入口不存在 → 空轨迹', () => {
    expect(buildDataTrace(fixtureNodes(), fixtureEdges(), 'ghost', 1).steps).toEqual([]);
  });

  it('无调用链（单节点无链边）→ 只含入口一步', () => {
    const nodes = [{ id: 'h__s1_A', label: 'A', layer: 'detail', host: 'h' }];
    const trace = buildDataTrace(nodes, [], 'h__s1_A', { x: 1 });
    expect(trace.steps).toHaveLength(1);
    expect(trace.branchEdgeIds).toEqual([]);
  });

  it('环路防御：异常数据不死循环', () => {
    // 人为构造环（derive 正常不会生成，防御测试）
    const nodes = [
      { id: 'h__s1_A', label: 'A', layer: 'detail', host: 'h' },
      { id: 'h__s2_B', label: 'B', layer: 'detail', host: 'h' },
    ];
    const edges = [
      { id: 'h__chain_1', from: 'h__s1_A', to: 'h__s2_B' },
      { id: 'h__chain_2', from: 'h__s2_B', to: 'h__s1_A' },
    ];
    const trace = buildDataTrace(nodes, edges, 'h__s1_A', 1);
    expect(trace.steps).toHaveLength(2); // A → B 后终止（visited）
  });

  it('main 层节点无 detail 链 → 只有入口一步（无链可追）', () => {
    const nodes = [
      { id: 'n1', label: 'N1' },
      { id: 'n2', label: 'N2' },
    ];
    const edges = [{ id: 'e1', from: 'n1', to: 'n2' }];
    const trace = buildDataTrace(nodes, edges, 'n1', 1);
    expect(trace.steps).toHaveLength(1);
    expect(trace.steps[0].nodeId).toBe('n1');
    expect(trace.branchEdgeIds).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// 判定走向选择：flattenScope / evaluateCond / applyJudgements
// ─────────────────────────────────────────────────────────────

describe('flattenScope - 注入值 → 变量查找表', () => {
  it('顶层 key + 一层嵌套展开（不覆盖顶层）', () => {
    const scope = flattenScope({ input: { token: 'abc', len: 3 }, flag: true });
    expect(scope.flag).toBe(true);
    expect(scope.token).toBe('abc');
    expect(scope.len).toBe(3);
    // 嵌套展开不覆盖已有顶层 key
    expect(flattenScope({ input: { input: 'nested' } }).input).toEqual({ input: 'nested' });
  });

  it('非对象（标量/数组/null）→ 空 scope', () => {
    expect(flattenScope(42)).toEqual({});
    expect(flattenScope(null)).toEqual({});
    expect(flattenScope([1, 2])).toEqual({});
  });
});

describe('evaluateCond - 轻量表达式求值', () => {
  it('布尔比较：over == true', () => {
    expect(evaluateCond('over == true', { over: true })).toEqual({ ok: true, value: true });
    expect(evaluateCond('over == true', { over: false }).value).toBe(false);
  });

  it('成员访问：token.length > 3（字符串 length）', () => {
    expect(evaluateCond('token.length > 3', { token: 'abcd' })).toEqual({ ok: true, value: true });
    expect(evaluateCond('token.length > 3', { token: 'ab' }).value).toBe(false);
  });

  it('字符串字面量 + 严格相等', () => {
    expect(evaluateCond("name === 'Composition'", { name: 'Composition' })).toEqual({ ok: true, value: true });
    expect(evaluateCond("name !== 'x'", { name: 'y' })).toEqual({ ok: true, value: true });
  });

  it('逻辑组合 + 括号 + 四则', () => {
    expect(evaluateCond('a > 1 && b < 5', { a: 2, b: 3 })).toEqual({ ok: true, value: true });
    expect(evaluateCond('a > 1 && b < 5', { a: 2, b: 9 }).value).toBe(false);
    expect(evaluateCond('(a + b) * 2 === 10', { a: 3, b: 2 })).toEqual({ ok: true, value: true });
    expect(evaluateCond('!flag', { flag: false })).toEqual({ ok: true, value: true });
  });

  it('未匹配变量 → ok:false + 报错变量名', () => {
    const r = evaluateCond('token.length > 3', {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain('未匹配变量：token');
  });

  it('方法调用（includes/startsWith）+ 三元 + 可选链', () => {
    expect(evaluateCond("tags.includes('hot')", { tags: ['hot', 'new'] })).toEqual({ ok: true, value: true });
    expect(evaluateCond("str.startsWith('示例')", { str: '示例文本' })).toEqual({ ok: true, value: true });
    expect(evaluateCond("a > 1 ? 'x' : 'y'", { a: 2 }).value).toBe('x');
    expect(evaluateCond("cfg?.mode === 'fast'", { cfg: { mode: 'fast' } })).toEqual({ ok: true, value: true });
  });

  it('内建纯函数可用（Math/parseInt/正则）', () => {
    expect(evaluateCond('Math.min(a, b) > 1', { a: 5, b: 2 })).toEqual({ ok: true, value: true });
    expect(evaluateCond('parseInt(x, 10) === 7', { x: '7' })).toEqual({ ok: true, value: true });
    expect(evaluateCond('/^h/.test(s)', { s: 'hot' })).toEqual({ ok: true, value: true });
  });

  it('全局阻断：window/document/fetch 访问 → 未匹配变量（接触不到外界）', () => {
    const r = evaluateCond('window !== undefined', {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain('未匹配变量：window');
    expect(evaluateCond('document.title', {}).error).toContain('未匹配变量：document');
    expect(evaluateCond('fetch(1)', {}).error).toContain('未匹配变量：fetch');
  });

  it('安全沙箱：原型链逃逸模式被预过滤阻断', () => {
    // 原型链逃逸：({}).constructor.constructor('return payload')()
    // 这是 new Function + with + Proxy 的经典绕路——对象字面量不经 Proxy，
    // 通过原型链直达原生 Function 构造器，从而执行任意代码。
    const r1 = evaluateCond('({}).constructor.constructor("return 42")()', {});
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain('安全限制');

    // 数组字面量同样可逃逸
    const r2 = evaluateCond('[].constructor.constructor("return 42")()', {});
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('安全限制');

    // 字符串字面量同样可逃逸
    const r3 = evaluateCond('"".constructor.constructor("return 42")()', {});
    expect(r3.ok).toBe(false);
    expect(r3.error).toContain('安全限制');

    // 直接 Function 构造器调用
    const r4 = evaluateCond('Function("return 42")()', {});
    expect(r4.ok).toBe(false);
    expect(r4.error).toContain('安全限制');

    // eval 调用
    const r5 = evaluateCond('eval("return 42")', {});
    expect(r5.ok).toBe(false);
    expect(r5.error).toContain('安全限制');

    // __proto__ 访问
    const r6 = evaluateCond('({}).__proto__', {});
    expect(r6.ok).toBe(false);
    expect(r6.error).toContain('安全限制');

    // .prototype 访问
    const r7 = evaluateCond('Object.prototype', {});
    expect(r7.ok).toBe(false);
    expect(r7.error).toContain('安全限制');
  });

  it('语句语法（循环/声明）→ SyntaxError 无法求值（只能算表达式）', () => {
    expect(evaluateCond('while (true) {}', {}).ok).toBe(false);
    expect(evaluateCond('let x = 1', {}).ok).toBe(false);
    // 赋值是合法表达式（a=1 返回 1），但只写进每次调用新建的局部 env，无副作用
    expect(evaluateCond('a = 1', { a: 1 })).toEqual({ ok: true, value: 1 });
  });

  it('函数调用（len(items)）→ ok:false + 未匹配变量', () => {
    const r = evaluateCond('i < len(sections)', { i: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('未匹配变量：len');
  });

  it('语法错误 → ok:false', () => {
    expect(evaluateCond('a >', { a: 1 }).ok).toBe(false);
    expect(evaluateCond('', {}).ok).toBe(false);
  });
});

describe('applyJudgements - 判定走向选择', () => {
  it('注入值命中真分支（是）', () => {
    const { nodes, edges } = cfgFixture();
    const js = collectJudgements(nodes, edges, 'host', 'Compose');
    const res = applyJudgements(js, flattenScope({ over: true }));

    expect(res[0].evaluable).toBe(true);
    expect(res[0].chosenVia).toBe('是');
    expect(res[0].chosenTo).toBe('返回错误');
  });

  it('注入值命中假分支（否）', () => {
    const { nodes, edges } = cfgFixture();
    const js = collectJudgements(nodes, edges, 'host', 'Compose');
    const res = applyJudgements(js, flattenScope({ over: false }));

    expect(res[0].evaluable).toBe(true);
    expect(res[0].chosenVia).toBe('否');
    expect(res[0].chosenTo).toBe('组装');
  });

  it('嵌套注入值经扁平化命中参数', () => {
    const { nodes, edges } = cfgFixture();
    const js = collectJudgements(nodes, edges, 'host', 'Compose');
    const res = applyJudgements(js, flattenScope({ payload: { over: true } }));
    expect(res[0].chosenVia).toBe('是');
  });

  it('无法求值：未匹配变量 / 函数调用 → evaluable:false + 原因', () => {
    const { nodes, edges } = cfgFixture();
    const js = collectJudgements(nodes, edges, 'host', 'Compose');
    const resEmpty = applyJudgements(js, {});
    expect(resEmpty[0].evaluable).toBe(false);
    expect(resEmpty[0].error).toContain('未匹配变量');

    const resLoop = applyJudgements(js, { over: true, i: 1 });
    // branch 可求值，loop 因 len() 调用（函数实现不在 DSL）无法求值
    expect(resLoop[0].evaluable).toBe(true);
    expect(resLoop[0].chosenVia).toBe('是');
    expect(resLoop[1].evaluable).toBe(false);
    expect(resLoop[1].error).toContain('未匹配变量：len');
  });
});
