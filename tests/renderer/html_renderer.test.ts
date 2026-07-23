import { describe, it, expect } from 'vitest';
import { renderHTML } from '../../src/renderer/html_renderer';
import type { DesignDSL } from '../../src/dsl/types';
import conveyor from '../../examples/conveyor.json';

function makeMinimalDSL(): DesignDSL {
  return {
    id: 'test',
    type: 'feature_diagram',
    feature: 'test',
    geometry: {
      layout: 'free',
      width: 500,
      height: 300,
      nodes: [
        {
          id: 'n1',
          x: 10,
          y: 10,
          width: 100,
          height: 50,
          label: '节点 1',
          style: { bg: '#0f3460', color: '#fff', borderRadius: 8 },
        },
        {
          id: 'n2',
          x: 200,
          y: 10,
          width: 100,
          height: 50,
          label: '节点 2',
        },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2', label: 'calls' }],
    },
    semantic: {
      files: [
        {
          id: 'n1',
          path: 'a.go',
          responsibility: 'A 模块',
          expected_apis: [{ signature: 'A.Do()', notes: 'do something' }],
          expected_deps: [],
        },
        {
          id: 'n2',
          path: 'b.go',
          responsibility: 'B 模块',
        },
      ],
      multi_file_invariants: ['b 必须调 a'],
    },
    annotations: [
      { id: 'a1', target_id: 'n1', text: '注意', author: 'human' },
    ],
  };
}

describe('renderHTML - 基本结构', () => {
  it('生成完整 HTML 文档（含 doctype）', () => {
    const html = renderHTML(makeMinimalDSL());
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('</html>');
  });

  it('内联所有 CSS（无外部样式表链接）', () => {
    const html = renderHTML(makeMinimalDSL());
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
    expect(html).toContain('<style>');
  });

  it('内联所有 JS（无外部 script src）', () => {
    const html = renderHTML(makeMinimalDSL());
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).toContain('<script>');
  });

  it('DSL JSON 嵌入到 window.__DSL__', () => {
    const dsl = makeMinimalDSL();
    const html = renderHTML(dsl);
    expect(html).toContain('window.__DSL__');
    // 嵌入的 JSON 应能 parse 回原 DSL
    const startMarker = 'window.__DSL__ = ';
    const endMarker = ';\n/* __DSL_END__ */';
    const startIdx = html.indexOf(startMarker);
    const endIdx = html.indexOf(endMarker, startIdx);
    expect(startIdx).not.toBe(-1);
    expect(endIdx).not.toBe(-1);
    const jsonStr = html.slice(startIdx + startMarker.length, endIdx);
    const parsed = JSON.parse(jsonStr);
    expect(parsed.feature).toBe('test');
    expect(parsed.geometry.nodes).toHaveLength(2);
  });
});

describe('renderHTML - 几何层渲染', () => {
  it('渲染 SVG 画布', () => {
    const html = renderHTML(makeMinimalDSL());
    expect(html).toContain('<svg');
    expect(html).toContain('viewBox="0 0 500 300"');
  });

  it('渲染节点 rect + text', () => {
    const html = renderHTML(makeMinimalDSL());
    expect(html).toContain('class="node status-draft"');
    expect(html).toContain('data-id="n1"');
    expect(html).toContain('data-id="n2"');
    expect(html).toContain('<rect');
    expect(html).toContain('节点 1');
    expect(html).toContain('节点 2');
  });

  it('渲染边 path + 箭头 marker', () => {
    const html = renderHTML(makeMinimalDSL());
    expect(html).toContain('class="edge"');
    expect(html).toContain('data-id="e1"');
    expect(html).toContain('marker-end="url(#arrow)"');
    expect(html).toContain('calls'); // 边标签
  });

  it('应用节点 style（bg/color/borderRadius）', () => {
    const html = renderHTML(makeMinimalDSL());
    expect(html).toContain('fill="#0f3460"');
    expect(html).toContain('rx="8"');
  });

  it('画布尺寸从节点推导（无 width/height 时）', () => {
    const dsl = makeMinimalDSL();
    delete dsl.geometry.width;
    delete dsl.geometry.height;
    const html = renderHTML(dsl);
    // 节点最大 x+w=300，y+h=60，加 50 padding → 350x110
    expect(html).toContain('viewBox="0 0 350 110"');
  });
});

describe('renderHTML - 语义层渲染', () => {
  it('渲染 semantic 卡片（path / responsibility / API）', () => {
    const html = renderHTML(makeMinimalDSL());
    expect(html).toContain('class="card"');
    expect(html).toContain('data-id="n1"');
    expect(html).toContain('a.go');
    expect(html).toContain('A 模块');
    expect(html).toContain('A.Do()');
  });

  it('渲染不变式列表', () => {
    const html = renderHTML(makeMinimalDSL());
    expect(html).toContain('class="invariants"');
    expect(html).toContain('不变式 (1)');
    expect(html).toContain('b 必须调 a');
  });

  it('无 semantic 时不报错（纯示意图）', () => {
    const dsl = makeMinimalDSL();
    delete dsl.semantic;
    const html = renderHTML(dsl);
    expect(html).toContain('无语义层信息');
  });
});

describe('renderHTML - 顶部 / 底部', () => {
  it('header 显示 feature + status + 文件数 + 不变式数', () => {
    const html = renderHTML(makeMinimalDSL());
    expect(html).toContain('<h1>test</h1>');
    expect(html).toContain('status-draft'); // 默认 status
    expect(html).toContain('2 文件');
    expect(html).toContain('1 不变式');
  });

  it('header 显示 title（如有）', () => {
    const dsl = makeMinimalDSL();
    dsl.title = '测试图';
    dsl.status = 'in_progress';
    const html = renderHTML(dsl);
    expect(html).toContain('测试图');
    expect(html).toContain('status-in_progress');
  });

  it('footer 包含导出按钮和重新渲染按钮', () => {
    const html = renderHTML(makeMinimalDSL());
    expect(html).toContain('id="export-json"');
    expect(html).toContain('id="rerender"');
    expect(html).toContain('导出 design-canvas.json');
  });
});

describe('renderHTML - conveyor 示例', () => {
  it('完整 conveyor DSL 能渲染', () => {
    const html = renderHTML(conveyor as DesignDSL);
    expect(html).toContain('<svg');
    expect(html).toContain('L0 永久层');
    expect(html).toContain('CurrentRound');
    expect(html).toContain('SectionQueue');
    expect(html).toContain('DraftZone');
    expect(html).toContain('DynamicInjection');
  });

  it('conveyor 的 29 个节点都有 rect', () => {
    const html = renderHTML(conveyor as DesignDSL);
    const nodeMatches = html.match(/class="node[^"]*"/g);
    expect(nodeMatches).not.toBeNull();
    expect(nodeMatches!.length).toBe(29);
  });

  it('conveyor 的 30 条边（5 条流向 + 21 条 contains + 4 条扩展）', () => {
    const html = renderHTML(conveyor as DesignDSL);
    const edgeMatches = html.match(/class="edge"/g);
    expect(edgeMatches).not.toBeNull();
    expect(edgeMatches!.length).toBe(30);
  });

  it('conveyor 的 3 条标注通过 window.__DSL__ 暴露（供 tooltip 使用）', () => {
    const html = renderHTML(conveyor as DesignDSL);
    expect(html).toContain('anno_kv_cache');
    expect(html).toContain('anno_fold_params');
    expect(html).toContain('anno_gc_removed');
  });
});

describe('renderHTML - 安全性', () => {
  it('label 中的 HTML 字符被转义', () => {
    const dsl = makeMinimalDSL();
    dsl.geometry.nodes[0].label = '<script>alert(1)</script>';
    const html = renderHTML(dsl);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('DSL JSON 嵌入时 </script> 被转义防止注入', () => {
    const dsl = makeMinimalDSL();
    dsl.geometry.nodes[0].label = '</script><script>alert(1)</script>';
    const html = renderHTML(dsl);
    // 应该找不到真正的 </script><script> 序列
    expect(html).not.toMatch(/<\/script><script>alert/);
  });
});
