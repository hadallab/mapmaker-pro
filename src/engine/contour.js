// Pure contour snapping, ring-segment tracing, segment protractor metrics, and
// seam-preserving polygon simplification. Free of UI imports so it runs in Node tests.

import { KIND_BY_TYPE } from './layers.js';
import {
  distanceToSegment,
  clamp,
  segmentsIntersect,
  simplifyRing,
  simplifyToCount,
  polygonBounds,
  boxOverlaps,
  triArea
} from './geometry.js';

export const PX_PER_UNIT = 10; // 1 Mapmaker unit = 10 file px
export const DEFAULT_SNAP_SCREEN_PX = 8; // screen px
export const DEFAULT_SHARED_VERTEX_TOLERANCE = 0.01; // file px coincidence threshold
export const EDGE_REVERSAL_COS = -0.9995; // matches tester.js findEdgeReversals

function finitePoint(p) {
  return Boolean(p && Number.isFinite(p.x) && Number.isFinite(p.y));
}

function isSnappableObject(o) {
  if (!o || !Array.isArray(o.points) || o.points.length < 2) return false;
  if (o.type && KIND_BY_TYPE[o.type] === 'sprite') return false;
  return true;
}

/**
 * Per-revision bounding-box cache so 3,000-object maps reject distant objects
 * in O(1) during pointer-move snap queries and shared-vertex lookups.
 */
export function createContourBoundsCache(doc = null) {
  let rev = doc ? doc.revision : -1;
  const map = new Map();
  return {
    get(obj) {
      if (doc && doc.revision !== rev) {
        rev = doc.revision;
        map.clear();
      }
      if (obj.uid == null) return polygonBounds(obj.points);
      let b = map.get(obj.uid);
      if (!b) {
        b = polygonBounds(obj.points);
        map.set(obj.uid, b);
      }
      return b;
    },
    clear() {
      map.clear();
      rev = doc ? doc.revision : -1;
    }
  };
}

function getBox(obj, boundsCache) {
  return boundsCache ? boundsCache.get(obj) : polygonBounds(obj.points);
}

function* iterVisibleLayerObjects(doc, visible = null) {
  if (!doc?.layers) return;
  for (const layerId of Object.keys(doc.layers)) {
    if (visible && !visible.has(layerId)) continue;
    const list = doc.layers[layerId];
    if (!Array.isArray(list)) continue;
    for (let i = 0; i < list.length; i++) {
      yield { layerId, obj: list[i] };
    }
  }
}

/**
 * Finds the highest-priority snap target near `worldPt` across visible objects.
 * Priority is strictly: vertex (`point`) > edge midpoint (`midpoint`) > nearest
 * point on edge (`edge`), followed by optional grid fallback (`grid`).
 * Uses bounding-box prefiltering on objects and segments for 3,000+ object maps.
 */
export function findSnapTarget(doc, worldPt, {
  tolerance = DEFAULT_SNAP_SCREEN_PX,
  visible = null,
  exclude = null,
  snapPoints = true,
  snapEdges = true,
  snapMidpoints = snapEdges,
  snapGrid = false,
  gridStep = 10,
  boundsCache = null
} = {}) {
  const wx = worldPt?.x ?? 0;
  const wy = worldPt?.y ?? 0;
  const fallback = () => {
    if (snapGrid && gridStep > 0) {
      return {
        x: Math.round(wx / gridStep) * gridStep,
        y: Math.round(wy / gridStep) * gridStep,
        kind: 'grid',
        label: 'Grid'
      };
    }
    return { x: wx, y: wy, kind: null, label: null };
  };

  if (!doc || !Number.isFinite(wx) || !Number.isFinite(wy)) return fallback();
  const tol = Math.max(0, Number(tolerance) || 0);
  if (tol <= 0 || (!snapPoints && !snapMidpoints && !snapEdges)) return fallback();

  const tolSq = tol * tol;
  const qMinX = wx - tol, qMaxX = wx + tol;
  const qMinY = wy - tol, qMaxY = wy + tol;

  let bestPoint = null;
  let bestPointDSq = Infinity;
  let bestMid = null;
  let bestMidDSq = Infinity;
  let bestEdge = null;
  let bestEdgeD = Infinity;

  for (const { layerId, obj } of iterVisibleLayerObjects(doc, visible)) {
    if (!isSnappableObject(obj)) continue;
    if (exclude && exclude.has(obj.uid)) continue;
    const pts = obj.points;
    const box = getBox(obj, boundsCache);
    if (!boxOverlaps(box, qMinX, qMinY, qMaxX, qMaxY)) continue;

    const n = pts.length;
    if (snapPoints) {
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        if (!finitePoint(p)) continue;
        const dx = p.x - wx, dy = p.y - wy;
        if (Math.abs(dx) > tol || Math.abs(dy) > tol) continue;
        const dSq = dx * dx + dy * dy;
        if (dSq <= tolSq && dSq < bestPointDSq) {
          bestPointDSq = dSq;
          bestPoint = {
            x: p.x,
            y: p.y,
            kind: 'point',
            label: 'Point',
            obj,
            uid: obj.uid,
            layerId,
            vertexIndex: i,
            edgeIndex: i,
            t: 0,
            distance: Math.sqrt(dSq)
          };
        }
      }
    }

    // Vertex tier strictly outranks midpoint and edge tiers.
    if (bestPoint || (!snapMidpoints && !snapEdges) || n < 2) continue;

    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      if (!finitePoint(a) || !finitePoint(b)) continue;
      if (Math.max(a.x, b.x) < qMinX || Math.min(a.x, b.x) > qMaxX ||
          Math.max(a.y, b.y) < qMinY || Math.min(a.y, b.y) > qMaxY) {
        continue;
      }

      if (snapMidpoints) {
        const mx = (a.x + b.x) * 0.5;
        const my = (a.y + b.y) * 0.5;
        const mdx = mx - wx, mdy = my - wy;
        if (Math.abs(mdx) <= tol && Math.abs(mdy) <= tol) {
          const mDSq = mdx * mdx + mdy * mdy;
          if (mDSq <= tolSq && mDSq < bestMidDSq) {
            bestMidDSq = mDSq;
            bestMid = {
              x: mx,
              y: my,
              kind: 'midpoint',
              label: 'Midpoint',
              obj,
              uid: obj.uid,
              layerId,
              edgeIndex: i,
              t: 0.5,
              a: { x: a.x, y: a.y },
              b: { x: b.x, y: b.y },
              distance: Math.sqrt(mDSq)
            };
          }
        }
      }

      // Midpoint tier strictly outranks arbitrary edge point tier.
      if (snapEdges && !bestMid) {
        const seg = distanceToSegment(worldPt, a, b);
        if (seg.distance <= tol && seg.distance < bestEdgeD) {
          bestEdgeD = seg.distance;
          bestEdge = {
            x: seg.x,
            y: seg.y,
            kind: 'edge',
            label: 'Edge',
            obj,
            uid: obj.uid,
            layerId,
            edgeIndex: i,
            t: seg.t,
            a: { x: a.x, y: a.y },
            b: { x: b.x, y: b.y },
            distance: seg.distance
          };
        }
      }
    }
  }

  return bestPoint || bestMid || bestEdge || fallback();
}

/**
 * Finds the closest point on a visible polygon's ring for Alt+Click contour tracing.
 * When `preferUid` is supplied (the currently anchored contour), hits on that
 * polygon within `tolerance` take precedence at shared corners/seams.
 */
export function findContourHit(doc, worldPt, {
  tolerance = 10,
  visible = null,
  exclude = null,
  preferUid = null,
  boundsCache = null
} = {}) {
  if (!doc || !finitePoint(worldPt) || !(tolerance > 0)) return null;
  if (preferUid != null && doc.get) {
    const preferred = doc.get(preferUid);
    if (preferred && (!visible || visible.has(preferred.layerId)) && (!exclude || !exclude.has(preferred.uid)) && isSnappableObject(preferred)) {
      const hit = findSnapTarget(
        { layers: { [preferred.layerId]: [preferred] } },
        worldPt,
        { tolerance, snapPoints: true, snapMidpoints: true, snapEdges: true, snapGrid: false, boundsCache }
      );
      if (hit && hit.kind && hit.kind !== 'grid') return hit;
    }
  }
  const hit = findSnapTarget(doc, worldPt, {
    tolerance,
    visible,
    exclude,
    snapPoints: true,
    snapMidpoints: true,
    snapEdges: true,
    snapGrid: false,
    boundsCache
  });
  return hit && hit.kind && hit.kind !== 'grid' ? hit : null;
}

/**
 * Locates `point` on a closed polygon `ring` within `tolerance`, preferring exact
 * vertex matches before projecting onto edges. Returns null if farther away.
 */
export function locatePointOnRing(ring, point, tolerance = 0.05) {
  if (!Array.isArray(ring) || ring.length < 3 || !finitePoint(point)) return null;
  const n = ring.length;
  const tol = Math.max(0, tolerance);
  let bestIdx = -1;
  let bestVertD = tol;
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    if (!finitePoint(p)) continue;
    const d = Math.hypot(p.x - point.x, p.y - point.y);
    if (d <= bestVertD) {
      bestVertD = d;
      bestIdx = i;
    }
  }
  if (bestIdx >= 0) {
    return { edgeIndex: bestIdx, t: 0, x: ring[bestIdx].x, y: ring[bestIdx].y, distance: bestVertD };
  }

  let bestEdge = null;
  let bestEdgeD = tol;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    if (!finitePoint(a) || !finitePoint(b)) continue;
    const seg = distanceToSegment(point, a, b);
    if (seg.distance <= bestEdgeD) {
      bestEdgeD = seg.distance;
      bestEdge = { edgeIndex: i, t: seg.t, x: seg.x, y: seg.y, distance: seg.distance };
    }
  }
  return bestEdge;
}

function normalizeRingLocation(ring, loc) {
  const n = ring.length;
  if (typeof loc === 'number') {
    const idx = ((Math.trunc(loc) % n) + n) % n;
    return { edgeIndex: idx, t: 0, x: ring[idx].x, y: ring[idx].y };
  }
  const rawIdx = loc.edgeIndex ?? loc.vertexIndex ?? loc.index ?? 0;
  let idx = ((Math.trunc(rawIdx) % n) + n) % n;
  let t = loc.t == null ? 0 : clamp(Number(loc.t) || 0, 0, 1);
  if (t <= 1e-9) {
    t = 0;
  } else if (t >= 1 - 1e-9) {
    idx = (idx + 1) % n;
    t = 0;
  }
  const a = ring[idx];
  const b = ring[(idx + 1) % n];
  const x = t === 0 ? a.x : (finitePoint(loc) ? loc.x : a.x + (b.x - a.x) * t);
  const y = t === 0 ? a.y : (finitePoint(loc) ? loc.y : a.y + (b.y - a.y) * t);
  return { edgeIndex: idx, t, x, y };
}

function pushUniquePoint(out, p) {
  const prev = out.at(-1);
  if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 1e-6) {
    out.push({ x: p.x, y: p.y });
  }
}

/**
 * Extracts the sequence of contour points along `ring` between `from` and `to`
 * along the shorter perimeter arc (or the longer arc when `reverse` is true).
 * `from` and `to` may be vertex indices or `{ edgeIndex, t, x?, y? }` locations.
 */
export function traceRingSegment(ring, from, to, options = {}) {
  if (!Array.isArray(ring) || ring.length < 3 || from == null || to == null) return [];
  const opts = typeof options === 'boolean' ? { reverse: options } : (options || {});
  const reverse = Boolean(opts.reverse);
  const includeStart = opts.includeStart !== false;
  const includeEnd = opts.includeEnd !== false;

  const n = ring.length;
  const a = normalizeRingLocation(ring, from);
  const b = normalizeRingLocation(ring, to);

  const cumLen = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    cumLen[i + 1] = cumLen[i] + Math.hypot(q.x - p.x, q.y - p.y);
  }
  const totalLen = cumLen[n];

  const arcPos = loc => {
    const edgeLen = cumLen[loc.edgeIndex + 1] - cumLen[loc.edgeIndex];
    return cumLen[loc.edgeIndex] + loc.t * edgeLen;
  };
  const s1 = arcPos(a);
  const s2 = arcPos(b);
  const u1 = a.edgeIndex + a.t;
  const u2 = b.edgeIndex + b.t;

  if (Math.abs(u1 - u2) < 1e-9 || Math.hypot(a.x - b.x, a.y - b.y) < 1e-6) {
    return includeStart ? [{ x: a.x, y: a.y }] : [];
  }

  let useForward;
  if (totalLen > 1e-9) {
    const fwdDist = s2 >= s1 ? s2 - s1 : totalLen - (s1 - s2);
    const bwdDist = totalLen - fwdDist;
    useForward = fwdDist <= bwdDist;
  } else {
    const fwdSteps = (b.edgeIndex - a.edgeIndex + n) % n;
    useForward = fwdSteps <= n - fwdSteps;
  }
  if (reverse) useForward = !useForward;

  const out = [];
  if (includeStart) pushUniquePoint(out, a);

  if (useForward) {
    const u2Wrap = u2 > u1 ? u2 : u2 + n;
    for (let k = Math.floor(u1) + 1; k < u2Wrap - 1e-9; k++) {
      pushUniquePoint(out, ring[k % n]);
    }
  } else {
    const u2Wrap = u2 < u1 ? u2 : u2 - n;
    let k = a.t > 0 ? a.edgeIndex : a.edgeIndex - 1;
    while (k > u2Wrap + 1e-9) {
      pushUniquePoint(out, ring[((k % n) + n) % n]);
      k--;
    }
  }

  if (includeEnd) {
    if (includeStart || out.length === 0 || Math.hypot(b.x - out.at(-1).x, b.y - out.at(-1).y) > 1e-6) {
      pushUniquePoint(out, b);
    }
  }
  if (!includeStart && out.length > 0 && Math.hypot(out[0].x - a.x, out[0].y - a.y) <= 1e-6) {
    out.shift();
  }
  return out;
}

/**
 * Computes segment length (in px and Mapmaker units), heading angle in degrees
 * (matching ui/tools.js measure: +90 up, 0 right, -90 down), and interior corner
 * angle at `last` when `prev` is present (flagging near-180 deg edge reversals).
 */
export function segmentMetrics(prev, last, cur) {
  if (!last || !cur) return null;
  const dx = cur.x - last.x;
  const dy = cur.y - last.y;
  const lengthPx = Math.hypot(dx, dy);
  const lengthUnits = lengthPx / PX_PER_UNIT;
  let angleDeg = lengthPx > 1e-9 ? (Math.atan2(-dy, dx) * 180 / Math.PI) : 0;
  if (Object.is(angleDeg, -0)) angleDeg = 0;

  let cornerDeg = null;
  let edgeReversal = false;
  if (prev && lengthPx >= 1e-3) {
    const px = prev.x - last.x;
    const py = prev.y - last.y;
    const prevLen = Math.hypot(px, py);
    if (prevLen >= 1e-3) {
      const dot = clamp((px * dx + py * dy) / (prevLen * lengthPx), -1, 1);
      cornerDeg = Math.acos(dot) * 180 / Math.PI;
      // Incoming vector (last - prev) vs outgoing (cur - last) has opposite sign to (prev - last).
      edgeReversal = -dot <= EDGE_REVERSAL_COS;
    }
  }
  return { dx, dy, lengthPx, lengthUnits, angleDeg, cornerDeg, edgeReversal };
}

// ---- shared-vertex detection and pinned simplification ----

function collectDocumentPeers(doc) {
  const peers = [];
  if (!doc?.layers) return peers;
  for (const layerId of Object.keys(doc.layers)) {
    const list = doc.layers[layerId];
    if (!Array.isArray(list)) continue;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (isSnappableObject(o)) peers.push(o);
    }
  }
  return peers;
}

/**
 * Returns the Set of vertex indices on `obj` that coincide within `tolerance`
 * (default 0.01 file px) with any vertex of another non-sprite object in `doc`.
 * Uses bounding-box prefiltering + spatial hashing for large maps.
 */
export function findSharedVertices(doc, obj, {
  tolerance = DEFAULT_SHARED_VERTEX_TOLERANCE,
  boundsCache = null,
  peers = null
} = {}) {
  const pinned = new Set();
  if (!obj || !Array.isArray(obj.points) || obj.points.length === 0) return pinned;
  const pts = obj.points;
  const tol = Math.max(0, Number(tolerance) || 0);
  const tolSq = tol * tol;

  const box = getBox(obj, boundsCache);
  const qMinX = box.minX - tol, qMaxX = box.maxX + tol;
  const qMinY = box.minY - tol, qMaxY = box.maxY + tol;
  const cellSize = Math.max(tol * 10, 1);
  const grid = new Map();

  const peerList = peers || collectDocumentPeers(doc);
  for (let i = 0; i < peerList.length; i++) {
    const peer = peerList[i];
    if (!peer || peer === obj || (obj.uid != null && peer.uid === obj.uid)) continue;
    if (!isSnappableObject(peer)) continue;
    const pb = getBox(peer, boundsCache);
    if (!boxOverlaps(pb, qMinX, qMinY, qMaxX, qMaxY)) continue;

    const pPts = peer.points;
    for (let k = 0; k < pPts.length; k++) {
      const q = pPts[k];
      if (!finitePoint(q)) continue;
      if (q.x < qMinX || q.x > qMaxX || q.y < qMinY || q.y > qMaxY) continue;
      const key = `${Math.floor(q.x / cellSize)},${Math.floor(q.y / cellSize)}`;
      let bucket = grid.get(key);
      if (!bucket) { bucket = []; grid.set(key, bucket); }
      bucket.push(q);
    }
  }

  if (!grid.size) return pinned;

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!finitePoint(p)) continue;
    const cx = Math.floor(p.x / cellSize);
    const cy = Math.floor(p.y / cellSize);
    let matched = false;
    for (let gx = cx - 1; gx <= cx + 1 && !matched; gx++) {
      for (let gy = cy - 1; gy <= cy + 1 && !matched; gy++) {
        const bucket = grid.get(`${gx},${gy}`);
        if (!bucket) continue;
        for (let b = 0; b < bucket.length; b++) {
          const q = bucket[b];
          const dx = q.x - p.x, dy = q.y - p.y;
          if (dx * dx + dy * dy <= tolSq) {
            pinned.add(i);
            matched = true;
            break;
          }
        }
      }
    }
  }

  return pinned;
}

/**
 * Batch version of `findSharedVertices` for multiple objects: builds a single
 * spatial hash over all non-sprite document vertices overlapping the union AABB
 * of `objs`, returning `Map<obj, Set<number>>`.
 */
export function findSharedVerticesBatch(doc, objs, {
  tolerance = DEFAULT_SHARED_VERTEX_TOLERANCE,
  boundsCache = null
} = {}) {
  const result = new Map();
  const list = (objs || []).filter(o => o && Array.isArray(o.points) && o.points.length > 0);
  if (!list.length) return result;
  for (let i = 0; i < list.length; i++) result.set(list[i], new Set());
  if (!doc?.layers) return result;

  const tol = Math.max(0, Number(tolerance) || 0);
  const tolSq = tol * tol;
  const cellSize = Math.max(tol * 10, 1);

  let uMinX = Infinity, uMinY = Infinity, uMaxX = -Infinity, uMaxY = -Infinity;
  for (let i = 0; i < list.length; i++) {
    const b = getBox(list[i], boundsCache);
    if (b.minX - tol < uMinX) uMinX = b.minX - tol;
    if (b.minY - tol < uMinY) uMinY = b.minY - tol;
    if (b.maxX + tol > uMaxX) uMaxX = b.maxX + tol;
    if (b.maxY + tol > uMaxY) uMaxY = b.maxY + tol;
  }

  const grid = new Map();
  const peers = collectDocumentPeers(doc);
  for (let i = 0; i < peers.length; i++) {
    const peer = peers[i];
    const pb = getBox(peer, boundsCache);
    if (!boxOverlaps(pb, uMinX, uMinY, uMaxX, uMaxY)) continue;
    const pPts = peer.points;
    for (let k = 0; k < pPts.length; k++) {
      const q = pPts[k];
      if (!finitePoint(q)) continue;
      if (q.x < uMinX || q.x > uMaxX || q.y < uMinY || q.y > uMaxY) continue;
      const key = `${Math.floor(q.x / cellSize)},${Math.floor(q.y / cellSize)}`;
      let bucket = grid.get(key);
      if (!bucket) { bucket = []; grid.set(key, bucket); }
      bucket.push({ obj: peer, uid: peer.uid, x: q.x, y: q.y });
    }
  }

  if (!grid.size) return result;

  for (let oi = 0; oi < list.length; oi++) {
    const obj = list[oi];
    const pts = obj.points;
    const pinned = result.get(obj);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!finitePoint(p)) continue;
      const cx = Math.floor(p.x / cellSize);
      const cy = Math.floor(p.y / cellSize);
      let matched = false;
      for (let gx = cx - 1; gx <= cx + 1 && !matched; gx++) {
        for (let gy = cy - 1; gy <= cy + 1 && !matched; gy++) {
          const bucket = grid.get(`${gx},${gy}`);
          if (!bucket) continue;
          for (let b = 0; b < bucket.length; b++) {
            const entry = bucket[b];
            if (entry.obj === obj || (obj.uid != null && entry.uid === obj.uid)) continue;
            const dx = entry.x - p.x, dy = entry.y - p.y;
            if (dx * dx + dy * dy <= tolSq) {
              pinned.add(i);
              matched = true;
              break;
            }
          }
        }
      }
    }
  }

  return result;
}

function toPinnedMask(n, pinnedIndices) {
  const mask = new Uint8Array(n);
  if (!pinnedIndices) return { mask, count: 0 };
  let count = 0;
  if (pinnedIndices instanceof Uint8Array || Array.isArray(pinnedIndices)) {
    if (pinnedIndices instanceof Uint8Array && pinnedIndices.length === n) {
      for (let i = 0; i < n; i++) { if (pinnedIndices[i]) { mask[i] = 1; count++; } }
      return { mask, count };
    }
  }
  for (const idx of pinnedIndices) {
    const i = idx | 0;
    if (i >= 0 && i < n && !mask[i]) {
      mask[i] = 1;
      count++;
    }
  }
  return { mask, count };
}

function markOpenLineDP(points, indices, epsilon, keepMask) {
  if (indices.length < 3) return;
  const stack = [[0, indices.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    if (e - s <= 1) continue;
    const ps = points[indices[s]];
    const pe = points[indices[e]];
    let bestPos = -1;
    let maxDist = 0;
    for (let pos = s + 1; pos < e; pos++) {
      const d = distanceToSegment(points[indices[pos]], ps, pe).distance;
      if (d > maxDist) {
        maxDist = d;
        bestPos = pos;
      }
    }
    if (maxDist > epsilon && bestPos > s) {
      keepMask[indices[bestPos]] = 1;
      stack.push([s, bestPos], [bestPos, e]);
    }
  }
}

/**
 * Douglas-Peucker simplification on a closed ring that preserves every vertex
 * index in `pinnedIndices` and always keeps at least 3 points.
 */
export function simplifyRingPinned(points, epsilon, pinnedIndices = null) {
  if (!Array.isArray(points)) return [];
  const n = points.length;
  if (n <= 3 || !(epsilon > 0)) return points.map(p => ({ x: p.x, y: p.y }));

  const { mask: pinned, count: pinnedCount } = toPinnedMask(n, pinnedIndices);
  if (pinnedCount === 0) return simplifyRing(points, epsilon);
  if (pinnedCount >= n) return points.map(p => ({ x: p.x, y: p.y }));

  const keep = new Uint8Array(n);
  const pinnedList = [];
  for (let i = 0; i < n; i++) {
    if (pinned[i]) {
      keep[i] = 1;
      pinnedList.push(i);
    }
  }

  if (pinnedList.length === 1) {
    const p0 = pinnedList[0];
    const loopIndices = [];
    for (let k = 0; k <= n; k++) loopIndices.push((p0 + k) % n);
    markOpenLineDP(points, loopIndices, epsilon, keep);
  } else {
    for (let m = 0; m < pinnedList.length; m++) {
      const start = pinnedList[m];
      const end = pinnedList[(m + 1) % pinnedList.length];
      const span = [];
      let cur = start;
      while (true) {
        span.push(cur);
        if (cur === end) break;
        cur = (cur + 1) % n;
      }
      markOpenLineDP(points, span, epsilon, keep);
    }
  }

  let keptCount = 0;
  for (let i = 0; i < n; i++) if (keep[i]) keptCount++;

  // Guarantee at least 3 vertices if DP dropped everything between 1 or 2 pins.
  while (keptCount < 3 && keptCount < n) {
    const kept = [];
    for (let i = 0; i < n; i++) if (keep[i]) kept.push(i);
    let bestIdx = -1;
    let bestScore = -1;
    for (let i = 0; i < n; i++) {
      if (keep[i]) continue;
      let score = 0;
      if (kept.length === 1) {
        const a = points[kept[0]];
        score = Math.hypot(points[i].x - a.x, points[i].y - a.y);
      } else {
        // Pick the unpinned vertex furthest from the chord connecting its bounding kept vertices.
        let prevK = kept[kept.length - 1], nextK = kept[0];
        for (let m = 0; m < kept.length; m++) {
          if (kept[m] < i) prevK = kept[m];
          if (kept[m] > i) { nextK = kept[m]; break; }
        }
        score = distanceToSegment(points[i], points[prevK], points[nextK]).distance;
      }
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    keep[bestIdx] = 1;
    keptCount++;
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push({ x: points[i].x, y: points[i].y });
  }
  return out.length >= 3 ? out : points.map(p => ({ x: p.x, y: p.y }));
}

function orient(a, b, c) {
  const v = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(v) < 1e-12) return 0;
  return v > 0 ? 1 : 2;
}

class MinAreaHeap {
  constructor() { this.data = []; }
  get size() { return this.data.length; }
  push(item) {
    const d = this.data;
    d.push(item);
    let i = d.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (d[p].area <= d[i].area) break;
      [d[p], d[i]] = [d[i], d[p]];
      i = p;
    }
  }
  pop() {
    const d = this.data;
    const top = d[0];
    const last = d.pop();
    if (d.length) {
      d[0] = last;
      let i = 0;
      const len = d.length;
      while (true) {
        let m = i;
        const l = i * 2 + 1, r = l + 1;
        if (l < len && d[l].area < d[m].area) m = l;
        if (r < len && d[r].area < d[m].area) m = r;
        if (m === i) break;
        [d[i], d[m]] = [d[m], d[i]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Visvalingam-Whyatt decimation down to `targetCount` points (>= max(3, pinnedCount))
 * while never removing any vertex in `pinnedIndices` and preventing edge reversals
 * or new self-intersections.
 */
export function simplifyToCountPinned(ring, targetCount, pinnedIndices = null) {
  if (!Array.isArray(ring)) return [];
  const n = ring.length;
  if (n <= 3 || targetCount == null || !Number.isFinite(Number(targetCount))) {
    return ring.map(p => ({ x: p.x, y: p.y }));
  }

  const { mask: pinned, count: pinnedCount } = toPinnedMask(n, pinnedIndices);
  if (pinnedCount === 0) return simplifyToCount(ring, targetCount);

  const minTarget = Math.max(3, pinnedCount);
  const target = Math.max(minTarget, Math.floor(Number(targetCount)));
  if (n <= target) return ring.map(p => ({ x: p.x, y: p.y }));

  const pts = ring.map(p => ({ x: p.x, y: p.y }));
  const prev = new Int32Array(n);
  const next = new Int32Array(n);
  const alive = new Uint8Array(n);
  const blocked = new Uint8Array(n);
  const ver = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    prev[i] = (i - 1 + n) % n;
    next[i] = (i + 1) % n;
    alive[i] = 1;
  }
  let aliveCount = n;

  const canRemove = i => {
    if (!alive[i] || pinned[i] || aliveCount <= 3) return false;
    const p = prev[i], q = next[i];
    if (p === q || prev[p] === q) return false;
    const A = pts[p], B = pts[i], C = pts[q];
    if (aliveCount === 4 && triArea(A, C, pts[next[q]]) <= 1e-6) return false;
    if (Math.hypot(B.x - A.x, B.y - A.y) < 1e-9 || Math.hypot(B.x - C.x, B.y - C.y) < 1e-9) return true;
    if (Math.hypot(C.x - A.x, C.y - A.y) < 1e-6) return false;

    const pp = pts[prev[p]], nn = pts[next[q]];
    if (orient(pp, A, C) === 0 && (pp.x - A.x) * (C.x - A.x) + (pp.y - A.y) * (C.y - A.y) > 0) return false;
    if (orient(A, C, nn) === 0 && (A.x - C.x) * (nn.x - C.x) + (A.y - C.y) * (nn.y - C.y) > 0) return false;

    const minX = Math.min(A.x, C.x), maxX = Math.max(A.x, C.x);
    const minY = Math.min(A.y, C.y), maxY = Math.max(A.y, C.y);
    for (let u = next[q]; u !== prev[p]; u = next[u]) {
      const w = next[u];
      const uPt = pts[u], wPt = pts[w];
      if (Math.max(uPt.x, wPt.x) < minX || Math.min(uPt.x, wPt.x) > maxX ||
          Math.max(uPt.y, wPt.y) < minY || Math.min(uPt.y, wPt.y) > maxY) continue;
      if (segmentsIntersect(A, C, uPt, wPt)) return false;
    }
    return true;
  };

  const heap = new MinAreaHeap();
  let minArea = 0;
  const pushVertex = i => {
    if (pinned[i]) return;
    ver[i]++;
    const area = Math.max(triArea(pts[prev[i]], pts[i], pts[next[i]]), minArea);
    heap.push({ area, i, v: ver[i] });
  };
  for (let i = 0; i < n; i++) pushVertex(i);

  const tryRemove = i => {
    if (!canRemove(i)) { blocked[i] = 1; return false; }
    const area = triArea(pts[prev[i]], pts[i], pts[next[i]]);
    if (area > minArea) minArea = area;
    const p = prev[i], q = next[i];
    alive[i] = 0;
    aliveCount--;
    next[p] = q;
    prev[q] = p;
    blocked[p] = 0;
    blocked[q] = 0;
    pushVertex(p);
    pushVertex(q);
    return true;
  };

  while (aliveCount > target) {
    while (heap.size && aliveCount > target) {
      const top = heap.pop();
      if (!alive[top.i] || top.v !== ver[top.i]) continue;
      tryRemove(top.i);
    }
    if (aliveCount <= target) break;
    let progressed = false;
    const candidates = [];
    for (let i = 0; i < n; i++) {
      if (alive[i] && !pinned[i] && blocked[i]) {
        candidates.push({ i, area: triArea(pts[prev[i]], pts[i], pts[next[i]]) });
      }
    }
    candidates.sort((a, b) => a.area - b.area);
    for (const c of candidates) {
      if (!alive[c.i] || aliveCount <= target) continue;
      blocked[c.i] = 0;
      if (tryRemove(c.i)) { progressed = true; break; }
    }
    if (!progressed) break;
  }

  let start = 0;
  while (start < n && !alive[start]) start++;
  const out = [];
  let cur = start;
  for (let k = 0; k < aliveCount; k++) {
    out.push({ x: pts[cur].x, y: pts[cur].y });
    cur = next[cur];
  }
  return out;
}

/**
 * Distributes `totalTarget` points across multiple rings proportionally while
 * respecting each ring's `max(min(3, len), pinnedCount)` floor.
 */
export function allocatePinnedPointBudget(rings, pinnedCounts, totalTarget) {
  const mins = rings.map((r, i) => Math.min(r.length, Math.max(Math.min(3, r.length), pinnedCounts[i] || 0)));
  const caps = rings.map(r => r.length);
  const minSum = mins.reduce((a, b) => a + b, 0);
  const maxSum = caps.reduce((a, b) => a + b, 0);
  const budget = Math.max(minSum, Math.min(maxSum, Math.round(totalTarget)));
  const rem = budget - minSum;
  const slack = maxSum - minSum;
  if (slack <= 0) return caps;
  const alloc = mins.map((m, i) => m + Math.floor(rem * (caps[i] - m) / slack));
  let leftover = budget - alloc.reduce((a, b) => a + b, 0);
  if (leftover > 0) {
    const order = rings.map((_, i) => ({
      i,
      frac: (rem * (caps[i] - mins[i]) / slack) % 1
    })).sort((a, b) => b.frac - a.frac);
    for (const { i } of order) {
      if (!leftover) break;
      if (alloc[i] < caps[i]) { alloc[i]++; leftover--; }
    }
  }
  return alloc;
}

/**
 * Read-only preview of simplifying `objs` while pinning vertices shared within
 * `tolerance` (default 0.01 px) with any other object in `doc`.
 */
export function previewSimplifyKeepingShared(doc, objs, {
  mode = 'tolerance',
  epsilon = 10,
  targetPoints = null,
  tolerance = DEFAULT_SHARED_VERTEX_TOLERANCE,
  boundsCache = null,
  pinnedSets = null
} = {}) {
  const polys = (objs || []).filter(o => o && KIND_BY_TYPE[o.type] === 'poly' && Array.isArray(o.points) && o.points.length >= 3);
  if (!polys.length) {
    return { before: 0, after: 0, minTarget: 0, pinnedCount: 0, items: [] };
  }

  let resolvedPinned = pinnedSets;
  if (!Array.isArray(resolvedPinned) || resolvedPinned.length !== polys.length) {
    const cache = boundsCache || createContourBoundsCache(doc);
    const batch = findSharedVerticesBatch(doc, polys, { tolerance, boundsCache: cache });
    resolvedPinned = polys.map(o => batch.get(o) || new Set());
  }
  const pinnedCounts = resolvedPinned.map(s => s.size);
  const totalPinned = pinnedCounts.reduce((a, b) => a + b, 0);
  const before = polys.reduce((s, o) => s + o.points.length, 0);
  const minTarget = polys.reduce((s, o, i) => s + Math.min(o.points.length, Math.max(3, pinnedCounts[i])), 0);

  let alloc = null;
  if (mode === 'target') {
    const t = targetPoints == null ? Math.round(before * 0.5) : Number(targetPoints);
    alloc = allocatePinnedPointBudget(polys.map(o => o.points), pinnedCounts, t);
  }

  const items = polys.map((o, i) => {
    const nextPoints = mode === 'target'
      ? simplifyToCountPinned(o.points, alloc[i], resolvedPinned[i])
      : simplifyRingPinned(o.points, epsilon, resolvedPinned[i]);
    return {
      obj: o,
      before: o.points.length,
      after: nextPoints.length,
      pinnedIndices: resolvedPinned[i],
      nextPoints
    };
  });

  const after = items.reduce((s, it) => s + it.after, 0);
  return { before, after, minTarget, pinnedCount: totalPinned, items };
}

/**
 * Simplifies `objs` in `doc` while pinning every vertex coinciding within
 * `tolerance` (0.01 px) with another object's vertex. Caller should wrap in a
 * single `doc.begin(...)` / `ed.edit(...)` transaction for 1-step undo.
 */
export function simplifyKeepingShared(doc, objs, options = {}) {
  const preview = previewSimplifyKeepingShared(doc, objs, options);
  let removed = 0;
  const touched = [];
  for (const item of preview.items) {
    if (item.nextPoints.length < item.obj.points.length) {
      doc.touch(item.obj);
      removed += item.obj.points.length - item.nextPoints.length;
      item.obj.points = item.nextPoints;
      touched.push(item.obj);
    }
  }
  return {
    removed,
    touched,
    pinnedCount: preview.pinnedCount,
    before: preview.before,
    after: preview.before - removed
  };
}
