// Command registry shared by the menu bar, context menu and keyboard shortcuts.

import { LAYERS, LAYER_BY_ID, KIND_BY_TYPE, TEXTURED_TYPES } from '../engine/layers.js';
import { signedArea, hexToInt } from '../engine/geometry.js';
import { clone } from '../engine/document.js';
import * as ops from '../engine/ops.js';
import * as dialogs from './dialogs.js';
import { host } from './host.js';
import { openScreenshot, pickRegion } from './screenshot.js';
import { SYMMETRY_MODES } from './meta.js';
import { openPreferences, checkUpdates } from './preferences.js';
import { drawInsideCommand } from './draw-inside.js';
import { lensCommands } from './lens.js';
import { contourCommands } from './contour-snap.js';
import { paletteCommands } from './palette-studio.js';
import { knifeCommands } from './knife-tool.js';
import { scatterCommands } from './scatter-tool.js';

export function createCommands(ed) {
  const sel = () => ed.selected();
  const has = () => ed.state.selection.size > 0;
  const many = n => () => ed.state.selection.size >= n;
  const polys = () => sel().filter(o => KIND_BY_TYPE[o.type] === 'poly');
  const pivot = () => ops.pivotOf(sel(), ed.catalog);
  const worldPivot = () => ({ x: ed.doc.pixelWidth / 2, y: ed.doc.pixelHeight / 2 });
  const boolean = (op, label) => {
    const made = ed.edit(label, () => ops.booleanSelection(ed.doc, polys(), op));
    if (made) { ed.select(made); ed.toast(`${label}: ${made.length} polygon${made.length === 1 ? '' : 's'}`); }
  };
  const view = (key) => () => { ed.state[key] = !ed.state[key]; ed.emit('view-options'); ed.requestRender(); };

  const transform = (label, fn) => () => {
    const objs = sel();
    if (!objs.length) return;
    ed.edit(label, () => fn(objs));
  };

  const symmetryCopy = (label, fn) => () => {
    const objs = sel();
    if (!objs.length) return;
    const made = ed.edit(label, () => {
      const copies = ops.duplicate(ed.doc, objs);
      fn(copies);
      return copies;
    });
    if (made) ed.select(made);
  };

  const list = [
    // file
    {
      id: 'file.new',
      label: 'New map...',
      keys: 'Ctrl+N',
      run: async () => {
        if (await ed.confirmDiscard()) {
          const r = await dialogs.newMap();
          if (r) ed.newMap(r);
        }
      }
    },
    { id: 'file.open', label: 'Open...', keys: 'Ctrl+O', run: () => ed.open() },
    { id: 'file.save', label: 'Save', keys: 'Ctrl+S', run: () => ed.save() },
    { id: 'file.saveAs', label: 'Save as...', keys: 'Ctrl+Shift+S', run: () => ed.save(true) },
    { id: 'file.screenshot', label: 'Screenshot...', keys: 'Ctrl+Shift+E', run: () => openScreenshot(ed) },
    {
      id: 'file.screenshotRegion',
      label: 'Screenshot region...',
      keys: 'Ctrl+Shift+4',
      run: () => {
        ed.shotSettings ||= { area: 'map', longSide: 8192, helpers: false, hiddenLayers: true, transparent: false };
        pickRegion(ed);
        ed.viewport.style.cursor = 'crosshair';
      }
    },
    { id: 'file.screenshotSel', label: 'Screenshot selection...', enabled: has, run: () => openScreenshot(ed, 'selection') },
    {
      id: 'file.mapSettings',
      label: 'Map settings...',
      keys: 'Ctrl+Alt+M',
      run: async () => {
        const r = await dialogs.mapSettings(ed.doc);
        if (r) ed.edit('Map settings', () => ed.doc.setWorld({ width: r.width, height: r.height }, { gravity: r.gravity }));
      }
    },

    // edit
    {
      id: 'edit.undo',
      label: () => 'Undo' + (ed.doc.history.undoLabel ? ' ' + ed.doc.history.undoLabel : ''),
      keys: 'Ctrl+Z',
      enabled: () => ed.doc.history.canUndo,
      run: () => { ed.doc.history.undo(); }
    },
    {
      id: 'edit.redo',
      label: () => 'Redo' + (ed.doc.history.redoLabel ? ' ' + ed.doc.history.redoLabel : ''),
      keys: 'Ctrl+Shift+Z',
      alt: ['Ctrl+Y'],
      enabled: () => ed.doc.history.canRedo,
      run: () => { ed.doc.history.redo(); }
    },
    { id: 'edit.cut', label: 'Cut', keys: 'Ctrl+X', enabled: has, run: () => ed.copy(true) },
    { id: 'edit.copy', label: 'Copy', keys: 'Ctrl+C', enabled: has, run: () => ed.copy() },
    { id: 'edit.paste', label: 'Paste at view centre', keys: 'Ctrl+V', run: () => ed.paste(false) },
    { id: 'edit.pasteInPlace', label: 'Paste in place', keys: 'Ctrl+Shift+V', run: () => ed.paste(true) },
    { id: 'edit.duplicate', label: 'Duplicate', keys: 'Ctrl+D', enabled: has, run: () => ed.duplicate() },
    { id: 'edit.delete', label: 'Delete', keys: 'Delete', alt: ['Backspace'], enabled: has, run: () => ed.deleteSelection() },
    {
      id: 'edit.selectAll',
      label: 'Select all',
      keys: 'Ctrl+A',
      run: () => ed.select(LAYERS.filter(l => ed.layerInteractive(l.id)).flatMap(l => ed.doc.layers[l.id]))
    },
    {
      id: 'edit.selectLayer',
      label: () => 'Select all in ' + LAYER_BY_ID[ed.state.activeLayer].title,
      keys: 'Ctrl+Alt+A',
      run: () => ed.select(ed.doc.layers[ed.state.activeLayer])
    },
    {
      id: 'edit.selectSame',
      label: 'Select same layer as selection',
      enabled: has,
      run: () => {
        const ids = new Set(sel().map(o => o.layerId));
        ed.select([...ids].flatMap(id => ed.doc.layers[id]));
      }
    },
    {
      id: 'edit.selectSimilarTexture',
      label: 'Select same texture',
      enabled: () => sel().some(o => TEXTURED_TYPES.has(o.type)),
      run: () => selectSimilarTexture(ed)
    },
    {
      id: 'edit.selectSimilarColor',
      label: 'Select same colour / gradient',
      enabled: () => sel().some(o => o.type === 'Sky' || o.type === 'Wat' || o.type === 'Air'),
      run: () => selectSimilarColor(ed)
    },
    {
      id: 'edit.selectSimilarAsset',
      label: 'Select same asset type',
      enabled: () => sel().some(o => o.type === 'H' || o.type === 'A' || o.type === 'P'),
      run: () => selectSimilarAsset(ed)
    },
    {
      id: 'edit.selectSimilarOpacity',
      label: 'Select same opacity',
      enabled: () => sel().some(o => o.type === 'Bg' || o.type === 'H'),
      run: () => selectSimilarOpacity(ed)
    },
    { id: 'edit.selectSmallPolygons', label: 'Select polygons smaller than...', run: () => selectSmallPolygons(ed) },
    { id: 'edit.copyStyle', label: 'Copy style', keys: 'Ctrl+Alt+C', enabled: () => canCopyStyle(sel()), run: () => copyStyle(ed) },
    { id: 'edit.pasteStyle', label: 'Paste style', keys: 'Ctrl+Alt+V', enabled: () => canPasteStyle(sel(), ed.styleClipboard), run: () => pasteStyle(ed) },
    ...paletteCommands(ed),
    { id: 'edit.deselect', label: 'Deselect', keys: 'Ctrl+Shift+A', enabled: has, run: () => ed.deselect() },

    // object
    { id: 'obj.rotCW', label: 'Rotate 90 deg clockwise', enabled: has, run: transform('Rotate 90', o => ops.rotate(ed.doc, o, 90, pivot())) },
    { id: 'obj.rotCCW', label: 'Rotate 90 deg counter-clockwise', enabled: has, run: transform('Rotate -90', o => ops.rotate(ed.doc, o, -90, pivot())) },
    { id: 'obj.rot180', label: 'Rotate 180 deg', enabled: has, run: transform('Rotate 180', o => ops.rotate(ed.doc, o, 180, pivot())) },
    { id: 'obj.flipH', label: 'Flip horizontal', keys: 'Shift+H', enabled: has, run: transform('Flip horizontal', o => ops.flip(ed.doc, o, 'h', pivot())) },
    { id: 'obj.flipV', label: 'Flip vertical', keys: 'Shift+V', enabled: has, run: transform('Flip vertical', o => ops.flip(ed.doc, o, 'v', pivot())) },
    {
      id: 'obj.mirrorCopyH',
      label: 'Mirror copy across world centre (left/right)',
      enabled: has,
      run: symmetryCopy('Mirror copy', c => ops.flip(ed.doc, c, 'h', worldPivot()))
    },
    {
      id: 'obj.mirrorCopyV',
      label: 'Mirror copy across world centre (top/bottom)',
      enabled: has,
      run: symmetryCopy('Mirror copy', c => ops.flip(ed.doc, c, 'v', worldPivot()))
    },
    {
      id: 'obj.pointCopy',
      label: 'Point-symmetric copy (180 deg around world centre)',
      enabled: has,
      run: symmetryCopy('Point-symmetric copy', c => ops.rotate(ed.doc, c, 180, worldPivot()))
    },
    { id: 'obj.front', label: 'Bring to front', keys: 'Ctrl+Shift+]', enabled: has, run: transform('Bring to front', o => ops.reorder(ed.doc, o, 'front')) },
    { id: 'obj.forward', label: 'Bring forward', keys: 'Ctrl+]', enabled: has, run: transform('Bring forward', o => ops.reorder(ed.doc, o, 'forward')) },
    { id: 'obj.backward', label: 'Send backward', keys: 'Ctrl+[', enabled: has, run: transform('Send backward', o => ops.reorder(ed.doc, o, 'backward')) },
    { id: 'obj.back', label: 'Send to back', keys: 'Ctrl+Shift+[', enabled: has, run: transform('Send to back', o => ops.reorder(ed.doc, o, 'back')) },
    { id: 'obj.alignL', label: 'Align left', enabled: many(2), run: transform('Align', o => ops.align(ed.doc, o, ed.catalog, 'left')) },
    { id: 'obj.alignHC', label: 'Align horizontal centres', enabled: many(2), run: transform('Align', o => ops.align(ed.doc, o, ed.catalog, 'hcenter')) },
    { id: 'obj.alignR', label: 'Align right', enabled: many(2), run: transform('Align', o => ops.align(ed.doc, o, ed.catalog, 'right')) },
    { id: 'obj.alignT', label: 'Align top', enabled: many(2), run: transform('Align', o => ops.align(ed.doc, o, ed.catalog, 'top')) },
    { id: 'obj.alignVC', label: 'Align vertical centres', enabled: many(2), run: transform('Align', o => ops.align(ed.doc, o, ed.catalog, 'vcenter')) },
    { id: 'obj.alignB', label: 'Align bottom', enabled: many(2), run: transform('Align', o => ops.align(ed.doc, o, ed.catalog, 'bottom')) },
    { id: 'obj.distH', label: 'Distribute horizontally', enabled: many(3), run: transform('Distribute', o => ops.distribute(ed.doc, o, ed.catalog, 'h')) },
    { id: 'obj.distV', label: 'Distribute vertically', enabled: many(3), run: transform('Distribute', o => ops.distribute(ed.doc, o, ed.catalog, 'v')) },
    {
      id: 'obj.simplify',
      label: 'Simplify outline...',
      enabled: () => polys().length > 0,
      run: async () => {
        const targets = polys();
        const res = await dialogs.simplify(targets, ed);
        if (res == null) return;
        const removed = ed.edit('Simplify', () =>
          typeof res === 'number'
            ? ops.simplify(ed.doc, targets, res)
            : ops.simplifyToCountSelection(ed.doc, targets, res.targetPoints)
        );
        ed.toast(`Removed ${removed || 0} point${removed === 1 ? '' : 's'}`);
      }
    },
    { id: 'obj.clamp', label: 'Clamp to world bounds', enabled: has, run: transform('Clamp to world', o => o.forEach(x => ops.clampToWorld(ed.doc, x))) },
    { id: 'obj.saveSymbol', label: 'Save selection as symbol...', enabled: has, run: () => ed.saveSymbol() },
    { id: 'shape.union', label: 'Unite', keys: 'Ctrl+Alt+U', enabled: () => polys().length >= 2, run: () => boolean('union', 'Unite') },
    {
      id: 'shape.subtract',
      label: 'Subtract others from first selected',
      keys: 'Ctrl+Alt+S',
      enabled: () => polys().length >= 2,
      run: () => boolean('subtract', 'Subtract')
    },
    { id: 'shape.intersect', label: 'Intersect', keys: 'Ctrl+Alt+I', enabled: () => polys().length >= 2, run: () => boolean('intersect', 'Intersect') },
    { id: 'shape.exclude', label: 'Exclude overlap', keys: 'Ctrl+Alt+X', enabled: () => polys().length >= 2, run: () => boolean('exclude', 'Exclude') },
    {
      id: 'shape.offset',
      label: 'Offset outline...',
      enabled: () => polys().length > 0,
      run: async () => {
        const r = await dialogs.offsetDialog(ed.state.activeLayer);
        if (!r) return;
        const made = ed.edit('Offset outline', () => ops.offsetSelection(ed.doc, polys(), r.distance * 10, r.join, r.target));
        if (made?.length) ed.select(made);
      }
    },
    {
      id: 'shape.smooth',
      label: 'Smooth outline...',
      enabled: () => polys().length > 0,
      run: async () => {
        const r = await dialogs.smoothDialog(polys());
        if (!r) return;
        const added = ed.edit('Smooth outline', () => ops.smoothSelection(ed.doc, polys(), r.iterations, r.amount));
        ed.toast(`Outline smoothed (+${added || 0} points)`);
      }
    },
    {
      id: 'shape.cutFrame',
      label: 'Cut arena frame (single ring)...',
      enabled: () => polys().length === 2,
      run: async () => {
        const r = await dialogs.frameCutDialog();
        if (!r) return;
        const made = ed.edit('Cut arena frame', () => ops.cutFrameSelection(ed.doc, polys(), r));
        if (made?.length) {
          ed.select(made);
          ed.toast(`Frame cut into ${made.length} polygon${made.length === 1 ? '' : 's'}`);
        }
      }
    },
    { id: 'obj.group', label: 'Group', keys: 'Ctrl+G', enabled: many(2), run: () => { ed.meta.group(sel()); ed.toast(`Grouped ${sel().length} objects`); } },
    {
      id: 'obj.ungroup',
      label: 'Ungroup',
      keys: 'Ctrl+Shift+G',
      enabled: () => sel().some(o => ed.meta.groupOf.has(o.uid)),
      run: () => ed.meta.ungroup(sel())
    },
    {
      id: 'obj.rename',
      label: 'Rename...',
      keys: 'F2',
      enabled: () => ed.state.selection.size === 1,
      run: async () => {
        const o = sel()[0];
        const name = await dialogs.prompt('Rename', 'Name', ed.meta.name(o) || '');
        if (name !== null) ed.meta.setName(o, name || '');
      }
    },
    drawInsideCommand(ed),
    ...knifeCommands(ed),
    ...scatterCommands(ed),
    {
      id: 'obj.unlinkTwin',
      label: 'Unlink symmetry twin',
      enabled: () => sel().some(o => ed.meta.twins.has(o.uid)),
      run: () => ed.meta.unlinkTwins(sel())
    },

    // view
    { id: 'view.zoomIn', label: 'Zoom in', keys: 'Ctrl+=', alt: ['Ctrl++'], run: () => ed.zoomBy(1.25) },
    { id: 'view.zoomOut', label: 'Zoom out', keys: 'Ctrl+-', run: () => ed.zoomBy(0.8) },
    { id: 'view.fit', label: 'Fit world', keys: 'Ctrl+0', run: () => ed.fitWorld() },
    { id: 'view.zoomSel', label: 'Zoom to selection', keys: 'Shift+2', enabled: has, run: () => ed.zoomSelection() },
    { id: 'view.actual', label: 'Zoom 100%', keys: 'Ctrl+1', run: () => ed.setZoom(1) },
    { id: 'view.outline', label: 'Outline view', keys: 'Ctrl+Y', checked: () => ed.state.outline, run: view('outline') },
    { id: 'view.isolate', label: 'Isolate active layer', keys: 'Ctrl+Shift+I', checked: () => ed.state.isolate, run: view('isolate') },
    {
      id: 'view.testerPreview',
      label: 'Preview as Map Tester',
      checked: () => !!(ed.state.testerPreview || ed.state.view?.testerPreview),
      run: () => {
        const next = !(ed.state.testerPreview || ed.state.view?.testerPreview);
        ed.state.testerPreview = next;
        ed.state.view ||= {};
        ed.state.view.testerPreview = next;
        ed.emit('view-options');
        ed.requestRender();
      }
    },
    ...lensCommands(ed),
    { id: 'view.grid', label: 'Show grid', keys: "Ctrl+'", checked: () => ed.state.grid, run: view('grid') },
    { id: 'view.snapGrid', label: 'Snap to grid', keys: "Ctrl+Shift+'", checked: () => ed.state.snapGrid, run: view('snapGrid') },
    { id: 'view.snapPoints', label: 'Snap to points', keys: 'Ctrl+;', checked: () => ed.state.snapPoints, run: view('snapPoints') },
    ...contourCommands(ed),
    { id: 'view.keepInWorld', label: 'Keep moves inside the world', checked: () => ed.state.keepInWorld, run: view('keepInWorld') },
    { id: 'view.sim', label: 'Game simulation (foods and NPCs)', keys: 'F6', checked: () => !!ed.sim?.enabled, run: () => ed.sim.toggle() },
    {
      id: 'view.clearBlocks',
      label: () => 'Remove all Napoleon blocks' + (ed.meta.blocks.length ? ` (${ed.meta.blocks.length})` : ''),
      enabled: () => ed.meta.blocks.length > 0,
      run: () => {
        const n = ed.meta.blocks.length;
        ed.meta.setBlocks([]);
        ed.toast(`Removed ${n} Napoleon blocks`);
      }
    },
    { id: 'view.smartGuides', label: 'Smart guides', keys: 'Ctrl+U', checked: () => ed.state.smartGuides, run: view('smartGuides') },
    ...SYMMETRY_MODES.map(m => ({
      id: 'sym.' + m.id,
      label: m.label,
      checked: () => ed.meta.symmetry === m.id,
      run: () => {
        ed.meta.setSymmetry(m.id);
        ed.toast(m.id === 'off' ? 'Live symmetry off' : 'Live symmetry: ' + m.label);
      }
    })),
    { id: 'edit.preferences', label: 'Preferences...', keys: 'Ctrl+,', run: () => openPreferences(ed) },
    { id: 'help.updates', label: 'Check for updates...', run: () => checkUpdates(ed, true) },
    { id: 'view.rulers', label: 'Rulers', keys: 'Ctrl+Shift+R', checked: () => ed.state.rulers, run: view('rulers') },
    { id: 'view.minimap', label: 'Navigator', checked: () => ed.state.minimap, run: view('minimap') },

    // official Mapmaker
    {
      id: 'mm.open',
      label: 'Open Mapmaker window',
      run: () => host.mapmakerOpen ? host.mapmakerOpen() : window.open('https://mapmaker.deeeep.io/', '_blank')
    },
    { id: 'mm.send', label: 'Send map to Mapmaker', keys: 'Ctrl+Shift+M', enabled: () => !!host.mapmakerSend, run: () => ed.sendToMapmaker() },
    { id: 'mm.pull', label: 'Get map from Mapmaker window', enabled: () => !!host.mapmakerPull, run: () => ed.pullFromMapmaker() },
    { id: 'mm.copy', label: 'Copy map for the browser extension', keys: 'Ctrl+Shift+C', run: () => ed.copyForMapmaker() },
    { id: 'mm.console', label: 'Copy console loader', run: () => ed.copyConsoleLoader() },

    // help
    { id: 'help.shortcuts', label: 'Keyboard shortcuts', keys: 'F1', run: () => dialogs.shortcuts(ed) },
    { id: 'help.about', label: 'About Mapmaker Pro', run: () => dialogs.about(ed) }
  ];

  const byId = new Map(list.map(c => [c.id, c]));
  const byKey = new Map();
  const rebuildKeys = () => {
    byKey.clear();
    for (const c of list) for (const k of [c.keys, ...(c.alt || [])]) if (k) byKey.set(k, c);
  };
  rebuildKeys();

  return {
    list, byId, byKey, rebuildKeys,
    get: id => byId.get(id),
    label: c => typeof c.label === 'function' ? c.label() : c.label,
    enabled: c => !c.enabled || c.enabled(),
    run: id => { const c = byId.get(id); if (c && (!c.enabled || c.enabled())) c.run(); }
  };
}

export function keyString(e) {
  let k = e.key;
  if (k === ' ') k = 'Space';
  if (k.length === 1) k = k.toUpperCase();
  if (e.code === 'BracketLeft') k = '[';
  if (e.code === 'BracketRight') k = ']';
  if (e.code === 'Quote') k = "'";
  if (e.code === 'Semicolon') k = ';';
  if (e.code === 'Equal') k = e.shiftKey ? '+' : '=';
  if (e.code === 'Minus') k = '-';
  if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey && k !== '+') parts.push('Shift');
  parts.push(k);
  return parts.join('+');
}

// ------------------------------------------------------------------ select similar & style clipboard

function layerPool(doc, layerIds) {
  const ids = layerIds || LAYERS.map(l => l.id);
  const out = [];
  for (const id of ids) for (const o of doc.layers[id] || []) out.push(o);
  return out;
}

function interactiveLayerIds(ed) {
  return LAYERS.filter(l => ed.layerInteractive(l.id)).map(l => l.id);
}

function colorSignature(o) {
  if (o.type === 'Sky' || o.type === 'Wat') return 'grad:' + (o.colors || []).map(hexToInt).join(',');
  if (o.type === 'Air') return 'border:' + hexToInt(o.borderColor ?? 0);
  return null;
}

function assetSignature(o) {
  if (o.type === 'H') return 'H:' + o.hSType;
  if (o.type === 'A') return 'A:' + o.fLevel;
  if (o.type === 'P') return 'P:' + o.pType;
  return null;
}

function opacitySignature(o) {
  if (o.type !== 'Bg' && o.type !== 'H') return null;
  const raw = o.opacity ?? (o.type === 'Bg' ? 0.9 : 1);
  return Math.round(Number(raw) * 1000);
}

export function findSimilarTexture(doc, seeds, layerIds = null) {
  const textures = new Set(seeds.filter(o => TEXTURED_TYPES.has(o.type) && o.texture != null).map(o => o.texture));
  if (!textures.size) return [];
  return layerPool(doc, layerIds).filter(o => TEXTURED_TYPES.has(o.type) && textures.has(o.texture));
}

export function findSimilarColor(doc, seeds, layerIds = null) {
  const sigs = new Set(seeds.map(colorSignature).filter(Boolean));
  if (!sigs.size) return [];
  return layerPool(doc, layerIds).filter(o => { const s = colorSignature(o); return s != null && sigs.has(s); });
}

export function findSimilarAsset(doc, seeds, layerIds = null) {
  const sigs = new Set(seeds.map(assetSignature).filter(Boolean));
  if (!sigs.size) return [];
  return layerPool(doc, layerIds).filter(o => { const s = assetSignature(o); return s != null && sigs.has(s); });
}

export function findSimilarOpacity(doc, seeds, layerIds = null) {
  const sigs = new Set(seeds.map(opacitySignature).filter(v => v != null));
  if (!sigs.size) return [];
  return layerPool(doc, layerIds).filter(o => { const s = opacitySignature(o); return s != null && sigs.has(s); });
}

export function findSmallPolygons(doc, maxAreaUnits, layerIds = null) {
  if (!Number.isFinite(maxAreaUnits) || maxAreaUnits <= 0) return [];
  return layerPool(doc, layerIds).filter(o => KIND_BY_TYPE[o.type] === 'poly' && o.points?.length >= 3 && (Math.abs(signedArea(o.points)) / 100) < maxAreaUnits);
}

function runSelectSimilar(ed, matches, emptyMsg) {
  if (!matches.length) { ed.toast(emptyMsg); return []; }
  ed.select(matches);
  ed.toast(`Selected ${matches.length} object${matches.length === 1 ? '' : 's'}`);
  return matches;
}

export function selectSimilarTexture(ed) {
  return runSelectSimilar(ed, findSimilarTexture(ed.doc, ed.selected(), interactiveLayerIds(ed)), 'No matching textured objects');
}

export function selectSimilarColor(ed) {
  return runSelectSimilar(ed, findSimilarColor(ed.doc, ed.selected(), interactiveLayerIds(ed)), 'No matching coloured objects');
}

export function selectSimilarAsset(ed) {
  return runSelectSimilar(ed, findSimilarAsset(ed.doc, ed.selected(), interactiveLayerIds(ed)), 'No matching asset objects');
}

export function selectSimilarOpacity(ed) {
  return runSelectSimilar(ed, findSimilarOpacity(ed.doc, ed.selected(), interactiveLayerIds(ed)), 'No objects with matching opacity');
}

export async function selectSmallPolygons(ed, maxAreaUnits = null) {
  let limit = maxAreaUnits;
  if (limit == null) {
    const raw = await dialogs.prompt('Select small polygons', 'Maximum area (u2)', '0.25');
    if (raw == null) return [];
    limit = Number(String(raw).replace(',', '.'));
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    ed.toast('Enter a positive area threshold', 'err');
    return [];
  }
  return runSelectSimilar(ed, findSmallPolygons(ed.doc, limit, interactiveLayerIds(ed)), `No polygons smaller than ${limit} u2`);
}

export function extractStyle(obj) {
  if (!obj) return null;
  switch (obj.type) {
    case 'Ter':
    case 'C':
      return { type: obj.type, texture: obj.texture };
    case 'Bg':
      return { type: 'Bg', texture: obj.texture, opacity: obj.opacity ?? 0.9 };
    case 'Air':
      return { type: 'Air', texture: obj.texture, borderColor: hexToInt(obj.borderColor ?? 0) };
    case 'Sky':
      return { type: 'Sky', colors: (obj.colors || []).map(hexToInt) };
    case 'Wat':
      return { type: 'Wat', colors: (obj.colors || []).map(hexToInt), hasBorder: !!obj.hasBorder };
    case 'Cu':
      return { type: 'Cu', settings: clone(obj.settings || { angle: 0, strength: 10 }) };
    case 'Hab':
      return { type: 'Hab', settings: { area: obj.settings?.area ?? 0 } };
    case 'Food':
      return {
        type: 'Food',
        settings: {
          foodIds: [...(obj.settings?.foodIds || [])],
          firstSpawnMs: obj.settings?.firstSpawnMs ?? 0,
          reSpawnMs: obj.settings?.reSpawnMs ?? 1000,
          onlyOnWater: !!obj.settings?.onlyOnWater
        }
      };
    case 'NPC':
      return {
        type: 'NPC',
        settings: {
          fishLevels: [...(obj.settings?.fishLevels || [])],
          firstSpawnMs: obj.settings?.firstSpawnMs ?? 0,
          reSpawnMs: obj.settings?.reSpawnMs ?? 2000,
          npcType: obj.settings?.npcType ?? 1,
          restrictMovement: !!obj.settings?.restrictMovement
        }
      };
    case 'H':
      return { type: 'H', hSType: obj.hSType, opacity: obj.opacity ?? 1 };
    case 'A':
      return { type: 'A', fLevel: obj.fLevel };
    case 'P':
      return { type: 'P', pType: obj.pType };
    default:
      return null;
  }
}

export function canCopyStyle(objs) {
  return objs.length > 0 && new Set(objs.map(o => o.type)).size === 1 && extractStyle(objs[0]) !== null;
}

export function canPasteStyle(objs, style) {
  return !!style && objs.length > 0 && objs.every(o => o.type === style.type);
}

export function applyStyleToObject(obj, style, catalog = null) {
  if (!obj || !style || obj.type !== style.type) return false;
  switch (obj.type) {
    case 'Ter':
    case 'C':
      obj.texture = style.texture;
      return true;
    case 'Bg':
      obj.texture = style.texture;
      obj.opacity = style.opacity;
      return true;
    case 'Air':
      obj.texture = style.texture;
      obj.borderColor = style.borderColor;
      return true;
    case 'Sky':
      obj.colors = [...style.colors];
      return true;
    case 'Wat':
      obj.colors = [...style.colors];
      obj.hasBorder = style.hasBorder;
      return true;
    case 'Cu':
      obj.settings = clone(style.settings);
      return true;
    case 'Hab':
      obj.settings = { ...(obj.settings || {}), area: style.settings.area };
      return true;
    case 'Food':
      obj.settings = {
        ...(obj.settings || {}),
        foodIds: [...style.settings.foodIds],
        firstSpawnMs: style.settings.firstSpawnMs,
        reSpawnMs: style.settings.reSpawnMs,
        onlyOnWater: style.settings.onlyOnWater
      };
      return true;
    case 'NPC':
      obj.settings = {
        ...(obj.settings || {}),
        fishLevels: [...style.settings.fishLevels],
        firstSpawnMs: style.settings.firstSpawnMs,
        reSpawnMs: style.settings.reSpawnMs,
        npcType: style.settings.npcType,
        restrictMovement: style.settings.restrictMovement
      };
      return true;
    case 'H':
      obj.hSType = style.hSType;
      obj.opacity = style.opacity;
      return true;
    case 'A':
      obj.fLevel = style.fLevel;
      return true;
    case 'P':
      obj.pType = style.pType;
      if (catalog?.propById) {
        const prop = catalog.propById.get(style.pType);
        obj.params = prop?.params?.some(p => p.key === 'text') ? { text: obj.params?.text ?? '' } : null;
      }
      return true;
    default:
      return false;
  }
}

export function copyStyle(ed) {
  const objs = ed.selected();
  if (!canCopyStyle(objs)) {
    ed.toast('Select objects of one type to copy style');
    return null;
  }
  ed.styleClipboard = extractStyle(objs[0]);
  ed.toast(`Copied style (${LAYER_BY_ID[objs[0].layerId]?.title || objs[0].type})`);
  return ed.styleClipboard;
}

export function pasteStyle(ed) {
  const objs = ed.selected();
  const style = ed.styleClipboard;
  if (!style) { ed.toast('No copied style on clipboard'); return 0; }
  if (!canPasteStyle(objs, style)) {
    ed.toast(`Select ${style.type} object(s) to paste this style`);
    return 0;
  }
  let count = 0;
  ed.edit('Paste style', () => {
    for (const o of objs) {
      ed.doc.touch(o);
      if (applyStyleToObject(o, style, ed.catalog)) count++;
    }
  });
  if (count) ed.toast(`Pasted style to ${count} object${count === 1 ? '' : 's'}`, 'ok');
  return count;
}
