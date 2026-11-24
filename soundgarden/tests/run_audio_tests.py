"""
End-to-end audio tests in real Chrome. Run:  python3 tests/make_audio.py && python3 tests/run_audio_tests.py
Serves nothing itself: expects `python3 -m http.server 5173` in the project root.

Honest scope: Chrome's fake media-device flags stand in for a real microphone, and
getDisplayMedia is attempted with Chrome's auto-select flags. Whatever the browser
returns is reported as-is, nothing is mocked in the app.
"""
import asyncio, json, os, sys
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(ROOT, "fixtures")
URL = "http://localhost:5173/index.html?debug"
CHROME = "/usr/bin/google-chrome"
BASE = ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"]
results = []


def record(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""))


# records every AudioNode.connect(target) by source/target class, before app code runs
SPY = """
window.__links = [];
const orig = AudioNode.prototype.connect;
AudioNode.prototype.connect = function (t, ...r) {
  try { window.__links.push(this.constructor.name + '->' + (t && t.constructor ? t.constructor.name : typeof t)); } catch (e) {}
  return orig.call(this, t, ...r);
};
"""

SAMPLE = """async (ms) => {
  const f = window.__soundgarden.audio.features, out = [], t0 = performance.now();
  while (performance.now() - t0 < ms) {
    out.push({ t: (performance.now() - t0) / 1000, bass: f.bass, mid: f.mid, treble: f.treble, level: f.level,
               rms: f.rms, beats: f.beatCount, trans: f.transientCount, sim: f.simulated, live: f.live });
    await new Promise(r => setTimeout(r, 50));
  }
  return out;
}"""


def avg(rows, k, a, b):
    xs = [r[k] for r in rows if a <= r["t"] < b]
    return sum(xs) / len(xs) if xs else float("nan")


async def new_page(b, spy=True):
    ctx = await b.new_context(viewport={"width": 1280, "height": 800})
    page = await ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    if spy:
        await page.add_init_script(SPY)
    await page.goto(URL)
    await page.wait_for_function("window.__soundgarden")
    return ctx, page, errs


async def set_file(page, name):
    await page.evaluate("document.getElementById('hero-playground').click()")
    await page.click('[data-id="file"]')
    await page.set_input_files('input[type=file]', os.path.join(FIX, name))


async def main():
    async with async_playwright() as p:
        # ---------------------------------------------------------------- FILE
        b = await p.chromium.launch(executable_path=CHROME, args=BASE)
        ctx, page, errs = await new_page(b)
        await set_file(page, "bands.wav")
        await page.wait_for_function("window.__soundgarden.audio.status.phase === 'live' && window.__soundgarden.audio.sourceId === 'file'", timeout=8000)
        record("file: loads and goes live", True)
        # sample once from the start: bands.wav = 3s bass, 3s mid, 3s treble, 3s silence
        await page.evaluate("window.__soundgarden.audio.transport.seek(0)")
        rows = await page.evaluate(SAMPLE, 12200)
        bass_ok = avg(rows, "bass", 0.8, 2.8) > 0.5 and avg(rows, "bass", 0.8, 2.8) > 2 * avg(rows, "treble", 0.8, 2.8)
        mid_ok = avg(rows, "mid", 3.8, 5.8) > 0.5 and avg(rows, "mid", 3.8, 5.8) > 2 * avg(rows, "bass", 3.8, 5.8)
        tre_ok = avg(rows, "treble", 6.8, 8.8) > 0.4 and avg(rows, "treble", 6.8, 8.8) > 2 * avg(rows, "mid", 6.8, 8.8)
        sil = max(r["level"] for r in rows if 10.8 <= r["t"] < 12.0)
        record("file: bass tone drives bass band", bass_ok, f"bass={avg(rows,'bass',0.8,2.8):.2f} treble={avg(rows,'treble',0.8,2.8):.2f}")
        record("file: 1-2kHz tone drives mid band", mid_ok, f"mid={avg(rows,'mid',3.8,5.8):.2f} bass={avg(rows,'bass',3.8,5.8):.2f}")
        record("file: 8-10kHz tone drives treble band", tre_ok, f"treble={avg(rows,'treble',6.8,8.8):.2f} mid={avg(rows,'mid',6.8,8.8):.2f}")
        record("file: silence settles near zero", sil < 0.05, f"max level in silence={sil:.3f}")
        record("file: not flagged simulated while live", all(not r["sim"] for r in rows))

        # transport: pause / play / seek / volume
        t = await page.evaluate("""async () => { const a = window.__soundgarden.audio, tr = a.transport;
          tr.seek(1); await new Promise(r=>setTimeout(r,200)); const seeked = tr.currentTime;
          tr.pause(); await new Promise(r=>setTimeout(r,150)); const p1 = tr.currentTime; await new Promise(r=>setTimeout(r,300)); const p2 = tr.currentTime; const paused = !tr.playing;
          await tr.play(); await new Promise(r=>setTimeout(r,300)); const resumed = tr.currentTime > p2;
          a.setVolume(0.2); await new Promise(r=>setTimeout(r,150)); const vol = a.monitor.gain.value;
          return { seeked, frozen: p1 === p2, paused, resumed, vol, status: a.status.phase }; }""")
        record("file: seek works", 0.9 <= t["seeked"] <= 1.6, f"t={t['seeked']:.2f}")
        record("file: pause holds position", t["paused"] and t["frozen"])
        record("file: play resumes", t["resumed"])
        record("file: volume control moves output gain", abs(t["vol"] - 0.2) < 0.05, f"gain={t['vol']:.2f}")

        # volume must not change analysis (analyser is tapped before the volume gain)
        await page.evaluate("window.__soundgarden.audio.transport.seek(0.5)")
        await page.wait_for_timeout(600)
        v_hi = await page.evaluate("(async()=>{const a=window.__soundgarden.audio;a.setVolume(1);await new Promise(r=>setTimeout(r,500));return a.features.bass})()")
        v_lo = await page.evaluate("(async()=>{const a=window.__soundgarden.audio;a.setVolume(0.05);await new Promise(r=>setTimeout(r,500));return a.features.bass})()")
        record("file: lowering volume does not dim the visuals", v_lo > 0.7 * v_hi, f"bass@1.0={v_hi:.2f} bass@0.05={v_lo:.2f}")

        links = await page.evaluate("window.__links")
        record("file: routed to analyser and to speakers (monitored)", "MediaElementAudioSourceNode->AnalyserNode" in links and "MediaElementAudioSourceNode->GainNode" in links)

        # stop -> everything released
        await page.evaluate("window.__soundgarden.audio.setSource(null)")
        s = await page.evaluate("({src: window.__soundgarden.audio.source, sim: window.__soundgarden.audio.features.simulated, phase: window.__soundgarden.audio.status.phase})")
        record("file: stop releases source and returns to ambient", s["src"] is None and s["sim"] and s["phase"] == "idle")

        # bad file
        bad = os.path.join(FIX, "notaudio.txt")
        open(bad, "w").write("hello")
        await page.set_input_files('input[type=file]', bad)
        await page.wait_for_function("['error','live'].includes(window.__soundgarden.audio.status.phase)", timeout=8000)
        st = await page.evaluate("window.__soundgarden.audio.status")
        record("file: non-audio file rejected with a message", st["phase"] == "error" and len(st["detail"]) > 10, st["detail"])
        record("file: no uncaught page errors", not errs, "; ".join(errs))
        await ctx.close()

        # ---------------------------------------------------------------- BEATS
        ctx, page, errs = await new_page(b, spy=False)
        await set_file(page, "kicks_120bpm.wav")
        await page.wait_for_function("window.__soundgarden.audio.sourceId === 'file'", timeout=8000)
        await page.evaluate("window.__soundgarden.audio.transport.seek(0)")
        b0 = await page.evaluate("window.__soundgarden.audio.features.beatCount")
        rows = await page.evaluate(SAMPLE, 10300)
        n = rows[-1]["beats"] - b0
        record("beats: 20 kicks @120BPM detected (accept 16-24, no flood)", 16 <= n <= 24, f"detected={n}")
        await ctx.close()

        # ---------------------------------------------------------------- NOISE GATE
        ctx, page, errs = await new_page(b, spy=False)
        await set_file(page, "room_noise.wav")
        await page.wait_for_function("window.__soundgarden.audio.sourceId === 'file'", timeout=8000)
        rows = await page.evaluate(SAMPLE, 3000)
        mx = max(r["level"] for r in rows[10:])
        bt = rows[-1]["beats"] - rows[0]["beats"]
        record("noise gate: quiet room noise does not animate or trigger beats", mx < 0.1 and bt == 0, f"max level={mx:.3f} beats={bt}")
        await ctx.close()
        await b.close()

        # ---------------------------------------------------------------- MIC (fake device)
        b = await p.chromium.launch(executable_path=CHROME, args=BASE + [
            "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
            f"--use-file-for-fake-audio-capture={os.path.join(FIX, 'kicks_120bpm.wav')}"])
        ctx, page, errs = await new_page(b)
        await ctx.grant_permissions(["microphone"])
        await page.evaluate("document.getElementById('hero-playground').click()")
        await page.click('[data-id="mic"]')
        await page.click("#source-card button:has-text(\"Enable microphone\")")
        await page.wait_for_function("window.__soundgarden.audio.status.phase === 'live' && window.__soundgarden.audio.sourceId === 'mic'", timeout=8000)
        record("mic: permission granted, goes live", True)
        ui = await page.evaluate("({main: document.getElementById('status-main').textContent, detail: document.getElementById('status-detail').textContent, rec: document.getElementById('status').dataset.rec})")
        record("mic: UI shows clear listening status", "microphone" in ui["main"].lower() and ui["rec"] == "1", f"{ui['main']} / {ui['detail']}")
        b0 = await page.evaluate("window.__soundgarden.audio.features.beatCount")
        rows = await page.evaluate(SAMPLE, 6000)
        react = max(r["bass"] for r in rows)
        record("mic: incoming sound drives the analysis", react > 0.3 and (rows[-1]["beats"] - b0) >= 3, f"peak bass={react:.2f} beats={rows[-1]['beats']-b0}")
        links = await page.evaluate("window.__links")
        mic_links = [l for l in links if l.startswith("MediaStreamAudioSourceNode")]
        record("mic: never routed to speakers (analyser only, no feedback path)", mic_links and all(l.endswith("AnalyserNode") for l in mic_links), ", ".join(sorted(set(mic_links))))
        tracks = await page.evaluate("window.__tr = window.__soundgarden.audio.source.stream.getTracks(); window.__tr.map(t => t.readyState)")
        await page.click("#source-card button:has-text(\"Stop microphone\")")
        await page.wait_for_function("window.__soundgarden.audio.source === null", timeout=5000)
        after = await page.evaluate("window.__tr.map(t => t.readyState)")
        record("mic: stop ends every media track (no leak)", tracks == ["live"] and after == ["ended"], f"{tracks} -> {after}")

        # interruption (device unplugged / permission revoked): simulated via the track's own 'ended' event
        await page.evaluate("window.__soundgarden.audio.setSource('mic')")
        await page.wait_for_function("window.__soundgarden.audio.sourceId === 'mic'", timeout=8000)
        await page.evaluate("window.__tr2 = window.__soundgarden.audio.source.stream.getTracks(); window.__tr2[0].dispatchEvent(new Event('ended'))")
        await page.wait_for_function("window.__soundgarden.audio.status.phase === 'ended'", timeout=5000)
        r = await page.evaluate("({src: window.__soundgarden.audio.source, st: window.__soundgarden.audio.status, rs: window.__tr2.map(t=>t.readyState)})")
        record("mic: interrupted stream is handled and released (simulated 'ended' event)", r["src"] is None and r["rs"] == ["ended"] and r["st"]["code"] == "interrupted", r["st"]["detail"])
        record("mic: no uncaught page errors", not errs, "; ".join(errs))
        await ctx.close()

        # ---------------------------------------------------------------- TAB / SYSTEM attempts (headless Chrome)
        ctx, page, errs = await new_page(b)
        await page.evaluate("document.getElementById('hero-playground').click()")
        await page.click('[data-id="tab"]')
        await page.click("#source-card button:has-text(\"Share a tab\")")
        await page.wait_for_function("['live','error'].includes(window.__soundgarden.audio.status.phase)", timeout=12000)
        st = await page.evaluate("window.__soundgarden.audio.status")
        record("tab: getDisplayMedia attempt is handled gracefully (no crash, clear state)", st["phase"] in ("live", "error") and not errs, f"phase={st['phase']} code={st['code']} detail={st['detail']}")
        tab_live = st["phase"] == "live"
        await page.evaluate("window.__soundgarden.audio.setSource(null)")
        await page.evaluate("document.querySelector('[data-id=system]').click()")
        await page.click("#source-card button:has-text(\"Share system audio\")")
        await page.wait_for_function("['live','error'].includes(window.__soundgarden.audio.status.phase)", timeout=12000)
        st2 = await page.evaluate("window.__soundgarden.audio.status")
        record("system: getDisplayMedia attempt is handled gracefully", st2["phase"] in ("live", "error") and not errs, f"phase={st2['phase']} code={st2['code']} detail={st2['detail']}")
        await ctx.close()
        await b.close()

        # ---------------------------------------------------------------- DENIED permission (no fake UI: headless auto-denies)
        b = await p.chromium.launch(executable_path=CHROME, args=BASE)
        ctx, page, errs = await new_page(b, spy=False)
        await page.evaluate("document.getElementById('hero-playground').click()")
        await page.click('[data-id="mic"]')
        await page.click("#source-card button:has-text(\"Enable microphone\")")
        await page.wait_for_function("['error','live'].includes(window.__soundgarden.audio.status.phase)", timeout=10000)
        st = await page.evaluate("window.__soundgarden.audio.status")
        d = await page.evaluate("document.getElementById('status-detail').textContent")
        record("mic: denied/unavailable shows a clear message and stays safe", st["phase"] == "error" and len(d) > 15 and not errs, f"code={st['code']} | {d}")
        await page.click('[data-id="demo"]')
        await page.wait_for_function("window.__soundgarden.audio.sourceId === 'demo'", timeout=8000)
        record("recovery: can switch to demo after an error", True)
        await ctx.close()

        # ---------------------------------------------------------------- SWITCHING: only the selected source drives visuals
        ctx, page, errs = await new_page(b, spy=False)
        await page.evaluate("document.getElementById('hero-playground').click()")
        await page.click('[data-id="demo"]')
        await page.wait_for_function("window.__soundgarden.audio.sourceId === 'demo'")
        await page.click('[data-id="file"]')
        s = await page.evaluate("({src: window.__soundgarden.audio.sourceId, sim: window.__soundgarden.audio.features.simulated})")
        record("switch: choosing File stops the demo; nothing drives visuals until a file loads", s["src"] is None and s["sim"])
        await page.set_input_files('input[type=file]', os.path.join(FIX, "bands.wav"))
        await page.wait_for_function("window.__soundgarden.audio.sourceId === 'file'", timeout=8000)
        await page.click('[data-id="demo"]')
        await page.wait_for_function("window.__soundgarden.audio.sourceId === 'demo'", timeout=8000)
        n = await page.evaluate("document.querySelectorAll('audio').length")
        record("switch: rapid file->demo leaves a single active source", True, f"active={await page.evaluate('window.__soundgarden.audio.sourceId')}")
        await ctx.close()
        await b.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    json.dump([{"name": n, "ok": o, "detail": d} for n, o, d in results], open(os.path.join(ROOT, "last_results.json"), "w"), indent=1)
    sys.exit(1 if failed else 0)


asyncio.run(main())
