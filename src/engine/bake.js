// Tester-safe gradient baker. Slices a multi-stop Sky polygon into consecutive
// horizontal 2-stop bands so the community map tester (which draws only colors[0..1]
// and renders two-colour Sky shapes shorter than 1.5 file px black) matches the editor.

import { bounds, signedArea, hexToInt, clamp, limitDecimals } from './geometry.js';
import { booleanOp } from './shapes.js';
import { createObject } from './dpm.js';
import { THIN_SKY_MIN_PX } from './tester.js';

function unpackRgb(c) {
  const n = hexToInt(c);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function packRgb(rgb) {
  const r = clamp(Math.round(rgb[0]), 0, 255);
  const g = clamp(Math.round(rgb[1]), 0, 255);
  const b = clamp(Math.round(rgb[2]), 0, 255);
  return (r << 16) | (g << 8) | b;
}

// Piecewise linear RGB interpolation matching render.js createLinearGradient.
function sampleGradient(rgbStops, t) {
  const u = clamp(t, 0, 1) * (rgbStops.length - 1);
  const i = Math.min(Math.floor(u), rgbStops.length - 2);
  const f = u - i;
  const a = rgbStops[i], b = rgbStops[i + 1];
  return [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f
  ];
}

// Raises the band's top bounding edge by `lift` using a tiny spike on a flat top
// cut edge so the tester's repeating 1 px gradient texture does not bleed the bottom
// colour onto the top visible row.
function applySeamLift(pts, minY, lift) {
  if (!(lift > 0) || pts.length < 3) return pts;
  const tol = 0.005;
  let bestIdx = -1, bestLen = 0.01;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if (Math.abs(a.y - minY) <= tol && Math.abs(b.y - minY) <= tol) {
      const len = Math.abs(b.x - a.x);
      if (len > bestLen) { bestLen = len; bestIdx = i; }
    }
  }
  if (bestIdx < 0) return pts;
  const a = pts[bestIdx], b = pts[(bestIdx + 1) % pts.length];
  const dir = b.x >= a.x ? 1 : -1;
  const w = Math.min(0.3, bestLen * 0.25);
  const x1 = limitDecimals(a.x + dir * w * 0.5, 3);
  const y1 = limitDecimals(minY - lift, 3);
  const x2 = limitDecimals(a.x + dir * w, 3);
  const y2 = limitDecimals(a.y, 3);
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    out.push(pts[i]);
    if (i === bestIdx) out.push({ x: x1, y: y1 }, { x: x2, y: y2 });
  }
  return out;
}

/**
 * Slice a Sky polygon into consecutive horizontal 2-stop bands for map-tester parity.
 * All coordinate parameters (`overlap`, `seamLift`) are in file pixels (1 unit = 10 px).
 * Refuses Wat polygons because overlapping water bands render black in the tester.
 */
export function bakeSkyGradient(obj, { bands = 16, overlap = 1, seamLift = 0, frame = null } = {}) {
  if (!obj || typeof obj !== 'object') {
    return { ok: false, error: 'No object provided.', removeId: null, objects: [] };
  }
  if (obj.type === 'Wat') {
    return {
      ok: false,
      error: 'Water gradients cannot be baked into bands because overlapping water polygons render black in the map tester.',
      removeId: null,
      objects: []
    };
  }
  if (obj.type !== 'Sky') {
    return { ok: false, error: `Only Sky objects can be baked (got ${obj.type || 'unknown'}).`, removeId: null, objects: [] };
  }
  if (!Array.isArray(obj.points) || obj.points.length < 3) {
    return { ok: false, error: 'Sky polygon must have at least 3 points.', removeId: null, objects: [] };
  }
  if (!obj.points.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y))) {
    return { ok: false, error: 'Sky polygon has non-numeric coordinates.', removeId: null, objects: [] };
  }
  if (!Array.isArray(obj.colors) || obj.colors.length < 2) {
    return { ok: false, error: 'Sky object needs at least 2 colour stops.', removeId: null, objects: [] };
  }

  const b = bounds(obj.points);
  if (!(b.width > 0) || !(b.height > 0)) {
    return { ok: false, error: 'Sky polygon has zero width or height.', removeId: null, objects: [] };
  }

  const n = Math.max(1, Math.round(Number(bands) || 16));
  const ov = Math.max(0, Number(overlap ?? 1) || 0);
  const liftReq = seamLift === true ? 0.6 : (seamLift === false || seamLift == null) ? 0 : Math.max(0, Number(seamLift) || 0);

  // `frame` (a shared {y0, y1} gradient span): neighbouring skies with the same stops get the same
  // band grid and the same colour at every height, so their side edges do not show as lines.
  const useFrame = frame && Number.isFinite(frame.y0) && Number.isFinite(frame.y1) && frame.y1 > frame.y0;
  const y0 = useFrame ? frame.y0 : b.y, y1 = useFrame ? frame.y1 : b.y + b.height, totalH = y1 - y0;
  const x0 = b.x - 10, x1 = b.x + b.width + 10;
  const rgbStops = obj.colors.map(unpackRgb);
  const removeId = obj.uid ?? obj.id ?? null;
  const layerId = obj.layerId || 'sky';
  const baseSettings = obj.settings ? { ...obj.settings } : { collidable: true };
  const objects = [];

  for (let i = 0; i < n; i++) {
    const ya = y0 + totalH * i / n;
    const ys = y0 + totalH * (i + 1) / n;
    const ye = i < n - 1 ? Math.min(y1, ys + ov) : y1;
    if (ye <= ya) continue;

    const strip = [
      { x: x0, y: ya },
      { x: x1, y: ya },
      { x: x1, y: ye },
      { x: x0, y: ye }
    ];
    const pieces = booleanOp('intersect', obj.points, [strip]);
    for (const rawPts of pieces) {
      if (rawPts.length < 3 || Math.abs(signedArea(rawPts)) < 1e-3) continue;
      const pb = bounds(rawPts);
      if (pb.width < 1e-3 || pb.height < 1e-3) continue;

      let pts = rawPts.map(p => ({ x: limitDecimals(p.x, 3), y: limitDecimals(p.y, 3) }));
      const rb = bounds(pts);
      const pMinY = rb.y, pMaxY = rb.y + rb.height;

      if (rb.height < THIN_SKY_MIN_PX) {
        const midT = ((pMinY + pMaxY) / 2 - y0) / totalH;
        const c = packRgb(sampleGradient(rgbStops, midT));
        objects.push({
          type: 'Sky',
          layerId,
          points: pts,
          colors: [c, c],
          settings: { ...baseSettings }
        });
        continue;
      }

      const visTop = pMinY;
      const visBot = (i < n - 1 && pMaxY > ys + 1e-6 && ys > pMinY + 1e-3) ? ys : pMaxY;
      const span = Math.max(1e-6, visBot - visTop);
      const ca = sampleGradient(rgbStops, (visTop - y0) / totalH);
      const cs = sampleGradient(rgbStops, (visBot - y0) / totalH);

      const maxLift = i > 0 ? Math.max(0, Math.min(liftReq, visTop - y0)) : 0;
      let finalMinY = pMinY;
      if (maxLift > 0) {
        const lifted = applySeamLift(pts, pMinY, maxLift);
        if (lifted !== pts) {
          pts = lifted;
          finalMinY = bounds(pts).y;
        }
      }

      const ct = [0, 1, 2].map(k => ca[k] - (cs[k] - ca[k]) * (visTop - finalMinY) / span);
      const ce = [0, 1, 2].map(k => ca[k] + (cs[k] - ca[k]) * (pMaxY - visTop) / span);
      objects.push({
        type: 'Sky',
        layerId,
        points: pts,
        colors: [packRgb(ct), packRgb(ce)],
        settings: { ...baseSettings }
      });
    }
  }

  if (!objects.length) {
    return { ok: false, error: 'Gradient baking produced no valid polygon bands.', removeId: null, objects: [] };
  }
  return { ok: true, removeId, objects };
}

const sameStops = (a, b) => a.colors.length === b.colors.length && a.colors.every((c, k) => hexToInt(c) === hexToInt(b.colors[k]));

/**
 * Groups Sky objects that share the same colour stops and touch or overlap (bounding boxes within
 * `gap` file px), transitively. Each group is baked against one shared gradient frame.
 */
export function skyBakeGroups(objs, gap = 1) {
  const list = objs.filter(o => o && o.type === 'Sky' && Array.isArray(o.points) && o.points.length >= 3 && Array.isArray(o.colors));
  const boxes = list.map(o => bounds(o.points));
  const parent = list.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = boxes[i], c = boxes[j];
      const touch = a.x <= c.x + c.width + gap && c.x <= a.x + a.width + gap && a.y <= c.y + c.height + gap && c.y <= a.y + a.height + gap;
      if (touch && sameStops(list[i], list[j])) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  list.forEach((o, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(o); });
  return [...groups.values()].map(members => {
    const bs = members.map(o => bounds(o.points));
    return { members, frame: { y0: Math.min(...bs.map(b => b.y)), y1: Math.max(...bs.map(b => b.y + b.height)) } };
  });
}

/** The baking group of `obj` among all multi-stop Sky objects of the document. */
export function skyBakeGroupOf(doc, obj) {
  const skies = [];
  for (const id of Object.keys(doc.layers)) for (const o of doc.layers[id]) if (o.type === 'Sky' && (o.colors?.length ?? 0) > 2) skies.push(o);
  return skyBakeGroups(skies).find(g => g.members.includes(obj)) || { members: [obj], frame: null };
}

/**
 * Replace one or more Sky objects in `doc` with baked 2-stop bands inside a transaction,
 * preserving consecutive draw order at each original object's slot. Touching skies with the
 * same stops share one gradient frame (see skyBakeGroups).
 */
export function bakeSkyInDoc(doc, targets, options = {}) {
  const list = Array.isArray(targets) ? targets : [targets];
  const frameOf = new Map();
  for (const g of skyBakeGroups(list)) for (const o of g.members) frameOf.set(o, g.frame);
  const created = [];
  const errors = [];
  for (const obj of list) {
    const res = bakeSkyGradient(obj, { ...options, frame: options.frame ?? frameOf.get(obj) ?? null });
    if (!res.ok) {
      errors.push(res.error);
      continue;
    }
    const layerList = doc.layers[obj.layerId];
    const index = layerList ? layerList.indexOf(obj) : -1;
    if (index < 0) continue;
    doc.remove(obj);
    res.objects.forEach((spec, k) => {
      const next = createObject('Sky', spec.layerId, spec);
      created.push(doc.add(next, index + k));
    });
  }
  return { created, errors };
}
