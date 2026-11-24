import { Emitter } from '../util/emitter.js';
import { clamp, damp, easeInOut, lerp } from '../util/math.js';
import { PALETTES, PaletteRuntime } from './palettes.js';
import { defaultParams, PARAM_DEFS } from './params.js';
import { GENERATORS } from './generators/index.js';

const SPRITE_BUCKETS = 24;

/**
 * Shared visual engine used by both Immersive and Playground modes.
 *
 * It owns the canvas, the render loop, parameters, palette crossfades, style
 * transitions and an adaptive-quality governor. It reads audio ONLY through the
 * `features` object it is given; it never touches the Web Audio API.
 *
 * Generator contract (see generators/):
 *   create(engine) -> { resize(w, h), update(dt, t, v, p), draw(ctx, alpha), dispose() }
 *   plus static `id`, `name`, `blurb`, `trail` (0..1 background veil per frame).
 *
 * `v` is a view of the audio features with the user's sensitivity applied.
 * `t` is a motion-scaled clock (it advances faster/slower with the Motion slider
 * without ever jumping), `p` is the smoothed parameter set.
 */
export class VisualEngine extends Emitter {
  constructor(canvas, features) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.features = features;

    this.styles = GENERATORS;
    this.target = defaultParams();
    this.params = defaultParams();
    this.pal = new PaletteRuntime(PALETTES[0]);
    this.paletteId = PALETTES[0].id;

    this.view = {
      bass: 0, mid: 0, treble: 0, energy: 0, level: 0, delta: 0, flux: 0,
      beat: 0, transient: 0, centroid: 0.3, spectrum: features.spectrum, sens: 1, simulated: true,
    };

    this.w = 1;
    this.h = 1;
    this.dpr = 1;
    this.quality = 1;
    this.clock = 0;
    this.fadeIn = 0;
    this.needsClear = true;
    this.running = false;
    this.raf = 0;
    this.last = 0;
    this.frameAvg = 1 / 60;
    this.govTimer = 0;
    this.govCooldown = 0;
    this.sprites = new Array(SPRITE_BUCKETS).fill(null);
    this.spriteVersion = -1;
    this.bgGradient = null;
    this.bgVersion = -1;

    this.current = { def: GENERATORS[0], inst: GENERATORS[0].create(this) };
    this.incoming = null;
    this.trans = 1;

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement || document.body);
    this.resize();
  }

  // --- public API -----------------------------------------------------------
  get styleId() {
    return (this.incoming || this.current).def.id;
  }

  setStyle(id) {
    const def = GENERATORS.find((g) => g.id === id);
    if (!def || id === this.styleId) return;
    if (this.incoming) {
      // Switching again mid-transition: drop the half-faded outgoing one.
      this.current.inst.dispose();
      this.current = this.incoming;
    }
    const inst = def.create(this);
    inst.resize(this.w, this.h);
    this.incoming = { def, inst };
    this.trans = 0;
    this.emit('style', id);
  }

  setPalette(id) {
    const def = PALETTES.find((p) => p.id === id);
    if (!def) return;
    this.paletteId = id;
    this.pal.set(def);
    this.emit('palette', id);
  }

  setParam(key, value) {
    const d = PARAM_DEFS[key];
    if (!d) return;
    this.target[key] = clamp(value, d.min, d.max);
  }

  // --- lifecycle ------------------------------------------------------------
  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.#frame);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose() {
    this.stop();
    this.ro.disconnect();
    this.current.inst.dispose();
    this.incoming?.inst.dispose();
  }

  resize() {
    const host = this.canvas.parentElement || document.body;
    const rect = host.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * (0.7 + 0.3 * this.quality);
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.ctx.setTransform(pw / w, 0, 0, ph / h, 0, 0);
    this.bgVersion = -1;
    this.needsClear = true;
    this.current.inst.resize(w, h);
    this.incoming?.inst.resize(w, h);
  }

  /** Cached soft glow sprite tinted from the palette ramp (u in 0..1). */
  sprite(u) {
    if (this.spriteVersion !== this.pal.version) {
      this.sprites.fill(null);
      this.spriteVersion = this.pal.version;
    }
    const i = clamp(Math.round(u * (SPRITE_BUCKETS - 1)), 0, SPRITE_BUCKETS - 1);
    let s = this.sprites[i];
    if (!s) {
      const size = 64;
      s = document.createElement('canvas');
      s.width = s.height = size;
      const g = s.getContext('2d');
      const c = this.pal.rgb(i / (SPRITE_BUCKETS - 1));
      const hot = `rgba(${Math.min(255, c[0] + 90)},${Math.min(255, c[1] + 90)},${Math.min(255, c[2] + 90)},`;
      const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0, hot + '0.95)');
      grad.addColorStop(0.18, `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},0.7)`);
      grad.addColorStop(0.5, `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},0.16)`);
      grad.addColorStop(1, `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},0)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, size, size);
      this.sprites[i] = s;
    }
    return s;
  }

  // --- frame ----------------------------------------------------------------
  #frame = (now) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.#frame);
    const dt = Math.min(0.05, (now - this.last) / 1000 || 0.016);
    this.last = now;
    this.#govern(dt);
    this.#update(dt);
    this.#draw();
  };

  #update(dt) {
    // parameters glide to their targets so dragging a slider never snaps
    const p = this.params;
    for (const k in p) p[k] = damp(p[k], this.target[k], 9, dt);

    this.clock += dt * p.motion;
    this.fadeIn = Math.min(1, this.fadeIn + dt / 1.6);
    this.pal.update(dt);

    // audio view with sensitivity applied (soft ceiling so loud input can't blow out the scene)
    const f = this.features;
    const v = this.view;
    const s = p.sensitivity;
    const lim = (x) => (x < 0 ? 0 : x > 1.4 ? 1.4 : x);
    v.bass = lim(f.bass * s);
    v.mid = lim(f.mid * s);
    v.treble = lim(f.treble * s);
    v.energy = lim(f.energy * s);
    v.level = lim(f.level * s);
    v.delta = f.delta * s;
    v.flux = lim(f.flux * s);
    v.beat = lim(f.beat * (0.55 + 0.45 * s));
    v.transient = lim(f.transient * (0.55 + 0.45 * s));
    v.centroid = f.centroid;
    v.sens = s;
    v.simulated = f.simulated;

    if (this.incoming) {
      this.trans = Math.min(1, this.trans + dt / 1.1);
      this.incoming.inst.update(dt, this.clock, v, p);
      if (this.trans >= 1) {
        this.current.inst.dispose();
        this.current = this.incoming;
        this.incoming = null;
      }
    }
    this.current.inst.update(dt, this.clock, v, p);
  }

  #draw() {
    const { ctx, w, h } = this;
    const e = this.incoming ? easeInOut(this.trans) : 1;
    const trailA = this.current.def.trail;
    const trailB = this.incoming ? this.incoming.def.trail : trailA;
    let veil = lerp(trailA, trailB, e);
    if (this.incoming) veil = Math.max(veil, 0.2);
    if (this.needsClear) {
      veil = 1;
      this.needsClear = false;
    }

    if (this.bgVersion !== this.pal.version || !this.bgGradient) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, this.pal.bg0);
      g.addColorStop(1, this.pal.bg1);
      this.bgGradient = g;
      this.bgVersion = this.pal.version;
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = veil;
    ctx.fillStyle = this.bgGradient;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;

    const intro = easeInOut(this.fadeIn);
    if (this.incoming) {
      this.current.inst.draw(ctx, (1 - e) * intro);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      this.incoming.inst.draw(ctx, e * intro);
    } else {
      this.current.inst.draw(ctx, intro);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  /** Lowers render resolution / particle budgets if frames run long, and recovers when there's headroom. */
  #govern(dt) {
    this.frameAvg += (dt - this.frameAvg) * 0.05;
    this.govTimer += dt;
    this.govCooldown = Math.max(0, this.govCooldown - dt);
    if (this.govTimer < 1) return;
    this.govTimer = 0;
    let q = this.quality;
    if (this.frameAvg > 0.026 && q > 0.45) {
      q = Math.max(0.45, q - 0.12);
      this.govCooldown = 4;
    } else if (this.frameAvg < 0.0185 && q < 1 && this.govCooldown === 0) {
      q = Math.min(1, q + 0.06);
    }
    if (q !== this.quality) {
      this.quality = q;
      this.resize();
      this.emit('quality', q);
    }
  }
}
