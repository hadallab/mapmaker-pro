// Shape operations: boolean (union, subtract, intersect, exclude), offset, smoothing and
// curves. Clipping uses Clipper 6.4.2 (Angus Johnson, Boost licence), loaded as a classic
// script in the renderer (src/vendor/clipper.js) or set on globalThis by tests.
//
// DPM polygons cannot have holes. Any result with a hole is bridged into hole-free
// pieces by `bridgeAllHoles` (thin slit to the nearest wall), so every output is valid.

import { bridgeAllHoles } from './knife.js';
import { selfIntersections } from './geometry.js';
import { SCALE, lib, toPath } from './clipper.js';

const fromPath = path => path.map(p => ({ x: p.X / SCALE, y: p.Y / SCALE }));

// Returns [{ outer, holes: [] }] from a PolyTree.
function polyTreeToShapes(tree) {
  const C = lib();
  const shapes = [];
  const walk = node => {
    for (const child of node.Childs()) {
      if (!child.IsHole()) {
        shapes.push({ outer: child.Contour(), holes: child.Childs().filter(h => h.IsHole()).map(h => h.Contour()) });
        for (const hole of child.Childs()) walk(hole); // islands inside holes
      }
    }
  };
  walk(tree);
  return shapes.filter(s => Math.abs(C.Clipper.Area(s.outer)) > 1);
}

function clip(type, subjects, clips, strictlySimple = false) {
  const C = lib();
  const c = new C.Clipper();
  if (strictlySimple) c.StrictlySimple = true; // split at touching vertices (bow-tie -> two triangles)
  for (const s of subjects) c.AddPath(s, C.PolyType.ptSubject, true);
  for (const k of clips) c.AddPath(k, C.PolyType.ptClip, true);
  const tree = new C.PolyTree();
  c.Execute(type, tree, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
  return polyTreeToShapes(tree);
}

function clean(path) {
  const C = lib();
  const cleaned = C.Clipper.CleanPolygon(path, 0.5 * SCALE / 100);
  return cleaned.length >= 3 ? cleaned : path;
}

const finish = shapes => bridgeAllHoles(shapes).map(clean).filter(p => p.length >= 3).map(fromPath);

// base: points of the object that keeps its settings; others: points of the other objects.
export function booleanOp(op, base, others) {
  const C = lib();
  const b = [toPath(base)], o = others.map(toPath);
  const type = { union: C.ClipType.ctUnion, subtract: C.ClipType.ctDifference, intersect: C.ClipType.ctIntersection, exclude: C.ClipType.ctXor }[op];
  if (type == null) throw new Error('Unknown operation ' + op);
  if (op === 'intersect') {
    // intersection of all shapes, not of base with the union of the others
    let acc = clip(C.ClipType.ctUnion, b, []);
    for (const k of o) {
      const flat = acc.flatMap(s => [s.outer, ...s.holes]);
      acc = clip(C.ClipType.ctIntersection, flat, [k]);
    }
    return finish(acc);
  }
  return finish(clip(type, b, o));
}

function horizontalCrossings(pts, yVal) {
  const xs = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if ((a.y <= yVal && b.y > yVal) || (b.y <= yVal && a.y > yVal)) {
      xs.push(a.x + (yVal - a.y) * (b.x - a.x) / (b.y - a.y));
    }
  }
  xs.sort((a, b) => a - b);
  return xs;
}

function pointBounds(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Bridges an outer ring and an inner hole ring into a single hole-free polygon
 * through a hairline side-wall slit (width >= 0.01 units = 0.1 file px) instead
 * of cutting the ceiling and floor vertically.
 */
export function bridgeHole(outer, inner, { side = 'left', slitWidth = 0.1, y = null } = {}) {
  if (!Array.isArray(outer) || outer.length < 3) return [];
  if (!Array.isArray(inner) || inner.length < 3) return [outer.map(p => ({ x: p.x, y: p.y }))];

  const C = lib();
  const oPath = toPath(outer);
  const iPath = toPath(inner);
  const baseDiff = clip(C.ClipType.ctDifference, [oPath], [iPath]);
  if (!baseDiff.length) return [];
  if (baseDiff.every(s => !s.holes.length)) return finish(baseDiff);

  const w = Math.max(0.1, Number(slitWidth) || 0.1);
  const wallSide = side === 'right' ? 'right' : 'left';
  const ob = pointBounds(outer);
  const ib = pointBounds(inner);
  const defaultY = (ib.minY + ib.maxY) / 2;
  let yMid = (y != null && Number.isFinite(Number(y))) ? Number(y) : defaultY;
  let xs = horizontalCrossings(inner, yMid);
  if (xs.length < 2) {
    yMid = defaultY;
    xs = horizontalCrossings(inner, yMid);
  }
  if (xs.length < 2) return finish(baseDiff);

  const pad = 10;
  let xStart, xEnd;
  if (wallSide === 'left') {
    xStart = ob.minX - pad;
    xEnd = Math.min(xs[0] + Math.max(1, w * 4), (xs[0] + xs[1]) / 2);
  } else {
    xStart = Math.max(xs[xs.length - 1] - Math.max(1, w * 4), (xs[xs.length - 2] + xs[xs.length - 1]) / 2);
    xEnd = ob.maxX + pad;
  }

  const slit = [
    { x: xStart, y: yMid - w / 2 },
    { x: xEnd, y: yMid - w / 2 },
    { x: xEnd, y: yMid + w / 2 },
    { x: xStart, y: yMid + w / 2 }
  ];
  const cut = clip(C.ClipType.ctDifference, [oPath], [iPath, toPath(slit)]);
  if (!cut.length) return finish(baseDiff);
  return finish(cut);
}

// Grows (positive) or shrinks (negative) outlines by `distance` in file pixels.
export function offset(polygons, distance, join = 'round') {
  const C = lib();
  const co = new C.ClipperOffset(2, 0.25 * SCALE);
  const jt = { round: C.JoinType.jtRound, miter: C.JoinType.jtMiter, square: C.JoinType.jtSquare }[join] ?? C.JoinType.jtRound;
  for (const pts of polygons) co.AddPath(toPath(pts), jt, C.EndType.etClosedPolygon);
  const tree = new C.PolyTree();
  co.Execute(tree, distance * SCALE);
  return finish(polyTreeToShapes(tree));
}

// Chaikin corner cutting on a closed ring.
export function smooth(points, iterations = 2, amount = 0.25) {
  let pts = points.map(p => ({ x: p.x, y: p.y }));
  const a = Math.min(0.49, Math.max(0.05, amount));
  for (let k = 0; k < iterations; k++) {
    const next = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      next.push({ x: p.x + (q.x - p.x) * a, y: p.y + (q.y - p.y) * a }, { x: p.x + (q.x - p.x) * (1 - a), y: p.y + (q.y - p.y) * (1 - a) });
    }
    pts = next;
  }
  return pts;
}

// Closed centripetal Catmull-Rom curve through the control points, sampled with
// `steps` points per span (so the outline stays a plain polygon).
export function catmullRom(points, steps = 6, closed = true) {
  const n = points.length;
  if (n < 3) return points.slice();
  const out = [];
  const get = i => closed ? points[(i + n) % n] : points[Math.max(0, Math.min(n - 1, i))];
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    const d = (a, b) => Math.pow(Math.hypot(b.x - a.x, b.y - a.y), 0.5) || 1e-4;
    const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
    for (let s = 0; s < steps; s++) {
      const t = t1 + (t2 - t1) * (s / steps);
      const lerp = (a, b, ta, tb) => ({
        x: (tb - t) / (tb - ta) * a.x + (t - ta) / (tb - ta) * b.x,
        y: (tb - t) / (tb - ta) * a.y + (t - ta) / (tb - ta) * b.y
      });
      const A1 = lerp(p0, p1, t0, t1), A2 = lerp(p1, p2, t1, t2), A3 = lerp(p2, p3, t2, t3);
      const B1 = lerp(A1, A2, t0, t2), B2 = lerp(A2, A3, t1, t3);
      out.push(lerp(B1, B2, t1, t2));
    }
  }
  if (!closed) out.push({ ...points[n - 1] });
  return out;
}

// Clean, non-crossing polygons covering the same area as a self-crossing outline, or null when
// that is not possible without a hole bridge (the bridge edges would cross again) or Clipper is missing.
export function untangle(points) {
  try {
    const C = lib();
    const pieces = finish(clip(C.ClipType.ctUnion, [toPath(points)], [], true));
    if (!pieces.length || pieces.some(p => selfIntersections(p, 1).length)) return null;
    return pieces;
  } catch { return null; }
}
