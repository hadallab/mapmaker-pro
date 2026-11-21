// Monospace font stack for text drawn on the canvas, read once from the --mono CSS variable.

const FALLBACK = 'Consolas, "JetBrains Mono", monospace';
let cached = null;

export function getMonoFont() {
  if (cached) return cached;
  if (typeof document === 'undefined' || !document.body) return FALLBACK;
  cached = getComputedStyle(document.body).getPropertyValue('--mono').trim() || FALLBACK;
  return cached;
}
