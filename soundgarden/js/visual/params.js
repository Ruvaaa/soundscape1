/** User-adjustable parameters shared by every generator. */
export const PARAM_DEFS = {
  motion: { label: 'Motion', min: 0.2, max: 2, step: 0.01, def: 1, lo: 'Still', hi: 'Restless' },
  density: { label: 'Density', min: 0.1, max: 1, step: 0.01, def: 0.65, lo: 'Sparse', hi: 'Lush' },
  sensitivity: { label: 'Sensitivity', min: 0.3, max: 2.2, step: 0.01, def: 1, lo: 'Calm', hi: 'Responsive' },
  complexity: { label: 'Complexity', min: 0, max: 1, step: 0.01, def: 0.5, lo: 'Simple', hi: 'Intricate' },
  shape: { label: 'Shape', min: 0, max: 1, step: 0.01, def: 0.25, lo: 'Soft', hi: 'Sharp' },
};

export function defaultParams() {
  const p = {};
  for (const [k, d] of Object.entries(PARAM_DEFS)) p[k] = d.def;
  return p;
}
