// Pure soft-falloff vertex sculpting geometry (Refine mode).
// Zero point bloat: only translates existing polygon vertices, never adds or removes points.

import { KIND_BY_TYPE, isLayerEditable } from './layers.js';
import { clamp, polygonBounds, boxOverlaps } from './geometry.js';

export const PX_PER_UNIT = 10;
export const DEFAULT_SEAM_TOLERANCE = 0.5; // 0.05 world units = 0.5 file px
export const MIN_BRUSH_RADIUS = 5; // 0.5 world units
export const MAX_BRUSH_RADIUS = 1000; // 100 world units
export const DEFAULT_BRUSH_RADIUS = 50; // 5.0 world units
export const DEFAULT_BRUSH_STRENGTH = 1;

/**
 * Creates a lightweight per-revision bounding-box cache for fast brush queries
 * on large maps (3000+ objects).
 */
export function createBoundsCache(doc = null) {
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

/**
 * Smooth C1 cosine falloff in [0, 1] for a vertex at `distance` inside `radius`.
 */
export function cosineFalloff(distance, radius) {
  if (!(radius > 0) || !Number.isFinite(distance)) return 0;
  if (distance <= 0) return 1;
  if (distance >= radius) return 0;
  return 0.5 * (1 + Math.cos(Math.PI * (distance / radius)));
}

/**
 * Computes an edge-slide displacement for vertex `curr` along its own adjacent
 * edges (`curr -> prev` or `curr -> next`), preserving the polygon outline.
 */
export function slideVertexOffset(prev, curr, next, delta, weight = 1) {
  if (!prev || !curr || !next || !delta || !(weight > 0)) return { dx: 0, dy: 0 };
  const wx = delta.x * weight;
  const wy = delta.y * weight;
  if (wx === 0 && wy === 0) return { dx: 0, dy: 0 };

  const px = prev.x - curr.x, py = prev.y - curr.y;
  const lenP = Math.hypot(px, py);
  const nx = next.x - curr.x, ny = next.y - curr.y;
  const lenN = Math.hypot(nx, ny);

  const projP = lenP > 1e-6 ? (wx * px + wy * py) / lenP : -Infinity;
  const projN = lenN > 1e-6 ? (wx * nx + wy * ny) / lenN : -Infinity;

  if (projP <= 0 && projN <= 0) return { dx: 0, dy: 0 };

  let ux, uy, len, proj;
  if (projP >= projN) {
    ux = px / lenP;
    uy = py / lenP;
    len = lenP;
    proj = projP;
  } else {
    ux = nx / lenN;
    uy = ny / lenN;
    len = lenN;
    proj = projN;
  }

  const minGap = Math.min(0.01, len * 0.05);
  const maxStep = Math.max(0, len - minGap);
  const step = Math.min(proj, maxStep);
  if (!(step > 0)) return { dx: 0, dy: 0 };
  return { dx: ux * step, dy: uy * step };
}

function getBox(obj, boundsCache) {
  return boundsCache ? boundsCache.get(obj) : polygonBounds(obj.points);
}

/**
 * Resolves primary target polygons to sculpt: selected editable polygons if any are
 * selected, otherwise visible unlocked polygons under the brush on the active layer.
 */
export function selectSculptTargets(doc, {
  selection = [],
  activeLayer = 'terrains',
  visible = null,
  locked = null,
  isolate = false,
  center = null,
  radius = DEFAULT_BRUSH_RADIUS,
  boundsCache = null
} = {}) {
  if (!doc) return [];
  const layerOpts = { activeLayer, visible, locked, isolate };
  if (selection && selection.length > 0) {
    return selection.filter(o =>
      o && KIND_BY_TYPE[o.type] === 'poly' &&
      Array.isArray(o.points) && o.points.length >= 3 &&
      isLayerEditable(o.layerId, layerOpts)
    );
  }
  if (!isLayerEditable(activeLayer, layerOpts)) return [];
  const list = doc.layers?.[activeLayer] || [];
  if (!center || !(radius > 0)) {
    return list.filter(o => o && KIND_BY_TYPE[o.type] === 'poly' && Array.isArray(o.points) && o.points.length >= 3);
  }

  const minX = center.x - radius, maxX = center.x + radius;
  const minY = center.y - radius, maxY = center.y + radius;
  const rSq = radius * radius;
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (!o || KIND_BY_TYPE[o.type] !== 'poly' || !Array.isArray(o.points) || o.points.length < 3) continue;
    const b = getBox(o, boundsCache);
    if (!boxOverlaps(b, minX, minY, maxX, maxY)) continue;
    const pts = o.points;
    for (let j = 0; j < pts.length; j++) {
      const dx = pts[j].x - center.x, dy = pts[j].y - center.y;
      if (dx * dx + dy * dy < rSq) {
        out.push(o);
        break;
      }
    }
  }
  return out;
}

/**
 * Returns all visible unlocked polygon objects eligible for Seam-Lock.
 */
export function collectSeamPeers(doc, {
  activeLayer = 'terrains',
  visible = null,
  locked = null,
  isolate = false
} = {}) {
  if (!doc?.layers) return [];
  const layerOpts = { activeLayer, visible, locked, isolate };
  const peers = [];
  for (const layerId of Object.keys(doc.layers)) {
    if (!isLayerEditable(layerId, layerOpts)) continue;
    const list = doc.layers[layerId];
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o && KIND_BY_TYPE[o.type] === 'poly' && Array.isArray(o.points) && o.points.length >= 3) {
        peers.push(o);
      }
    }
  }
  return peers;
}

function clonePoints(points) {
  const out = new Array(points.length);
  for (let i = 0; i < points.length; i++) out[i] = { x: points[i].x, y: points[i].y };
  return out;
}

function recordOriginal(originals, obj) {
  if (!originals.has(obj)) originals.set(obj, clonePoints(obj.points));
  return originals.get(obj);
}

/**
 * Captures a deterministic sculpt stroke plan at `center` without mutating `doc`.
 * Primary vertices inside `radius` are weighted with cosine falloff * strength,
 * and if `seamLock` is true, vertices on other visible unlocked polygons within
 * `seamTolerance` (default 0.5 px = 0.05 world units) are bound to move identically.
 */
export function prepareSculptStroke(doc, {
  center,
  radius = DEFAULT_BRUSH_RADIUS,
  strength = DEFAULT_BRUSH_STRENGTH,
  seamLock = true,
  seamTolerance = DEFAULT_SEAM_TOLERANCE,
  selection = [],
  activeLayer = 'terrains',
  visible = null,
  locked = null,
  isolate = false,
  boundsCache = null
} = {}) {
  const s = clamp(Number(strength) || 0, 0, 1);
  const empty = {
    center: center ? { x: center.x, y: center.y } : { x: 0, y: 0 },
    radius,
    strength: s,
    seamLock: !!seamLock,
    seamTolerance,
    leaders: [],
    originals: new Map(),
    affectedObjects: []
  };
  if (!doc || !center || !(radius > 0) || !(s > 0)) return empty;
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) return empty;

  const targets = selectSculptTargets(doc, {
    selection, activeLayer, visible, locked, isolate, center, radius, boundsCache
  });
  if (!targets.length) return empty;

  const candidates = [];
  const rSq = radius * radius;
  for (let t = 0; t < targets.length; t++) {
    const obj = targets[t];
    const pts = obj.points;
    const n = pts.length;
    const b = getBox(obj, boundsCache);
    if (!boxOverlaps(b, center.x - radius, center.y - radius, center.x + radius, center.y + radius)) continue;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const dx = p.x - center.x, dy = p.y - center.y;
      const dSq = dx * dx + dy * dy;
      if (dSq >= rSq) continue;
      const weight = cosineFalloff(Math.sqrt(dSq), radius) * s;
      if (!(weight > 0)) continue;
      const prev = pts[(i - 1 + n) % n];
      const next = pts[(i + 1) % n];
      candidates.push({
        obj,
        index: i,
        weight,
        orig: { x: p.x, y: p.y },
        prevOrig: { x: prev.x, y: prev.y },
        nextOrig: { x: next.x, y: next.y },
        followers: []
      });
    }
  }
  if (!candidates.length) return empty;

  // Highest-weight vertex leads each co-located seam cluster so touching shorelines
  // never diverge even when multiple polygons are selected together.
  candidates.sort((a, b) => b.weight - a.weight);

  const originals = new Map();
  const leaders = [];
  const claimed = new WeakMap();
  const markClaimed = (obj, idx) => {
    let set = claimed.get(obj);
    if (!set) { set = new Set(); claimed.set(obj, set); }
    set.add(idx);
  };
  const isClaimed = (obj, idx) => Boolean(claimed.get(obj)?.has(idx));

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const o = candidates[i].orig;
    if (o.x < minX) minX = o.x;
    if (o.y < minY) minY = o.y;
    if (o.x > maxX) maxX = o.x;
    if (o.y > maxY) maxY = o.y;
  }

  let seamGrid = null;
  let cellSize = 1;
  let tolSq = 0;
  if (seamLock && seamTolerance >= 0) {
    const tol = seamTolerance;
    tolSq = tol * tol;
    cellSize = Math.max(tol, 1);
    const qMinX = minX - tol, qMinY = minY - tol, qMaxX = maxX + tol, qMaxY = maxY + tol;
    const peers = collectSeamPeers(doc, { activeLayer, visible, locked, isolate });
    seamGrid = new Map();
    for (let i = 0; i < peers.length; i++) {
      const peer = peers[i];
      const b = getBox(peer, boundsCache);
      if (!boxOverlaps(b, qMinX, qMinY, qMaxX, qMaxY)) continue;
      const pts = peer.points;
      for (let k = 0; k < pts.length; k++) {
        const q = pts[k];
        if (q.x < qMinX || q.x > qMaxX || q.y < qMinY || q.y > qMaxY) continue;
        const key = `${Math.floor(q.x / cellSize)},${Math.floor(q.y / cellSize)}`;
        let bucket = seamGrid.get(key);
        if (!bucket) { bucket = []; seamGrid.set(key, bucket); }
        bucket.push({ obj: peer, index: k, orig: q });
      }
    }
  }

  for (const c of candidates) {
    if (isClaimed(c.obj, c.index)) continue;
    markClaimed(c.obj, c.index);
    recordOriginal(originals, c.obj);
    leaders.push(c);

    if (seamGrid && seamGrid.size) {
      const lx = c.orig.x, ly = c.orig.y;
      const cx = Math.floor(lx / cellSize), cy = Math.floor(ly / cellSize);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const bucket = seamGrid.get(`${gx},${gy}`);
          if (!bucket) continue;
          for (let b = 0; b < bucket.length; b++) {
            const item = bucket[b];
            if (item.obj === c.obj || isClaimed(item.obj, item.index)) continue;
            const dx = item.orig.x - lx, dy = item.orig.y - ly;
            if (dx * dx + dy * dy <= tolSq) {
              markClaimed(item.obj, item.index);
              recordOriginal(originals, item.obj);
              c.followers.push({ obj: item.obj, index: item.index, orig: { x: item.orig.x, y: item.orig.y } });
            }
          }
        }
      }
    }
  }

  return {
    center: { x: center.x, y: center.y },
    radius,
    strength: s,
    seamLock: !!seamLock,
    seamTolerance,
    leaders,
    originals,
    affectedObjects: [...originals.keys()]
  };
}

/**
 * Restores `stroke` objects to their initial snapshot and applies `delta`
 * (`{ x, y }` in file px). Preserves exact point counts.
 */
export function applySculptStroke(stroke, delta, { edgeSlide = false } = {}) {
  if (!stroke || !stroke.leaders?.length) return [];
  const dxIn = delta?.x || 0;
  const dyIn = delta?.y || 0;

  for (const [obj, origPts] of stroke.originals) {
    const pts = obj.points;
    for (let i = 0; i < origPts.length; i++) {
      pts[i].x = origPts[i].x;
      pts[i].y = origPts[i].y;
    }
  }

  if (dxIn === 0 && dyIn === 0) return stroke.affectedObjects;

  const d = { x: dxIn, y: dyIn };
  for (let i = 0; i < stroke.leaders.length; i++) {
    const leader = stroke.leaders[i];
    let dx, dy;
    if (edgeSlide) {
      ({ dx, dy } = slideVertexOffset(leader.prevOrig, leader.orig, leader.nextOrig, d, leader.weight));
    } else {
      dx = dxIn * leader.weight;
      dy = dyIn * leader.weight;
    }
    const lp = leader.obj.points[leader.index];
    lp.x = leader.orig.x + dx;
    lp.y = leader.orig.y + dy;

    const followers = leader.followers;
    for (let j = 0; j < followers.length; j++) {
      const f = followers[j];
      const fp = f.obj.points[f.index];
      fp.x = f.orig.x + dx;
      fp.y = f.orig.y + dy;
    }
  }

  return stroke.affectedObjects;
}

/**
 * One-shot transactional helper for unit tests and scripted edits.
 * Assumes caller runs inside `doc.begin(...)` / `ed.edit(...)`.
 */
export function sculptAt(doc, options = {}) {
  const stroke = prepareSculptStroke(doc, options);
  if (!stroke.affectedObjects.length) {
    return { affectedObjects: [], movedVertices: 0, seamFollowers: 0 };
  }
  for (const obj of stroke.affectedObjects) doc.touch(obj);
  applySculptStroke(stroke, options.delta || { x: 0, y: 0 }, { edgeSlide: !!options.edgeSlide });
  const seamFollowers = stroke.leaders.reduce((sum, l) => sum + l.followers.length, 0);
  return {
    affectedObjects: stroke.affectedObjects,
    movedVertices: stroke.leaders.length,
    seamFollowers
  };
}

/**
 * Mirrors a world point across the map centre matching EditorMeta.mirror (`'h' | 'v' | 'p'`).
 */
export function mirrorPoint(p, mode, pixelWidth, pixelHeight) {
  const fx = mode === 'h' || mode === 'p';
  const fy = mode === 'v' || mode === 'p';
  return {
    x: fx ? pixelWidth - p.x : p.x,
    y: fy ? pixelHeight - p.y : p.y
  };
}

/**
 * Mirrors a polygon point ring matching EditorMeta.mirror winding rules.
 */
export function mirrorPolygonPoints(points, mode, pixelWidth, pixelHeight) {
  if (!mode || mode === 'off') return clonePoints(points);
  const out = points.map(p => mirrorPoint(p, mode, pixelWidth, pixelHeight));
  if (mode !== 'p') out.reverse();
  return out;
}
