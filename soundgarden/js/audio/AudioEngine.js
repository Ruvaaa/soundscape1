import { Emitter } from '../util/emitter.js';
import { clamp } from '../util/math.js';
import { AudioAnalyzer, createFeatures, SPECTRUM_BINS } from './AudioAnalyzer.js';
import { describeError } from './errors.js';
import { detectSupport } from './support.js';
import { DemoSource } from './sources/DemoSource.js';
import { FileSource } from './sources/FileSource.js';
import { MicSource } from './sources/MicSource.js';
import { DisplaySource } from './sources/DisplaySource.js';

/**
 * Owns the AudioContext, the single active source, and the analysis loop.
 *
 * Graph:   source.node --> analyser                      (always, analysis tap)
 *          source.node --> monitorGain --> destination   (only if source.monitor)
 *
 * The analyser sits BEFORE the volume control, so turning the volume down does
 * not make the visuals fade. Mic / tab / system audio are never routed to the
 * speakers (no feedback loop, no doubled sound).
 *
 * Only one source can be active. setSource() always tears the previous one down
 * (media tracks stopped, nodes disconnected, object URLs revoked) before the
 * next starts, and a token guards against overlapping start requests.
 *
 * Events: 'status' (this.status), 'transport' (play state), 'context' (ctx.state).
 * The visual engine never imports this module. It only reads `features`.
 */
export class AudioEngine extends Emitter {
  features = createFeatures();
  support = detectSupport();
  ctx = null;
  analyser = null;
  analyzer = null;
  monitor = null;
  source = null;
  sourceId = null;
  volume = 0.7;
  status = { phase: 'idle', source: null, message: 'Ambient preview', detail: '', info: {}, code: '' };

  #handle = null;
  #offs = [];
  #token = 0;
  #raf = 0;
  #last = performance.now();
  #clock = 0;

  constructor() {
    super();
    this.#raf = requestAnimationFrame(this.#loop);
  }

  get contextState() {
    return this.ctx ? this.ctx.state : 'none';
  }

  get transport() {
    return this.source?.transport || null;
  }

  #ensureContext() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('Web Audio is not available in this browser.');
    const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));
    const an = (this.analyser = ctx.createAnalyser());
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0.2;
    an.minDecibels = -85;
    an.maxDecibels = -15;
    this.monitor = ctx.createGain();
    this.monitor.gain.value = this.volume;
    this.monitor.connect(ctx.destination);
    this.analyzer = new AudioAnalyzer(an, this.features);
    ctx.addEventListener('statechange', () => this.emit('context', ctx.state));
    return ctx;
  }

  /** Browsers keep the context suspended until a user gesture. Call from a click. */
  async resume() {
    if (this.ctx && this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch {
        /* still blocked; UI shows the gate */
      }
    }
    this.emit('context', this.contextState);
    return this.contextState;
  }

  setVolume(v) {
    this.volume = clamp(v);
    if (this.monitor) this.monitor.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
  }

  #setStatus(patch) {
    this.status = { phase: 'idle', source: null, message: '', detail: '', info: {}, code: '', ...patch };
    this.emit('status', this.status);
  }

  #createSource(id, opts) {
    const ctx = this.ctx;
    switch (id) {
      case 'demo':
        return new DemoSource(ctx);
      case 'file':
        return new FileSource(ctx, opts);
      case 'mic':
        return new MicSource(ctx);
      case 'tab':
      case 'system':
        return new DisplaySource(ctx, { kind: id });
      default:
        throw new Error(`Unknown audio source "${id}"`);
    }
  }

  /**
   * Switch to `id` ('demo' | 'file' | 'mic' | 'tab' | 'system') or pass null to stop.
   * Resolves true if the source is live. Never throws; failures land in `status`.
   */
  async setSource(id, opts = {}) {
    const token = ++this.#token;
    await this.#teardown();
    if (token !== this.#token) return false;
    if (!id) {
      this.#setStatus({ phase: 'idle', message: 'Ambient preview' });
      return false;
    }

    let src = null;
    try {
      this.#ensureContext();
      this.#setStatus({ phase: 'starting', source: id, message: 'Starting…' });
      await this.resume();
      src = this.#createSource(id, opts);
      const { node, monitor } = await src.start();

      if (token !== this.#token) {
        // A newer request superseded this one while the permission prompt / file load was open.
        src.stop();
        return false;
      }

      node.connect(this.analyser);
      if (monitor) node.connect(this.monitor);
      this.#handle = { node };
      this.source = src;
      this.sourceId = id;
      this.analyzer.reset();

      this.#offs.push(
        src.on('ended', ({ reason }) => {
          if (this.source !== src) return;
          this.#teardown().then(() => this.#setStatus({ phase: 'ended', source: id, message: 'Input ended', detail: reason, code: 'interrupted' }));
        }),
        src.on('transport', (t) => {
          if (this.source !== src) return;
          this.#publishLive();
          this.emit('transport', t);
        }),
      );
      this.#publishLive(src.autoplayBlocked ? 'Press play to start.' : '');
      return true;
    } catch (err) {
      try {
        src?.stop();
      } catch {
        /* ignore */
      }
      if (token !== this.#token) return false;
      const d = describeError(err, id);
      console.warn(`[soundgarden] ${id} failed:`, err);
      await this.#teardown();
      this.#setStatus({ phase: 'error', source: id, message: 'Could not start', detail: d.message, code: d.code });
      return false;
    }
  }

  #publishLive(extraDetail = '') {
    const src = this.source;
    if (!src) return;
    const playing = src.transport ? src.transport.playing : true;
    const detail = extraDetail || src.info?.warning || '';
    const messages = {
      demo: 'Demo sound',
      file: src.info?.name || src.label,
      mic: 'Listening to microphone',
      tab: 'Listening to tab audio',
      system: 'Listening to system audio',
    };
    this.#setStatus({
      phase: playing ? 'live' : 'paused',
      source: this.sourceId,
      message: messages[this.sourceId] || src.label,
      detail: detail || (src.info?.sharing ? `Sharing ${src.info.sharing}` : src.info?.device || ''),
      info: src.info || {},
    });
  }

  async #teardown() {
    const src = this.source;
    this.source = null;
    this.sourceId = null;
    this.#offs.forEach((off) => off());
    this.#offs = [];
    if (this.#handle) {
      try {
        this.#handle.node.disconnect(); // from analyser and monitor
      } catch {
        /* already disconnected */
      }
      this.#handle = null;
    }
    if (src) {
      try {
        await src.stop();
      } catch (err) {
        console.warn('[soundgarden] error while stopping source', err);
      }
    }
    this.analyzer?.reset();
    this.features.live = false;
    this.features.simulated = true;
  }

  async stop() {
    return this.setSource(null);
  }

  // --- analysis loop (independent of the render loop) ----------------------
  #loop = (now) => {
    this.#raf = requestAnimationFrame(this.#loop);
    const dt = Math.min(0.1, (now - this.#last) / 1000 || 0.016);
    this.#last = now;
    this.#clock += dt;
    if (this.source && this.analyzer) {
      this.features.live = true;
      this.features.simulated = false;
      this.analyzer.process(dt, now / 1000);
    } else {
      this.#simulate(this.#clock);
    }
  };

  /** Gentle ambient motion shown when no source is running. Flagged `simulated`. */
  #simulate(t) {
    const f = this.features;
    f.live = false;
    f.simulated = true;
    f.bass = 0.3 + 0.16 * Math.sin(t * 0.9) + 0.08 * Math.sin(t * 2.3 + 1);
    f.mid = 0.28 + 0.13 * Math.sin(t * 0.7 + 2) + 0.07 * Math.sin(t * 1.9);
    f.treble = 0.18 + 0.1 * Math.sin(t * 1.3 + 4) + 0.06 * Math.sin(t * 3.1);
    f.energy = 0.5 * f.bass + 0.3 * f.mid + 0.2 * f.treble;
    f.slowEnergy = 0.3;
    f.delta = f.energy - 0.3;
    f.level = f.energy;
    f.rms = 0;
    f.beat = 0.45 * Math.exp(-(t % 2.6) * 3.2);
    f.transient = 0;
    f.centroid = 0.4 + 0.15 * Math.sin(t * 0.3);
    const sp = f.spectrum;
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const x = i / SPECTRUM_BINS;
      sp[i] = clamp((0.45 - x * 0.3) * (0.55 + 0.45 * Math.sin(i * 0.35 + t * 1.1)) + 0.06);
    }
  }

  async dispose() {
    cancelAnimationFrame(this.#raf);
    await this.#teardown();
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
