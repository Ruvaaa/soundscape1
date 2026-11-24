"""
Tab / system capture with real audio content. A second tab plays kicks_120bpm.wav; Soundgarden
shares it via getDisplayMedia and we check the analyser actually hears it.
Uses Chrome's auto-select flags, because a human normally picks the tab in the browser dialog.
Reports whatever Chrome returns, and does NOT claim more than was observed.
"""
import asyncio, os
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC_PAGE = """<!doctype html><title>SGSOURCE</title><body><audio id=a loop src="/tests/fixtures/kicks_120bpm.wav"></audio>
<script>document.title='SGSOURCE';</script>"""

SAMPLE = """async (ms) => { const f = window.__soundgarden.audio.features; const b0 = f.beatCount; let peak = 0, rmsPeak = 0; const t0 = performance.now();
  while (performance.now() - t0 < ms) { peak = Math.max(peak, f.bass); rmsPeak = Math.max(rmsPeak, f.rms); await new Promise(r => setTimeout(r, 40)); }
  return { peak, rmsPeak, beats: f.beatCount - b0 }; }"""


async def attempt(p, kind, flags):
    b = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=[
        "--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", *flags])
    ctx = await b.new_context(viewport={"width": 1100, "height": 700})
    src = await ctx.new_page()
    await src.route("**/source.html", lambda r: r.fulfill(body=SRC_PAGE, content_type="text/html"))
    await src.goto("http://localhost:5173/source.html")
    await src.evaluate("document.getElementById('a').play()")
    app = await ctx.new_page()
    errs = []
    app.on("pageerror", lambda e: errs.append(str(e)))
    await app.goto("http://localhost:5173/index.html?debug")
    await app.wait_for_function("window.__soundgarden")
    await app.bring_to_front()
    await app.evaluate("document.getElementById('hero-playground').click()")
    await app.click(f'[data-id="{kind}"]')
    await app.click(f'#source-card button:has-text("{"Share a tab" if kind == "tab" else "Share system audio"}")')
    await app.wait_for_function("['live','error'].includes(window.__soundgarden.audio.status.phase)", timeout=15000)
    st = await app.evaluate("window.__soundgarden.audio.status")
    out = {"kind": kind, "phase": st["phase"], "code": st["code"], "detail": st["detail"], "surface": st["info"].get("surface")}
    if st["phase"] == "live":
        out.update(await app.evaluate(SAMPLE, 6000))
        tracks = await app.evaluate("window.__t = window.__soundgarden.audio.source.stream.getTracks(); window.__t.map(t => t.kind + ':' + t.readyState)")
        # user clicks the browser's "Stop sharing": simulated with the tracks' own 'ended' event
        await app.evaluate("window.__t.forEach(t => t.dispatchEvent(new Event('ended')))")
        await app.wait_for_function("window.__soundgarden.audio.status.phase === 'ended'", timeout=5000)
        out["after_end"] = await app.evaluate("({src: window.__soundgarden.audio.source, tracks: window.__t.map(t => t.readyState)})")
        out["tracks_before"] = tracks
    out["page_errors"] = errs
    await b.close()
    return out


async def main():
    async with async_playwright() as p:
        print(await attempt(p, "tab", ["--auto-select-tab-capture-source-by-title=SGSOURCE"]))
        print(await attempt(p, "system", ["--auto-select-desktop-capture-source=Entire screen"]))

asyncio.run(main())
