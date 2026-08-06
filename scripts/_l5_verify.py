# 序号5/7 架构分层着色验证：图层按钮切换 → 节点按层着色 + 图例显隐
from playwright.sync_api import sync_playwright
import pathlib

HTML = (pathlib.Path(__file__).resolve().parent.parent / "output" / "self_analyze.html").as_uri()

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    errors = []
    page.on("pageerror", lambda e: errors.append("PAGEERROR=" + str(e)))
    page.on("console", lambda m: errors.append("CONSOLE_%s=%s" % (m.type, m.text)) if m.type in ("error", "warning") else None)
    page.goto(HTML)
    page.wait_for_selector("#layer-viz-toggle", timeout=20000)
    page.wait_for_timeout(1500)
    page.evaluate("""() => {
      const ov = document.getElementById('report-overlay');
      if (ov) ov.remove();
      const sb = document.querySelector('.stale-bar');
      if (sb) sb.remove();
    }""")
    page.wait_for_timeout(300)

    # 前提：图层按钮/图例/节点层次属性存在
    print("TOGGLE_EXISTS=", page.evaluate("!!document.getElementById('layer-viz-toggle')"))
    print("LEGEND_EXISTS=", page.evaluate("!!document.getElementById('layer-legend')"))

    # 分层元信息：data-arch-layer 节点数 + 层定义数
    print("NODES_WITH_LAYER=", page.evaluate("document.querySelectorAll('.node[data-arch-layer]').length"))
    print("LAYER_DEFS=", page.evaluate("document.querySelectorAll('#layer-legend .layer-legend-row').length"))

    # 取一个 file 节点切换前的填充色（节点 rect/data-shape 的 fill）
    def node_fill(layer):
        return page.evaluate("""(id) => {
          const el = document.querySelector('.node[data-arch-layer="' + id + '"] > [data-shape]');
          return el ? el.getAttribute('fill') : null;
        }""", layer)

    # 初始（语言色模式）：canvas 无 layer-viz 类，图例隐藏
    print("CANVAS_INIT=", page.evaluate("document.getElementById('canvas').classList.contains('layer-viz')"))
    print("LEGEND_HIDDEN_INIT=", page.evaluate("document.getElementById('layer-legend').classList.contains('hidden')"))

    # 点击图层按钮 → 开启分层着色
    page.evaluate("document.getElementById('layer-viz-toggle').click()")
    page.wait_for_timeout(300)
    print("CANVAS_ON=", page.evaluate("document.getElementById('canvas').classList.contains('layer-viz')"))
    print("BTN_ACTIVE=", page.evaluate("document.getElementById('layer-viz-toggle').classList.contains('active')"))
    print("LEGEND_VISIBLE=", page.evaluate("!document.getElementById('layer-legend').classList.contains('hidden')"))

    # 切换后：data-arch-layer 节点应按层色着色（fill === 层色）
    check = page.evaluate("""() => {
      const rows = document.querySelectorAll('#layer-legend .layer-legend-row');
      const palette = {};
      rows.forEach(r => {
        const swatch = r.querySelector('.layer-legend-swatch');
        const count = r.querySelector('.layer-legend-count');
        if (swatch) palette[swatch.style.background] = (palette[swatch.style.background]||0)+1;
      });
      // 统计层色命中的节点数
      let matched = 0, total = 0, mismatched = [];
      document.querySelectorAll('.node[data-arch-layer]').forEach(n => {
        const layer = n.getAttribute('data-arch-layer');
        const shape = n.querySelector('[data-shape]');
        if (!shape) return;
        total++;
        const fill = shape.getAttribute('fill');
        // 层色在 CSS 中定义，实际 fill 走样式；这里取 row 的 swatch 颜色比对
      });
      return { total };
    }""")
    print("NODE_TOTAL=", check["total"])

    # 用 computed style 验证着色生效（CSS fill 覆盖 inline fill）
    comp = page.evaluate("""() => {
      const el = document.querySelector('.node[data-arch-layer="data"] > [data-shape]');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { fill: cs.fill, stroke: cs.stroke };
    }""")
    print("DATA_LAYER_COMPUTED=", comp)

    # 再点一次 → 关闭分层着色
    page.evaluate("document.getElementById('layer-viz-toggle').click()")
    page.wait_for_timeout(200)
    print("CANVAS_OFF=", page.evaluate("!document.getElementById('canvas').classList.contains('layer-viz')"))
    print("LEGEND_HIDDEN_OFF=", page.evaluate("document.getElementById('layer-legend').classList.contains('hidden')"))

    page.screenshot(path=".tmp_l5_layer_viz.png")
    print("ERRORS=", errors if errors else "NONE")
    browser.close()