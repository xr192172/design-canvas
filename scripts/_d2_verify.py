from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    page.goto("http://localhost:3100/self_analyze.html")
    page.wait_for_selector("#diff-impact-toggle", timeout=20000)
    page.on("pageerror", lambda e: print("PAGEERROR=", e))
    page.on("console", lambda m: print("CONSOLE_%s=" % m.type, m.text) if m.type in ("error", "warning") else None)
    page.wait_for_timeout(1200)

    # 0. 移除导读面板遮罩与过期横幅，避免拦截点击
    page.evaluate("""() => {
      const ov = document.getElementById('report-overlay');
      if (ov) ov.remove();
      const sb = document.querySelector('.stale-bar');
      if (sb) sb.remove();
    }""")
    page.wait_for_timeout(300)

    # 1. 打开输入面板（evaluate dispatch click + 检查 body 是否含面板 DOM）
    page.evaluate("""() => {
      const b = document.getElementById('diff-impact-toggle');
      b.dispatchEvent(new MouseEvent('click', {bubbles: true}));
      return {panel: !!document.getElementById('diff-input-panel')};
    }""")
    page.wait_for_timeout(500)
    print("INPUT_PANEL_COUNT=", page.locator("#diff-input-panel").count())
    print("BODY_HAS_PANEL_MARKER=", page.evaluate("document.body.innerHTML.includes('diff-input-panel')"))
    print("BUTTON_CLICKED_OK=1")

    # 2. 填变更文件
    page.locator("#diff-input-files").fill("db/db.ts")
    page.screenshot(path=".tmp_d2_2_input.png")

    # 3. 分析并标红
    page.locator("#diff-input-run").click()
    page.wait_for_selector("#diff-panel", timeout=8000)
    page.wait_for_timeout(800)

    # 4. 验证标红节点
    impacted = page.locator(".node.impacted").count()
    impacted_direct = page.locator(".node.impacted-direct").count()
    impacted_edges = page.locator(".edge.impacted").count()
    print("IMPACTED_NODES=", impacted)
    print("IMPACTED_DIRECT=", impacted_direct)
    print("IMPACTED_EDGES=", impacted_edges)

    # 5. 面板内容
    panel = page.locator("#diff-panel")
    print("PANEL_TEXT_SNIPPET=", (panel.inner_text().replace("\\n", " | ")[:300] if panel.count() else "N/A"))
    page.screenshot(path=".tmp_d2_3_result.png")

    # 6. 点击面板中一个间接波及文件行，验证飞行
    indirect_row = page.locator("#diff-panel .focus-row").nth(0)
    if indirect_row.count():
        indirect_row.click()
        page.wait_for_timeout(800)
        print("ROW_CLICKED_OK=1")
        page.screenshot(path=".tmp_d2_4_after_click.png")

    browser.close()