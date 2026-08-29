import { describe, it, expect } from 'vitest';
import { validateDSL, validateDSLJson } from '../../src/dsl/validator';
import type { DesignDSL } from '../../src/dsl/types';

/** 构造一个最小合法 DSL 用于测试 */
function makeValid(): DesignDSL {
  return {
    id: 'test_diagram',
    type: 'feature_diagram',
    feature: 'test',
    geometry: {
      layout: 'free',
      nodes: [
        { id: 'n1', x: 0, y: 0, width: 100, height: 50, label: '节点 1' },
        { id: 'n2', x: 120, y: 0, width: 100, height: 50, label: '节点 2' },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2', label: 'calls' }],
    },
    semantic: {
      files: [
        {
          id: 'n1',
          path: 'a.go',
          responsibility: 'A',
          expected_apis: [{ signature: 'A.Do()' }],
          expected_deps: [],
        },
        {
          id: 'n2',
          path: 'b.go',
          responsibility: 'B',
        },
      ],
      multi_file_invariants: ['b 必须调 a'],
    },
    annotations: [
      { id: 'a1', target_id: 'n1', text: '注意', author: 'human' },
    ],
  };
}

describe('validateDSL - 合法 DSL', () => {
  it('最小合法 DSL 通过校验', () => {
    const result = validateDSL(makeValid());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('无 semantic 的纯示意图通过校验', () => {
    const dsl = makeValid();
    delete dsl.semantic;
    const result = validateDSL(dsl);
    expect(result.valid).toBe(true);
  });

  it('无 annotations 通过校验', () => {
    const dsl = makeValid();
    delete dsl.annotations;
    const result = validateDSL(dsl);
    expect(result.valid).toBe(true);
  });
});

describe('validateDSL - 必填字段缺失', () => {
  it('缺 id 报错', () => {
    const dsl = makeValid() as Partial<DesignDSL>;
    delete dsl.id;
    const result = validateDSL(dsl);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('id'))).toBe(true);
  });

  it('缺 type 报错', () => {
    const dsl = makeValid() as Partial<DesignDSL>;
    delete dsl.type;
    const result = validateDSL(dsl);
    expect(result.valid).toBe(false);
  });

  it('缺 feature 报错', () => {
    const dsl = makeValid() as Partial<DesignDSL>;
    delete dsl.feature;
    const result = validateDSL(dsl);
    expect(result.valid).toBe(false);
  });

  it('缺 geometry 报错', () => {
    const dsl = makeValid() as Partial<DesignDSL>;
    delete dsl.geometry;
    const result = validateDSL(dsl);
    expect(result.valid).toBe(false);
  });

  it('缺 geometry.nodes 报错', () => {
    const dsl = makeValid();
    dsl.geometry = { layout: 'free' } as DesignDSL['geometry'];
    const result = validateDSL(dsl);
    expect(result.valid).toBe(false);
  });

  it('type 不是 "feature_diagram" 报错', () => {
    const dsl = makeValid();
    (dsl as { type: string }).type = 'wrong_type';
    const result = validateDSL(dsl);
    expect(result.valid).toBe(false);
  });
});

describe('validateDSL - 节点字段校验', () => {
  it('node 缺 id 报错', () => {
    const dsl = makeValid();
    // 删掉一个 node 的 id
    delete (dsl.geometry.nodes[0] as Partial<{ id: string }>).id;
    const result = validateDSL(dsl);
    expect(result.valid).toBe(false);
  });

  it('edge 缺 from/to 报错', () => {
    const dsl = makeValid();
    delete (dsl.geometry.edges![0] as Partial<{ from: string }>).from;
    const result = validateDSL(dsl);
    expect(result.valid).toBe(false);
  });

  it('semantic.file 缺 path 报错', () => {
    const dsl = makeValid();
    delete (dsl.semantic!.files[0] as Partial<{ path: string }>).path;
    const result = validateDSL(dsl);
    expect(result.valid).toBe(false);
  });
});

describe('validateDSL - 语义校验（schema 之外）', () => {
  it('nodes.id 重复报错', () => {
    const dsl = makeValid();
    dsl.geometry.nodes[1].id = 'n1'; // 与第一个重复
    const result = validateDSL(dsl);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('duplicate_id'))).toBe(true);
  });

  it('semantic.files.id 在 nodes 中找不到报错（锚定完整性）', () => {
    const dsl = makeValid();
    dsl.semantic!.files[0].id = 'not_exists';
    const result = validateDSL(dsl);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('anchor_broken'))).toBe(true);
  });

  it('edge.from 指向不存在的 node 报错', () => {
    const dsl = makeValid();
    dsl.geometry.edges![0].from = 'ghost_node';
    const result = validateDSL(dsl);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('dangling_edge'))).toBe(true);
  });

  it('annotation.target_id 既不在 nodes 也不在 edges 报错', () => {
    const dsl = makeValid();
    dsl.annotations = [
      { id: 'a1', target_id: 'ghost', text: 'x' },
    ];
    const result = validateDSL(dsl);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('dangling_annotation'))).toBe(true);
  });

  it('annotation 指向 edge.id 也合法', () => {
    const dsl = makeValid();
    dsl.annotations = [
      { id: 'a1', target_id: 'e1', text: '指向边' },
    ];
    const result = validateDSL(dsl);
    expect(result.valid).toBe(true);
  });
});

describe('validateDSLJson - 字符串入口', () => {
  it('合法 JSON 字符串通过，并返回 dsl 对象', () => {
    const json = JSON.stringify(makeValid());
    const result = validateDSLJson(json);
    expect(result.valid).toBe(true);
    expect(result.dsl).toBeDefined();
    expect(result.dsl!.feature).toBe('test');
  });

  it('JSON 解析失败时报错', () => {
    const result = validateDSLJson('{ not json');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('json_parse'))).toBe(true);
    expect(result.dsl).toBeUndefined();
  });

  it('JSON 合法但 schema 不通过的字符串报错', () => {
    const result = validateDSLJson(JSON.stringify({ foo: 'bar' }));
    expect(result.valid).toBe(false);
  });
});
