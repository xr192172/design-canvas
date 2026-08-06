# D4 验证：从 git diff 自动取改动文件 → 一键分析标红
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    errors = []
    page.on("pageerror", lambda e: errors.append("PAGEERROR=" + str(e)))
    page.on("console", lambda m: errors.append("CONSOLE_%s=%s" % (m.type, m.text)) if m.type in ("error", "warning") else None)
    page.goto("http://localhost:3100/self_analyze.html")
    page.wait_for_selector("#diff-impact-toggle", timeout=20000)
    page.wait_for_timeout(1200)
    page.evaluate("""() => {
      const ov = document.getElementById('report-overlay');
      if (ov) ov.remove();
      const sb = document.querySelector('.stale-bar');
      if (sb) sb.remove();
    }""")
    page.wait_for_timeout(300)

    # 打开输入面板
    page.evaluate("document.getElementById('diff-impact-toggle').click()")
    try:
        page.wait_for_selector("#diff-input-panel", timeout=4000)
        print("PANEL_OPEN=1")
    except Exception as e:
        print("PANEL_OPEN=FAIL")
        print("ERRORS=", errors)
        print("BTN_COUNT=", page.locator("#diff-impact-toggle").count())
        try:
            print("OPEN_FN=", page.evaluate("typeof (window.__OPEN_PROBE)") )
        except Exception:
            pass
        browser.close()
        raise
    print("HAS_GITDIFF_BTN=", page.locator("#diff-input-gitdiff").count())

    # 点击"从 git diff 取"
    page.locator("#diff-input-gitdiff").click()
    page.wait_for_timeout(1200)

    print("FILLED_VALUE_TL=", page.evaluate("document.getElementById('diff-input-files').value.split('\\n')[0]"))
    print("FILLED_COUNT=", page.evaluate("document.getElementById('diff-input-files').value.split('\\n').length"))
    print("PANEL_VISIBLE_AFTER=", page.locator("#diff-input-panel").is_visible())

    # 等待分析完成：输入面板隐藏 + 结果面板出现
    page.wait_for_timeout(1500)
    print("DIFF_PANEL_COUNT=", page.locator("#diff-panel").count())
    print("IMPACTED_NODES=", page.locator(".node.impacted").count())
    print("STATUS=", page.evaluate("(document.getElementById('diff-input-status')||{}).textContent || ''"))
    print("ERRORS=", errors if errors else "NONE")
    browser.close()