import { BaseSource } from './BaseSource.js';
import { mulberry32 } from '../../util/math.js';

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

// A minor loop: Am - F - C - G. Pad voicings (MIDI) and bass roots.
const CHORDS = [
  { root: 45, pad: [57, 60, 64] },
  { root: 41, pad: [53, 57, 60] },
  { root: 48, pad: [60, 64, 67] },
  { root: 43, pad: [55, 59, 62] },
];
const ARP = [0, 2, 1, 3, 2, 4, 1, 5];

/**
 * A small generative piece, synthesised live with the Web Audio API.
 *
 * It goes through exactly the same analyser as a real file or microphone, so the
 * demo exercises the real audio-reactive pipeline instead of faking values.
 * It has a 16-bar arc (intro, groove, breakdown) so the visuals see dynamics.
 */
export class DemoSource extends BaseSource {
  constructor(ctx) {
    super('demo', 'Demo sound');
    this.ctx = ctx;
    this.bpm = 94;
    this.voices = new Set();
    this.step = 0;
    this.timer = null;
    this.playing = false;
    this.rnd = mulberry32(11);
  }

  async start() {
    const ctx = this.ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.85;

    // Soft echo for the arpeggio and bells.
    this.fx = ctx.createGain();
    const delay = ctx.createDelay(1);
    delay.delayTime.value = (60 / this.bpm) * 0.75;
    const fb = ctx.createGain();
    fb.gain.value = 0.36;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 2600;
    this.fx.connect(delay);
    delay.connect(tone);
    tone.connect(fb);
    fb.connect(delay);
    tone.connect(this.out);
    this.fxNodes = [delay, fb, tone];

    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this.transport = {
      kind: 'demo',
      get playing() {
        return self.playing;
      },
      play: () => this.play(),
      pause: () => this.pause(),
    };
    const self = this;
    this.info = { bpm: this.bpm };
    this.#begin();
    return { node: this.out, monitor: true };
  }

  #begin() {
    this.nextTime = this.ctx.currentTime + 0.06;
    this.playing = true;
    this.timer = setInterval(() => this.#schedule(), 25);
    this.out.gain.cancelScheduledValues(this.ctx.currentTime);
    this.out.gain.setTargetAtTime(0.85, this.ctx.currentTime, 0.05);
    this.emit('transport', { kind: 'demo', playing: true });
  }

  play() {
    if (!this.playing && !this.stopped) this.#begin();
  }

  pause() {
    if (!this.playing) return;
    clearInterval(this.timer);
    this.timer = null;
    this.playing = false;
    this.out.gain.cancelScheduledValues(this.ctx.currentTime);
    this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
    this.emit('transport', { kind: 'demo', playing: false });
  }

  #schedule() {
    const ctx = this.ctx;
    const stepDur = 60 / this.bpm / 4;
    // If the page was backgrounded, don't replay a backlog of steps.
    if (this.nextTime < ctx.currentTime - 0.5) this.nextTime = ctx.currentTime + 0.05;
    while (this.nextTime < ctx.currentTime + 0.15) {
      this.#playStep(this.step, this.nextTime, stepDur);
      this.nextTime += stepDur;
      this.step++;
    }
  }

  #playStep(step, t, stepDur) {
    const s = step % 16;
    const bar = Math.floor(step / 16);
    const section = bar % 16; // 0-3 intro, 4-11 groove, 12-15 breakdown
    const chord = CHORDS[bar % 4];
    const beat = stepDur * 4;
    const groove = section >= 4 && section < 12;

    if (s === 0) {
      for (const n of chord.pad) this.#pad(midi(n), t, beat * 4.2, section >= 12 ? 0.07 : 0.05);
      this.#tone('sine', midi(chord.root), t, beat * 3.8, groove ? 0.34 : 0.2, this.out, 0.02, 0.5);
      if (bar % 2 === 0) this.#tone('sine', midi(chord.pad[2] + 24), t + stepDur * 2, beat * 3, 0.05, this.fx, 0.01, 1.4);
    }
    if (groove) {
      if (s % 4 === 0 || (section >= 8 && s === 10)) this.#kick(t, s === 10 ? 0.5 : 1);
      if (s === 4 || s === 12) this.#snare(t);
      if (s === 6 || s === 14) this.#tone('sine', midi(chord.root), t, stepDur * 1.6, 0.26, this.out, 0.005, 0.12);
    }
    if (section >= 2 && section < 15) {
      const sixteenths = section >= 8 && section < 12;
      if (s % 2 === 0 || sixteenths) this.#hat(t, s % 4 === 2 ? 0.05 : 0.028, s % 8 === 6 ? 0.16 : 0.05);
    }
    if (s % 2 === 0 && !(section === 15 && s > 8)) {
      const pool = [...chord.pad, chord.pad[0] + 12, chord.pad[1] + 12, chord.pad[2] + 12];
      const note = pool[ARP[(s / 2 + bar) % 8]];
      this.#tone('triangle', midi(note), t, stepDur * 2.5, 0.075, this.fx, 0.004, 0.35);
    }
  }

  #voice(osc, gain, t0, dur, release) {
    this.voices.add(osc);
    osc.onended = () => {
      this.voices.delete(osc);
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {
        /* ok */
      }
    };
    osc.start(t0);
    osc.stop(t0 + dur + release + 0.05);
  }

  #tone(type, freq, t, dur, amp, dest, attack = 0.01, release = 0.2) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(amp, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + release);
    osc.connect(g).connect(dest);
    this.#voice(osc, g, t, dur, release);
  }

  #pad(freq, t, dur, amp) {
    const ctx = this.ctx;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(500, t);
    filter.frequency.linearRampToValueAtTime(1700, t + dur * 0.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(amp, t + 0.7);
    g.gain.linearRampToValueAtTime(amp * 0.8, t + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 1.2);
    filter.connect(g).connect(this.out);
    for (const detune of [-9, 8]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.detune.value = detune;
      osc.connect(filter);
      this.#voice(osc, g, t, dur, 1.2);
    }
  }

  #kick(t, vel = 1) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(130, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.14);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.9 * vel, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    osc.connect(g).connect(this.out);
    this.#voice(osc, g, t, 0.4, 0.02);
  }

  #noiseHit(t, { type, freq, q = 0.7, amp, decay }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loopStart = this.rnd() * 0.5;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(amp, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    src.connect(f).connect(g).connect(this.out);
    this.voices.add(src);
    src.onended = () => {
      this.voices.delete(src);
      try {
        src.disconnect();
        g.disconnect();
      } catch {
        /* ok */
      }
    };
    src.start(t, this.rnd() * 0.5);
    src.stop(t + decay + 0.05);
  }

  #hat(t, amp, decay) {
    this.#noiseHit(t, { type: 'highpass', freq: 7500, amp, decay });
  }

  #snare(t) {
    this.#noiseHit(t, { type: 'bandpass', freq: 1900, q: 0.8, amp: 0.2, decay: 0.16 });
  }

  stop() {
    super.stop();
    clearInterval(this.timer);
    this.timer = null;
    this.playing = false;
    for (const v of this.voices) {
      try {
        v.stop();
      } catch {
        /* not started or already stopped */
      }
    }
    this.voices.clear();
    try {
      this.out?.disconnect();
      this.fxNodes?.forEach((n) => n.disconnect());
      this.fx?.disconnect();
    } catch {
      /* ok */
    }
    this.out = this.fx = this.noise = null;
  }
}
