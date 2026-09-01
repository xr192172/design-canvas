/**
 * get_dsl / list_features 工具测试
 *
 * 覆盖 e2e 未触及的边界场景：
 * - get_dsl 找不到 feature 时抛错
 * - list_features 空列表返回提示
 * - list_features 多个 feature 排序
 * - list_features 统计文件数 / 不变式数 / 状态
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderDesign } from '../../src/tools/render_design';
import { getDsl } from '../../src/tools/get_dsl';
import { listFeatures } from '../../src/tools/list_features';
import { clearAllFeatures } from '../../src/storage';
import type { DesignDSL } from '../../src/dsl/types';

function makeDSL(feature: string, status: DesignDSL['status']): DesignDSL {
  return {
    id: `id_${feature}`,
    type: 'feature_diagram',
    feature,
    status,
    geometry: {
      layout: 'free',
      width: 200,
      height: 100,
      nodes: [{ id: 'n1', x: 0, y: 0, width: 100, height: 50, label: 'n1' }],
    },
    semantic: {
      files: [
        { id: 'n1', path: `${feature}.go`, responsibility: 'r' },
      ],
      multi_file_invariants: status === 'done' ? ['inv1', 'inv2'] : [],
    },
  };
}

describe('get_dsl', () => {
  beforeEach(() => clearAllFeatures());
  afterEach(() => clearAllFeatures());

  it('feature 不存在时抛错', () => {
    expect(() => getDsl({ feature_name: 'not_exist' })).toThrow(/feature not found/);
  });

  it('能读回已保存的 DSL', () => {
    const dsl = makeDSL('alpha', 'in_progress');
    renderDesign({ dsl_json: JSON.stringify(dsl) });
    const result = getDsl({ feature_name: 'alpha' });
    const parsed = JSON.parse(result.json);
    expect(parsed.feature).toBe('alpha');
    expect(parsed.status).toBe('in_progress');
  });

  it('feature 名含特殊字符时抛错（路径安全）', () => {
    expect(() => getDsl({ feature_name: '../etc/passwd' })).toThrow(/非法 feature 名/);
    expect(() => getDsl({ feature_name: 'a/b' })).toThrow(/非法 feature 名/);
    expect(() => getDsl({ feature_name: 'a b' })).toThrow(/非法 feature 名/);
  });
});

describe('list_features', () => {
  beforeEach(() => clearAllFeatures());
  afterEach(() => clearAllFeatures());

  it('无 feature 时返回提示', () => {
    const result = listFeatures();
    expect(result.count).toBe(0);
    expect(result.message).toContain('尚无');
  });

  it('单个 feature 正确列出', () => {
    renderDesign({ dsl_json: JSON.stringify(makeDSL('alpha', 'done')) });
    const result = listFeatures();
    expect(result.count).toBe(1);
    expect(result.message).toContain('alpha');
    expect(result.message).toContain('done');
    expect(result.message).toContain('1 文件');
    expect(result.message).toContain('2 不变式');
  });

  it('多个 feature 按字母序排列', () => {
    renderDesign({ dsl_json: JSON.stringify(makeDSL('zeta', 'draft')) });
    renderDesign({ dsl_json: JSON.stringify(makeDSL('alpha', 'draft')) });
    renderDesign({ dsl_json: JSON.stringify(makeDSL('middle', 'draft')) });
    const result = listFeatures();
    expect(result.count).toBe(3);
    // alpha 应该在 zeta 之前
    const alphaIdx = result.message.indexOf('alpha');
    const middleIdx = result.message.indexOf('middle');
    const zetaIdx = result.message.indexOf('zeta');
    expect(alphaIdx).toBeLessThan(middleIdx);
    expect(middleIdx).toBeLessThan(zetaIdx);
  });

  it('draft 状态的 feature 无不变式时不显示不变式计数异常', () => {
    renderDesign({ dsl_json: JSON.stringify(makeDSL('draft_one', 'draft')) });
    const result = listFeatures();
    expect(result.message).toContain('0 不变式');
  });

  it('status 默认 draft（DSL 未设 status 时）', () => {
    const dsl = makeDSL('no_status', 'done');
    delete dsl.status;
    renderDesign({ dsl_json: JSON.stringify(dsl) });
    const result = listFeatures();
    expect(result.message).toContain('no_status');
    expect(result.message).toContain('draft');
  });
});
