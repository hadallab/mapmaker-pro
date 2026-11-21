// Contour-snap Pen (D) tool, three-tier snap markers (Point / Midpoint / Edge),
// Alt+Click ring-segment trace, live segment length/angle readout, and
// seam-preserving polygon simplification UI.

import { LAYER_BY_ID, KIND_BY_TYPE, TOOL } from '../engine/layers.js';
import { clamp, distanceToSegment } from '../engine/geometry.js';
import { catmullRom } from '../engine/shapes.js';
import {
  PX_PER_UNIT,
  DEFAULT_SNAP_SCREEN_PX,
  DEFAULT_SHARED_VERTEX_TOLERANCE,
  createContourBoundsCache,
  findSnapTarget,
  findContourHit,
  locatePointOnRing,
  traceRingSegment,
  segmentMetrics,
  findSharedVerticesBatch,
  previewSimplifyKeepingShared,
  simplifyKeepingShared
} from '../engine/contour.js';
import { h, clear, numberField, toggle } from './dom.js';
import { modal } from './dialogs.js';
import { icon } from './icons.js';
import { getMonoFont } from './canvas-font.js';

export const CONTOUR_PEN_TOOL_DEF = {
  title: 'Draw points',
  key: 'D',
  icon: 'pen',
  native: TOOL.Creation,
  preferLayer: () => 'terrains',
  help: 'Click to add points, drag for freehand. Alt+Click contour twice to trace (Shift flips). Shift+S: edge/mid snap. Enter or double-click: finish.'
};

const editorCaches = new WeakMap();

function getBoundsCache(ed) {
  if (!ed?.doc) return null;
  let entry = editorCaches.get(ed);
  if (!entry || entry.doc !== ed.doc) {
    entry = { doc: ed.doc, cache: createContourBoundsCache(ed.doc) };
    editorCaches.set(ed, entry);
  }
  return entry.cache;
}

/**
 * Ensures `ed.state.snapEdges` exists (default true) and returns snap state.
 */
export function ensureContourState(ed) {
  if (ed?.state && ed.state.snapEdges === undefined) {
    ed.state.snapEdges = true;
  }
  return { snapEdges: ed?.state?.snapEdges !== false };
}

/**
 * Toggles edge & midpoint snapping (`Shift+S`).
 */
export function toggleEdgeSnap(ed) {
  if (!ed?.state) return false;
  ensureContourState(ed);
  ed.state.snapEdges = !ed.state.snapEdges;
  ed.emit?.('view-options');
  ed.emit?.('contour-snap');
  ed.requestRender?.();
  ed.toast?.(ed.state.snapEdges ? 'Edge and midpoint snap on' : 'Edge and midpoint snap off');
  return ed.state.snapEdges;
}

/**
 * Command entries for ui/commands.js.
 */
export function contourCommands(ed) {
  return [
    {
      id: 'view.snapEdges',
      label: 'Snap to edges and midpoints',
      keys: 'Shift+S',
      checked: () => ed.state.snapEdges !== false,
      run: () => toggleEdgeSnap(ed)
    },
    {
      id: 'obj.simplifyShared',
      label: 'Simplify keeping shared points...',
      enabled: () => ed.selected().some(o => KIND_BY_TYPE[o.type] === 'poly' && !ed.state?.locked?.has(o.layerId)),
      run: () => openSimplifySharedDialog(ed)
    }
  ];
}

/**
 * Snaps world point `w` with priority:
 * vertex (`point`) > edge midpoint (`midpoint`) > nearest point on edge (`edge`) > `grid`.
 */
export function snapContour(ed, w, { exclude = null, allowPoints = true, allowEdges = allowPoints, tolerance = null } = {}) {
  const st = ed.state;
  ensureContourState(ed);
  const zoom = ed.renderer?.view?.zoom || 1;
  const tol = tolerance != null ? tolerance : DEFAULT_SNAP_SCREEN_PX / zoom;
  return findSnapTarget(ed.doc, w, {
    tolerance: tol,
    visible: st.visible,
    exclude,
    snapPoints: Boolean(allowPoints && st.snapPoints !== false),
    snapEdges: Boolean(allowEdges && st.snapEdges !== false),
    snapMidpoints: Boolean(allowEdges && st.snapEdges !== false),
    snapGrid: Boolean(st.snapGrid),
    gridStep: st.gridStep || 10,
    boundsCache: getBoundsCache(ed)
  });
}

function roundRectPath(ctx, x, y, w, hgt, rad) {
  const r = Math.min(rad, w / 2, hgt / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + hgt - r);
  ctx.quadraticCurveTo(x + w, y + hgt, x + w - r, y + hgt);
  ctx.lineTo(x + r, y + hgt);
  ctx.quadraticCurveTo(x, y + hgt, x, y + hgt - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function boxesOverlap(a, b) {
  return a && b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Draws a snap marker and label (`Point` / `Midpoint` / `Edge`) on the screen-space
 * canvas. Returns `{ labelBox }` for readout collision avoidance.
 */
export function drawContourSnapMark(ctx, r, p, { showLabel = true } = {}) {
  if (!p?.kind || !r) return { labelBox: null };
  const s = r.toScreen(p.x, p.y);
  ctx.save();

  let badgeColor = null;
  let textColor = '#d6dbe4';
  let label = p.label || null;

  if (p.kind === 'point') {
    badgeColor = '#ff4fd8';
    textColor = '#ff9be8';
    label = label || 'Point';
    ctx.strokeStyle = 'rgba(11, 14, 19, 0.92)';
    ctx.lineWidth = 3;
    ctx.strokeRect(s.x - 5, s.y - 5, 10, 10);
    ctx.strokeStyle = '#ff4fd8';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(s.x - 5, s.y - 5, 10, 10);
    ctx.fillStyle = '#ff4fd8';
    ctx.fillRect(s.x - 1.5, s.y - 1.5, 3, 3);
  } else if (p.kind === 'midpoint') {
    badgeColor = '#22d3ee';
    textColor = '#67e8f9';
    label = label || 'Midpoint';
    const d = 5.5;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y - d);
    ctx.lineTo(s.x + d, s.y);
    ctx.lineTo(s.x, s.y + d);
    ctx.lineTo(s.x - d, s.y);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(11, 14, 19, 0.92)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#22d3ee';
    ctx.beginPath();
    ctx.arc(s.x, s.y, 1.5, 0, Math.PI * 2);
    ctx.fill();
  } else if (p.kind === 'edge') {
    badgeColor = '#e3a33b';
    textColor = '#f0bf6c';
    label = label || 'Edge';
    let nx = 0, ny = -1;
    if (p.a && p.b) {
      const sa = r.toScreen(p.a.x, p.a.y);
      const sb = r.toScreen(p.b.x, p.b.y);
      const dx = sb.x - sa.x, dy = sb.y - sa.y;
      const len = Math.hypot(dx, dy);
      if (len > 1e-3) {
        nx = -dy / len;
        ny = dx / len;
      }
    }
    const tick = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(s.x - nx * tick, s.y - ny * tick);
    ctx.lineTo(s.x + nx * tick, s.y + ny * tick);
    ctx.strokeStyle = 'rgba(11, 14, 19, 0.92)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = '#e3a33b';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#11141a';
    ctx.fill();
    ctx.strokeStyle = '#e3a33b';
    ctx.lineWidth = 1.4;
    ctx.stroke();
  } else {
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(s.x - 5, s.y - 5, 10, 10);
    ctx.restore();
    return { labelBox: null };
  }

  let labelBox = null;
  if (showLabel && label && badgeColor) {
    const mono = getMonoFont();
    ctx.font = '600 10.5px ' + mono;
    const tw = ctx.measureText(label).width;
    const bw = Math.ceil(tw + 18);
    const bh = 17;
    const bx = clamp(Math.round(s.x + 11), 4, Math.max(4, (r.width || 400) - bw - 4));
    const by = clamp(Math.round(s.y - bh - 7), 4, Math.max(4, (r.height || 300) - bh - 4));

    roundRectPath(ctx, bx, by, bw, bh, 4);
    ctx.fillStyle = 'rgba(17, 20, 26, 0.92)';
    ctx.fill();
    ctx.strokeStyle = '#323a4a';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(bx + 7, by + bh / 2, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = badgeColor;
    ctx.fill();

    ctx.fillStyle = textColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + 13, by + bh / 2 + 0.5);
    labelBox = { x: bx, y: by, w: bw, h: bh };
  }

  ctx.restore();
  return { labelBox };
}

function drawSegmentReadout(ctx, r, metrics, cursorW, { traceCount = 0, avoidBox = null } = {}) {
  if (!metrics || !cursorW || !r) return;
  if (metrics.lengthPx < 1e-4 && traceCount <= 0) return;

  const sc = r.toScreen(cursorW.x, cursorW.y);
  const parts = [`${metrics.lengthUnits.toFixed(2)} u`, `${metrics.angleDeg.toFixed(1)}°`];
  if (metrics.cornerDeg != null) {
    parts.push(`∠${Math.round(metrics.cornerDeg)}°`);
  }
  if (metrics.edgeReversal) {
    parts.push('180° fold');
  }
  if (traceCount > 0) {
    parts.push(`+${traceCount} pts`);
  }
  const text = parts.join(' · ');

  ctx.save();
  ctx.font = '11px ' + getMonoFont();
  const tw = ctx.measureText(text).width;
  const bw = Math.ceil(tw + 12);
  const bh = 18;
  const maxX = Math.max(4, (r.width || 400) - bw - 4);
  const maxY = Math.max(4, (r.height || 300) - bh - 4);

  let bx = clamp(Math.round(sc.x + 14), 4, maxX);
  let by = clamp(Math.round(sc.y + 14), 4, maxY);
  if (boxesOverlap({ x: bx, y: by, w: bw, h: bh }, avoidBox)) {
    const altY = clamp(Math.round(avoidBox.y + avoidBox.h + 4), 4, maxY);
    if (!boxesOverlap({ x: bx, y: altY, w: bw, h: bh }, avoidBox)) by = altY;
    else bx = clamp(Math.round(sc.x - bw - 14), 4, maxX);
  }

  roundRectPath(ctx, bx, by, bw, bh, 4);
  ctx.fillStyle = 'rgba(17, 20, 26, 0.92)';
  ctx.fill();
  ctx.strokeStyle = metrics.edgeReversal ? '#e3a33b' : (traceCount > 0 ? '#22d3ee' : '#323a4a');
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = metrics.edgeReversal ? '#f0bf6c' : (traceCount > 0 ? '#67e8f9' : '#d6dbe4');
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + 6, by + bh / 2 + 0.5);
  ctx.restore();
}

function selectedEdgeAt(ed, w) {
  const tol = 5 / (ed.renderer?.view?.zoom || 1);
  for (const o of ed.selected()) {
    if (KIND_BY_TYPE[o.type] !== 'poly') continue;
    for (let i = 0; i < o.points.length; i++) {
      const d = distanceToSegment(w, o.points[i], o.points[(i + 1) % o.points.length]);
      if (d.distance <= tol && d.t > 0.001 && d.t < 0.999) {
        return { o, index: i + 1, at: { x: d.x, y: d.y } };
      }
    }
  }
  return null;
}

function insertEdgePoint(ed, edge) {
  ed.edit('Add point', () => {
    ed.doc.touch(edge.o);
    edge.o.points.splice(edge.index, 0, { x: edge.at.x, y: edge.at.y });
  });
  ed.state.points.set(edge.o.uid, new Set([edge.index]));
  ed.emit?.('selection');
  ed.requestRender();
}

/**
 * Creates the Draw points (`D`) tool handler with three-tier snapping,
 * Alt+Click contour tracing along existing polygons (Shift flips direction),
 * and live segment length/angle readout.
 */
export function createContourPenTool(ed, helpers = {}) {
  const R = () => ed.renderer;
  const zoom = () => ed.renderer?.view?.zoom || 1;
  const clampWorld = p => ({
    x: clamp(p.x, 0, ed.doc.pixelWidth),
    y: clamp(p.y, 0, ed.doc.pixelHeight),
    kind: p.kind ?? null,
    label: p.label ?? null,
    obj: p.obj ?? null,
    uid: p.uid ?? null,
    layerId: p.layerId ?? null,
    vertexIndex: p.vertexIndex,
    edgeIndex: p.edgeIndex,
    t: p.t,
    a: p.a,
    b: p.b
  });
  const snap = helpers.snap || ((w, opts) => snapContour(ed, w, opts));
  const drawSnapMark = helpers.drawSnapMark || ((ctx, r, p) => drawContourSnapMark(ctx, r, p));
  const edgeAt = helpers.edgeAt || (w => selectedEdgeAt(ed, w));
  const insertPoint = helpers.insertPoint || (edge => insertEdgePoint(ed, edge));

  function resolveTraceStart(hit) {
    if (!hit?.obj || !tool.draft?.points?.length) return null;
    const last = tool.draft.points.at(-1);
    if (tool.traceAnchor && tool.traceAnchor.uid === hit.uid) {
      if (Math.hypot(last.x - tool.traceAnchor.x, last.y - tool.traceAnchor.y) <= 0.05) {
        return tool.traceAnchor;
      }
    }
    return locatePointOnRing(hit.obj.points, last, 0.05);
  }

  function updateTraceAt(rawW, alt, shift) {
    if (!rawW) return;
    if (!alt) {
      tool.tracePreview = null;
      const p = clampWorld(tool.constrain(snap(rawW), { shift }));
      tool.cursorW = p;
      tool.snapMark = p.kind ? p : null;
      return;
    }

    const hit = findContourHit(ed.doc, rawW, {
      tolerance: 10 / zoom(),
      visible: ed.state.visible,
      preferUid: tool.traceAnchor?.uid ?? null,
      boundsCache: getBoundsCache(ed)
    });
    if (!hit) {
      tool.tracePreview = null;
      const p = clampWorld(snap(rawW));
      tool.cursorW = p;
      tool.snapMark = p.kind ? p : null;
      return;
    }

    const p = clampWorld(hit);
    tool.cursorW = p;
    tool.snapMark = hit;

    const startLoc = resolveTraceStart(hit);
    if (startLoc) {
      const seg = traceRingSegment(hit.obj.points, startLoc, hit, { reverse: !!shift });
      tool.tracePreview = { obj: hit.obj, points: seg, reverse: !!shift };
    } else {
      tool.tracePreview = null;
    }
  }

  function syncCursorStatus() {
    if (!tool.draft || !tool.draft.points.length || !tool.cursorW) {
      ed.state.cursorInfo = null;
      return;
    }
    const prev = tool.draft.points.length >= 2 ? tool.draft.points.at(-2) : null;
    const last = tool.draft.points.at(-1);
    const m = segmentMetrics(prev, last, tool.cursorW);
    if (!m) { ed.state.cursorInfo = null; return; }
    const traceTag = tool.tracePreview && tool.tracePreview.points.length > 2
      ? `Trace +${tool.tracePreview.points.length - 1}  `
      : '';
    ed.state.cursorInfo = `${traceTag}${m.lengthUnits.toFixed(2)} u  ${m.angleDeg.toFixed(1)} deg`;
  }

  const tool = {
    __contourSnapIntegrated: true,
    cursor: 'crosshair',
    draft: null,
    cursorW: null,
    snapMark: null,
    down0: null,
    traceAnchor: null,
    tracePreview: null,
    altDown: false,
    shiftDown: false,
    _rawW: null,
    _lastDownAddedSingle: false,
    _onKeyMod: null,

    activate() {
      ensureContourState(ed);
      this.draft = null;
      this.traceAnchor = null;
      this.tracePreview = null;
      this._rawW = null;
      this._lastDownAddedSingle = false;
      this.altDown = false;
      this.shiftDown = false;
      if (typeof window !== 'undefined') {
        this._onKeyMod = e => {
          if (e.key !== 'Alt' && e.key !== 'Shift') return;
          if (e.altKey === this.altDown && e.shiftKey === this.shiftDown) return;
          this.altDown = e.altKey;
          this.shiftDown = e.shiftKey;
          if (this._rawW) {
            updateTraceAt(this._rawW, this.altDown, this.shiftDown);
            syncCursorStatus();
            ed.requestRender();
          }
        };
        window.addEventListener('keydown', this._onKeyMod);
        window.addEventListener('keyup', this._onKeyMod);
      }
    },

    deactivate() {
      if (this.draft && this.draft.points.length >= 3) this.finish();
      this.draft = null;
      this.traceAnchor = null;
      this.tracePreview = null;
      this.snapMark = null;
      this.cursorW = null;
      this._rawW = null;
      ed.state.cursorInfo = null;
      if (this._onKeyMod && typeof window !== 'undefined') {
        window.removeEventListener('keydown', this._onKeyMod);
        window.removeEventListener('keyup', this._onKeyMod);
        this._onKeyMod = null;
      }
    },

    constrain(p, ev) {
      const last = this.draft?.points.at(-1);
      if (!ev?.shift || !last) return p;
      const dx = p.x - last.x, dy = p.y - last.y;
      const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      return { x: last.x + Math.cos(a) * len, y: last.y + Math.sin(a) * len, kind: null };
    },

    down(e) {
      const layer = LAYER_BY_ID[ed.state.activeLayer];
      if (!layer || layer.kind !== 'poly') {
        ed.toast('Draw points works on polygon layers (terrain, background, water, sky...)');
        return;
      }
      this.altDown = !!e.alt;
      this.shiftDown = !!e.shift;
      this._rawW = { x: e.w.x, y: e.w.y };
      this._lastDownAddedSingle = false;

      if (!this.draft && !e.shift && !e.alt) {
        const edge = edgeAt(e.w);
        if (edge) { insertPoint(edge); return; }
      }

      if (e.alt) {
        const hit = findContourHit(ed.doc, e.w, {
          tolerance: 10 / zoom(),
          visible: ed.state.visible,
          preferUid: this.traceAnchor?.uid ?? null,
          boundsCache: getBoundsCache(ed)
        });
        if (hit) {
          if (!this.draft) this.draft = { layerId: layer.id, points: [] };
          const startLoc = resolveTraceStart(hit);
          if (startLoc) {
            const firstPt = this.draft.points[0];
            const firstScreen = firstPt ? R().toScreen(firstPt.x, firstPt.y) : null;
            const seg = traceRingSegment(hit.obj.points, startLoc, hit, {
              reverse: !!e.shift,
              includeStart: false,
              includeEnd: true
            });
            const closingToStart = Boolean(
              firstScreen &&
              Math.hypot(firstScreen.x - e.sx, firstScreen.y - e.sy) <= 7 &&
              (this.draft.points.length + seg.length - 1) >= 3
            );
            for (let i = 0; i < seg.length; i++) {
              const pt = clampWorld(seg[i]);
              if (closingToStart && i === seg.length - 1 && firstPt && Math.hypot(pt.x - firstPt.x, pt.y - firstPt.y) <= 1e-3) {
                continue;
              }
              const prev = this.draft.points.at(-1);
              if (!prev || Math.hypot(pt.x - prev.x, pt.y - prev.y) > 1e-6) {
                this.draft.points.push({ x: pt.x, y: pt.y });
              }
            }
            if (closingToStart && this.draft.points.length >= 3) {
              this.finish();
              return;
            }
            this.traceAnchor = { uid: hit.uid, obj: hit.obj, edgeIndex: hit.edgeIndex, t: hit.t, x: hit.x, y: hit.y };
            this.tracePreview = null;
            this.down0 = null;
            this.cursorW = clampWorld(hit);
            this.snapMark = hit;
            syncCursorStatus();
            ed.requestRender();
            return;
          }

          // First Alt+Click anchor on a contour
          const pt = clampWorld(hit);
          const prev = this.draft.points.at(-1);
          if (!prev || Math.hypot(pt.x - prev.x, pt.y - prev.y) > 1e-6) {
            this.draft.points.push({ x: pt.x, y: pt.y });
          }
          this.traceAnchor = { uid: hit.uid, obj: hit.obj, edgeIndex: hit.edgeIndex, t: hit.t, x: pt.x, y: pt.y };
          this.tracePreview = null;
          this.down0 = null;
          this.cursorW = pt;
          this.snapMark = hit;
          syncCursorStatus();
          ed.requestRender();
          return;
        }
      }

      const rawSnap = snap(e.w);
      const p = clampWorld(this.constrain(rawSnap, e));
      if (this.draft && this.draft.points.length >= 3) {
        const f = R().toScreen(this.draft.points[0].x, this.draft.points[0].y);
        if (Math.hypot(f.x - e.sx, f.y - e.sy) <= 7) { this.finish(); return; }
      }
      if (!this.draft) this.draft = { layerId: layer.id, points: [] };
      this.draft.points.push({ x: p.x, y: p.y });
      this._lastDownAddedSingle = true;
      this.tracePreview = null;
      this.traceAnchor = (p.obj && (p.kind === 'point' || p.kind === 'midpoint' || p.kind === 'edge'))
        ? { uid: p.uid, obj: p.obj, edgeIndex: p.edgeIndex, t: p.t, x: p.x, y: p.y }
        : null;
      this.down0 = { sx: e.sx, sy: e.sy, last: { sx: e.sx, sy: e.sy } };
      this.cursorW = p;
      this.snapMark = p.kind ? p : null;
      syncCursorStatus();
      ed.requestRender();
    },

    move(e) {
      this.altDown = !!e.alt;
      this.shiftDown = !!e.shift;
      this._rawW = { x: e.w.x, y: e.w.y };
      updateTraceAt(this._rawW, this.altDown, this.shiftDown);
      if (this.down0 && (e.buttons & 1) && this.draft && !e.alt) {
        const l = this.down0.last;
        if (Math.hypot(e.sx - l.sx, e.sy - l.sy) >= 10) {
          this.draft.points.push({ x: this.cursorW.x, y: this.cursorW.y });
          this.down0.last = { sx: e.sx, sy: e.sy };
          this.traceAnchor = null;
          this._lastDownAddedSingle = false;
        }
      }
      syncCursorStatus();
      ed.requestRender();
    },

    up() {
      this.down0 = null;
    },

    dblclick() {
      if (!this.draft) return;
      if (this._lastDownAddedSingle && this.draft.points.length > 1) {
        this.draft.points.pop();
      }
      this._lastDownAddedSingle = false;
      this.finish();
    },

    key(e) {
      if (!this.draft) return false;
      if (e.key === 'Enter') { this.finish(); return true; }
      if (e.key === 'Escape') { this.cancel(); return true; }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        this.draft.points.pop();
        this.traceAnchor = null;
        this.tracePreview = null;
        this._lastDownAddedSingle = false;
        if (!this.draft.points.length) this.draft = null;
        syncCursorStatus();
        ed.requestRender();
        return true;
      }
      return false;
    },

    finish() {
      const d = this.draft;
      this.draft = null;
      this.traceAnchor = null;
      this.tracePreview = null;
      this._lastDownAddedSingle = false;
      ed.state.cursorInfo = null;
      if (!d) return;
      let pts = d.points.filter((p, i, a) => i === 0 || Math.hypot(p.x - a[i - 1].x, p.y - a[i - 1].y) > 1e-6);
      while (pts.length > 1 && Math.hypot(pts[0].x - pts.at(-1).x, pts[0].y - pts.at(-1).y) <= 1e-6) pts.pop();
      if (ed.state.brush.curve && pts.length >= 3) {
        pts = catmullRom(pts, ed.state.brush.curveSteps || 6).map(p => ({
          x: clamp(p.x, 0, ed.doc.pixelWidth),
          y: clamp(p.y, 0, ed.doc.pixelHeight)
        }));
      }
      if (pts.length < 3) {
        ed.toast('A polygon needs at least 3 points');
        ed.requestRender();
        return;
      }
      const layer = LAYER_BY_ID[d.layerId];
      if (ed.drawInside?.commit(layer, pts, 'Draw ' + layer.title.replace(/s$/, ''))) return;
      const obj = ed.edit('Draw ' + layer.title.replace(/s$/, ''), () => ed.doc.add(ed.newObjectFromBrush(layer.type, layer.id, { points: pts })));
      if (obj) ed.select([obj]);
    },

    cancel() {
      this.draft = null;
      this.traceAnchor = null;
      this.tracePreview = null;
      this._lastDownAddedSingle = false;
      ed.state.cursorInfo = null;
      ed.requestRender();
    },

    overlay(ctx, r) {
      drawPenToolOverlay(ctx, ed, r, this, drawSnapMark);
    }
  };

  return tool;
}

function drawPenToolOverlay(ctx, ed, r, state, drawSnapMark) {
  const snapInfo = drawSnapMark(ctx, r, state.snapMark);
  const d = state.draft;
  if (!d) return;

  ctx.save();
  const tp = state.tracePreview;
  if (tp && tp.points.length >= 2) {
    ctx.beginPath();
    for (let i = 0; i < tp.points.length; i++) {
      const s = r.toScreen(tp.points[i].x, tp.points[i].y);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    }
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(11, 14, 19, 0.8)';
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    for (let i = 1; i < tp.points.length - 1; i++) {
      const s = r.toScreen(tp.points[i].x, tp.points[i].y);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 2.75, 0, Math.PI * 2);
      ctx.fillStyle = '#22d3ee';
      ctx.fill();
      ctx.strokeStyle = '#0b0e13';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  const controls = tp && tp.points.length >= 2
    ? [...d.points, ...tp.points.slice(1)]
    : (state.cursorW ? [...d.points, state.cursorW] : d.points);
  const path = ed.state.brush.curve && controls.length >= 3 ? catmullRom(controls, 8, false) : controls;
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  path.forEach((p, i) => {
    const s = r.toScreen(p.x, p.y);
    if (i === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  });
  ctx.stroke();

  if (d.points.length >= 2) {
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.5)';
    const a = r.toScreen(d.points[0].x, d.points[0].y);
    const bPt = state.cursorW || d.points.at(-1);
    const b = r.toScreen(bPt.x, bPt.y);
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(a.x, a.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (let i = 0; i < d.points.length; i++) {
    const s = r.toScreen(d.points[i].x, d.points[i].y);
    ctx.fillStyle = i === 0 ? '#3b82f6' : '#fff';
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1;
    ctx.fillRect(s.x - 3, s.y - 3, 6, 6);
    ctx.strokeRect(s.x - 3, s.y - 3, 6, 6);
  }
  ctx.restore();

  if (state.cursorW && d.points.length >= 1) {
    const prev = d.points.length >= 2 ? d.points.at(-2) : null;
    const last = d.points.at(-1);
    const metrics = segmentMetrics(prev, last, state.cursorW);
    const traceCount = tp && tp.points.length > 2 ? tp.points.length - 1 : 0;
    drawSegmentReadout(ctx, r, metrics, state.cursorW, {
      traceCount,
      avoidBox: snapInfo?.labelBox || null
    });
  }
}

/**
 * Standalone overlay hook for render loops calling `drawContourOverlay(ctx, ed)`.
 * No-ops when `tools.pen` already drew via `createContourPenTool`.
 */
export function drawContourOverlay(ctx, ed) {
  if (!ctx || !ed?.renderer) return;
  const t = ed.state?.tool;
  if (t === 'pen' && ed.tool && !ed.tool.__contourSnapIntegrated) {
    drawPenToolOverlay(ctx, ed, ed.renderer, ed.tool, (c, r, p) => drawContourSnapMark(c, r, p));
  }
}

function createEdgeSnapToggle(ed) {
  ensureContourState(ed);
  const edgeToggle = toggle({
    checked: ed.state.snapEdges !== false,
    label: 'Edge/Mid snap (Shift+S)',
    title: 'Snap to polygon edge midpoints and edges (priority: Point > Midpoint > Edge)',
    onChange: v => {
      ed.state.snapEdges = !!v;
      ed.emit?.('view-options');
      ed.emit?.('contour-snap');
      ed.requestRender?.();
    }
  });
  const input = edgeToggle.querySelector('input');
  const sync = () => {
    if (!edgeToggle.isConnected) {
      ed.listeners?.get('view-options')?.delete(sync);
      return;
    }
    if (input) input.checked = ed.state.snapEdges !== false;
  };
  ed.on?.('view-options', sync);
  return edgeToggle;
}

/**
 * Builds the Pen control-bar toggle widget for Edge/Midpoint snapping (Shift+S).
 */
export function buildPenSnapControls(ed) {
  return [h('span', { class: 'cb-sep' }), createEdgeSnapToggle(ed)];
}

/**
 * Opens the "Simplify keeping shared points" dialog and commits as a single undo step.
 */
export async function openSimplifySharedDialog(ed) {
  const selectedPolys = ed.selected().filter(o => o && KIND_BY_TYPE[o.type] === 'poly' && o.points?.length >= 3);
  const targets = selectedPolys.filter(o => !ed.state?.locked?.has(o.layerId));
  if (!targets.length) {
    ed.toast?.(selectedPolys.length ? 'Selected layers are locked' : 'Select one or more polygons to simplify');
    return null;
  }

  const cache = getBoundsCache(ed);
  const initial = previewSimplifyKeepingShared(ed.doc, targets, {
    mode: 'tolerance',
    epsilon: 10,
    tolerance: DEFAULT_SHARED_VERTEX_TOLERANCE,
    boundsCache: cache
  });
  const pinnedSets = initial.items.map(it => it.pinnedIndices);

  let mode = 'tolerance';
  let eps = 1;
  const before = initial.before;
  const minTarget = initial.minTarget;
  const pinnedCount = initial.pinnedCount;
  let targetPoints = Math.max(minTarget, Math.min(before, Math.round(before * 0.5)));

  const seg = h('div', { class: 'seg', style: { marginBottom: '10px' } });
  const controls = h('div');
  const result = h('span', { class: 'v' });

  const pinBadge = h('div', {
    class: 'row',
    style: {
      padding: '6px 8px',
      borderRadius: '4px',
      background: 'var(--bg1)',
      border: '1px solid var(--line)',
      marginBottom: '10px'
    }
  },
    h('span', { class: pinnedCount > 0 ? 'badge ok' : 'badge' }, `${pinnedCount} pinned`),
    h('span', { class: 'muted', style: { fontSize: '11px' } },
      pinnedCount > 0
        ? `Vertices within ${DEFAULT_SHARED_VERTEX_TOLERANCE} px of another object will not move.`
        : `No shared seam vertices within ${DEFAULT_SHARED_VERTEX_TOLERANCE} px found.`)
  );

  const update = () => {
    const prev = previewSimplifyKeepingShared(ed.doc, targets, {
      mode,
      epsilon: eps * PX_PER_UNIT,
      targetPoints,
      tolerance: DEFAULT_SHARED_VERTEX_TOLERANCE,
      boundsCache: cache,
      pinnedSets
    });
    const pct = prev.before ? Math.round((1 - prev.after / prev.before) * 100) : 0;
    result.textContent = `${prev.before} -> ${prev.after} points (${pct}% fewer)`;
  };

  const renderControls = () => {
    clear(seg);
    const tolBtn = h('button', { class: mode === 'tolerance' ? 'on' : '' }, 'Tolerance');
    const tgtBtn = h('button', { class: mode === 'target' ? 'on' : '' }, 'Target points');
    tolBtn.addEventListener('click', () => { mode = 'tolerance'; renderControls(); });
    tgtBtn.addEventListener('click', () => { mode = 'target'; renderControls(); });
    seg.append(tolBtn, tgtBtn);

    clear(controls);
    if (mode === 'tolerance') {
      const range = h('input', { type: 'range', min: 0.05, max: 5, step: 0.05, value: eps });
      const num = numberField({
        label: 'Tolerance',
        value: eps,
        digits: 2,
        step: 0.05,
        min: 0.01,
        max: 50,
        suffix: 'u',
        onCommit: v => { eps = v; range.value = v; update(); }
      });
      range.addEventListener('input', () => {
        eps = Number(range.value);
        update();
        num.setValue(eps);
      });
      controls.append(
        h('p', {}, 'Simplifies unshared outline sections (Douglas-Peucker) while keeping every shared seam vertex fixed.'),
        h('div', { class: 'row' }, range),
        num
      );
    } else {
      const maxTarget = Math.max(minTarget, before);
      const range = h('input', { type: 'range', min: minTarget, max: maxTarget, step: 1, value: targetPoints, disabled: before <= minTarget });
      const num = numberField({
        label: 'Target',
        value: targetPoints,
        digits: 0,
        step: 1,
        min: minTarget,
        max: maxTarget,
        suffix: 'pts',
        disabled: before <= minTarget,
        onCommit: v => { targetPoints = Math.round(v); range.value = targetPoints; update(); }
      });
      range.addEventListener('input', () => {
        targetPoints = Math.round(Number(range.value));
        update();
        num.setValue(targetPoints);
      });
      controls.append(
        h('p', {}, 'Reduces unshared vertices to a target count (Visvalingam-Whyatt) while locking shared seam vertices.'),
        h('div', { class: 'row' }, range),
        num
      );
    }
    update();
  };

  renderControls();
  const choice = await modal({
    title: 'Simplify keeping shared points',
    body: h('div', {}, pinBadge, seg, controls, h('div', { class: 'row', style: { marginTop: '10px' } }, result)),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Simplify', primary: true, value: () => ({ mode, epsilon: eps * PX_PER_UNIT, targetPoints }) }
    ]
  });

  if (!choice) return null;
  const res = ed.edit('Simplify keeping shared points', () =>
    simplifyKeepingShared(ed.doc, targets, {
      mode: choice.mode,
      epsilon: choice.epsilon,
      targetPoints: choice.targetPoints,
      tolerance: DEFAULT_SHARED_VERTEX_TOLERANCE,
      boundsCache: getBoundsCache(ed),
      pinnedSets
    })
  );
  if (res) {
    ed.toast?.(`Removed ${res.removed} point${res.removed === 1 ? '' : 's'} (${res.pinnedCount} shared pinned)`);
  }
  return res;
}

const sharedCountMemo = new WeakMap();
const MAX_EAGER_SHARED_POLYS = 64;

/**
 * Properties panel section for selected polygons: shared seam count,
 * edge/midpoint snap toggle, and seam-preserving simplify trigger.
 */
export function contourPropertiesSection(ed, sel) {
  const polys = (sel || []).filter(o => o && KIND_BY_TYPE[o.type] === 'poly' && o.points?.length >= 3);
  if (!polys.length) return null;
  ensureContourState(ed);

  let asideText;
  if (polys.length > MAX_EAGER_SHARED_POLYS) {
    asideText = 'Seam-safe';
  } else {
    const rev = ed.doc?.revision;
    const key = polys.map(o => o.uid).join(',');
    const memo = sharedCountMemo.get(ed);
    let sharedCount;
    if (memo && memo.doc === ed.doc && memo.revision === rev && memo.key === key) {
      sharedCount = memo.sharedCount;
    } else {
      const cache = getBoundsCache(ed);
      const batch = findSharedVerticesBatch(ed.doc, polys, {
        tolerance: DEFAULT_SHARED_VERTEX_TOLERANCE,
        boundsCache: cache
      });
      sharedCount = 0;
      for (let i = 0; i < polys.length; i++) {
        sharedCount += batch.get(polys[i])?.size || 0;
      }
      sharedCountMemo.set(ed, { doc: ed.doc, revision: rev, key, sharedCount });
    }
    asideText = `${sharedCount} shared pt${sharedCount === 1 ? '' : 's'}`;
  }

  const simpBtn = h('button', { class: 'btn small' }, h('span', { html: icon('simplify') }), 'Simplify (keep seams)...');
  simpBtn.addEventListener('click', () => openSimplifySharedDialog(ed));

  const edgeToggle = createEdgeSnapToggle(ed);

  return h('div', { class: 'section' },
    h('div', { class: 'section-title' },
      h('span', {}, 'Contour & seams'),
      h('span', { class: 'aside' }, asideText)
    ),
    h('div', { class: 'row' }, simpBtn),
    h('div', { class: 'row' }, edgeToggle)
  );
}
