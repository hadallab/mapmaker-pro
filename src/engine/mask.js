// Pure Draw Inside silhouette masking helpers.
// Clips drawn polygon strokes to a mask polygon via Clipper (shapes.js), drops
// slivers smaller than 0.25 square units (25 px^2), locks thin Sky pieces
// (< 1.5 file px tall) to solid [c, c], and prevents Wat output inside a Wat mask.

import { LAYER_BY_ID } from './layers.js';
import { bounds, signedArea, limitDecimals, hexToInt } from './geometry.js';
import { booleanOp } from './shapes.js';
import { DEFAULTS } from './dpm.js';
import { THIN_SKY_MIN_PX, MICRO_TERRAIN_MAX_AREA_PX2 } from './tester.js';

export const MASK_MIN_AREA_PX2 = MICRO_TERRAIN_MAX_AREA_PX2; // 0.25 u^2 = 25 file px^2
export const MASK_THIN_SKY_PX = THIN_SKY_MIN_PX; // 1.5 file px

function isValidPolygon(pts) {
  return Array.isArray(pts) && pts.length >= 3 && pts.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
}

function cleanRing(pts) {
  const out = [];
  for (const p of pts) {
    const rx = limitDecimals(p.x, 3);
    const ry = limitDecimals(p.y, 3);
    const x = rx === 0 ? 0 : rx;
    const y = ry === 0 ? 0 : ry;
    const prev = out.at(-1);
    if (!prev || prev.x !== x || prev.y !== y) out.push({ x, y });
  }
  while (out.length > 1 && out[0].x === out.at(-1).x && out[0].y === out.at(-1).y) out.pop();
  return out;
}

/**
 * Clips `strokePoints` against `maskPoints` via Clipper intersection, splitting
 * any holes into valid Mapmaker polygons and dropping slivers < 0.25 square units.
 */
export function clipToMask(strokePoints, maskPoints, { minAreaPx2 = MASK_MIN_AREA_PX2 } = {}) {
  if (!isValidPolygon(strokePoints) || !isValidPolygon(maskPoints)) return [];
  if (Math.abs(signedArea(strokePoints)) <= 1e-6 || Math.abs(signedArea(maskPoints)) <= 1e-6) return [];

  const sb = bounds(strokePoints);
  const mb = bounds(maskPoints);
  if (sb.x + sb.width <= mb.x || mb.x + mb.width <= sb.x || sb.y + sb.height <= mb.y || mb.y + mb.height <= sb.y) {
    return [];
  }

  const raw = booleanOp('intersect', strokePoints, [maskPoints]);
  const out = [];
  for (const poly of raw) {
    const pts = cleanRing(poly);
    if (pts.length < 3) continue;
    const b = bounds(pts);
    if (b.width <= 0 || b.height <= 0) continue;
    if (Math.abs(signedArea(pts)) < minAreaPx2) continue;
    out.push(pts);
  }
  return out;
}

/**
 * Ensures Sky polygons shorter than 1.5 file px use solid [c, c] colours
 * so they never render black in the community map tester.
 */
export function normalizeMaskedSkyColors(points, colors) {
  const base = (Array.isArray(colors) && colors.length ? colors : DEFAULTS.skyColors).map(hexToInt);
  const c0 = base[0] ?? 0;
  if (!isValidPolygon(points)) return base.length >= 2 ? base : [c0, c0];
  if (bounds(points).height < MASK_THIN_SKY_PX) return [c0, c0];
  return base.length >= 2 ? base : [c0, c0];
}

/**
 * True when outputting to `targetLayerId` inside `maskObj` would place a Wat
 * polygon inside a Wat mask.
 */
export function isWaterMaskConflict(maskObj, targetLayerId) {
  const targetType = LAYER_BY_ID[targetLayerId]?.type;
  return Boolean(maskObj && maskObj.type === 'Wat' && targetType === 'Wat');
}

/**
 * Returns the insertion index in `doc.layers[targetLayerId]` so masked shapes on
 * the mask's own layer sit directly above the mask (or above `anchorUid` when
 * drawing multiple strokes in the same session), and other layers append at top.
 */
export function maskedInsertIndex(doc, maskObj, targetLayerId, anchorUid = null) {
  if (!doc || !maskObj || maskObj.layerId !== targetLayerId) return null;
  const list = doc.layers[targetLayerId];
  if (!list) return null;
  const maskIdx = list.indexOf(maskObj);
  if (maskIdx < 0) return null;
  if (anchorUid != null) {
    const anchorObj = doc.get(anchorUid);
    const anchorIdx = anchorObj && anchorObj.layerId === targetLayerId ? list.indexOf(anchorObj) : -1;
    if (anchorIdx > maskIdx) return anchorIdx + 1;
  }
  return maskIdx + 1;
}

/**
 * Inserts pre-clipped polygon pieces into `doc` at the masked draw order.
 * Must be called inside a document transaction (`doc.begin`).
 */
export function insertMaskedPieces(doc, { maskObj, layerId, pieces, makeObject, anchorUid = null }) {
  const layer = LAYER_BY_ID[layerId];
  if (!layer || layer.kind !== 'poly') return { ok: false, reason: 'invalid-layer', created: [] };
  if (isWaterMaskConflict(maskObj, layerId)) return { ok: false, reason: 'wat-in-wat', created: [] };
  if (!Array.isArray(pieces) || !pieces.length) return { ok: false, reason: 'empty', created: [] };

  const baseIdx = maskedInsertIndex(doc, maskObj, layerId, anchorUid);
  const created = [];
  for (let i = 0; i < pieces.length; i++) {
    const obj = makeObject(layer.type, layer.id, pieces[i]);
    if (obj.type === 'Sky') {
      obj.colors = normalizeMaskedSkyColors(obj.points, obj.colors);
    }
    const idx = baseIdx == null ? null : baseIdx + i;
    created.push(doc.add(obj, idx));
  }
  return { ok: true, reason: null, created };
}

/**
 * Clips `strokePoints` to `maskObj` and adds resulting polygon(s) to `doc` at the
 * masked draw order. Must be called inside a document transaction (`doc.begin`).
 */
export function commitMaskedPolygons(doc, { maskObj, layerId, strokePoints, makeObject, anchorUid = null }) {
  if (!doc || !maskObj || !isValidPolygon(maskObj.points)) {
    return { ok: false, reason: 'invalid-mask', created: [] };
  }
  const layer = LAYER_BY_ID[layerId];
  if (!layer || layer.kind !== 'poly') {
    return { ok: false, reason: 'invalid-layer', created: [] };
  }
  if (isWaterMaskConflict(maskObj, layerId)) {
    return { ok: false, reason: 'wat-in-wat', created: [] };
  }
  const pieces = clipToMask(strokePoints, maskObj.points);
  if (!pieces.length) {
    return { ok: false, reason: 'empty', created: [] };
  }
  return insertMaskedPieces(doc, { maskObj, layerId, pieces, makeObject, anchorUid });
}
