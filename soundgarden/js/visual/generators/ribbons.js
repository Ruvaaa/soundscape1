import { noise3 } from '../../util/noise.js';
import { frac, lerp, mulberry32, TAU } from '../../util/math.js';

/**
 * Ribbon Bloom: fronds of light rooted at the bottom of the frame.
 *
 *   bass    -> how tall and wide the fronds swell, soft orbs expand
 *   mid     -> how strongly the fronds sway and bend (organic deformation)
 *   treble  -> fine veins, edge shimmer, little points of light
 *   beat    -> a ripple that travels up every frond
 *   energy  -> overall brightness and the glow at the roots
 */
const MAX_FRONDS = 14;
const MAX_POINTS = 48;

class Ribbons {
  constructor(engine) {
    this.e = engine;
    this.w = 1;
    this.h = 1;
    this.t = 0;
    this.ripple = 0;
    const r = mulberry32(7);
    // Golden-ratio spacing: any prefix of the list is evenly spread, so complexity can add fronds smoothly.
    this.fronds = Array.from({ length: MAX_FRONDS }, (_, i) => ({
      rx: 0.06 + 0.88 * frac(i * 0.618034 + 0.1),
      len: 0.55 + 0.4 * r(),
      ci: frac(i * 0.37 + 0.08),
      ph: r() * TAU,
      sway: 0.6 + 0.8 * r(),
      wid: 0.7 + 0.6 * r(),
      lean: (r() - 0.5) * 0.5,
      spark: r() * 10,
    }));
    this.orbs = Array.from({ length: 5 }, (_, i) => ({ ph: i * 3.1 + 0.7, ci: frac(i * 0.23 + 0.2), r: 0.6 + r() * 0.8 }));
    this.X = new Float32Array(MAX_POINTS);
    this.Y = new Float32Array(MAX_POINTS);
    this.W = new Float32Array(MAX_POINTS);
    this.P = new Float32Array(MAX_POINTS * 4); // outline: left edge forward, right edge back
  }

  resize(w, h) {
    this.w = w;
    this.h = h;
  }

  update(dt, t, v, p) {
    this.t = t;
    this.v = v;
    this.p = p;
    this.ripple += dt * (1.5 + v.bass * 3 + v.energy * 2) * (0.4 + p.motion * 0.6);
  }

  draw(ctx, a) {
    const { w, h, v, p, t, e } = this;
    const pal = e.pal;
    const q = e.quality;
    ctx.globalCompositeOperation = 'lighter';
    // Additive layers pile up across frames behind a trailing veil (steady state ~ alpha / veil),
    // so ambient light is scaled down to land at a sensible brightness.
    const K = 0.2;

    // soft evolving orbs: atmosphere behind the fronds
    for (const o of this.orbs) {
      const ox = w * (0.5 + 0.42 * noise3(o.ph, t * 0.05, 0));
      const oy = h * (0.45 + 0.35 * noise3(o.ph, t * 0.05, 9));
      const rad = (0.16 + 0.12 * o.r) * Math.max(w, h) * (1 + v.bass * 0.55 + v.energy * 0.2);
      const g = ctx.createRadialGradient(ox, oy, 0, ox, oy, rad);
      g.addColorStop(0, pal.rgba(o.ci, (0.1 + 0.22 * v.energy) * a * K));
      g.addColorStop(1, pal.rgba(o.ci, 0));
      ctx.fillStyle = g;
      ctx.fillRect(ox - rad, oy - rad, rad * 2, rad * 2);
    }

    // glow at the roots
    {
      const rad = Math.max(w, h) * (0.35 + 0.15 * v.bass);
      const g = ctx.createRadialGradient(w / 2, h * 1.02, 0, w / 2, h * 1.02, rad);
      g.addColorStop(0, pal.rgba(0.75, (0.12 + 0.3 * v.energy) * a * K));
      g.addColorStop(1, pal.rgba(0.75, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, h - rad, w, rad + h * 0.05);
    }

    const count = Math.round(lerp(4, MAX_FRONDS, p.complexity));
    const M = Math.round(26 + (MAX_POINTS - 26) * q);
    const { X, Y, W, P } = this;
    const shapeExp = lerp(0.55, 1.7, p.shape);
    const angular = p.shape > 0.72;
    const drive = a * (0.7 + 0.5 * v.energy + 0.25 * v.beat) * 0.34;

    for (let i = 0; i < count; i++) {
      const f = this.fronds[i];
      const baseX = f.rx * w;
      const baseY = h * 1.03;
      const grow = f.len * h * (0.78 + v.bass * 0.3 + v.energy * 0.08);
      const bend = (0.55 + v.mid * 1.5) * f.sway;
      const freq = 0.9 + v.mid * 0.9 + p.complexity * 0.6;
      const wmax = Math.min(w, h) * 0.028 * f.wid * (0.7 + v.bass * 0.9);

      for (let k = 0; k < M; k++) {
        const s = k / (M - 1);
        const sway =
          noise3(f.rx * 4 + s * 1.4 * freq, f.ph, t * 0.22) * w * 0.11 * bend * Math.pow(s, 1.1) +
          Math.sin(t * 0.6 * f.sway + f.ph + s * 2.6) * w * 0.035 * s * (1 + v.energy);
        const rip = Math.sin(s * 9 - this.ripple * 2 + f.ph) * (v.beat * 0.035 + v.treble * 0.012) * w * s;
        X[k] = baseX + sway + rip + f.lean * w * s * 0.5;
        Y[k] = baseY - s * grow;
        const prof = Math.pow(Math.max(0, Math.sin(Math.PI * Math.pow(s, 0.82))), shapeExp);
        W[k] = wmax * prof * (1 + 0.35 * Math.sin(s * 14 - this.ripple * 3 + f.ph) * v.treble);
      }

      const gTop = baseY - grow;
      const grad = ctx.createLinearGradient(baseX, baseY, baseX, gTop);
      grad.addColorStop(0, pal.rgba(f.ci, 0));
      grad.addColorStop(0.3, pal.rgba((f.ci + 0.18) % 1, 0.95));
      grad.addColorStop(1, pal.rgba((f.ci + 0.4) % 1, 0.85));

      const passes = [
        [2.4, 0.06],
        [1.4, 0.14],
        [0.8, 0.36],
      ];
      for (const [sc, al] of passes) {
        // outline from the centreline and its normals
        for (let k = 0; k < M; k++) {
          const k0 = k === 0 ? 0 : k - 1;
          const k1 = k === M - 1 ? k : k + 1;
          let dx = X[k1] - X[k0];
          let dy = Y[k1] - Y[k0];
          const len = Math.hypot(dx, dy) || 1;
          dx /= len;
          dy /= len;
          const off = W[k] * sc;
          P[k * 2] = X[k] - dy * off;
          P[k * 2 + 1] = Y[k] + dx * off;
          const j = (2 * M - 1 - k) * 2;
          P[j] = X[k] + dy * off;
          P[j + 1] = Y[k] - dx * off;
        }
        const n = M * 2;
        ctx.beginPath();
        if (angular) {
          ctx.moveTo(P[0], P[1]);
          for (let k = 1; k < n; k++) ctx.lineTo(P[k * 2], P[k * 2 + 1]);
        } else {
          const lx = (P[(n - 1) * 2] + P[0]) / 2;
          const ly = (P[(n - 1) * 2 + 1] + P[1]) / 2;
          ctx.moveTo(lx, ly);
          for (let k = 0; k < n; k++) {
            const nk = (k + 1) % n;
            ctx.quadraticCurveTo(P[k * 2], P[k * 2 + 1], (P[k * 2] + P[nk * 2]) / 2, (P[k * 2 + 1] + P[nk * 2 + 1]) / 2);
          }
        }
        ctx.closePath();
        ctx.globalAlpha = al * drive;
        ctx.fillStyle = grad;
        ctx.fill();
      }

      // fine vein along the centre: treble brightens it
      ctx.globalAlpha = (0.14 + v.treble * 0.55) * a;
      ctx.strokeStyle = pal.at((f.ci + 0.55) % 1);
      ctx.lineWidth = 0.8 + v.treble * 0.8;
      ctx.beginPath();
      ctx.moveTo(X[0], Y[0]);
      for (let k = 1; k < M; k++) ctx.lineTo(X[k], Y[k]);
      ctx.stroke();

      // points of light drifting along the frond
      const sprite = e.sprite((f.ci + 0.5) % 1);
      for (let j = 0; j < 5; j++) {
        const s = frac(j * 0.21 + f.spark * 0.1 + t * 0.03 * (1 + j * 0.2));
        const k = Math.round(s * (M - 1));
        const side = j % 2 ? 1 : -1;
        const tw = 0.5 + 0.5 * Math.sin(t * 3 + f.spark + j * 2);
        const size = 8 + v.treble * 20 + W[k] * 0.4;
        ctx.globalAlpha = (0.1 + v.treble * 0.8 + v.transient * 0.3) * tw * a;
        ctx.drawImage(sprite, X[k] + side * W[k] * 0.6 - size, Y[k] - size, size * 2, size * 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  dispose() {}
}

export default {
  id: 'ribbons',
  name: 'Ribbon Bloom',
  blurb: 'Fronds of light that sway, swell and ripple.',
  trail: 0.22,
  create: (engine) => new Ribbons(engine),
};
