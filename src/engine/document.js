// Map document: layered object store with transactional, per-object undo history.
// Objects keep the official Mapmaker field names so export is a direct projection.

import { LAYERS, LAYER_BY_ID, KIND_BY_TYPE } from './layers.js';
import { bounds, rotatePoint } from './geometry.js';

export const clone = typeof structuredClone === 'function'
  ? structuredClone
  : value => JSON.parse(JSON.stringify(value));

export class MapDocument {
  constructor({ width = 200, height = 200, gravity = 9.8 } = {}) {
    this.worldSize = { width, height };
    this.settings = { gravity };
    this.layers = Object.fromEntries(LAYERS.map(l => [l.id, []]));
    this.byUid = new Map();
    this.nextUid = 1;
    this.revision = 0;
    this.history = new History(this);
    this.listeners = new Set();
  }

  get pixelWidth() { return this.worldSize.width * 10; }
  get pixelHeight() { return this.worldSize.height * 10; }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed(reason = 'edit') {
    this.revision++;
    for (const fn of this.listeners) fn(reason);
  }

  // ---- queries ----
  get(uid) { return this.byUid.get(uid) || null; }

  *objects() {
    for (const layer of LAYERS) yield* this.layers[layer.id];
  }

  count() { return this.byUid.size; }

  indexOf(obj) { return this.layers[obj.layerId].indexOf(obj); }

  // ---- raw mutations (always called inside a transaction) ----
  insert(obj, index = null) {
    if (!LAYER_BY_ID[obj.layerId]) throw new Error('Unknown layer ' + obj.layerId);
    if (!obj.uid) obj.uid = this.nextUid++;
    else this.nextUid = Math.max(this.nextUid, obj.uid + 1);
    const list = this.layers[obj.layerId];
    if (index == null || index > list.length) list.push(obj);
    else list.splice(Math.max(0, index), 0, obj);
    this.byUid.set(obj.uid, obj);
    syncDerived(obj);
    return obj;
  }

  detach(obj) {
    const list = this.layers[obj.layerId];
    const i = list.indexOf(obj);
    if (i >= 0) list.splice(i, 1);
    this.byUid.delete(obj.uid);
    return i;
  }

  // ---- transactional API ----
  begin(label) { return this.history.begin(label); }

  add(obj, index = null) {
    this.history.touchNew(obj);
    return this.insert(obj, index);
  }

  remove(obj) {
    this.history.touch(obj);
    this.detach(obj);
  }

  touch(obj) { this.history.touch(obj); return obj; }

  // Move an object to a new position inside its layer (draw order).
  reorder(obj, index) {
    this.history.touch(obj);
    const list = this.layers[obj.layerId];
    const i = list.indexOf(obj);
    list.splice(i, 1);
    list.splice(Math.max(0, Math.min(index, list.length)), 0, obj);
  }

  // Move to another layer of the same native type (e.g. terrains -> platforms).
  relayer(obj, layerId) {
    this.history.touch(obj);
    this.history.touchLayer(layerId);
    this.detach(obj);
    obj.layerId = layerId;
    this.insert(obj);
  }

  setWorld(size, settings) {
    this.history.touchWorld();
    if (size) this.worldSize = { width: size.width, height: size.height };
    if (settings) this.settings = { ...this.settings, ...settings };
  }

  // Replace everything (used by import / new).
  load({ worldSize, settings, objects }) {
    this.worldSize = { width: worldSize.width, height: worldSize.height };
    this.settings = { ...settings };
    for (const layer of LAYERS) this.layers[layer.id] = [];
    this.byUid.clear();
    this.nextUid = 1;
    for (const obj of objects) this.insert(obj);
    this.history.clear();
    this.changed('load');
  }
}

// ---- derived geometry ----

export function syncDerived(obj) {
  const kind = KIND_BY_TYPE[obj.type];
  if (kind === 'rect') {
    const { x, y } = obj.position, { width, height } = obj.size;
    obj.points = [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
  }
}

export function objectBounds(obj, catalog) {
  const kind = KIND_BY_TYPE[obj.type];
  if (kind === 'sprite') {
    const s = spriteSize(obj, catalog);
    const corners = spriteCorners(obj, s);
    return bounds(corners);
  }
  return bounds(obj.points);
}

export function spriteSize(obj, catalog) {
  if (obj.type === 'H') {
    const h = catalog.hideSpaceById.get(obj.hSType);
    return h ? { width: h.width * 10, height: h.height * 10, ax: h.anchorX, ay: h.anchorY } : { width: 20, height: 20, ax: 0.5, ay: 0.5 };
  }
  if (obj.type === 'P') {
    const p = catalog.propById.get(obj.pType);
    return p ? { width: p.width * 10, height: p.height * 10, ax: p.anchorX, ay: p.anchorY } : { width: 20, height: 20, ax: 0.5, ay: 0.5 };
  }
  const a = catalog.animalByLevel.get(obj.fLevel);
  if (!a || !a.width) return { width: 20, height: 20, ax: 0.5, ay: 0.5 };
  // engine f2cd: texture * (48/180, 68/255) * sizeMultiplier / 10
  let m = a.sizeMultiplier;
  if (a.clientSideSizeScale != null) m *= a.clientSideSizeScale;
  return { width: a.width * (48 / 180) * m / 10, height: a.height * (68 / 255) * m / 10, ax: 0.5, ay: 0.5 };
}

// Sprite geometry follows engine cdd1: the image is centred on the object position after
// shifting by the anchor (inner pivot), then rotated about the object position.
export function spriteCorners(obj, size) {
  const { width: w, height: h, ax, ay } = size;
  const ox = -(w * ax - w / 2), oy = -(h * ay - h / 2);
  const local = [
    { x: -w / 2 + ox, y: -h / 2 + oy }, { x: w / 2 + ox, y: -h / 2 + oy },
    { x: w / 2 + ox, y: h / 2 + oy }, { x: -w / 2 + ox, y: h / 2 + oy }
  ];
  const r = (obj.rotation || 0) * Math.PI / 180;
  return local.map(p => rotatePoint({ x: obj.x + p.x, y: obj.y + p.y }, obj.x, obj.y, r));
}

// ---- history ----

class History {
  constructor(doc) {
    this.doc = doc;
    this.undoStack = [];
    this.redoStack = [];
    this.open = null;
    this.depth = 0;
    this.limit = 200;
  }

  clear() { this.undoStack = []; this.redoStack = []; this.open = null; this.depth = 0; }

  begin(label) {
    if (this.depth++ === 0) this.open = { label, before: new Map(), orders: new Map(), world: null };
    const tx = this;
    return {
      commit: () => tx.end(true),
      cancel: () => tx.end(false)
    };
  }

  // Layer order is recorded as uid lists so restoring several objects never depends
  // on the order in which they were touched.
  touchLayer(layerId) {
    if (!this.open.orders.has(layerId)) this.open.orders.set(layerId, this.doc.layers[layerId].map(o => o.uid));
  }

  touch(obj) {
    if (!this.open) throw new Error('Edit outside a transaction');
    this.touchLayer(obj.layerId);
    if (!this.open.before.has(obj.uid) && this.doc.byUid.has(obj.uid)) this.open.before.set(obj.uid, clone(obj));
  }

  touchNew(obj) {
    if (!this.open) throw new Error('Edit outside a transaction');
    if (!obj.uid) obj.uid = this.doc.nextUid++;
    this.touchLayer(obj.layerId);
    if (!this.open.before.has(obj.uid)) this.open.before.set(obj.uid, null);
  }

  touchWorld() {
    if (!this.open) throw new Error('Edit outside a transaction');
    if (!this.open.world) this.open.world = { worldSize: { ...this.doc.worldSize }, settings: { ...this.doc.settings } };
  }

  end(keep) {
    if (--this.depth > 0) return;
    const tx = this.open;
    this.open = null;
    if (!tx) return;
    if (!keep) {
      this.restore(tx.before, tx.orders, tx.world);
      this.doc.changed('cancel');
      return;
    }
    // Lets the editor make dependent edits (live symmetry) inside the same undo step.
    if (this.doc.beforeCommit) {
      this.open = tx; this.depth = 1;
      try { this.doc.beforeCommit(tx.before, tx.label); } finally { this.open = null; this.depth = 0; }
    }
    const after = new Map();
    for (const uid of tx.before.keys()) {
      const obj = this.doc.byUid.get(uid);
      after.set(uid, obj ? clone(obj) : null);
    }
    const ordersAfter = new Map([...tx.orders.keys()].map(id => [id, this.doc.layers[id].map(o => o.uid)]));
    const worldAfter = tx.world ? { worldSize: { ...this.doc.worldSize }, settings: { ...this.doc.settings } } : null;
    const orderChanged = [...tx.orders].some(([id, list]) => list.join() !== ordersAfter.get(id).join());
    const meaningful = tx.world || orderChanged ||
      [...tx.before].some(([uid, b]) => JSON.stringify(b) !== JSON.stringify(after.get(uid)));
    if (meaningful) {
      this.undoStack.push({ label: tx.label, before: tx.before, orders: tx.orders, after, ordersAfter, world: tx.world, worldAfter });
      if (this.undoStack.length > this.limit) this.undoStack.shift();
      this.redoStack = [];
    }
    this.doc.changed(tx.label || 'edit');
  }

  restore(states, orders, world) {
    const doc = this.doc;
    for (const uid of states.keys()) doc.byUid.delete(uid);
    for (const [uid, data] of states) {
      if (!data) continue;
      const obj = clone(data);
      doc.byUid.set(uid, obj);
      syncDerived(obj);
    }
    for (const [layerId, uids] of orders) {
      doc.layers[layerId] = uids.map(uid => doc.byUid.get(uid)).filter(o => o && o.layerId === layerId);
    }
    if (world) {
      doc.worldSize = { ...world.worldSize };
      doc.settings = { ...world.settings };
    }
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { return this.undoStack.at(-1)?.label || ''; }
  get redoLabel() { return this.redoStack.at(-1)?.label || ''; }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.restore(entry.before, entry.orders, entry.world);
    this.redoStack.push(entry);
    this.doc.changed('undo');
    return entry;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.restore(entry.after, entry.ordersAfter, entry.worldAfter);
    this.undoStack.push(entry);
    this.doc.changed('redo');
    return entry;
  }
}
