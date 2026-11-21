// Surface-normal hide-space scatter and re-seat operations.
// DPM H objects have no scale field (only x, y, rotation, hSType, opacity),
// so size variation comes from mixing hide-space assets.

import { KIND_BY_TYPE } from './layers.js';
import { clamp, distanceToSegment, isClockwise, limitDecimals, signedArea } from './geometry.js';
import { spriteSize } from './document.js';
import { createObject } from './dpm.js';

export const PX_PER_UNIT = 10;
export const SURFACE_LAYER_IDS = ['terrains', 'islands', 'platforms', 'ceilings'];
export const SURFACE_FILTERS = ['all', 'floor', 'wall', 'ceiling'];
export const ALIGN_MODES = ['normal', 'upright'];

export const MIN_BRUSH_RADIUS = 5;    // 0.5 world units
export const MAX_BRUSH_RADIUS = 500;  // 50.0 world units
export const DEFAULT_BRUSH_RADIUS = 30; // 3.0 world units

export const MIN_SPACING = 2;         // 0.2 world units
export const MAX_SPACING = 300;       // 30.0 world units
export const DEFAULT_SPACING = 15;    // 1.5 world units

export const DEFAULT_ROTATION_JITTER = 10;  // degrees (+/-)
export const DEFAULT_SPACING_JITTER = 0.15; // fraction of spacing (+/-)
export const DEFAULT_EMBED = 0;             // file px
export const DEFAULT_RESEAT_MAX_DIST = 20;  // 2.0 world units
export const SLOPE_COS_THRESHOLD = Math.SQRT1_2; // 45 deg partition for Floor / Wall / Ceiling

const FALLBACK_ASSET = { width: 2, height: 2, anchorX: 0.5, anchorY: 1 };

function normalizeAngle(deg) {
  let v = deg % 360;
  if (v > 180) v -= 360;
  if (v <= -180) v += 360;
  return v === 0 ? 0 : v;
}

function polygonMeta(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const area = signedArea(points);
  if (!Number.isFinite(area) || Math.abs(area) < 1e-6) return null;
  return { minX, minY, maxX, maxY, cw: isClockwise(points), area };
}

/**
 * Caches per-polygon bounding boxes and winding keyed by `doc.revision`
 * so hover/drag surface queries stay fast on 3000-object maps.
 */
export function createSurfaceCache(doc = null) {
  let rev = doc ? doc.revision : -1;
  const map = new Map();
  return {
    get(obj) {
      if (doc && doc.revision !== rev) {
        rev = doc.revision;
        map.clear();
      }
      if (!obj || !Array.isArray(obj.points) || obj.points.length < 3) return null;
      if (obj.uid == null) return polygonMeta(obj.points);
      let entry = map.get(obj.uid);
      if (entry === undefined) {
        entry = polygonMeta(obj.points);
        map.set(obj.uid, entry);
      }
      return entry;
    },
    clear() {
      map.clear();
      rev = doc ? doc.revision : -1;
    }
  };
}

/**
 * True when an outward unit normal `(nx, ny)` in y-down coordinates matches `filter`:
 * - `'all'`: any normal
 * - `'floor'`: within 45 deg of up `(0, -1)`
 * - `'ceiling'`: within 45 deg of down `(0, +1)`
 * - `'wall'`: strictly between 45 deg and 135 deg from vertical
 */
export function matchesSurfaceFilter(nx, ny, filter = 'all') {
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return false;
  switch (filter) {
    case 'floor': return ny <= -SLOPE_COS_THRESHOLD;
    case 'ceiling': return ny >= SLOPE_COS_THRESHOLD;
    case 'wall': return Math.abs(ny) < SLOPE_COS_THRESHOLD;
    case 'all':
    default:
      return true;
  }
}

/**
 * Returns the unit outward normal `{ x, y }` for polygon edge `a -> b` given
 * `cw = isClockwise(points)` in y-down coordinates.
 */
export function outwardNormalForEdge(a, b, cw) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  const nx = (cw ? dy / len : -dy / len) || 0;
  const ny = (cw ? -dx / len : dx / len) || 0;
  return { x: nx, y: ny };
}

/**
 * Finds the closest surface point on visible terrain/island/platform/ceiling polygons
 * within `maxDist` file px of `point`, optionally filtered by `surfaceFilter`.
 */
export function nearestSurfacePoint(doc, point, maxDist = DEFAULT_BRUSH_RADIUS, {
  surfaceFilter = 'all',
  layers = SURFACE_LAYER_IDS,
  visible = null,
  surfaceCache = null
} = {}) {
  if (!doc?.layers || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  if (!(maxDist >= 0) || !Number.isFinite(maxDist)) return null;

  const qMinX = point.x - maxDist, qMaxX = point.x + maxDist;
  const qMinY = point.y - maxDist, qMaxY = point.y + maxDist;

  let best = null;
  let bestDist = maxDist;

  for (let li = 0; li < layers.length; li++) {
    const layerId = layers[li];
    if (visible && !visible.has(layerId)) continue;
    const list = doc.layers[layerId];
    if (!list || !list.length) continue;

    for (let oi = 0; oi < list.length; oi++) {
      const obj = list[oi];
      if (!obj || KIND_BY_TYPE[obj.type] !== 'poly') continue;
      const meta = surfaceCache ? surfaceCache.get(obj) : polygonMeta(obj.points);
      if (!meta) continue;
      if (meta.maxX < qMinX || meta.minX > qMaxX || meta.maxY < qMinY || meta.minY > qMaxY) continue;

      const pts = obj.points;
      const n = pts.length;
      for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        const minEx = a.x < b.x ? a.x : b.x;
        const maxEx = a.x > b.x ? a.x : b.x;
        if (maxEx < qMinX || minEx > qMaxX) continue;
        const minEy = a.y < b.y ? a.y : b.y;
        const maxEy = a.y > b.y ? a.y : b.y;
        if (maxEy < qMinY || minEy > qMaxY) continue;

        const norm = outwardNormalForEdge(a, b, meta.cw);
        if (!norm || !matchesSurfaceFilter(norm.x, norm.y, surfaceFilter)) continue;

        const d = distanceToSegment(point, a, b);
        if (d.distance <= bestDist) {
          bestDist = d.distance;
          best = {
            x: d.x,
            y: d.y,
            nx: norm.x,
            ny: norm.y,
            distance: d.distance,
            obj,
            edgeIndex: i,
            t: d.t
          };
        }
      }
    }
  }
  return best;
}

function anchorInfo(catalogEntry, flip180 = false) {
  const entry = catalogEntry || FALLBACK_ASSET;
  const w = (Number(entry.width) || FALLBACK_ASSET.width) * PX_PER_UNIT;
  const h = (Number(entry.height) || FALLBACK_ASSET.height) * PX_PER_UNIT;
  const ax = Number.isFinite(entry.anchorX) ? entry.anchorX : 0.5;
  const ay = Number.isFinite(entry.anchorY) ? entry.anchorY : 1;
  // Only top-anchored ceiling assets (anchorY === 0, e.g. iciclea, swamphalfmangrove)
  // hang downward (+y) at rot = 0; beaverdam (0.2) and swamplillypad (0.3) sit upright.
  const orientDown = (ay <= 0.05) !== !!flip180;
  const anchorDist = orientDown ? h * ay : h * (1 - ay);
  const offsetTan = (orientDown ? (0.5 - ax) : -(0.5 - ax)) * w;
  const contactLocal = { x: (0.5 - ax) * w, y: orientDown ? -anchorDist : anchorDist };
  return { orientDown, anchorDist, offsetTan, contactLocal };
}

/**
 * Computes anchor position `{ x, y }` and `rotation` (deg) so an `H` asset's
 * catalog anchor sits flush on `hit` and aligns to the outward surface normal.
 */
export function computePlacement(hit, catalogEntry, {
  align = 'normal',
  flip180 = false,
  rotationJitter = 0,
  embed = DEFAULT_EMBED,
  rng = Math.random
} = {}) {
  const { orientDown, anchorDist, offsetTan } = anchorInfo(catalogEntry, flip180);

  let effNx = hit.nx;
  let effNy = hit.ny;
  if (align === 'upright') {
    effNx = 0;
    effNy = hit.ny > 0 ? 1 : -1;
  }

  const normalDeg = Math.atan2(effNy, effNx) * 180 / Math.PI;
  const baseRot = orientDown ? normalDeg - 90 : normalDeg + 90;
  const jitterAmt = Number(rotationJitter) || 0;
  const jitter = jitterAmt > 0 ? (rng() * 2 - 1) * jitterAmt : 0;
  const rotation = normalizeAngle(baseRot + jitter);

  // Compensate non-0/1 anchors (e.g. anchorY = 0.5) along sprite orientation axes
  // so the sprite edge sits on `hit`, while embedding along the actual surface normal.
  const tx = -effNy;
  const ty = effNx;
  const emb = Number(embed) || 0;

  const x = hit.x + effNx * anchorDist + tx * offsetTan - hit.nx * emb;
  const y = hit.y + effNy * anchorDist + ty * offsetTan - hit.ny * emb;

  return {
    x: limitDecimals(x, 3),
    y: limitDecimals(y, 3),
    rotation: limitDecimals(rotation, 2)
  };
}

/**
 * Picks one valid `hSType` id from `assetIds` using `rng`.
 */
export function pickScatterAsset(assetIds, catalog, rng = Math.random) {
  const byId = catalog?.hideSpaceById;
  const valid = [];
  if (Array.isArray(assetIds)) {
    for (let i = 0; i < assetIds.length; i++) {
      const id = Number(assetIds[i]);
      if (!byId || byId.has(id)) valid.push(id);
    }
  }
  if (!valid.length) return catalog?.hideSpaces?.[0]?.id ?? 1;
  const idx = Math.min(valid.length - 1, Math.floor(rng() * valid.length));
  return valid[idx];
}

/**
 * Creates mutable state for a single scatter brush drag stroke.
 */
export function createScatterStrokeState() {
  return { placed: [], nextGap: null };
}

function nextSpacingValue(spacing, spacingJitter, rng) {
  const j = clamp(Number(spacingJitter) || 0, 0, 0.5);
  const factor = j > 0 ? 1 + (rng() * 2 - 1) * j : 1;
  return Math.max(MIN_SPACING, spacing * factor);
}

/**
 * Plans new `H` placements along the cursor segment `prevCursor -> currCursor`
 * without mutating `doc`. Appends accepted placements to `state.placed` and returns
 * only the newly planned items from this step.
 */
export function planScatterStep(doc, state, prevCursor, currCursor, options = {}) {
  if (!doc || !state || !currCursor) return [];
  const radius = clamp(Number(options.radius) || DEFAULT_BRUSH_RADIUS, MIN_BRUSH_RADIUS, MAX_BRUSH_RADIUS);
  const spacing = clamp(Number(options.spacing) || DEFAULT_SPACING, MIN_SPACING, MAX_SPACING);
  const spacingJitter = clamp(Number(options.spacingJitter ?? DEFAULT_SPACING_JITTER) || 0, 0, 0.5);
  const rotationJitter = clamp(Number(options.rotationJitter ?? 0) || 0, 0, 180);
  const embed = Number(options.embed) || 0;
  const opacity = clamp(Number(options.opacity ?? 1), 0, 1);
  const surfaceFilter = options.surfaceFilter || 'all';
  const align = options.align || 'normal';
  const flip180 = !!options.flip180;
  const visible = options.visible || null;
  const surfaceCache = options.surfaceCache || null;
  const catalog = options.catalog || null;
  const rng = options.rng || Math.random;
  const clampBounds = options.clampToWorld !== false;

  const p0 = prevCursor || currCursor;
  const dx = currCursor.x - p0.x;
  const dy = currCursor.y - p0.y;
  const dist = Math.hypot(dx, dy);
  const stepLen = Math.max(2, spacing * 0.35);
  const steps = prevCursor && dist > 0 ? Math.max(1, Math.ceil(dist / stepLen)) : 1;
  const minAnySq = Math.pow(Math.max(MIN_SPACING * 0.5, spacing * 0.65), 2);
  const W = doc.pixelWidth || 0;
  const H = doc.pixelHeight || 0;

  const added = [];
  for (let s = 1; s <= steps; s++) {
    const t = prevCursor ? s / steps : 1;
    const pt = { x: p0.x + dx * t, y: p0.y + dy * t };
    const hit = nearestSurfacePoint(doc, pt, radius, {
      surfaceFilter,
      visible,
      surfaceCache
    });
    if (!hit) continue;

    const placed = state.placed;
    if (placed.length > 0) {
      const last = placed[placed.length - 1];
      const gap = state.nextGap ?? spacing;
      const dLastSq = (hit.x - last.sx) * (hit.x - last.sx) + (hit.y - last.sy) * (hit.y - last.sy);
      if (dLastSq < gap * gap) continue;

      let tooClose = false;
      for (let i = placed.length - 2; i >= 0; i--) {
        const prev = placed[i];
        const dSq = (hit.x - prev.sx) * (hit.x - prev.sx) + (hit.y - prev.sy) * (hit.y - prev.sy);
        if (dSq < minAnySq) { tooClose = true; break; }
      }
      if (tooClose) continue;
    }

    const hSType = pickScatterAsset(options.assets, catalog, rng);
    const entry = catalog?.hideSpaceById?.get(hSType) || null;
    const pos = computePlacement(hit, entry, { align, flip180, rotationJitter, embed, rng });
    const px = clampBounds && W > 0 ? clamp(pos.x, 0, W) : pos.x;
    const py = clampBounds && H > 0 ? clamp(pos.y, 0, H) : pos.y;

    const item = {
      type: 'H',
      layerId: 'hide-spaces',
      hSType,
      x: limitDecimals(px, 3),
      y: limitDecimals(py, 3),
      rotation: pos.rotation,
      opacity,
      sx: hit.x,
      sy: hit.y
    };
    placed.push(item);
    added.push(item);
    state.nextGap = nextSpacingValue(spacing, spacingJitter, rng);
  }
  return added;
}

/**
 * Transactional batch helper for unit tests and scripted scatter strokes.
 * Assumes caller runs inside `doc.begin(...)` / `ed.edit(...)`.
 */
export function scatterStroke(doc, pathPoints, options = {}) {
  if (!doc || !Array.isArray(pathPoints) || !pathPoints.length) return [];
  const opts = options.surfaceCache ? options : { ...options, surfaceCache: createSurfaceCache(doc) };
  const state = createScatterStrokeState();
  const planned = [];
  for (let i = 0; i < pathPoints.length; i++) {
    const prev = i > 0 ? pathPoints[i - 1] : null;
    planned.push(...planScatterStep(doc, state, prev, pathPoints[i], opts));
  }
  const created = [];
  for (let i = 0; i < planned.length; i++) {
    const p = planned[i];
    created.push(doc.add(createObject('H', 'hide-spaces', {
      hSType: p.hSType,
      x: p.x,
      y: p.y,
      rotation: p.rotation,
      opacity: p.opacity
    })));
  }
  return created;
}

/**
 * Returns all `H` objects on `'hide-spaces'` whose oriented sprite bounds
 * intersect the circle `(center, radius)`.
 */
export function findHideSpacesInRadius(doc, center, radius, catalog = null) {
  if (!doc?.layers || !center || !(radius >= 0) || !Number.isFinite(center.x) || !Number.isFinite(center.y)) {
    return [];
  }
  const list = doc.layers['hide-spaces'] || [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (!o || o.type !== 'H') continue;
    const size = catalog ? spriteSize(o, catalog) : { width: 20, height: 20, ax: 0.5, ay: 0.5 };
    const maxDim = Math.max(size.width, size.height) + radius;
    const dx = center.x - o.x;
    const dy = center.y - o.y;
    if (Math.abs(dx) > maxDim || Math.abs(dy) > maxDim) continue;

    const rad = -(o.rotation || 0) * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;

    const minX = -size.width * size.ax;
    const maxX = size.width * (1 - size.ax);
    const minY = -size.height * size.ay;
    const maxY = size.height * (1 - size.ay);

    const qx = clamp(lx, minX, maxX);
    const qy = clamp(ly, minY, maxY);
    if (Math.hypot(lx - qx, ly - qy) <= radius) {
      out.push(o);
    }
  }
  return out;
}

/**
 * Re-seats `H` objects within `maxDist` (default 20 file px = 2 world units)
 * back onto the nearest visible terrain surface with anchor-aware rotation.
 * Must be called inside a `doc.begin(...)` / `ed.edit(...)` transaction.
 */
export function reseatHideSpaces(doc, objects, catalog, {
  maxDist = DEFAULT_RESEAT_MAX_DIST,
  surfaceFilter = 'all',
  visible = null,
  align = 'normal',
  flip180 = false,
  embed = 0,
  surfaceCache = null,
  clampToWorld = true
} = {}) {
  const result = { moved: 0, alreadySeated: 0, outOfRange: 0, updated: [] };
  if (!doc || !Array.isArray(objects) || !objects.length) return result;
  const cache = surfaceCache || createSurfaceCache(doc);
  const W = doc.pixelWidth || 0;
  const H = doc.pixelHeight || 0;

  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    if (!o || o.type !== 'H') continue;
    const entry = catalog?.hideSpaceById?.get(o.hSType) || null;
    const { contactLocal } = anchorInfo(entry, flip180);
    const rad = (o.rotation || 0) * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const queryPt = {
      x: o.x + contactLocal.x * cos - contactLocal.y * sin,
      y: o.y + contactLocal.x * sin + contactLocal.y * cos
    };
    const hit = nearestSurfacePoint(doc, queryPt, maxDist, {
      surfaceFilter,
      visible,
      surfaceCache: cache
    });
    if (!hit) {
      result.outOfRange++;
      continue;
    }

    const next = computePlacement(hit, entry, { align, flip180, rotationJitter: 0, embed });
    const nx = clampToWorld && W > 0 ? limitDecimals(clamp(next.x, 0, W), 3) : next.x;
    const ny = clampToWorld && H > 0 ? limitDecimals(clamp(next.y, 0, H), 3) : next.y;

    const dx = Math.abs(nx - o.x);
    const dy = Math.abs(ny - o.y);
    const dRot = Math.abs(normalizeAngle(next.rotation - (o.rotation || 0)));
    if (dx <= 1e-4 && dy <= 1e-4 && dRot <= 1e-3) {
      result.alreadySeated++;
      continue;
    }

    doc.touch(o);
    o.x = nx;
    o.y = ny;
    o.rotation = next.rotation;
    result.moved++;
    result.updated.push(o);
  }
  return result;
}

/**
 * True when a hide-space opacity below 1 prevents in-game food spawning.
 */
export function hideSpaceOpacityWarns(opacity) {
  const op = Number(opacity);
  return Number.isFinite(op) && op < 1;
}
