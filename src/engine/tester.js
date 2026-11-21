// Pure community map-tester parity and geometry/teleport safety helpers.
// Shared between the compatibility validator (validate.js) and canvas renderer (render.js).

import { bounds, signedArea, pointInPolygon, distanceToSegment, hexToInt, finite } from './geometry.js';

export const THIN_SKY_MIN_PX = 1.5; // file px; verified in the tester: 0.8-1.0 px snowflakes black (New Year), 5.6 px bands fine (Eclipse)
export const MICRO_TERRAIN_MAX_AREA_PX2 = 25; // 0.25 square map units

/**
 * Returns the two colour stops [c0, c1] the community map tester uses when
 * drawing a Sky or Wat gradient (stops beyond index 1 are ignored).
 */
export function testerGradientColors(obj) {
  const c = obj?.colors;
  if (!c || !c.length) return [0, 0];
  if (c.length === 1) return [c[0], c[0]];
  return [c[0], c[1]];
}

/** True when a Sky or Wat object defines more than two gradient colour stops. */
export function hasExtraGradientStops(obj) {
  return Boolean(obj && (obj.type === 'Sky' || obj.type === 'Wat') && (obj.colors?.length ?? 0) > 2);
}

/**
 * True when a Sky polygon is shorter than 1.5 file px and its first two
 * stops differ; the community tester draws such shapes solid black.
 */
export function isThinTwoStopSky(obj, objBounds = null) {
  if (!obj || obj.type !== 'Sky' || !obj.points || obj.points.length < 3) return false;
  if (!obj.colors || obj.colors.length < 2) return false;
  if (hexToInt(obj.colors[0]) === hexToInt(obj.colors[1])) return false;
  const b = objBounds || bounds(obj.points);
  return b.height < THIN_SKY_MIN_PX;
}

function minEdgeDistance(p, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = distanceToSegment(p, pts[i], pts[(i + 1) % pts.length]).distance;
    if (d < best) best = d;
  }
  return best;
}

/**
 * Describes the top-edge gradient wrap seam for a Sky/Wat shape in the tester,
 * or null when the shape uses a single solid colour.
 */
export function gradientTopSeam(obj) {
  if (!obj || (obj.type !== 'Sky' && obj.type !== 'Wat') || !obj.points || obj.points.length < 3) return null;
  const [c0, c1] = testerGradientColors(obj);
  if (hexToInt(c0) === hexToInt(c1)) return null;
  const b = bounds(obj.points);
  const flatTopEdges = [];
  for (let i = 0; i < obj.points.length; i++) {
    const p = obj.points[i], q = obj.points[(i + 1) % obj.points.length];
    if (Math.abs(p.y - b.y) <= 0.5 && Math.abs(q.y - b.y) <= 0.5 && Math.abs(p.x - q.x) > 0.5) {
      flatTopEdges.push([p, q]);
    }
  }
  return { top: b.y, x0: b.x, x1: b.x + b.width, flatTopEdges };
}

function ringMatchesWithin(ptsA, ptsB, tol) {
  for (const p of ptsA) {
    if (minEdgeDistance(p, ptsB) > tol) return false;
  }
  return true;
}

/**
 * Finds solid Ter polygons whose outline duplicates an earlier Ter polygon
 * (regardless of vertex order or winding direction).
 */
export function findDuplicateContours(terObjs) {
  const items = [];
  for (const obj of terObjs) {
    if (!obj?.points || obj.points.length < 3) continue;
    const area = Math.abs(signedArea(obj.points));
    if (area < 1e-6) continue;
    items.push({ obj, b: bounds(obj.points), area });
  }
  const duplicates = [];
  for (let i = 1; i < items.length; i++) {
    const cur = items[i];
    for (let j = 0; j < i; j++) {
      const prev = items[j];
      const tol = Math.max(0.5, 0.02 * Math.max(cur.b.width, cur.b.height, prev.b.width, prev.b.height));
      if (Math.abs(cur.b.x - prev.b.x) > tol || Math.abs(cur.b.y - prev.b.y) > tol ||
          Math.abs(cur.b.width - prev.b.width) > tol || Math.abs(cur.b.height - prev.b.height) > tol) continue;
      if (Math.abs(cur.area - prev.area) > 0.05 * Math.max(cur.area, prev.area)) continue;
      if (ringMatchesWithin(cur.obj.points, prev.obj.points, tol) &&
          ringMatchesWithin(prev.obj.points, cur.obj.points, tol)) {
        duplicates.push({ duplicate: cur.obj, original: prev.obj });
        break;
      }
    }
  }
  return duplicates;
}

/**
 * Returns vertex indices where two adjacent non-zero edges fold back ~180 deg
 * onto each other.
 */
export function findEdgeReversals(points, cosThreshold = -0.9995) {
  const n = points?.length ?? 0;
  if (n < 3) return [];
  const hits = [];
  for (let i = 0; i < n; i++) {
    const a = points[(i + n - 1) % n], b = points[i], c = points[(i + 1) % n];
    const x1 = b.x - a.x, y1 = b.y - a.y;
    const x2 = c.x - b.x, y2 = c.y - b.y;
    const l1 = Math.hypot(x1, y1), l2 = Math.hypot(x2, y2);
    if (l1 < 0.001 || l2 < 0.001) continue;
    const dot = (x1 * x2 + y1 * y2) / (l1 * l2);
    if (dot <= cosThreshold) hits.push(i);
  }
  return hits;
}

function shapeEntries(objs) {
  const out = [];
  for (const o of objs) {
    if (!o?.points || o.points.length < 3) continue;
    out.push({ pts: o.points, b: bounds(o.points) });
  }
  return out;
}

function anyShapeContains(list, x, y) {
  for (const s of list) {
    const b = s.b;
    if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height && pointInPolygon(x, y, s.pts)) {
      return true;
    }
  }
  return false;
}

function pointInTriggerRect(p, tr) {
  const x = tr.position?.x ?? 0, y = tr.position?.y ?? 0;
  const w = tr.size?.width ?? 0, h = tr.size?.height ?? 0;
  return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;
}

/** Lightweight spatial query for solid terrain, water, and trigger bounds. */
export function buildWorldQuery(doc) {
  const solid = shapeEntries([...doc.layers.terrains, ...doc.layers.islands].filter(o => o.settings?.collidable !== false));
  const water = shapeEntries(doc.layers.water);
  const air = shapeEntries(doc.layers['air-pockets']);
  return {
    pixelWidth: doc.pixelWidth,
    pixelHeight: doc.pixelHeight,
    triggers: doc.layers.triggers,
    isSolid: (x, y) => anyShapeContains(solid, x, y),
    inWater: (x, y) => anyShapeContains(water, x, y) && !anyShapeContains(air, x, y)
  };
}

function hasReturnEnterTeleport(candidateTr, originTr) {
  for (const t of candidateTr.triggers || []) {
    if (t.when !== 1) continue;
    for (const a of t.actions || []) {
      if (a.type === 1 && a.data?.pos && finite(a.data.pos.x) && finite(a.data.pos.y)) {
        if (pointInTriggerRect(a.data.pos, originTr)) return true;
      }
    }
  }
  return false;
}

function isInstantTeleportLoop(trObj, trigger, pos, allTriggers) {
  if (trigger.when !== 1) return false;
  if (pointInTriggerRect(pos, trObj)) return true;
  for (const other of allTriggers) {
    if (other === trObj || !pointInTriggerRect(pos, other)) continue;
    if (hasReturnEnterTeleport(other, trObj)) return true;
  }
  return false;
}

/**
 * Evaluates every teleport action across `doc.layers.triggers` and returns a Map
 * keyed by action object with `{ outOfBounds, solid, dry, loop }` flags.
 */
export function diagnoseTeleports(doc, world = null) {
  const w = world || buildWorldQuery(doc);
  const diag = new Map();
  for (const tr of w.triggers) {
    for (const t of tr.triggers || []) {
      for (const a of t.actions || []) {
        if (a.type !== 1) continue;
        const pos = a.data?.pos;
        if (!pos || !finite(pos.x) || !finite(pos.y)) continue;
        const outOfBounds = pos.x < 0 || pos.y < 0 || pos.x > w.pixelWidth || pos.y > w.pixelHeight;
        const solid = w.isSolid(pos.x, pos.y);
        const dry = !outOfBounds && !w.inWater(pos.x, pos.y);
        const loop = isInstantTeleportLoop(tr, t, pos, w.triggers);
        if (outOfBounds || solid || dry || loop) {
          diag.set(a, { outOfBounds, solid, dry, loop });
        }
      }
    }
  }
  return diag;
}

/** Formats a concise canvas tooltip reason string for a flagged teleport action. */
export function teleportActionSummary(flag) {
  if (!flag) return null;
  const reasons = [];
  if (flag.outOfBounds) reasons.push('Outside world');
  if (flag.solid) reasons.push('Inside solid terrain');
  if (flag.dry) reasons.push('Outside water');
  if (flag.loop) reasons.push('Teleport loop');
  return reasons.length ? reasons.join(', ') : null;
}
