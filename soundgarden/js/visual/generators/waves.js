import { noise3 } from '../../util/noise.js';
import { clamp, frac, lerp, mulberry32, TAU } from '../../util/math.js';

/**
 * Generative Waves: layered ridges, near ones large and slow, far ones fine and quick.
 *
 *   spectrum -> every layer listens to its own slice of the spectrum
 *               (near layers = bass ... far layers = treble), so the geometry
 *               itself is the frequency picture
 *   bass     -> the big swells and the glow of the sun
 *   mid      -> wavelength and drift of the ridges
 *   treble   -> fine ripples on far ridges and rising seed-lights
 *   beat     -> pulses that roll outwards through the layers
 */
const MAX_LAYERS = 16;
const tri = (x) => (2 / Math.PI) * Math.asin(Math.sin(x)); // triangle wave, -1..1

class Waves {
  constructor(engine) {
    this.e = engine;
    this.w = 1;
    this.h = 1;
    this.t = 0;
    this.pulses = [];
    this.prevBeat = 0;
    const r = mulberry32(53);
    this.seeds = Array.from({ length: 70 }, () => ({ x: r(), y: r(), s: r(), ph: r() * TAU }));
    this.layerSeed = Array.from({ length: MAX_LAYERS }, () => r() * 100);
  }

  resize(w, h) {
    this.w = w;
    this.h = h;
  }

  update(dt, t, v, p) {
    this.t = t;
    this.v = v;
    this.p = p;
    if (v.beat > 0.9 && this.prevBeat <= 0.9) {
      this.pulses.push({ x: (0.15 + 0.7 * Math.random()) * this.w, age: 0 });
      if (this.pulses.length > 4) this.pulses.shift();
    }
    this.prevBeat = v.beat;
    for (const pu of this.pulses) pu.age += dt * (0.6 + p.motion * 0.4);
    while (this.pulses.length && this.pulses[0].age > 1.6) this.pulses.shift();
  }

  draw(ctx, a) {
    const { w, h, v, p, t, e } = this;
    const pal = e.pal;
    const q = e.quality;
    const sp = v.spectrum;

    // sun / moon glow behind the ridges
    ctx.globalCompositeOperation = 'lighter';
    {
      const sx = w * (0.5 + 0.14 * Math.sin(t * 0.05));
      const sy = h * (0.3 - 0.04 * v.bass);
      const rad = Math.max(w, h) * (0.22 + 0.16 * v.bass + 0.06 * v.energy);
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, rad);
      g.addColorStop(0, pal.rgba(0.95, (0.28 + 0.4 * v.energy) * a * 0.4));
      g.addColorStop(0.35, pal.rgba(0.6, (0.12 + 0.15 * v.energy) * a * 0.4));
      g.addColorStop(1, pal.rgba(0.3, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    const L = Math.round(lerp(5, MAX_LAYERS, p.complexity));
    const stepPx = Math.max(4, (w / 160) * (1 + (1 - q) * 0.5) * (1 + p.shape * 2.5));
    const steps = Math.ceil(w / stepPx) + 1;
    const harmonics = 1 + Math.round(p.complexity * 2);
    const wavelength = 1 / (lerp(520, 260, p.complexity) * (1 - v.mid * 0.25));
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineJoin = p.shape > 0.5 ? 'miter' : 'round';

    for (let i = 0; i < L; i++) {
      const d = L === 1 ? 1 : i / (L - 1); // 0 = far, 1 = near
      const baseY = h * (0.34 + 0.64 * Math.pow(d, 0.85));
      const specIdx = Math.min(63, Math.floor((1 - d) * 0.85 * 64));
      const band = clamp((sp[specIdx] * v.sens + sp[Math.min(63, specIdx + 1)] * v.sens) * 0.5, 0, 1.4);
      const amp = h * (0.03 + 0.1 * d) * (0.55 + band * 1.5 + v.bass * d * 0.6);
      const speed = (0.18 + 0.5 * (1 - d)) * (0.6 + 0.8 * v.mid);
      const seed = this.layerSeed[i];

      ctx.beginPath();
      const ys = this._ys || (this._ys = new Float32Array(2048));
      for (let k = 0; k < steps; k++) {
        const x = Math.min(w, k * stepPx);
        const ph = x * wavelength * (1 + (1 - d) * 1.4) * TAU + t * speed + seed;
        let m = 0;
        for (let hm = 1; hm <= harmonics; hm++) m += (lerp(Math.sin(ph * hm), tri(ph * hm), p.shape * 0.85) / hm) * (hm === 1 ? 1 : 0.6);
        const organic = noise3(x * 0.003 + seed, t * 0.12 * (0.5 + d), i * 0.7);
        let y = baseY - amp * (0.55 * m + 0.9 * organic);
        // fine ripples on far layers: treble
        y -= (1 - d) * v.treble * h * 0.012 * Math.sin(x * 0.05 + t * 3 + seed);
        // rolling pulses from beats
        for (const pu of this.pulses) {
          const reach = 90 + pu.age * 520;
          const dx = (x - pu.x) / reach;
          y -= Math.exp(-dx * dx) * (1 - pu.age / 1.6) * h * 0.07 * (0.4 + d);
        }
        if (k < ys.length) ys[k] = y;
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h + 4);
      ctx.lineTo(0, h + 4);
      ctx.closePath();

      const top = baseY - amp * 1.4;
      const fog = 1 - d * 0.85;
      const grad = ctx.createLinearGradient(0, top, 0, Math.min(h, baseY + h * 0.28));
      const ci = frac(0.05 + d * 0.8 + v.centroid * 0.1 + t * 0.004);
      grad.addColorStop(0, pal.rgba(ci, 0.5 + 0.35 * d));
      grad.addColorStop(1, pal.rgba(0.02, 0.92));
      ctx.globalAlpha = a * (0.55 + 0.45 * d) * (1 - fog * 0.25);
      ctx.fillStyle = grad;
      ctx.fill();

      // lit crest line
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = a * (0.25 + 0.45 * d + band * 0.4);
      ctx.lineWidth = 1 + d * 1.4 + band * 1.2;
      ctx.strokeStyle = pal.at(frac(ci + 0.2));
      ctx.beginPath();
      for (let k = 0; k < steps && k < ys.length; k++) {
        const x = Math.min(w, k * stepPx);
        if (k === 0) ctx.moveTo(x, ys[k]);
        else ctx.lineTo(x, ys[k]);
      }
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }

    // seed-lights rising off the ridges (treble)
    ctx.globalCompositeOperation = 'lighter';
    const sprite = e.sprite(0.85);
    const n = Math.round(this.seeds.length * (0.4 + 0.6 * p.density) * q);
    for (let i = 0; i < n; i++) {
      const s = this.seeds[i];
      const yy = frac(s.y - t * 0.02 * (0.4 + s.s));
      const x = (s.x + Math.sin(t * 0.3 + s.ph) * 0.03) * w;
      const y = h * (0.15 + 0.8 * yy);
      const size = 5 + s.s * 9 + v.treble * 8;
      ctx.globalAlpha = (0.12 + v.treble * 0.7 + v.transient * 0.3) * (0.4 + 0.6 * Math.sin(t * 2 + s.ph) ** 2) * a;
      ctx.drawImage(sprite, x - size, y - size, size * 2, size * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  dispose() {}
}

export default {
  id: 'waves',
  name: 'Generative Waves',
  blurb: 'Layered ridges shaped by the spectrum itself.',
  trail: 0.5,
  create: (engine) => new Waves(engine),
};
