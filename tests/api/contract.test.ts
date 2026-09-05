import { describe, it, expect } from 'vitest';
import {
  API_VERSION,
  RESPONSE_SCHEMA_AT,
  schemas,
  featuresResp,
  saveResp,
  overviewResp,
  mindMapResp,
  archifyDemoResp,
} from '../../src/api/contract.js';

describe('api/contract —— 响应契约 zod 单源', () => {
  it('export 契约常量对齐：_api=1 且字段名为 RESPONSE_SCHEMA_AT', () => {
    expect(API_VERSION).toBe(1);
    expect(RESPONSE_SCHEMA_AT).toBe('_api');
  });

  it('featuresResp 能校验采样响应（含 _api=1 + features[]）', () => {
    const r = featuresResp.safeParse({
      _api: 1,
      features: [{ feature: 'design-canvas', title: 'design-canvas', files: 2, nodes: 8, language: 'ts' }],
    });
    expect(r.success).toBe(true);
  });

  it('featuresResp 缺 _api 版本字段 → 校验失败（漂移即显）', () => {
    const r = featuresResp.safeParse({ features: [] });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path[0] === RESPONSE_SCHEMA_AT)).toBe(true);
    }
  });

  it('saveResp 校验保存成功分支', () => {
    const r = saveResp.safeParse({ _api: 1, success: true, message: 'DSL 已保存', feature: 'x', saved_at: 'now', rev: 1 });
    expect(r.success).toBe(true);
  });

  it('overviewResp 校验小白视图采样（summary 必带 three 字段，其余放行）', () => {
    const r = overviewResp.safeParse({
      _api: 1,
      success: true,
      feature: 'design-canvas',
      title: 'design-canvas',
      summary: { one_liner: 'x', brief: 'y', mode: 'rule', extra_field: 1 },
      mind_map: { root: { id: 'r' } },
    });
    expect(r.success).toBe(true);
  });

  it('mindMapResp 校验 mind-map / mind-map-teach（success + mind_map）', () => {
    const r = mindMapResp.safeParse({ _api: 1, success: true, mind_map: { feature: 'x' } });
    expect(r.success).toBe(true);
  });

  it('archifyDemoResp 校验 5 类交付清单', () => {
    const r = archifyDemoResp.safeParse({
      _api: 1,
      delivered: true,
      manifest: [
        { type: 'architecture', delivered: true, htmlPath: 'a.html' },
        { type: 'workflow', delivered: false, note: 'skip' },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('archifyDemoResp 拒绝非法图类型（type 不在枚举内 → 漂移暴露）', () => {
    const r = archifyDemoResp.safeParse({ _api: 1, delivered: false, manifest: [{ type: 'bogus', delivered: false }] });
    expect(r.success).toBe(false);
  });

  it('schemas 表覆盖 6 个契约端点键', () => {
    expect(Object.keys(schemas).sort()).toEqual(
      ['archify-demo', 'features', 'mind-map', 'mind-map-teach', 'overview', 'save'].sort(),
    );
  });
});