/**
 * arg_suggest 参数纠错 —— 纯函数测试
 *
 * 出处：Serena 的 Smart Errors。动机（dogfood 观察）：zod object 会**静默丢弃**未知键，
 * 于是"参数写错"表现为"结果莫名其妙"，而不是一条可行动的纠正。
 *
 * 覆盖：编辑距离 / 归一化命中（projectDir → project_dir）/ 阈值（不够像就静默）/
 *       多候选排序 / 渲染格式 / 不误报既有键。
 */
import { describe, it, expect } from 'vitest';
import {
  levenshtein,
  suggestNames,
  unknownArgHints,
  renderArgHints,
} from '../../src/tools/arg_suggest';

describe('levenshtein', () => {
  it('基本距离', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
  });
});

describe('suggestNames', () => {
  const known = ['project_dir', 'file', 'symbol', 'mode', 'top_k'];

  it('§归一化命中：大小写/下划线差异视为同一名（最常用的一次纠正）', () => {
    expect(suggestNames('projectDir', known)[0]).toBe('project_dir');
    expect(suggestNames('project-dir', known)[0]).toBe('project_dir');
    expect(suggestNames('PROJECT_DIR', known)[0]).toBe('project_dir');
  });

  it('近似拼写给出候选', () => {
    expect(suggestNames('symbols', known)).toContain('symbol');
    expect(suggestNames('projct_dir', known)[0]).toBe('project_dir');
  });

  it('★ 阈值哲学：多/少一整个词 不算"够像" → 静默（宁缺勿滥，别制造噪音）', () => {
    // 'file_dir' 归一化后是 'filedir'，与 'file' 差 3 > 阈值 2 ⇒ 不提示
    expect(suggestNames('file_dir', known)).toEqual([]);
  });

  it('完全不像 → 空数组（不制造噪音）', () => {
    expect(suggestNames('zwischenzug', known)).toEqual([]);
  });

  it('返回数量受 max 限制，且按距离升序', () => {
    const r = suggestNames('modes', known, { max: 2 });
    expect(r.length).toBeLessThanOrEqual(2);
    expect(r[0]).toBe('mode');
  });
});

describe('unknownArgHints', () => {
  const known = ['project_dir', 'file', 'symbol'];

  it('未知键 → 给出"是否想传 X"', () => {
    const hints = unknownArgHints({ projectDir: '/x', file: 'a.ts' }, known);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('projectDir');
    expect(hints[0]).toContain('project_dir');
  });

  it('既有键不报（不误报）', () => {
    expect(unknownArgHints({ project_dir: '/x', file: 'a.ts', symbol: 's' }, known)).toEqual([]);
  });

  it('不像的未知键静默（未知键也可能是有意为之）', () => {
    expect(unknownArgHints({ whatever_extra: 1 }, known)).toEqual([]);
  });

  it('空参数 / undefined 参数不炸', () => {
    expect(unknownArgHints({}, known)).toEqual([]);
    expect(unknownArgHints(undefined as never, known)).toEqual([]);
  });
});

describe('renderArgHints', () => {
  it('无提示 → 空串（调用方什么都别加）', () => {
    expect(renderArgHints([], ['a'])).toBe('');
  });

  it('有提示 → 带 ⚠ 与参数清单', () => {
    const s = renderArgHints(['未知参数 `projectDir` —— 是否想传 `project_dir`？'], ['project_dir', 'file']);
    expect(s).toContain('⚠ 未知参数 `projectDir`');
    expect(s).toContain('（本工具参数：project_dir / file）');
  });
});
