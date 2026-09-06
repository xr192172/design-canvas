/**
 * feature_line 测试：功能线 入口挑选(pickEntry) + 主链构建(buildMainChain) + 按功能推导(deriveLineFromFunctions)
 */
import { describe, it, expect } from 'vitest';
import { pickEntry, buildMainChain, deriveLineFromFunctions, type FeatureLineNode } from '../../src/tools/feature_line';
import type { FunctionOutlineFn } from '../../src/tools/function_outline';

function fn(id: string, name: string, feature: string, calls: string[] = [], calledBy: string[] = []): FunctionOutlineFn {
  return {
    id, name, kind: 'function', qualified_name: name, file: 'observe/x.ts', dir: 'observe',
    start_line: 1, end_line: 4, calls: calls.map((fn_id) => ({ fn_id, name: fn_id.split('#').pop() || fn_id, file: 'x.ts', line: 1, cross: false })),
    called_by: calledBy.map((fn_id) => ({ fn_id, name: fn_id.split('#').pop() || fn_id, file: 'x.ts', line: 1, cross: false })),
    recursive: false, feature_id: 'f1', feature_name: feature,
  };
}

describe('pickEntry', () => {
  it('选根（功能内不被调用者）+ 名启发', () => {
    const fns = [
      fn('f1#run', 'run', '观测', ['f1#a', 'f1#b'], []),               // root + 名启发
      fn('f1#a', 'a', '观测', ['f1#b'], ['f1#run']),
      fn('f1#b', 'b', '观测', [], ['f1#a', 'f1#run']),
    ];
    expect(pickEntry(fns)?.name).toBe('run');
  });

  it('无根（互相调用）时退化到名启发/出度最大', () => {
    const fns = [
      fn('f1#a', 'a', '观测', ['f1#b'], ['f1#c']),
      fn('f1#b', 'b', '观测', ['f1#c'], ['f1#a']),
      fn('f1#c', 'c', '观测', [], ['f1#b']),
    ];
    expect(pickEntry(fns)).toBeDefined();
  });

  it('空列表 → undefined', () => {
    expect(pickEntry([])).toBeUndefined();
  });
});

describe('buildMainChain', () => {
  it('沿功能内 calls 走主链、不重复、遇无内联则停', () => {
    const fns = [
      fn('f1#run', 'run', '观测', ['f1#a', 'f1#skip']),
      fn('f1#a', 'a', '观测', ['f1#b']),
      fn('f1#b', 'b', '观测', ['f1#run']), // 回环 → seen 拦截
      fn('f1#skip', 'skip', '观测', ['f1#b']),
    ];
    const entry = pickEntry(fns)!;
    const chain = buildMainChain(entry, fns, 10);
    const names = chain.map((n: FeatureLineNode) => n.name);
    // run → a → b →(b 只调 run，seen) 停
    expect(names).toEqual(['run', 'a', 'b']);
    expect(new Set(chain.map((n) => n.id)).size).toBe(chain.length); // 无重复
  });

  it('maxSteps 上限生效', () => {
    const mk = (i: number) => fn(`f#s${i}`, `s${i}`, '观测', i < 4 ? [`f#s${i + 1}`] : []);
    const fns = [0, 1, 2, 3, 4].map((i) => mk(i));
    const chain = buildMainChain(fns[0], fns, 3);
    expect(chain.length).toBe(3);
  });
});

describe('deriveLineFromFunctions', () => {
  it('按功能分组取线，target 命中返回该功能入口+主链', () => {
    const fns = [
      fn('f1#run', 'run', '观测', ['f1#a'], []),
      fn('f1#a', 'a', '观测', [], ['f1#run']),
      fn('f2#load', 'load', '存储', ['f2#put'], []),
      fn('f2#put', 'put', '存储', [], ['f2#load']),
    ];
    const { line, chosenFeature } = deriveLineFromFunctions(fns, { targetName: '存储' });
    expect(chosenFeature).toBe('存储');
    expect(line.entry?.name).toBe('load');
    expect(line.chain.map((n) => n.name)).toEqual(['load', 'put']);
  });

  it('target 未命中 → 取函数最多功能，note 说明', () => {
    const fns = [fn('f1#a', 'a', '观测', [], []), fn('f2#b', 'b', '存储', [], [])];
    const { line, chosenFeature } = deriveLineFromFunctions(fns, { targetName: '不存在' });
    expect(chosenFeature).toBe('观测');
    expect(line.chain.length).toBeGreaterThan(0);
  });
});