import { BaseSource } from './BaseSource.js';
import { AudioInputError } from '../errors.js';

/**
 * Microphone input.
 *
 * The stream is analysed only. It is never connected to the speakers (that is
 * what would cause a feedback loop) and never recorded or sent anywhere.
 * Echo cancellation / noise suppression / auto-gain are off so the analysis sees
 * the real signal, e.g. music playing in the room.
 */
export class MicSource extends BaseSource {
  constructor(ctx) {
    super('mic', 'Microphone');
    this.ctx = ctx;
    this.stream = null;
    this.node = null;
  }

  async start() {
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) throw new AudioInputError('unsupported', 'This browser does not expose microphone input.');

    const stream = await md.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    const track = stream.getAudioTracks()[0];
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      throw new AudioInputError('no-device', 'No audio track was provided by the microphone.');
    }
    this.stream = stream;
    track.addEventListener('ended', () => this._interrupted('The microphone was disconnected or its access was revoked.'));
    this.node = this.ctx.createMediaStreamSource(stream);
    this.info = { device: track.label || 'Default microphone' };
    return { node: this.node, monitor: false };
  }

  stop() {
    super.stop();
    try {
      this.node?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = this.node = null;
  }
}
