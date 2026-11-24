import { Emitter } from '../../util/emitter.js';

/**
 * An audio source produces ONE AudioNode that the engine taps for analysis.
 *
 *   start() -> { node, monitor }
 *     node     the AudioNode to analyse
 *     monitor  true if the engine should also route it to the speakers.
 *              Live captures (mic / tab / system) are never monitored: that
 *              would create a feedback loop (mic) or double the sound (tab).
 *   stop()   release everything: stop media tracks, pause elements, revoke URLs.
 *
 * Events: 'ended' ({reason}) when the input is interrupted from outside,
 *         'transport' when play/pause/seek state changes.
 */
export class BaseSource extends Emitter {
  constructor(id, label) {
    super();
    this.id = id;
    this.label = label;
    this.info = {};
    this.transport = null;
    this.stopped = false;
  }

  async start() {
    throw new Error('not implemented');
  }

  stop() {
    this.stopped = true;
  }

  /** Called when the browser/user ends the input (device unplugged, Stop sharing). */
  _interrupted(reason) {
    if (this.stopped) return;
    this.emit('ended', { reason });
  }
}
