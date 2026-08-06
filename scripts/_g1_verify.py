# G1 验证：跨产物导览播放器
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1500, "height": 1000})
    errors = []
    page.on("pageerror", lambda e: errors.append("PAGEERROR=" + str(e)))
    page.on("console", lambda m: errors.append("CONSOLE_%s=%s" % (m.type, m.text)) if m.type in ("error",) else None)

    # 0. /api/tour 端点
    r = page.request.get("http://localhost:3100/api/tour?feature=self_analyze")
    j = r.json()
    print("TOUR_API_STEPS=", [s["path"] for s in j["steps"]])
    print("TOUR_API_FEATURE=", j["feature"])

    # 1. Hub 分组应有「▶ 导览」按钮
    page.goto("http://localhost:3100/")
    page.wait_for_selector("#artifact-cards .group-title .tour-btn", timeout=15000)
    print("TOUR_BTN_TEXT=", page.locator("#artifact-cards .group-title .tour-btn").inner_text().strip())
    print("TOUR_BTN_HREF=", page.locator("#artifact-cards .group-title .tour-btn").get_attribute("href"))

    # 2. 打开导览播放器（直接导航）
    page.goto("http://localhost:3100/tour.html?feature=self_analyze")
    page.wait_for_timeout(1500)
    print("FRAME_EXISTS=", page.evaluate("!!document.getElementById('frame')"))
    page.wait_for_selector("#frame", state="attached", timeout=8000)
    page.wait_for_timeout(2500)

    popup = page
    print("PLAYER_TITLE=", popup.locator("#ftitle").inner_text().strip())
    print("PLAYER_PROG=", popup.locator("#prog").inner_text().strip())
    print("DOT_COUNT=", popup.locator("#dots .dot").count())
    cur_first = "CUR_DOT_0=" + str(popup.locator("#dots .dot").first.evaluate("el => el.className"))
    print(cur_first)
    print("IFRAME_SRC_0=", popup.locator("#frame").get_attribute("src"))
    print("PREV_DISABLED=", popup.locator("#prev").is_disabled())

    # 3. 下一步 → 切到第 2 个产物
    popup.locator("#next").click()
    popup.wait_for_timeout(2500)
    print("AFTER_NEXT_PROG=", popup.locator("#prog").inner_text().strip())
    print("CUR_DOT_1=", popup.locator("#dots .dot").nth(1).evaluate("el => el.className"))
    print("IFRAME_SRC_1=", popup.locator("#frame").get_attribute("src"))

    # 4. 上一步 → 回到第 1 个
    popup.locator("#prev").click()
    popup.wait_for_timeout(2000)
    print("AFTER_PREV_PROG=", popup.locator("#prog").inner_text().strip())
    print("CUR_DOT_0_AGAIN=", popup.locator("#dots .dot").first.evaluate("el => el.className"))

    # 5. 点进度点直接跳第 2 个
    popup.locator("#dots .dot").nth(1).click()
    popup.wait_for_timeout(2000)
    print("DOTJUMP_PROG=", popup.locator("#prog").inner_text().strip())

    popup.screenshot(path=".tmp_g1_player.png")
    print("ERRORS=", errors if errors else "NONE")
    browser.close()