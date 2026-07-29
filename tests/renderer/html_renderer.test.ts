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

  it('conveyor 的 33 个节点都有 rect', () => {
    const html = renderHTML(conveyor as DesignDSL);
    const nodeMatches = html.match(/class="node[^"]*"/g);
    expect(nodeMatches).not.toBeNull();
    expect(nodeMatches!.length).toBe(33);
  });

  it('conveyor 的 33 条边（5 条流向 + 21 条 contains + 4 条扩展 + 3 条 detail 变形链）', () => {
    const html = renderHTML(conveyor as DesignDSL);
    const edgeMatches = html.match(/class="edge"/g);
    expect(edgeMatches).not.toBeNull();
    expect(edgeMatches!.length).toBe(33);
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

describe('renderHTML - 职责分层', () => {
  function makeLayeredDSL(): DesignDSL {
    const dsl = makeMinimalDSL();
    dsl.geometry.nodes.push(
      { id: 'err1', x: 10, y: 200, width: 100, height: 50, label: '异常处理', layer: 'error', host: 'n1' },
      { id: 'det1', x: 200, y: 200, width: 100, height: 50, label: '实现细节', layer: 'detail', host: 'n2' },
    );
    dsl.geometry.edges!.push(
      { id: 'e_err', from: 'n1', to: 'err1', label: 'on error' },
      { id: 'e_det', from: 'n2', to: 'det1', label: '内部步骤' },
    );
    return dsl;
  }

  it('深层节点渲染 display:none + data-layer + data-host', () => {
    const html = renderHTML(makeLayeredDSL());
    // error 节点
    expect(html).toMatch(/<g class="node[^"]*" data-id="err1"[^>]*data-layer="error"/);
    expect(html).toMatch(/data-id="err1"[^>]*data-host="n1"/);
    expect(html).toMatch(/data-id="err1"[^>]*style="display:none"/);
    // detail 节点
    expect(html).toMatch(/data-id="det1"[^>]*data-layer="detail"/);
    expect(html).toMatch(/data-id="det1"[^>]*style="display:none"/);
  });

  it('main 节点不带 data-layer / display:none', () => {
    const html = renderHTML(makeLayeredDSL());
    const n1Match = html.match(/<g class="node[^"]*" data-id="n1"[^>]*>/);
    expect(n1Match).toBeTruthy();
    expect(n1Match![0]).not.toContain('data-layer');
    expect(n1Match![0]).not.toContain('display:none');
  });

  it('边层自动推导：跟随端点较深层', () => {
    const html = renderHTML(makeLayeredDSL());
    // n1(main)→err1(error) 的边推导为 error 层并隐藏
    expect(html).toMatch(/data-id="e_err"[^>]*data-layer="error"[^>]*style="display:none"/);
    expect(html).toMatch(/data-id="e_det"[^>]*data-layer="detail"[^>]*style="display:none"/);
    // main 边不受影响
    const e1Match = html.match(/<g class="edge" data-id="e1"[^>]*>/);
    expect(e1Match).toBeTruthy();
    expect(e1Match![0]).not.toContain('data-layer');
    expect(e1Match![0]).not.toContain('display:none');
  });

  it('边显式 layer 优先于端点推导', () => {
    const dsl = makeLayeredDSL();
    // 显式把 main→main 的边标为 error（罕见但合法）
    dsl.geometry.edges![0].layer = 'error';
    const html = renderHTML(dsl);
    expect(html).toMatch(/data-id="e1"[^>]*data-layer="error"[^>]*style="display:none"/);
  });

  it('有深层节点时渲染层开关按钮（带计数），无则不渲染', () => {
    const html = renderHTML(makeLayeredDSL());
    expect(html).toContain('id="layer-error-toggle"');
    expect(html).toContain('id="layer-detail-toggle"');
    expect(html).toContain('🛡 1');
    expect(html).toContain('🧩 1');

    // 注意：scripts 内联代码里也有同名字符串，必须匹配 HTML 按钮形式
    const plain = renderHTML(makeMinimalDSL());
    expect(plain).not.toContain('id="layer-error-toggle"');
    expect(plain).not.toContain('id="layer-detail-toggle"');
  });

  it('F3：flow 激活门控注入内联脚本（端点隐藏时 flow 整体不执行）', () => {
    const html = renderHTML(makeMinimalDSL());
    // 门控函数 + spawnDefaultParticle 入口检查都在内联动画脚本里
    expect(html).toContain('function flowDomVisible(flow)');
    expect(html).toContain('if (!flowDomVisible(flow)) return;');
  });

  it('缩放钻入动效：相机补间 + 检查点 + 钻入/退回函数注入', () => {
    const html = renderHTML(makeMinimalDSL());
    // 相机动效核心
    expect(html).toContain('function animateCamera(');
    expect(html).toContain('function easeInOutCubic(');
    // 钻入/退回
    expect(html).toContain('function drillIntoHost(');
    expect(html).toContain('function drillOutOfHost(');
    expect(html).toContain('function cameraFitNodes(');
    // 检查点（退路机制）：展开前记录、收起时恢复
    expect(html).toContain('cameraAnim.checkpoints[key] = { scale: canvasState.scale');
    expect(html).toContain('delete cameraAnim.checkpoints[key]');
    // 闭包相机句柄暴露
    expect(html).toContain('canvasState.updateViewBox = updateViewBox');
    expect(html).toContain('canvasState.fitVisibleContent = fitVisibleContent');
  });

  it('F2 推导：handler.errors.to 节点自动 error 层 + host=flow.from', () => {
    const dsl = makeMinimalDSL();
    dsl.geometry.nodes.push({ id: 'err_sink', x: 10, y: 200, width: 100, height: 50, label: '错误池' });
    dsl.animations_v2 = {
      version: 1,
      flows: [
        {
          id: 'f1',
          trigger: { type: 'periodic', interval: 3000 },
          from: 'n1',
          to: 'n2',
          handler: {
            file_id: 'n1',
            api: 'Do',
            errors: [{ type: 'panic', condition: 'result.panic', severity: 'unexpected', to: 'err_sink' }],
          },
        },
      ],
    };
    const html = renderHTML(dsl);
    // err_sink 无显式 layer → 推导为 error，host=n1
    expect(html).toMatch(/data-id="err_sink"[^>]*data-layer="error"/);
    expect(html).toMatch(/data-id="err_sink"[^>]*data-host="n1"/);
    // 注入的 DSL JSON 也被烘焙（浏览器端单源消费）
    expect(html).toMatch(/"id":"err_sink"[^}]*"layer":"error"/);
  });

  it('F2 推导：显式 layer 不被覆盖；host 指向不存在节点时丢弃 host', () => {
    const dsl = makeMinimalDSL();
    dsl.geometry.nodes.push(
      { id: 'err_a', x: 10, y: 200, width: 100, height: 50, label: '显式 detail', layer: 'detail' },
      { id: 'err_b', x: 200, y: 200, width: 100, height: 50, label: '孤儿' },
    );
    dsl.animations_v2 = {
      version: 1,
      flows: [
        {
          id: 'f1',
          trigger: { type: 'periodic', interval: 3000 },
          from: 'ghost', // 不存在的节点
          to: 'n1',
          handler: {
            file_id: 'n1',
            api: 'Do',
            errors: [
              { type: 'e1', condition: 'x', severity: 'expected', to: 'err_a' },
              { type: 'e2', condition: 'y', severity: 'expected', to: 'err_b' },
            ],
          },
        },
      ],
    };
    const html = renderHTML(dsl);
    // 显式 detail 不被推导覆盖
    expect(html).toMatch(/data-id="err_a"[^>]*data-layer="detail"/);
    expect(html).not.toMatch(/data-id="err_a"[^>]*data-layer="error"/);
    // host=ghost 不存在 → err_b 推导为 error 但无 data-host
    expect(html).toMatch(/data-id="err_b"[^>]*data-layer="error"/);
    const bMatch = html.match(/<g class="node[^"]*" data-id="err_b"[^>]*>/);
    expect(bMatch![0]).not.toContain('data-host');
  });
});

describe('renderHTML - D1 数据形状卡', () => {
  function makeShapedDSL(): DesignDSL {
    const dsl = makeMinimalDSL();
    dsl.geometry.nodes.push({
      id: 'shape_node',
      x: 10,
      y: 200,
      label: '进料口',
      layer: 'detail',
      host: 'n1',
      shapes: {
        in: {
          type: 'object',
          properties: { token: { type: 'string' } },
          required: ['token'],
        },
        out: {
          type: 'object',
          properties: {
            user_id: { type: 'integer' },
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    });
    return dsl;
  }

  it('形状卡渲染进/出人话形状（schemaToHuman 转换）', () => {
    const html = renderHTML(makeShapedDSL());
    expect(html).toContain('class="shape-card"');
    expect(html).toContain('<span class="shape-dir">进</span>');
    expect(html).toContain('<span class="shape-dir">出</span>');
    expect(html).toContain('{token: 字符串}');
    expect(html).toContain('{user_id: 整数, tags: 字符串[]}');
  });

  it('形状卡节点标签置顶 + 卡片在标签下方', () => {
    const html = renderHTML(makeShapedDSL());
    // 标签 y = 节点 y + 18（置顶），卡片 foreignObject y = 节点 y + 28
    expect(html).toMatch(/<text x="130" y="218"[^>]*>进料口<\/text>/);
    expect(html).toMatch(/<foreignObject x="16" y="228"[^>]*><div[^>]*class="shape-card"/);
  });

  it('形状卡节点默认尺寸放大（240 × 34+行*24+10）', () => {
    const html = renderHTML(makeShapedDSL());
    // 2 行 → 高 34+48+10=92
    expect(html).toMatch(/<rect data-shape="true" x="10" y="200" width="240" height="92"/);
  });

  it('无 shapes 节点不渲染形状卡，显式尺寸优先', () => {
    const dsl = makeShapedDSL();
    dsl.geometry.nodes[2].width = 300;
    dsl.geometry.nodes[2].height = 100;
    const html = renderHTML(dsl);
    expect(html).toMatch(/<rect data-shape="true" x="10" y="200" width="300" height="100"/);
    // n1/n2 无 shapes → 无卡片
    const n1Match = html.match(/<g class="node[^"]*" data-id="n1"[\s\S]*?<\/g>/);
    expect(n1Match![0]).not.toContain('shape-card');
  });

  it('形状卡 XSS 转义（label 中的 HTML 不注入）', () => {
    const dsl = makeMinimalDSL();
    dsl.geometry.nodes.push({
      id: 'evil',
      x: 0,
      y: 0,
      shapes: { in: { type: 'string', label: '<script>alert(1)</script>' } },
    });
    const html = renderHTML(dsl);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
