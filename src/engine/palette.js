// Pure colour, atmosphere, Bg depth-stepping and palette extraction helpers.
// All mutations run on standard DPM fields (Sky/Wat colors, Air borderColor, Bg opacity)
// inside caller-managed transactions so every action is a single undo step.

import { bounds, clamp, hexToInt, intToHex } from './geometry.js';
import { THIN_SKY_MIN_PX } from './tester.js';
import { DECEPTIVE_BG_OPACITY } from './readability.js';

// Mapmaker Background Terrain opacity options (10% to 90% in 10% steps).
export const BG_ALLOWED_OPACITIES = Object.freeze([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
export const BG_DECEPTIVE_OPACITY = DECEPTIVE_BG_OPACITY;

const isSkyOrWat = o => Boolean(o && (o.type === 'Sky' || o.type === 'Wat'));
const isColorable = (o, includeAir) => isSkyOrWat(o) || Boolean(includeAir && o && o.type === 'Air');

/** Unpacks a 24-bit integer or `#rrggbb` colour into `[r, g, b]` bytes. */
export function intToRgb(color) {
  const c = hexToInt(color) & 0xffffff;
  return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}

/** Packs `[r, g, b]` channel values (0..255) into a 24-bit integer colour. */
export function rgbToInt(r, g, b) {
  const rr = clamp(Math.round(r), 0, 255);
  const gg = clamp(Math.round(g), 0, 255);
  const bb = clamp(Math.round(b), 0, 255);
  return ((rr << 16) | (gg << 8) | bb) >>> 0;
}

/** Converts 0..255 RGB channels into `{ h: [0..360), s: [0..1], l: [0..1] }`. */
export function rgbToHsl(r, g, b) {
  const rn = clamp(r, 0, 255) / 255;
  const gn = clamp(g, 0, 255) / 255;
  const bn = clamp(b, 0, 255) / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (d > 1e-9) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
    else if (max === gn) h = ((bn - rn) / d + 2) * 60;
    else h = ((rn - gn) / d + 4) * 60;
  }
  return { h, s, l };
}

/** Converts `{ h: [0..360), s: [0..1], l: [0..1] }` into `[r, g, b]` bytes. */
export function hslToRgb(h, s, l) {
  const hn = (((Number(h) || 0) % 360) + 360) % 360 / 360;
  const sn = clamp(Number(s) || 0, 0, 1);
  const ln = clamp(Number(l) || 0, 0, 1);
  if (sn <= 1e-9) {
    const v = Math.round(ln * 255);
    return [v, v, v];
  }
  const hue2rgb = (p, q, t) => {
    let u = t;
    if (u < 0) u += 1;
    if (u > 1) u -= 1;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  return [
    Math.round(hue2rgb(p, q, hn + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, hn) * 255),
    Math.round(hue2rgb(p, q, hn - 1 / 3) * 255)
  ];
}

/**
 * True when `obj` is a Sky polygon shorter than `THIN_SKY_MIN_PX` (1.5 file px).
 * Such shapes render solid black in the community tester unless kept single-colour `[c, c]`.
 */
export function isThinSkyPolygon(obj, objBounds = null) {
  if (!obj || obj.type !== 'Sky' || !Array.isArray(obj.points) || obj.points.length < 3) return false;
  const b = objBounds || bounds(obj.points);
  return b.height < THIN_SKY_MIN_PX;
}

/**
 * Collects distinct colours across `Sky` / `Wat` gradient stops (and `Air` borders if enabled),
 * sorted by descending stop count.
 */
export function collectSelectionColors(objs, { includeAir = false } = {}) {
  if (!Array.isArray(objs) || !objs.length) return [];
  const map = new Map();
  const record = (rawColor, obj) => {
    const color = hexToInt(rawColor) & 0xffffff;
    let entry = map.get(color);
    if (!entry) {
      entry = { color, hex: intToHex(color), count: 0, objects: new Set() };
      map.set(color, entry);
    }
    entry.count++;
    entry.objects.add(obj);
  };

  for (const obj of objs) {
    if (!obj) continue;
    if (isSkyOrWat(obj)) {
      for (const c of obj.colors || []) record(c, obj);
    } else if (includeAir && obj.type === 'Air') {
      record(obj.borderColor ?? 0, obj);
    }
  }

  return [...map.values()]
    .map(e => ({ color: e.color, hex: e.hex, count: e.count, objectCount: e.objects.size }))
    .sort((a, b) => (b.count - a.count) || (b.objectCount - a.objectCount) || (a.color - b.color));
}

function sameIntColors(prev, next) {
  if (!Array.isArray(prev) || prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if ((hexToInt(prev[i]) & 0xffffff) !== next[i]) return false;
  }
  return true;
}

/**
 * Replaces `fromColor` with `toColor` across matching gradient stops in `objs` without
 * flattening distinct gradients. Keeps thin Sky polygons (`< THIN_SKY_MIN_PX`) solid `[c, c]`.
 */
export function replaceSelectionColor(doc, objs, fromColor, toColor, { includeAir = false, preserveThinSky = true } = {}) {
  if (!Array.isArray(objs) || !objs.length) return { changedObjects: 0, changedStops: 0 };
  const fromInt = hexToInt(fromColor) & 0xffffff;
  const toInt = hexToInt(toColor) & 0xffffff;
  if (fromInt === toInt) return { changedObjects: 0, changedStops: 0 };

  let changedObjects = 0;
  let changedStops = 0;

  for (const obj of objs) {
    if (!obj) continue;
    if (isSkyOrWat(obj)) {
      const cols = obj.colors;
      if (!Array.isArray(cols) || !cols.length) continue;
      let hits = 0;
      for (let i = 0; i < cols.length; i++) {
        if ((hexToInt(cols[i]) & 0xffffff) === fromInt) hits++;
      }
      if (!hits) continue;

      let next;
      if (preserveThinSky && isThinSkyPolygon(obj)) {
        next = [toInt, toInt];
      } else {
        next = cols.map(c => {
          const v = hexToInt(c) & 0xffffff;
          return v === fromInt ? toInt : v;
        });
      }
      if (!sameIntColors(cols, next)) {
        doc?.touch?.(obj);
        obj.colors = next;
        changedObjects++;
        changedStops += hits;
      }
    } else if (includeAir && obj.type === 'Air') {
      const cur = hexToInt(obj.borderColor ?? 0) & 0xffffff;
      if (cur === fromInt) {
        doc?.touch?.(obj);
        obj.borderColor = toInt;
        changedObjects++;
        changedStops++;
      }
    }
  }

  return { changedObjects, changedStops };
}

/**
 * Collects colour-editable objects (`Sky`, `Wat`, and optionally `Air`) from either the
 * active selection or the whole document.
 */
export function collectPaletteTargets(doc, {
  scope = 'selection',
  selection = [],
  includeAir = true,
  locked = null
} = {}) {
  const out = [];
  if (scope === 'selection') {
    for (const obj of selection || []) {
      if (!isColorable(obj, includeAir)) continue;
      if (locked?.has?.(obj.layerId)) continue;
      out.push(obj);
    }
    return out;
  }
  if (!doc) return out;
  for (const obj of doc.objects()) {
    if (!isColorable(obj, includeAir)) continue;
    if (locked?.has?.(obj.layerId)) continue;
    out.push(obj);
  }
  return out;
}

/**
 * Transforms a single 24-bit colour by Hue (deg), Saturation (%), Lightness (%),
 * and proportional depth Haze toward `hazeColor`.
 */
export function transformColor(color, {
  hue = 0,
  saturation = 0,
  lightness = 0,
  haze = 0,
  hazeColor = 0xcfe9fc,
  depth = 0
} = {}) {
  const cInt = hexToInt(color) & 0xffffff;
  const dh = Number(hue) || 0;
  const ds = clamp((Number(saturation) || 0) / 100, -1, 1);
  const dl = clamp((Number(lightness) || 0) / 100, -1, 1);
  const mix = clamp((Number(haze) || 0) / 100, 0, 1) * clamp(Number(depth) || 0, 0, 1);

  if (dh === 0 && ds === 0 && dl === 0 && mix <= 0) return cInt;

  let [r, g, b] = intToRgb(cInt);
  if (dh !== 0 || ds !== 0 || dl !== 0) {
    const hsl = rgbToHsl(r, g, b);
    const h2 = ((hsl.h + dh) % 360 + 360) % 360;
    const s2 = hsl.s <= 1e-9 ? 0 : (ds >= 0 ? hsl.s + (1 - hsl.s) * ds : hsl.s * (1 + ds));
    const l2 = dl >= 0 ? hsl.l + (1 - hsl.l) * dl : hsl.l * (1 + dl);
    [r, g, b] = hslToRgb(h2, s2, l2);
  }

  if (mix > 0) {
    const [hr, hg, hb] = intToRgb(hazeColor);
    r += (hr - r) * mix;
    g += (hg - g) * mix;
    b += (hb - b) * mix;
  }

  return rgbToInt(r, g, b);
}

/**
 * Computes normalized vertical depth `[0, 1]` and cached polygon bounds for each object.
 * Uses vertical centre span across `objs` when > 1 px, falling back to `[0, worldHeight]`.
 */
export function computeObjectDepths(objs, {
  worldHeight = 0,
  direction = 'top-to-bottom',
  range = 'auto'
} = {}) {
  const entries = [];
  let minCy = Infinity;
  let maxCy = -Infinity;

  for (const obj of objs || []) {
    if (!obj) continue;
    let b = null;
    let cy = 0;
    if (Array.isArray(obj.points) && obj.points.length >= 3) {
      b = bounds(obj.points);
      cy = b.y + b.height / 2;
    } else if (obj.position && obj.size) {
      cy = obj.position.y + obj.size.height / 2;
    } else if (Number.isFinite(obj.y)) {
      cy = obj.y;
    }
    if (cy < minCy) minCy = cy;
    if (cy > maxCy) maxCy = cy;
    entries.push({ obj, cy, bounds: b });
  }

  let lo = minCy;
  let hi = maxCy;
  if (range === 'world' && worldHeight > 0) {
    lo = 0;
    hi = worldHeight;
  } else if (range === 'auto' && maxCy - minCy <= 1 && worldHeight > 0) {
    lo = 0;
    hi = worldHeight;
  }

  const span = hi - lo;
  const map = new Map();
  for (const { obj, cy, bounds: b } of entries) {
    let t = span > 1e-6 ? clamp((cy - lo) / span, 0, 1) : 0.5;
    if (direction === 'bottom-to-top') t = 1 - t;
    map.set(obj, { depth: t, bounds: b });
  }
  return map;
}

function computeAtmosphereForObject(obj, info, params, { includeAir = true, preserveThinSky = true } = {}) {
  const p = { ...params, depth: info.depth };
  if (isSkyOrWat(obj)) {
    if (!Array.isArray(obj.colors) || !obj.colors.length) return null;
    const thinSky = preserveThinSky && isThinSkyPolygon(obj, info.bounds);
    const nextColors = thinSky
      ? (() => { const c = transformColor(obj.colors[0], p); return [c, c]; })()
      : obj.colors.map(c => transformColor(c, p));
    const changed = !sameIntColors(obj.colors, nextColors);
    return { kind: 'colors', changed, thinSky, colors: nextColors };
  }
  if (includeAir && obj.type === 'Air') {
    const prev = hexToInt(obj.borderColor ?? 0) & 0xffffff;
    const next = transformColor(prev, p);
    return { kind: 'borderColor', changed: next !== prev, thinSky: false, borderColor: next };
  }
  return null;
}

/**
 * Computes non-destructive atmosphere preview overrides (`Map<uid, { colors?, borderColor? }>`)
 * for `Renderer.renderScene` without mutating any live document objects.
 */
export function computeAtmospherePreview(objs, params = {}, {
  worldHeight = 0,
  direction = 'top-to-bottom',
  range = 'auto',
  includeAir = true,
  preserveThinSky = true,
  depths = null
} = {}) {
  const overrides = new Map();
  if (!Array.isArray(objs) || !objs.length) return { overrides, changed: 0, thinSkyCount: 0 };
  const depthMap = depths || computeObjectDepths(objs, { worldHeight, direction, range });

  let changed = 0;
  let thinSkyCount = 0;
  for (const obj of objs) {
    if (!obj) continue;
    const info = depthMap.get(obj) || { depth: 0, bounds: null };
    const res = computeAtmosphereForObject(obj, info, params, { includeAir, preserveThinSky });
    if (!res) continue;
    if (res.thinSky) thinSkyCount++;
    if (res.changed) {
      changed++;
      const key = obj.uid ?? obj;
      overrides.set(key, res.kind === 'colors' ? { colors: res.colors } : { borderColor: res.borderColor });
    }
  }
  return { overrides, changed, thinSkyCount };
}

/**
 * Applies HSL shift and depth-proportional haze across `objs`.
 * Pass `doc = null` for non-destructive live preview; pass `doc` inside `doc.begin()` /
 * `ed.edit()` to commit as a single undo step. Thin Sky polygons (`< THIN_SKY_MIN_PX`)
 * always remain solid `[c, c]`.
 */
export function applyAtmosphereAdjust(doc, objs, params = {}, {
  worldHeight = 0,
  direction = 'top-to-bottom',
  range = 'auto',
  includeAir = true,
  preserveThinSky = true,
  depths = null
} = {}) {
  if (!Array.isArray(objs) || !objs.length) return { changed: 0, thinSkyCount: 0 };
  const h = worldHeight || doc?.pixelHeight || 0;
  const depthMap = depths || computeObjectDepths(objs, { worldHeight: h, direction, range });

  let changed = 0;
  let thinSkyCount = 0;

  for (const obj of objs) {
    if (!obj) continue;
    const info = depthMap.get(obj) || { depth: 0, bounds: null };
    const res = computeAtmosphereForObject(obj, info, params, { includeAir, preserveThinSky });
    if (!res) continue;
    if (res.thinSky) thinSkyCount++;
    if (res.changed) {
      doc?.touch?.(obj);
      if (res.kind === 'colors') obj.colors = res.colors;
      else obj.borderColor = res.borderColor;
      changed++;
    }
  }
  if (changed > 0 && doc?.touch) {
    for (const obj of objs) {
      if (obj && isColorable(obj, includeAir)) doc.touch(obj);
    }
  }

  return { changed, thinSkyCount };
}

/** Snaps an opacity value to the closest official `Bg` opacity in `BG_ALLOWED_OPACITIES`. */
export function snapBgOpacity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return BG_ALLOWED_OPACITIES[BG_ALLOWED_OPACITIES.length - 1];
  let best = BG_ALLOWED_OPACITIES[0];
  let bestDiff = Math.abs(n - best);
  for (let i = 1; i < BG_ALLOWED_OPACITIES.length; i++) {
    const cand = BG_ALLOWED_OPACITIES[i];
    const diff = Math.abs(n - cand);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = cand;
    }
  }
  return best;
}

/**
 * Generates `count` evenly spaced `Bg` opacities from `far` to `near`, quantized strictly
 * to the official Mapmaker `BG_ALLOWED_OPACITIES` (`0.1..0.9`).
 */
export function computeBgDepthSteps(count, far = 0.1, near = 0.5) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n === 0) return [];
  const f = snapBgOpacity(far);
  const t = snapBgOpacity(near);
  if (n === 1) return [f];
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = snapBgOpacity(f + (t - f) * (i / (n - 1)));
  }
  return out;
}

/**
 * Sorts `Bg` objects from far to near (`'z'` matches `Renderer` opacity+index draw order;
 * `'y-asc'` orders top-to-bottom; `'y-desc'` bottom-to-top; `'selection'` preserves order).
 */
export function orderBgObjects(objs, doc = null, orderBy = 'z') {
  const bgs = (objs || []).filter(o => o && o.type === 'Bg');
  if (orderBy === 'selection' || bgs.length < 2) return bgs.slice();

  const indexOf = (obj, fallback) => {
    if (!doc) return fallback;
    const idx = doc.indexOf(obj);
    return idx >= 0 ? idx : fallback;
  };
  const centerY = obj => {
    if (!Array.isArray(obj.points) || !obj.points.length) return 0;
    const b = bounds(obj.points);
    return b.y + b.height / 2;
  };

  const tagged = bgs.map((obj, i) => ({
    obj,
    layerIdx: indexOf(obj, i),
    opacity: Number(obj.opacity ?? 0),
    cy: (orderBy === 'y-asc' || orderBy === 'y-desc') ? centerY(obj) : 0
  }));

  if (orderBy === 'y-asc') {
    tagged.sort((a, b) => (a.cy - b.cy) || (a.layerIdx - b.layerIdx));
  } else if (orderBy === 'y-desc') {
    tagged.sort((a, b) => (b.cy - a.cy) || (a.layerIdx - b.layerIdx));
  } else {
    tagged.sort((a, b) => (a.opacity - b.opacity) || (a.layerIdx - b.layerIdx));
  }
  return tagged.map(e => e.obj);
}

/** Computes compounded alpha `1 - Π(1 - α_i)` for stacked translucent layers. */
export function compoundedOpacity(opacities) {
  let passThrough = 1;
  for (const v of opacities || []) {
    const a = clamp(Number(v) || 0, 0, 1);
    passThrough *= (1 - a);
  }
  return 1 - passThrough;
}

/**
 * Sets `Bg` opacities in even steps between `far` and `near` using only official allowed
 * values (`BG_ALLOWED_OPACITIES`). Mutates inside the caller's transaction.
 */
export function stepBgDepthOpacities(doc, objs, { far = 0.1, near = 0.5, orderBy = 'z' } = {}) {
  const ordered = orderBgObjects(objs, doc, orderBy);
  if (!ordered.length) return { count: 0, changed: 0, ordered: [], opacities: [], compounded: 0 };

  const opacities = computeBgDepthSteps(ordered.length, far, near);
  let changed = 0;
  for (let i = 0; i < ordered.length; i++) {
    const obj = ordered[i];
    if (obj.opacity !== opacities[i]) {
      doc?.touch?.(obj);
      obj.opacity = opacities[i];
      changed++;
    }
  }
  if (changed > 0 && doc?.touch) {
    for (let i = 0; i < ordered.length; i++) doc.touch(ordered[i]);
  }
  return {
    count: ordered.length,
    changed,
    ordered,
    opacities,
    compounded: compoundedOpacity(opacities)
  };
}

/**
 * Extracts up to `count` dominant `#rrggbb` colours from an RGBA pixel buffer via
 * deterministic median-cut quantization (ignores pixels with alpha < 128).
 */
export function extractPaletteFromPixels(rgba, count = 6) {
  const targetCount = Math.max(1, Math.min(16, Math.floor(Number(count) || 6)));
  if (!rgba || rgba.length < 4) return [];

  const totalPixels = Math.floor(rgba.length / 4);
  const stride = Math.max(1, Math.floor(totalPixels / 1500));
  const samples = [];
  for (let p = 0; p < totalPixels; p += stride) {
    const i = p * 4;
    if (rgba[i + 3] < 128) continue;
    samples.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
  }
  if (!samples.length) return [];

  const channelRange = bucket => {
    let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
    for (let i = 0; i < bucket.length; i++) {
      const c = bucket[i];
      if (c[0] < minR) minR = c[0]; if (c[0] > maxR) maxR = c[0];
      if (c[1] < minG) minG = c[1]; if (c[1] > maxG) maxG = c[1];
      if (c[2] < minB) minB = c[2]; if (c[2] > maxB) maxB = c[2];
    }
    const r = maxR - minR, g = maxG - minG, b = maxB - minB;
    if (r >= g && r >= b) return { ch: 0, span: r };
    if (g >= b) return { ch: 1, span: g };
    return { ch: 2, span: b };
  };

  const buckets = [samples];
  while (buckets.length < targetCount) {
    let bestIdx = -1;
    let bestCh = 0;
    let bestSpan = 0;
    for (let i = 0; i < buckets.length; i++) {
      if (buckets[i].length < 2) continue;
      const { ch, span } = channelRange(buckets[i]);
      if (span > bestSpan) {
        bestSpan = span;
        bestIdx = i;
        bestCh = ch;
      }
    }
    if (bestIdx < 0 || bestSpan < 4) break;
    const b = buckets.splice(bestIdx, 1)[0];
    b.sort((a, c) => a[bestCh] - c[bestCh]);
    const mid = b.length >> 1;
    buckets.push(b.slice(0, mid), b.slice(mid));
  }

  const seen = new Set();
  const out = [];
  buckets.sort((a, b) => b.length - a.length);
  for (const b of buckets) {
    let sr = 0, sg = 0, sb = 0;
    for (let i = 0; i < b.length; i++) { sr += b[i][0]; sg += b[i][1]; sb += b[i][2]; }
    const hex = intToHex(rgbToInt(sr / b.length, sg / b.length, sb / b.length));
    if (!seen.has(hex)) {
      seen.add(hex);
      out.push(hex);
    }
  }
  return out;
}
