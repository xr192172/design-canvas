/**
 * similar_names —— 相似名称检测与一键消歧
 *
 * 覆盖：
 *   - findSimilarNames：同一函数内把"易看错"的孪生名（仅大小写 / 数字后缀 / 小编辑距离）
 *     聚成 cluster，basis 为最清晰名，其余为 offenders。
 *     - 跨函数同名保持隔离，各自成组，互不误并。
 *     - 短名（长度 <3）与 `_` 不在此判（归 suggest_renames）。
 *   - suggestDisambiguations：可注入 LLM 消歧命名；null/失败 → 降级只列聚类。
 *   - disambiguationItems：把消歧结果转成 renameMany 可消费的 items。
 */
import { describe, it, expect } from 'vitest';
import { findSimilarNames, suggestDisambiguations, disambiguationItems, type SimilarNameCluster } from '../../src/tools/similar_names';

/** 断言：在 clusters 里找包含指定名字（作为 basis 或 offender）的 cluster */
function findCluster(clusters: SimilarNameCluster[], name: string): SimilarNameCluster {
  const c = clusters.find((x) => x.entries.some((e) => e.name === name));
  if (!c) throw new Error(`no cluster contains ${name}: ${JSON.stringify(clusters, null, 2)}`);
  return c;
}

describe('findSimilarNames - 相似名聚类', () => {
  it('唯一命名不产生聚类', async () => {
    const src = 'function f() {\n  const total = 1;\n  const subtotal = 2;\n  return total + subtotal;\n}\n';
    const clusters = await findSimilarNames(src);
    expect(clusters).toHaveLength(0);
  });

  it('数字后缀孪生聚成一边，让人看错的 count2 是 offender', async () => {
    const src = 'function calc() {\n  const count = 0;\n  const count2 = 0;\n  return count + count2;\n}\n';
    const clusters = await findSimilarNames(src);
    expect(clusters).toHaveLength(1);
    const c = clusters[0];
    expect(c.basis).toBe('count');
    expect(c.offenders.map((o) => o.name)).toEqual(['count2']);
    expect(c.reason).toContain('数字后缀');
  });

  it('仅大小写不同的孪生名聚成一边', async () => {
    const src = 'function f() {\n  const userData = [];\n  const userdata = [];\n  return [userData, userdata];\n}\n';
    const clusters = await findSimilarNames(src);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].reason).toContain('大小写');
  });

  it('小编辑距离相似名（相隔 1 字符）聚成一边', async () => {
    const src = 'function f() {\n  const config = 1;\n  const confid = 2;\n  const total = config + confid;\n}\n';
    const clusters = await findSimilarNames(src);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].entries.map((e) => e.name).sort()).toEqual(['confid', 'config']);
  });

  it('跨函数同名不误并，各自隔离', async () => {
    const src =
      'function a() {\n  const cfg = 1;\n  const cfs = 2;\n  return cfg + cfs;\n}\n' +
      'function b() {\n  const cfg = 3;\n  const cfs = 4;\n  return cfg * cfs;\n}\n';
    const clusters = await findSimilarNames(src);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].scopeLabel).toBe('a');
    expect(clusters[1].scopeLabel).toBe('b');
  });

  it('短名（<3字符）不在此判，不产生相似聚类', async () => {
    const src = 'function f() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n';
    const clusters = await findSimilarNames(src);
    expect(clusters).toHaveLength(0);
  });

  it('同一个函数里两个独立孪生组合自成两cluster', async () => {
    const src =
      'function f() {\n' +
      '  const count = 1;\n  const count2 = 2;\n' +
      '  const total = 3;\n  const totla = 4;\n' +
      '  return count + count2 + total + totla;\n}\n';
    const clusters = await findSimilarNames(src);
    expect(clusters).toHaveLength(2);
    expect(findCluster(clusters, 'count2').basis).toBe('count');
    expect(findCluster(clusters, 'totla').basis).toBe('total');
  });

  it('单复数对（node/nodes、chunk/chunks）属正常英文，不当作相似名', async () => {
    const src = 'function f() {\n  const node = 1;\n  const nodes = [node];\n  const chunk = [];\n  const chunks = [chunk];\n  return [nodes, chunks];\n}\n';
    const clusters = await findSimilarNames(src);
    expect(clusters).toHaveLength(0);
  });

  it('公共前缀不足2的"单字符巧合"（node/mode）不判为相似', async () => {
    const src = 'function f() {\n  const node = 1;\n  const mode = 2;\n  return node + mode;\n}\n';
    const clusters = await findSimilarNames(src);
    expect(clusters).toHaveLength(0);
  });

  it('无关短名（out/outs/cur/cut）非传递聚类：只把真孪生 cu→cut 聚出，其余不串联', async () => {
    const src = 'function f() {\n  const out = 1;\n  const outs = out + 1;\n  const cur = 3;\n  const cut = cur + 1;\n  return [outs, cut];\n}\n';
    const clusters = await findSimilarNames(src);
    // out/outs 是单复数对→滤掉；out/cur/out/cut 起手不同→不串
    // 仅 cur/cut（公共前缀 cu=2、1 字符差异）成簇
    expect(clusters).toHaveLength(1);
    expect(clusters[0].entries.map((e) => e.name).sort()).toEqual(['cur', 'cut']);
  });
});

describe('suggestDisambiguations - LLM 消歧命名（可注入）', () => {
  it('注入 LLM 后 offender 获得 suggested 新名，且 basis 不被命名', async () => {
    const src = 'function f() {\n  const count = 0;\n  const count2 = 0;\n  return count + count2;\n}\n';
    const llm = async () => [{ name: 'count2', renamed: 'retryCount', reason: '与 count 区分' }];
    const result = await suggestDisambiguations(src, undefined as unknown as string, { llm });
    expect(result.llm).toBe(true);
    const c = result.clusters[0];
    const o = c.offenders[0];
    expect(o.suggested).toBe('retryCount');
    expect(result.clusters[0].entries.find((e) => e.name === 'count')!.suggested).toBeUndefined();
  });

  it('llm=null 强制降级：仅检测，offender suggested 留空', async () => {
    const src = 'function f() {\n  const count = 0;\n  const count2 = 0;\n  return count;\n}\n';
    const result = await suggestDisambiguations(src, 'f.ts', { llm: null });
    expect(result.llm).toBe(false);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].offenders[0].suggested).toBeUndefined();
  });

  it('disambiguationItems 只收集有合法新名的 offender 进 renameMany items', async () => {
    const src = 'function f() {\n  const count = 0;\n  const count2 = 0;\n}\n';
    const llm = async () => [{ name: 'count2', renamed: 'retryCount', reason: '' }];
    const result = await suggestDisambiguations(src, 'f.ts', { llm });
    const items = disambiguationItems(result);
    expect(items).toEqual([{ id: result.clusters[0].offenders[0].id, to: 'retryCount' }]);
  });
});