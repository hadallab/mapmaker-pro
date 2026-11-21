// Clipper (src/vendor/clipper.js) works on integer paths: coordinates are scaled by
// SCALE (0.001 px precision). The library is a global set by the vendor script.

export const SCALE = 1000;

export function lib() {
  const C = globalThis.ClipperLib;
  if (!C) throw new Error('Clipper library is not loaded');
  return C;
}

export const toPath = pts => pts.map(p => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
