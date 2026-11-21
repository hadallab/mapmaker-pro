// High-resolution screenshots of the whole map, the selection, the visible view or a
// region drawn on the canvas. Rendering is offscreen with the same engine as the editor.

import { LAYERS, KIND_BY_TYPE } from '../engine/layers.js';
import { Renderer } from '../engine/render.js';
import * as ops from '../engine/ops.js';
import { h, clear, numberField, toggle } from './dom.js';
import { modal } from './dialogs.js';
import { host } from './host.js';

// Chromium canvas limits: 32767 px per side and about 268 million pixels in total.
// 16384 keeps a margin and is still well above 8K.
const MAX_SIDE = 16384;
const MAX_AREA = 16384 * 16384;
const SIZES = [2048, 4096, 8192, 16384];

export function areaRect(ed, area) {
  const d = ed.doc;
  if (area === 'map') return { x: 0, y: 0, width: d.pixelWidth, height: d.pixelHeight };
  if (area === 'selection') {
    const b = ops.selectionBounds(ed.selected(), ed.catalog);
    if (!b) return null;
    const pad = Math.max(b.width, b.height) * 0.04;
    return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 };
  }
  if (area === 'view') {
    const r = ed.renderer;
    const a = r.toWorld(0, 0), b = r.toWorld(r.width, r.height);
    return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
  }
  return area && typeof area === 'object' ? area : null;
}

export function outputSize(rect, longSide) {
  let scale = longSide / Math.max(rect.width, rect.height);
  let w = Math.round(rect.width * scale), hh = Math.round(rect.height * scale);
  let capped = false;
  if (w > MAX_SIDE || hh > MAX_SIDE) { scale *= MAX_SIDE / Math.max(w, hh); capped = true; }
  const area = rect.width * scale * rect.height * scale;
  if (area > MAX_AREA) { scale *= Math.sqrt(MAX_AREA / area); capped = true; }
  w = Math.max(1, Math.round(rect.width * scale)); hh = Math.max(1, Math.round(rect.height * scale));
  return { scale, width: w, height: hh, capped };
}

// Sprites load lazily in the editor; a screenshot must wait for every image it draws.
async function ensureSprites(ed) {
  const files = new Set();
  for (const o of ed.doc.objects()) {
    if (KIND_BY_TYPE[o.type] !== 'sprite') continue;
    if (o.type === 'H') { const f = ed.catalog.hideSpaceById.get(o.hSType)?.frame?.file; if (f) files.add(f); }
    if (o.type === 'P') { const f = ed.catalog.propById.get(o.pType)?.frame?.file; if (f) files.add(f); }
    if (o.type === 'A') { const f = ed.catalog.animalByLevel.get(o.fLevel)?.file; if (f) files.add(f); }
  }
  await Promise.all([...files].map(f => ed.assets.load(f)));
}

export async function renderShot(ed, { rect, longSide, helpers, hiddenLayers, transparent, onlySelection }) {
  await ensureSprites(ed);
  const size = outputSize(rect, longSide);
  const canvas = document.createElement('canvas');
  canvas.width = size.width; canvas.height = size.height;
  const r = new Renderer(canvas, { catalog: ed.catalog, assets: ed.assets });
  r.dpr = 1; r.width = size.width; r.height = size.height;
  r.gameView = !helpers;
  r.view = { cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2, zoom: size.scale };
  const visible = new Set(
    LAYERS.filter(l => helpers || (!l.helper && l.id !== 'animals'))
      .map(l => l.id)
      .filter(id => !hiddenLayers || ed.state.visible.has(id))
  );
  let hiddenUids = null;
  if (onlySelection) {
    hiddenUids = new Set();
    for (const o of ed.doc.objects()) if (!ed.state.selection.has(o.uid)) hiddenUids.add(o.uid);
  }
  // With "only the selected objects" on a transparent background the grey world fill is
  // left out too, so the objects can be placed on anything.
  r.renderScene({
    doc: ed.doc,
    visible,
    layerAlpha: () => 1,
    outline: false,
    hiddenUids,
    backdrop: transparent ? 'transparent' : '#000000',
    noWorldFill: !!(onlySelection && transparent)
  });
  return { canvas, size };
}

const toBlob = canvas => new Promise((resolve, reject) => {
  canvas.toBlob(b => b ? resolve(b) : reject(new Error('The image is too large for this computer')), 'image/png');
});

export function openScreenshot(ed, initialArea = null) {
  const s = ed.shotSettings || (ed.shotSettings = { area: 'map', longSide: 8192, helpers: false, hiddenLayers: true, transparent: false });
  if (initialArea) s.area = initialArea;
  if (s.area === 'selection' && !ed.state.selection.size) s.area = 'map';
  const body = h('div');
  let info = null;
  const draw = () => {
    clear(body);
    const areas = [
      { id: 'map', label: 'Full map' },
      { id: 'selection', label: 'Selection', disabled: !ed.state.selection.size },
      { id: 'view', label: 'Visible view' },
      { id: 'region', label: s.region ? 'Drawn region' : 'Draw region...' }
    ];
    const seg = h('div', { class: 'presets', style: { gridTemplateColumns: 'repeat(4, 1fr)' } });
    for (const a of areas) {
      const sub = a.id === 'region' && s.region
        ? `${(s.region.width / 10).toFixed(1)} x ${(s.region.height / 10).toFixed(1)}`
        : a.id === 'selection' ? `${ed.state.selection.size} obj` : ' ';
      const b = h('button', { class: 'preset' + (s.area === a.id ? ' on' : ''), disabled: a.disabled },
        h('b', {}, a.label),
        h('span', {}, sub));
      b.addEventListener('click', () => {
        if (a.id === 'region') { close(); pickRegion(ed); return; }
        s.area = a.id; draw();
      });
      seg.append(b);
    }
    const sizes = h('div', { class: 'seg' });
    for (const px of SIZES) {
      const b = h('button', { class: s.longSide === px ? 'on' : '' }, px >= 1024 ? (px / 1024) + 'K' : String(px));
      b.addEventListener('click', () => { s.longSide = px; draw(); });
      sizes.append(b);
    }
    const rect = areaRect(ed, s.area === 'region' ? s.region : s.area);
    const size = rect ? outputSize(rect, s.longSide) : null;
    const capNote = size?.capped ? ' - reduced to the 16K / 268 MP canvas limit' : '';
    info = h('p', { class: 'muted', style: { margin: '8px 0 0' } }, size
      ? `${size.width} x ${size.height} px  (${(size.scale * 10).toFixed(2)} px per map unit)${capNote}`
      : 'Nothing to capture');
    body.append(...[seg,
      h('div', { class: 'row' }, h('span', { class: 'k' }, 'Long side'), sizes,
        numberField({ label: 'px', value: s.longSide, digits: 0, min: 64, max: MAX_SIDE, onCommit: v => { s.longSide = Math.round(v); draw(); } })),
      info,
      h('div', { style: { height: '10px' } }),
      h('div', { class: 'row' }, toggle({
        checked: s.helpers,
        label: 'Include editor helpers (habitats, spawns, triggers, currents, preview animals)',
        onChange: v => { s.helpers = v; }
      })),
      h('div', { class: 'row' }, toggle({ checked: s.hiddenLayers, label: 'Leave out layers hidden in the Layers panel', onChange: v => { s.hiddenLayers = v; } })),
      h('div', { class: 'row' }, toggle({ checked: s.transparent, label: 'Transparent outside the map', onChange: v => { s.transparent = v; } })),
      s.area === 'selection'
        ? h('div', { class: 'row' }, toggle({ checked: !!s.onlySelection, label: 'Only the selected objects', onChange: v => { s.onlySelection = v; } }))
        : null].filter(Boolean));
  };
  let close = () => {};
  draw();
  const run = async copy => {
    const rect = areaRect(ed, s.area === 'region' ? s.region : s.area);
    if (!rect) return;
    ed.toast('Rendering screenshot...');
    await new Promise(r => setTimeout(r, 30));
    try {
      const { canvas, size } = await renderShot(ed, {
        rect,
        longSide: s.longSide,
        helpers: s.helpers,
        hiddenLayers: s.hiddenLayers,
        transparent: s.transparent,
        onlySelection: s.area === 'selection' && s.onlySelection
      });
      const blob = await toBlob(canvas);
      if (copy) {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        ed.toast(`Copied ${size.width} x ${size.height} image`, 'ok');
      } else {
        const base = ed.state.file.name.replace(/\.(dpm|json)$/i, '');
        const name = `${base}-${s.area === 'map' ? 'map' : s.area}-${size.width}x${size.height}.png`;
        const res = await host.exportPng({ bytes: new Uint8Array(await blob.arrayBuffer()), defaultName: name });
        if (res) ed.toast(`Saved ${size.width} x ${size.height} screenshot`, 'ok');
      }
    } catch (e) {
      ed.toast('Screenshot failed: ' + e.message, 'err');
    }
  };
  const p = modal({
    title: 'Screenshot',
    wide: true,
    body,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Copy to clipboard', value: 'copy' }, { label: 'Save PNG...', primary: true, value: 'save' }],
    onOpen: c => { close = c; }
  });
  p.then(v => { if (v === 'copy') run(true); else if (v === 'save') run(false); });
  return p;
}

// Drag a rectangle on the canvas, then reopen the dialog with it.
export function pickRegion(ed) {
  ed.toast('Drag a rectangle on the map to capture (Esc cancels)');
  ed.pickRect = rect => {
    if (!rect || rect.width < 1 || rect.height < 1) return;
    ed.shotSettings.region = rect;
    ed.shotSettings.area = 'region';
    openScreenshot(ed);
  };
}
