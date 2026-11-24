export class AudioInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AudioInputError';
    this.code = code;
  }
}

/** Turn a browser media error into a short, actionable message. */
export function describeError(err, kind) {
  if (err instanceof AudioInputError) return { code: err.code, message: err.message };
  const sharing = kind === 'tab' || kind === 'system';
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return sharing
        ? { code: 'denied', message: 'Sharing was cancelled or not allowed. Pick a tab or screen in the browser dialog to continue.' }
        : { code: 'denied', message: 'Microphone access was blocked. Allow it in the browser’s site settings (the icon beside the address), then try again.' };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return { code: 'no-device', message: sharing ? 'Nothing was available to share.' : 'No microphone was found. Connect one and try again.' };
    case 'NotReadableError':
    case 'TrackStartError':
      return { code: 'busy', message: 'The input device is unavailable. Another app may be using it.' };
    case 'OverconstrainedError':
      return { code: 'constraints', message: 'The selected device does not support the requested audio settings.' };
    case 'AbortError':
      return { code: 'aborted', message: 'The request was interrupted. Please try again.' };
    case 'NotSupportedError':
    case 'TypeError':
      return { code: 'unsupported', message: 'This browser does not support that kind of audio capture.' };
    default:
      return { code: 'error', message: err?.message || 'Something went wrong starting this input.' };
  }
}
