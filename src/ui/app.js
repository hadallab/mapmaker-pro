// Mapmaker Pro editor core: state, commands, hit testing, file workflow and render loop.

import { MapDocument, objectBounds, spriteSize, spriteCorners, clone } from '../engine/document.js';
import { LAYERS, LAYER_BY_ID, KIND_BY_TYPE, Z_ORDER } from '../engine/layers.js';
import { buildCatalog } from '../engine/catalog.js';
import rawCatalog from '../data/catalog.js';
import { AssetStore } from '../engine/assets.js';
import { Renderer } from '../engine/render.js';
import { parseDpm, importMap, serializeDpm, createObject, totalFood, totalNpc, foodBudget, npcBudget } from '../engine/dpm.js';
import { validate, summarize } from '../engine/validate.js';
import { pointInPolygon, distanceToSegment } from '../engine/geometry.js';
import * as ops from '../engine/ops.js';
import { host } from './host.js';
import { createTools, TOOL_DEFS, toolAllowed } from './tools.js';
import { buildChrome } from './chrome.js';
import { buildPanels } from './panels.js';
import * as dialogs from './dialogs.js';
import { h, nextFrame } from './dom.js';
import { EditorMeta } from './meta.js';
import { Simulation } from './simulation.js';
import { drawBlocks, preloadBlocks } from './blocks.js';
import { loadPreferences, bindUpdateEvents } from './preferences.js';
import { createGradientHandles } from './gradient-handles.js';
import { DrawInside } from './draw-inside.js';
import { drawInspectorOverlay, isInspectClick, openPixelStack } from './inspector.js';
import { createLens } from './lens.js';

const CLIP_MARK = 'mapmaker-pro/objects@1';

// Same steps as LOADER in main.cjs and loadMapFromMapmakerPro in mapmaker-pro.user.js:
// what MapEditor.onMapChanged does after opening a map.
const MAPMAKER_LOADER = `async (map) => {
    const app = window.app;
    if (!app || typeof app.fromJsonObject !== 'function') throw new Error('Run this on mapmaker.deeeep.io');
    await app.fromJsonObject(map);
    if (typeof app.trimNpcCount === 'function') app.trimNpcCount();
    if (typeof app.trimFoodCount === 'function') app.trimFoodCount();
    if (app.history && typeof app.history.init === 'function') app.history.init(app.toJsonObject());
    if (window.vueData) window.vueData.mapDirty = true;
    return Object.keys(app.screenObjects).length;
  }`;

export class Editor {
  constructor(catalog, assets) {
    this.catalog = catalog;
    this.assets = assets;
    this.doc = new MapDocument({ width: 200, height: 200 });
    this.viewport = document.getElementById('viewport');
    this.canvas = document.getElementById('scene');
    this.renderer = new Renderer(this.canvas, { catalog, assets });
    this.state = {
      tool: 'select',
      activeLayer: 'terrains',
      visible: new Set(LAYERS.map(l => l.id)),
      locked: new Set(),
      isolate: false,
      outline: false,
      testerPreview: false,
      view: { testerPreview: false },
      grid: false,
      snapGrid: false,
      snapPoints: true,
      snapEdges: true,
      gridStep: 10,
      keepInWorld: true,
      smartGuides: true,
      rulers: true,
      minimap: true,
      selection: new Set(),
      points: new Map(),
      file: { path: null, name: 'Untitled.dpm' },
      dirty: false,
      savedRevision: 0,
      cursor: null,
      brush: {
        texture: 5, opacity: 0.9, skyColors: ['#cfe9fc', '#87c7f8'], waterColors: ['#003a62', '#031d30'],
        hasBorder: true, borderColor: '#003a62', hSType: catalog.hideSpaces[0]?.id ?? 1, fLevel: 0, pType: 1,
        segments: 24, sides: 6
      }
    };
    this.issues = [];
    this.listeners = new Map();
    this.clipboard = null;
    this.previewColors = null;
    this.frame = 0;
    this.tools = createTools(this);
    this.tool = this.tools.select;

    this.meta = new EditorMeta(this);
    this.gradientHandles = createGradientHandles(this);
    this.drawInside = new DrawInside(this);
    // Alt+Shift+Click with the selection tool (wired here to keep tools.js free of an import cycle).
    this.inspectClick = e => { if (!isInspectClick(e)) return false; openPixelStack(this, e); return true; };
    preloadBlocks(() => this.requestRender());
    this.doc.beforeCommit = (before, label) => this.meta.beforeCommit(before, label);
    this.doc.on(reason => this.onDocChanged(reason));
    assets.onLoad = () => { this.renderer.patterns.clear(); this.requestRender(); };
  }

  // ---- events ----
  on(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
  }
  emit(name, arg) { for (const fn of this.listeners.get(name) || []) fn(arg); }

  onDocChanged(reason) {
    for (const uid of [...this.state.selection]) if (!this.doc.get(uid)) this.state.selection.delete(uid);
    for (const [uid, set] of [...this.state.points.entries()]) {
      const o = this.doc.get(uid);
      const maxLen = Array.isArray(o?.points) ? o.points.length : 0;
      if (!o || !maxLen) { this.state.points.delete(uid); continue; }
      for (const idx of [...set]) {
        if (!Number.isInteger(idx) || idx < 0 || idx >= maxLen) set.delete(idx);
      }
      if (!set.size) this.state.points.delete(uid);
    }
    this.state.dirty = this.doc.revision !== this.state.savedRevision && reason !== 'load';
    if (reason === 'load') this.state.savedRevision = this.doc.revision;
    this.scheduleValidation();
    this.requestRender();
    this.emit('doc', reason);
    this.emit('selection');
  }

  scheduleValidation() {
    clearTimeout(this.validateTimer);
    this.validateTimer = setTimeout(() => {
      this.issues = validate(this.doc, this.catalog);
      this.emit('issues');
    }, 350);
  }

  requestRender() {
    if (this.frame) return;
    this.frame = nextFrame(() => { this.frame = 0; this.render(); });
  }

  // ---- layer visibility & interactivity (mirrors MapEditor.selectLayer alpha rules) ----
  layerAlpha(id) {
    if (!this.state.visible.has(id)) return 0;
    if (this.state.isolate) return id === this.state.activeLayer ? 1 : 0.25;
    if (LAYER_BY_ID[id].helper && id !== this.state.activeLayer) return 0.4;
    return 1;
  }

  objectAlpha(o) {
    if (!o || !this.state.visible.has(o.layerId)) return 0;
    if (!this.state.isolate) return this.layerAlpha(o.layerId);
    if (this.state.selection.size > 0) return this.state.selection.has(o.uid) ? 1 : 0.25;
    return this.layerAlpha(o.layerId);
  }

  layerInteractive(id) {
    if (!this.state.visible.has(id) || this.state.locked.has(id)) return false;
    if (this.state.isolate) return id === this.state.activeLayer;
    if (LAYER_BY_ID[id].helper) return id === this.state.activeLayer;
    return true;
  }

  setActiveLayer(id) {
    if (!LAYER_BY_ID[id] || this.state.activeLayer === id) return;
    this.state.activeLayer = id;
    const def = TOOL_DEFS[this.state.tool];
    if (!toolAllowed(this.state.tool, id) || (def.layer && def.layer !== id)) this.setTool('select');
    this.emit('layer');
    this.emit('tool');
    this.requestRender();
  }

  _pruneSelectionToLayer(layerId) {
    let changed = false;
    for (const uid of [...this.state.selection]) {
      const o = this.doc.get(uid);
      if (!o || o.layerId !== layerId) {
        this.state.selection.delete(uid);
        this.state.points.delete(uid);
        changed = true;
      }
    }
    return changed;
  }

  setIsolate(on) {
    const next = !!on;
    if (this.state.isolate === next) return;
    this.state.isolate = next;
    if (next && this.state.selection.size > 0) {
      const layers = new Set(this.selected().map(o => o.layerId));
      if (layers.size === 1) {
        const [targetLayer] = layers;
        if (this.state.activeLayer !== targetLayer) {
          this.state.activeLayer = targetLayer;
          const def = TOOL_DEFS[this.state.tool];
          if (!toolAllowed(this.state.tool, targetLayer) || (def.layer && def.layer !== targetLayer)) this.setTool('select');
          this.emit('layer');
          this.emit('tool');
        }
      }
    }
    this.emit('view-options');
    this.requestRender();
  }

  focusLayer(id) {
    if (!LAYER_BY_ID[id]) return;
    const layerChanged = this.state.activeLayer !== id;
    const isoChanged = !this.state.isolate;
    if (layerChanged) {
      this.state.activeLayer = id;
      const def = TOOL_DEFS[this.state.tool];
      if (!toolAllowed(this.state.tool, id) || (def.layer && def.layer !== id)) this.setTool('select');
    }
    this.state.isolate = true;
    const selChanged = this._pruneSelectionToLayer(id);
    if (layerChanged) {
      this.emit('layer');
      this.emit('tool');
    }
    if (selChanged) this.emit('selection');
    if (isoChanged || layerChanged) this.emit('view-options');
    this.requestRender();
  }

  setTool(name) {
    const def = TOOL_DEFS[name];
    if (!def) return;
    if (def.layer) this.setActiveLayerSilently(def.layer);
    else if (!toolAllowed(name, this.state.activeLayer)) {
      const target = def.preferLayer?.(this);
      if (target) this.setActiveLayerSilently(target);
      else { this.toast(`${def.title} is not available on ${LAYER_BY_ID[this.state.activeLayer].title}`); return; }
    }
    this.tool?.deactivate?.();
    this.state.tool = name;
    this.tool = this.tools[name];
    this.tool.activate?.();
    this.viewport.style.cursor = this.tool.cursor || 'default';
    this.emit('tool');
    this.requestRender();
  }

  setActiveLayerSilently(id) {
    if (this.state.activeLayer !== id) {
      this.state.activeLayer = id;
      this.emit('layer');
    }
  }

  // ---- selection ----
  selected() {
    const out = [];
    for (const uid of this.state.selection) { const o = this.doc.get(uid); if (o) out.push(o); }
    return out;
  }

  select(objs, mode = 'replace') {
    const s = this.state.selection;
    if (mode === 'replace') s.clear();
    for (const o of objs) {
      if (mode === 'toggle' && s.has(o.uid)) s.delete(o.uid);
      else s.add(o.uid);
    }
    for (const uid of [...this.state.points.keys()]) if (!s.has(uid)) this.state.points.delete(uid);
    const first = this.selected()[0];
    if (first && mode === 'replace' && objs.length && first.layerId !== this.state.activeLayer && !LAYER_BY_ID[first.layerId].helper) {
      this.setActiveLayerSilently(first.layerId);
    }
    this.emit('selection');
    this.requestRender();
  }

  deselect() {
    if (!this.state.selection.size && !this.state.points.size) return;
    this.state.selection.clear();
    this.state.points.clear();
    this.emit('selection');
    this.requestRender();
  }

  // ---- hit testing ----
  hitTest(world, { activeOnly = false, includeLocked = false } = {}) {
    const tol = 4 / this.renderer.view.zoom;
    const order = LAYERS.slice().sort((a, b) => Z_ORDER[b.id] - Z_ORDER[a.id]);
    for (const layer of order) {
      if (activeOnly && layer.id !== this.state.activeLayer) continue;
      if (!includeLocked && !this.layerInteractive(layer.id)) continue;
      const list = this.doc.layers[layer.id];
      for (let i = list.length - 1; i >= 0; i--) {
        if (this.hits(list[i], world, tol)) return list[i];
      }
    }
    return null;
  }

  hits(o, w, tol) {
    const kind = KIND_BY_TYPE[o.type];
    if (kind === 'sprite') return pointInPolygon(w.x, w.y, spriteCorners(o, spriteSize(o, this.catalog)));
    const pts = o.points;
    if (pts.length < 3) return false;
    if (pointInPolygon(w.x, w.y, pts)) return true;
    for (let i = 0; i < pts.length; i++) {
      if (distanceToSegment(w, pts[i], pts[(i + 1) % pts.length]).distance <= tol) return true;
    }
    return false;
  }

  objectsInRect(r, { activeOnly = false } = {}) {
    const out = [];
    for (const layer of LAYERS) {
      if (activeOnly && layer.id !== this.state.activeLayer) continue;
      if (!this.layerInteractive(layer.id)) continue;
      for (const o of this.doc.layers[layer.id]) {
        const b = objectBounds(o, this.catalog);
        const inside = b.x >= r.x && b.y >= r.y && b.x + b.width <= r.x + r.width && b.y + b.height <= r.y + r.height;
        const touching = r.touch && !(b.x > r.x + r.width || b.x + b.width < r.x || b.y > r.y + r.height || b.y + b.height < r.y);
        if (inside || touching) out.push(o);
      }
    }
    return out;
  }

  // ---- edits ----
  edit(label, fn) {
    const tx = this.doc.begin(label);
    try {
      const r = fn();
      tx.commit();
      return r;
    } catch (e) {
      tx.cancel();
      console.error(e);
      this.toast(e.message || String(e), 'err');
      return undefined;
    }
  }

  newObjectFromBrush(type, layerId, geometry) {
    const b = this.state.brush;
    const init = { ...geometry };
    if (['Ter', 'Bg', 'C', 'Air'].includes(type)) init.texture = b.texture;
    if (type === 'Bg') init.opacity = b.opacity;
    if (type === 'Air') init.borderColor = b.borderColor;
    if (type === 'Sky') init.colors = b.skyColors;
    if (type === 'Wat') { init.colors = b.waterColors; init.hasBorder = b.hasBorder; }
    if (type === 'NPC') {
      const remaining = Math.max(0, Math.floor(npcBudget(this.doc.worldSize) - totalNpc(this.doc)));
      init.settings = { animalCount: Math.min(10, remaining) };
    }
    return createObject(type, layerId, init);
  }

  deleteSelection() {
    const objs = this.selected();
    if (!objs.length) return;
    if (this.state.tool === 'point' && this.state.points.size) {
      this.edit('Delete points', () => {
        for (const [uid, set] of this.state.points) {
          const o = this.doc.get(uid);
          if (!o || KIND_BY_TYPE[o.type] !== 'poly') continue;
          const keep = o.points.filter((_, i) => !set.has(i));
          if (keep.length >= 3) { this.doc.touch(o); o.points = keep; }
          else this.toast('A polygon keeps at least 3 points');
        }
        this.state.points.clear();
      });
      return;
    }
    this.edit(objs.length > 1 ? `Delete ${objs.length} objects` : 'Delete', () => objs.forEach(o => this.doc.remove(o)));
    this.deselect();
  }

  // ---- clipboard ----
  async copy(cut = false) {
    const objs = this.selected();
    if (!objs.length) return;
    const payload = {
      mark: CLIP_MARK,
      objects: objs.map(o => { const c = clone(o); delete c.uid; delete c.sourceId; return c; }),
      bounds: ops.selectionBounds(objs, this.catalog)
    };
    this.clipboard = payload;
    try { await navigator.clipboard.writeText(JSON.stringify(payload)); } catch { /* internal clipboard still works */ }
    if (cut) this.deleteSelection();
    this.toast(`${cut ? 'Cut' : 'Copied'} ${objs.length} object${objs.length > 1 ? 's' : ''}`);
  }

  async readClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      const data = JSON.parse(text);
      if (data?.mark === CLIP_MARK) return data;
      if (Array.isArray(data?.screenObjects)) {
        const r = importMap(data, { applyQuotas: false });
        return { objects: r.objects, bounds: null };
      }
    } catch { /* not ours */ }
    return this.clipboard;
  }

  async paste(inPlace = false) {
    const data = await this.readClipboard();
    if (!data?.objects?.length) return;
    const created = this.edit('Paste', () => {
      const made = data.objects.filter(o => LAYER_BY_ID[o.layerId]).map(o => this.doc.add(clone(o)));
      if (!inPlace) {
        const b = ops.selectionBounds(made, this.catalog);
        const v = this.renderer.view;
        if (b) ops.translate(this.doc, made, v.cx - (b.x + b.width / 2), v.cy - (b.y + b.height / 2));
      }
      return made;
    });
    if (created?.length) this.select(created);
  }

  duplicate() {
    const objs = this.selected();
    if (!objs.length) return;
    const off = 20 / this.renderer.view.zoom;
    const made = this.edit('Duplicate', () => ops.duplicate(this.doc, objs, off, off));
    if (made) this.select(made);
  }

  // ---- view ----
  fitWorld() { this.renderer.fit(this.doc); this.requestRender(); this.emit('view'); }
  zoomSelection() {
    const b = ops.selectionBounds(this.selected(), this.catalog);
    if (b) { this.renderer.fitBounds(b); this.requestRender(); this.emit('view'); }
  }
  zoomBy(f, screen = null) {
    const r = this.renderer;
    const p = screen || { x: r.width / 2, y: r.height / 2 };
    const before = r.toWorld(p.x, p.y);
    r.view.zoom = Math.min(80, Math.max(0.004, r.view.zoom * f));
    const after = r.toWorld(p.x, p.y);
    r.view.cx += before.x - after.x;
    r.view.cy += before.y - after.y;
    this.requestRender();
    this.emit('view');
  }
  setZoom(z) { this.renderer.view.zoom = Math.min(80, Math.max(0.004, z)); this.requestRender(); this.emit('view'); }
  focusObject(o) {
    const b = objectBounds(o, this.catalog);
    const pad = Math.max(b.width, b.height) * 0.6 + 20;
    this.renderer.fitBounds({ x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 });
    this.requestRender();
    this.emit('view');
  }

  // ---- files ----
  async confirmDiscard() {
    if (!this.state.dirty) return true;
    const choice = await dialogs.confirmSave(this.state.file.name);
    if (choice === 'save') return await this.save();
    return choice === 'discard';
  }

  loadText(text, file) {
    let json;
    try { json = parseDpm(text); } catch (e) { dialogs.alert('Cannot open file', e.message); return false; }
    const result = importMap(json);
    this.doc.load(result);
    this.meta.fromSidecar(file?.sidecar || null);
    this.state.file = { path: file?.path || null, name: file?.name || 'Untitled.dpm' };
    this.state.selection.clear();
    this.state.points.clear();
    this.fitWorld();
    this.emit('file');
    this.issues = validate(this.doc, this.catalog);
    this.emit('issues');
    const changed = result.notes.filter(n => !n.startsWith('No world settings'));
    if (changed.length) dialogs.importNotes(file?.name, result.notes);
    this.toast(`Opened ${this.state.file.name} - ${this.doc.count()} objects`, 'ok');
    host.clearRecovery();
    return true;
  }

  async open() {
    if (!(await this.confirmDiscard())) return;
    const f = await host.openDialog();
    if (f) this.loadText(f.text, f);
  }

  async openPath(path) {
    if (!(await this.confirmDiscard())) return;
    const f = await host.openPath(path);
    if (f?.error) dialogs.alert('Cannot open file', f.error);
    else if (f) this.loadText(f.text, f);
  }

  newMap({ width, height, gravity, template }) {
    const doc = this.doc;
    const objects = [];
    const W = width * 10, H = height * 10;
    if (template) {
      const sea = Math.round(H * 0.22);
      objects.push(createObject('Sky', 'sky', { points: [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: sea }, { x: 0, y: sea }] }));
      objects.push(createObject('Wat', 'water', { points: [{ x: 0, y: sea }, { x: W, y: sea }, { x: W, y: H }, { x: 0, y: H }] }));
    }
    doc.load({ worldSize: { width, height }, settings: { gravity }, objects });
    this.meta.reset();
    this.emit('meta');
    this.state.file = { path: null, name: 'Untitled.dpm' };
    this.deselect();
    this.fitWorld();
    this.emit('file');
  }

  async save(as = false) {
    const errors = validate(this.doc, this.catalog).filter(i => i.severity === 'error');
    if (errors.length) {
      const msg = `${errors.length} object(s) would fail to open in the official Mapmaker. Open the Checks panel to fix them before saving, or save anyway.`;
      const go = await dialogs.confirm('Compatibility errors', msg, 'Save anyway');
      if (!go) { this.emit('show-checks'); return false; }
    }
    const text = serializeDpm(this.doc);
    const r = await host.save({
      path: as ? null : this.state.file.path,
      text,
      defaultName: this.state.file.name,
      sidecar: this.meta.toSidecar()
    });
    if (!r) return false;
    this.state.file = { path: r.path, name: r.name };
    this.state.savedRevision = this.doc.revision;
    this.state.dirty = false;
    this.emit('file');
    host.clearRecovery();
    this.toast(`Saved ${r.name}`, 'ok');
    return true;
  }

  // ---- transfer to the official Mapmaker ----
  async checkBeforeTransfer() {
    const errors = validate(this.doc, this.catalog).filter(i => i.severity === 'error');
    if (!errors.length) return true;
    const msg = `${errors.length} object(s) would fail in the official Mapmaker. Fix them in the Checks panel first, or continue anyway.`;
    const go = await dialogs.confirm('Compatibility errors', msg, 'Continue');
    if (!go) this.emit('show-checks');
    return go;
  }

  async copyForMapmaker() {
    if (!(await this.checkBeforeTransfer())) return;
    try {
      await navigator.clipboard.writeText(serializeDpm(this.doc));
      this.toast('Map copied. In Mapmaker press "Paste from Mapmaker Pro" in the extension panel.', 'ok');
    } catch (e) { this.toast('Clipboard unavailable: ' + e.message, 'err'); }
  }

  async copyConsoleLoader() {
    if (!(await this.checkBeforeTransfer())) return;
    const script = [
      '(async () => {',
      `  const map = ${serializeDpm(this.doc)};`,
      `  const count = await (${MAPMAKER_LOADER})(map);`,
      "  console.log('Mapmaker Pro: loaded ' + count + ' objects. Press Save to keep it.');",
      '})().catch(console.error);\n'
    ].join('\n');
    try {
      await navigator.clipboard.writeText(script);
      this.toast('Loader copied. Paste it into the console (F12) on mapmaker.deeeep.io.', 'ok');
    } catch (e) { this.toast('Clipboard unavailable: ' + e.message, 'err'); }
  }

  async sendToMapmaker() {
    if (!host.mapmakerSend) { this.copyForMapmaker(); return; }
    if (!(await this.checkBeforeTransfer())) return;
    const status = await host.mapmakerStatus();
    let text = 'The map opens in the Mapmaker window. Press Save there to store it on your account (log in first).';
    if (status.map) {
      const name = status.map.title || status.map.stringId;
      text = `The Mapmaker window currently has "${name}" open. Sending replaces its contents, ` +
        'and pressing Save there overwrites that online map. To save as a new map, choose File > New in Mapmaker first.';
    } else if (status.open && status.dirty) {
      text = 'The Mapmaker window has unsaved work, which will be replaced. ' + text;
    }
    if (!(await dialogs.confirm('Send to Mapmaker', text, 'Send'))) return;
    this.toast('Sending to Mapmaker...');
    const r = await host.mapmakerSend(serializeDpm(this.doc));
    if (r.error) dialogs.alert('Could not send the map', r.error);
    else this.toast(`Mapmaker loaded ${r.count} objects. Press Save in the Mapmaker window.`, 'ok');
  }

  async pullFromMapmaker() {
    if (!host.mapmakerPull) return;
    if (!(await this.confirmDiscard())) return;
    const r = await host.mapmakerPull();
    if (r.error) { dialogs.alert('Could not read the Mapmaker window', r.error); return; }
    const prevSidecar = this.meta.toStaleSidecar();
    this.loadText(r.text, { name: r.name, sidecar: prevSidecar });
  }

  // ---- symbols (reusable object groups) ----
  async saveSymbol() {
    const objs = this.selected();
    if (!objs.length) return;
    const name = await dialogs.prompt('Save as symbol', 'Name', objs.length === 1 ? objs[0].type : `${objs.length} objects`);
    if (!name) return;
    const list = (await host.storeGet('symbols')) || [];
    const items = objs.map(o => { const c = clone(o); delete c.uid; delete c.sourceId; return c; });
    list.unshift({
      id: Date.now().toString(36),
      name,
      created: new Date().toISOString(),
      objects: items,
      bounds: ops.selectionBounds(objs, this.catalog)
    });
    await host.storeSet('symbols', list);
    this.emit('symbols');
    this.toast(`Symbol "${name}" saved`, 'ok');
  }

  placeSymbol(sym) {
    const made = this.edit(`Place ${sym.name}`, () => {
      const created = sym.objects.filter(o => LAYER_BY_ID[o.layerId]).map(o => this.doc.add(clone(o)));
      const b = ops.selectionBounds(created, this.catalog);
      const v = this.renderer.view;
      if (b) ops.translate(this.doc, created, v.cx - (b.x + b.width / 2), v.cy - (b.y + b.height / 2));
      return created;
    });
    if (made) this.select(made);
  }

  // ---- misc ----
  toast(text, kind = '') {
    const root = document.getElementById('toast-root');
    const el = h('div', { class: 'toast ' + kind }, text);
    root.append(el);
    setTimeout(() => el.remove(), kind === 'err' ? 4200 : 2400);
    while (root.children.length > 3) root.firstChild.remove();
  }

  quotaInfo() {
    return {
      food: totalFood(this.doc), foodMax: Math.floor(foodBudget(this.doc.worldSize)),
      npc: totalNpc(this.doc), npcMax: Math.floor(npcBudget(this.doc.worldSize))
    };
  }

  issueSummary() { return summarize(this.issues); }

  // ---- render ----
  render() {
    const r = this.renderer;
    const state = this.state;
    const hidden = this.tool.hiddenUids?.() || null;
    const lensState = this.lens?.renderState();
    r.renderScene({
      doc: this.doc,
      visible: state.visible,
      layerAlpha: id => this.layerAlpha(id),
      objectAlpha: o => this.objectAlpha(o),
      outline: state.outline,
      testerPreview: !!(state.testerPreview || state.view?.testerPreview),
      hiddenUids: hidden,
      reference: this.meta.renderState(),
      xray: lensState?.xray || null,
      colorOverrides: this.previewColors || null
    });
    if (this.meta.blocks.length) { r.worldTransform(); drawBlocks(r.ctx, this.meta.blocks); }
    this.sim?.draw(r);
    this.drawSymmetryAxis();
    if (state.grid) r.drawGrid(this.doc, state.gridStep);
    this.drawSelection();
    r.screenTransform();
    this.drawInside?.drawOverlay(r.ctx, r);
    this.tool.overlay?.(r.ctx, r);
    this.gradientHandles?.drawOverlay(r.ctx, r);
    drawInspectorOverlay(r.ctx, this);
    this.lens?.drawOverlay(r.ctx, r);
    if (this.rectDrag) {
      const { a, b } = this.rectDrag, ctx = r.ctx;
      const p = r.toScreen(Math.min(a.x, b.x), Math.min(a.y, b.y)), q = r.toScreen(Math.max(a.x, b.x), Math.max(a.y, b.y));
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(0, 0, r.width, p.y); ctx.fillRect(0, q.y, r.width, r.height - q.y);
      ctx.fillRect(0, p.y, p.x, q.y - p.y); ctx.fillRect(q.x, p.y, r.width - q.x, q.y - p.y);
      ctx.strokeStyle = '#5b9bff'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
      ctx.strokeRect(p.x + 0.5, p.y + 0.5, q.x - p.x, q.y - p.y);
      ctx.setLineDash([]);
      const label = `${(Math.abs(b.x - a.x) / 10).toFixed(2)} x ${(Math.abs(b.y - a.y) / 10).toFixed(2)}`;
      ctx.font = '11px ' + getComputedStyle(document.body).getPropertyValue('--mono');
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(17,20,26,0.92)'; ctx.fillRect(q.x - tw - 12, q.y + 6, tw + 10, 18);
      ctx.fillStyle = '#d6dbe4'; ctx.fillText(label, q.x - tw - 7, q.y + 19);
      ctx.restore();
    }
    this.emit('rendered');
  }

  drawSymmetryAxis() {
    const mode = this.meta.symmetry;
    if (mode === 'off') return;
    const r = this.renderer, ctx = r.ctx, W = this.doc.pixelWidth, H = this.doc.pixelHeight;
    r.worldTransform();
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 79, 216, 0.75)';
    ctx.lineWidth = 1.5 / r.view.zoom;
    ctx.setLineDash([8 / r.view.zoom, 6 / r.view.zoom]);
    ctx.beginPath();
    if (mode === 'h' || mode === 'p') { ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); }
    if (mode === 'v' || mode === 'p') { ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); }
    ctx.stroke();
    ctx.setLineDash([]);
    // linked twins of the selection
    ctx.strokeStyle = 'rgba(255, 79, 216, 0.9)';
    for (const uid of this.state.selection) {
      const t = this.doc.get(this.meta.twins.get(uid));
      if (t) this.outlineObject(t);
    }
    ctx.restore();
  }

  drawSelection() {
    const r = this.renderer, ctx = r.ctx, z = r.view.zoom;
    r.worldTransform();
    const hover = this.tool.hover;
    if (hover && !this.state.selection.has(hover.uid)) {
      ctx.save();
      ctx.strokeStyle = 'rgba(91, 155, 255, 0.85)';
      ctx.lineWidth = 1.5 / z;
      this.outlineObject(hover);
      ctx.restore();
    }
    const sel = this.selected();
    if (!sel.length) return;
    ctx.save();
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.5 / z;
    for (const o of sel) this.outlineObject(o);
    if (this.state.tool === 'point' || this.state.tool === 'pen') {
      const s = 6 / z;
      for (const o of sel) {
        if (KIND_BY_TYPE[o.type] === 'sprite') continue;
        const chosen = this.state.points.get(o.uid);
        o.points.forEach((p, i) => {
          const on = chosen?.has(i);
          ctx.fillStyle = on ? '#3b82f6' : '#ffffff';
          ctx.strokeStyle = on ? '#ffffff' : '#3b82f6';
          ctx.lineWidth = 1 / z;
          ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
          ctx.strokeRect(p.x - s / 2, p.y - s / 2, s, s);
        });
      }
    }
    ctx.restore();
  }

  outlineObject(o) {
    const ctx = this.renderer.ctx;
    const kind = KIND_BY_TYPE[o.type];
    const pts = kind === 'sprite' ? spriteCorners(o, spriteSize(o, this.catalog)) : o.points;
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.stroke();
    if (kind === 'sprite') {
      const r = 3 / this.renderer.view.zoom;
      ctx.beginPath(); ctx.arc(o.x, o.y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#3b82f6'; ctx.fill();
    }
  }
}

// ---------------------------------------------------------------- bootstrap

async function boot() {
  const catalog = buildCatalog(rawCatalog);
  const assets = new AssetStore(catalog);
  await assets.loadCore();
  const editor = new Editor(catalog, assets);
  window.mmp = editor;
  editor.sim = new Simulation(editor);
  buildChrome(editor);
  buildPanels(editor);
  editor.lens = createLens(editor);
  await loadPreferences(editor);
  bindUpdateEvents(editor);
  let sized = false;
  const resize = () => {
    const rect = editor.viewport.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    editor.renderer.resize(rect.width, rect.height);
    if (!sized) { sized = true; editor.renderer.fit(editor.doc); }
    // Setting canvas.width clears it; repaint now so dock drags never flash a black canvas
    editor.render();
    editor.emit('view');
  };
  new ResizeObserver(resize).observe(editor.viewport);
  resize();
  editor.newMap({ width: 20, height: 20, gravity: 9.8, template: true });
  editor.state.savedRevision = editor.doc.revision;
  editor.state.dirty = false;
  editor.emit('file');
  editor.setTool('select');
  editor.on('file', () => { document.title = editor.state.file.name + ' - Mapmaker Pro'; });

  host.onRequestClose(async () => { if (await editor.confirmDiscard()) host.confirmClose(); });
  host.onOpenPath(file => editor.openPath(file));
  const pending = await host.pendingOpen();
  if (pending) await editor.openPath(pending);
  else {
    const recovery = await host.readRecovery();
    if (recovery && await dialogs.confirm('Recover unsaved work', 'Mapmaker Pro closed with unsaved changes. Restore the recovered map?', 'Restore')) {
      editor.loadText(recovery, { name: 'Recovered.dpm' });
      editor.state.dirty = true;
      editor.emit('file');
    } else if (recovery) host.clearRecovery();
  }
  setInterval(() => { if (editor.state.dirty) host.writeRecovery(serializeDpm(editor.doc)); }, 45000);
}

boot().catch(e => {
  console.error(e);
  document.body.append(h('div', { class: 'modal-backdrop' },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' }, 'Mapmaker Pro failed to start'),
      h('div', { class: 'modal-body' }, h('p', {}, String(e?.stack || e))))));
});

