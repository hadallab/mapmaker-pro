// Geometry and document operations for the Knife tool, vertex bevel, and hole
// bridging. Kept free of UI imports so tools.js stays cycle-free and functions
// can be unit tested directly in Node.

import { KIND_BY_TYPE, isLayerEditable } from './layers.js';
import {
  limitDecimals,
  signedArea,
  bounds,
  distanceToSegment,
  segmentsIntersect,
  pointInPolygon,
  selfIntersections
} from './geometry.js';
import { clone } from './document.js';
import { SCALE, lib, toPath } from './clipper.js';
export { SCALE } from './clipper.js';

export const PX_PER_UNIT = 10; // 1 Mapmaker unit = 10 file px
export const DEFAULT_SLIT_WIDTH_PX = 0.1; // 0.01 units
export const DEFAULT_BEVEL_DISTANCE_PX = 5; // 0.5 Mapmaker units

const fromPath = path => path.map(p => ({ x: limitDecimals(p.X / SCALE, 3), y: limitDecimals(p.Y / SCALE, 3) }));

function clonePts(pts) {
  return pts.map(p => ({ x: p.x, y: p.y }));
}

function pointBounds(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function pathBBox(path) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    if (p.X < minX) minX = p.X;
    if (p.Y < minY) minY = p.Y;
    if (p.X > maxX) maxX = p.X;
    if (p.Y > maxY) maxY = p.Y;
  }
  return { minX, minY, maxX, maxY };
}

function polyTreeToShapes(tree) {
  const C = lib();
  const shapes = [];
  const walk = node => {
    for (const child of node.Childs()) {
      if (!child.IsHole()) {
        shapes.push({
          outer: child.Contour(),
          holes: child.Childs().filter(h => h.IsHole()).map(h => h.Contour())
        });
        for (const hole of child.Childs()) walk(hole);
      }
    }
  };
  walk(tree);
  return shapes.filter(s => Math.abs(C.Clipper.Area(s.outer)) > 1);
}

function clip(type, subjects, clips) {
  const C = lib();
  const c = new C.Clipper();
  for (const s of subjects) c.AddPath(s, C.PolyType.ptSubject, true);
  for (const k of clips) c.AddPath(k, C.PolyType.ptClip, true);
  const tree = new C.PolyTree();
  c.Execute(type, tree, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
  return polyTreeToShapes(tree);
}

function cleanClipperPath(path) {
  const C = lib();
  const cleaned = C.Clipper.CleanPolygon(path, 0.5 * SCALE / 100);
  return cleaned.length >= 3 ? cleaned : path;
}

function ensurePositiveOrientation(path) {
  const C = lib();
  return C.Clipper.Orientation(path) ? path : path.slice().reverse();
}

function ensureNegativeOrientation(path) {
  const C = lib();
  return C.Clipper.Orientation(path) ? path.slice().reverse() : path;
}

function dedupeRingPoints(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = { x: limitDecimals(pts[i].x, 3), y: limitDecimals(pts[i].y, 3) };
    const prev = out[out.length - 1];
    if (!prev || Math.abs(prev.x - p.x) > 1e-6 || Math.abs(prev.y - p.y) > 1e-6) {
      out.push(p);
    }
  }
  while (out.length > 3 && Math.abs(out[0].x - out[out.length - 1].x) <= 1e-6 && Math.abs(out[0].y - out[out.length - 1].y) <= 1e-6) {
    out.pop();
  }
  return out;
}

function finalizeClipperPath(path) {
  const C = lib();
  const cleaned = cleanClipperPath(path);
  let pts = dedupeRingPoints(fromPath(cleaned));
  if (pts.length < 3 || Math.abs(signedArea(pts)) < 1e-3) return [];
  if (selfIntersections(pts, 1).length > 0) {
    const simp = C.Clipper.SimplifyPolygon(toPath(pts), C.PolyFillType.pftNonZero);
    const out = [];
    for (const ring of simp) {
      const rPts = dedupeRingPoints(fromPath(cleanClipperPath(ring)));
      if (rPts.length >= 3 && Math.abs(signedArea(rPts)) >= 1e-3 && selfIntersections(rPts, 1).length === 0) {
        out.push(rPts);
      }
    }
    return out;
  }
  return [pts];
}

// ---- bridgeAllHoles ----

function distPointToSegClipper(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const qx = ax + t * dx, qy = ay + t * dy;
  return { dist: Math.hypot(px - qx, py - qy), qx, qy, t };
}

function closestSegmentBetweenRings(holePath, targetPaths) {
  let best = null;
  let bestScore = Infinity;

  const checkPointsAgainstRing = (ptsPath, segRing, reverse) => {
    const nPts = ptsPath.length;
    const nSeg = segRing.length;
    for (let i = 0; i < nPts; i++) {
      const a = ptsPath[i];
      const b = ptsPath[(i + 1) % nPts];
      const samples = [
        { x: (a.X + b.X) * 0.5, y: (a.Y + b.Y) * 0.5, isCorner: false },
        { x: a.X, y: a.Y, isCorner: true }
      ];
      for (let sIdx = 0; sIdx < samples.length; sIdx++) {
        const pt = samples[sIdx];
        for (let j = 0; j < nSeg; j++) {
          const sa = segRing[j], sb = segRing[(j + 1) % nSeg];
          const minX = sa.X < sb.X ? sa.X : sb.X;
          const maxX = sa.X > sb.X ? sa.X : sb.X;
          const minY = sa.Y < sb.Y ? sa.Y : sb.Y;
          const maxY = sa.Y > sb.Y ? sa.Y : sb.Y;
          const dxBox = pt.x < minX ? minX - pt.x : (pt.x > maxX ? pt.x - maxX : 0);
          const dyBox = pt.y < minY ? minY - pt.y : (pt.y > maxY ? pt.y - maxY : 0);
          if (dxBox * dxBox + dyBox * dyBox > bestScore * bestScore) continue;

          const hit = distPointToSegClipper(pt.x, pt.y, sa.X, sa.Y, sb.X, sb.Y);
          const p = reverse ? { X: hit.qx, Y: hit.qy } : { X: pt.x, Y: pt.y };
          const q = reverse ? { X: pt.x, Y: pt.y } : { X: hit.qx, Y: hit.qy };
          const dx = Math.abs(q.X - p.X), dy = Math.abs(q.Y - p.Y);
          const sideBias = dx >= dy ? 0 : 1;
          const cornerBias = (pt.isCorner ? 2 : 0) + (hit.t <= 0.02 || hit.t >= 0.98 ? 2 : 0);
          const score = hit.dist + sideBias + cornerBias;
          if (score < bestScore) {
            bestScore = score;
            best = { p, q, dist: hit.dist };
          }
        }
      }
    }
  };

  for (let k = 0; k < targetPaths.length; k++) {
    const tRing = targetPaths[k];
    checkPointsAgainstRing(holePath, tRing, false);
    checkPointsAgainstRing(tRing, holePath, true);
  }
  return best;
}

function rayExtentClipper(origin, dirX, dirY, ringPath) {
  let minT = Infinity;
  const n = ringPath.length;
  for (let i = 0; i < n; i++) {
    const a = ringPath[i], b = ringPath[(i + 1) % n];
    const ex = b.X - a.X, ey = b.Y - a.Y;
    const denom = dirX * ey - dirY * ex;
    if (Math.abs(denom) < 1e-9) continue;
    const rx = a.X - origin.X, ry = a.Y - origin.Y;
    const t = (rx * ey - ry * ex) / denom;
    const u = (rx * dirY - ry * dirX) / denom;
    if (t > 1e-3 && u >= -1e-6 && u <= 1 + 1e-6 && t < minT) minT = t;
  }
  return minT;
}

function buildSlitRectClipper(p, q, widthClipper, holePath, targetPaths) {
  const dx = q.X - p.X, dy = q.Y - p.Y;
  const len = Math.hypot(dx, dy);
  const ux = len > 1e-6 ? dx / len : 1;
  const uy = len > 1e-6 ? dy / len : 0;
  const nx = -uy, ny = ux;
  const hw = Math.max(1, Math.round(widthClipper / 2));
  const baseExt = Math.max(Math.round(widthClipper * 0.75), 80);

  const holeClear = rayExtentClipper(p, -ux, -uy, holePath);
  const extP = Number.isFinite(holeClear) ? Math.min(baseExt, Math.max(10, holeClear * 0.35)) : baseExt;

  let targetClear = Infinity;
  for (let i = 0; i < targetPaths.length; i++) {
    const c = rayExtentClipper(q, ux, uy, targetPaths[i]);
    if (c < targetClear) targetClear = c;
  }
  const extQ = Number.isFinite(targetClear) ? Math.min(baseExt, Math.max(10, targetClear * 0.35)) : baseExt;

  const pExt = { X: Math.round(p.X - ux * extP), Y: Math.round(p.Y - uy * extP) };
  const qExt = { X: Math.round(q.X + ux * extQ), Y: Math.round(q.Y + uy * extQ) };

  const rect = [
    { X: Math.round(pExt.X + nx * hw), Y: Math.round(pExt.Y + ny * hw) },
    { X: Math.round(qExt.X + nx * hw), Y: Math.round(qExt.Y + ny * hw) },
    { X: Math.round(qExt.X - nx * hw), Y: Math.round(qExt.Y - ny * hw) },
    { X: Math.round(pExt.X - nx * hw), Y: Math.round(pExt.Y - ny * hw) }
  ];
  return ensurePositiveOrientation(rect);
}

function splitHolesFallback(shapes) {
  const C = lib();
  const out = [];
  const queue = [...shapes];
  let guard = 0;
  while (queue.length && guard++ < 5000) {
    const s = queue.shift();
    if (!s.holes.length) { out.push(s.outer); continue; }
    const hb = pathBBox(s.holes[0]), ob = pathBBox(s.outer);
    const x = Math.round((hb.minX + hb.maxX) / 2);
    const pad = 10;
    const left = [
      { X: ob.minX - pad, Y: ob.minY - pad },
      { X: x, Y: ob.minY - pad },
      { X: x, Y: ob.maxY + pad },
      { X: ob.minX - pad, Y: ob.maxY + pad }
    ];
    const right = [
      { X: x, Y: ob.minY - pad },
      { X: ob.maxX + pad, Y: ob.minY - pad },
      { X: ob.maxX + pad, Y: ob.maxY + pad },
      { X: x, Y: ob.maxY + pad }
    ];
    const shape = [s.outer, ...s.holes];
    for (const half of [left, right]) queue.push(...clip(C.ClipType.ctIntersection, shape, [half]));
  }
  return out;
}

function bridgeShapeListClipper(shapes, slitWidth = DEFAULT_SLIT_WIDTH_PX) {
  const C = lib();
  const w = Math.max(100, Math.round((Number(slitWidth) || DEFAULT_SLIT_WIDTH_PX) * SCALE));
  const out = [];
  const queue = [...shapes];
  let guard = 0;

  while (queue.length && guard++ < 64) {
    const s = queue.shift();
    if (!s.holes || !s.holes.length) {
      out.push(s.outer);
      continue;
    }

    const targets = [s.outer];
    const remaining = s.holes.slice();
    const slits = [];

    while (remaining.length) {
      let bestIdx = -1;
      let bestSeg = null;
      for (let i = 0; i < remaining.length; i++) {
        const seg = closestSegmentBetweenRings(remaining[i], targets);
        if (seg && (!bestSeg || seg.dist < bestSeg.dist)) {
          bestSeg = seg;
          bestIdx = i;
        }
      }
      if (bestIdx < 0 || !bestSeg) break;
      const hole = remaining.splice(bestIdx, 1)[0];
      slits.push(buildSlitRectClipper(bestSeg.p, bestSeg.q, w, hole, targets));
      targets.push(hole);
    }

    if (!slits.length) {
      out.push(...splitHolesFallback([s]));
      continue;
    }

    const clipRings = [...s.holes.map(ensurePositiveOrientation), ...slits];
    const res = clip(C.ClipType.ctDifference, [ensurePositiveOrientation(s.outer)], clipRings);
    if (!res.length) {
      out.push(...splitHolesFallback([s]));
      continue;
    }
    for (const r of res) {
      if (!r.holes.length) out.push(r.outer);
      else queue.push(r);
    }
  }

  if (queue.length) out.push(...splitHolesFallback(queue));
  return out;
}

/**
 * Replaces holes in Clipper PolyTree shapes OR `{x,y}` polygon rings with a single
 * thin slit per hole to the nearest exterior/bridged wall instead of bisecting
 * cave ceilings down the middle.
 *
 * Accepts either:
 * - `bridgeAllHoles(clipperShapes, { slitWidth })` -> `IntPoint[][]`
 * - `bridgeAllHoles(outerPts, holePtsList, { slitWidth })` -> `Array<Array<{x,y}>>`
 */
export function bridgeAllHoles(input, holesOrOpts = {}, maybeOpts = {}) {
  if (!Array.isArray(input) || !input.length) return [];
  if (input[0] && 'outer' in input[0]) {
    const opts = holesOrOpts && !Array.isArray(holesOrOpts) ? holesOrOpts : {};
    return bridgeShapeListClipper(input, opts.slitWidth ?? DEFAULT_SLIT_WIDTH_PX);
  }
  const holeList = Array.isArray(holesOrOpts) ? holesOrOpts : [];
  const opts = maybeOpts && typeof maybeOpts === 'object' ? maybeOpts : {};
  const slitWidth = opts.slitWidth ?? DEFAULT_SLIT_WIDTH_PX;
  const C = lib();
  const outerPath = ensurePositiveOrientation(toPath(input));
  const holePaths = holeList.filter(h => Array.isArray(h) && h.length >= 3).map(toPath);
  const diff = holePaths.length
    ? clip(C.ClipType.ctDifference, [outerPath], holePaths.map(ensurePositiveOrientation))
    : [{ outer: outerPath, holes: [] }];
  const bridged = bridgeShapeListClipper(diff, slitWidth);
  const out = [];
  for (const p of bridged) {
    for (const ring of finalizeClipperPath(p)) out.push(ring);
  }
  return out;
}

// ---- Knife / Polyline Slice ----

function cleanPolyline(polyline) {
  const out = [];
  if (!Array.isArray(polyline)) return out;
  for (let i = 0; i < polyline.length; i++) {
    const p = polyline[i];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 1e-4) {
      out.push({ x: p.x, y: p.y });
    }
  }
  return out;
}

function polylineIntersectsPolygon(line, poly, margin = 0.01) {
  const lb = pointBounds(line);
  const pb = pointBounds(poly);
  if (lb.maxX < pb.minX - margin || lb.minX > pb.maxX + margin ||
      lb.maxY < pb.minY - margin || lb.minY > pb.maxY + margin) {
    return false;
  }
  for (let i = 0; i < line.length; i++) {
    if (pointInPolygon(line[i].x, line[i].y, poly)) return true;
  }
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1];
    for (let j = 0; j < poly.length; j++) {
      const c = poly[j], d = poly[(j + 1) % poly.length];
      if (segmentsIntersect(a, b, c, d)) return true;
      if (margin > 0.02) {
        if (distanceToSegment(a, c, d).distance <= margin || distanceToSegment(b, c, d).distance <= margin ||
            distanceToSegment(c, a, b).distance <= margin) {
          return true;
        }
      }
    }
  }
  return false;
}

function polylineIsSimple(pts) {
  const n = pts.length;
  if (n < 3) return true;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 2; j < n - 1; j++) {
      if (segmentsIntersect(pts[i], pts[i + 1], pts[j], pts[j + 1])) return false;
    }
  }
  return true;
}

function segmentIntersectsAny(a, b, ring, skipPolyline = null) {
  for (let i = 0; i < ring.length; i++) {
    if (segmentsIntersect(a, b, ring[i], ring[(i + 1) % ring.length])) return true;
  }
  if (skipPolyline && skipPolyline.length >= 2) {
    for (let i = 0; i < skipPolyline.length - 1; i++) {
      const c = skipPolyline[i], d = skipPolyline[i + 1];
      if ((Math.hypot(c.x - a.x, c.y - a.y) < 1e-6 || Math.hypot(d.x - a.x, d.y - a.y) < 1e-6)) continue;
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

function rayToBox(origin, dx, dy, box) {
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  const ux = dx / len, uy = dy / len;
  let tMin = Infinity;
  if (ux > 1e-9) tMin = Math.min(tMin, (box.maxX - origin.x) / ux);
  else if (ux < -1e-9) tMin = Math.min(tMin, (box.minX - origin.x) / ux);
  if (uy > 1e-9) tMin = Math.min(tMin, (box.maxY - origin.y) / uy);
  else if (uy < -1e-9) tMin = Math.min(tMin, (box.minY - origin.y) / uy);
  if (!Number.isFinite(tMin) || tMin <= 0) return null;
  return { x: origin.x + ux * tMin, y: origin.y + uy * tMin };
}

function isStrictlyInsidePolygon(pt, poly) {
  if (!pointInPolygon(pt.x, pt.y, poly)) return false;
  for (let i = 0; i < poly.length; i++) {
    if (distanceToSegment(pt, poly[i], poly[(i + 1) % poly.length]).distance <= 1e-3) return false;
  }
  return true;
}

function findClearExtension(endpoint, prevPoint, poly, pb, cutLine, bigBox, extraSeg = null) {
  if (isStrictlyInsidePolygon(endpoint, poly)) return null;
  const dirs = [];
  dirs.push({ dx: endpoint.x - prevPoint.x, dy: endpoint.y - prevPoint.y });
  if (endpoint.x < pb.minX) dirs.push({ dx: -1, dy: 0 });
  if (endpoint.x > pb.maxX) dirs.push({ dx: 1, dy: 0 });
  if (endpoint.y < pb.minY) dirs.push({ dx: 0, dy: -1 });
  if (endpoint.y > pb.maxY) dirs.push({ dx: 0, dy: 1 });
  dirs.push(
    { dx: -1, dy: 0 }, { dx: 1, dy: 0 }, { dx: 0, dy: -1 }, { dx: 0, dy: 1 },
    { dx: 1, dy: 1 }, { dx: 1, dy: -1 }, { dx: -1, dy: 1 }, { dx: -1, dy: -1 }
  );
  for (let k = 0; k < 16; k++) {
    const a = (k * Math.PI) / 8;
    dirs.push({ dx: Math.cos(a), dy: Math.sin(a) });
  }

  for (let i = 0; i < dirs.length; i++) {
    const hit = rayToBox(endpoint, dirs[i].dx, dirs[i].dy, bigBox);
    if (!hit) continue;
    const len = Math.hypot(hit.x - endpoint.x, hit.y - endpoint.y);
    if (len < 1e-4) continue;
    const nudge = Math.min(0.01, len * 0.1);
    const epsStart = {
      x: endpoint.x + ((hit.x - endpoint.x) / len) * nudge,
      y: endpoint.y + ((hit.y - endpoint.y) / len) * nudge
    };
    if (pointInPolygon(epsStart.x, epsStart.y, poly)) continue;
    if (segmentIntersectsAny(epsStart, hit, poly, cutLine)) continue;
    if (extraSeg && segmentsIntersect(epsStart, hit, extraSeg[0], extraSeg[1])) continue;
    return hit;
  }
  return null;
}

function boxPerimeterParam(pt, box) {
  const w = box.maxX - box.minX, h = box.maxY - box.minY;
  const eps = 1e-3;
  if (Math.abs(pt.y - box.minY) <= eps) return (pt.x - box.minX) / w;
  if (Math.abs(pt.x - box.maxX) <= eps) return 1 + (pt.y - box.minY) / h;
  if (Math.abs(pt.y - box.maxY) <= eps) return 2 + (box.maxX - pt.x) / w;
  return 3 + (box.maxY - pt.y) / h;
}

function buildComplementaryHalfPlanes(extLine, box) {
  const corners = [
    { x: box.minX, y: box.minY, t: 0 },
    { x: box.maxX, y: box.minY, t: 1 },
    { x: box.maxX, y: box.maxY, t: 2 },
    { x: box.minX, y: box.maxY, t: 3 }
  ];
  const e0 = extLine[0], e1 = extLine[extLine.length - 1];
  const t0 = boxPerimeterParam(e0, box);
  const t1 = boxPerimeterParam(e1, box);

  // CW walk from t1 -> t0 along box perimeter
  const cwCorners = [];
  for (let step = 0; step < 4; step++) {
    const base = (Math.floor(t1) + step + 1) % 4;
    const c = corners[base];
    const distCw = ((c.t - t1) % 4 + 4) % 4;
    const spanCw = ((t0 - t1) % 4 + 4) % 4;
    if (distCw > 1e-6 && distCw < spanCw - 1e-6) cwCorners.push({ x: c.x, y: c.y, d: distCw });
  }
  cwCorners.sort((a, b) => a.d - b.d);

  // CCW walk from t1 -> t0 along box perimeter
  const ccwCorners = [];
  for (let step = 0; step < 4; step++) {
    const base = (Math.floor(t1) - step + 4) % 4;
    const c = corners[base];
    const distCcw = ((t1 - c.t) % 4 + 4) % 4;
    const spanCcw = ((t1 - t0) % 4 + 4) % 4;
    if (distCcw > 1e-6 && distCcw < spanCcw - 1e-6) ccwCorners.push({ x: c.x, y: c.y, d: distCcw });
  }
  ccwCorners.sort((a, b) => a.d - b.d);

  const linePath = toPath(extLine);
  const h1 = [...linePath, ...toPath(cwCorners)];
  const h2 = [...linePath, ...toPath(ccwCorners)];
  return [h1, h2];
}

/**
 * Slices a single polygon with an open polyline.
 * Returns `{ pieces: Array<Array<{x,y}>>, changed: boolean }`.
 * - When `gapPx <= 0`: produces zero-gap abutting halves sharing exact cut vertices.
 * - When `gapPx > 0`: carves a passage of width `gapPx` (file px) using ClipperOffset.
 */
export function slicePolygonDetailed(points, cutPolyline, { gapPx = 0, slitWidth = DEFAULT_SLIT_WIDTH_PX } = {}) {
  if (!Array.isArray(points) || points.length < 3 || Math.abs(signedArea(points)) < 1e-3) {
    return { pieces: [], changed: false };
  }
  const line = cleanPolyline(cutPolyline);
  if (line.length < 2) return { pieces: [clonePts(points)], changed: false };

  const gap = Math.max(0, Number(gapPx) || 0);
  if (!polylineIntersectsPolygon(line, points, gap * 0.5 + 0.01)) {
    return { pieces: [clonePts(points)], changed: false };
  }

  const C = lib();
  const pPath = ensurePositiveOrientation(toPath(points));
  const isClosedLoop = line.length >= 4 && Math.hypot(line[0].x - line[line.length - 1].x, line[0].y - line[line.length - 1].y) < 0.1;

  if (gap > 0) {
    const co = new C.ClipperOffset(2, 1.5 * SCALE);
    const offsetPath = isClosedLoop ? toPath(line.slice(0, -1)) : toPath(line);
    const endType = isClosedLoop ? C.EndType.etClosedLine : C.EndType.etOpenButt;
    co.AddPath(offsetPath, C.JoinType.jtMiter, endType);
    const corridorTree = new C.PolyTree();
    co.Execute(corridorTree, (gap * 0.5) * SCALE);
    const corridors = polyTreeToShapes(corridorTree)
      .flatMap(s => [ensurePositiveOrientation(s.outer), ...s.holes.map(ensureNegativeOrientation)]);
    if (!corridors.length) return { pieces: [clonePts(points)], changed: false };

    const diff = clip(C.ClipType.ctDifference, [pPath], corridors);
    const bridged = bridgeAllHoles(diff, { slitWidth });
    const pieces = [];
    for (const ring of bridged) {
      for (const pts of finalizeClipperPath(ring)) pieces.push(pts);
    }
    const origArea = Math.abs(signedArea(points));
    const newArea = pieces.reduce((s, r) => s + Math.abs(signedArea(r)), 0);
    if (pieces.length === 1 && Math.abs(newArea - origArea) < 1e-2 && pieces[0].length === points.length) {
      return { pieces: [clonePts(points)], changed: false };
    }
    return { pieces, changed: true };
  }

  if (isClosedLoop) {
    const loopRing = ensurePositiveOrientation(toPath(line.slice(0, -1)));
    const innerShapes = clip(C.ClipType.ctIntersection, [pPath], [loopRing]);
    const outerShapes = clip(C.ClipType.ctDifference, [pPath], [loopRing]);
    if (innerShapes.length && outerShapes.length) {
      const bridged = [
        ...bridgeAllHoles(innerShapes, { slitWidth }),
        ...bridgeAllHoles(outerShapes, { slitWidth })
      ];
      const pieces = [];
      for (const ring of bridged) {
        for (const pts of finalizeClipperPath(ring)) pieces.push(pts);
      }
      if (pieces.length >= 2) return { pieces, changed: true };
    }
  }

  // Zero-gap split via exact complementary half-planes sharing the cut polyline.
  const pb = pointBounds(points);
  const lb = pointBounds(line);
  const uMinX = Math.min(pb.minX, lb.minX), uMinY = Math.min(pb.minY, lb.minY);
  const uMaxX = Math.max(pb.maxX, lb.maxX), uMaxY = Math.max(pb.maxY, lb.maxY);
  const pad = Math.max(uMaxX - uMinX, uMaxY - uMinY, 100) + 500;
  const bigBox = { minX: uMinX - pad, minY: uMinY - pad, maxX: uMaxX + pad, maxY: uMaxY + pad };

  if (polylineIsSimple(line)) {
    const e0 = findClearExtension(line[0], line[1], points, pb, line, bigBox);
    const e1 = e0
      ? findClearExtension(line[line.length - 1], line[line.length - 2], points, pb, line, bigBox, [e0, line[0]])
      : null;

    if (e0 && e1) {
      const extLine = [e0, ...line, e1];
      const [h1, h2] = buildComplementaryHalfPlanes(extLine, bigBox);
      const s1 = clip(C.ClipType.ctIntersection, [pPath], [h1]);
      const s2 = clip(C.ClipType.ctIntersection, [pPath], [h2]);
      if (!s1.length || !s2.length) {
        return { pieces: [clonePts(points)], changed: false };
      }
      const bridged = [
        ...bridgeAllHoles(s1, { slitWidth }),
        ...bridgeAllHoles(s2, { slitWidth })
      ];
      const pieces = [];
      for (const ring of bridged) {
        for (const pts of finalizeClipperPath(ring)) pieces.push(pts);
      }
      if (pieces.length >= 2) return { pieces, changed: true };
      return { pieces: [clonePts(points)], changed: false };
    }
  }

  // Fallback for self-intersecting / closed-loop polyline cuts at gapPx = 0:
  // use a 0.002 px (1 Clipper unit half-width) slit only if it yields >= 2 pieces.
  const co = new C.ClipperOffset(2, 1.5 * SCALE);
  co.AddPath(toPath(line), C.JoinType.jtMiter, C.EndType.etOpenButt);
  const slitTree = new C.PolyTree();
  co.Execute(slitTree, 1);
  const slits = polyTreeToShapes(slitTree)
    .flatMap(s => [ensurePositiveOrientation(s.outer), ...s.holes.map(ensureNegativeOrientation)]);
  if (!slits.length) return { pieces: [clonePts(points)], changed: false };

  const diff = clip(C.ClipType.ctDifference, [pPath], slits);
  const bridged = bridgeAllHoles(diff, { slitWidth });
  const pieces = [];
  for (const ring of bridged) {
    for (const pts of finalizeClipperPath(ring)) pieces.push(pts);
  }
  if (pieces.length >= 2) return { pieces, changed: true };
  return { pieces: [clonePts(points)], changed: false };
}

/**
 * Convenience wrapper returning the array of cut polygon rings (or `[points]` if untouched).
 */
export function slicePolygon(points, cutPolyline, options = {}) {
  return slicePolygonDetailed(points, cutPolyline, options).pieces;
}

/**
 * Computes all edge-crossing points between `cutPolyline` and `targets` (for live preview).
 */
export function computeCutIntersections(targets, cutPolyline) {
  const line = cleanPolyline(cutPolyline);
  if (line.length < 2 || !targets?.length) return [];
  const lb = pointBounds(line);
  const hits = [];

  for (let t = 0; t < targets.length; t++) {
    const pts = targets[t]?.points;
    if (!pts || pts.length < 3) continue;
    const pb = pointBounds(pts);
    if (lb.maxX < pb.minX || lb.minX > pb.maxX || lb.maxY < pb.minY || lb.minY > pb.maxY) continue;

    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1];
      const segMinX = Math.min(a.x, b.x), segMaxX = Math.max(a.x, b.x);
      const segMinY = Math.min(a.y, b.y), segMaxY = Math.max(a.y, b.y);
      if (segMaxX < pb.minX || segMinX > pb.maxX || segMaxY < pb.minY || segMinY > pb.maxY) continue;

      const d1x = b.x - a.x, d1y = b.y - a.y;
      for (let j = 0; j < pts.length; j++) {
        const c = pts[j], d = pts[(j + 1) % pts.length];
        if (Math.max(c.x, d.x) < segMinX || Math.min(c.x, d.x) > segMaxX ||
            Math.max(c.y, d.y) < segMinY || Math.min(c.y, d.y) > segMaxY) continue;
        const d2x = d.x - c.x, d2y = d.y - c.y;
        const denom = d1x * d2y - d1y * d2x;
        if (Math.abs(denom) < 1e-9) continue;
        const rx = c.x - a.x, ry = c.y - a.y;
        const u = (rx * d2y - ry * d2x) / denom;
        const v = (rx * d1y - ry * d1x) / denom;
        if (u >= -1e-6 && u <= 1 + 1e-6 && v >= -1e-6 && v <= 1 + 1e-6) {
          hits.push({ x: a.x + u * d1x, y: a.y + u * d1y });
        }
      }
    }
  }
  return hits;
}

/**
 * Resolves which polygon objects the Knife tool targets:
 * selected editable polygons if any are selected, otherwise visible unlocked polygons
 * on `activeLayer` (or all editable layers if `scope === 'all'`) whose AABB meets `polyline`.
 */
export function selectKnifeTargets(doc, {
  selection = [],
  activeLayer = 'terrains',
  visible = null,
  locked = null,
  isolate = false,
  polyline = null,
  gapPx = 0,
  scope = 'active',
  boundsCache = null
} = {}) {
  if (!doc) return [];
  const layerOpts = { activeLayer, visible, locked, isolate };
  const line = cleanPolyline(polyline);
  const lb = line.length >= 2 ? pointBounds(line) : null;
  const pad = Math.max(0, Number(gapPx) || 0) * 0.5 + 1;

  const filterList = list => {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (!o || KIND_BY_TYPE[o.type] !== 'poly' || !Array.isArray(o.points) || o.points.length < 3) continue;
      if (!isLayerEditable(o.layerId, layerOpts)) continue;
      if (lb) {
        if (boundsCache) {
          const b = boundsCache.get(o);
          if (b.maxX < lb.minX - pad || b.minX > lb.maxX + pad ||
              b.maxY < lb.minY - pad || b.minY > lb.maxY + pad) continue;
        } else {
          const b = bounds(o.points);
          if (b.x + b.width < lb.minX - pad || b.x > lb.maxX + pad ||
              b.y + b.height < lb.minY - pad || b.y > lb.maxY + pad) continue;
        }
      }
      out.push(o);
    }
    return out;
  };

  if (selection && selection.length > 0) {
    return filterList(selection);
  }
  if (scope === 'all') {
    const out = [];
    for (const layerId of Object.keys(doc.layers || {})) {
      if (!isLayerEditable(layerId, layerOpts)) continue;
      out.push(...filterList(doc.layers[layerId]));
    }
    return out;
  }
  if (!isLayerEditable(activeLayer, layerOpts)) return [];
  return filterList(doc.layers?.[activeLayer] || []);
}

/**
 * Applies `slicePolygonDetailed` to every target object inside an active `doc.begin(...)`
 * transaction. Preserves type, layerId, draw order slot, texture, settings, opacity, colors.
 */
export function slicePolygonsInDoc(doc, targets, cutPolyline, { gapPx = 0, slitWidth = DEFAULT_SLIT_WIDTH_PX, twins = null } = {}) {
  const created = [];
  const untouched = [];
  const cutUids = new Set();
  let cutCount = 0;

  for (let t = 0; t < targets.length; t++) {
    const obj = targets[t];
    if (!obj || KIND_BY_TYPE[obj.type] !== 'poly' || !Array.isArray(obj.points) || obj.points.length < 3) continue;
    if (twins?.size && obj.uid != null) {
      const twinUid = twins.get(obj.uid);
      if (twinUid != null && cutUids.has(twinUid)) continue;
    }
    const { pieces, changed } = slicePolygonDetailed(obj.points, cutPolyline, { gapPx, slitWidth });
    if (!changed) {
      untouched.push(obj);
      continue;
    }
    const list = doc.layers[obj.layerId];
    const index = list ? list.indexOf(obj) : -1;
    if (index < 0) continue;

    if (obj.uid != null) cutUids.add(obj.uid);
    const template = clone(obj);
    doc.remove(obj);
    cutCount++;
    for (let i = 0; i < pieces.length; i++) {
      const next = clone(template);
      delete next.uid;
      delete next.sourceId;
      next.points = pieces[i];
      created.push(doc.add(next, index + i));
    }
  }

  return { created, untouched, cutCount };
}

// ---- Vertex Bevel (Chamfer) ----

function buildBeveledRing(points, distances) {
  const n = points.length;
  const out = [];
  const selectedIndices = new Set();
  let beveledCount = 0;

  for (let i = 0; i < n; i++) {
    const d = distances[i];
    const p = points[i];
    if (!(d > 0)) {
      out.push({ x: p.x, y: p.y });
      continue;
    }
    const prev = points[(i - 1 + n) % n];
    const next = points[(i + 1) % n];
    const ux = prev.x - p.x, uy = prev.y - p.y;
    const vx = next.x - p.x, vy = next.y - p.y;
    const lenPrev = Math.hypot(ux, uy);
    const lenNext = Math.hypot(vx, vy);
    const a = { x: limitDecimals(p.x + (ux / lenPrev) * d, 3), y: limitDecimals(p.y + (uy / lenPrev) * d, 3) };
    const b = { x: limitDecimals(p.x + (vx / lenNext) * d, 3), y: limitDecimals(p.y + (vy / lenNext) * d, 3) };

    if (Math.hypot(a.x - b.x, a.y - b.y) < 0.002) {
      selectedIndices.add(out.length);
      out.push({ x: p.x, y: p.y });
      continue;
    }
    selectedIndices.add(out.length);
    out.push(a);
    selectedIndices.add(out.length);
    out.push(b);
    beveledCount++;
  }
  return { points: out, selectedIndices, beveledCount };
}

/**
 * Replaces each selected corner in `indexSet` with 2 chamfer points at `distancePx`
 * along the two adjacent edges. Distances are clamped so adjacent bevels never cross
 * or overlap along shared edges, and checked to avoid new self-intersections.
 */
export function bevelPolygonVertices(points, indexSet, distancePx = DEFAULT_BEVEL_DISTANCE_PX) {
  if (!Array.isArray(points) || points.length < 3) {
    return { points: [], selectedIndices: new Set(), beveledCount: 0, clamped: false };
  }
  const n = points.length;
  const sel = new Set([...(indexSet || [])].filter(i => Number.isInteger(i) && i >= 0 && i < n));
  const distReq = Number(distancePx);
  if (!sel.size || !Number.isFinite(distReq) || distReq <= 0) {
    return { points: clonePts(points), selectedIndices: sel, beveledCount: 0, clamped: false };
  }

  const distances = new Float64Array(n);
  let clamped = false;
  for (const i of sel) {
    const prevIdx = (i - 1 + n) % n;
    const nextIdx = (i + 1) % n;
    const lenPrev = Math.hypot(points[prevIdx].x - points[i].x, points[prevIdx].y - points[i].y);
    const lenNext = Math.hypot(points[nextIdx].x - points[i].x, points[nextIdx].y - points[i].y);
    if (lenPrev < 0.02 || lenNext < 0.02) {
      clamped = true;
      continue;
    }
    const capPrev = sel.has(prevIdx) ? Math.max(0, lenPrev * 0.5 - 0.005) : Math.max(0, lenPrev - 0.01);
    const capNext = sel.has(nextIdx) ? Math.max(0, lenNext * 0.5 - 0.005) : Math.max(0, lenNext - 0.01);
    const d = Math.min(distReq, capPrev, capNext);
    if (d < distReq - 1e-6) clamped = true;
    distances[i] = d >= 0.002 ? d : 0;
  }

  const hadSelfCross = selfIntersections(points, 1).length > 0;
  let built = buildBeveledRing(points, distances);
  if (!hadSelfCross && built.beveledCount > 0 && selfIntersections(built.points, 1).length > 0) {
    clamped = true;
    for (let attempt = 0; attempt < 8 && selfIntersections(built.points, 1).length > 0; attempt++) {
      for (let i = 0; i < n; i++) distances[i] = distances[i] * 0.5 >= 0.002 ? distances[i] * 0.5 : 0;
      built = buildBeveledRing(points, distances);
    }
    if (selfIntersections(built.points, 1).length > 0) {
      return { points: clonePts(points), selectedIndices: sel, beveledCount: 0, clamped: true };
    }
  }

  return { ...built, clamped };
}

/**
 * Applies `bevelPolygonVertices` to all polygon entries in `pointsMap` (`Map<uid, Set<number>>`)
 * inside an active `doc.begin(...)` transaction.
 */
export function bevelSelectionPoints(doc, pointsMap, distancePx = DEFAULT_BEVEL_DISTANCE_PX) {
  let totalBeveled = 0;
  let clamped = false;
  const touchedObjects = [];
  const nextPointsMap = new Map();

  if (!doc || !pointsMap) return { totalBeveled, clamped, touchedObjects, nextPointsMap };

  for (const [uid, indexSet] of pointsMap) {
    const obj = doc.get(uid);
    if (!obj || KIND_BY_TYPE[obj.type] !== 'poly' || !Array.isArray(obj.points) || obj.points.length < 3) continue;
    const res = bevelPolygonVertices(obj.points, indexSet, distancePx);
    if (res.clamped) clamped = true;
    if (res.beveledCount > 0) {
      doc.touch(obj);
      obj.points = res.points;
      totalBeveled += res.beveledCount;
      touchedObjects.push(obj);
      nextPointsMap.set(uid, res.selectedIndices);
    } else {
      nextPointsMap.set(uid, new Set(indexSet));
    }
  }

  return { totalBeveled, clamped, touchedObjects, nextPointsMap };
}
