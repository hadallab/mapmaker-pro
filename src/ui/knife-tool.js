// Knife / Polyline Slice tool (K) and Point-mode Vertex Bevel (Ctrl+B).
// Exports tool definition, control-bar widgets, overlay renderer, command entry,
// and Properties section builder without importing ui/commands.js or ui/tools.js.

import { LAYER_BY_ID, KIND_BY_TYPE, TOOL } from '../engine/layers.js';
import { clamp } from '../engine/geometry.js';
import { createContourBoundsCache } from '../engine/contour.js';
import {
  PX_PER_UNIT,
  DEFAULT_BEVEL_DISTANCE_PX,
  selectKnifeTargets,
  computeCutIntersections,
  slicePolygonsInDoc,
  bevelPolygonVertices,
  bevelSelectionPoints
} from '../engine/knife.js';
import { snapContour, drawContourSnapMark } from './contour-snap.js';
import { h, numberField } from './dom.js';
import { modal } from './dialogs.js';
import { getMonoFont } from './canvas-font.js';

const knifeBoundsCaches = new WeakMap();

function getBoundsCache(ed) {
  if (!ed?.doc) return null;
  let entry = knifeBoundsCaches.get(ed);
  if (!entry || entry.doc !== ed.doc) {
    entry = { doc: ed.doc, cache: createContourBoundsCache(ed.doc) };
    knifeBoundsCaches.set(ed, entry);
  }
  return entry.cache;
}

export const KNIFE_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 2.5L5.2 10.8l-1.7.7.7-1.7L12.5 1.5z"/><path d="M9.6 4.4l2 2"/><path d="M2 13.5h4.5M8.5 13.5h5.5" stroke-dasharray="1.8 1.8"/></svg>';

export const KNIFE_TOOL_DEF = {
  title: 'Knife',
  key: 'K',
  icon: 'knife',
  native: TOOL.Creation,
  preferLayer: () => 'terrains',
  help: 'Drag to slice in a line (Shift: 45 deg), or click points and press Enter / double-click to slice a polyline. Esc cancels.'
};

export function ensureKnifeState(ed) {
  if (!ed.state.knife) {
    ed.state.knife = {
      gapPx: 0,
      bevelPx: DEFAULT_BEVEL_DISTANCE_PX
    };
  }
  return ed.state.knife;
}

export function setKnifeGap(ed, gapPx) {
  const s = ensureKnifeState(ed);
  const raw = Number(gapPx);
  const clamped = clamp(Number.isFinite(raw) ? raw : 0, 0, 500);
  const next = Math.round(clamped * 100) / 100;
  if (next === s.gapPx) return s.gapPx;
  s.gapPx = next;
  ed.emit?.('knife');
  ed.requestRender?.();
  return s.gapPx;
}

/**
 * Builds the Knife control-bar widgets (Passage Gap in units + zero reset).
 */
export function buildKnifeControls(ed) {
  const s = ensureKnifeState(ed);
  const gapField = numberField({
    label: 'Gap',
    value: s.gapPx / PX_PER_UNIT,
    step: 0.5,
    min: 0,
    max: 50,
    digits: 2,
    suffix: 'u',
    title: 'Cut passage width in units (0 = zero-gap split)',
    onCommit: v => setKnifeGap(ed, v * PX_PER_UNIT)
  });
  gapField.style.flex = '0 0 118px';

  const zeroBtn = h('button', {
    type: 'button',
    class: 'btn small' + (s.gapPx === 0 ? ' on' : ''),
    title: 'Zero-gap split (0.00 u)'
  }, 'Zero');
  zeroBtn.addEventListener('click', () => setKnifeGap(ed, 0));

  const sync = () => {
    if (!gapField.isConnected) {
      ed.listeners?.get('knife')?.delete(sync);
      return;
    }
    const cur = ensureKnifeState(ed);
    gapField.setValue(cur.gapPx / PX_PER_UNIT);
    zeroBtn.classList.toggle('on', cur.gapPx === 0);
  };
  ed.on?.('knife', sync);

  return [
    h('span', { class: 'cb-sep' }),
    h('span', { class: 'cb-group' }, gapField, zeroBtn)
  ];
}

function constrainAngle45(anchor, pt, shift) {
  if (!shift || !anchor) return pt;
  const dx = pt.x - anchor.x, dy = pt.y - anchor.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return pt;
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: anchor.x + Math.cos(ang) * len, y: anchor.y + Math.sin(ang) * len, kind: null };
}

function polylineLength(pts) {
  let len = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    len += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
  }
  return len;
}

function explainNoTarget(ed) {
  const sel = ed.selected();
  if (sel.length > 0) {
    const polys = sel.filter(o => KIND_BY_TYPE[o.type] === 'poly');
    if (!polys.length) {
      ed.toast?.('Select polygon objects or deselect to slice on the active layer');
      return;
    }
    const hasEditable = polys.some(o =>
      (!ed.state.visible || ed.state.visible.has(o.layerId)) &&
      (!ed.state.locked || !ed.state.locked.has(o.layerId)) &&
      (!ed.state.isolate || o.layerId === ed.state.activeLayer) &&
      (!LAYER_BY_ID[o.layerId]?.helper || o.layerId === ed.state.activeLayer)
    );
    if (!hasEditable) {
      ed.toast?.('Selected layers are locked or hidden');
    }
    return;
  }
  const layer = LAYER_BY_ID[ed.state.activeLayer];
  if (!layer || layer.kind !== 'poly') {
    ed.toast?.('Knife works on polygon layers or selected polygons');
    return;
  }
  if (!ed.state.visible.has(layer.id) || ed.state.locked.has(layer.id)) {
    ed.toast?.(`${layer.title} layer is hidden or locked`);
  }
}

function commitKnifePolyline(ed, polyline) {
  if (!polyline || polyline.length < 2) return false;
  const len = polylineLength(polyline);
  if (len < 0.1) return false;

  const s = ensureKnifeState(ed);
  const gapPx = s.gapPx;
  const prevSel = ed.selected();
  const hadSelection = prevSel.length > 0;
  const targets = selectKnifeTargets(ed.doc, {
    selection: prevSel,
    activeLayer: ed.state.activeLayer,
    visible: ed.state.visible,
    locked: ed.state.locked,
    isolate: ed.state.isolate,
    polyline,
    gapPx,
    boundsCache: getBoundsCache(ed)
  });

  if (!targets.length) {
    explainNoTarget(ed);
    return false;
  }

  // With live symmetry active, pass twins so slicePolygonsInDoc avoids slicing both halves
  // of a twin pair and lets EditorMeta.beforeCommit mirror the new pieces cleanly.
  const twins = (ed.meta?.symmetry && ed.meta.symmetry !== 'off' && ed.meta.twins?.size)
    ? ed.meta.twins
    : null;

  const label = gapPx > 0 ? 'Knife passage' : 'Knife slice';
  const result = ed.edit(label, () => slicePolygonsInDoc(ed.doc, targets, polyline, { gapPx, twins }));
  if (!result || result.cutCount === 0) {
    ed.toast?.('Cut line did not split any polygon');
    return false;
  }

  if (hadSelection) {
    const keep = [...prevSel.filter(o => ed.doc.get(o.uid)), ...result.created];
    ed.select(keep);
  }

  if (gapPx > 0) {
    ed.toast?.(`Carved ${(gapPx / PX_PER_UNIT).toFixed(2)} u passage across ${result.cutCount} polygon${result.cutCount === 1 ? '' : 's'}`, 'ok');
  } else {
    ed.toast?.(`Sliced ${result.cutCount} polygon${result.cutCount === 1 ? '' : 's'} into ${result.created.length} pieces`, 'ok');
  }
  return true;
}

/**
 * Creates the Knife tool handler compatible with ui/tools.js and ui/app.js.
 */
export function createKnifeTool(ed) {
  const R = () => ed.renderer;

  const tool = {
    cursor: 'crosshair',
    draft: null, // { points: [{x, y}], downScreen: {sx, sy}, dragging: false }
    cursorW: null,
    snapMark: null,
    _previewLine: null,
    _previewHits: [],

    activate() {
      ensureKnifeState(ed);
      this.resetDraft();
    },

    deactivate() {
      this.resetDraft();
    },

    resetDraft() {
      this.draft = null;
      this.snapMark = null;
      this._previewLine = null;
      this._previewHits = [];
      ed.state.cursorInfo = null;
    },

    activePolyline() {
      if (!this.draft) return null;
      const pts = this.draft.points.slice();
      if (this.cursorW) {
        const last = pts[pts.length - 1];
        if (!last || Math.hypot(this.cursorW.x - last.x, this.cursorW.y - last.y) > 1e-4) {
          pts.push({ x: this.cursorW.x, y: this.cursorW.y });
        }
      }
      return pts;
    },

    refreshPreview() {
      const line = this.activePolyline();
      this._previewLine = line;
      if (!line || line.length < 2) {
        this._previewHits = [];
        return;
      }
      const s = ensureKnifeState(ed);
      const targets = selectKnifeTargets(ed.doc, {
        selection: ed.selected(),
        activeLayer: ed.state.activeLayer,
        visible: ed.state.visible,
        locked: ed.state.locked,
        isolate: ed.state.isolate,
        polyline: line,
        gapPx: s.gapPx,
        boundsCache: getBoundsCache(ed)
      });
      this._previewHits = computeCutIntersections(targets, line);
      const n = this._previewHits.length;
      const lenU = polylineLength(line) / PX_PER_UNIT;
      const gapTag = s.gapPx > 0 ? `  gap ${(s.gapPx / PX_PER_UNIT).toFixed(2)} u` : '';
      ed.state.cursorInfo = `L ${lenU.toFixed(2)} u  ${n} crossing${n === 1 ? '' : 's'}${gapTag}`;
    },

    down(e) {
      ensureKnifeState(ed);
      const anchor = this.draft?.points.at(-1) || null;
      const snapped = snapContour(ed, e.w);
      const pt = constrainAngle45(anchor, snapped, e.shift);
      this.cursorW = { x: pt.x, y: pt.y };
      this.snapMark = pt.kind ? pt : null;

      if (!this.draft) {
        this.draft = {
          points: [{ x: pt.x, y: pt.y }],
          downScreen: { sx: e.sx, sy: e.sy },
          dragging: false
        };
      } else {
        this.draft.points.push({ x: pt.x, y: pt.y });
        this.draft.downScreen = { sx: e.sx, sy: e.sy };
        this.draft.dragging = false;
      }
      this.refreshPreview();
      ed.requestRender();
    },

    move(e) {
      const anchor = this.draft?.points.at(-1) || null;
      const snapped = snapContour(ed, e.w);
      const pt = constrainAngle45(anchor, snapped, e.shift);
      this.cursorW = { x: pt.x, y: pt.y };
      this.snapMark = pt.kind ? pt : null;

      if (this.draft && (e.buttons & 1) && this.draft.points.length === 1 && !this.draft.dragging) {
        const ds = this.draft.downScreen;
        if (ds && Math.hypot(e.sx - ds.sx, e.sy - ds.sy) > 4) {
          this.draft.dragging = true;
        }
      }
      this.refreshPreview();
      ed.requestRender();
    },

    up(e) {
      if (!this.draft) return;
      if (this.draft.dragging && this.draft.points.length === 1) {
        const anchor = this.draft.points[0];
        const snapped = e?.w ? snapContour(ed, e.w) : this.cursorW;
        const endPt = constrainAngle45(anchor, snapped, e?.shift);
        const line = [anchor, { x: endPt.x, y: endPt.y }];
        this.resetDraft();
        commitKnifePolyline(ed, line);
        ed.requestRender();
      }
    },

    dblclick() {
      if (!this.draft) return;
      if (this.draft.points.length > 2) this.draft.points.pop();
      const line = this.draft.points.slice();
      this.resetDraft();
      if (line.length >= 2) commitKnifePolyline(ed, line);
      ed.requestRender();
    },

    key(e) {
      if (!this.draft) return false;
      if (e.key === 'Enter') {
        const line = this.draft.points.slice();
        this.resetDraft();
        if (line.length >= 2) commitKnifePolyline(ed, line);
        ed.requestRender();
        return true;
      }
      if (e.key === 'Escape') {
        this.resetDraft();
        ed.requestRender();
        return true;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        this.draft.points.pop();
        if (!this.draft.points.length) this.resetDraft();
        else this.refreshPreview();
        ed.requestRender();
        return true;
      }
      return false;
    },

    cancel() {
      this.resetDraft();
      ed.requestRender();
    },

    overlay(ctx, r = R()) {
      drawKnifeToolOverlay(ctx, ed, r, this);
    }
  };

  return tool;
}

function drawKnifeToolOverlay(ctx, ed, r, state) {
  if (!r) return;
  drawContourSnapMark(ctx, r, state.snapMark);

  const line = state._previewLine;
  if (!line || line.length < 2) return;

  const s = ensureKnifeState(ed);
  const gapPx = s.gapPx;
  const z = r.view.zoom || 1;
  const hits = state._previewHits || [];

  ctx.save();

  if (gapPx > 0) {
    const screenW = Math.max(2, gapPx * z);
    ctx.save();
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    ctx.miterLimit = 2;
    ctx.beginPath();
    for (let i = 0; i < line.length; i++) {
      const sp = r.toScreen(line[i].x, line[i].y);
      if (i === 0) ctx.moveTo(sp.x, sp.y);
      else ctx.lineTo(sp.x, sp.y);
    }
    ctx.lineWidth = screenW;
    ctx.strokeStyle = 'rgba(227, 163, 59, 0.22)';
    ctx.stroke();
    ctx.restore();
  }

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i < line.length; i++) {
    const sp = r.toScreen(line[i].x, line[i].y);
    if (i === 0) ctx.moveTo(sp.x, sp.y);
    else ctx.lineTo(sp.x, sp.y);
  }
  ctx.lineWidth = 3.2;
  ctx.strokeStyle = 'rgba(11, 14, 19, 0.85)';
  ctx.stroke();

  const placedCount = state.draft?.points?.length || 0;
  if (placedCount >= 2) {
    ctx.beginPath();
    for (let i = 0; i < placedCount; i++) {
      const sp = r.toScreen(line[i].x, line[i].y);
      if (i === 0) ctx.moveTo(sp.x, sp.y);
      else ctx.lineTo(sp.x, sp.y);
    }
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = '#ffd24a';
    ctx.stroke();
  }

  if (line.length >= 2) {
    const startIdx = Math.max(0, placedCount - 1);
    ctx.setLineDash(state.draft?.dragging ? [] : [5, 4]);
    ctx.beginPath();
    for (let i = startIdx; i < line.length; i++) {
      const sp = r.toScreen(line[i].x, line[i].y);
      if (i === startIdx) ctx.moveTo(sp.x, sp.y);
      else ctx.lineTo(sp.x, sp.y);
    }
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = '#ffd24a';
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (let i = 0; i < placedCount; i++) {
    const sp = r.toScreen(line[i].x, line[i].y);
    ctx.fillStyle = i === 0 ? '#ffd24a' : '#ffffff';
    ctx.strokeStyle = 'rgba(11, 14, 19, 0.9)';
    ctx.lineWidth = 1.2;
    ctx.fillRect(sp.x - 3, sp.y - 3, 6, 6);
    ctx.strokeRect(sp.x - 3, sp.y - 3, 6, 6);
  }

  for (let i = 0; i < hits.length; i++) {
    const sp = r.toScreen(hits[i].x, hits[i].y);
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#ffd24a';
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(11, 14, 19, 0.95)';
    ctx.stroke();
  }

  const endPt = line[line.length - 1];
  const se = r.toScreen(endPt.x, endPt.y);
  const lenU = polylineLength(line) / PX_PER_UNIT;
  const parts = [`${lenU.toFixed(2)} u`];
  if (hits.length) parts.push(`${hits.length} crossing${hits.length === 1 ? '' : 's'}`);
  if (gapPx > 0) parts.push(`gap ${(gapPx / PX_PER_UNIT).toFixed(2)} u`);
  const label = parts.join('  ');

  ctx.font = '11px ' + getMonoFont();
  const tw = ctx.measureText(label).width;
  const boxW = tw + 10;
  const boxH = 18;
  const bx = clamp(se.x + 12, 6, Math.max(6, r.width - boxW - 6));
  const by = clamp(se.y + 12, 6, Math.max(6, r.height - boxH - 6));

  ctx.fillStyle = 'rgba(17, 20, 26, 0.92)';
  ctx.fillRect(bx, by, boxW, boxH);
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#323a4a';
  ctx.strokeRect(bx + 0.5, by + 0.5, boxW, boxH);
  ctx.fillStyle = '#ffe28a';
  ctx.fillText(label, bx + 5, by + 13);

  ctx.restore();
}

/**
 * Standalone overlay hook matching drawOverlay(ctx, ed).
 */
export function drawKnifeOverlay(ctx, ed) {
  if (ed?.state?.tool !== 'knife') return;
  const tool = ed.tools?.knife;
  if (tool?.overlay) tool.overlay(ctx, ed.renderer);
}

// ---- Vertex Bevel (Point editing, Ctrl+B) ----

function selectedPolyPointEntries(ed) {
  const entries = [];
  if (!ed?.doc || !ed?.state?.points?.size) return entries;
  for (const [uid, set] of ed.state.points) {
    if (!set || !set.size) continue;
    const obj = ed.doc.get(uid);
    if (!obj || KIND_BY_TYPE[obj.type] !== 'poly' || !Array.isArray(obj.points) || obj.points.length < 3) continue;
    if (ed.state?.locked?.has(obj.layerId)) continue;
    entries.push({ obj, set });
  }
  return entries;
}

export function hasSelectedPolyPoints(ed) {
  return selectedPolyPointEntries(ed).length > 0;
}

function captureOriginals(entries) {
  return entries.map(({ obj, set }) => ({
    obj,
    origPoints: obj.points.map(p => ({ x: p.x, y: p.y })),
    origSet: new Set(set)
  }));
}

function restoreOriginals(snapshots, ed) {
  for (const { obj, origPoints, origSet } of snapshots) {
    obj.points = origPoints.map(p => ({ x: p.x, y: p.y }));
    ed.state.points.set(obj.uid, new Set(origSet));
  }
}

/**
 * Opens the Vertex Bevel dialog (with live chamfer preview and clamping) and
 * commits the bevel as a single undoable transaction.
 */
export async function openBevelDialog(ed) {
  const entries = selectedPolyPointEntries(ed);
  if (!entries.length) {
    let anyPolyLocked = false;
    let anyRect = false;
    for (const [uid, set] of ed.state?.points || []) {
      if (!set || !set.size) continue;
      const o = ed.doc?.get(uid);
      if (!o) continue;
      if (KIND_BY_TYPE[o.type] === 'poly' && ed.state?.locked?.has(o.layerId)) anyPolyLocked = true;
      else if (KIND_BY_TYPE[o.type] === 'rect') anyRect = true;
    }
    ed.toast?.(
      anyPolyLocked ? 'Selected layers are locked'
        : anyRect ? 'Vertex bevel works on polygon objects (not rectangles)'
        : 'Select one or more polygon points in Point selection (P) first'
    );
    return false;
  }

  const state = ensureKnifeState(ed);
  let distUnits = Math.max(0.01, state.bevelPx / PX_PER_UNIT);
  const snapshots = captureOriginals(entries);
  const selectedCornerCount = entries.reduce((sum, e) => sum + e.set.size, 0);

  const infoEl = h('span', { class: 'v' }, '');
  const rangeEl = h('input', {
    type: 'range',
    min: 0.05,
    max: 10,
    step: 0.05,
    value: clamp(distUnits, 0.05, 10)
  });

  const applyPreview = units => {
    restoreOriginals(snapshots, ed);
    const distPx = Math.max(0.01, units * PX_PER_UNIT);
    let beveled = 0;
    let clamped = false;
    let deltaPts = 0;
    for (const { obj, origPoints, origSet } of snapshots) {
      const res = bevelPolygonVertices(origPoints, origSet, distPx);
      if (res.clamped) clamped = true;
      beveled += res.beveledCount;
      deltaPts += res.points.length - origPoints.length;
      obj.points = res.points;
      ed.state.points.set(obj.uid, res.selectedIndices);
    }
    const clampTag = clamped ? ' (clamped to adjacent edges)' : '';
    infoEl.textContent = `${beveled} of ${selectedCornerCount} corner${selectedCornerCount === 1 ? '' : 's'} -> +${deltaPts} pts${clampTag}`;
    ed.requestRender?.();
  };

  const numField = numberField({
    label: 'Distance',
    value: distUnits,
    digits: 2,
    step: 0.1,
    min: 0.01,
    max: 500,
    suffix: 'u',
    title: 'Chamfer setback along adjacent edges (Mapmaker units)',
    onCommit: v => {
      distUnits = v;
      rangeEl.value = String(clamp(v, 0.05, 10));
      applyPreview(distUnits);
    }
  });
  rangeEl.addEventListener('input', () => {
    distUnits = Number(rangeEl.value);
    numField.setValue(distUnits);
    applyPreview(distUnits);
  });

  applyPreview(distUnits);

  const body = h('div', {},
    h('p', {}, 'Replaces each selected corner with two chamfer points. Distance is clamped automatically so adjacent edges never cross.'),
    h('div', { class: 'row' }, rangeEl),
    numField,
    h('div', { class: 'row', style: { marginTop: '10px' } }, infoEl)
  );

  const committed = await modal({
    title: 'Bevel vertices',
    body,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Bevel', primary: true, value: () => distUnits }
    ]
  });

  // Always restore exact originals before either cancelling or committing inside ed.edit().
  restoreOriginals(snapshots, ed);

  if (committed == null || !(committed > 0)) {
    ed.requestRender?.();
    return false;
  }

  const finalDistPx = committed * PX_PER_UNIT;
  state.bevelPx = finalDistPx;

  const pointsMap = new Map(snapshots.map(s => [s.obj.uid, new Set(s.origSet)]));
  const res = ed.edit('Bevel points', () => bevelSelectionPoints(ed.doc, pointsMap, finalDistPx));
  if (!res || !res.totalBeveled) {
    ed.toast?.('Selected corners could not be beveled at this distance');
    ed.requestRender?.();
    return false;
  }

  for (const [uid, nextSet] of res.nextPointsMap) {
    ed.state.points.set(uid, nextSet);
  }
  ed.emit?.('selection');
  ed.requestRender?.();
  ed.toast?.(`Beveled ${res.totalBeveled} corner${res.totalBeveled === 1 ? '' : 's'}`, 'ok');
  return true;
}

/**
 * Command entries for ui/commands.js.
 */
export function knifeCommands(ed) {
  return [
    {
      id: 'shape.bevel',
      label: 'Bevel selected points...',
      keys: 'Ctrl+B',
      enabled: () => ed.state?.tool === 'point' && hasSelectedPolyPoints(ed),
      run: () => openBevelDialog(ed)
    }
  ];
}

/**
 * Properties section for vertex beveling. Returns null unless Point selection
 * is active with polygon vertices selected.
 */
export function buildBevelSection(ed) {
  if (ed?.state?.tool !== 'point') return null;
  const entries = selectedPolyPointEntries(ed);
  if (!entries.length) return null;
  const count = entries.reduce((s, e) => s + e.set.size, 0);
  const btn = h('button', {
    type: 'button',
    class: 'btn small primary',
    title: 'Replace selected corners with 2 chamfer points (Ctrl+B)'
  }, 'Bevel corners...');
  btn.addEventListener('click', () => openBevelDialog(ed));

  return h('div', { class: 'section' },
    h('div', { class: 'section-title' },
      h('span', {}, 'Vertex bevel'),
      h('span', { class: 'aside' }, 'Ctrl+B')
    ),
    h('div', { class: 'row' },
      h('span', { class: 'k' }, 'Selected'),
      h('span', { class: 'v' }, `${count} pt${count === 1 ? '' : 's'}`),
      h('span', { style: { flex: '1' } }),
      btn
    )
  );
}
