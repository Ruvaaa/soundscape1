/**
 * Feature detection only. Whether a given OS/browser will actually deliver
 * system audio can't be known until the user picks a source, so the UI reports
 * what the browser really returned instead of promising it up front.
 */
export function detectSupport() {
  const md = navigator.mediaDevices;
  const secure = window.isSecureContext;
  const needSecure = 'Needs a secure page (https or localhost).';
  return {
    webAudio: !!(window.AudioContext || window.webkitAudioContext),
    file: { ok: true },
    demo: { ok: true },
    mic:
      md?.getUserMedia && secure
        ? { ok: true }
        : { ok: false, reason: secure ? 'This browser does not expose microphone input.' : needSecure },
    tab:
      md?.getDisplayMedia && secure
        ? { ok: true }
        : { ok: false, reason: secure ? 'This browser cannot share a tab’s audio.' : needSecure },
    system:
      md?.getDisplayMedia && secure
        ? { ok: true, caveat: 'Support varies by browser and operating system.' }
        : { ok: false, reason: secure ? 'This browser cannot share system audio.' : needSecure },
  };
}
