import { BaseSource } from './BaseSource.js';
import { AudioInputError } from '../errors.js';

const SURFACE_NAME = { browser: 'a browser tab', window: 'a window', monitor: 'the entire screen' };

/**
 * Browser tab audio and system audio, both via getDisplayMedia().
 *
 * The browser decides what is offered. We never bypass its picker. After the
 * user chooses, we report what was really shared (track.getSettings().displaySurface)
 * and fail clearly if no audio track came back, rather than assuming success.
 *
 * Typical behaviour (varies by browser and OS version):
 *   Chromium desktop: tab audio via "Also share tab audio".
 *   Chromium on Windows / ChromeOS: system audio when sharing the entire screen.
 *   macOS / Linux: usually tab audio only. Firefox / Safari: no audio capture.
 */
export class DisplaySource extends BaseSource {
  constructor(ctx, { kind }) {
    super(kind, kind === 'tab' ? 'Browser tab audio' : 'System audio');
    this.ctx = ctx;
    this.kind = kind;
    this.stream = null;
    this.node = null;
  }

  async start() {
    const md = navigator.mediaDevices;
    if (!md?.getDisplayMedia) throw new AudioInputError('unsupported', 'This browser cannot capture tab or system audio.');
    const tab = this.kind === 'tab';

    // Unknown members are ignored by browsers that don't implement them.
    const stream = await md.getDisplayMedia({
      video: { displaySurface: tab ? 'browser' : 'monitor' },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: tab ? 'exclude' : 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      preferCurrentTab: false,
    });

    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();
    if (!audioTracks.length) {
      stream.getTracks().forEach((t) => t.stop());
      throw new AudioInputError(
        'no-audio',
        tab
          ? 'The tab was shared without audio. Choose a tab again and tick “Also share tab audio” in the browser dialog.'
          : 'No system audio was shared. Choose “Entire screen” and tick “Also share system audio”. Browsers on macOS and Linux often can’t offer this; tab audio may work instead.',
      );
    }

    const surface = videoTracks[0]?.getSettings?.().displaySurface;
    this.stream = stream;
    // Only the audio is analysed. Keep the video track (ending it can end the share)
    // but switch it off so nothing is decoded.
    videoTracks.forEach((t) => (t.enabled = false));
    const onEnd = () => this._interrupted('Sharing was stopped.');
    stream.getTracks().forEach((t) => t.addEventListener('ended', onEnd, { once: true }));

    this.node = this.ctx.createMediaStreamSource(new MediaStream(audioTracks));

    let warning = '';
    if (!tab && surface && surface !== 'monitor') {
      warning = `You shared ${SURFACE_NAME[surface] || 'something else'} rather than the entire screen, so only that source’s audio is captured.`;
    } else if (tab && surface === 'monitor') {
      warning = 'You shared the entire screen, so this is system audio rather than a single tab.';
    }
    this.info = { surface: surface || 'unknown', sharing: SURFACE_NAME[surface] || 'a source', warning };
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
