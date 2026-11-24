import { noise3 } from '../../util/noise.js';
import { clamp, frac, lerp, mulberry32, TAU } from '../../util/math.js';

/**
 * Particle Garden: blooms that emit spiralling motes, petals and fireflies.
 *
 *   bass    -> outward push from each bloom, bigger bursts, bloom light swells
 *   mid     -> swirl and flow-field strength, bloom rotation
 *   treble  -> firefly sparks (rate and twinkle) and the seed-head's fine dots
 *   beat    -> a ring of motes plus a few petals from every bloom
 *   spectrum-> brightness of each dot in the central seed head (frequency to place)
 */
const MAX = 4600;
const BUCKETS = 20;
const GOLDEN = 2.399963229728653; // golden angle in radians

class Garden {
  constructor(engine) {
    this.e = engine;
    this.w = 1;
    this.h = 1;
    this.t = 0;
    this.rnd = mulberry32(31);

    this.x = new Float32Array(MAX);
    this.y = new Float32Array(MAX);
    this.vx = new Float32Array(MAX);
    this.vy = new Float32Array(MAX);
    this.life = new Float32Array(MAX); // remaining seconds, <=0 means free
    this.max = new Float32Array(MAX);
    this.size = new Float32Array(MAX);
    this.ci = new Float32Array(MAX);
    this.seed = new Float32Array(MAX);
    this.spin = new Float32Array(MAX);
    this.kind = new Uint8Array(MAX); // 0 mote, 1 spark, 2 petal
    this.bloom = new Uint8Array(MAX);
    this.cursor = 0;
    this.petals = 0;
    this.sparkAcc = 0;
    this.moteAcc = 0;
    this.prevBeat = 0;

    this.blooms = [
      { fx: 0.5, fy: 0.6, phase: 0, hue: 0.1, nx: 1 },
      { fx: 0.2, fy: 0.4, phase: 2, hue: 0.45, nx: 2 },
      { fx: 0.8, fy: 0.38, phase: 4, hue: 0.75, nx: 3 },
    ];
    this.order = new Uint16Array(MAX);
    this.counts = new Uint32Array(BUCKETS + 1);
    this.glow = new Uint16Array(MAX);
    this.streak = new Uint16Array(MAX);
  }

  resize(w, h) {
    this.w = w;
    this.h = h;
  }

  #slot() {
    const n = MAX;
    for (let k = 0; k < 64; k++) {
      const i = (this.cursor + k) % n;
      if (this.life[i] <= 0) {
        this.cursor = (i + 1) % n;
        return i;
      }
    }
    const i = this.cursor; // pool is full: recycle the oldest-ish slot
    this.cursor = (i + 1) % n;
    if (this.kind[i] === 2) this.petals--;
    return i;
  }

  #spawn(kind, bi, x, y, vx, vy, life, size, ci) {
    const i = this.#slot();
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.life[i] = this.max[i] = life;
    this.size[i] = size;
    this.ci[i] = ci;
    this.kind[i] = kind;
    this.bloom[i] = bi;
    this.seed[i] = this.rnd();
    this.spin[i] = (this.rnd() < 0.5 ? -1 : 1) * (0.4 + this.rnd());
    if (kind === 2) this.petals++;
  }

  #bloomPos(b, t, out) {
    out.x = this.w * (b.fx + 0.05 * noise3(b.nx, t * 0.04, 0));
    out.y = this.h * (b.fy + 0.05 * noise3(b.nx, t * 0.04, 5));
  }

  update(dt, t, v, p) {
    this.t = t;
    this.v = v;
    this.p = p;
    const { w, h, rnd } = this;
    const q = this.e.quality;
    const dens = p.density * q;
    const nBlooms = 1 + Math.round(p.complexity * 2);
    const arms = 5 + Math.round(p.complexity * 8);
    const pos = (this._pos ||= { x: 0, y: 0 });
    this.nBlooms = nBlooms;
    this.arms = arms;

    for (let b = 0; b < 3; b++) {
      const bl = this.blooms[b];
      bl.phase += dt * (0.15 + 0.5 * v.mid) * p.motion;
      this.#bloomPos(bl, t, pos);
      bl.px = pos.x;
      bl.py = pos.y;
    }

    // emission: motes from the blooms along spiral arms
    this.moteAcc += (40 + 520 * v.energy + 200 * v.bass) * dens * dt;
    while (this.moteAcc >= 1) {
      this.moteAcc -= 1;
      const bi = (rnd() * nBlooms) | 0;
      const bl = this.blooms[bi];
      const arm = (rnd() * arms) | 0;
      const th = bl.phase + (arm / arms) * TAU + (rnd() - 0.5) * 0.12;
      const sp = 30 + 110 * rnd() + 160 * v.bass;
      this.#spawn(0, bi, bl.px, bl.py, Math.cos(th) * sp, Math.sin(th) * sp, 2.4 + 2.2 * rnd(), 1.6 + 3.4 * rnd() * rnd() * 2, frac((arm / arms) * 0.6 + bl.hue + t * 0.02 + rnd() * 0.1));
    }

    // fireflies: treble
    this.sparkAcc += (20 + 300 * Math.pow(Math.min(1, v.treble), 1.5) + 120 * v.transient) * dens * dt;
    while (this.sparkAcc >= 1) {
      this.sparkAcc -= 1;
      this.#spawn(1, 0, rnd() * w, h * (0.25 + 0.75 * rnd()), (rnd() - 0.5) * 12, -(10 + 30 * rnd()), 1 + 1.6 * rnd(), 0.9 + 1.3 * rnd(), 0.55 + 0.45 * rnd());
    }

    // beat: ring burst + petals
    if (v.beat > 0.9 && this.prevBeat <= 0.9) {
      const n = Math.round((60 + 140 * p.density) * q);
      for (let b = 0; b < nBlooms; b++) {
        const bl = this.blooms[b];
        for (let k = 0; k < n; k++) {
          const th = (k / n) * TAU + rnd() * 0.1;
          const sp = 150 + 110 * rnd();
          this.#spawn(0, b, bl.px, bl.py, Math.cos(th) * sp, Math.sin(th) * sp, 1.8 + 1.4 * rnd(), 2.4 + 3 * rnd(), frac(0.7 + bl.hue * 0.3 + rnd() * 0.2));
        }
        if (this.petals < 260) {
          for (let k = 0; k < 6; k++) {
            const th = rnd() * TAU;
            this.#spawn(2, b, bl.px, bl.py, Math.cos(th) * (60 + 70 * rnd()), Math.sin(th) * (60 + 70 * rnd()), 3.5 + 1.5 * rnd(), 5 + 5 * rnd(), frac(0.45 + rnd() * 0.4));
          }
        }
      }
    }
    this.prevBeat = v.beat;

    // integrate
    const drag = Math.exp(-dt * 0.9);
    const flow = (14 + 70 * v.mid) * p.motion;
    const push = v.bass * 140 + v.beat * 260;
    const swirl = 0.4 + 1.6 * v.mid;
    for (let i = 0; i < MAX; i++) {
      let life = this.life[i];
      if (life <= 0) continue;
      life -= dt;
      if (life <= 0) {
        this.life[i] = 0;
        if (this.kind[i] === 2) this.petals--;
        continue;
      }
      this.life[i] = life;
      const x = this.x[i];
      const y = this.y[i];
      let vx = this.vx[i];
      let vy = this.vy[i];
      const kind = this.kind[i];
      const ang = noise3(x * 0.0014, y * 0.0014, t * 0.08 + this.seed[i] * 0.2) * TAU * 1.4;
      let ax = Math.cos(ang) * flow;
      let ay = Math.sin(ang) * flow;
      if (kind !== 1) {
        const om = this.spin[i] * swirl * 0.6;
        ax += -vy * om;
        ay += vx * om;
        const bl = this.blooms[this.bloom[i]];
        const dx = x - bl.px;
        const dy = y - bl.py;
        const d = Math.hypot(dx, dy) + 1;
        const pu = push / (1 + d * 0.004);
        ax += (dx / d) * pu;
        ay += (dy / d) * pu;
      } else {
        ay -= 8;
      }
      vx = vx * drag + ax * dt;
      vy = vy * drag + ay * dt;
      this.vx[i] = vx;
      this.vy[i] = vy;
      const nx = x + vx * dt;
      const ny = y + vy * dt;
      this.x[i] = nx;
      this.y[i] = ny;
      if (nx < -80 || nx > w + 80 || ny < -80 || ny > h + 80) {
        this.life[i] = 0;
        if (kind === 2) this.petals--;
      }
    }
  }

  draw(ctx, a) {
    const { w, h, v, p, t, e } = this;
    const pal = e.pal;
    const sp = v.spectrum;
    ctx.globalCompositeOperation = 'lighter';

    // bloom light + seed head
    for (let b = 0; b < this.nBlooms; b++) {
      const bl = this.blooms[b];
      const rad = (120 + 160 * v.bass + 60 * v.beat) * (b === 0 ? 1.2 : 0.85);
      const g = ctx.createRadialGradient(bl.px, bl.py, 0, bl.px, bl.py, rad);
      g.addColorStop(0, pal.rgba(frac(bl.hue + 0.3), (0.12 + 0.3 * v.bass) * a * 0.22));
      g.addColorStop(1, pal.rgba(frac(bl.hue + 0.3), 0));
      ctx.fillStyle = g;
      ctx.fillRect(bl.px - rad, bl.py - rad, rad * 2, rad * 2);

      // seed head: phyllotaxis dots, each tied to a slice of the spectrum
      const n = Math.round((50 + p.complexity * 110) * e.quality);
      const scale = (b === 0 ? 7.5 : 5) * (1 + v.bass * 0.3);
      const sprite = e.sprite(frac(bl.hue + 0.55));
      for (let k = 1; k < n; k++) {
        const r = Math.sqrt(k) * scale;
        const th = k * GOLDEN + bl.phase * 0.6;
        const band = sp[Math.min(63, Math.floor((k / n) * 64))] * v.sens;
        const size = 3 + band * 7 + v.treble * 2;
        ctx.globalAlpha = (0.04 + Math.min(1, band) * 0.3) * a;
        ctx.drawImage(sprite, bl.px + Math.cos(th) * r - size, bl.py + Math.sin(th) * r - size, size * 2, size * 2);
      }
    }

    // sort live particles into colour buckets
    const { life, kind, ci, seed, order, counts, glow, streak } = this;
    const shape = p.shape;
    let ng = 0;
    let ns = 0;
    for (let i = 0; i < MAX; i++) {
      if (life[i] <= 0 || kind[i] === 2) continue;
      if (kind[i] === 0 && seed[i] < shape) streak[ns++] = i;
      else glow[ng++] = i;
    }

    counts.fill(0);
    for (let k = 0; k < ng; k++) counts[Math.min(BUCKETS - 1, (ci[glow[k]] * BUCKETS) | 0) + 1]++;
    for (let b = 0; b < BUCKETS; b++) counts[b + 1] += counts[b];
    for (let k = 0; k < ng; k++) order[counts[Math.min(BUCKETS - 1, (ci[glow[k]] * BUCKETS) | 0)]++] = glow[k];

    const lift = 0.55 + 0.6 * v.energy;
    let from = 0;
    for (let b = 0; b < BUCKETS; b++) {
      const to = counts[b];
      if (to === from) continue;
      const sprite = e.sprite((b + 0.5) / BUCKETS);
      for (let k = from; k < to; k++) {
        const i = order[k];
        const lf = life[i] / this.max[i];
        let al;
        let s;
        if (kind[i] === 1) {
          const tw = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * (6 + seed[i] * 10) + seed[i] * 40));
          al = tw * (0.35 + v.treble * 0.9) * Math.min(1, lf * 3);
          s = this.size[i] * 4.5;
        } else {
          al = Math.pow(Math.sin(Math.PI * (1 - lf)), 0.8) * 0.8 * lift;
          s = this.size[i] * 3.2 * (1 + v.bass * 0.4);
        }
        ctx.globalAlpha = al * a;
        ctx.drawImage(sprite, this.x[i] - s, this.y[i] - s, s * 2, s * 2);
      }
      from = to;
    }

    // streaks (the Shape slider turns soft glows into light-lines)
    if (ns) {
      ctx.lineWidth = 1.2;
      ctx.lineCap = 'round';
      const byBucket = (this._sb ||= Array.from({ length: BUCKETS }, () => []));
      for (let b = 0; b < BUCKETS; b++) byBucket[b].length = 0;
      for (let k = 0; k < ns; k++) byBucket[Math.min(BUCKETS - 1, (ci[streak[k]] * BUCKETS) | 0)].push(streak[k]);
      ctx.globalAlpha = (0.35 + 0.35 * v.energy) * a;
      for (let b = 0; b < BUCKETS; b++) {
        const list = byBucket[b];
        if (!list.length) continue;
        ctx.strokeStyle = pal.at((b + 0.5) / BUCKETS);
        ctx.beginPath();
        for (const i of list) {
          const tx = this.vx[i] * 0.07;
          const ty = this.vy[i] * 0.07;
          ctx.moveTo(this.x[i], this.y[i]);
          ctx.lineTo(this.x[i] - tx, this.y[i] - ty);
        }
        ctx.stroke();
      }
    }

    // petals
    if (this.petals > 0) {
      const sharp = shape > 0.5;
      for (let i = 0; i < MAX; i++) {
        if (life[i] <= 0 || kind[i] !== 2) continue;
        const lf = life[i] / this.max[i];
        const rot = Math.atan2(this.vy[i], this.vx[i]) + t * this.spin[i] * 0.6;
        const s = this.size[i] * (1 + v.bass * 0.3);
        ctx.globalAlpha = Math.sin(Math.PI * (1 - lf)) * 0.45 * a;
        ctx.fillStyle = pal.at(ci[i]);
        ctx.save();
        ctx.translate(this.x[i], this.y[i]);
        ctx.rotate(rot);
        ctx.beginPath();
        if (sharp) {
          ctx.moveTo(s * 1.6, 0);
          ctx.lineTo(0, s * 0.5);
          ctx.lineTo(-s * 1.6, 0);
          ctx.lineTo(0, -s * 0.5);
          ctx.closePath();
        } else {
          ctx.ellipse(0, 0, s * 1.5, s * 0.6, 0, 0, TAU);
        }
        ctx.fill();
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  }

  dispose() {}
}

export default {
  id: 'garden',
  name: 'Particle Garden',
  blurb: 'Blooms that scatter motes, petals and fireflies.',
  trail: 0.2,
  create: (engine) => new Garden(engine),
};
