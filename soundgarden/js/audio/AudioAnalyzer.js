import { clamp, smoothstep } from '../util/math.js';

/**
 * Real-time feature extraction on top of a Web Audio AnalyserNode.
 *
 * This module knows nothing about rendering. It reads the analyser and writes
 * into a shared `features` object that anything (the visual engine, the UI
 * meters, tests) can read.
 *
 * Pipeline per frame:
 *   analyser -> raw band means -> silence gate -> adaptive gain (per-band peak
 *   tracker) -> contrast curve -> asymmetric attack/release smoothing.
 * Beat-like events come from positive spectral flux against an adaptive
 * threshold, so they work at any input level.
 */

export const BANDS = { bass: [20, 250], mid: [250, 4000], treble: [4000, 16000] };
export const SPECTRUM_BINS = 64;
const HIST = 48;

export function createFeatures() {
  return {
    live: false, // a real audio source is feeding the analyser
    simulated: true, // values are an ambient preview, NOT derived from audio
    rms: 0, // raw loudness (0..1), unsmoothed
    level: 0, // smoothed, auto-gained loudness (0..1)
    bass: 0,
    mid: 0,
    treble: 0, // smoothed, auto-gained band energy (0..1)
    energy: 0, // weighted mix of the three bands
    slowEnergy: 0, // long-term average of energy
    delta: 0, // energy - slowEnergy: positive when the music is building
    flux: 0, // smoothed positive spectral change
    beat: 0, // 1 on a bass onset, decays to 0 (~180ms)
    beatCount: 0,
    transient: 0, // 1 on a high-frequency onset, decays (~100ms)
    transientCount: 0,
    centroid: 0.3, // spectral brightness 0 (dark) .. 1 (bright)
    spectrum: new Float32Array(SPECTRUM_BINS), // log-spaced, 30Hz..16kHz
  };
}

/** One-pole follower with separate attack and release time constants (seconds). */
const follow = (cur, target, dt, attack, release) =>
  cur + (target - cur) * (1 - Math.exp(-dt / (target > cur ? attack : release)));

export class AudioAnalyzer {
  constructor(analyser, features) {
    this.an = analyser;
    this.f = features;
    this.freq = new Uint8Array(analyser.frequencyBinCount);
    this.td = new Float32Array(analyser.fftSize);
    this.configure(analyser.context.sampleRate);
    this.reset();
  }

  configure(sampleRate) {
    const n = this.freq.length;
    const hz = sampleRate / (2 * n);
    const idx = (f) => clamp(Math.round(f / hz), 1, n - 1);
    this.hz = hz;
    this.rng = {};
    for (const k of Object.keys(BANDS)) {
      const a = idx(BANDS[k][0]);
      this.rng[k] = [a, Math.max(a + 1, idx(BANDS[k][1]))];
    }
    const lo = 30;
    const hi = Math.min(16000, (sampleRate / 2) * 0.95);
    this.edges = new Uint16Array(SPECTRUM_BINS + 1);
    for (let i = 0; i <= SPECTRUM_BINS; i++) this.edges[i] = idx(lo * Math.pow(hi / lo, i / SPECTRUM_BINS));
  }

  reset() {
    const f = this.f;
    f.rms = f.level = f.bass = f.mid = f.treble = 0;
    f.energy = f.slowEnergy = f.delta = f.flux = f.beat = f.transient = 0;
    f.centroid = 0.3;
    f.spectrum.fill(0);
    this.pk = { bass: 0.15, mid: 0.15, treble: 0.15 };
    this.rmsPk = 0.05;
    this.specPk = 0.2;
    this.prevBass = 0;
    this.prevTreble = 0;
    this.bassHist = new Float32Array(HIST);
    this.trebHist = new Float32Array(HIST);
    this.histPos = 0;
    this.lastBeat = -10;
    this.lastTransient = -10;
  }

  process(dt, now) {
    dt = clamp(dt, 0.001, 0.1);
    const { an, f, freq, td } = this;
    an.getByteFrequencyData(freq);
    an.getFloatTimeDomainData(td);

    let s2 = 0;
    for (let i = 0; i < td.length; i++) s2 += td[i] * td[i];
    const rms = Math.sqrt(s2 / td.length);
    // Silence gate: room noise / paused media should not animate the scene.
    const gate = smoothstep(0.003, 0.012, rms);
    const pkDecay = Math.exp((-dt * Math.LN2) / 6); // peak tracker half-life: 6s

    const norm = {};
    for (const k of ['bass', 'mid', 'treble']) {
      const [a, z] = this.rng[k];
      let sum = 0;
      for (let i = a; i < z; i++) sum += freq[i];
      const mean = sum / (z - a);
      // A plain mean dilutes narrow tonal content in a wide band (a single note in 250-4000Hz).
      // Blend with the mean of the above-average bins so both tonal and broadband sound register.
      let hi = 0;
      let hiN = 0;
      for (let i = a; i < z; i++) {
        if (freq[i] > mean) {
          hi += freq[i];
          hiN++;
        }
      }
      const upper = hiN ? hi / hiN : mean;
      const raw = (0.35 * mean + 0.65 * upper) / 255;
      this.pk[k] = Math.max(raw, this.pk[k] * pkDecay);
      norm[k] = Math.pow(clamp(raw / Math.max(this.pk[k], 0.15)), 1.6) * gate;
    }

    // --- smoothed band values -------------------------------------------
    f.rms = rms;
    f.bass = follow(f.bass, norm.bass, dt, 0.035, 0.32);
    f.mid = follow(f.mid, norm.mid, dt, 0.05, 0.28);
    f.treble = follow(f.treble, norm.treble, dt, 0.03, 0.18);

    this.rmsPk = Math.max(rms, this.rmsPk * pkDecay);
    const lv = clamp(rms / Math.max(this.rmsPk, 0.04)) * gate;
    f.level = follow(f.level, lv, dt, 0.04, 0.25);

    const eRaw = 0.5 * norm.bass + 0.3 * norm.mid + 0.2 * norm.treble;
    f.energy = follow(f.energy, eRaw, dt, 0.08, 0.5);
    f.slowEnergy = follow(f.slowEnergy, eRaw, dt, 3, 3);
    f.delta = f.energy - f.slowEnergy;

    // --- onset detection (spectral flux vs adaptive threshold) -----------
    const bFlux = Math.max(0, norm.bass - this.prevBass);
    const tFlux = Math.max(0, norm.treble - this.prevTreble);
    this.prevBass = norm.bass;
    this.prevTreble = norm.treble;
    f.flux = follow(f.flux, bFlux + tFlux * 0.6, dt, 0.02, 0.2);

    const bThr = this.#threshold(this.bassHist, 0.05);
    const tThr = this.#threshold(this.trebHist, 0.04);
    this.bassHist[this.histPos] = bFlux;
    this.trebHist[this.histPos] = tFlux;
    this.histPos = (this.histPos + 1) % HIST;

    f.beat *= Math.exp(-dt / 0.18);
    f.transient *= Math.exp(-dt / 0.1);
    if (bFlux > bThr && norm.bass > 0.28 && now - this.lastBeat > 0.2) {
      f.beat = 1;
      f.beatCount++;
      this.lastBeat = now;
    }
    if (tFlux > tThr && norm.treble > 0.2 && now - this.lastTransient > 0.07) {
      f.transient = 1;
      f.transientCount++;
      this.lastTransient = now;
    }

    // --- spectral centroid (brightness) ----------------------------------
    let num = 0;
    let den = 0;
    for (let i = 2; i < freq.length; i++) {
      const w = freq[i];
      num += w * Math.log2(i * this.hz);
      den += w;
    }
    if (den > 200 && gate > 0.05) {
      const c = clamp((num / den - Math.log2(120)) / (Math.log2(6000) - Math.log2(120)));
      f.centroid = follow(f.centroid, c, dt, 0.4, 0.4);
    }

    // --- log-spaced spectrum ---------------------------------------------
    const e = this.edges;
    let frameMax = 0;
    const tmp = this._tmp || (this._tmp = new Float32Array(SPECTRUM_BINS));
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const a = e[i];
      const z = Math.max(a + 1, e[i + 1]);
      let sum = 0;
      for (let j = a; j < z; j++) sum += freq[j];
      const v = sum / ((z - a) * 255);
      tmp[i] = v;
      if (v > frameMax) frameMax = v;
    }
    this.specPk = Math.max(frameMax, this.specPk * pkDecay);
    const sp = f.spectrum;
    const specScale = 1 / Math.max(this.specPk, 0.2);
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const t = Math.pow(clamp(tmp[i] * specScale), 1.3) * gate;
      sp[i] = follow(sp[i], t, dt, 0.04, 0.22);
    }
  }

  /** mean + 1.5*std of recent flux, never below `floor`. */
  #threshold(hist, floor) {
    let m = 0;
    for (let i = 0; i < HIST; i++) m += hist[i];
    m /= HIST;
    let v = 0;
    for (let i = 0; i < HIST; i++) v += (hist[i] - m) * (hist[i] - m);
    return Math.max(floor, m + 1.5 * Math.sqrt(v / HIST));
  }
}
