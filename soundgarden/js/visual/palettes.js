import { clamp, lerp } from '../util/math.js';

/** Each palette: two background colours and five colour stops from cool/dim to warm/bright. */
export const PALETTES = [
  { id: 'nightbloom', name: 'Night Bloom', bg: [[9, 5, 24], [40, 10, 58]], stops: [[70, 50, 210], [150, 60, 220], [235, 70, 170], [255, 140, 120], [255, 214, 150]] },
  { id: 'mossaurora', name: 'Moss Aurora', bg: [[3, 12, 16], [8, 40, 40]], stops: [[20, 120, 140], [30, 200, 170], [120, 235, 140], [210, 250, 150], [250, 255, 220]] },
  { id: 'emberorchard', name: 'Ember Orchard', bg: [[16, 5, 6], [56, 12, 14]], stops: [[120, 20, 60], [220, 50, 50], [255, 120, 40], [255, 190, 70], [255, 240, 190]] },
  { id: 'glasshouse', name: 'Glasshouse', bg: [[4, 10, 22], [10, 30, 56]], stops: [[40, 90, 230], [60, 170, 255], [110, 235, 240], [190, 255, 230], [245, 255, 255]] },
  { id: 'lilacdusk', name: 'Lilac Dusk', bg: [[14, 8, 28], [52, 24, 70]], stops: [[100, 90, 230], [180, 120, 240], [240, 140, 200], [255, 180, 170], [255, 226, 200]] },
  { id: 'inkivory', name: 'Ink & Ivory', bg: [[6, 6, 8], [22, 22, 28]], stops: [[90, 96, 120], [150, 155, 175], [205, 205, 215], [240, 236, 225], [255, 252, 240]] },
];

const RAMP = 48;

const mixRgb = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

function rampFrom(stops) {
  const out = [];
  for (let i = 0; i < RAMP; i++) {
    const u = (i / (RAMP - 1)) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(u));
    out.push(mixRgb(stops[k], stops[k + 1], u - k));
  }
  return out;
}

const css = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;

/**
 * Runtime palette used by generators. Crossfades between palettes so switching
 * colours never pops. `at(u)` gives a CSS colour for u in 0..1 (cool -> warm);
 * `rgba(u, a)` allocates a string, so use it for gradients, not per-particle.
 */
export class PaletteRuntime {
  constructor(def) {
    this.from = this.to = this.#expand(def);
    this.t = 1;
    this.version = 0;
    this.id = def.id;
    this.#build();
  }

  #expand(def) {
    return { bg: def.bg, ramp: rampFrom(def.stops) };
  }

  set(def) {
    if (def.id === this.id) return;
    this.from = this.#current();
    this.to = this.#expand(def);
    this.id = def.id;
    this.t = 0;
  }

  #current() {
    return { bg: this.bg.map((c) => c.slice()), ramp: this.rgbRamp.map((c) => c.slice()) };
  }

  /** Advance the crossfade. Returns true while it is still animating. */
  update(dt) {
    if (this.t >= 1) return false;
    this.t = Math.min(1, this.t + dt / 1.2);
    this.#build();
    return true;
  }

  #build() {
    const e = this.t * this.t * (3 - 2 * this.t);
    const { from, to } = this;
    this.bg = from.bg.map((c, i) => mixRgb(c, to.bg[i], e));
    this.rgbRamp = from.ramp.map((c, i) => mixRgb(c, to.ramp[i], e));
    this.ramp = this.rgbRamp.map(css);
    this.bg0 = css(this.bg[0]);
    this.bg1 = css(this.bg[1]);
    this.version++;
  }

  at(u) {
    return this.ramp[(clamp(u) * (RAMP - 1)) | 0];
  }

  rgb(u) {
    return this.rgbRamp[(clamp(u) * (RAMP - 1)) | 0];
  }

  rgba(u, a) {
    const c = this.rgb(u);
    return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  }
}
