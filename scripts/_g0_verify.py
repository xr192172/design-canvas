# G0 验证：Hub 首页动态产物总览 + 打标记/编辑
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1500, "height": 1000})
    errors = []
    page.on("pageerror", lambda e: errors.append("PAGEERROR=" + str(e)))
    page.on("console", lambda m: errors.append("CONSOLE_%s=%s" % (m.type, m.text)) if m.type in ("error",) else None)

    page.goto("http://localhost:3100/")
    page.wait_for_selector("#artifact-cards .card", timeout=15000)
    page.wait_for_timeout(600)

    # 1. 产物卡片渲染
    cards = page.locator("#artifact-cards .card")
    print("CARD_COUNT=", cards.count())

    # 2. 分组标题
    groups = page.locator("#artifact-cards .group-title")
    print("GROUPS=", [g.inner_text().strip() for g in groups.all()])

    # 3. 卡片标题/feature/语言/状态
    first = cards.first
    print("FIRST_CARD_TITLE=", first.locator("h3").inner_text().strip())
    print("FIRST_CARD_META=", first.locator(".meta").inner_text().strip())
    print("FIRST_HAS_LANG=", "TS" in first.locator(".card-top").inner_text())
    print("FIRST_HAS_STATUS=", "done" in first.locator(".card-top").inner_text())

    # 4. 打开编辑弹层
    first.locator(".edit").click()
    page.wait_for_selector("#edit-modal", state="visible", timeout=4000)
    print("MODAL_VISIBLE=", page.locator("#edit-modal").is_visible())
    print("MODAL_PATH=", page.locator("#e-path").inner_text().strip())

    # 5. 打标记：标题 + 标签 + 备注 + 状态
    page.locator("#e-title").fill("项目星图（G0 已打标）")
    page.locator("#e-tags").fill("核心, 星图, 导览")
    page.locator("#e-note").fill("G0 验证：手动打标记")
    page.locator("#e-status").select_option("in_progress")
    page.screenshot(path=".tmp_g0_edit_modal.png")
    page.locator("#e-save").click()
    page.wait_for_timeout(800)

    # 6. 保存后卡片应更新（标题/标签/状态）
    page.wait_for_function("document.querySelector('#artifact-cards .card h3 a').textContent.includes('G0 已打标')", timeout=5000)
    print("AFTER_SAVE_TITLE=", page.locator("#artifact-cards .card h3").first.inner_text().strip())
    print("AFTER_SAVE_TAGS=", page.locator("#artifact-cards .tag").all_inner_texts())
    print("AFTER_SAVE_STATUS=", page.locator("#artifact-cards .card-top .cchip").first.inner_text().strip())

    # 7. 搜索过滤
    page.locator("#q").fill("星图")
    page.wait_for_timeout(400)
    print("SEARCH_KONGTU_COUNT=", page.locator("#artifact-cards .card").count())

    # 8. 状态筛选
    page.locator("#q").fill("")
    page.locator("#status-filter").select_option("in_progress")
    page.wait_for_timeout(400)
    print("FILTER_INPROG_COUNT=", page.locator("#artifact-cards .card").count())

    # 9. 关分组
    page.locator("#group-toggle").click()
    page.wait_for_timeout(400)
    print("UNGROUPED_GROUPS=", page.locator("#artifact-cards .group-title").count())

    page.screenshot(path=".tmp_g0_hub.png")
    print("ERRORS=", errors if errors else "NONE")
    browser.close()