# D3 验证：变更影响标红后，受影响边上的动画粒子流转红
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    errors = []
    page.on("pageerror", lambda e: errors.append("PAGEERROR=" + str(e)))
    page.on("console", lambda m: errors.append("CONSOLE_%s=%s" % (m.type, m.text)) if m.type in ("error", "warning") else None)
    page.goto("http://localhost:3100/self_analyze.html")
    page.wait_for_selector("#diff-impact-toggle", timeout=20000)
    page.wait_for_timeout(6000)  # 等动画启动并发射粒子
    page.evaluate("""() => {
      const ov = document.getElementById('report-overlay');
      if (ov) ov.remove();
      const sb = document.querySelector('.stale-bar');
      if (sb) sb.remove();
    }""")
    page.wait_for_timeout(300)

    # 动画已启动？
    print("ANIM_STARTED=", page.evaluate("!!(window.__animV2__ && window.__animV2__.version)"))
    print("PARTICLE_COUNT_BEFORE=", page.evaluate("document.querySelectorAll('.anim-particle-v2').length"))

    # 打开输入面板，手填一个改动文件并分析
    page.evaluate("document.getElementById('diff-impact-toggle').click()")
    page.wait_for_selector("#diff-input-panel", timeout=4000)
    page.locator("#diff-input-files").fill("db/db.ts")
    page.locator("#diff-input-run").click()
    page.wait_for_selector("#diff-panel", timeout=8000)
    page.wait_for_timeout(1500)

    # 受影响边 + 其上的粒子
    impacted_edge_ids = page.evaluate("""() => {
      const ids = [];
      document.querySelectorAll('.edge.impacted').forEach(e => ids.push(e.getAttribute('data-id')));
      return ids;
    }""")
    print("IMPACTED_EDGES=", impacted_edge_ids)

    # 检查受影响边上的粒子 fill 是否为红
    red_particles = 0
    total_on_impacted = 0
    for eid in impacted_edge_ids:
        n = page.evaluate("""(flowId) => {
          const els = document.querySelectorAll('.anim-particle-v2[data-flow-id="' + flowId + '"] circle');
          let red = 0, total = 0;
          els.forEach(c => { total++; if ((c.getAttribute('fill')||'').toLowerCase() === '#ff5252') red++; });
          return { total, red };
        }""", "default_flow_" + eid)
        total_on_impacted += n["total"]
        red_particles += n["red"]
        print(f"  edge {eid}: total={n['total']} red={n['red']}")

    print("TOTAL_ON_IMPACTED=", total_on_impacted, "RED_ON_IMPACTED=", red_particles)
    print("ERRORS=", errors if errors else "NONE")
    page.screenshot(path=".tmp_d3_impact_red.png")
    browser.close()