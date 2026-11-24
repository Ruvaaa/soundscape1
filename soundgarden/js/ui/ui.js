import { PALETTES } from '../visual/palettes.js';
import { PARAM_DEFS, defaultParams } from '../visual/params.js';

const NS = 'http://www.w3.org/2000/svg';
const SOURCES = [
  { id: 'demo', name: 'Demo sound', sub: 'Generated live, no setup', icon: 'demo' },
  { id: 'file', name: 'Audio file', sub: 'MP3, WAV, OGG, M4A…', icon: 'file' },
  { id: 'mic', name: 'Microphone', sub: 'Listen to the room', icon: 'mic' },
  { id: 'tab', name: 'Browser tab', sub: 'YouTube, Spotify web…', icon: 'tab' },
  { id: 'system', name: 'System audio', sub: 'Where the browser allows', icon: 'system' },
];
const FILE_ACCEPT = 'audio/*,.mp3,.wav,.ogg,.oga,.opus,.m4a,.aac,.flac,.webm';

function icon(name) {
  const s = document.createElementNS(NS, 'svg');
  const u = document.createElementNS(NS, 'use');
  u.setAttribute('href', `#i-${name}`);
  s.append(u);
  return s;
}

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return el;
}

const fmtTime = (s) => {
  if (!Number.isFinite(s)) return '0:00';
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Arrow-key navigation for a radiogroup (roving tabindex). */
function radioKeys(container) {
  container.addEventListener('keydown', (e) => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
    if (!keys.includes(e.key)) return;
    const items = [...container.querySelectorAll('[role="radio"]:not([disabled])')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = items[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    next.focus();
    next.click();
  });
}

export class SoundgardenUI {
  constructor({ audio, visual }) {
    this.audio = audio;
    this.visual = visual;
    this.mode = 'hero';
    this.selected = null;
    this.seeking = false;
    this.hudTimer = 0;
    this.hudHover = false;
    this.toastTimer = 0;
    this.dom = {};
    this.lastMeter = 0;
    this.lastNote = '';

    const $ = (id) => document.getElementById(id);
    this.el = {
      body: document.body,
      sourceList: $('source-list'), sourceCard: $('source-card'),
      status: $('status'), statusMain: $('status-main'), statusDetail: $('status-detail'),
      styleList: $('style-list'), paletteList: $('palette-list'), paletteName: $('palette-name'), sliders: $('sliders'),
      hud: $('hud'), hudStyles: $('hud-styles'), hudStatus: document.querySelector('.hud-status'), hudText: $('hud-text'), hudPlay: $('hud-play'),
      gate: $('gate'), toast: $('toast'), dropveil: $('dropveil'),
      mBass: $('m-bass'), mMid: $('m-mid'), mTreble: $('m-treble'), mBeat: $('m-beat'), mNote: $('m-note'),
    };

    // one hidden file input for the whole app (kept out of the re-rendered cards)
    this.fileInput = h('input', { type: 'file', accept: FILE_ACCEPT, hidden: true, 'aria-hidden': 'true', tabindex: '-1' });
    document.body.append(this.fileInput);
    this.fileInput.addEventListener('change', () => {
      const f = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (f) this.loadFile(f);
    });

    this.buildSources();
    this.buildStyles();
    this.buildPalettes();
    this.buildSliders();
    this.bindGlobal();
    this.bindAudio();
    this.setPalette(visual.paletteId);
    this.renderSourceCard();
    this.updateStatus();
    requestAnimationFrame(this.tick);
  }

  // ---------------------------------------------------------------- modes
  setMode(mode) {
    this.mode = mode;
    const b = this.el.body;
    b.classList.remove('mode-hero', 'mode-playground', 'mode-immersive');
    b.classList.add(`mode-${mode}`);
    if (mode === 'immersive') this.pokeHud(3500);
    else {
      clearTimeout(this.hudTimer);
      b.classList.remove('hud-visible');
    }
  }

  async enterImmersive() {
    // make sure *something* is reacting: fall back to the demo unless the user already chose a source
    if (!this.audio.source && this.audio.status.phase !== 'starting' && !this.selected) this.selectSource('demo');
    this.setMode('immersive');
    try {
      await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
    } catch {
      /* fullscreen refused (iOS, embedded frames): stay immersive in-page */
    }
  }

  exitImmersive(fromFullscreenEvent = false) {
    if (this.mode !== 'immersive') return;
    this.setMode('playground');
    if (!fromFullscreenEvent && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  }

  enterPlayground() {
    if (!this.selected && !this.audio.source) this.selectSource('demo');
    this.setMode('playground');
  }

  pokeHud(ms = 2800) {
    if (this.mode !== 'immersive') return;
    this.el.body.classList.add('hud-visible');
    clearTimeout(this.hudTimer);
    this.hudTimer = setTimeout(() => {
      if (!this.hudHover) this.el.body.classList.remove('hud-visible');
    }, ms);
  }

  // -------------------------------------------------------------- sources
  buildSources() {
    const { audio } = this;
    for (const s of SOURCES) {
      const sup = audio.support[s.id];
      const btn = h(
        'button',
        {
          class: 'source', type: 'button', role: 'radio', 'aria-checked': 'false', 'data-id': s.id,
          disabled: sup && !sup.ok, title: sup && !sup.ok ? sup.reason : '',
          tabindex: '-1',
          onclick: () => this.selectSource(s.id),
        },
        icon(s.icon),
        h('span', {}, h('span', { class: 's-name' }, s.name), h('span', { class: 's-sub' }, sup && !sup.ok ? sup.reason : s.sub)),
        h('span', { class: 'tag' }, s.id === 'system' && sup?.ok ? 'varies' : ''),
      );
      this.el.sourceList.append(btn);
    }
    this.syncSourceRadios();
    radioKeys(this.el.sourceList);
  }

  syncSourceRadios() {
    const radios = [...this.el.sourceList.children];
    const first = radios.find((r) => !r.disabled);
    radios.forEach((r) => {
      const on = r.dataset.id === this.selected;
      r.setAttribute('aria-checked', String(on));
      r.tabIndex = on || (!this.selected && r === first) ? 0 : -1;
    });
  }

  async selectSource(id) {
    const sup = this.audio.support[id];
    if (sup && !sup.ok) return this.toast(sup.reason);
    const same = this.selected === id;
    this.selected = id;
    this.syncSourceRadios();
    this.renderSourceCard();
    if (same && this.audio.sourceId === id) return;
    if (id === 'demo') await this.audio.setSource('demo');
    else await this.audio.setSource(null); // only the selected source may drive the visuals
  }

  async loadFile(file) {
    this.selected = 'file';
    this.syncSourceRadios();
    if (this.mode === 'hero') this.setMode('playground');
    await this.audio.setSource('file', { file });
  }

  startSource(id) {
    return this.audio.setSource(id);
  }

  stopSource() {
    return this.audio.setSource(null);
  }

  renderSourceCard() {
    const { audio } = this;
    const card = this.el.sourceCard;
    const live = audio.sourceId === this.selected && ['live', 'paused', 'starting'].includes(audio.status.phase);
    this.dom = {};
    card.replaceChildren();
    card.style.animation = 'none';
    void card.offsetWidth;
    card.style.animation = '';

    const busy = audio.status.phase === 'starting';
    const action = (label, fn, cls = 'primary') => h('button', { class: `btn ${cls} small`, type: 'button', onclick: fn, disabled: busy }, label);

    switch (this.selected) {
      case null:
        card.append(h('p', {}, 'Choose where the sound comes from. Until then, the garden drifts on its own.'));
        break;

      case 'demo':
        card.append(
          h('p', {}, 'A short piece synthesised in your browser. It goes through exactly the same analysis as any other input.'),
          this.transportRow({ seek: false }),
          this.volumeRow(),
        );
        break;

      case 'file':
        if (live && audio.transport) {
          card.append(h('div', { class: 'filename' }, audio.status.message), this.transportRow({ seek: true }), this.volumeRow(), h('div', { class: 'row', style: 'margin-top:12px' }, action('Choose another file', () => this.fileInput.click(), 'ghost')));
        } else {
          const dz = h('div', { class: 'dropzone' }, 'Drop an audio file here');
          dz.addEventListener('dragover', (e) => (e.preventDefault(), dz.classList.add('over')));
          dz.addEventListener('dragleave', () => dz.classList.remove('over'));
          card.append(dz, h('div', { class: 'row' }, action('Choose audio file', () => this.fileInput.click())), h('p', { class: 'note' }, 'Plays inside Soundgarden and is analysed as it plays. Nothing is uploaded; the file stays on your device.'));
        }
        break;

      case 'mic':
        card.append(
          h('p', {}, live ? 'The microphone is on. Sound is analysed live on this device. It is not recorded, saved, or played back through your speakers.' : 'Your browser will ask for permission. Sound is analysed live on this device and never recorded or played back, so there is no feedback loop.'),
          h('div', { class: 'row' }, live ? action('Stop microphone', () => this.stopSource(), 'ghost') : action('Enable microphone', () => this.startSource('mic'))),
        );
        break;

      case 'tab':
        card.append(
          live ? h('p', {}, 'Listening to the shared tab. Keep that tab playing.') : h('ol', {}, h('li', {}, 'Open your music in another tab (YouTube, Spotify web player…).'), h('li', {}, 'Press “Share a tab” and pick that tab in the browser’s dialog.'), h('li', {}, 'Tick “Also share tab audio”, then Share.')),
          h('div', { class: 'row' }, live ? action('Stop sharing', () => this.stopSource(), 'ghost') : action('Share a tab', () => this.startSource('tab'))),
          h('p', { class: 'note' }, 'Works in Chromium-based desktop browsers (Chrome, Edge…). Firefox and Safari don’t offer tab audio. Some services protect their audio, and capture can come back silent.'),
        );
        break;

      case 'system':
        card.append(
          live ? h('p', {}, 'Listening to what the browser is sharing.') : h('ol', {}, h('li', {}, 'Press “Share system audio” and choose “Entire screen”.'), h('li', {}, 'Tick “Also share system audio”, then Share.')),
          h('div', { class: 'row' }, live ? action('Stop sharing', () => this.stopSource(), 'ghost') : action('Share system audio', () => this.startSource('system'))),
          h('p', { class: 'note' }, 'Not available everywhere: Chromium on Windows and ChromeOS usually offers it. On macOS and Linux the browser often only offers tab audio, and Firefox and Safari offer none. We’ll show what the browser actually shared.'),
        );
        break;
    }
    this.updateTransportUi();
  }

  transportRow({ seek }) {
    const play = h('button', { class: 'play', type: 'button', 'aria-label': 'Play or pause', onclick: () => this.togglePlay() }, icon('pause'));
    const time = h('time', {}, seek ? '0:00 / 0:00' : '');
    let mid;
    if (seek) {
      mid = h('input', { type: 'range', min: '0', max: '1000', value: '0', step: '1', 'aria-label': 'Seek' });
      mid.addEventListener('pointerdown', () => (this.seeking = true));
      mid.addEventListener('input', () => {
        const t = this.audio.transport;
        if (t?.duration) t.seek((mid.value / 1000) * t.duration);
        this.paintRange(mid);
      });
      const done = () => (this.seeking = false);
      mid.addEventListener('pointerup', done);
      mid.addEventListener('change', done);
    } else {
      mid = h('span', { style: 'color:var(--muted);font-size:13px' }, 'Looping 16-bar piece');
    }
    this.dom.play = play;
    this.dom.seek = seek ? mid : null;
    this.dom.time = time;
    return h('div', { class: 'transport' }, play, mid, time);
  }

  volumeRow() {
    const r = h('input', { type: 'range', min: '0', max: '1', step: '0.01', value: String(this.audio.volume), 'aria-label': 'Volume' });
    r.addEventListener('input', () => {
      this.audio.setVolume(Number(r.value));
      this.paintRange(r);
    });
    this.paintRange(r);
    return h('div', { class: 'volume' }, icon('volume'), r);
  }

  paintRange(r) {
    const p = ((r.value - r.min) / (r.max - r.min)) * 100;
    r.style.setProperty('--p', `${p}%`);
  }

  togglePlay() {
    const t = this.audio.transport;
    if (!t) return;
    (t.playing ? Promise.resolve(t.pause()) : Promise.resolve(t.play())).catch((err) => {
      this.toast(err?.name === 'NotAllowedError' ? 'The browser needs a click before it will play sound.' : 'Could not start playback.');
    });
    this.audio.resume();
  }

  updateTransportUi() {
    const t = this.audio.transport;
    const playing = !!t?.playing;
    const name = playing ? 'pause' : 'play';
    for (const btn of [this.dom.play, this.el.hudPlay]) {
      if (!btn) continue;
      btn.firstChild?.firstChild?.setAttribute('href', `#i-${name}`);
      btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    }
    this.el.hudPlay.hidden = !t;
  }

  // --------------------------------------------------------------- status
  bindAudio() {
    const { audio } = this;
    audio.on('status', () => {
      this.updateStatus();
      // a successful start/interruption may change which card should show
      if (this.selected) this.renderSourceCard();
      if (audio.status.phase === 'error') this.toast(audio.status.detail);
      if (audio.status.phase === 'ended') this.toast(audio.status.detail);
      this.updateGate();
    });
    audio.on('transport', () => this.updateTransportUi());
    audio.on('context', () => this.updateGate());
  }

  updateStatus() {
    const s = this.audio.status;
    const rec = ['mic', 'tab', 'system'].includes(s.source) && s.phase === 'live';
    let main = s.message;
    let detail = s.detail;
    if (s.phase === 'idle') detail = 'No sound source selected. The garden is drifting on its own.';
    if (rec && s.source === 'mic') detail = detail ? `${detail} · not recorded` : 'Not recorded or played back';
    if (s.phase === 'paused') detail = detail || 'Paused';
    this.el.status.dataset.phase = s.phase;
    this.el.status.dataset.rec = rec ? '1' : '0';
    this.el.statusMain.textContent = main;
    this.el.statusDetail.textContent = detail;
    this.el.hudStatus.dataset.phase = s.phase;
    this.el.hudStatus.dataset.rec = rec ? '1' : '0';
    this.el.hudText.textContent = s.phase === 'error' ? 'Could not start' : main;
  }

  updateGate() {
    const need = !!this.audio.source && this.audio.contextState !== 'running';
    this.el.gate.hidden = !need;
  }

  toast(msg, ms = 6000) {
    if (!msg) return;
    const t = this.el.toast;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  // ---------------------------------------------------- style / palette / sliders
  buildStyles() {
    this.visual.styles.forEach((g, i) => {
      this.el.styleList.append(
        h('button', { class: 'style', type: 'button', role: 'radio', 'aria-checked': 'false', 'data-id': g.id, onclick: () => this.setStyle(g.id) }, h('b', {}, g.name), h('kbd', {}, String(i + 1)), h('span', {}, g.blurb)),
      );
      this.el.hudStyles.append(h('button', { class: 'hud-style', type: 'button', role: 'radio', 'aria-checked': 'false', 'data-id': g.id, onclick: () => this.setStyle(g.id) }, g.name));
    });
    radioKeys(this.el.styleList);
    radioKeys(this.el.hudStyles);
    this.setStyle(this.visual.styleId, true);
  }

  setStyle(id, silent = false) {
    if (!silent) this.visual.setStyle(id);
    for (const c of [...this.el.styleList.children, ...this.el.hudStyles.children]) {
      c.setAttribute('aria-checked', String(c.dataset.id === id));
      c.tabIndex = c.dataset.id === id ? 0 : -1;
    }
  }

  buildPalettes() {
    for (const p of PALETTES) {
      const stops = p.stops.map((c, i) => `rgb(${c}) ${(i / (p.stops.length - 1)) * 100}%`).join(',');
      this.el.paletteList.append(
        h('button', { class: 'swatch', type: 'button', role: 'radio', 'aria-checked': 'false', 'aria-label': p.name, title: p.name, 'data-id': p.id, style: `background:linear-gradient(135deg,${stops})`, onclick: () => this.setPalette(p.id, true) }),
      );
    }
    radioKeys(this.el.paletteList);
  }

  setPalette(id, apply = false) {
    if (apply) this.visual.setPalette(id);
    const def = PALETTES.find((p) => p.id === id) || PALETTES[0];
    for (const c of this.el.paletteList.children) {
      c.setAttribute('aria-checked', String(c.dataset.id === id));
      c.tabIndex = c.dataset.id === id ? 0 : -1;
    }
    this.el.paletteName.textContent = def.name;
    const a = def.stops[2];
    document.documentElement.style.setProperty('--accent', `rgb(${Math.min(255, a[0] + 20)},${Math.min(255, a[1] + 20)},${Math.min(255, a[2] + 20)})`);
  }

  buildSliders() {
    this.sliders = {};
    for (const [key, d] of Object.entries(PARAM_DEFS)) {
      const id = `p-${key}`;
      const out = h('output', { for: id });
      const input = h('input', { id, type: 'range', min: d.min, max: d.max, step: d.step, value: this.visual.target[key] });
      const show = () => {
        out.textContent = `${Math.round(((input.value - d.min) / (d.max - d.min)) * 100)}`;
        this.paintRange(input);
      };
      input.addEventListener('input', () => {
        this.visual.setParam(key, Number(input.value));
        show();
      });
      show();
      this.sliders[key] = { input, show };
      this.el.sliders.append(h('div', {}, h('div', { class: 'slider-head' }, h('label', { for: id }, d.label), out), input, h('div', { class: 'slider-ends' }, h('span', {}, d.lo), h('span', {}, d.hi))));
    }
  }

  syncSliders() {
    for (const [key, s] of Object.entries(this.sliders)) {
      s.input.value = this.visual.target[key];
      s.show();
    }
  }

  surprise() {
    const r = (a, b) => a + Math.random() * (b - a);
    const v = this.visual;
    const others = PALETTES.filter((p) => p.id !== v.paletteId);
    this.setPalette(others[Math.floor(Math.random() * others.length)].id, true);
    v.setParam('motion', r(0.6, 1.6));
    v.setParam('density', r(0.35, 0.95));
    v.setParam('sensitivity', r(0.8, 1.5));
    v.setParam('complexity', r(0.15, 0.95));
    v.setParam('shape', r(0, 1));
    this.syncSliders();
  }

  reset() {
    const d = defaultParams();
    for (const k of Object.keys(d)) this.visual.setParam(k, d[k]);
    this.setPalette(PALETTES[0].id, true);
    this.syncSliders();
  }

  // --------------------------------------------------------------- global
  bindGlobal() {
    const $ = (id) => document.getElementById(id);
    $('hero-immersive').addEventListener('click', () => this.enterImmersive());
    $('hero-playground').addEventListener('click', () => this.enterPlayground());
    $('btn-immersive').addEventListener('click', () => this.enterImmersive());
    $('hud-exit').addEventListener('click', () => this.exitImmersive());
    $('hud-play').addEventListener('click', () => this.togglePlay());
    $('btn-collapse').addEventListener('click', () => this.togglePanel(true));
    $('btn-reveal').addEventListener('click', () => this.togglePanel(false));
    $('btn-surprise').addEventListener('click', () => this.surprise());
    $('btn-reset').addEventListener('click', () => this.reset());
    this.el.gate.addEventListener('click', async () => {
      await this.audio.resume();
      const t = this.audio.transport;
      if (t && !t.playing) this.togglePlay();
      this.updateGate();
    });

    this.el.hud.addEventListener('pointerenter', () => ((this.hudHover = true), this.pokeHud(60000)));
    this.el.hud.addEventListener('pointerleave', () => ((this.hudHover = false), this.pokeHud()));
    for (const ev of ['pointermove', 'pointerdown', 'touchstart']) window.addEventListener(ev, () => this.pokeHud(), { passive: true });

    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && this.mode === 'immersive') this.exitImmersive(true);
    });

    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      this.pokeHud();
      const tag = e.target?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (e.key === 'Escape' && this.mode === 'immersive') return this.exitImmersive();
      if (typing && e.target.type !== 'range') return;
      if (typing) return;
      const k = e.key.toLowerCase();
      if (k === 'i') this.mode === 'immersive' ? this.exitImmersive() : this.enterImmersive();
      else if (k === 'h' && this.mode !== 'immersive' && this.mode !== 'hero') this.togglePanel();
      else if (['1', '2', '3'].includes(k) && this.visual.styles[Number(k) - 1]) this.setStyle(this.visual.styles[Number(k) - 1].id);
      else if (k === ' ' && tag !== 'BUTTON' && this.audio.transport) (e.preventDefault(), this.togglePlay());
    });

    // drag & drop an audio file anywhere
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    window.addEventListener('dragenter', (e) => hasFiles(e) && (depth++, (this.el.dropveil.hidden = false)));
    window.addEventListener('dragleave', (e) => hasFiles(e) && --depth <= 0 && ((depth = 0), (this.el.dropveil.hidden = true)));
    window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      this.el.dropveil.hidden = true;
      const f = e.dataTransfer.files?.[0];
      if (f) this.loadFile(f);
    });
  }

  togglePanel(force) {
    const hide = typeof force === 'boolean' ? force : !this.el.body.classList.contains('panel-hidden');
    this.el.body.classList.toggle('panel-hidden', hide);
  }

  // ----------------------------------------------------------- per-frame UI
  tick = (now) => {
    requestAnimationFrame(this.tick);
    if (document.hidden) return;
    const f = this.audio.features;

    // transport position (cheap; only while a transport exists)
    const t = this.audio.transport;
    if (t && this.dom.time && t.kind === 'file') {
      if (this.dom.seek && !this.seeking && t.duration) {
        this.dom.seek.value = String((t.currentTime / t.duration) * 1000);
        this.paintRange(this.dom.seek);
      }
      this.dom.time.textContent = `${fmtTime(t.currentTime)} / ${fmtTime(t.duration)}`;
    }

    // signal meters ~30fps, only when the panel is visible
    if (this.mode === 'playground' && !this.el.body.classList.contains('panel-hidden') && now - this.lastMeter > 33) {
      this.lastMeter = now;
      const c = (v) => Math.max(0, Math.min(1, v));
      this.el.mBass.style.transform = `scaleX(${c(f.bass)})`;
      this.el.mMid.style.transform = `scaleX(${c(f.mid)})`;
      this.el.mTreble.style.transform = `scaleX(${c(f.treble)})`;
      this.el.mBeat.style.opacity = String(0.15 + 0.85 * c(f.beat));
      const note = f.simulated ? 'Ambient preview, not from audio' : 'Live analysis';
      if (note !== this.lastNote) {
        this.lastNote = note;
        this.el.mNote.textContent = note;
      }
    }
  };
}
