import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MapDocument, spriteSize, spriteCorners } from '../src/engine/document.js';
import { TOOL } from '../src/engine/layers.js';
import { parseDpm, importMap, exportMap, serializeDpm, createObject, foodBudget, totalFood } from '../src/engine/dpm.js';
import { buildCatalog } from '../src/engine/catalog.js';
import { validate } from '../src/engine/validate.js';
import {
  limitDecimals,
  bounds,
  signedArea,
  simplifyRing,
  simplifyToCount,
  allocatePointBudget,
  selfIntersections,
  makeBrighter
} from '../src/engine/geometry.js';
import { booleanOp, bridgeHole } from '../src/engine/shapes.js';
import { bakeSkyGradient, bakeSkyInDoc, skyBakeGroups } from '../src/engine/bake.js';
import {
  THIN_SKY_MIN_PX,
  testerGradientColors,
  hasExtraGradientStops,
  isThinTwoStopSky,
  gradientTopSeam,
  findDuplicateContours,
  diagnoseTeleports,
  teleportActionSummary
} from '../src/engine/tester.js';
import * as ops from '../src/engine/ops.js';
import { EditorMeta, objectSignature, reattachSidecar } from '../src/ui/meta.js';
import {
  createContourBoundsCache,
  findSnapTarget,
  findContourHit,
  locatePointOnRing,
  traceRingSegment,
  segmentMetrics,
  findSharedVertices,
  findSharedVerticesBatch,
  simplifyRingPinned,
  previewSimplifyKeepingShared,
  simplifyKeepingShared
} from '../src/engine/contour.js';
import {
  BG_ALLOWED_OPACITIES,
  collectSelectionColors,
  replaceSelectionColor,
  collectPaletteTargets,
  transformColor,
  computeAtmospherePreview,
  applyAtmosphereAdjust,
  computeBgDepthSteps,
  orderBgObjects,
  compoundedOpacity,
  stepBgDepthOpacities,
  extractPaletteFromPixels
} from '../src/engine/palette.js';
import {
  slicePolygon,
  slicePolygonDetailed,
  slicePolygonsInDoc,
  selectKnifeTargets,
  computeCutIntersections,
  bevelPolygonVertices,
  bevelSelectionPoints,
  bridgeAllHoles
} from '../src/engine/knife.js';
import {
  matchesSurfaceFilter,
  nearestSurfacePoint,
  computePlacement,
  scatterStroke,
  findHideSpacesInRadius,
  reseatHideSpaces,
  hideSpaceOpacityWarns
} from '../src/engine/scatter.js';

globalThis.self = globalThis;
globalThis.window = globalThis.window || {};
await import('../src/vendor/clipper.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const catalog = buildCatalog(JSON.parse(fs.readFileSync(path.join(here, '..', 'src', 'data', 'catalog.json'), 'utf8')));

function sampleMaps() {
  const dirs = [
    path.join(root, 'ffa', 'favorites-study-2026-10-23', 'sources'),
    path.join(root, 'pd', 'favorites-study-2026-10-23', 'sources'),
    path.join(root, '1v1', 'favorites-study-2026-10-22', 'sources')
  ];
  const files = [];
  for (const d of dirs) if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) if (f.endsWith('.dpm')) files.push(path.join(d, f));
  return files;
}

function loadDoc(json) {
  const doc = new MapDocument();
  const result = importMap(json, { applyQuotas: false });
  doc.load(result);
  return { doc, result };
}

// Field-level comparison that ignores ids (the official editor renumbers on import)
// and numeric-string differences the editor normalises.
function canonical(o) {
  const c = JSON.parse(JSON.stringify(o));
  delete c.id;
  const round = v => typeof v === 'number' ? limitDecimals(v, 3) : v;
  const walk = x => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)]));
    if (typeof x === 'string' && x.trim() !== '' && !isNaN(x) && !x.startsWith('#')) return round(Number(x));
    return round(x);
  };
  return walk(c);
}

// Keys each official class writes in toJsonObject (id removed by canonical()).
const BASE = ['type', 'layerId'];
const NATIVE_KEYS = {
  Ter: [...BASE, 'points', 'texture', 'foodSpawnSettings', 'settings'],
  Bg: [...BASE, 'points', 'texture', 'settings', 'opacity'],
  C: [...BASE, 'points', 'texture', 'settings'],
  Air: [...BASE, 'points', 'texture', 'settings', 'borderColor'],
  Sky: [...BASE, 'points', 'settings', 'colors'],
  Wat: [...BASE, 'points', 'settings', 'colors', 'hasBorder'],
  Cu: [...BASE, 'points', 'settings'],
  Hab: [...BASE, 'points', 'position', 'size', 'settings'],
  Food: [...BASE, 'points', 'position', 'size', 'settings'],
  NPC: [...BASE, 'points', 'position', 'size', 'settings'],
  Tr: [...BASE, 'points', 'position', 'size', 'triggers'],
  H: [...BASE, 'x', 'y', 'rotation', 'hSType', 'opacity'],
  A: [...BASE, 'x', 'y', 'rotation', 'fLevel'],
  P: [...BASE, 'x', 'y', 'rotation', 'pType', 'params']
};

test('engine helpers match the official implementation', () => {
  assert.equal(limitDecimals(1.23456, 3), 1.235);
  assert.equal(limitDecimals(1e-7, 3), 0);
  assert.equal(limitDecimals(-2.0005, 3), -2);
  assert.equal(makeBrighter(0x003a62, 1.75), parseInt('0065ab', 16));
});

test('every reference DPM round-trips field-for-field', () => {
  const files = sampleMaps();
  assert.ok(files.length >= 5, 'reference maps found');
  for (const file of files) {
    const json = parseDpm(fs.readFileSync(file, 'utf8'));
    const { doc } = loadDoc(json);
    const out = exportMap(doc);
    const expected = json.screenObjects.filter(o => o && o.layerId !== undefined);
    // the editor groups by layer, keeping file order within each layer
    const order = ['habitats', 'triggers', 'npc-spawns', 'food-spawns', 'currents', 'ceilings', 'terrains', 'islands', 'animals', 'props', 'platforms', 'hide-spaces', 'air-pockets', 'background-terrains', 'water', 'sky'];
    const relayer = o => (o.type === 'Ter' && o.layerId === 'terrains' && o.settings && !o.settings.collidable) ? 'platforms' : o.layerId;
    const grouped = order.flatMap(l => expected.filter(o => relayer(o) === l));
    assert.equal(out.screenObjects.length, grouped.length, path.basename(file) + ' object count');
    for (let i = 0; i < grouped.length; i++) {
      const a = canonical(out.screenObjects[i]), src = { ...grouped[i], layerId: relayer(grouped[i]) };
      const b = canonical(src);
      if (b.type === 'Sky' || b.type === 'Wat') b.colors = grouped[i].colors.map(c => typeof c === 'string' ? parseInt(c.slice(1), 16) : c);
      if (b.type === 'H' && b.opacity === 1) delete b.opacity;
      if (b.type === 'Food') {
        const s = grouped[i].size, area = Number(s.width) * Number(s.height) / 100;
        b.settings.area = limitDecimals(area, 3);
        b.settings.count = Math.floor(Math.min(Math.max(40, area / 12.3), Number(grouped[i].settings.count)));
      }
      if (b.type === 'NPC' && b.settings.restrictMovement === undefined) b.settings.restrictMovement = false;
      if (b.position && b.size) {
        const { x, y } = b.position, { width: w, height: h } = b.size;
        b.points = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }].map(p => ({ x: limitDecimals(p.x, 3), y: limitDecimals(p.y, 3) }));
      }
      // fields the official classes never serialize (written by third-party generators) are dropped
      for (const k of Object.keys(b)) if (!NATIVE_KEYS[b.type].includes(k)) delete b[k];
      assert.deepEqual(Object.keys(a), Object.keys(b), path.basename(file) + ' key order #' + grouped[i].id);
      assert.deepEqual(a, b, path.basename(file) + ' object #' + grouped[i].id);
    }
    assert.equal(Number(out.worldSize.width), Number(json.worldSize.width));
  }
});

test('reference maps produce no compatibility errors', () => {
  for (const file of sampleMaps()) {
    const { doc } = loadDoc(parseDpm(fs.readFileSync(file, 'utf8')));
    const errors = validate(doc, catalog).filter(i => i.severity === 'error');
    assert.deepEqual(errors.map(e => e.message), [], path.basename(file));
  }
});

test('import trims spawn counts like the official editor', () => {
  const json = {
    worldSize: { width: 20, height: 20 }, settings: { gravity: 9.8 },
    screenObjects: [
      { id: 1, type: 'Food', layerId: 'food-spawns', points: [], position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, settings: { foodIds: [1], count: 30, firstSpawnMs: 0, reSpawnMs: 1000, area: 100, onlyOnWater: false } },
      { id: 2, type: 'Food', layerId: 'food-spawns', points: [], position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, settings: { foodIds: [1], count: 30, firstSpawnMs: 0, reSpawnMs: 1000, area: 100, onlyOnWater: false } }
    ]
  };
  const r = importMap(json);
  const budget = foodBudget(r.worldSize);
  const total = r.objects.reduce((s, o) => s + o.settings.count, 0);
  assert.ok(total <= budget, `total ${total} within ${budget}`);
  assert.deepEqual(r.objects.map(o => o.settings.count), [30 - Math.ceil((60 - budget) / 2), 30 - Math.ceil((60 - budget) / 2)]);
});

test('history restores order across multi-object edits', () => {
  const doc = new MapDocument({ width: 50, height: 50 });
  const tx0 = doc.begin('seed');
  const objs = [0, 1, 2, 3, 4].map(i => doc.add(createObject('Ter', 'terrains', { points: [{ x: i, y: 0 }, { x: i + 5, y: 0 }, { x: i, y: 5 }] })));
  tx0.commit();
  const tx = doc.begin('mixed');
  doc.remove(objs[1]);
  ops.translate(doc, [objs[3]], 10, 10);
  ops.reorder(doc, [objs[0]], 'front');
  tx.commit();
  const after = doc.layers.terrains.map(o => o.uid);
  doc.history.undo();
  assert.deepEqual(doc.layers.terrains.map(o => o.uid), objs.map(o => o.uid));
  assert.equal(doc.layers.terrains[3].points[0].x, 3);
  doc.history.redo();
  assert.deepEqual(doc.layers.terrains.map(o => o.uid), after);
  assert.equal(doc.get(objs[3].uid).points[0].x, 13);
});

test('geometry utilities', () => {
  const ring = [];
  for (let i = 0; i < 100; i++) ring.push({ x: Math.cos(i / 100 * Math.PI * 2) * 100, y: Math.sin(i / 100 * Math.PI * 2) * 100 });
  const s = simplifyRing(ring, 2);
  assert.ok(s.length < 40 && s.length >= 3);
  assert.deepEqual(selfIntersections(ring), []);
  const bow = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
  assert.equal(selfIntersections(bow).length, 1);
});

test('new objects export with the native field layout', () => {
  const doc = new MapDocument({ width: 30, height: 30 });
  const tx = doc.begin('make');
  const sq = [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 60 }, { x: 10, y: 60 }];
  doc.add(createObject('Ter', 'terrains', { points: sq, texture: 5 }));
  doc.add(createObject('Ter', 'platforms', { points: sq, texture: 5 }));
  doc.add(createObject('Wat', 'water', { points: sq }));
  doc.add(createObject('H', 'hide-spaces', { x: 5, y: 5, hSType: 28 }));
  doc.add(createObject('Food', 'food-spawns', { position: { x: 1, y: 1 }, size: { width: 50, height: 50 }, settings: { foodIds: [1], count: 10 } }));
  tx.commit();
  const out = exportMap(doc).screenObjects;
  assert.deepEqual(Object.keys(out[0]), ['id', 'type', 'layerId', 'points', 'position', 'size', 'settings']);
  const ter = out.find(o => o.layerId === 'terrains');
  assert.deepEqual(Object.keys(ter), ['id', 'type', 'layerId', 'points', 'texture', 'foodSpawnSettings', 'settings']);
  const plat = out.find(o => o.layerId === 'platforms');
  assert.deepEqual(plat.settings, { collidable: false });
  assert.equal(plat.foodSpawnSettings, undefined);
  const wat = out.find(o => o.type === 'Wat');
  assert.deepEqual(wat.colors, [0x003a62, 0x031d30]);
  const h = out.find(o => o.type === 'H');
  assert.deepEqual(Object.keys(h), ['id', 'type', 'layerId', 'x', 'y', 'rotation', 'hSType']);
  assert.ok(totalFood(doc) === 10);
});

const rectPts = (x, y, w, h) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h }
];

test('bake.js slices multi-stop Sky into tester-safe 2-stop bands and refuses Wat', () => {
  const wat = createObject('Wat', 'water', { points: rectPts(0, 0, 200, 100), colors: [0x112233, 0x223344, 0x334455] });
  const watRes = bakeSkyGradient(wat);
  assert.equal(watRes.ok, false);
  assert.match(watRes.error, /water|black/i);
  assert.equal(watRes.objects.length, 0);

  // Tall 3-stop Sky -> 4 consecutive 2-stop bands
  const tallSky = createObject('Sky', 'sky', {
    points: rectPts(0, 0, 200, 200),
    colors: [0x000000, 0x808080, 0xffffff]
  });
  const tallRes = bakeSkyGradient(tallSky, { bands: 4, overlap: 0, seamLift: 0 });
  assert.equal(tallRes.ok, true);
  assert.equal(tallRes.objects.length, 4);
  assert.deepEqual(tallRes.objects[0].colors, [0x000000, 0x404040]);
  assert.deepEqual(tallRes.objects[1].colors, [0x404040, 0x808080]);
  assert.deepEqual(tallRes.objects[2].colors, [0x808080, 0xc0c0c0]);
  assert.deepEqual(tallRes.objects[3].colors, [0xc0c0c0, 0xffffff]);

  // Thin bands (< 1.5 file px) become solid [c, c] so nothing renders black in tester
  const shortSky = createObject('Sky', 'sky', {
    points: rectPts(0, 0, 200, 4),
    colors: [0x000000, 0xffffff]
  });
  const shortRes = bakeSkyGradient(shortSky, { bands: 4, overlap: 0 });
  assert.equal(shortRes.ok, true);
  assert.equal(shortRes.objects.length, 4);
  for (const b of shortRes.objects) {
    assert.equal(b.colors.length, 2);
    assert.equal(b.colors[0], b.colors[1]);
  }

  // 10 px bands stay 2-stop gradients
  const midSky = createObject('Sky', 'sky', {
    points: rectPts(0, 0, 200, 40),
    colors: [0x000000, 0xffffff]
  });
  const midRes = bakeSkyGradient(midSky, { bands: 4, overlap: 0 });
  assert.equal(midRes.ok, true);
  for (const b of midRes.objects) assert.notEqual(b.colors[0], b.colors[1]);

  // Seam-lift + overlap + transactional doc replacement + undo/redo
  const doc = new MapDocument({ width: 20, height: 20 });
  let firstSky, targetSky, lastSky;
  const tx0 = doc.begin('seed sky');
  firstSky = doc.add(createObject('Sky', 'sky', { points: rectPts(0, 0, 10, 20), colors: [0x111111, 0x111111] }));
  targetSky = doc.add(createObject('Sky', 'sky', { points: rectPts(0, 0, 200, 200), colors: [0x000000, 0x555555, 0xffffff] }));
  lastSky = doc.add(createObject('Sky', 'sky', { points: rectPts(190, 0, 10, 20), colors: [0x222222, 0x222222] }));
  tx0.commit();
  const beforeDpm = serializeDpm(doc);

  const tx1 = doc.begin('bake');
  const { created, errors } = bakeSkyInDoc(doc, [targetSky], { bands: 4, overlap: 1, seamLift: 0.6 });
  tx1.commit();
  assert.deepEqual(errors, []);
  assert.equal(created.length, 4);
  assert.equal(doc.layers.sky[0].uid, firstSky.uid);
  assert.equal(doc.layers.sky.at(-1).uid, lastSky.uid);
  assert.equal(bounds(created[0].points).y, 0);
  assert.equal(bounds(created[0].points).height, 51);
  assert.equal(bounds(created[1].points).y, 49.4);
  assert.equal(bounds(created[2].points).y, 99.4);
  assert.equal(bounds(created[3].points).y, 149.4);
  assert.equal(gradientTopSeam(created[1]).flatTopEdges.length, 0);

  const issuesAfter = validate(doc, catalog);
  assert.equal(issuesAfter.filter(i => i.code === 'tester-colors' || i.code === 'tester-thin-sky').length, 0);

  doc.history.undo();
  assert.equal(serializeDpm(doc), beforeDpm);
});

test('simplifyToCount reduces vertex count while preserving ring validity', () => {
  const circle = Array.from({ length: 100 }, (_, i) => ({
    x: 100 + Math.cos(i / 100 * Math.PI * 2) * 80,
    y: 100 + Math.sin(i / 100 * Math.PI * 2) * 80
  }));
  const decimated = simplifyToCount(circle, 12);
  assert.equal(decimated.length, 12);
  assert.deepEqual(selfIntersections(decimated), []);

  // Concave U-shape with narrow gap where naive removal would cross opposite wall
  const uShape = [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 80, y: 100 },
    { x: 80, y: 20 }, { x: 75, y: 19.5 }, { x: 50, y: 19.2 }, { x: 25, y: 19.5 },
    { x: 20, y: 20 }, { x: 20, y: 100 }, { x: 10, y: 100 }, { x: 0, y: 100 }
  ];
  const uSimplified = simplifyToCount(uShape, 6);
  assert.ok(uSimplified.length >= 6 && uSimplified.length <= uShape.length);
  assert.deepEqual(selfIntersections(uSimplified), []);
  assert.ok(Math.abs(signedArea(uSimplified)) > 0);

  assert.equal(simplifyToCount(circle.slice(0, 10), 2).length, 3);
  assert.equal(simplifyToCount(circle.slice(0, 10), 20).length, 10);
  assert.deepEqual(allocatePointBudget([circle, circle.slice(0, 20)], 24), [18, 6]);

  const doc = new MapDocument({ width: 20, height: 20 });
  const tx0 = doc.begin('seed');
  const ter = doc.add(createObject('Ter', 'terrains', { points: circle, texture: 5 }));
  tx0.commit();
  const tx1 = doc.begin('simplify to count');
  const removed = ops.simplifyToCountSelection(doc, [ter], 15);
  tx1.commit();
  assert.equal(removed, 85);
  assert.equal(ter.points.length, 15);
  doc.history.undo();
  assert.equal(doc.get(ter.uid).points.length, 100);
});

test('bridgeHole cuts a single-ring arena frame through a hairline side-wall slit', () => {
  const outer = rectPts(0, 0, 200, 200);
  const inner = rectPts(20, 20, 160, 160);

  // Standard subtract bridges holes into 1 hole-free polygon via bridgeAllHoles
  const subBridged = booleanOp('subtract', outer, [inner]);
  assert.equal(subBridged.length, 1);
  assert.deepEqual(selfIntersections(subBridged[0]), []);

  // bridgeHole (left wall default) produces ONE single polygon
  const leftRes = bridgeHole(outer, inner);
  assert.equal(leftRes.length, 1);
  const ringL = leftRes[0];
  assert.deepEqual(selfIntersections(ringL), []);
  // Top ceiling (y=0) and bottom floor (y=200) and right wall (x=200) have no midpoint cuts
  assert.equal(ringL.filter(p => p.y === 0).length, 2);
  assert.equal(ringL.filter(p => p.y === 200).length, 2);
  assert.equal(ringL.filter(p => p.x === 200).length, 2);
  // Left wall (x=0) has 4 vertices around the hairline slit at y = 100 +/- 0.05
  const leftWallYs = ringL.filter(p => p.x === 0).map(p => p.y).sort((a, b) => a - b);
  assert.deepEqual(leftWallYs, [0, 99.95, 100.05, 200]);

  // Right wall cut with custom slitWidth
  const rightRes = bridgeHole(outer, inner, { side: 'right', slitWidth: 0.2 });
  assert.equal(rightRes.length, 1);
  const ringR = rightRes[0];
  assert.equal(ringR.filter(p => p.x === 0).length, 2);
  const rightWallYs = ringR.filter(p => p.x === 200).map(p => p.y).sort((a, b) => a - b);
  assert.deepEqual(rightWallYs, [0, 99.9, 100.1, 200]);

  // ops.cutFrameSelection replaces outer & inner and is undoable
  const doc = new MapDocument({ width: 20, height: 20 });
  const tx0 = doc.begin('seed frame');
  const oObj = doc.add(createObject('Ter', 'terrains', { points: outer, texture: 5 }));
  const iObj = doc.add(createObject('Ter', 'terrains', { points: inner, texture: 5 }));
  tx0.commit();
  const tx1 = doc.begin('cut frame');
  const made = ops.cutFrameSelection(doc, [oObj, iObj], { side: 'left', slitWidth: 0.1 });
  tx1.commit();
  assert.equal(made.length, 1);
  assert.equal(doc.layers.terrains.length, 1);
  doc.history.undo();
  assert.equal(doc.layers.terrains.length, 2);
});

test('tester parity helpers and physics/geometry/teleport validation checks', () => {
  // testerGradientColors & hasExtraGradientStops
  assert.deepEqual(testerGradientColors({ colors: [0x112233, 0x445566, 0x778899] }), [0x112233, 0x445566]);
  assert.deepEqual(testerGradientColors({ colors: [0x112233] }), [0x112233, 0x112233]);
  assert.equal(hasExtraGradientStops({ type: 'Sky', colors: [1, 2, 3] }), true);
  assert.equal(hasExtraGradientStops({ type: 'Sky', colors: [1, 2] }), false);

  // isThinTwoStopSky
  const thinTwoColor = { type: 'Sky', points: rectPts(0, 0, 100, 1), colors: [0xff0000, 0x0000ff] };
  const thinSolid = { type: 'Sky', points: rectPts(0, 0, 100, 1), colors: [0xff0000, 0xff0000] };
  const tallTwoColor = { type: 'Sky', points: rectPts(0, 0, 100, 1.6), colors: [0xff0000, 0x0000ff] };
  assert.equal(isThinTwoStopSky(thinTwoColor), true);
  assert.equal(isThinTwoStopSky(thinSolid), false);
  assert.equal(isThinTwoStopSky(tallTwoColor), false);

  // gradientTopSeam
  const seamFlat = gradientTopSeam({ type: 'Sky', points: rectPts(0, 20, 100, 60), colors: [0x112233, 0x445566] });
  assert.equal(seamFlat.top, 20);
  assert.equal(seamFlat.flatTopEdges.length, 1);

  // validate: duplicate-contour, micro-terrain, edge-reversal, teleport-solid, teleport-dry, teleport-loop
  const doc = new MapDocument({ width: 20, height: 20 });
  const tx = doc.begin('populate checks');
  // Main water body on left half only (x: 0..100, y: 0..200)
  doc.add(createObject('Wat', 'water', { points: rectPts(0, 0, 100, 200) }));
  // Solid terrain at 10,10..60,60 and a duplicate with reversed winding & rotated start on islands
  const sq = rectPts(10, 10, 50, 50);
  doc.add(createObject('Ter', 'terrains', { points: sq, texture: 5 }));
  const dupTer = doc.add(createObject('Ter', 'islands', { points: [sq[2], sq[1], sq[0], sq[3]], texture: 5 }));
  // Micro-terrain on terrains: 4x4 px = 16 px^2 = 0.16 u^2 (< 0.25 u^2)
  const microTer = doc.add(createObject('Ter', 'terrains', { points: rectPts(70, 10, 4, 4), texture: 5 }));
  // Backtracking 180-deg edge on terrain
  doc.add(createObject('Ter', 'terrains', {
    points: [{ x: 10, y: 100 }, { x: 60, y: 100 }, { x: 25, y: 100 }, { x: 60, y: 140 }, { x: 10, y: 140 }],
    texture: 5
  }));
  // Multi-stop Sky
  const multiSky = doc.add(createObject('Sky', 'sky', { points: rectPts(0, 0, 200, 200), colors: [0x112233, 0x445566, 0x778899] }));
  // Triggers:
  // Tr1 at (10, 70..20, 80) -> teleports into solid terrain (25, 25), dry area (150, 50), and into Tr2 (15, 165)
  doc.add(createObject('Tr', 'triggers', {
    position: { x: 10, y: 70 }, size: { width: 10, height: 10 },
    triggers: [{
      when: 1, delay: 0,
      actions: [
        { type: 1, data: { pos: { x: 25, y: 25 } } },
        { type: 1, data: { pos: { x: 150, y: 50 } } },
        { type: 1, data: { pos: { x: 15, y: 165 } } }
      ]
    }]
  }));
  // Tr2 at (10, 160..20, 170) -> teleports back into Tr1 (15, 75), forming an A->B->A instant loop
  doc.add(createObject('Tr', 'triggers', {
    position: { x: 10, y: 160 }, size: { width: 10, height: 10 },
    triggers: [{
      when: 1, delay: 0,
      actions: [{ type: 1, data: { pos: { x: 15, y: 75 } } }]
    }]
  }));
  tx.commit();

  const issues = validate(doc, catalog);
  const byCode = code => issues.filter(i => i.code === code);
  assert.equal(byCode('duplicate-contour').length, 1);
  assert.equal(byCode('duplicate-contour')[0].uid, dupTer.uid);
  assert.equal(byCode('duplicate-contour')[0].fix, 'deleteDuplicate');
  assert.equal(byCode('micro-terrain').length, 1);
  assert.equal(byCode('micro-terrain')[0].uid, microTer.uid);
  assert.equal(byCode('micro-terrain')[0].fix, 'moveToPlatforms');
  assert.equal(byCode('edge-reversal').length, 1);
  assert.equal(byCode('teleport-solid').length, 1);
  assert.equal(byCode('teleport-dry').length, 1);
  assert.equal(byCode('teleport-loop').length, 2);
  assert.equal(byCode('tester-colors').length, 1);
  assert.equal(byCode('tester-colors')[0].uid, multiSky.uid);
  assert.equal(byCode('tester-colors')[0].fix, 'bakeSky');

  const diag = diagnoseTeleports(doc);
  const summaries = [...diag.values()].map(teleportActionSummary);
  assert.ok(summaries.some(s => s.includes('Inside solid terrain')));
  assert.ok(summaries.some(s => s.includes('Outside water')));
  assert.ok(summaries.some(s => s.includes('Teleport loop')));

  // Applying fixes clears micro-terrain, duplicate-contour, and tester-colors
  const txFix = doc.begin('apply fixes');
  ops.applyFix(doc, catalog, byCode('micro-terrain')[0]);
  ops.applyFix(doc, catalog, byCode('duplicate-contour')[0]);
  ops.applyFix(doc, catalog, byCode('tester-colors')[0]);
  txFix.commit();

  assert.equal(microTer.layerId, 'platforms');
  assert.equal(microTer.settings.collidable, false);
  assert.equal(doc.get(dupTer.uid), null);
  const afterFix = validate(doc, catalog);
  assert.equal(afterFix.filter(i => ['micro-terrain', 'duplicate-contour', 'tester-colors'].includes(i.code)).length, 0);
});

test('smart sidecar re-attach restores names, groups, twins, blocks and reference across external edits', () => {
  const polyA = createObject('Ter', 'terrains', { points: [{ x: 10.1234, y: 20.00001 }, { x: 40, y: 20 }, { x: 25, y: 50 }] });
  const polyB = createObject('Ter', 'terrains', { points: [{ x: 10.123, y: 20 }, { x: 40, y: 20 }, { x: 25, y: 50 }] });
  assert.equal(objectSignature(polyA), objectSignature(polyB));

  const sprA = createObject('H', 'hide-spaces', { x: 10, y: 20, rotation: -90, hSType: 1 });
  const sprB = createObject('H', 'hide-spaces', { x: 10, y: 20, rotation: 270, hSType: 1 });
  assert.equal(objectSignature(sprA), objectSignature(sprB));

  const makeMockEd = doc => ({
    doc,
    state: { dirty: false },
    toasts: [],
    emit() {},
    requestRender() {},
    toast(msg, kind) { this.toasts.push({ msg, kind }); }
  });

  const doc1 = new MapDocument({ width: 20, height: 20 });
  const tx1 = doc1.begin('seed doc1');
  const a = doc1.add(createObject('Ter', 'terrains', { points: rectPts(10, 10, 20, 20) }));
  const b = doc1.add(createObject('Ter', 'terrains', { points: rectPts(40, 10, 20, 20) }));
  const c = doc1.add(createObject('Ter', 'terrains', { points: rectPts(70, 10, 20, 20) }));
  const d = doc1.add(createObject('Ter', 'terrains', { points: rectPts(110, 10, 20, 20) }));
  const h1 = doc1.add(createObject('H', 'hide-spaces', { x: 50, y: 50, rotation: 0, hSType: 1 }));
  const h2 = doc1.add(createObject('H', 'hide-spaces', { x: 50, y: 50, rotation: 0, hSType: 1 }));
  tx1.commit();

  const ed1 = makeMockEd(doc1);
  const meta1 = new EditorMeta(ed1);
  meta1.setName(a, 'Left wall');
  meta1.setName(h1, 'First anemone');
  meta1.setName(h2, 'Second anemone');
  meta1.group([a, b, c]);
  meta1.twins.set(c.uid, d.uid);
  meta1.twins.set(d.uid, c.uid);
  meta1.blocks = [{ x: 50, y: 50, rotation: 15, solid: true }];
  meta1.reference = { name: 'ref.png', x: 0, y: 0, width: 100, height: 100, opacity: 0.5, above: true, visible: true };

  const staleSidecar = meta1.toStaleSidecar();
  assert.ok(staleSidecar.stale);
  assert.equal(staleSidecar.signatures.length, 6);

  // Doc 2: insert new Ter at index 0 and new H before h1/h2, delete c
  const doc2 = new MapDocument({ width: 20, height: 20 });
  const tx2 = doc2.begin('seed doc2');
  doc2.add(createObject('Ter', 'terrains', { points: rectPts(0, 0, 5, 5) }));
  const a2 = doc2.add(createObject('Ter', 'terrains', { points: rectPts(10, 10, 20, 20) }));
  const b2 = doc2.add(createObject('Ter', 'terrains', { points: rectPts(40, 10, 20, 20) }));
  const d2 = doc2.add(createObject('Ter', 'terrains', { points: rectPts(110, 10, 20, 20) }));
  const hNew = doc2.add(createObject('H', 'hide-spaces', { x: 10, y: 10, rotation: 0, hSType: 1 }));
  const h1b = doc2.add(createObject('H', 'hide-spaces', { x: 50, y: 50, rotation: 0, hSType: 1 }));
  const h2b = doc2.add(createObject('H', 'hide-spaces', { x: 50, y: 50, rotation: 0, hSType: 1 }));
  tx2.commit();

  const ed2 = makeMockEd(doc2);
  const meta2 = new EditorMeta(ed2);
  meta2.fromSidecar(staleSidecar);

  assert.equal(meta2.name(a2), 'Left wall');
  assert.equal(meta2.name(hNew), null);
  assert.equal(meta2.name(h1b), 'First anemone');
  assert.equal(meta2.name(h2b), 'Second anemone');
  assert.ok(meta2.groupOf.has(a2.uid));
  assert.equal(meta2.groupOf.get(a2.uid), meta2.groupOf.get(b2.uid));
  assert.equal(meta2.twins.size, 0, 'broken twin link dropped when c was deleted');
  assert.equal(meta2.blocks.length, 1);
  assert.equal(meta2.reference.name, 'ref.png');
  assert.equal(ed2.toasts.length, 1);
  assert.match(ed2.toasts[0].msg, /Restored names, groups, blocks and reference image/);

  // Zero-match fallback drops all metadata without toast
  const doc3 = new MapDocument({ width: 20, height: 20 });
  const tx3 = doc3.begin('unrelated');
  doc3.add(createObject('Ter', 'terrains', { points: rectPts(150, 150, 30, 30) }));
  tx3.commit();
  const r3 = reattachSidecar(doc3, staleSidecar);
  assert.equal(r3.restored, false);
});

test('layer filter, map palette, habitat compatibility, select similar and style copy/paste', async () => {
  const {
    parseLayerQuery,
    matchesLayerFilter,
    collectMapPalette,
    compatibleAnimalsForHabitat
  } = await import('../src/ui/panels.js');
  const {
    findSimilarTexture,
    findSimilarColor,
    findSimilarAsset,
    findSimilarOpacity,
    findSmallPolygons,
    canCopyStyle,
    extractStyle,
    applyStyleToObject
  } = await import('../src/ui/commands.js');
  const { sampleObjectToBrush } = await import('../src/ui/tools.js');

  const q = parseLayerQuery('deep area<0.1 pts>40');
  assert.equal(q.empty, false);
  assert.deepEqual(q.ops, [
    { field: 'area', op: '<', value: 0.1 },
    { field: 'pts', op: '>', value: 40 }
  ]);
  assert.deepEqual(q.terms, ['deep']);

  const doc = new MapDocument({ width: 20, height: 20 });
  const tx = doc.begin('seed');
  const tinyTer = doc.add(createObject('Ter', 'terrains', { points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }], texture: 5 }));
  const bigTer = doc.add(createObject('Ter', 'terrains', { points: rectPts(0, 0, 20, 20), texture: 19 }));
  const bg5 = doc.add(createObject('Bg', 'background-terrains', { points: rectPts(0, 0, 20, 20), texture: 5, opacity: 0.4 }));
  const sky1 = doc.add(createObject('Sky', 'sky', { points: rectPts(0, 0, 200, 100), colors: [0x112233, 0x445566] }));
  const sky2 = doc.add(createObject('Sky', 'sky', { points: rectPts(0, 100, 200, 100), colors: [0x112233, 0x778899] }));
  const air1 = doc.add(createObject('Air', 'air-pockets', { points: rectPts(10, 10, 20, 20), texture: 5, borderColor: 0x112233 }));
  const hide1 = doc.add(createObject('H', 'hide-spaces', { x: 10, y: 10, hSType: 1, opacity: 0.4 }));
  tx.commit();

  assert.equal(matchesLayerFilter(tinyTer, 'area<0.1', { catalog }), true);
  assert.equal(matchesLayerFilter(bigTer, 'area<0.1', { catalog }), false);
  assert.equal(matchesLayerFilter(tinyTer, 'Deep Ground', { catalog }), true);
  assert.equal(matchesLayerFilter(sky1, '#112233', { catalog }), true);
  assert.equal(matchesLayerFilter(hide1, 'anemone', { catalog }), true);

  // Map palette counts
  assert.deepEqual(collectMapPalette(doc), [
    { hex: '#112233', count: 3 },
    { hex: '#445566', count: 1 },
    { hex: '#778899', count: 1 }
  ]);

  // Select similar helpers
  assert.equal(findSimilarTexture(doc, [tinyTer]).length, 3);
  assert.deepEqual(findSimilarColor(doc, [sky1]), [sky1]);
  assert.deepEqual(findSimilarAsset(doc, [hide1]), [hide1]);
  assert.equal(findSimilarOpacity(doc, [bg5]).length, 2);
  assert.deepEqual(findSmallPolygons(doc, 0.25), [tinyTer]);

  // Eyedropper & Copy/Paste Style
  const mockEd = { state: { brush: {} }, catalog, emit() {} };
  const sampled = sampleObjectToBrush(mockEd, sky1);
  assert.equal(sampled.sampled, true);
  assert.deepEqual(mockEd.state.brush.skyColors, ['#112233', '#445566']);

  assert.equal(canCopyStyle([tinyTer, bg5]), false);
  assert.equal(canCopyStyle([tinyTer, bigTer]), true);
  const style = extractStyle(tinyTer);
  const txStyle = doc.begin('Paste style');
  doc.touch(bigTer);
  applyStyleToObject(bigTer, style, catalog);
  txStyle.commit();
  assert.equal(bigTer.texture, 5);
  doc.history.undo();
  assert.equal(doc.get(bigTer.uid).texture, 19);

  // Habitat animal compatibility
  assert.equal(compatibleAnimalsForHabitat(catalog.animals, 0).length, 0);
  assert.equal(compatibleAnimalsForHabitat(catalog.animals, 63).length, 117);
  const warmShallowSalt = compatibleAnimalsForHabitat(catalog.animals, 38).map(a => a.name);
  assert.ok(warmShallowSalt.includes('shark'));
  assert.ok(warmShallowSalt.includes('killerwhale'));
  assert.ok(!warmShallowSalt.includes('polarbear'));
  assert.ok(!warmShallowSalt.includes('giantsquid'));

  // Command registry & tool shortcuts have no primary key collisions
  const { createCommands } = await import('../src/ui/commands.js');
  const { TOOL_DEFS } = await import('../src/ui/tools.js');
  const cmdEd = {
    doc,
    catalog,
    meta: { symmetry: 'off', blocks: [], groupOf: new Map(), twins: new Map() },
    state: { selection: new Set(), activeLayer: 'terrains', view: { testerPreview: false } },
    selected: () => []
  };
  const cmds = createCommands(cmdEd);
  const requiredIds = [
    'view.testerPreview',
    'shape.cutFrame',
    'edit.copyStyle',
    'edit.pasteStyle',
    'edit.selectSimilarTexture',
    'edit.selectSimilarColor',
    'edit.selectSimilarAsset',
    'edit.selectSimilarOpacity',
    'edit.selectSmallPolygons'
  ];
  for (const id of requiredIds) assert.ok(cmds.get(id), `command ${id} registered`);
  assert.equal(TOOL_DEFS.eyedropper?.key, 'I');

  const seenKeys = new Map();
  for (const [name, def] of Object.entries(TOOL_DEFS)) {
    if (!def.key) continue;
    assert.equal(seenKeys.has(def.key), false, `tool key ${def.key} collision (${name})`);
    seenKeys.set(def.key, 'tool:' + name);
  }
  for (const c of cmds.list) {
    if (!c.keys) continue;
    assert.equal(seenKeys.has(c.keys), false, `command key ${c.keys} collision (${c.id})`);
    seenKeys.set(c.keys, 'cmd:' + c.id);
  }
});

test('bakeSkyGradient handles boundary heights, concave overlap pieces and non-finite points', () => {
  // Float-noisy 1.5 px height (2.502 - 1.002 = 1.4999999999999998) must agree with isThinTwoStopSky.
  const floatThinSky = createObject('Sky', 'sky', {
    points: [{ x: 0, y: 1.002 }, { x: 200, y: 1.002 }, { x: 200, y: 2.502 }, { x: 0, y: 2.502 }],
    colors: [0x000000, 0x808080, 0xffffff]
  });
  const thinBake = bakeSkyGradient(floatThinSky, { bands: 1, overlap: 0, seamLift: 0 });
  assert.equal(thinBake.ok, true);
  assert.equal(isThinTwoStopSky(thinBake.objects[0]), false);
  assert.equal(thinBake.objects[0].colors[0], thinBake.objects[0].colors[1]);

  // Concave Sky sub-piece starting inside overlap zone (pMinY > ys) must keep interpolated colours.
  const concaveSky = createObject('Sky', 'sky', {
    points: [
      { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 75 }, { x: 100, y: 75 },
      { x: 100, y: 50.5 }, { x: 200, y: 50.5 }, { x: 200, y: 100 }, { x: 0, y: 100 }
    ],
    colors: [0x204060, 0x80a0c0]
  });
  const concaveBake = bakeSkyGradient(concaveSky, { bands: 2, overlap: 20, seamLift: 0 });
  assert.equal(concaveBake.ok, true);
  const overlapPiece = concaveBake.objects.find(o => bounds(o.points).y > 50);
  assert.ok(overlapPiece, 'expected sub-piece starting inside overlap zone');
  assert.ok(overlapPiece.colors[1] > 0x507090 && overlapPiece.colors[1] < 0x80a0c0,
    `expected interpolated bottom colour, got 0x${overlapPiece.colors[1].toString(16)}`);

  const nanSky = createObject('Sky', 'sky', {
    points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: Number.NaN, y: 50 }],
    colors: [0x000000, 0xffffff]
  });
  assert.equal(bakeSkyGradient(nanSky).ok, false);
});

test('cutFrameSelection validates selection order and preserves draw slot', () => {
  const doc = new MapDocument({ width: 20, height: 20 });
  const tx0 = doc.begin('seed frame order');
  const first = doc.add(createObject('Ter', 'terrains', { points: rectPts(0, 0, 5, 5), texture: 5 }));
  const inner = doc.add(createObject('Ter', 'terrains', { points: rectPts(20, 20, 160, 160), texture: 5 }));
  const outer = doc.add(createObject('Ter', 'terrains', { points: rectPts(0, 0, 200, 200), texture: 5 }));
  const last = doc.add(createObject('Ter', 'terrains', { points: rectPts(190, 190, 5, 5), texture: 5 }));
  tx0.commit();

  const txBad = doc.begin('bad order');
  assert.throws(() => ops.cutFrameSelection(doc, [inner, outer], { side: 'left', slitWidth: 0.1 }), /outer frame first/i);
  txBad.cancel();
  assert.equal(doc.layers.terrains.length, 4);

  const txGood = doc.begin('good order');
  const made = ops.cutFrameSelection(doc, [outer, inner], { side: 'left', slitWidth: 0.1 });
  txGood.commit();
  assert.equal(made.length, 1);
  assert.deepEqual(doc.layers.terrains.map(o => o.uid), [first.uid, made[0].uid, last.uid]);
});

test('sidecar re-attach, brush sampling and habitat compatibility handle invalid inputs', async () => {
  const { habitatCompatibility } = await import('../src/ui/panels.js');
  const { sampleObjectToBrush } = await import('../src/ui/tools.js');

  const infSprite = createObject('H', 'hide-spaces', { x: 10, y: 20, rotation: Infinity, hSType: 1 });
  assert.equal(objectSignature(infSprite).includes('NaN'), false);

  const docS = new MapDocument({ width: 20, height: 20 });
  const txS = docS.begin('seed sidecar edge');
  const s0 = docS.add(createObject('Ter', 'terrains', { points: rectPts(10, 10, 20, 20) }));
  const s1 = docS.add(createObject('Ter', 'terrains', { points: rectPts(40, 10, 20, 20) }));
  const s2 = docS.add(createObject('Ter', 'terrains', { points: rectPts(70, 10, 20, 20) }));
  txS.commit();
  const re = reattachSidecar(docS, {
    stale: true,
    signatures: [objectSignature(s0), objectSignature(s1), objectSignature(s2)],
    names: { 0: 'A' },
    groups: [[0, 0]],
    twins: [[0, 1], [0, 2]]
  });
  assert.equal(re.groupOf.size, 0, 'duplicate index [0, 0] must not form a singleton group');
  assert.equal(re.twins.get(s0.uid), s1.uid);
  assert.equal(re.twins.get(s1.uid), s0.uid);
  assert.equal(re.twins.has(s2.uid), false, 'conflicting twin pair must not corrupt existing twin');

  const emptyBrushEd = { state: { brush: {} }, catalog, emit() {} };
  assert.equal(sampleObjectToBrush(emptyBrushEd, { type: 'Sky', layerId: 'sky', colors: [] }).sampled, false);
  assert.equal(sampleObjectToBrush(emptyBrushEd, { type: 'Wat', layerId: 'water', colors: [] }).sampled, false);
  assert.equal(habitatCompatibility(catalog.animals, 64).animals.length, 0);
});

test('contour.js: snap priority, AABB cache, ring trace and segment metrics', () => {
  const doc = new MapDocument({ width: 40, height: 40 });
  const tx0 = doc.begin('seed contour');
  const ter = doc.add(createObject('Ter', 'terrains', { points: rectPts(0, 0, 100, 100), texture: 5 }));
  tx0.commit();

  const cache = createContourBoundsCache(doc);
  const vis = new Set(['terrains']);
  const pHit = findSnapTarget(doc, { x: 5, y: 2 }, { tolerance: 10, visible: vis, boundsCache: cache });
  assert.equal(pHit.kind, 'point');
  assert.equal(pHit.label, 'Point');
  assert.equal(pHit.x, 0);
  assert.equal(pHit.y, 0);
  assert.equal(pHit.vertexIndex, 0);

  const mHit = findSnapTarget(doc, { x: 48, y: 3 }, { tolerance: 10, visible: vis, boundsCache: cache });
  assert.equal(mHit.kind, 'midpoint');
  assert.equal(mHit.label, 'Midpoint');
  assert.equal(mHit.x, 50);
  assert.equal(mHit.y, 0);
  assert.equal(mHit.edgeIndex, 0);
  assert.equal(mHit.t, 0.5);

  const eHit = findSnapTarget(doc, { x: 25, y: 3 }, { tolerance: 10, visible: vis, boundsCache: cache });
  assert.equal(eHit.kind, 'edge');
  assert.equal(eHit.label, 'Edge');
  assert.equal(eHit.x, 25);
  assert.equal(eHit.y, 0);
  assert.equal(eHit.edgeIndex, 0);
  assert.equal(eHit.t, 0.25);

  const gHit = findSnapTarget(doc, { x: 25, y: 3 }, { tolerance: 10, visible: vis, snapEdges: false, snapGrid: true, gridStep: 10 });
  assert.equal(gHit.kind, 'grid');
  assert.equal(gHit.x, 30);
  assert.equal(gHit.y, 0);

  const hiddenHit = findSnapTarget(doc, { x: 25, y: 3 }, { tolerance: 10, visible: new Set(['water']) });
  assert.equal(hiddenHit.kind, null);

  const b1 = cache.get(ter);
  const b2 = cache.get(ter);
  assert.equal(b1, b2);
  const txMove = doc.begin('move');
  ops.translate(doc, [ter], 10, 0);
  txMove.commit();
  const b3 = cache.get(ter);
  assert.notEqual(b3, b1);
  assert.equal(b3.minX, 10);
  doc.history.undo();

  const R = rectPts(0, 0, 100, 100);
  assert.deepEqual(traceRingSegment(R, 3, 1), [{ x: 0, y: 100 }, { x: 0, y: 0 }, { x: 100, y: 0 }]);
  assert.deepEqual(traceRingSegment(R, 0, 3), [{ x: 0, y: 0 }, { x: 0, y: 100 }]);
  assert.deepEqual(traceRingSegment(R, 0, 3, { reverse: true }), [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }
  ]);
  const wide = rectPts(0, 0, 100, 20);
  assert.deepEqual(
    traceRingSegment(wide, { edgeIndex: 0, t: 0.5 }, { edgeIndex: 2, t: 0.5 }, { includeStart: false }),
    [{ x: 100, y: 0 }, { x: 100, y: 20 }, { x: 50, y: 20 }]
  );
  assert.deepEqual(
    traceRingSegment(R, { edgeIndex: 1, t: 0.2 }, { edgeIndex: 1, t: 0.8 }),
    [{ x: 100, y: 20 }, { x: 100, y: 80 }]
  );
  assert.equal(traceRingSegment(R, { edgeIndex: 1, t: 0.2 }, { edgeIndex: 1, t: 0.8 }, { reverse: true }).length, 6);
  assert.equal(locatePointOnRing(R, { x: 50, y: 0 }, 0.05).edgeIndex, 0);

  const m1 = segmentMetrics({ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: -40 });
  assert.equal(m1.lengthPx, 40);
  assert.equal(m1.lengthUnits, 4);
  assert.equal(m1.angleDeg, 90);
  assert.equal(Math.round(m1.cornerDeg), 90);
  assert.equal(m1.edgeReversal, false);

  const mFold = segmentMetrics({ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 10, y: 0 });
  assert.equal(Math.round(mFold.cornerDeg), 0);
  assert.equal(mFold.edgeReversal, true);
});

test('contour.js: seam-preserving simplification and shared vertex detection', () => {
  const docS = new MapDocument({ width: 600, height: 600 });
  const txS = docS.begin('seed seams');
  docS.add(createObject('Ter', 'terrains', {
    points: [
      { x: 0, y: 0 }, { x: 20, y: 2 }, { x: 40, y: 4 }, { x: 60, y: 2 }, { x: 80, y: 0 },
      { x: 80, y: -50 }, { x: 0, y: -50 }
    ],
    texture: 5
  }));
  const watB = docS.add(createObject('Wat', 'water', {
    points: [
      { x: 0, y: 0 }, { x: 20, y: 2.005 }, { x: 40, y: 4 }, { x: 60, y: 2 }, { x: 80, y: 0 },
      { x: 80, y: 40 }, { x: 60, y: 40.5 }, { x: 40, y: 40 }, { x: 20, y: 40.2 }, { x: 0, y: 40 }
    ]
  }));
  docS.add(createObject('Ter', 'terrains', { points: rectPts(5000, 5000, 50, 50), texture: 5 }));
  txS.commit();

  const shared = findSharedVertices(docS, watB, { tolerance: 0.01 });
  assert.deepEqual([...shared].sort((a, b) => a - b), [0, 1, 2, 3, 4]);

  const beforeDpm = serializeDpm(docS);
  const txSimp = docS.begin('simplify keeping shared');
  const simpRes = simplifyKeepingShared(docS, [watB], { mode: 'tolerance', epsilon: 10, tolerance: 0.01 });
  txSimp.commit();
  assert.ok(simpRes.removed > 0);
  assert.equal(simpRes.pinnedCount, 5);
  assert.deepEqual(watB.points.slice(0, 5), [
    { x: 0, y: 0 }, { x: 20, y: 2.005 }, { x: 40, y: 4 }, { x: 60, y: 2 }, { x: 80, y: 0 }
  ]);
  docS.history.undo();
  assert.equal(serializeDpm(docS), beforeDpm);

  const txTarget = docS.begin('target keeping shared');
  simplifyKeepingShared(docS, [watB], { mode: 'target', targetPoints: 3, tolerance: 0.01 });
  txTarget.commit();
  assert.ok(watB.points.length >= 5);
  assert.deepEqual(selfIntersections(watB.points), []);

  const docE = new MapDocument({ width: 50, height: 50 });
  const txE = docE.begin('seed edges');
  const poly1 = docE.add(createObject('Ter', 'terrains', { points: rectPts(0, 0, 100, 100), texture: 5 }));
  const poly2 = docE.add(createObject('Ter', 'terrains', {
    points: [{ x: 100, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 100, y: 100 }],
    texture: 5
  }));
  const polyGap = docE.add(createObject('Ter', 'terrains', {
    points: [{ x: 0, y: 100.02 }, { x: 100, y: 100.02 }, { x: 100, y: 200 }, { x: 0, y: 200 }],
    texture: 5
  }));
  txE.commit();

  const hitPref1 = findContourHit(docE, { x: 100, y: 50 }, { tolerance: 10, preferUid: poly1.uid });
  assert.equal(hitPref1.uid, poly1.uid);
  const hitPref2 = findContourHit(docE, { x: 100, y: 50 }, { tolerance: 10, preferUid: poly2.uid });
  assert.equal(hitPref2.uid, poly2.uid);

  const gapShared = findSharedVertices(docE, polyGap, { tolerance: 0.01 });
  assert.equal(gapShared.size, 0, '0.02 px gap must not be pinned at 0.01 px tolerance');

  const batch = findSharedVerticesBatch(docE, [poly1, poly2, polyGap], { tolerance: 0.01 });
  assert.deepEqual([...batch.get(poly1)].sort((a, b) => a - b), [1, 2]);
  assert.deepEqual([...batch.get(poly2)].sort((a, b) => a - b), [0, 3]);
  assert.equal(batch.get(polyGap).size, 0);

  const preSimp = previewSimplifyKeepingShared(docE, [poly1, poly2], {
    mode: 'tolerance',
    epsilon: 5,
    pinnedSets: [batch.get(poly1), batch.get(poly2)]
  });
  assert.equal(preSimp.pinnedCount, 4);

  const concave = [
    { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 40 }, { x: 90, y: 40 },
    { x: 90, y: 0 }, { x: 140, y: 0 }, { x: 140, y: 100 }, { x: 0, y: 100 }
  ];
  const pin1 = simplifyRingPinned(concave, 500, new Set([0]));
  assert.ok(pin1.length >= 3);
  assert.deepEqual(pin1[0], { x: 0, y: 0 });
  const pin2 = simplifyRingPinned(concave, 500, new Set([0, 6]));
  assert.ok(pin2.length >= 3);
  assert.deepEqual(pin2[0], { x: 0, y: 0 });
  assert.ok(pin2.some(p => p.x === 140 && p.y === 100));
});

test('palette.js: selection colors, HSL/haze with thin-Sky lock, Bg depth stepper and reference extraction', () => {
  const doc = new MapDocument({ width: 20, height: 20 });
  const tx0 = doc.begin('seed palette');
  const skyA = doc.add(createObject('Sky', 'sky', { points: rectPts(0, 0, 200, 50), colors: [0x112233, 0x445566] }));
  const skyB = doc.add(createObject('Sky', 'sky', { points: rectPts(0, 50, 200, 50), colors: [0x445566, 0x778899] }));
  const skyThin = doc.add(createObject('Sky', 'sky', { points: rectPts(0, 10, 50, 1.0), colors: [0x445566, 0x445566] }));
  const wat = doc.add(createObject('Wat', 'water', { points: rectPts(0, 100, 200, 100), colors: [0x445566, 0x001122] }));
  tx0.commit();

  const list = collectSelectionColors([skyA, skyB, skyThin, wat]);
  assert.equal(list[0].hex, '#445566');
  assert.equal(list[0].count, 5);
  assert.equal(list[0].objectCount, 4);

  const beforeDpm = serializeDpm(doc);
  const tx1 = doc.begin('replace color');
  const rep = replaceSelectionColor(doc, [skyA, skyB, skyThin, wat], '#445566', '#abcdef');
  tx1.commit();
  assert.equal(rep.changedObjects, 4);
  assert.equal(rep.changedStops, 5);
  assert.deepEqual(skyA.colors, [0x112233, 0xabcdef]);
  assert.deepEqual(skyB.colors, [0xabcdef, 0x778899]);
  assert.deepEqual(skyThin.colors, [0xabcdef, 0xabcdef]);
  assert.deepEqual(wat.colors, [0xabcdef, 0x001122]);
  doc.history.undo();
  assert.equal(serializeDpm(doc), beforeDpm);

  assert.equal(transformColor(0x336699, { hue: 0, saturation: 0, lightness: 0, haze: 0 }), 0x336699);
  assert.equal(transformColor(0xff0000, { hue: 120 }), 0x00ff00);

  const txBad = doc.begin('seed thin');
  const badThin = doc.add(createObject('Sky', 'sky', {
    points: rectPts(0, 10, 50, THIN_SKY_MIN_PX - 0.2),
    colors: [0xff0000, 0x00ff00]
  }));
  txBad.commit();

  const liveSkyA = doc.get(skyA.uid);
  const liveWat = doc.get(wat.uid);
  const txAtm = doc.begin('atmosphere');
  applyAtmosphereAdjust(doc, [liveSkyA, liveWat, badThin], {
    hue: 0, saturation: 0, lightness: 0, haze: 100, hazeColor: 0xffffff
  });
  txAtm.commit();
  assert.equal(isThinTwoStopSky(badThin), false);
  assert.equal(badThin.colors.length, 2);
  assert.equal(badThin.colors[0], badThin.colors[1]);
  assert.deepEqual(liveWat.colors, [0xffffff, 0xffffff]);

  assert.deepEqual(computeBgDepthSteps(5, 0.1, 0.5), [0.1, 0.2, 0.3, 0.4, 0.5]);
  assert.deepEqual(computeBgDepthSteps(4, 0.1, 0.9), [0.1, 0.4, 0.6, 0.9]);
  for (const op of computeBgDepthSteps(7, 0.1, 0.9)) {
    assert.ok(BG_ALLOWED_OPACITIES.includes(op));
  }

  const bgs = [0, 1, 2].map(i => createObject('Bg', 'background-terrains', { points: rectPts(0, i * 20, 50, 20), opacity: 0.9 }));
  const txBg0 = doc.begin('seed bg');
  bgs.forEach(b => doc.add(b));
  txBg0.commit();
  const txBg1 = doc.begin('step bg');
  const bgRes = stepBgDepthOpacities(doc, bgs, { far: 0.1, near: 0.5, orderBy: 'z' });
  txBg1.commit();
  assert.deepEqual(bgRes.opacities, [0.1, 0.3, 0.5]);
  assert.deepEqual(bgs.map(b => doc.get(b.uid).opacity), [0.1, 0.3, 0.5]);
  doc.history.undo();
  assert.deepEqual(bgs.map(b => doc.get(b.uid).opacity), [0.9, 0.9, 0.9]);

  const rgba = new Uint8ClampedArray([
    255, 0, 0, 255,  255, 0, 0, 255,
    0, 255, 0, 255,  0, 255, 0, 255,
    0, 0, 255, 255,  0, 0, 0, 0
  ]);
  assert.deepEqual(extractPaletteFromPixels(rgba, 6).sort(), ['#0000ff', '#00ff00', '#ff0000']);
});

test('palette.js: target filtering, non-destructive preview, depth ramps and Bg ordering', () => {
  const docP = new MapDocument({ width: 20, height: 20 });
  const txP = docP.begin('seed palette edges');
  const pSkyTop = docP.add(createObject('Sky', 'sky', { points: rectPts(0, 0, 100, 40), colors: [0x204060, 0x406080] }));
  const pWatBot = docP.add(createObject('Wat', 'water', { points: rectPts(0, 100, 100, 80), colors: [0x102030, 0x051018] }));
  const pAir = docP.add(createObject('Air', 'air-pockets', { points: rectPts(20, 120, 40, 40), borderColor: 0x000000 }));
  const pThinTwo = docP.add(createObject('Sky', 'sky', { points: rectPts(0, 10, 50, 1.0), colors: [0x445566, 0x112233] }));
  txP.commit();

  const unlockedTargets = collectPaletteTargets(docP, { scope: 'map', includeAir: true, locked: new Set(['sky']) });
  assert.equal(unlockedTargets.includes(pSkyTop), false);
  assert.equal(unlockedTargets.includes(pWatBot), true);
  assert.equal(unlockedTargets.includes(pAir), true);

  // Non-destructive computeAtmospherePreview must not mutate live objects
  const prevColorsSnapshot = JSON.stringify([pSkyTop.colors, pAir.borderColor]);
  const preview = computeAtmospherePreview([pSkyTop, pAir], { hue: 90, haze: 50, hazeColor: 0xffffff });
  assert.equal(preview.changed, 2);
  assert.ok(preview.overrides.has(pSkyTop.uid));
  assert.ok(preview.overrides.has(pAir.uid));
  assert.equal(JSON.stringify([pSkyTop.colors, pAir.borderColor]), prevColorsSnapshot);

  // bottom-to-top depth ramp + Air borderColor adjustment
  const txBot = docP.begin('atmosphere bottom-to-top');
  applyAtmosphereAdjust(docP, [pSkyTop, pAir], {
    hue: 0, saturation: 0, lightness: 0, haze: 100, hazeColor: 0xffffff
  }, { direction: 'bottom-to-top' });
  txBot.commit();
  assert.deepEqual(pSkyTop.colors, [0xffffff, 0xffffff], 'top object gets depth=1 under bottom-to-top');
  assert.equal(pAir.borderColor, 0x000000, 'bottom object gets depth=0 under bottom-to-top');
  const txAir = docP.begin('atmosphere air');
  applyAtmosphereAdjust(docP, [pAir], { hue: 0, saturation: 0, lightness: 100, haze: 0 });
  txAir.commit();
  assert.equal(pAir.borderColor, 0xffffff);

  // replaceSelectionColor locks thin 2-stop Sky to [c, c]
  const txThinRep = docP.begin('replace thin sky');
  replaceSelectionColor(docP, [pThinTwo], '#445566', '#abcdef', { preserveThinSky: true });
  txThinRep.commit();
  assert.deepEqual(pThinTwo.colors, [0xabcdef, 0xabcdef]);

  // orderBgObjects (y-asc, y-desc, selection) and compoundedOpacity
  const bgHigh = createObject('Bg', 'background-terrains', { points: rectPts(0, 10, 20, 20), opacity: 0.9 });
  const bgLow = createObject('Bg', 'background-terrains', { points: rectPts(0, 100, 20, 20), opacity: 0.2 });
  assert.deepEqual(orderBgObjects([bgLow, bgHigh], null, 'y-asc'), [bgHigh, bgLow]);
  assert.deepEqual(orderBgObjects([bgHigh, bgLow], null, 'y-desc'), [bgLow, bgHigh]);
  assert.deepEqual(orderBgObjects([bgLow, bgHigh], null, 'selection'), [bgLow, bgHigh]);
  assert.ok(Math.abs(compoundedOpacity([0.5, 0.5]) - 0.75) < 1e-9);
});

test('knife.js: polyline slice, passage gaps, vertex bevel, and bridgeAllHoles', () => {
  const sq = rectPts(0, 0, 100, 100);
  const straight = slicePolygonDetailed(sq, [{ x: -20, y: 40 }, { x: 120, y: 40 }]);
  assert.equal(straight.changed, true);
  assert.equal(straight.pieces.length, 2);
  const sumStraight = straight.pieces.reduce((s, r) => s + Math.abs(signedArea(r)), 0);
  assert.ok(Math.abs(sumStraight - 10000) < 1e-3);
  for (const p of straight.pieces) {
    assert.equal(p.length, 4);
    assert.deepEqual(selfIntersections(p), []);
  }

  const uShape = [
    { x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 70 }, { x: 70, y: 70 },
    { x: 70, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }
  ];
  const uPieces = slicePolygon(uShape, [{ x: -10, y: 40 }, { x: 110, y: 40 }]);
  assert.equal(uPieces.length, 3);
  for (const p of uPieces) assert.deepEqual(selfIntersections(p), []);

  const passage = slicePolygonDetailed(sq, [{ x: -10, y: 50 }, { x: 110, y: 50 }], { gapPx: 20 });
  assert.equal(passage.changed, true);
  assert.equal(passage.pieces.length, 2);
  const sumPassage = passage.pieces.reduce((s, r) => s + Math.abs(signedArea(r)), 0);
  assert.ok(Math.abs(sumPassage - 8000) < 1);

  assert.equal(slicePolygonDetailed(sq, [{ x: -20, y: 50 }, { x: 50, y: 50 }]).changed, false);

  const doc = new MapDocument({ width: 30, height: 30 });
  const tx0 = doc.begin('seed knife');
  const ter = doc.add(createObject('Ter', 'terrains', { points: rectPts(10, 10, 100, 100), texture: 5 }));
  const bg = doc.add(createObject('Bg', 'background-terrains', { points: rectPts(10, 10, 100, 100), texture: 4, opacity: 0.4 }));
  tx0.commit();
  const before = serializeDpm(doc);

  const cutLine = [{ x: 0, y: 60 }, { x: 120, y: 60 }];
  assert.equal(selectKnifeTargets(doc, { activeLayer: 'terrains', polyline: cutLine }).length, 1);
  assert.equal(computeCutIntersections([ter], cutLine).length, 2);

  const tx1 = doc.begin('Knife slice');
  const res = slicePolygonsInDoc(doc, [ter, bg], cutLine);
  tx1.commit();
  assert.equal(res.cutCount, 2);
  assert.equal(doc.layers.terrains.length, 2);
  assert.equal(doc.layers.terrains[0].texture, 5);
  assert.equal(doc.layers['background-terrains'][1].opacity, 0.4);
  doc.history.undo();
  assert.equal(serializeDpm(doc), before);

  // Vertex bevel
  const one = bevelPolygonVertices(sq, new Set([0]), 10);
  assert.equal(one.beveledCount, 1);
  assert.equal(one.clamped, false);
  assert.deepEqual(one.points.slice(0, 2), [{ x: 0, y: 10 }, { x: 10, y: 0 }]);
  assert.deepEqual([...one.selectedIndices], [0, 1]);

  const all = bevelPolygonVertices(sq, new Set([0, 1, 2, 3]), 1000);
  assert.equal(all.beveledCount, 4);
  assert.equal(all.clamped, true);
  assert.equal(all.points.length, 8);
  assert.deepEqual(selfIntersections(all.points), []);
  assert.ok(all.points[1].x < all.points[2].x);

  const txB = doc.begin('Bevel points');
  const bRes = bevelSelectionPoints(doc, new Map([[ter.uid, new Set([0, 2])]]), 15);
  txB.commit();
  assert.equal(bRes.totalBeveled, 2);
  assert.equal(doc.get(ter.uid).points.length, 6);
  doc.history.undo();
  assert.equal(serializeDpm(doc), before);

  // bridgeAllHoles
  const outer = rectPts(0, 0, 200, 200);
  const inner = rectPts(20, 20, 160, 160);
  const oneHole = bridgeAllHoles(outer, [inner], { slitWidth: 0.1 });
  assert.equal(oneHole.length, 1);
  assert.deepEqual(selfIntersections(oneHole[0]), []);
  assert.equal(oneHole[0].filter(p => p.y === 0).length, 2);

  const rock = rectPts(0, 0, 400, 200);
  const cave1 = rectPts(40, 60, 120, 100);
  const cave2 = rectPts(240, 60, 120, 100);
  const twoHoles = bridgeAllHoles(rock, [cave1, cave2], { slitWidth: 0.1 });
  assert.equal(twoHoles.length, 1);
  assert.deepEqual(selfIntersections(twoHoles[0]), []);
});

test('knife.js: inner corners, closed loops, notches, live symmetry, target filtering and spike bevels', () => {
  const sq = rectPts(0, 0, 100, 100);
  const lShape = [
    { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 },
    { x: 100, y: 50 }, { x: 100, y: 100 }, { x: 0, y: 100 }
  ];
  const lSplit = slicePolygonDetailed(lShape, [{ x: 0, y: 50 }, { x: 50, y: 50 }], { gapPx: 0 });
  assert.equal(lSplit.changed, true);
  assert.equal(lSplit.pieces.length, 2);
  const lSum = lSplit.pieces.reduce((s, r) => s + Math.abs(signedArea(r)), 0);
  assert.ok(Math.abs(lSum - 7500) < 1e-2, 'L-shape inner corner split must be zero-gap');
  for (const p of lSplit.pieces) assert.deepEqual(selfIntersections(p), []);

  // Closed-loop island cut (zero-gap)
  const islandLoop = [
    { x: 20, y: 20 }, { x: 80, y: 20 }, { x: 80, y: 80 }, { x: 20, y: 80 }, { x: 20, y: 20 }
  ];
  const islandRes = slicePolygonDetailed(sq, islandLoop, { gapPx: 0 });
  assert.equal(islandRes.changed, true);
  assert.equal(islandRes.pieces.length, 2);
  for (const p of islandRes.pieces) assert.deepEqual(selfIntersections(p), []);

  // Passage non-splitting notch
  const notchRes = slicePolygonDetailed(sq, [{ x: -10, y: 50 }, { x: 50, y: 50 }], { gapPx: 20 });
  assert.equal(notchRes.changed, true);
  assert.equal(notchRes.pieces.length, 1);
  assert.ok(Math.abs(signedArea(notchRes.pieces[0])) < 9500);

  // Live-symmetry twin slice (slicing one side mirrors cleanly into 4 pieces, 0 duplicate contours)
  const docSym = new MapDocument({ width: 40, height: 20 });
  const edSymMock = { doc: docSym, state: { dirty: false }, emit() {}, requestRender() {}, toast() {} };
  const symMeta = new EditorMeta(edSymMock);
  symMeta.setSymmetry('h');
  docSym.beforeCommit = (before, label) => symMeta.beforeCommit(before, label);
  const txSym0 = docSym.begin('seed sym');
  const leftTer = docSym.add(createObject('Ter', 'terrains', { points: rectPts(20, 40, 80, 80), texture: 5 }));
  txSym0.commit();
  assert.equal(docSym.layers.terrains.length, 2);
  const rightTer = docSym.get(symMeta.twins.get(leftTer.uid));
  const txSymCut = docSym.begin('Knife slice');
  slicePolygonsInDoc(docSym, [leftTer, rightTer], [{ x: 0, y: 80 }, { x: 400, y: 80 }], { gapPx: 0, twins: symMeta.twins });
  txSymCut.commit();
  assert.equal(docSym.layers.terrains.length, 4);
  assert.equal(symMeta.twins.size, 4);
  assert.equal(findDuplicateContours(docSym.layers.terrains).length, 0);

  // selectKnifeTargets locked / hidden / isolated / boundsCache
  const docFilt = new MapDocument({ width: 30, height: 30 });
  const txF = docFilt.begin('seed filt');
  const tF = docFilt.add(createObject('Ter', 'terrains', { points: rectPts(10, 10, 100, 100), texture: 5 }));
  const iF = docFilt.add(createObject('Ter', 'islands', { points: rectPts(10, 10, 100, 100), texture: 5 }));
  txF.commit();
  const fCache = createContourBoundsCache(docFilt);
  const fLine = [{ x: 0, y: 50 }, { x: 120, y: 50 }];
  assert.equal(selectKnifeTargets(docFilt, { activeLayer: 'terrains', locked: new Set(['terrains']), polyline: fLine, boundsCache: fCache }).length, 0);
  assert.equal(selectKnifeTargets(docFilt, { activeLayer: 'terrains', visible: new Set(['islands']), scope: 'all', polyline: fLine, boundsCache: fCache }).length, 1);
  assert.deepEqual(selectKnifeTargets(docFilt, { activeLayer: 'terrains', isolate: true, scope: 'all', polyline: fLine, boundsCache: fCache }), [tF]);
  assert.equal(selectKnifeTargets(docFilt, { selection: [iF], activeLayer: 'terrains', isolate: true, polyline: fLine, boundsCache: fCache }).length, 0);

  // bevelPolygonVertices self-intersection halving / rollback on concave spikes
  const spike = [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 },
    { x: 52, y: 100 }, { x: 50, y: 10 }, { x: 48, y: 100 }, { x: 0, y: 100 }
  ];
  const bevelSpike = bevelPolygonVertices(spike, new Set([3, 4, 5]), 40);
  assert.deepEqual(selfIntersections(bevelSpike.points, 1), []);

  // bridgeAllHoles with asymmetric near-wall hole
  const asymOuter = rectPts(0, 0, 200, 200);
  const asymHole = rectPts(10, 90, 40, 20);
  const asymRes = bridgeAllHoles(asymOuter, [asymHole], { slitWidth: 0.1 });
  assert.equal(asymRes.length, 1);
  assert.deepEqual(selfIntersections(asymRes[0]), []);
});

test('scatter.js: surface filter, CW/CCW normals, placement, stroke symmetry, erase & re-seat', () => {
  assert.equal(matchesSurfaceFilter(0, -1, 'floor'), true);
  assert.equal(matchesSurfaceFilter(0, -1, 'wall'), false);
  assert.equal(matchesSurfaceFilter(0, -1, 'ceiling'), false);
  assert.equal(matchesSurfaceFilter(0, -1, 'all'), true);
  assert.equal(matchesSurfaceFilter(1, 0, 'wall'), true);
  assert.equal(matchesSurfaceFilter(-1, 0, 'wall'), true);
  assert.equal(matchesSurfaceFilter(0, 1, 'ceiling'), true);
  assert.equal(matchesSurfaceFilter(Math.SQRT1_2, -Math.SQRT1_2, 'floor'), true);
  assert.equal(matchesSurfaceFilter(Math.SQRT1_2, -Math.SQRT1_2, 'wall'), false);

  const docSurf = new MapDocument({ width: 50, height: 50 });
  const txS = docSurf.begin('seed surfaces');
  docSurf.add(createObject('Ter', 'terrains', { points: rectPts(100, 100, 100, 100), texture: 5 }));
  const ccwPlat = rectPts(250, 100, 100, 100).reverse();
  docSurf.add(createObject('Ter', 'platforms', { points: ccwPlat, texture: 5 }));
  txS.commit();

  const floorHit = nearestSurfacePoint(docSurf, { x: 150, y: 92 }, 20);
  assert.equal(floorHit.x, 150);
  assert.equal(floorHit.y, 100);
  assert.equal(floorHit.nx, 0);
  assert.equal(floorHit.ny, -1);

  const platHit = nearestSurfacePoint(docSurf, { x: 300, y: 208 }, 20);
  assert.equal(platHit.x, 300);
  assert.equal(platHit.y, 200);
  assert.equal(platHit.nx, 0);
  assert.equal(platHit.ny, 1);

  assert.equal(nearestSurfacePoint(docSurf, { x: 300, y: 208 }, 20, { visible: new Set(['terrains']) }), null);
  assert.equal(nearestSurfacePoint(docSurf, { x: 150, y: 92 }, 20, { surfaceFilter: 'ceiling' }), null);

  const anemone = catalog.hideSpaceById.get(1);
  assert.deepEqual(computePlacement({ x: 100, y: 200, nx: 0, ny: -1 }, anemone), { x: 100, y: 200, rotation: 0 });
  assert.deepEqual(computePlacement({ x: 200, y: 150, nx: 1, ny: 0 }, anemone), { x: 200, y: 150, rotation: 90 });
  assert.deepEqual(computePlacement({ x: 100, y: 50, nx: 0, ny: 1 }, anemone), { x: 100, y: 50, rotation: 180 });

  const iciclea = catalog.hideSpaceById.get(58);
  assert.deepEqual(computePlacement({ x: 100, y: 50, nx: 0, ny: 1 }, iciclea), { x: 100, y: 50, rotation: 0 });
  assert.deepEqual(computePlacement({ x: 100, y: 200, nx: 0, ny: -1 }, iciclea), { x: 100, y: 200, rotation: 180 });

  const cloudbig = catalog.hideSpaceById.get(53);
  const cloudPlaced = computePlacement({ x: 100, y: 200, nx: 0, ny: -1 }, cloudbig);
  assert.equal(cloudPlaced.x, 100);
  assert.ok(Math.abs(cloudPlaced.y - 160.15) < 0.05);
  assert.equal(cloudPlaced.rotation, 0);

  assert.equal(computePlacement({ x: 0, y: 0, nx: Math.SQRT1_2, ny: -Math.SQRT1_2 }, anemone, { align: 'upright' }).rotation, 0);
  const flippedIcicle = computePlacement({ x: 100, y: 200, nx: 0, ny: -1 }, iciclea, { flip180: true, embed: 2 });
  assert.equal(flippedIcicle.rotation, 0);
  assert.ok(Math.abs(flippedIcicle.y - (200 - iciclea.height * 10 + 2)) < 0.01);

  const doc = new MapDocument({ width: 40, height: 40 });
  const edMock = { doc, state: { dirty: false }, emit() {}, requestRender() {}, toast() {} };
  const meta = new EditorMeta(edMock);
  meta.setSymmetry('h');
  doc.beforeCommit = (before, label) => meta.beforeCommit(before, label);

  const tx0 = doc.begin('seed ter');
  doc.add(createObject('Ter', 'terrains', { points: rectPts(50, 200, 300, 100), texture: 5 }));
  tx0.commit();
  meta.twins.clear();

  const tx1 = doc.begin('Scatter hide spaces');
  const rng = (() => { let s = 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
  const created = scatterStroke(doc, [{ x: 60, y: 192 }, { x: 260, y: 192 }], {
    radius: 30, spacing: 20, spacingJitter: 0, rotationJitter: 8,
    assets: [32, 33], surfaceFilter: 'floor', opacity: 1, catalog, rng
  });
  tx1.commit();

  assert.equal(created.length, 10);
  assert.equal(doc.layers['hide-spaces'].length, 20);
  for (const h of created) {
    assert.equal(h.y, 200);
    assert.ok(Math.abs(h.rotation) <= 8);
  }
  assert.equal(validate(doc, catalog).filter(i => i.severity === 'error').length, 0);
  doc.history.undo();
  assert.equal(doc.layers['hide-spaces'].length, 0);

  const txH = doc.begin('seed kelp');
  const kelp = doc.add(createObject('H', 'hide-spaces', { x: 100, y: 200, rotation: 0, hSType: 36 }));
  txH.commit();
  assert.deepEqual(findHideSpacesInRadius(doc, { x: 100, y: 160 }, 10, catalog), [kelp]);
  assert.deepEqual(findHideSpacesInRadius(doc, { x: 200, y: 200 }, 10, catalog), []);

  const txR = doc.begin('seed reseat');
  const near = doc.add(createObject('H', 'hide-spaces', { x: 100, y: 185, rotation: 45, hSType: 1 }));
  const wallH = doc.add(createObject('H', 'hide-spaces', { x: 365, y: 250, rotation: 0, hSType: 1 }));
  const tooFar = doc.add(createObject('H', 'hide-spaces', { x: 100, y: 170, rotation: 25, hSType: 1 }));
  const cloudFlush = doc.add(createObject('H', 'hide-spaces', { x: 160, y: cloudPlaced.y, rotation: 0, hSType: 53 }));
  const cloudMoved = doc.add(createObject('H', 'hide-spaces', { x: 220, y: cloudPlaced.y - 10, rotation: 15, hSType: 53 }));
  const ceilIcicle = doc.add(createObject('H', 'hide-spaces', { x: 150, y: 312, rotation: 10, hSType: 58 }));
  txR.commit();

  const txRe = doc.begin('Re-seat hide spaces');
  const reRes = reseatHideSpaces(doc, [near, wallH, tooFar, cloudFlush, cloudMoved, ceilIcicle], catalog);
  txRe.commit();
  assert.equal(reRes.moved, 4);
  assert.equal(reRes.alreadySeated, 1);
  assert.equal(reRes.outOfRange, 1);
  assert.equal(near.x, 100);
  assert.equal(near.y, 200);
  assert.equal(near.rotation, 0);
  assert.equal(wallH.x, 350);
  assert.equal(wallH.y, 250);
  assert.equal(wallH.rotation, 90);
  assert.equal(tooFar.y, 170);
  assert.ok(Math.abs(cloudMoved.y - (200 - cloudbig.height * 5)) < 0.05);
  assert.equal(cloudMoved.rotation, 0);
  assert.equal(ceilIcicle.y, 300);
  assert.equal(ceilIcicle.rotation, 0);
  doc.history.undo();
  assert.equal(doc.get(near.uid).y, 185);

  const txWc = doc.begin('scatter wall ceiling');
  const wallCreated = scatterStroke(doc, [{ x: 360, y: 210 }, { x: 360, y: 290 }], {
    radius: 30, spacing: 20, spacingJitter: 0, rotationJitter: 0,
    assets: [1], surfaceFilter: 'wall', catalog
  });
  const ceilCreated = scatterStroke(doc, [{ x: 80, y: 310 }, { x: 200, y: 310 }], {
    radius: 30, spacing: 20, spacingJitter: 0, rotationJitter: 0,
    assets: [58], surfaceFilter: 'ceiling', catalog
  });
  txWc.commit();
  assert.ok(wallCreated.length >= 2);
  for (const h of wallCreated) assert.equal(h.rotation, 90);
  assert.ok(ceilCreated.length >= 2);
  for (const h of ceilCreated) assert.equal(h.rotation, 0);
  doc.history.undo();

  assert.equal(hideSpaceOpacityWarns(1), false);
  assert.equal(hideSpaceOpacityWarns(0.99), true);
});

test('tool and command shortcuts have no collisions and avoid Turkish AltGr keys', async () => {
  const doc = new MapDocument({ width: 40, height: 40 });
  const { createCommands } = await import('../src/ui/commands.js');
  const { TOOL_DEFS } = await import('../src/ui/tools.js');
  const cmdEd = {
    doc,
    catalog,
    meta: { symmetry: 'off', blocks: [], groupOf: new Map(), twins: new Map() },
    state: { selection: new Set(), points: new Map(), activeLayer: 'terrains', snapEdges: true, view: { testerPreview: false } },
    selected: () => []
  };
  const cmds = createCommands(cmdEd);
  const checkedCmdIds = ['view.snapEdges', 'obj.simplifyShared', 'edit.paletteStudio', 'shape.bevel', 'obj.reseatHideSpaces'];
  for (const id of checkedCmdIds) {
    assert.ok(cmds.get(id), `command ${id} registered`);
  }
  assert.equal(TOOL_DEFS.knife?.key, 'K');
  assert.equal(TOOL_DEFS.scatter?.key, 'F');
  const turkishAltGr = /[[\];'"\\]/;
  for (const id of checkedCmdIds) {
    const k = cmds.get(id).keys;
    if (k) assert.equal(turkishAltGr.test(k), false, `shortcut ${k} (${id}) must avoid Turkish AltGr keys`);
  }
  for (const name of ['knife', 'scatter']) {
    assert.equal(turkishAltGr.test(TOOL_DEFS[name].key), false, `tool ${name} key must avoid Turkish AltGr keys`);
  }
  const seenKeys = new Map();
  for (const [name, def] of Object.entries(TOOL_DEFS)) {
    if (!def.key) continue;
    assert.equal(seenKeys.has(def.key), false, `tool key ${def.key} collision (${name})`);
    seenKeys.set(def.key, 'tool:' + name);
  }
  for (const c of cmds.list) {
    if (!c.keys) continue;
    assert.equal(seenKeys.has(c.keys), false, `command key ${c.keys} collision (${c.id})`);
    seenKeys.set(c.keys, 'cmd:' + c.id);
  }
});

test('knife handles closed-loop passages, X-cuts, islands in holes and tool layer preference', async () => {
  const bigSq = rectPts(0, 0, 200, 200);
  const loop50to150 = [
    { x: 50, y: 50 }, { x: 150, y: 50 }, { x: 150, y: 150 }, { x: 50, y: 150 }, { x: 50, y: 50 }
  ];
  const loopCut = slicePolygonDetailed(bigSq, loop50to150, { gapPx: 10 });
  assert.equal(loopCut.changed, true);
  assert.equal(loopCut.pieces.length, 2);
  const loopArea = loopCut.pieces.reduce((s, r) => s + Math.abs(signedArea(r)), 0);
  assert.ok(Math.abs(loopArea - 36000) < 10, `expected ~36000 px^2, got ${loopArea}`);
  const areas = loopCut.pieces.map(r => Math.abs(signedArea(r))).sort((a, b) => a - b);
  assert.ok(Math.abs(areas[0] - 8100) < 1, `expected 90x90 inner island, got ${areas[0]}`);
  for (const p of loopCut.pieces) assert.deepEqual(selfIntersections(p), []);

  const unitSq = rectPts(0, 0, 100, 100);
  const xCut = slicePolygonDetailed(unitSq, [
    { x: -10, y: -10 }, { x: 110, y: 110 }, { x: 110, y: -10 }, { x: -10, y: 110 }
  ], { gapPx: 0 });
  assert.equal(xCut.changed, true);
  assert.equal(xCut.pieces.length, 4);
  const xArea = xCut.pieces.reduce((s, r) => s + Math.abs(signedArea(r)), 0);
  assert.ok(Math.abs(xArea - 10000) < 5, `expected ~10000 px^2, got ${xArea}`);
  for (const p of xCut.pieces) assert.deepEqual(selfIntersections(p), []);

  const C = globalThis.ClipperLib;
  const toClip = pts => pts.map(p => ({ X: Math.round(p.x * 1000), Y: Math.round(p.y * 1000) }));
  const pos = path => (C.Clipper.Orientation(path) ? path : path.slice().reverse());
  const neg = path => (C.Clipper.Orientation(path) ? path.slice().reverse() : path);
  const bridgedWithIsland = bridgeAllHoles([
    { outer: pos(toClip(rectPts(0, 0, 200, 200))), holes: [neg(toClip(rectPts(30, 30, 140, 140)))] },
    { outer: pos(toClip(rectPts(70, 70, 60, 60))), holes: [] }
  ], { slitWidth: 0.1 });
  assert.equal(bridgedWithIsland.length, 2);

  const { TOOL_DEFS } = await import('../src/ui/tools.js');
  assert.equal(TOOL_DEFS.knife.native, TOOL.Creation);
  assert.equal(TOOL_DEFS.knife.preferLayer(), 'terrains');
});

test('palette depth stepping and atmosphere haze preserve live symmetry', () => {
  const docBg = new MapDocument({ width: 40, height: 20 });
  const edBgMock = { doc: docBg, state: { dirty: false }, emit() {}, requestRender() {}, toast() {} };
  const metaBg = new EditorMeta(edBgMock);
  metaBg.setSymmetry('h');
  docBg.beforeCommit = (before, label) => metaBg.beforeCommit(before, label);

  const txBgSeed = docBg.begin('seed bg sym');
  const bg1 = docBg.add(createObject('Bg', 'background-terrains', { points: rectPts(20, 20, 60, 40), opacity: 0.1 }));
  txBgSeed.commit();
  assert.equal(docBg.layers['background-terrains'].length, 2);
  const bg2 = docBg.get(metaBg.twins.get(bg1.uid));
  const bgBeforeDpm = serializeDpm(docBg);

  const txBgStep = docBg.begin('Step Bg depth');
  stepBgDepthOpacities(docBg, [bg1, bg2], { far: 0.1, near: 0.5, orderBy: 'selection' });
  txBgStep.commit();
  assert.equal(docBg.get(bg1.uid).opacity, 0.1);
  assert.equal(docBg.get(bg2.uid).opacity, 0.5);
  docBg.history.undo();
  assert.equal(serializeDpm(docBg), bgBeforeDpm);

  const docAtm = new MapDocument({ width: 20, height: 20 });
  const edAtmMock = { doc: docAtm, state: { dirty: false }, emit() {}, requestRender() {}, toast() {} };
  const metaAtm = new EditorMeta(edAtmMock);
  metaAtm.setSymmetry('v');
  docAtm.beforeCommit = (before, label) => metaAtm.beforeCommit(before, label);

  const txSkySeed = docAtm.begin('seed sky sym');
  const skyTop = docAtm.add(createObject('Sky', 'sky', { points: rectPts(0, 0, 100, 40), colors: [0x112233, 0x223344] }));
  txSkySeed.commit();
  assert.equal(docAtm.layers.sky.length, 2);
  const skyBot = docAtm.get(metaAtm.twins.get(skyTop.uid));
  const skyBeforeDpm = serializeDpm(docAtm);

  const txSkyHaze = docAtm.begin('Atmosphere haze');
  applyAtmosphereAdjust(docAtm, [skyTop, skyBot], {
    hue: 0, saturation: 0, lightness: 0, haze: 100, hazeColor: 0xffffff
  }, { worldHeight: 200, direction: 'top-to-bottom', range: 'selection' });
  txSkyHaze.commit();
  assert.deepEqual(docAtm.get(skyTop.uid).colors, [0x112233, 0x223344]);
  assert.deepEqual(docAtm.get(skyBot.uid).colors, [0xffffff, 0xffffff]);
  docAtm.history.undo();
  assert.equal(serializeDpm(docAtm), skyBeforeDpm);
});

test('scatter placement handles non-bottom anchors, upright slopes and re-seating', () => {
  const beaverdam = catalog.hideSpaceById.get(2);
  const lilypad = catalog.hideSpaceById.get(16);
  const cloudbig = catalog.hideSpaceById.get(53);
  const bdFloor = computePlacement({ x: 100, y: 200, nx: 0, ny: -1 }, beaverdam);
  assert.equal(bdFloor.rotation, 0);
  assert.ok(Math.abs(bdFloor.y - (200 - beaverdam.height * 10 * (1 - beaverdam.anchorY))) < 0.05);
  const lpFloor = computePlacement({ x: 100, y: 200, nx: 0, ny: -1 }, lilypad);
  assert.equal(lpFloor.rotation, 0);
  assert.ok(Math.abs(lpFloor.y - (200 - lilypad.height * 10 * (1 - lilypad.anchorY))) < 0.05);

  const cloudSlope = computePlacement(
    { x: 100, y: 100, nx: Math.SQRT1_2, ny: -Math.SQRT1_2 },
    cloudbig,
    { align: 'upright', embed: 0 }
  );
  assert.equal(cloudSlope.rotation, 0);
  assert.equal(cloudSlope.x, 100);
  const cloudCorners = spriteCorners(
    { type: 'H', hSType: 53, x: cloudSlope.x, y: cloudSlope.y, rotation: cloudSlope.rotation },
    spriteSize({ type: 'H', hSType: 53 }, catalog)
  );
  const cloudBottomY = Math.max(...cloudCorners.map(c => c.y));
  const cloudCenterX = (Math.min(...cloudCorners.map(c => c.x)) + Math.max(...cloudCorners.map(c => c.x))) / 2;
  assert.ok(Math.abs(cloudBottomY - 100) < 0.05, `expected bottomY=100, got ${cloudBottomY}`);
  assert.ok(Math.abs(cloudCenterX - 100) < 0.05, `expected centerX=100, got ${cloudCenterX}`);

  const docScat = new MapDocument({ width: 40, height: 40 });
  const txScat = docScat.begin('seed floor & surface assets');
  docScat.add(createObject('Ter', 'terrains', { points: rectPts(0, 200, 300, 100), texture: 5 }));
  const bdObj = docScat.add(createObject('H', 'hide-spaces', { x: 80, y: bdFloor.y - 6, rotation: 20, hSType: 2 }));
  const lpObj = docScat.add(createObject('H', 'hide-spaces', { x: 180, y: lpFloor.y - 6, rotation: -15, hSType: 16 }));
  txScat.commit();
  const txReseat = docScat.begin('Re-seat');
  const reseatRes = reseatHideSpaces(docScat, [bdObj, lpObj], catalog);
  txReseat.commit();
  assert.equal(reseatRes.moved, 2);
  assert.equal(bdObj.rotation, 0);
  assert.equal(lpObj.rotation, 0);
  assert.ok(Math.abs(bdObj.y - bdFloor.y) < 0.05);
  assert.ok(Math.abs(lpObj.y - lpFloor.y) < 0.05);

  const asymEntry = { width: 4, height: 2, anchorX: 0.25, anchorY: 1 };
  const asymPlaced = computePlacement({ x: 100, y: 200, nx: 0, ny: -1 }, asymEntry);
  assert.equal(asymPlaced.x, 90);
  assert.equal(asymPlaced.y, 200);
  assert.equal(asymPlaced.rotation, 0);
});

test('bake: touching skies with the same stops share one gradient frame (no column seams)', () => {
  const stops = [0x0b1030, 0x2a1a5e, 0x5a3a9a, 0x4a6ad0];
  const col = (a, b, top) => ({ type: 'Sky', layerId: 'sky', colors: stops, points: [{ x: a, y: top }, { x: b, y: top }, { x: b, y: 120 }, { x: a, y: 120 }] });
  const A = col(0, 60.5, 0), B = col(60, 95, 3), far = col(300, 340, 10);
  const groups = skyBakeGroups([A, B, far]);
  assert.equal(groups.length, 2);
  const g = groups.find(x => x.members.includes(A));
  assert.deepEqual(g.frame, { y0: 0, y1: 120 });
  const opts = { bands: 16, overlap: 1, seamLift: 0, frame: g.frame };
  const ra = bakeSkyGradient(A, opts).objects, rb = bakeSkyGradient(B, opts).objects;
  // the band that holds y = 60 has the same colours in both columns
  const at = (list, y) => list.find(o => { const ys = o.points.map(p => p.y); return Math.min(...ys) <= y && Math.max(...ys) > y; });
  assert.deepEqual(at(ra, 60).colors, at(rb, 60).colors);
});

test('validate and applyFix handle off-world shapes, self-intersections, spikes, spawns and teleports', () => {
  const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  const doc = new MapDocument({ width: 20, height: 20 });
  const tx = doc.begin('populate');
  doc.add(createObject('Wat', 'water', { points: rect(0, 0, 200, 200) }));
  doc.add(createObject('Wat', 'water', { points: rect(50, 50, 20, 20) })); // nested water is allowed
  doc.add(createObject('Ter', 'terrains', { points: rect(100, 100, 60, 60), texture: 5 }));
  const dupPts = doc.add(createObject('Sky', 'sky', { points: [...rect(0, 0, 50, 50), { x: 0, y: 50 }], colors: [1, 2] }));
  const off = doc.add(createObject('Sky', 'sky', { points: rect(-300, -300, 10, 10), colors: [1, 2] }));
  const bow = doc.add(createObject('Ter', 'terrains', { points: [{ x: 10, y: 10 }, { x: 40, y: 40 }, { x: 40, y: 10 }, { x: 10, y: 40 }], texture: 5 }));
  const spike = doc.add(createObject('Ter', 'terrains', { points: [{ x: 10, y: 160 }, { x: 60, y: 160 }, { x: 80, y: 160 }, { x: 60, y: 160.0001 }, { x: 60, y: 190 }, { x: 10, y: 190 }], texture: 5 }));
  const npc = doc.add(createObject('NPC', 'npc-spawns', { points: rect(20, 60, 20, 20) }));
  npc.settings.fishLevels = [1, 51, 99999]; npc.settings.animalCount = 150;
  const tr = doc.add(createObject('Tr', 'triggers', { position: { x: 5, y: 5 }, size: { width: 5, height: 5 },
    triggers: [{ when: 1, delay: 0, actions: [{ type: 1, data: { pos: { x: 130, y: 130 } } }] }] }));
  tx.commit();

  const issues = validate(doc, catalog);
  const codes = new Set(issues.map(i => i.code));
  assert.ok(!codes.has('duplicate-points') && !codes.has('tester-nested-water'));
  assert.ok(!issues.some(i => i.uid === dupPts.uid));
  const fixOf = (code, uid) => issues.find(i => i.code === code && (uid == null || i.uid === uid))?.fix;
  assert.equal(fixOf('off-world', off.uid), 'deleteObject');
  assert.equal(fixOf('self-intersection', bow.uid), 'untangle');
  assert.equal(fixOf('edge-reversal', spike.uid), 'removeSpikes');
  assert.equal(fixOf('npc-count', npc.uid), 'capNpcCount');
  assert.equal(fixOf('teleport-solid', tr.uid), 'moveTeleports');

  const tx2 = doc.begin('fix');
  for (const i of issues.filter(i => i.fix)) ops.applyFix(doc, catalog, i);
  tx2.commit();
  assert.ok(doc.get(off.uid) == null);
  assert.ok(npc.settings.animalCount <= 100); // npc-budget trim may lower it further on this tiny world
  assert.deepEqual(npc.settings.fishLevels.map(Number), [1]);
  const after = validate(doc, catalog);
  for (const code of ['off-world', 'self-intersection', 'edge-reversal', 'npc-count', 'npc-state', 'npc-level', 'teleport-solid', 'teleport-dry']) {
    assert.ok(!after.some(i => i.code === code), code + ' still reported');
  }
  const pos = tr.triggers[0].actions[0].data.pos;
  assert.ok(pos.x < 100 || pos.x > 160 || pos.y < 100 || pos.y > 160, 'teleport target moved out of the rock');
});

test('validate detects tester-hide-order, sortHideSpacesByOpacity fixes it, and layer filter supports opacity', async () => {
  const nonAbove = catalog.hideSpaces.find(h => !h.above);
  const aboveHs = catalog.hideSpaces.find(h => h.above);
  assert.ok(nonAbove && aboveHs, 'catalog has both above and non-above hide spaces');

  // 1. Overlapping 40% after 100% non-above -> triggers warning
  const doc = new MapDocument({ width: 40, height: 40 });
  const tx = doc.begin('seed hide-spaces');
  const h100 = doc.add(createObject('H', 'hide-spaces', { x: 100, y: 100, hSType: nonAbove.id, opacity: 1 }));
  const h40 = doc.add(createObject('H', 'hide-spaces', { x: 100, y: 100, hSType: nonAbove.id, opacity: 0.4 }));
  // Non-overlapping 40% after 100% -> should NOT trigger
  const h40Far = doc.add(createObject('H', 'hide-spaces', { x: 350, y: 350, hSType: nonAbove.id, opacity: 0.4 }));
  // Overlapping 40% after 100% above=true -> should NOT trigger
  doc.add(createObject('H', 'hide-spaces', { x: 250, y: 100, hSType: aboveHs.id, opacity: 1 }));
  const h40UnderAbove = doc.add(createObject('H', 'hide-spaces', { x: 250, y: 100, hSType: nonAbove.id, opacity: 0.4 }));
  tx.commit();

  const issues = validate(doc, catalog).filter(i => i.code === 'tester-hide-order');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'warning');
  assert.equal(issues[0].uid, h40.uid);
  assert.equal(issues[0].fix, 'sortHideSpacesByOpacity');
  assert.ok(!issues.some(i => i.uid === h40Far.uid || i.uid === h40UnderAbove.uid));

  // 2. 1-click fix sorts ascending by opacity, clears warning, and undo restores order
  const orderBefore = doc.layers['hide-spaces'].map(o => o.uid);
  const txFix = doc.begin('Fix hide-space order');
  ops.applyFix(doc, catalog, issues[0]);
  txFix.commit();
  assert.equal(validate(doc, catalog).filter(i => i.code === 'tester-hide-order').length, 0);
  assert.ok(doc.layers['hide-spaces'].indexOf(h40) < doc.layers['hide-spaces'].indexOf(h100));
  doc.history.undo();
  assert.deepEqual(doc.layers['hide-spaces'].map(o => o.uid), orderBefore);

  // 3. 40% already before 100% -> does NOT trigger
  const docOk = new MapDocument({ width: 40, height: 40 });
  const txOk = docOk.begin('ordered');
  docOk.add(createObject('H', 'hide-spaces', { x: 100, y: 100, hSType: nonAbove.id, opacity: 0.4 }));
  docOk.add(createObject('H', 'hide-spaces', { x: 100, y: 100, hSType: nonAbove.id, opacity: 1 }));
  txOk.commit();
  assert.equal(validate(docOk, catalog).filter(i => i.code === 'tester-hide-order').length, 0);

  // 4. Layer panel opacity filter (0..1 and 1..100%)
  const { parseLayerQuery, matchesLayerFilter } = await import('../src/ui/panels.js');
  assert.equal(matchesLayerFilter(h40, parseLayerQuery('opacity<1')), true);
  assert.equal(matchesLayerFilter(h100, parseLayerQuery('opacity<1')), false);
  assert.equal(matchesLayerFilter(h40, parseLayerQuery('op=40')), true);
  assert.equal(matchesLayerFilter(h40, parseLayerQuery('op<=0.4')), true);
  assert.equal(matchesLayerFilter(h40, parseLayerQuery('op=40%')), true);
  assert.equal(matchesLayerFilter(h100, parseLayerQuery('op=40')), false);
});

test('Renderer.renderScene respects per-object objectAlpha across same-layer objects and water borders', async () => {
  const { Renderer } = await import('../src/engine/render.js');
  const { LAYERS } = await import('../src/engine/layers.js');

  const alphaStack = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'miter',
    setTransform() {},
    clearRect() {},
    fillRect() {},
    strokeRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    rect() {},
    arc() {},
    fill() {},
    stroke() {},
    translate() {},
    rotate() {},
    scale() {},
    setLineDash() {},
    drawImage() {},
    fillText() {},
    measureText: () => ({ width: 10 }),
    createPattern: () => null,
    createLinearGradient: () => ({ addColorStop() {} }),
    save() { alphaStack.push(this.globalAlpha); },
    restore() { if (alphaStack.length) this.globalAlpha = alphaStack.pop(); }
  };
  const canvas = { width: 200, height: 200, style: {}, getContext: () => ctx };
  const assets = {
    texture: () => null,
    textureFrameWidth: () => 64,
    spriteFor: () => null,
    image: () => null
  };

  const doc = new MapDocument({ width: 20, height: 20 });
  const tx = doc.begin('seed focus render');
  const t1 = doc.add(createObject('Ter', 'terrains', { points: rectPts(10, 10, 40, 40), texture: 5 }));
  const t2 = doc.add(createObject('Ter', 'terrains', { points: rectPts(70, 10, 40, 40), texture: 5 }));
  const p1 = doc.add(createObject('P', 'props', { x: 140, y: 40, pType: 1 }));
  const w1 = doc.add(createObject('Wat', 'water', { points: rectPts(0, 80, 200, 120), hasBorder: true }));
  tx.commit();

  const r = new Renderer(canvas, { catalog, assets });
  r.width = 200;
  r.height = 200;

  const drawn = new Map();
  const borderAlphas = [];
  const origDraw = r.drawObject.bind(r);
  r.drawObject = (obj, outline) => {
    drawn.set(obj.uid, ctx.globalAlpha);
    return origDraw(obj, outline);
  };
  const origStrips = r.strips.bind(r);
  r.strips = (list, color) => {
    if (list.length) borderAlphas.push(ctx.globalAlpha);
    return origStrips(list, color);
  };

  const visible = new Set(LAYERS.map(l => l.id));

  // 1. Without objectAlpha (e.g. minimap / screenshot), falls back to layerAlpha
  drawn.clear(); borderAlphas.length = 0;
  r.renderScene({ doc, visible, layerAlpha: () => 1, outline: false });
  assert.equal(drawn.get(t1.uid), 1);
  assert.equal(drawn.get(t2.uid), 1);
  assert.equal(drawn.get(p1.uid), 1);
  assert.equal(drawn.get(w1.uid), 1);
  assert.ok(borderAlphas.length > 0 && borderAlphas.every(a => a === 1));

  // 2. With objectAlpha isolating t1: t1 = 1, t2 (same layer!) = 0.25, p1 = 0.25, w1 & borders = 0.25
  drawn.clear(); borderAlphas.length = 0;
  r.renderScene({
    doc,
    visible,
    layerAlpha: id => (id === 'terrains' ? 1 : 0.25),
    objectAlpha: o => (o.uid === t1.uid ? 1 : 0.25),
    outline: false
  });
  assert.equal(drawn.get(t1.uid), 1);
  assert.equal(drawn.get(t2.uid), 0.25);
  assert.equal(drawn.get(p1.uid), 0.25);
  assert.equal(drawn.get(w1.uid), 0.25);
  assert.ok(borderAlphas.length > 0 && borderAlphas.every(a => a === 0.25));

  // 3. Selecting w1 keeps water and its border strips at 1 while terrains dim to 0.25
  drawn.clear(); borderAlphas.length = 0;
  r.renderScene({
    doc,
    visible,
    layerAlpha: id => (id === 'water' ? 1 : 0.25),
    objectAlpha: o => (o.uid === w1.uid ? 1 : 0.25),
    outline: false
  });
  assert.equal(drawn.get(w1.uid), 1);
  assert.equal(drawn.get(t1.uid), 0.25);
  assert.equal(drawn.get(t2.uid), 0.25);
  assert.ok(borderAlphas.length > 0 && borderAlphas.every(a => a === 1));
});

test('Cu current direction matches official Mapmaker (0=right, 90=down, 180=left, -90/270=up)', async () => {
  const { Renderer, currentArrowRotation, currentDirectionVector } = await import('../src/engine/render.js');

  // 1. Direction unit vectors in world/screen space (+x right, +y down) and up-pointing arrow.png rotation
  const cases = [
    { angle: 0, dx: 1, dy: 0, arrowDeg: 90 },
    { angle: 90, dx: 0, dy: 1, arrowDeg: 180 },
    { angle: 180, dx: -1, dy: 0, arrowDeg: 270 },
    { angle: -90, dx: 0, dy: -1, arrowDeg: 0 },
    { angle: 270, dx: 0, dy: -1, arrowDeg: 360 }
  ];
  for (const c of cases) {
    const v = currentDirectionVector(c.angle);
    assert.ok(Math.abs(v.x - c.dx) < 1e-9, `angle ${c.angle} dx`);
    assert.ok(Math.abs(v.y - c.dy) < 1e-9, `angle ${c.angle} dy`);
    assert.equal(currentArrowRotation(c.angle), c.arrowDeg, `angle ${c.angle} arrow rotation`);
  }

  // 2. Renderer draws ui/arrow.png rotated by (angle + 90) deg and centered vertically on the pivot
  const rotations = [];
  const drawImages = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    fill() {}, stroke() {}, save() {}, restore() {}, translate() {},
    rotate(rad) { rotations.push(rad); },
    drawImage(_img, x, y, w, h) { drawImages.push({ x, y, w, h }); }
  };
  const canvas = { width: 200, height: 200, style: {}, getContext: () => ctx };
  const fakeArrow = { width: 50, height: 100 };
  const assets = { image: rel => (rel === 'ui/arrow.png' ? fakeArrow : null) };
  const r = new Renderer(canvas, { catalog, assets });
  r.view = { cx: 50, cy: 50, zoom: 1 };

  for (const c of cases) {
    rotations.length = 0;
    drawImages.length = 0;
    const cu = createObject('Cu', 'currents', { points: rectPts(0, 0, 100, 100), settings: { angle: c.angle, strength: 25 } });
    r.drawPolygonObject(cu, false);
    assert.equal(rotations.length, 1);
    assert.ok(Math.abs(rotations[0] - c.arrowDeg * Math.PI / 180) < 1e-9, `canvas rotate for ${c.angle}`);
    assert.equal(drawImages.length, 1);
    assert.ok(Math.abs(drawImages[0].x + drawImages[0].w / 2) < 1e-9, 'arrow horizontally centered');
    assert.ok(Math.abs(drawImages[0].y + drawImages[0].h / 2) < 1e-9, 'arrow vertically centered');
  }

  // 3. ops.rotate and ops.flip keep Cu.settings.angle aligned with transformed geometry
  const doc = new MapDocument({ width: 20, height: 20 });
  const tx0 = doc.begin('seed cu');
  const cu = doc.add(createObject('Cu', 'currents', { points: rectPts(20, 20, 40, 40), settings: { angle: 0, strength: 50 } }));
  tx0.commit();
  const pivot = { x: 40, y: 40 };

  let tx = doc.begin('rot90'); ops.rotate(doc, [cu], 90, pivot); tx.commit();
  assert.equal(cu.settings.angle, 90);
  tx = doc.begin('rot90 again'); ops.rotate(doc, [cu], 90, pivot); tx.commit();
  assert.equal(cu.settings.angle, 180);
  tx = doc.begin('rot90 third'); ops.rotate(doc, [cu], 90, pivot); tx.commit();
  assert.equal(cu.settings.angle, -90);
  tx = doc.begin('flipV'); ops.flip(doc, [cu], 'v', pivot); tx.commit();
  assert.equal(cu.settings.angle, 90);
  tx = doc.begin('set45'); doc.touch(cu); cu.settings.angle = 45; tx.commit();
  tx = doc.begin('flipH'); ops.flip(doc, [cu], 'h', pivot); tx.commit();
  assert.equal(cu.settings.angle, 135);
  tx = doc.begin('flipV2'); ops.flip(doc, [cu], 'v', pivot); tx.commit();
  assert.equal(cu.settings.angle, -135);

  // 4. DPM export preserves Cu settings unchanged
  const exported = exportMap(doc).screenObjects.find(o => o.type === 'Cu');
  assert.deepEqual(exported.settings, { angle: -135, strength: 50 });
});
