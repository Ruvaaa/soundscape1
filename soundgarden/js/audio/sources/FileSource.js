import { BaseSource } from './BaseSource.js';
import { AudioInputError } from '../errors.js';

const AUDIO_EXT = /\.(mp3|wav|wave|ogg|oga|opus|m4a|aac|flac|webm|weba|mp4)$/i;

/** Plays a user-selected file and exposes it for analysis. */
export class FileSource extends BaseSource {
  constructor(ctx, { file }) {
    super('file', file?.name || 'Audio file');
    this.ctx = ctx;
    this.file = file;
    this.el = null;
    this.url = null;
    this.node = null;
  }

  async start() {
    const file = this.file;
    if (!file) throw new AudioInputError('no-file', 'No file was chosen.');
    if (!(file.type.startsWith('audio/') || file.type === 'video/mp4' || file.type === 'video/webm' || AUDIO_EXT.test(file.name))) {
      throw new AudioInputError('bad-type', `“${file.name}” doesn’t look like an audio file.`);
    }

    this.url = URL.createObjectURL(file);
    const el = (this.el = new Audio());
    el.preload = 'auto';
    el.src = this.url;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new AudioInputError('timeout', 'The file took too long to load.')), 20000);
      el.addEventListener('loadedmetadata', () => (clearTimeout(timer), resolve()), { once: true });
      el.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new AudioInputError('decode', `This browser can’t play “${file.name}”. Its format may not be supported (try MP3, WAV, OGG or M4A).`));
        },
        { once: true },
      );
    });

    // MediaElementSource can only be created once per element; we make a fresh element per file.
    this.node = this.ctx.createMediaElementSource(el);

    const notify = () => this.emit('transport', this.transportState());
    for (const ev of ['play', 'pause', 'ended', 'durationchange', 'seeked']) el.addEventListener(ev, notify);

    this.transport = {
      kind: 'file',
      get playing() {
        return !el.paused && !el.ended;
      },
      get currentTime() {
        return el.currentTime;
      },
      get duration() {
        return Number.isFinite(el.duration) ? el.duration : 0;
      },
      play: () => this.play(),
      pause: () => el.pause(),
      seek: (t) => {
        el.currentTime = Math.max(0, Math.min(t, el.duration || t));
      },
    };

    this.info = { name: file.name, size: file.size };
    this.autoplayBlocked = false;
    try {
      await el.play();
    } catch (err) {
      if (err?.name === 'NotAllowedError') this.autoplayBlocked = true; // user can press play
      else throw err;
    }
    return { node: this.node, monitor: true };
  }

  async play() {
    const el = this.el;
    if (!el) return;
    if (el.ended) el.currentTime = 0;
    await el.play();
  }

  transportState() {
    const t = this.transport;
    return t ? { kind: 'file', playing: t.playing, currentTime: t.currentTime, duration: t.duration } : null;
  }

  stop() {
    super.stop();
    const el = this.el;
    if (el) {
      el.pause();
      el.removeAttribute('src');
      el.load(); // releases the decoder
    }
    try {
      this.node?.disconnect();
    } catch {
      /* already disconnected */
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.el = this.url = this.node = null;
  }
}
