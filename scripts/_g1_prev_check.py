# 精简验证：导览播放器 prev 回退
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={"width": 1400, "height": 900})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    pg.goto("http://localhost:3100/tour.html?feature=self_analyze")
    pg.wait_for_timeout(2000)
    # 等 iframe 加载完第一个产物
    pg.wait_for_function("document.getElementById('frame').src.includes('self_analyze.html')", timeout=10000)
    print("INIT_PROG=", pg.locator("#prog").inner_text().strip())
    # 下一步
    pg.locator("#next").click()
    pg.wait_for_timeout(800)
    print("NEXT_ALL=", pg.evaluate("""() => ({
      prog: document.getElementById('prog').textContent,
      prevDisabled: document.getElementById('prev').disabled,
      nextDisabled: document.getElementById('next').disabled,
      src: document.getElementById('frame').src,
      dots: Array.from(document.querySelectorAll('#dots .dot')).map(d => d.className)
    })"""))
    pg.wait_for_function("document.getElementById('frame').src.includes('monolith_report.html')", timeout=10000)
    print("NEXT_ALL_AFTERLOAD=", pg.evaluate("""() => ({
      prog: document.getElementById('prog').textContent,
      prevDisabled: document.getElementById('prev').disabled,
      src: document.getElementById('frame').src,
      dots: Array.from(document.querySelectorAll('#dots .dot')).map(d => d.className)
    })"""))
    # 上一步
    pg.locator("#prev").click()
    pg.wait_for_function("document.getElementById('frame').src.includes('self_analyze.html')", timeout=10000)
    print("PREV_PROG=", pg.locator("#prog").inner_text().strip())
    print("PREV_FIRST_DOT=", pg.locator("#dots .dot").first.evaluate("el => el.className"))
    print("PREV_PREV_DISABLED=", pg.locator("#prev").is_disabled())
    print("ERRORS=", errs if errs else "NONE")
    b.close()