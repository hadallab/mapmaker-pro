// Pure helpers for Sky / Wat gradient spans, colour interpolation and seam matching.
// All coordinate inputs and outputs are in file pixels (1 Mapmaker unit = 10 px).

import { bounds, clamp, hexToInt, intToHex, isClockwise, pointInPolygon } from './geometry.js';
import { THIN_SKY_MIN_PX, testerGradientColors } from './tester.js';

export const SEAM_TOLERANCE_PX = 1; // 0.1 Mapmaker units

export function isGradientObject(obj) {
  return Boolean(
    obj &&
    (obj.type === 'Sky' || obj.type === 'Wat') &&
    Array.isArray(obj.points) &&
    obj.points.length >= 3
  );
}

export function isThinSky(obj, objBounds = null) {
  if (!obj || obj.type !== 'Sky' || !Array.isArray(obj.points) || obj.points.length < 3) return false;
  const b = objBounds || bounds(obj.points);
  return b.height < THIN_SKY_MIN_PX;
}

export function normalizeGradientColors(colors) {
  if (!Array.isArray(colors) || colors.length === 0) return [0, 0];
  if (colors.length === 1) {
    const c = hexToInt(colors[0]);
    return [c, c];
  }
  return colors.map(hexToInt);
}

function sameColorArrays(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (hexToInt(a[i]) !== hexToInt(b[i])) return false;
  }
  return true;
}

/**
 * Computes the vertical gradient span of a Sky or Wat polygon, matching Renderer.gradientSpan().
 */
export function gradientSpan(obj) {
  if (!isGradientObject(obj)) return null;
  const b = bounds(obj.points);
  let rawTop = b.y;
  let rawBottom = b.y + b.height;
  if (obj.type === 'Wat' && obj.hasBorder) {
    const pts = obj.points.slice();
    if (!isClockwise(pts)) pts.reverse();
    for (let i = 0; i < pts.length; i++) {
      const l = pts[i];
      const c = pts[i > 0 ? i - 1 : pts.length - 1];
      if (l.x > c.x && l.x - c.x > 10) {
        rawTop = Math.min(rawTop, c.y - 1.5, l.y - 1.5);
        rawBottom = Math.max(rawBottom, c.y + 1.5, l.y + 1.5);
      }
    }
  }
  const top = Math.round(rawTop);
  const height = rawBottom - rawTop;
  return {
    top,
    bottom: top + height,
    height,
    rawTop,
    rawBottom,
    bounds: b,
    cx: b.x + b.width / 2
  };
}

/**
 * Piecewise-linear RGB colour interpolation at file coordinate `y` along a Sky/Wat gradient span.
 * Returns a 24-bit integer colour (0xrrggbb).
 */
export function colorAtY(obj, y, { testerPreview = false } = {}) {
  if (!isGradientObject(obj)) return 0;
  const span = gradientSpan(obj);
  if (!span) return 0;
  const colors = testerPreview
    ? testerGradientColors(obj).map(hexToInt)
    : normalizeGradientColors(obj.colors);

  if (testerPreview && isThinSky(obj, span.bounds) && colors[0] !== colors[1]) {
    return 0;
  }

  const h = span.height > 0 ? span.height : 0;
  const t = h > 0 ? clamp((y - span.top) / h, 0, 1) : 0;
  const stepCount = colors.length - 1;
  if (stepCount <= 0) return colors[0];

  const u = t * stepCount;
  const i = Math.min(Math.floor(u), stepCount - 1);
  const f = u - i;
  const a = colors[i];
  const b = colors[i + 1];

  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;

  const r = clamp(Math.round(ar + (br - ar) * f), 0, 255);
  const g = clamp(Math.round(ag + (bg - ag) * f), 0, 255);
  const bl = clamp(Math.round(ab + (bb - ab) * f), 0, 255);
  return (r << 16) | (g << 8) | bl;
}

/**
 * Returns a new 2-stop-compatible integer colour array with the requested stop replaced.
 * Thin Sky polygons (< 1.5 file px) are always kept solid [c, c].
 */
export function setGradientStop(obj, stop, color) {
  const c = hexToInt(color);
  if (isThinSky(obj)) return [c, c];
  const cols = normalizeGradientColors(obj?.colors);
  let idx;
  if (stop === 'top' || stop === 0) idx = 0;
  else if (stop === 'bottom' || stop === 'last' || Number(stop) >= cols.length - 1) idx = cols.length - 1;
  else idx = clamp(Math.floor(Number(stop) || 0), 0, cols.length - 1);
  return cols.map((v, i) => (i === idx ? c : v));
}

/**
 * Computes the adjoining stop colours so `upper` and `lower` meet cleanly at their
 * horizontal boundary, using the colour of `upper` at the boundary.
 * Preserves 2-stop compatibility and keeps thin Sky (< 1.5 file px) solid [c, c].
 */
export function matchSeam(upper, lower, { seamY = null, testerPreview = false } = {}) {
  if (!isGradientObject(upper) || !isGradientObject(lower)) return null;
  const bU = bounds(upper.points);
  const bL = bounds(lower.points);
  const uBot = bU.y + bU.height;
  const lTop = bL.y;

  let y = seamY;
  if (y == null || !Number.isFinite(y)) {
    y = (uBot >= lTop - SEAM_TOLERANCE_PX && lTop >= bU.y) ? lTop : uBot;
  }

  const upperNorm = normalizeGradientColors(upper.colors);
  let color;
  let upperColors;
  if (isThinSky(upper, bU)) {
    color = upperNorm[0];
    upperColors = [color, color];
  } else {
    color = colorAtY(upper, y, { testerPreview });
    upperColors = upperNorm;
  }

  const lowerColors = setGradientStop(lower, 'top', color);
  return {
    seamY: y,
    color,
    hex: intToHex(color),
    upperColors,
    lowerColors,
    upperChanged: !sameColorArrays(upper.colors, upperColors),
    lowerChanged: !sameColorArrays(lower.colors, lowerColors)
  };
}

function horizontalEdges(points, tol) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (Math.abs(a.y - b.y) > tol) continue;
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    if (x1 - x0 <= 0.5) continue;
    out.push({ x0, x1, y: (a.y + b.y) / 2 });
  }
  return out;
}

function findEdgeSeam(obj, other, bA, bB, tol) {
  const edgesA = horizontalEdges(obj.points, tol);
  if (!edgesA.length) return null;
  const edgesB = horizontalEdges(other.points, tol);
  if (!edgesB.length) return null;

  let best = null;
  for (const ea of edgesA) {
    for (const eb of edgesB) {
      const x0 = Math.max(ea.x0, eb.x0);
      const x1 = Math.min(ea.x1, eb.x1);
      const overlap = x1 - x0;
      if (overlap <= 0.5) continue;
      if (Math.abs(ea.y - eb.y) > tol) continue;

      const midX = (x0 + x1) / 2;
      const midY = (ea.y + eb.y) / 2;
      const probeStep = Math.max(0.5, Math.min(2, bA.height * 0.25, bB.height * 0.25));
      const aAbove = pointInPolygon(midX, midY - probeStep, obj.points);
      const aBelow = pointInPolygon(midX, midY + probeStep, obj.points);
      const bAbove = pointInPolygon(midX, midY - probeStep, other.points);
      const bBelow = pointInPolygon(midX, midY + probeStep, other.points);

      let side = null;
      if (aAbove && !aBelow && bBelow && !bAbove) side = 'bottom';
      else if (bAbove && !bBelow && aBelow && !aAbove) side = 'top';
      if (!side) continue;

      if (!best || overlap > best.overlap) {
        best = { side, x0, x1, seamX: midX, seamY: side === 'bottom' ? eb.y : ea.y, overlap };
      }
    }
  }
  return best;
}

/**
 * Finds Sky/Wat polygons in `candidates` that share or overlap a horizontal boundary
 * with `target` within `tol` file pixels (default 1 px = 0.1 Mapmaker units).
 */
export function findGradientSeams(target, candidates, { tol = SEAM_TOLERANCE_PX, sameTypeOnly = true, testerPreview = false } = {}) {
  if (!isGradientObject(target) || !Array.isArray(candidates)) return [];
  const bA = bounds(target.points);
  const aTop = bA.y;
  const aBot = bA.y + bA.height;
  const seams = [];

  for (const other of candidates) {
    if (!other || other === target || (target.uid != null && other.uid === target.uid)) continue;
    if (!isGradientObject(other)) continue;
    if (sameTypeOnly && other.type !== target.type) continue;

    const bB = bounds(other.points);
    const x0 = Math.max(bA.x, bB.x);
    const x1 = Math.min(bA.x + bA.width, bB.x + bB.width);
    if (x1 - x0 <= 0.5) continue;

    const bTop = bB.y;
    const bBot = bB.y + bB.height;
    const gapAB = Math.abs(aBot - bTop);
    const gapBA = Math.abs(bBot - aTop);

    let hit = null;
    if (gapAB <= tol && gapAB <= gapBA) {
      hit = { upper: target, lower: other, side: 'bottom', x0, x1, seamX: (x0 + x1) / 2, seamY: bTop };
    } else if (gapBA <= tol) {
      hit = { upper: other, lower: target, side: 'top', x0, x1, seamX: (x0 + x1) / 2, seamY: aTop };
    } else if (aTop <= bBot + tol && bTop <= aBot + tol) {
      const edge = findEdgeSeam(target, other, bA, bB, tol);
      if (edge) {
        hit = edge.side === 'bottom'
          ? { upper: target, lower: other, side: 'bottom', x0: edge.x0, x1: edge.x1, seamX: edge.seamX, seamY: edge.seamY }
          : { upper: other, lower: target, side: 'top', x0: edge.x0, x1: edge.x1, seamX: edge.seamX, seamY: edge.seamY };
      }
    }
    if (!hit) continue;

    const match = matchSeam(hit.upper, hit.lower, { seamY: hit.seamY, testerPreview });
    if (!match) continue;
    seams.push({
      ...hit,
      match,
      alreadyMatched: !match.upperChanged && !match.lowerChanged
    });
  }

  seams.sort((a, b) => {
    if (a.side !== b.side) return a.side === 'top' ? -1 : 1;
    return a.seamX - b.seamX;
  });
  return seams;
}
