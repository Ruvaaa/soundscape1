# Soundgarden

An audio-reactive garden of light. Dependency-free: plain ES modules, Canvas 2D, Web Audio API. No build step.

```
python3 -m http.server 5173      # from this folder
open http://localhost:5173
```

Needs a secure context (`localhost` or https) for microphone and screen/tab capture.
Add `?debug` to the URL to expose `window.__soundgarden` (used by the tests).

## About the host project

The ruvaaa.xyz source was not available to me (empty workspace, no linked repo, site not fetchable),
and the project was described as "only a scaffold". So Soundgarden is a **standalone module that has not been
integrated into or checked against the existing site's framework, routing or styles**. `index.html` is the
page; `css/soundgarden.css` is self-contained and scoped by its own class names; `js/main.js` is the only entry.
To embed it, mount the canvas + panel markup in a route and import `js/main.js`.

## Architecture

```
js/audio/   Web Audio only. Knows nothing about rendering.
  AudioEngine.js      owns AudioContext, the ONE active source, the analysis loop, teardown
  AudioAnalyzer.js    AnalyserNode -> bands, level, energy, delta, flux, beats, transients, spectrum
  sources/            FileSource, MicSource, DisplaySource (tab + system), DemoSource
  errors.js support.js
js/visual/  Canvas only. Reads `features` (a plain object), never touches Web Audio.
  VisualEngine.js     render loop, params, palette crossfade, style transitions, quality governor
  generators/         ribbons.js (Ribbon Bloom), garden.js (Particle Garden), waves.js (Generative Waves)
js/ui/ui.js           source selector, transport, status, playground panel, immersive HUD
```

The only link between audio and visuals is `audio.features`, passed to `VisualEngine` in `main.js`.
Add a generator by creating a file in `generators/` and listing it in `generators/index.js`.

### Signal path

`source node -> AnalyserNode` always (analysis tap). `-> monitor gain -> speakers` **only** for the file and demo
sources. Mic, tab and system audio are never connected to the speakers. The analyser sits before the volume
control, so lowering volume does not dim the visuals.

Per frame: band means (bass 20-250 Hz, mid 250-4k, treble 4k-16k; blends mean with above-average bins so
narrow tones register) -> silence gate -> per-band adaptive gain -> contrast curve -> attack/release smoothing.
Beats = positive spectral flux vs an adaptive threshold with a refractory period. Also: 64-bin log spectrum,
spectral centroid, slow energy average and `delta` (building/falling).

### How generators read the same audio differently

| | bass | mid | treble | beat | spectrum |
|---|---|---|---|---|---|
| Ribbon Bloom | frond height/width, orb size | sway + bend | veins, shimmer, light points | ripple up fronds | n/a |
| Particle Garden | outward push, burst size | swirl / flow field | fireflies, twinkle | ring of motes + petals | seed-head dots |
| Generative Waves | big swells, sun glow | wavelength + drift | fine ripples, rising lights | rolling pulses | every ridge listens to its own slice |

## Input sources: status

| Source | Status | Notes |
|---|---|---|
| Demo sound | Implemented, tested | Synthesised live with Web Audio and sent through the **real** analyser. |
| Audio file | Implemented, tested | MP3/WAV/OGG/M4A/FLAC/WebM as the browser can decode. Play/pause/seek/volume, drag-and-drop. Stays on-device. |
| Microphone | Implemented, tested with Chrome's fake mic | Permission via browser, status shows listening / not recorded, Stop releases tracks. Not tested with physical hardware or in Firefox/Safari. |
| Browser tab audio | Implemented. **Real tab capture NOT verified** | See below. |
| System audio | Implemented. **Real system capture NOT verified** | See below. |

### Tab and system audio: what is and isn't known

- Uses `getDisplayMedia`. The user always picks the source in the browser's own dialog; nothing bypasses it.
- In my sandbox, Chrome refused real capture (`NotReadableError`, no display). Soundgarden showed a clear error and
  stayed stable. **I have not seen Soundgarden react to real audio from another tab or from the system.**
- With Chrome's *fake* display device, the returned audio track did flow through the analyser and drive the visuals,
  which only confirms the code path from a `getDisplayMedia` audio track onward.
- Expected (documented browser behaviour, untested here): Chromium desktop offers tab audio via "Also share tab audio";
  system audio is generally Windows/ChromeOS Chromium with "Entire screen"; macOS/Linux usually tab-only;
  Firefox and Safari offer neither. Some services (DRM content) can produce silence.
- If audio isn't shared, the app says exactly what to tick. It never claims universal access.

**To verify yourself:** play music in tab A, open Soundgarden in tab B, choose Browser tab > Share a tab > tab A >
tick *Also share tab audio*. Repeat with System audio > Entire screen on a supported OS/browser.

## Tests (`tests/`)

```
python3 tests/make_audio.py          # known test signals
python3 tests/run_audio_tests.py     # 30 checks in real Chrome
python3 tests/run_capture_test.py    # tab/system attempt with real audio (fails in headless, see above)
```

Passing (30/30): band separation with known tones (bass/mid/treble), silence settles to zero, quiet noise gated,
20 kicks at 120 BPM -> 20 beats detected, seek/pause/play/volume, volume doesn't dim visuals, source routing
(mic never reaches speakers), stop ends all tracks, simulated device-disconnect handled, denied/missing mic message,
bad file rejected, switching sources leaves one active source, no uncaught page errors.

Limits: mic uses Chrome's fake device; interruption is simulated by firing the track's `ended` event; autoplay-gate
UI ("Tap to enable sound") exists but was not exercised in a browser that actually blocks autoplay; Safari/Firefox
untested; mobile layout only viewed at CSS level, not on a device; no long-run memory/performance profiling beyond
the built-in adaptive quality governor.

## Not implemented (planned)

Playlists, accounts, social features (out of scope by request). WebGL renderer (Canvas 2D used; governor lowers
resolution/particles if frames run long). Saving/sharing presets. Recording/export.
