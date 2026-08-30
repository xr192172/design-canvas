/**
 * sync_contracts 走查：先写 DSL → 从 server_registry zod schema 回填工具契约（修复契约漂移 D）。
 * 同时验证 ESM 循环 import（sync_contracts ↔ server_registry）在函数执行期安全。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { syncContracts } from '../../src/tools/sync_contracts';
import { saveDSL, getDSL, clearAllFeatures, deleteFeature } from '../../src/storage';
import type { DesignDSL } from '../../src/dsl/types';

function makeDSL(feature: string): DesignDSL {
  return {
    id: feature,
    type: 'feature_diagram',
    feature,
    geometry: {
      layout: 'free',
      width: 400,
      height: 200,
      nodes: [
        { id: 'f0', x: 0, y: 0, width: 200, height: 60, label: '入口' },
        // 先写 DSL：harvest_decisions 契约文件（预期签名将与 registry 对齐）
        { id: 'f_harvest_decisions', x: 0, y: 0, width: 200, height: 60, label: 'src/tools/harvest_decisions.ts' },
      ],
      edges: [],
    },
    semantic: {
      files: [
        { id: 'f_harvest_decisions', path: 'src/tools/harvest_decisions.ts', responsibility: '决策卡补录：提取候选' },
      ],
    },
  };
}

describe('sync_contracts 走查（契约回填）', () => {
  beforeEach(() => clearAllFeatures());
  afterEach(() => {
    clearAllFeatures();
    try {
      deleteFeature('sync_demo');
      deleteFeature('sync_demo2');
    } catch {
      /* ignore */
    }
  });

  it('先写 DSL → sync：harvest_decisions 契约被 registry zod 回填（默认不新增）', () => {
    saveDSL(makeDSL('sync_demo'));
    const r = syncContracts({ feature: 'sync_demo' });

    const saved = getDSL('sync_demo')!;
    const f = saved.semantic!.files.find((x) => x.path === 'src/tools/harvest_decisions.ts')!;
    expect(f.expected_apis?.length).toBeGreaterThanOrEqual(1);
    // 签名用注册名（snake_case，与 MCP 工具名一致），参数来自 registry zod（含可选标记）
    const api = f.expected_apis!.find((a) => a.signature.includes('harvest_decisions'))!;
    // registry zod 的参数已生成进签名（含可选标记），与 server_registry 对齐
    expect(api.signature).toContain('git_root?');
    expect(api.signature).toContain('comment_files?');
    // 默认不新增文件节点（契约文件已有则不重复创建）
    expect(r.added_files).toEqual([]);
    // 不污染几何：默认不新增 geometry 节点
    expect(saved.geometry!.nodes.length).toBe(2);
  });

  it('include_all=true：为缺失的工具契约文件补全节点 + geometry 节点', () => {
    saveDSL(makeDSL('sync_demo2'));
    // 先删掉 harvest_decisions 契约文件，模拟"新工具没写进 DSL"
    const dsl = getDSL('sync_demo2')!;
    dsl.semantic!.files = [];
    dsl.geometry!.nodes = [];
    saveDSL(dsl);

    const r = syncContracts({ feature: 'sync_demo2', include_all: true });
    const saved = getDSL('sync_demo2')!;
    expect(saved.semantic!.files.some((f) => f.path === 'src/tools/harvest_decisions.ts')).toBe(true);
    // geometry 节点与契约文件对齐（file.id ↔ node.id）
    for (const f of saved.semantic!.files) {
      expect(saved.geometry!.nodes.some((n) => n.id === f.id), `node 缺失: ${f.id}`).toBe(true);
    }
    expect(r.added_files.length).toBeGreaterThan(0);
  });

  it('幂等：再跑一次不重复追加（防漂移重复污染）', () => {
    saveDSL(makeDSL('sync_demo'));
    syncContracts({ feature: 'sync_demo' });
    const r2 = syncContracts({ feature: 'sync_demo' });
    const saved = getDSL('sync_demo')!;
    const f = saved.semantic!.files.find((x) => x.path === 'src/tools/harvest_decisions.ts')!;
    const count = f.expected_apis!.filter((a) => a.signature.includes('harvest_decisions')).length;
    expect(count).toBe(1); // 幂等：同一签名只存在一条
    expect(r2.updated_files).toEqual([]);
  });

  it('feature 不存在时抛错', () => {
    expect(() => syncContracts({ feature: 'not_exist' })).toThrow(/不存在/);
  });
});
