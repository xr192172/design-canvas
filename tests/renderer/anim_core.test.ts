/**
 * AnimCore 纯逻辑单元测试
 *
 * 覆盖：L3 条件求值/分支选择/mock 轮换、L4 路径映射、L4.5 异常匹配、快照对比
 * 该模块同时被内联进浏览器动画脚本（单源双消费），
 * 本测试保证纯逻辑正确性，浏览器端行为由 e2e 验证补充。
 */
import { describe, it, expect } from 'vitest';
import {
  evalCondition,
  pickBranch,
  createMockRotator,
  resolvePath,
  setPath,
  applyInputMapping,
  applyOutputMapping,
  matchError,
  isErrorResult,
  classifyError,
  makeSnapshot,
  parseApiName,
  formatHandlerArgs,
  formatValueShort,
} from '../../src/renderer/anim_core';

describe('evalCondition - 条件表达式求值', () => {
  it('简单比较表达式', () => {
    expect(evalCondition('value.status == 200', { status: 200 })).toBe(true);
    expect(evalCondition('value.status == 200', { status: 401 })).toBe(false);
  });

  it('算术与逻辑组合', () => {
    expect(evalCondition('value.used > value.budget * 0.8', { used: 90, budget: 100 })).toBe(true);
    expect(evalCondition('value.a && value.b', { a: true, b: false })).toBe(false);
  });

  it('数组方法调用（conveyor 预算场景）', () => {
    const value = {
      sections: [{ tokens: 50000 }, { tokens: 60000 }],
      tokenBudget: 128000,
    };
    expect(
      evalCondition(
        'Array.isArray(value.sections) && value.sections.reduce(function(sum, s){ return sum + (s.tokens || 0); }, 0) > value.tokenBudget * 0.8',
        value,
      ),
    ).toBe(true);
  });

  it('result 上下文（L4.5 异常条件）', () => {
    expect(evalCondition('result.error.code == 401', undefined, { error: { code: 401 } })).toBe(true);
    expect(evalCondition('result.panic == true', undefined, { panic: false })).toBe(false);
  });

  it('兜底词：else / true / default / 空串 / null 恒真', () => {
    expect(evalCondition('else')).toBe(true);
    expect(evalCondition('true')).toBe(true);
    expect(evalCondition('default')).toBe(true);
    expect(evalCondition('')).toBe(true);
    expect(evalCondition(null)).toBe(true);
    expect(evalCondition(undefined)).toBe(true);
  });

  it('语法错误 / 运行时异常 → false 不抛出', () => {
    expect(evalCondition('value..bad', { x: 1 })).toBe(false);
    expect(evalCondition('value.a.b.c', null)).toBe(false);
    expect(evalCondition('undefinedFunc()', {})).toBe(false);
  });

  it('真值转换：返回非布尔值时按真值处理', () => {
    expect(evalCondition('value.name', { name: 'x' })).toBe(true);
    expect(evalCondition('value.count', { count: 0 })).toBe(false);
  });
});

describe('pickBranch - L3 分支选择', () => {
  const branches = [
    { condition: 'value.status == 200', to: 'node_ok', value: { type: 'ok' } },
    { condition: 'value.status == 401', to: 'node_auth', value: { type: 'auth_err' } },
    { condition: 'else', to: 'node_other', value: { type: 'other' } },
  ];

  it('按声明顺序返回第一个命中分支及索引', () => {
    expect(pickBranch(branches, { status: 200 })).toEqual({ branch: branches[0], index: 0 });
    expect(pickBranch(branches, { status: 401 })).toEqual({ branch: branches[1], index: 1 });
  });

  it('else 兜底分支', () => {
    expect(pickBranch(branches, { status: 500 })).toEqual({ branch: branches[2], index: 2 });
  });

  it('全部未命中（无 else）→ null', () => {
    const noElse = branches.slice(0, 2);
    expect(pickBranch(noElse, { status: 500 })).toBeNull();
  });

  it('空 / 未定义 branches → null', () => {
    expect(pickBranch([], { status: 200 })).toBeNull();
    expect(pickBranch(undefined, { status: 200 })).toBeNull();
    expect(pickBranch(null, { status: 200 })).toBeNull();
  });
});

describe('createMockRotator - mock 数据源轮换', () => {
  it('按序轮流返回值，末尾回绕', () => {
    const next = createMockRotator([{ status: 200 }, { status: 401 }]);
    expect(next()).toEqual({ status: 200 });
    expect(next()).toEqual({ status: 401 });
    expect(next()).toEqual({ status: 200 });
  });

  it('空数组 / undefined → 恒 undefined', () => {
    const nextEmpty = createMockRotator([]);
    const nextUndef = createMockRotator(undefined);
    expect(nextEmpty()).toBeUndefined();
    expect(nextUndef()).toBeUndefined();
  });
});

describe('resolvePath - 路径解析', () => {
  const ctx = { value: { token: 'abc', claims: { user_id: 42 } }, result: { ok: true } };

  it('$value 前缀路径', () => {
    expect(resolvePath(ctx, '$value.token')).toBe('abc');
    expect(resolvePath(ctx, '$value.claims.user_id')).toBe(42);
  });

  it('$result 前缀路径', () => {
    expect(resolvePath(ctx, '$result.ok')).toBe(true);
  });

  it('路径不存在 → undefined', () => {
    expect(resolvePath(ctx, '$value.missing.deep')).toBeUndefined();
    expect(resolvePath(ctx, '$other.x')).toBeUndefined();
    expect(resolvePath(ctx, '')).toBeUndefined();
    expect(resolvePath(ctx, null)).toBeUndefined();
  });
});

describe('setPath - 路径写入', () => {
  it('写入并自动创建中间层', () => {
    const obj: Record<string, unknown> = {};
    setPath(obj, 'a.b.c', 1);
    expect(obj).toEqual({ a: { b: { c: 1 } } });
  });

  it('忽略 $value/$result 根前缀', () => {
    const obj: Record<string, unknown> = {};
    setPath(obj, '$value.claims', { uid: 1 });
    expect(obj).toEqual({ claims: { uid: 1 } });
  });
});

describe('applyInputMapping - L4 输入映射', () => {
  it('按映射解析参数对象', () => {
    const out = applyInputMapping(
      { token: '$value.token', uid: '$value.claims.user_id' },
      { token: 'abc', claims: { user_id: 42 } },
    );
    expect(out).toEqual({ token: 'abc', uid: 42 });
  });

  it('空映射 → 空对象', () => {
    expect(applyInputMapping(undefined, {})).toEqual({});
  });
});

describe('applyOutputMapping - L4 输出映射', () => {
  it('把 result 写回 value 副本（不污染原值）', () => {
    const value = { type: 'auth_token' };
    const out = applyOutputMapping({ '$value.claims': '$result' }, value, { uid: 1 }) as Record<string, unknown>;
    expect(out).toEqual({ type: 'auth_token', claims: { uid: 1 } });
    expect(value).toEqual({ type: 'auth_token' });
  });

  it('value 为 null 时以空对象为基底', () => {
    const out = applyOutputMapping({ '$value.x': '$result' }, null, 5);
    expect(out).toEqual({ x: 5 });
  });

  it('空映射 → 原样返回', () => {
    expect(applyOutputMapping(undefined, { a: 1 }, null)).toEqual({ a: 1 });
  });
});

describe('matchError - L4.5 异常匹配', () => {
  const errors = [
    { type: 'ErrInvalidToken', condition: 'result.error.code == 401', severity: 'expected' as const, to: 'node_retry' },
    { type: 'panic', condition: 'result.panic == true', severity: 'unexpected' as const, to: 'node_handler' },
  ];

  it('按声明顺序返回第一个命中', () => {
    expect(matchError(errors, { error: { code: 401 } })?.type).toBe('ErrInvalidToken');
    expect(matchError(errors, { panic: true })?.type).toBe('panic');
  });

  it('未命中 → null', () => {
    expect(matchError(errors, { error: { code: 500 } })).toBeNull();
  });

  it('空声明 → null', () => {
    expect(matchError([], { panic: true })).toBeNull();
    expect(matchError(undefined, { panic: true })).toBeNull();
  });
});

describe('isErrorResult - L4.5 异常形态判定', () => {
  it('error 字段非空 → true', () => {
    expect(isErrorResult({ error: { code: 401 } })).toBe(true);
    expect(isErrorResult({ error: 'boom' })).toBe(true);
  });

  it('panic === true → true', () => {
    expect(isErrorResult({ panic: true, message: 'nil pointer' })).toBe(true);
  });

  it('正常业务数据 → false', () => {
    expect(isErrorResult({ compose: 'ok', tokens: 1200 })).toBe(false);
    expect(isErrorResult({ $mock: 'Compose' })).toBe(false);
    expect(isErrorResult({ panic: false, error: null })).toBe(false);
  });

  it('非对象 / null → false', () => {
    expect(isErrorResult(null)).toBe(false);
    expect(isErrorResult(undefined)).toBe(false);
    expect(isErrorResult(42)).toBe(false);
    expect(isErrorResult('error')).toBe(false);
  });
});

describe('classifyError - L4.5 异常分类', () => {
  const errors = [
    { type: 'ErrBudget', condition: "result.error && result.error.code === 'BUDGET'", severity: 'expected' as const, to: 'node_draft' },
    { type: 'panic', condition: 'result.panic === true', severity: 'unexpected' as const, to: 'node_handler' },
  ];

  it('命中声明 → declared 带 decl', () => {
    const c = classifyError(errors, { error: { code: 'BUDGET' } });
    expect(c.kind).toBe('declared');
    expect(c.decl?.type).toBe('ErrBudget');
    expect(classifyError(errors, { panic: true }).kind).toBe('declared');
  });

  it('像异常但未命中声明 → undeclared', () => {
    expect(classifyError(errors, { error: { code: 'NETWORK_TIMEOUT' } }).kind).toBe('undeclared');
    expect(classifyError(errors, { panic: false, error: { code: 500 } }).kind).toBe('undeclared');
  });

  it('无声明时异常结果仍 → undeclared', () => {
    expect(classifyError(undefined, { error: { code: 1 } }).kind).toBe('undeclared');
    expect(classifyError([], { panic: true }).kind).toBe('undeclared');
  });

  it('正常结果 → none', () => {
    expect(classifyError(errors, { compose: 'ok' }).kind).toBe('none');
    expect(classifyError(undefined, { compose: 'ok' }).kind).toBe('none');
  });
});

describe('makeSnapshot - 状态快照', () => {
  it('普通对象序列化', () => {
    expect(makeSnapshot({ a: 1 })).toBe('{"a":1}');
  });

  it('循环引用 → null 不抛出', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(makeSnapshot(a)).toBeNull();
  });
});

describe('parseApiName - 从 signature 解析函数名', () => {
  it('简单函数形式', () => {
    expect(parseApiName('Compose() (string, error)')).toBe('Compose');
    expect(parseApiName('L0Content() string')).toBe('L0Content');
  });

  it('方法形式（Type.Method）', () => {
    expect(parseApiName('SectionQueue.Push(section *Section)')).toBe('Push');
    expect(parseApiName('DraftZone.AddDraft(content string) (int, error)')).toBe('AddDraft');
  });

  it('Go func 前缀与接收者形式', () => {
    expect(parseApiName('func Authenticate(token string) (*Claims, error)')).toBe('Authenticate');
    expect(parseApiName('func (r *SectionQueue) Fold(n, k int)')).toBe('Fold');
  });

  it('空输入 → 空串', () => {
    expect(parseApiName('')).toBe('');
    expect(parseApiName(null)).toBe('');
    expect(parseApiName(undefined)).toBe('');
  });
});

describe('formatHandlerArgs - handler 调用参数格式化', () => {
  it('基本类型混合', () => {
    expect(formatHandlerArgs({ token: 'abc', n: 4, ok: true })).toBe('token="abc", n=4, ok=true');
  });

  it('长值截断', () => {
    const out = formatHandlerArgs({ data: 'x'.repeat(40) });
    expect(out.length).toBeLessThan(30);
    expect(out).toContain('…');
  });

  it('对象值 JSON 序列化 + 截断', () => {
    expect(formatHandlerArgs({ sec: { id: 's1' } })).toBe('sec={"id":"s1"}');
  });

  it('空对象 → 空串；不可序列化回退 String()', () => {
    expect(formatHandlerArgs({})).toBe('');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatHandlerArgs({ c: circular })).toContain('c=');
  });
});

describe('formatValueShort - IO 浮层输出预览格式化', () => {
  it('null/undefined → 空串', () => {
    expect(formatValueShort(null)).toBe('');
    expect(formatValueShort(undefined)).toBe('');
  });

  it('字符串原样；对象 JSON 序列化', () => {
    expect(formatValueShort('ok')).toBe('ok');
    expect(formatValueShort({ token: 't1' })).toBe('{"token":"t1"}');
    expect(formatValueShort(42)).toBe('42');
  });

  it('超 maxLen 截断带省略号', () => {
    const out = formatValueShort({ data: 'x'.repeat(60) }, 32);
    expect(out.length).toBeLessThanOrEqual(32);
    expect(out).toContain('…');
  });
});
