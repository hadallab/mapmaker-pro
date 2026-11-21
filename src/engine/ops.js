// Geometry operations on editor objects. Callers wrap them in a document transaction
// and call doc.touch(obj) through the helpers below, so every edit is undoable.

import { KIND_BY_TYPE, LAYER_BY_ID, TEXTURED_TYPES } from './layers.js';
import { unionBounds, rotatePoint, simplifyRing, simplifyToCount, allocatePointBudget, clamp } from './geometry.js';
import { objectBounds, syncDerived, clone } from './document.js';
import { createObject, refreshFoodArea, foodBoxCap, applyLoadQuotas, DEFAULTS } from './dpm.js';
import { bakeSkyInDoc, skyBakeGroupOf } from './bake.js';
import * as shapes from './shapes.js';
import { buildWorldQuery, diagnoseTeleports } from './tester.js';
import { removeSpikes } from './spikes.js';
export { removeSpikes };

// The official NPC picker skips these closed/filled animal states (kept in sync with validate.js).
const NPC_HIDDEN_LEVELS = new Set([51, 65, 84]);

export function selectionBounds(objs, catalog) {
  return unionBounds(objs.map(o => objectBounds(o, catalog)));
}

export function pivotOf(objs, catalog, mode = 'center', doc = null) {
  if (mode === 'world' && doc) return { x: doc.pixelWidth / 2, y: doc.pixelHeight / 2 };
  const b = selectionBounds(objs, catalog);
  if (!b) return { x: 0, y: 0 };
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

export function translate(doc, objs, dx, dy) {
  for (const o of objs) {
    doc.touch(o);
    const kind = KIND_BY_TYPE[o.type];
    if (kind === 'poly') for (const p of o.points) { p.x += dx; p.y += dy; }
    else if (kind === 'rect') { o.position.x += dx; o.position.y += dy; syncDerived(o); }
    else { o.x += dx; o.y += dy; }
  }
}

// Limits a move so a selection that starts inside the world stays inside it.
export function clampDelta(doc, objs, catalog, dx, dy) {
  const b = selectionBounds(objs, catalog);
  if (!b) return { dx, dy };
  const W = doc.pixelWidth, H = doc.pixelHeight;
  if (b.x >= 0 && b.x + b.width <= W) dx = clamp(dx, -b.x, W - b.x - b.width);
  if (b.y >= 0 && b.y + b.height <= H) dy = clamp(dy, -b.y, H - b.y - b.height);
  return { dx, dy };
}

export function rotate(doc, objs, degrees, pivot) {
  const r = degrees * Math.PI / 180;
  const skipped = [];
  for (const o of objs) {
    const kind = KIND_BY_TYPE[o.type];
    if (kind === 'rect') { skipped.push(o); continue; }
    doc.touch(o);
    if (kind === 'poly') o.points = o.points.map(p => rotatePoint(p, pivot.x, pivot.y, r));
    else {
      const p = rotatePoint({ x: o.x, y: o.y }, pivot.x, pivot.y, r);
      o.x = p.x; o.y = p.y;
      o.rotation = normalizeAngle((o.rotation || 0) + degrees);
    }
  }
  return skipped;
}

export function normalizeAngle(a) {
  let v = a % 360;
  if (v > 180) v -= 360;
  if (v <= -180) v += 360;
  return v;
}

export function scale(doc, objs, sx, sy, pivot) {
  for (const o of objs) {
    doc.touch(o);
    const kind = KIND_BY_TYPE[o.type];
    if (kind === 'poly') {
      o.points = o.points.map(p => ({ x: pivot.x + (p.x - pivot.x) * sx, y: pivot.y + (p.y - pivot.y) * sy }));
      if (sx * sy < 0) o.points.reverse();
    } else if (kind === 'rect') {
      const x1 = pivot.x + (o.position.x - pivot.x) * sx;
      const y1 = pivot.y + (o.position.y - pivot.y) * sy;
      const x2 = pivot.x + (o.position.x + o.size.width - pivot.x) * sx;
      const y2 = pivot.y + (o.position.y + o.size.height - pivot.y) * sy;
      o.position = { x: Math.min(x1, x2), y: Math.min(y1, y2) };
      o.size = { width: Math.max(10, Math.abs(x2 - x1)), height: Math.max(10, Math.abs(y2 - y1)) };
      syncDerived(o);
      if (o.type === 'Food') refreshFoodArea(o);
    } else {
      o.x = pivot.x + (o.x - pivot.x) * sx;
      o.y = pivot.y + (o.y - pivot.y) * sy;
    }
  }
}

// Mirror geometry. Sprites cannot be mirrored natively (no flip field), so their
// position mirrors and their rotation is reflected.
export function flip(doc, objs, axis, pivot) {
  for (const o of objs) {
    doc.touch(o);
    const kind = KIND_BY_TYPE[o.type];
    const fx = axis === 'h' ? -1 : 1, fy = axis === 'v' ? -1 : 1;
    if (kind === 'poly') {
      o.points = o.points.map(p => ({ x: pivot.x + (p.x - pivot.x) * fx, y: pivot.y + (p.y - pivot.y) * fy })).reverse();
    } else if (kind === 'rect') {
      if (axis === 'h') o.position.x = 2 * pivot.x - o.position.x - o.size.width;
      else o.position.y = 2 * pivot.y - o.position.y - o.size.height;
      syncDerived(o);
    } else {
      if (axis === 'h') { o.x = 2 * pivot.x - o.x; o.rotation = normalizeAngle(-(o.rotation || 0)); }
      else { o.y = 2 * pivot.y - o.y; o.rotation = normalizeAngle(180 - (o.rotation || 0)); }
    }
  }
}

export function align(doc, objs, catalog, mode, reference) {
  const ref = reference || selectionBounds(objs, catalog);
  for (const o of objs) {
    const b = objectBounds(o, catalog);
    let dx = 0, dy = 0;
    if (mode === 'left') dx = ref.x - b.x;
    if (mode === 'hcenter') dx = ref.x + ref.width / 2 - (b.x + b.width / 2);
    if (mode === 'right') dx = ref.x + ref.width - (b.x + b.width);
    if (mode === 'top') dy = ref.y - b.y;
    if (mode === 'vcenter') dy = ref.y + ref.height / 2 - (b.y + b.height / 2);
    if (mode === 'bottom') dy = ref.y + ref.height - (b.y + b.height);
    if (dx || dy) translate(doc, [o], dx, dy);
  }
}

export function distribute(doc, objs, catalog, axis) {
  if (objs.length < 3) return;
  const items = objs.map(o => ({ o, b: objectBounds(o, catalog) }));
  const key = axis === 'h' ? 'x' : 'y', size = axis === 'h' ? 'width' : 'height';
  items.sort((a, b) => (a.b[key] + a.b[size] / 2) - (b.b[key] + b.b[size] / 2));
  const first = items[0].b[key] + items[0].b[size] / 2;
  const last = items.at(-1).b[key] + items.at(-1).b[size] / 2;
  const step = (last - first) / (items.length - 1);
  items.forEach((it, i) => {
    const d = first + step * i - (it.b[key] + it.b[size] / 2);
    if (d) translate(doc, [it.o], axis === 'h' ? d : 0, axis === 'h' ? 0 : d);
  });
}

export function simplify(doc, objs, epsilon) {
  let removed = 0;
  for (const o of objs) {
    if (KIND_BY_TYPE[o.type] !== 'poly') continue;
    const next = simplifyRing(o.points, epsilon);
    if (next.length < o.points.length) {
      doc.touch(o);
      removed += o.points.length - next.length;
      o.points = next;
    }
  }
  return removed;
}

export function simplifyToCountSelection(doc, objs, totalTarget) {
  const polys = objs.filter(o => KIND_BY_TYPE[o.type] === 'poly');
  if (!polys.length) return 0;
  const alloc = allocatePointBudget(polys.map(o => o.points), totalTarget);
  let removed = 0;
  polys.forEach((o, i) => {
    const next = simplifyToCount(o.points, alloc[i]);
    if (next.length < o.points.length) {
      doc.touch(o);
      removed += o.points.length - next.length;
      o.points = next;
    }
  });
  return removed;
}

export function bakeSkySelection(doc, objs, options) {
  return bakeSkyInDoc(doc, objs, options);
}

export function dedupePoints(doc, o) {
  const out = [];
  for (const p of o.points) {
    const last = out.at(-1);
    if (!last || Math.abs(last.x - p.x) >= 0.001 || Math.abs(last.y - p.y) >= 0.001) out.push(p);
  }
  while (out.length > 3 && Math.abs(out[0].x - out.at(-1).x) < 0.001 && Math.abs(out[0].y - out.at(-1).y) < 0.001) out.pop();
  if (out.length >= 3 && out.length !== o.points.length) { doc.touch(o); o.points = out; }
}

export function clampToWorld(doc, o) {
  const W = doc.pixelWidth, H = doc.pixelHeight;
  doc.touch(o);
  const kind = KIND_BY_TYPE[o.type];
  if (kind === 'poly') {
    // Cut the polygon at the world edge; squashing points onto the edge makes slivers and crossings.
    let pieces = null;
    try {
      pieces = shapes.booleanOp('intersect', o.points, [[{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }]]);
    } catch { pieces = null; }
    if (!pieces) { o.points = o.points.map(p => ({ x: clamp(p.x, 0, W), y: clamp(p.y, 0, H) })); return; }
    if (!pieces.length) { doc.remove(o); return; }
    o.points = pieces[0];
    const index = doc.layers[o.layerId].indexOf(o);
    pieces.slice(1).forEach((pts, k) => {
      const n = clone(o);
      delete n.uid; delete n.sourceId;
      n.points = pts;
      doc.add(n, index + 1 + k);
    });
  } else if (kind === 'rect') {
    const x1 = clamp(o.position.x, 0, W), y1 = clamp(o.position.y, 0, H);
    const x2 = clamp(o.position.x + o.size.width, 0, W), y2 = clamp(o.position.y + o.size.height, 0, H);
    o.position = { x: x1, y: y1 };
    o.size = { width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
    syncDerived(o);
  } else { o.x = clamp(o.x, 0, W); o.y = clamp(o.y, 0, H); }
}

export function reorder(doc, objs, where) {
  const byLayer = new Map();
  for (const o of objs) {
    if (!byLayer.has(o.layerId)) byLayer.set(o.layerId, []);
    byLayer.get(o.layerId).push(o);
  }
  for (const [layerId, group] of byLayer) {
    const list = doc.layers[layerId];
    group.sort((a, b) => list.indexOf(a) - list.indexOf(b));
    if (where === 'front') for (const o of group) doc.reorder(o, list.length - 1);
    else if (where === 'back') for (let i = group.length - 1; i >= 0; i--) doc.reorder(group[i], 0);
    else if (where === 'forward') for (let i = group.length - 1; i >= 0; i--) doc.reorder(group[i], Math.min(list.length - 1, list.indexOf(group[i]) + 1));
    else if (where === 'backward') for (const o of group) doc.reorder(o, Math.max(0, list.indexOf(o) - 1));
  }
}

// Terrain variants share the Ter type; moving between them adjusts the fields the
// official editor attaches per layer.
export function moveTerrainLayer(doc, o, layerId) {
  if (o.type !== 'Ter' || !['terrains', 'islands', 'platforms'].includes(layerId) || o.layerId === layerId) return false;
  doc.relayer(o, layerId);
  o.settings = { ...o.settings, collidable: layerId !== 'platforms' };
  if (layerId === 'terrains' && !o.foodSpawnSettings) o.foodSpawnSettings = clone(DEFAULTS.terrainFood);
  if (layerId !== 'terrains') delete o.foodSpawnSettings;
  return true;
}

// Polygon conversion between layers (e.g. Terrain outline -> Background). Returns the new object.
export function convertPolygon(doc, o, layerId) {
  const layer = LAYER_BY_ID[layerId];
  if (!layer || layer.kind !== 'poly' || KIND_BY_TYPE[o.type] !== 'poly') return null;
  const init = { points: o.points.map(p => ({ ...p })) };
  if (TEXTURED_TYPES.has(o.type) && TEXTURED_TYPES.has(layer.type)) init.texture = o.texture;
  if ((o.type === 'Sky' || o.type === 'Wat') && (layer.type === 'Sky' || layer.type === 'Wat')) init.colors = [...o.colors];
  const next = createObject(layer.type, layerId, init);
  const index = doc.layers[layerId].length;
  doc.remove(o);
  doc.add(next, index);
  return next;
}

export function duplicate(doc, objs, dx = 0, dy = 0) {
  const created = [];
  for (const o of objs) {
    const copy = clone(o);
    delete copy.uid;
    delete copy.sourceId;
    const list = doc.layers[o.layerId];
    doc.add(copy, list.indexOf(o) + 1);
    created.push(copy);
  }
  if (dx || dy) translate(doc, created, dx, dy);
  return created;
}

// Self-crossing outline -> the same filled area as clean polygons (Clipper non-zero union).
function untangleObject(doc, o) {
  const pieces = shapes.untangle(o.points);
  if (!pieces) return;
  doc.touch(o);
  o.points = pieces[0];
  const index = doc.layers[o.layerId].indexOf(o);
  pieces.slice(1).forEach((pts, k) => {
    const n = clone(o);
    delete n.uid; delete n.sourceId;
    n.points = pts;
    doc.add(n, index + 1 + k);
  });
}

// Moves teleport targets that are outside the world, in solid terrain or out of water to the
// nearest open water point with 2 units of room around it (rings up to 60 units away).
export function moveTeleportTargets(doc, trObj) {
  const w = buildWorldQuery(doc);
  const diag = diagnoseTeleports(doc, w);
  const W = doc.pixelWidth, H = doc.pixelHeight;
  const open = (x, y) => x >= 0 && y >= 0 && x <= W && y <= H && w.inWater(x, y) && !w.isSolid(x, y);
  const roomy = (x, y) => open(x, y) && [0, 1, 2, 3, 4, 5, 6, 7].every(
    k => open(x + Math.cos(k * Math.PI / 4) * 20, y + Math.sin(k * Math.PI / 4) * 20)
  );
  let moved = 0;
  for (const t of trObj.triggers || []) {
    for (const a of t.actions || []) {
      const f = diag.get(a);
      if (!f || !(f.outOfBounds || f.solid || f.dry)) continue;
      const sx = clamp(a.data.pos.x, 0, W), sy = clamp(a.data.pos.y, 0, H);
      let best = null;
      for (let r = 0; r <= 600 && !best; r += 5) {
        const steps = Math.max(1, Math.round(2 * Math.PI * r / 5));
        for (let k = 0; k < steps; k++) {
          const x = sx + Math.cos(k / steps * 2 * Math.PI) * r, y = sy + Math.sin(k / steps * 2 * Math.PI) * r;
          if (roomy(x, y)) { best = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 }; break; }
        }
      }
      if (best) { if (!moved) doc.touch(trObj); a.data.pos = best; moved++; }
    }
  }
  return moved;
}

export function applyFix(doc, catalog, issue) {
  const o = issue.uid != null ? doc.get(issue.uid) : null;
  switch (issue.fix) {
    case 'clampToWorld': if (o) clampToWorld(doc, o); break;
    case 'dedupePoints': if (o) dedupePoints(doc, o); break;
    case 'defaultTexture': if (o) { doc.touch(o); o.texture = catalog.textures[0].id; } break;
    case 'fixColors': if (o) {
      doc.touch(o);
      const base = o.type === 'Sky' ? DEFAULTS.skyColors : DEFAULTS.water.colors;
      o.colors = o.colors?.length === 1 ? [o.colors[0], o.colors[0]] : base.map(c => parseInt(c.slice(1), 16));
    } break;
    case 'solidColor': if (o) { doc.touch(o); o.colors = [o.colors[0], o.colors[0]]; } break;
    case 'bakeSky':
      // Touching skies with the same stops bake together so their edges match.
      if (o && o.type === 'Sky') bakeSkyInDoc(doc, skyBakeGroupOf(doc, o).members, { bands: 16, overlap: 1, seamLift: 0.6 });
      break;
    case 'moveToPlatforms': if (o) moveTerrainLayer(doc, o, 'platforms'); break;
    case 'deleteDuplicate': if (o) doc.remove(o); break;
    case 'defaultOpacity': if (o) { doc.touch(o); o.opacity = DEFAULTS.opacity; } break;
    case 'capFoodBox': if (o) { doc.touch(o); o.settings.count = foodBoxCap(o); } break;
    case 'deleteObject': if (o) doc.remove(o); break;
    case 'untangle': if (o) untangleObject(doc, o); break;
    case 'removeSpikes': if (o) { doc.touch(o); o.points = removeSpikes(o.points); } break;
    case 'dropUnknownFood':
      if (o) { doc.touch(o); o.settings.foodIds = (o.settings.foodIds || []).filter(id => catalog.foodById.has(Number(id))); }
      break;
    case 'dropBadNpcLevels':
      if (o) {
        doc.touch(o);
        o.settings.fishLevels = (o.settings.fishLevels || []).filter(l => catalog.animalByLevel.has(Number(l)) && !NPC_HIDDEN_LEVELS.has(Number(l)));
      }
      break;
    case 'capNpcCount': if (o) { doc.touch(o); o.settings.animalCount = 100; } break;
    case 'moveTeleports': if (o) moveTeleportTargets(doc, o); break;
    case 'trimQuotas': {
      const spawns = [...doc.layers['food-spawns'], ...doc.layers['npc-spawns']];
      spawns.forEach(s => doc.touch(s));
      applyLoadQuotas(doc.worldSize, spawns);
      break;
    }
    default: return false;
  }
  return true;
}

// ---- shape operations (see shapes.js) ----

// The first object keeps its layer, texture and settings; results replace every input.
export function booleanSelection(doc, objs, op) {
  const polys = objs.filter(o => KIND_BY_TYPE[o.type] === 'poly');
  if (polys.length < 2) throw new Error('Select at least two polygons');
  const [base, ...rest] = polys;
  const results = shapes.booleanOp(op, base.points, rest.map(o => o.points));
  const index = doc.layers[base.layerId].indexOf(base);
  const template = clone(base);
  for (const o of polys) doc.remove(o);
  return results.map((pts, i) => {
    const o = clone(template);
    delete o.uid; delete o.sourceId;
    o.points = pts;
    return doc.add(o, index + i);
  });
}

// distance in file pixels. target: 'replace', or a polygon layer id for a new copy.
export function offsetSelection(doc, objs, distance, join, target = 'replace') {
  const polys = objs.filter(o => KIND_BY_TYPE[o.type] === 'poly');
  const made = [];
  for (const o of polys) {
    const results = shapes.offset([o.points], distance, join);
    if (target === 'replace') {
      const index = doc.layers[o.layerId].indexOf(o);
      const template = clone(o);
      doc.remove(o);
      results.forEach((pts, i) => {
        const n = clone(template);
        delete n.uid; delete n.sourceId;
        n.points = pts;
        made.push(doc.add(n, index + i));
      });
    } else {
      const layer = LAYER_BY_ID[target];
      for (const pts of results) {
        const init = { points: pts };
        if (TEXTURED_TYPES.has(o.type) && TEXTURED_TYPES.has(layer.type)) init.texture = o.texture;
        made.push(doc.add(createObject(layer.type, target, init)));
      }
    }
  }
  return made;
}

export function smoothSelection(doc, objs, iterations, amount) {
  let added = 0;
  for (const o of objs) {
    if (KIND_BY_TYPE[o.type] !== 'poly') continue;
    doc.touch(o);
    const before = o.points.length;
    o.points = shapes.smooth(o.points, iterations, amount);
    added += o.points.length - before;
  }
  return added;
}

export function cutFrameSelection(doc, objs, { side = 'left', slitWidth = 0.1 } = {}) {
  const polys = objs.filter(o => KIND_BY_TYPE[o.type] === 'poly');
  if (polys.length !== 2) throw new Error('Select the outer frame polygon first and the inner cutout polygon second');
  const [outer, inner] = polys;
  const results = shapes.bridgeHole(outer.points, inner.points, { side, slitWidth });
  if (!results.length) throw new Error('Outer polygon is completely covered by the inner polygon (select the outer frame first)');
  const list = doc.layers[outer.layerId];
  const outerIdx = list.indexOf(outer);
  const innerIdx = inner.layerId === outer.layerId ? list.indexOf(inner) : -1;
  const index = innerIdx >= 0 && innerIdx < outerIdx ? outerIdx - 1 : outerIdx;
  const template = clone(outer);
  doc.remove(outer);
  doc.remove(inner);
  return results.map((pts, i) => {
    const o = clone(template);
    delete o.uid; delete o.sourceId;
    o.points = pts;
    return doc.add(o, index + i);
  });
}
