import { AudioEngine } from './audio/AudioEngine.js';
import { VisualEngine } from './visual/VisualEngine.js';
import { SoundgardenUI } from './ui/ui.js';

// Audio and visuals are wired together only through the shared `features` object.
const audio = new AudioEngine();
const visual = new VisualEngine(document.getElementById('stage'), audio.features);
const ui = new SoundgardenUI({ audio, visual });
visual.start();

// Release microphone / screen-capture streams and the audio context when leaving the page.
addEventListener('pagehide', (e) => {
  audio.setSource(null);
  if (!e.persisted) {
    visual.dispose();
    audio.dispose();
  }
});

// `?debug` exposes the engines for automated tests and console poking.
if (new URLSearchParams(location.search).has('debug')) window.__soundgarden = { audio, visual, ui };
