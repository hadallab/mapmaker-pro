// Pure readability diagnostics for Deeeep.io maps:
// - Deceptive Background Terrains (Bg with opacity >= 0.65 inside playable water)
// - Misleading Hide Spaces (H with catalog above:true and canHide:false)

import { bounds, pointInPolygon } from './geometry.js';

export const DECEPTIVE_BG_OPACITY = 0.65;

const EPS = 1e-6;
const STRICT_EDGE_SQ = 1e-8;

function boxesOverlap(a, b) {
  return (
    a.x + a.width > b.x + EPS &&
    b.x + b.width > a.x + EPS &&
    a.y + a.height > b.y + EPS &&
    b.y + b.height > a.y + EPS
  );
}

function minEdgeDistSq(x, y, pts) {
  let best = Infinity;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq > 0 ? ((x - a.x) * dx + (y - a.y) * dy) / lenSq : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const px = a.x + t * dx - x;
    const py = a.y + t * dy - y;
    const dSq = px * px + py * py;
    if (dSq < best) best = dSq;
  }
  return best;
}

function pointInBox(x, y, b) {
  return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
}

function pointInAny(x, y, list) {
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (pointInBox(x, y, item.b) && pointInPolygon(x, y, item.pts)) return true;
  }
  return false;
}

function pointStrictlyInWater(x, y, waterList) {
  for (let i = 0; i < waterList.length; i++) {
    const w = waterList[i];
    if (
      x > w.b.x + EPS &&
      x < w.b.x + w.b.width - EPS &&
      y > w.b.y + EPS &&
      y < w.b.y + w.b.height - EPS &&
      pointInPolygon(x, y, w.pts) &&
      minEdgeDistSq(x, y, w.pts) > STRICT_EDGE_SQ
    ) {
      return true;
    }
  }
  return false;
}

function shapeEntries(list, hiddenUids, filterFn = null) {
  const out = [];
  if (!list) return out;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (!o || hiddenUids?.has(o.uid)) continue;
    if (!o.points || o.points.length < 3) continue;
    if (filterFn && !filterFn(o)) continue;
    out.push({ pts: o.points, b: bounds(o.points) });
  }
  return out;
}

/**
 * True when a Bg object has opacity >= minOpacity (default 0.65).
 */
export function isDeceptiveBgOpacity(obj, minOpacity = DECEPTIVE_BG_OPACITY) {
  if (!obj || obj.type !== 'Bg') return false;
  const raw = obj.opacity === undefined || obj.opacity === null ? 1 : Number(obj.opacity);
  return Number.isFinite(raw) && raw >= minOpacity;
}

/**
 * Classifies a Hide Space object using catalog metadata flags:
 * - 'misleading': drawn above animals (above:true) and does not hide (canHide:false)
 * - 'cover': grants stealth (canHide:true)
 * - null: regular background decor or invisible (opacity <= 0)
 */
export function classifyHideSpace(obj, catalog) {
  if (!obj || obj.type !== 'H') return null;
  const opacity = obj.opacity === undefined || obj.opacity === null ? 1 : Number(obj.opacity);
  if (!Number.isFinite(opacity) || opacity <= 0) return null;
  const info = catalog?.hideSpaceById?.get(obj.hSType);
  if (!info) return null;
  if (info.above && !info.canHide) return 'misleading';
  if (info.canHide) return 'cover';
  return null;
}

/**
 * Builds a bounding-box-indexed spatial query for playable water
 * (inside Water, outside Air Pockets, outside collidable Terrains/Islands).
 */
export function buildPlayableWaterQuery(doc, { hiddenUids = null } = {}) {
  const layers = doc?.layers || {};
  const water = shapeEntries(layers.water, hiddenUids);
  const air = shapeEntries(layers['air-pockets'], hiddenUids);
  const solid = [
    ...shapeEntries(layers.terrains, hiddenUids, o => o.settings?.collidable !== false),
    ...shapeEntries(layers.islands, hiddenUids, o => o.settings?.collidable !== false)
  ];

  const inPlayableWater = (x, y) =>
    pointStrictlyInWater(x, y, water) &&
    !pointInAny(x, y, air) &&
    !pointInAny(x, y, solid);

  const overlapsPlayableWater = (points, polyBounds = null) => {
    if (!water.length || !points || points.length < 3) return false;
    const b = polyBounds || bounds(points);
    const wList = [];
    for (let i = 0; i < water.length; i++) {
      if (boxesOverlap(water[i].b, b)) wList.push(water[i]);
    }
    if (!wList.length) return false;

    const aList = [];
    for (let i = 0; i < air.length; i++) {
      if (boxesOverlap(air[i].b, b)) aList.push(air[i]);
    }
    const sList = [];
    for (let i = 0; i < solid.length; i++) {
      if (boxesOverlap(solid[i].b, b)) sList.push(solid[i]);
    }

    const playable = (x, y) =>
      pointStrictlyInWater(x, y, wList) &&
      !pointInAny(x, y, aList) &&
      !pointInAny(x, y, sList);

    let cx = 0;
    let cy = 0;
    for (let i = 0; i < points.length; i++) {
      cx += points[i].x;
      cy += points[i].y;
    }
    cx /= points.length;
    cy /= points.length;
    if (pointInPolygon(cx, cy, points) && playable(cx, cy)) return true;

    const bx = b.x + b.width / 2;
    const by = b.y + b.height / 2;
    if (pointInPolygon(bx, by, points) && playable(bx, by)) return true;

    // Sample a 3x3 interior grid over each (bg ∩ water) bounding-box overlap.
    for (let wi = 0; wi < wList.length; wi++) {
      const wb = wList[wi].b;
      const ix0 = Math.max(b.x, wb.x);
      const iy0 = Math.max(b.y, wb.y);
      const ix1 = Math.min(b.x + b.width, wb.x + wb.width);
      const iy1 = Math.min(b.y + b.height, wb.y + wb.height);
      const iw = ix1 - ix0;
      const ih = iy1 - iy0;
      if (iw <= EPS || ih <= EPS) continue;
      for (let gx = 1; gx <= 3; gx++) {
        const px = ix0 + iw * (gx / 4);
        for (let gy = 1; gy <= 3; gy++) {
          const py = iy0 + ih * (gy / 4);
          if (pointInPolygon(px, py, points) && playable(px, py)) return true;
        }
      }
    }

    // Strict water check avoids false positives when a background only touches the water edge.
    const stride = points.length > 64 ? Math.ceil(points.length / 64) : 1;
    for (let i = 0; i < points.length; i += stride) {
      const p = points[i];
      if (playable(p.x, p.y)) return true;
      const q = points[(i + 1) % points.length];
      if (playable((p.x + q.x) / 2, (p.y + q.y) / 2)) return true;
    }

    return false;
  };

  return { inPlayableWater, overlapsPlayableWater };
}

/**
 * Returns Background Terrain (Bg) objects whose opacity >= minOpacity (default 0.65)
 * and whose polygon overlaps playable water.
 */
export function findDeceptiveBackgrounds(doc, {
  minOpacity = DECEPTIVE_BG_OPACITY,
  hiddenUids = null,
  waterQuery = null
} = {}) {
  const bgs = doc?.layers?.['background-terrains'] || [];
  const candidates = [];
  for (let i = 0; i < bgs.length; i++) {
    const bg = bgs[i];
    if (!bg || hiddenUids?.has(bg.uid)) continue;
    if (!bg.points || bg.points.length < 3) continue;
    if (isDeceptiveBgOpacity(bg, minOpacity)) candidates.push(bg);
  }
  if (!candidates.length) return [];
  const query = waterQuery || buildPlayableWaterQuery(doc, { hiddenUids });
  return candidates.filter(bg => query.overlapsPlayableWater(bg.points));
}

/**
 * Returns Hide Space (H) objects whose catalog entry has above:true and canHide:false.
 */
export function findMisleadingHideSpaces(doc, catalog, { hiddenUids = null } = {}) {
  const list = doc?.layers?.['hide-spaces'] || [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const obj = list[i];
    if (!obj || hiddenUids?.has(obj.uid)) continue;
    if (classifyHideSpace(obj, catalog) === 'misleading') out.push(obj);
  }
  return out;
}

/**
 * Runs both readability diagnostics in a single pass and returns object arrays
 * alongside O(1) uid Sets for the canvas renderer and overlay.
 */
export function analyzeReadability(doc, catalog, {
  minOpacity = DECEPTIVE_BG_OPACITY,
  hiddenUids = null
} = {}) {
  const deceptiveBgs = findDeceptiveBackgrounds(doc, { minOpacity, hiddenUids });
  const misleadingHides = [];
  const coverHides = [];
  const hides = doc?.layers?.['hide-spaces'] || [];
  for (let i = 0; i < hides.length; i++) {
    const obj = hides[i];
    if (!obj || hiddenUids?.has(obj.uid)) continue;
    const kind = classifyHideSpace(obj, catalog);
    if (kind === 'misleading') misleadingHides.push(obj);
    else if (kind === 'cover') coverHides.push(obj);
  }
  return {
    deceptiveBgs,
    deceptiveBgUids: new Set(deceptiveBgs.map(o => o.uid)),
    misleadingHides,
    misleadingHideUids: new Set(misleadingHides.map(o => o.uid)),
    coverHides,
    coverHideUids: new Set(coverHides.map(o => o.uid))
  };
}
