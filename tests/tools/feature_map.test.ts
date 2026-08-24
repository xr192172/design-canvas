/**
 * feature_map（可视化地基）测试 —— 把设计画布 src 当狗食现场验证"功能→前端/后端→相似→废弃"
 */
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildFeatureMap, featureIdOf, sideOfLayer } from '../../src/tools/feature_map';

const SRC = path.join(process.cwd(), 'src');

describe('feature_map 顶层约定', () => {
  it('功能 = source_root 下首层目录段；根文件归 root', () => {
    expect(featureIdOf('renderer/html_renderer.ts')).toBe('renderer');
    expect(featureIdOf('tools/detect_dead_imports.ts')).toBe('tools');
    expect(featureIdOf('server.ts')).toBe('root');
  });

  it('层 → 前端/后端/通用', () => {
    expect(sideOfLayer('ui')).toBe('frontend');
    expect(sideOfLayer('api')).toBe('backend');
    expect(sideOfLayer('service')).toBe('backend');
    expect(sideOfLayer('data')).toBe('backend');
    expect(sideOfLayer('utility')).toBe('shared');
    expect(sideOfLayer('core')).toBe('shared');
  });
});

describe('feature_map 在 design-canvas src 上的真实结果', () => {
  it('能切出 renderer/tools/dsl 等功能，且 renderer 有前端文件', () => {
    const { features, scannedFiles } = buildFeatureMap({ project_dir: path.join(process.cwd()), source_root: SRC });
    expect(scannedFiles).toBeGreaterThan(100);
    const fns = features.map((f) => f.id);
    expect(fns).toContain('renderer');
    expect(fns).toContain('tools');
    expect(fns).toContain('dsl');
    const renderer = features.find((f) => f.id === 'renderer');
    // renderer 至少命中一个前端(ui)层文件：html_renderer / anim_core 等目录含 renderer → ui 层
    expect((renderer?.frontend.length ?? 0) + (renderer?.shared.length ?? 0)).toBeGreaterThan(0);
  });

  it('每组 proven 的 features 都带数组型 frontend/backend/shared（可渲染）', () => {
    const { features } = buildFeatureMap({ project_dir: path.join(process.cwd()), source_root: SRC });
    for (const f of features) {
      expect(Array.isArray(f.frontend)).toBe(true);
      expect(Array.isArray(f.backend)).toBe(true);
      expect(Array.isArray(f.shared)).toBe(true);
      expect(f.similar).toBeInstanceOf(Array);
      expect(f.deprecation).toHaveProperty('deadImportSources');
      expect(f.deprecation).toHaveProperty('deadSources');
    }
  });

  it('多处存在相似功能链接（互相重复实现的风险被显式标出）', () => {
    const { features } = buildFeatureMap({ project_dir: path.join(process.cwd()), source_root: SRC });
    const withSimilar = features.filter((f) => f.similar.length > 0);
    expect(withSimilar.length).toBeGreaterThan(0);
    // 镜像性：a→b 存在时 b→a 也应存在（抽查）
    for (const a of withSimilar) {
      for (const link of a.similar) {
        const b = features.find((f) => f.id === link.featureId);
        expect(b?.similar.some((x) => x.featureId === a.id)).toBe(true);
      }
    }
  });

  it('tools 功能被抓出 derive 平行实现家族（重复实现屎山症状）', () => {
    const { features } = buildFeatureMap({ project_dir: path.join(process.cwd()), source_root: SRC });
    const tools = features.find((f) => f.id === 'tools');
    expect(tools).toBeDefined();
    const derive = tools?.repeatedFamilies.find((r) => r.root === 'derive');
    // derive_* 系列（algorithm/chain/anim_flow/feature_tree/mind_map/reasoning/split）自成一线
    expect(derive?.files.length).toBeGreaterThanOrEqual(6);
  });
});