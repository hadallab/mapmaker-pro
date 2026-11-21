// DPM import/export. Export reproduces MapEditor.toJsonObject() of the official engine:
// layer order, per-class key order, limitDecimals rounding, integer colours.
// Import reproduces MapEditor.fromJsonObject(): unknown layers are skipped, collidable:false
// terrains move to platforms, legacy texture paths are mapped, and spawn counts are trimmed
// the same way the editor trims them after loading.

import { LAYERS, LAYER_BY_ID, KIND_BY_TYPE, TYPES } from './layers.js';
import { limitDecimals, hexToInt } from './geometry.js';
import { clone, syncDerived } from './document.js';

const FOOD_DENSITY = 12.3;

// engine f8a7._oldTextureMap
const OLD_TEXTURE_MAP = {
  'assets/terrains/terrain.png': 1,
  'assets/terrains/terrain_back.png': 2,
  'assets/terrains/coldterrain.png': 3,
  'assets/terrains/coldterrain_back.png': 4,
  'assets/terrains/deepterrain.png': 5,
  'assets/terrains/beach.png': 6,
  'assets/terrains/swamp/island.png': 8,
  'assets/terrains/glacier.png': 9
};

export const DEFAULTS = {
  skyColors: ['#cfe9fc', '#87c7f8'],
  water: { colors: ['#003a62', '#031d30'], hasBorder: true },
  borderColor: '#003a62',
  opacity: 0.9,
  food: { foodIds: [], count: 0, firstSpawnMs: 0, reSpawnMs: 1000, area: 10, onlyOnWater: false },
  npc: { fishLevels: [], animalCount: 10, firstSpawnMs: 0, reSpawnMs: 2000, npcType: 1, restrictMovement: false },
  current: { angle: 0, strength: 10 },
  terrainFood: { foodIds: [], count: 0, firstSpawnMs: 0, reSpawnMs: 1000 }
};

const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export function foodBudget(worldSize) {
  return worldSize.width * worldSize.height / FOOD_DENSITY;
}

export function npcBudget(worldSize) {
  return Math.min(200, worldSize.width * worldSize.height / 200);
}

export function totalFood(doc) {
  return doc.layers['food-spawns'].reduce((s, o) => s + num(o.settings.count), 0);
}

export function totalNpc(doc) {
  return doc.layers['npc-spawns'].reduce((s, o) => s + num(o.settings.animalCount), 0);
}

// engine 309f.refreshArea: area follows the box and count is capped per box.
export function foodBoxCap(obj) {
  return Math.floor(Math.max(40, (obj.size.width * obj.size.height / 100) / FOOD_DENSITY));
}

export function refreshFoodArea(obj) {
  obj.settings.area = obj.size.width * obj.size.height / 100;
  obj.settings.count = Math.floor(Math.min(Math.max(40, obj.settings.area / FOOD_DENSITY), num(obj.settings.count)));
}

// ---------------------------------------------------------------- factories

export function createObject(type, layerId, init = {}) {
  const obj = { type, layerId };
  switch (type) {
    case 'Ter':
      obj.points = init.points || [];
      obj.texture = init.texture ?? 1;
      if (layerId === 'terrains') obj.foodSpawnSettings = clone(DEFAULTS.terrainFood);
      obj.settings = { collidable: layerId !== 'platforms' };
      break;
    case 'Bg':
      obj.points = init.points || [];
      obj.texture = init.texture ?? 1;
      obj.settings = { collidable: true };
      obj.opacity = init.opacity ?? DEFAULTS.opacity;
      break;
    case 'C':
      obj.points = init.points || [];
      obj.texture = init.texture ?? 1;
      obj.settings = { collidable: true };
      break;
    case 'Air':
      obj.points = init.points || [];
      obj.texture = init.texture ?? 1;
      obj.settings = { collidable: true };
      obj.borderColor = hexToInt(init.borderColor ?? DEFAULTS.borderColor);
      break;
    case 'Sky':
      obj.points = init.points || [];
      obj.settings = { collidable: true };
      obj.colors = (init.colors || DEFAULTS.skyColors).map(hexToInt);
      break;
    case 'Wat':
      obj.points = init.points || [];
      obj.settings = { collidable: true };
      obj.colors = (init.colors || DEFAULTS.water.colors).map(hexToInt);
      obj.hasBorder = init.hasBorder ?? DEFAULTS.water.hasBorder;
      break;
    case 'Cu':
      obj.points = init.points || [];
      obj.settings = { ...DEFAULTS.current, ...(init.settings || {}) };
      break;
    case 'Hab':
      obj.position = init.position || { x: 0, y: 0 };
      obj.size = init.size || { width: 10, height: 10 };
      obj.settings = { area: init.settings?.area ?? 0 };
      break;
    case 'Food':
      obj.position = init.position || { x: 0, y: 0 };
      obj.size = init.size || { width: 10, height: 10 };
      obj.settings = { ...clone(DEFAULTS.food), ...clone(init.settings || {}) };
      refreshFoodArea(obj);
      break;
    case 'NPC':
      obj.position = init.position || { x: 0, y: 0 };
      obj.size = init.size || { width: 10, height: 10 };
      obj.settings = { ...clone(DEFAULTS.npc), ...clone(init.settings || {}) };
      break;
    case 'Tr':
      obj.position = init.position || { x: 0, y: 0 };
      obj.size = init.size || { width: 10, height: 10 };
      obj.triggers = clone(init.triggers || []);
      break;
    case 'H':
      obj.x = init.x ?? 0; obj.y = init.y ?? 0; obj.rotation = init.rotation ?? 0;
      obj.hSType = init.hSType ?? 1;
      obj.opacity = init.opacity ?? 1;
      break;
    case 'A':
      obj.x = init.x ?? 0; obj.y = init.y ?? 0; obj.rotation = init.rotation ?? 0;
      obj.fLevel = init.fLevel ?? 0;
      break;
    case 'P':
      obj.x = init.x ?? 0; obj.y = init.y ?? 0; obj.rotation = init.rotation ?? 0;
      obj.pType = init.pType ?? 1;
      obj.params = init.params ?? null;
      break;
    default:
      throw new Error('Unknown object type ' + type);
  }
  syncDerived(obj);
  return obj;
}

// ---------------------------------------------------------------- import

function readPoints(list) {
  return (Array.isArray(list) ? list : []).map(p => ({ x: num(p?.x), y: num(p?.y) }));
}

function readTexture(value) {
  if (value == null) return null;
  if (isNaN(value)) return OLD_TEXTURE_MAP[value] ?? null;
  return Number(value);
}

// Converts one native screen object into an editor object. Returns null when the
// official editor would skip it, with the reason in `notes`.
function readObject(src, notes) {
  if (!src || typeof src !== 'object') { notes.push('Skipped a non-object entry'); return null; }
  let layerId = src.layerId;
  const type = src.type;
  if (!LAYER_BY_ID[layerId]) { notes.push(`Skipped ${type} #${src.id}: unknown layer "${layerId}" (the official editor ignores it)`); return null; }
  if (!Object.values(TYPES).includes(type)) {
    notes.push(`Skipped #${src.id}: unknown type "${type}" (the official editor would fail to open this file)`);
    return null;
  }

  if (type === 'Ter' && src.settings && !src.settings.collidable && layerId === 'terrains') {
    layerId = 'platforms';
    notes.push(`Ter #${src.id}: collidable:false on terrains moved to platforms (official import behaviour)`);
  }

  const kind = KIND_BY_TYPE[type];
  const obj = { type, layerId, sourceId: src.id };
  if (kind === 'poly') {
    obj.points = readPoints(src.points);
    if (type === 'Ter' || type === 'Bg' || type === 'C' || type === 'Air') {
      obj.texture = readTexture(src.texture);
    }
    if (type === 'Ter') {
      // engine: foodSpawnSettings created for every Ter constructed on the terrains layer,
      // then overwritten by the file's settings if present.
      if (src.foodSpawnSettings) obj.foodSpawnSettings = { ...clone(src.foodSpawnSettings), foodIds: [...(src.foodSpawnSettings.foodIds || [])] };
      else if (layerId === 'terrains') obj.foodSpawnSettings = clone(DEFAULTS.terrainFood);
    }
    obj.settings = src.settings ? { ...clone(src.settings) } : (type === 'Cu' ? { ...DEFAULTS.current } : { collidable: true });
    if (type === 'Bg') obj.opacity = src.opacity;
    if (type === 'Air') obj.borderColor = hexToInt(src.borderColor);
    if (type === 'Sky' || type === 'Wat') obj.colors = (src.colors || []).map(hexToInt);
    if (type === 'Wat') obj.hasBorder = src.hasBorder;
  } else if (kind === 'rect') {
    obj.position = { x: num(src.position?.x), y: num(src.position?.y) };
    obj.size = { width: num(src.size?.width), height: num(src.size?.height) };
    if (type === 'Hab') obj.settings = { area: num(src.settings?.area) };
    // engine 309f/168f.setSettings copy the file's settings as-is (no defaults);
    // Food then runs refreshArea(), NPC.fromJsonObject defaults restrictMovement.
    if (type === 'Food') {
      obj.settings = { ...clone(src.settings || {}), foodIds: [...(src.settings?.foodIds || [])] };
      refreshFoodArea(obj);
    }
    if (type === 'NPC') {
      const s = clone(src.settings || {});
      s.restrictMovement = s.restrictMovement || false;
      obj.settings = { ...s, fishLevels: [...(s.fishLevels || [])] };
    }
    if (type === 'Tr') obj.triggers = clone(src.triggers || []);
  } else {
    obj.x = num(src.x); obj.y = num(src.y);
    obj.rotation = num(src.rotation);
    if (type === 'H') { obj.hSType = num(src.hSType); obj.opacity = src.opacity ?? 1; }
    if (type === 'A') obj.fLevel = num(src.fLevel);
    if (type === 'P') { obj.pType = num(src.pType); obj.params = src.params === undefined ? null : clone(src.params); }
  }
  syncDerived(obj);
  return obj;
}

// Applies the editor's spawn budgets the way MapEditor does when a map is opened:
// each spawn is first capped by the whole-world budget, then everything is trimmed
// proportionally (trimNpcCount / trimFoodCount).
export function applyLoadQuotas(worldSize, objects, notes = []) {
  const foods = objects.filter(o => o.type === 'Food');
  const npcs = objects.filter(o => o.type === 'NPC');
  const foodAvail = Math.floor(Math.max(0, foodBudget(worldSize)));
  const npcAvail = Math.floor(Math.max(0, npcBudget(worldSize)));
  for (const o of foods) {
    const before = num(o.settings.count);
    o.settings.count = Math.min(before, foodAvail);
  }
  for (const o of npcs) {
    const before = num(o.settings.animalCount);
    o.settings.animalCount = Math.min(before, npcAvail);
  }
  trim(foods, 'count', foodBudget(worldSize), 'food', notes);
  trim(npcs, 'animalCount', npcBudget(worldSize), 'NPC', notes);
}

function trim(list, key, budget, label, notes) {
  const total = list.reduce((s, o) => s + num(o.settings[key]), 0);
  const avail = budget - total;
  if (avail >= 0) return;
  for (const o of list) {
    const share = num(o.settings[key]) / total;
    o.settings[key] = Math.max(0, num(o.settings[key]) - Math.ceil(Math.abs(avail) * share));
  }
  notes.push(`${label} total ${total} exceeded the world budget ${Math.floor(budget)}; trimmed proportionally like the official editor`);
}

export function parseDpm(text) {
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error('Not a valid DPM/JSON file: ' + e.message); }
  if (json && typeof json.data === 'string' && !json.screenObjects) {
    // API map record: { data: "<serialized DPM>" }
    json = JSON.parse(json.data);
  }
  if (!json || !Array.isArray(json.screenObjects) || !json.worldSize) throw new Error('File has no screenObjects/worldSize; it is not a Mapmaker map');
  return json;
}

export function importMap(json, { applyQuotas = true } = {}) {
  const notes = [];
  const worldSize = { width: num(json.worldSize.width, 200), height: num(json.worldSize.height, 200) };
  const settings = { gravity: num(json.settings?.gravity, 9.8) };
  if (!json.settings) notes.push('No world settings in file; default gravity 9.8 used (official resetWorldSettings)');
  const objects = [];
  for (const src of json.screenObjects) {
    const obj = readObject(src, notes);
    if (obj) objects.push(obj);
  }
  // Group by layer keeping file order inside each layer (the editor appends children per layer).
  const ordered = [];
  for (const layer of LAYERS) for (const o of objects) if (o.layerId === layer.id) ordered.push(o);
  if (applyQuotas) {
    const before = ordered.map(o => o.type === 'Food' ? o.settings.count : o.type === 'NPC' ? o.settings.animalCount : null);
    applyLoadQuotas(worldSize, ordered, notes);
    ordered.forEach((o, i) => {
      const after = o.type === 'Food' ? o.settings.count : o.type === 'NPC' ? o.settings.animalCount : null;
      if (before[i] !== after && before[i] != null && Number(before[i]) !== after) {
        notes.push(`${o.type} #${o.sourceId}: ${before[i]} -> ${after}`);
      }
    });
  }
  return { worldSize, settings, objects: ordered, notes };
}

// ---------------------------------------------------------------- export

const L3 = v => limitDecimals(num(v), 3);

function exportPoints(points) {
  return points.map(p => ({ x: L3(p.x), y: L3(p.y) }));
}

export function exportObject(obj, id) {
  const out = { id, type: obj.type, layerId: obj.layerId };
  const kind = KIND_BY_TYPE[obj.type];
  if (kind === 'poly' || kind === 'rect') out.points = exportPoints(obj.points);
  switch (obj.type) {
    case 'Ter':
      if (obj.texture != null) out.texture = obj.texture;
      if (obj.foodSpawnSettings) out.foodSpawnSettings = clone(obj.foodSpawnSettings);
      out.settings = clone(obj.settings);
      break;
    case 'Bg':
      if (obj.texture != null) out.texture = obj.texture;
      out.settings = clone(obj.settings);
      if (obj.opacity !== undefined) out.opacity = obj.opacity;
      break;
    case 'C':
      if (obj.texture != null) out.texture = obj.texture;
      out.settings = clone(obj.settings);
      break;
    case 'Air':
      if (obj.texture != null) out.texture = obj.texture;
      out.settings = clone(obj.settings);
      out.borderColor = obj.borderColor;
      break;
    case 'Sky':
      out.settings = clone(obj.settings);
      out.colors = obj.colors.map(hexToInt);
      break;
    case 'Wat':
      out.settings = clone(obj.settings);
      out.colors = obj.colors.map(hexToInt);
      out.hasBorder = obj.hasBorder;
      break;
    case 'Cu':
      out.settings = clone(obj.settings);
      break;
    case 'Hab': case 'Food': case 'NPC': case 'Tr':
      out.position = { x: L3(obj.position.x), y: L3(obj.position.y) };
      out.size = { width: L3(obj.size.width), height: L3(obj.size.height) };
      if (obj.type === 'Tr') out.triggers = clone(obj.triggers);
      else out.settings = clone(obj.settings);
      break;
    case 'H':
      out.x = L3(obj.x); out.y = L3(obj.y); out.rotation = limitDecimals(num(obj.rotation), 2);
      out.hSType = obj.hSType;
      if (obj.opacity !== 1) out.opacity = obj.opacity;
      break;
    case 'A':
      out.x = L3(obj.x); out.y = L3(obj.y); out.rotation = limitDecimals(num(obj.rotation), 2);
      out.fLevel = obj.fLevel;
      break;
    case 'P':
      out.x = L3(obj.x); out.y = L3(obj.y); out.rotation = limitDecimals(num(obj.rotation), 2);
      out.pType = obj.pType;
      out.params = obj.params === undefined ? null : clone(obj.params);
      break;
  }
  return out;
}

export function exportMap(doc) {
  const screenObjects = [];
  let id = 1;
  for (const layer of LAYERS) for (const obj of doc.layers[layer.id]) screenObjects.push(exportObject(obj, id++));
  return {
    screenObjects,
    settings: { gravity: num(doc.settings.gravity, 9.8) },
    worldSize: { width: doc.worldSize.width, height: doc.worldSize.height }
  };
}

export function serializeDpm(doc) {
  return JSON.stringify(exportMap(doc));
}
