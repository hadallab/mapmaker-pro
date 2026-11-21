// Canvas tools. Each tool receives pointer events with screen (sx, sy) and world (w)
// coordinates. Live drags run inside one document transaction and re-apply the transform
// to a snapshot of the original geometry, so the result is exact and Escape restores it.

import { LAYER_BY_ID, KIND_BY_TYPE, TOOL, layerAllowsTool } from '../engine/layers.js';
import { syncDerived, objectBounds, spriteSize } from '../engine/document.js';
import { distanceToSegment, clamp, intToHex } from '../engine/geometry.js';
import { refreshFoodArea } from '../engine/dpm.js';
import * as ops from '../engine/ops.js';
import { BLOCK_SIZE, blockAt, snapBlock, drawBlocks } from './blocks.js';
import { SCULPT_TOOL_DEF, createSculptTool } from './sculpt-tool.js';
import {
  CONTOUR_PEN_TOOL_DEF,
  createContourPenTool,
  snapContour,
  drawContourSnapMark
} from './contour-snap.js';
import { KNIFE_TOOL_DEF, createKnifeTool } from './knife-tool.js';
import { SCATTER_TOOL_DEF, createScatterTool } from './scatter-tool.js';

const polyLayer = layer => layer && layer.kind === 'poly';
const shapeLayer = layer => layer && (layer.kind === 'poly' || layer.kind === 'rect');

export const TOOL_DEFS = {
  select: {
    title: 'Selection', key: 'O', icon: 'select',
    help: 'Click to select, drag to move. Drag handles to scale, outside corners to rotate. ' +
      'Drag on empty space to marquee (left to right: inside, right to left: touching). ' +
      'Alt+Shift+Click inspects everything under the cursor.'
  },
  point: {
    title: 'Point selection', key: 'P', icon: 'point',
    help: 'Drag vertices. Shift adds to the point selection. Double-click an edge to insert a point. Delete removes points (minimum 3).'
  },
  sculpt: SCULPT_TOOL_DEF,
  move: { title: 'Move', key: 'M', icon: 'move', help: 'Drag anywhere to move the selection. Shift constrains to an axis.' },
  rotate: {
    title: 'Rotate', key: 'T', icon: 'rotate',
    help: 'Drag to rotate the selection around its centre (a single sprite rotates around its anchor). Shift snaps to 15 degrees.'
  },
  pen: CONTOUR_PEN_TOOL_DEF,
  rect: {
    title: 'Rectangle', key: 'R', icon: 'rect', native: TOOL.ShapeSquare, preferLayer: () => 'terrains',
    help: 'Drag to draw. Shift: square. Alt: from centre. On habitat, trigger and spawn layers this creates their area.'
  },
  ellipse: {
    title: 'Ellipse', key: 'E', icon: 'ellipse', native: TOOL.Creation, preferLayer: () => 'terrains',
    help: 'Drag to draw an ellipse polygon. Shift: circle. Alt: from centre. Segment count is in the control bar.'
  },
  polygon: {
    title: 'Regular polygon', key: 'N', icon: 'polygon', native: TOOL.Creation, preferLayer: () => 'terrains',
    help: 'Drag from the centre to draw a regular polygon. Shift snaps the angle. Side count is in the control bar.'
  },
  knife: KNIFE_TOOL_DEF,
  hide: { title: 'Hide Space', key: 'H', icon: 'hide', native: TOOL.HideSpace, layer: 'hide-spaces', help: 'Click to place the hide space chosen in Assets.' },
  scatter: SCATTER_TOOL_DEF,
  animal: { title: 'Preview animal', key: 'A', icon: 'animal', native: TOOL.Animal, layer: 'animals', help: 'Click to place a preview animal (editor only, not visible in game).' },
  prop: { title: 'Prop', key: 'X', icon: 'prop', native: TOOL.Prop, layer: 'props', help: 'Click to place the chosen prop.' },
  eyedropper: { title: 'Eyedropper', key: 'I', icon: 'eyedropper', help: 'Click an object to copy its texture, colour, opacity or asset settings into the brush.' },
  measure: {
    title: 'Measure', key: 'U', icon: 'ruler',
    help: 'Drag to measure distance and angle. The preview animal chosen in Assets is drawn at true size at the end point to check whether it fits a passage.'
  },
  block: {
    title: 'Napoleon block', key: 'B', icon: 'block',
    help: 'Click to place a Napoleon wrasse sand block (78 x 78 game units, editor only). Next to a block it snaps edge to edge; Ctrl places freely. ' +
      'Drag a block to move it, comma and full stop (or [ ]) rotate by 15 deg (Shift: 1 deg), Alt-click or Delete removes.'
  },
  reference: {
    title: 'Reference image', key: '', icon: 'select',
    help: 'Drag the image to move it, drag a corner to resize (Shift: free proportions). Esc or Done to finish.'
  },
  pan: { title: 'Pan', key: 'V', icon: 'pan', help: 'Drag to pan. Hold Space with any tool, or use the middle mouse button.' },
  zoom: { title: 'Zoom', key: 'Z', icon: 'zoom', help: 'Click to zoom in, Alt-click to zoom out, drag a rectangle to zoom to it.' }
};

export function sampleObjectToBrush(ed, obj) {
  if (!obj || !ed?.state?.brush) return { sampled: false, summary: 'Nothing to sample' };
  const b = ed.state.brush;
  const texName = id => ed.catalog?.textureById?.get(id)?.name || `texture #${id}`;
  const twoStops = cols => cols.length >= 2 ? [intToHex(cols[0]), intToHex(cols[1])] : [intToHex(cols[0]), intToHex(cols[0])];
  let summary = '';
  switch (obj.type) {
    case 'Ter':
    case 'C':
      if (obj.texture != null) b.texture = obj.texture;
      summary = `${LAYER_BY_ID[obj.layerId]?.title || obj.type}: ${texName(obj.texture)}`;
      break;
    case 'Bg':
      if (obj.texture != null) b.texture = obj.texture;
      if (obj.opacity != null) b.opacity = obj.opacity;
      summary = `Background: ${texName(obj.texture)}, opacity ${Number(b.opacity).toFixed(2)}`;
      break;
    case 'Air':
      if (obj.texture != null) b.texture = obj.texture;
      if (obj.borderColor != null) b.borderColor = intToHex(obj.borderColor);
      summary = `Air pocket: ${texName(obj.texture)}, border ${b.borderColor}`;
      break;
    case 'Sky':
      if (!obj.colors?.length) return { sampled: false, summary: 'Sky has no gradient colours' };
      b.skyColors = twoStops(obj.colors);
      summary = `Sky: ${b.skyColors.join(' -> ')}`;
      break;
    case 'Wat':
      if (!obj.colors?.length && obj.hasBorder == null) return { sampled: false, summary: 'Water has no gradient colours' };
      if (obj.colors?.length) b.waterColors = twoStops(obj.colors);
      if (obj.hasBorder != null) b.hasBorder = !!obj.hasBorder;
      summary = `Water: ${(b.waterColors || []).join(' -> ')}`;
      break;
    case 'H':
      if (obj.hSType != null) b.hSType = obj.hSType;
      summary = `Hide space: ${ed.catalog?.hideSpaceById?.get(obj.hSType)?.name || '#' + obj.hSType}`;
      break;
    case 'A':
      if (obj.fLevel != null) b.fLevel = obj.fLevel;
      summary = `Preview animal: ${ed.catalog?.animalByLevel?.get(obj.fLevel)?.name || 'level ' + obj.fLevel}`;
      break;
    case 'P':
      if (obj.pType != null) b.pType = obj.pType;
      summary = `Prop: ${ed.catalog?.propById?.get(obj.pType)?.name || '#' + obj.pType}`;
      break;
    default:
      return { sampled: false, summary: `${LAYER_BY_ID[obj.layerId]?.title || obj.type} has no brush settings` };
  }
  ed.emit?.('brush');
  return { sampled: true, summary };
}

export function toolAllowed(name, layerId) {
  const def = TOOL_DEFS[name];
  if (!def?.native || def.layer) return true;
  return layerAllowsTool(LAYER_BY_ID[layerId], def.native);
}

function geometryOf(o) {
  const k = KIND_BY_TYPE[o.type];
  if (k === 'poly') return { points: o.points.map(p => ({ x: p.x, y: p.y })) };
  if (k === 'rect') return { position: { ...o.position }, size: { ...o.size } };
  return { x: o.x, y: o.y, rotation: o.rotation };
}

function restoreGeometry(o, g) {
  const k = KIND_BY_TYPE[o.type];
  if (k === 'poly') o.points = g.points.map(p => ({ x: p.x, y: p.y }));
  else if (k === 'rect') { o.position = { ...g.position }; o.size = { ...g.size }; syncDerived(o); }
  else { o.x = g.x; o.y = g.y; o.rotation = g.rotation; }
}

export function createTools(ed) {
  const R = () => ed.renderer;
  const zoom = () => ed.renderer.view.zoom;

  // ---------- snapping ----------
  function snap(w, opts) {
    return snapContour(ed, w, opts);
  }

  function clampWorld(p) {
    return { x: clamp(p.x, 0, ed.doc.pixelWidth), y: clamp(p.y, 0, ed.doc.pixelHeight) };
  }

  function drawSnapMark(ctx, r, p) {
    return drawContourSnapMark(ctx, r, p);
  }

  // ---------- transform box ----------
  function selectionBox() {
    const sel = ed.selected();
    if (!sel.length) return null;
    const b = ops.selectionBounds(sel, ed.catalog);
    if (!b) return null;
    const onlySprites = sel.every(o => KIND_BY_TYPE[o.type] === 'sprite');
    const scalable = !(onlySprites && sel.length === 1);
    const rotatable = sel.some(o => KIND_BY_TYPE[o.type] !== 'rect');
    return { b, scalable, rotatable, sel };
  }

  function handlePoints(b) {
    const { x, y, width: w, height: h } = b;
    return [
      { i: 0, x, y, cursor: 'nwse-resize' }, { i: 1, x: x + w / 2, y, cursor: 'ns-resize' }, { i: 2, x: x + w, y, cursor: 'nesw-resize' },
      { i: 3, x: x + w, y: y + h / 2, cursor: 'ew-resize' }, { i: 4, x: x + w, y: y + h, cursor: 'nwse-resize' },
      { i: 5, x: x + w / 2, y: y + h, cursor: 'ns-resize' }, { i: 6, x, y: y + h, cursor: 'nesw-resize' }, { i: 7, x, y: y + h / 2, cursor: 'ew-resize' }
    ];
  }

  function boxHit(sx, sy) {
    const box = selectionBox();
    if (!box) return null;
    const r = R();
    for (const hp of handlePoints(box.b)) {
      const s = r.toScreen(hp.x, hp.y);
      const dx = sx - s.x, dy = sy - s.y;
      if (box.scalable && Math.abs(dx) <= 5 && Math.abs(dy) <= 5) return { kind: 'scale', handle: hp, box };
      if (box.rotatable && [0, 2, 4, 6].includes(hp.i)) {
        const d = Math.hypot(dx, dy);
        if (d > 6 && d < 22) {
          const tl = r.toScreen(box.b.x, box.b.y), br = r.toScreen(box.b.x + box.b.width, box.b.y + box.b.height);
          const outside = sx < tl.x || sx > br.x || sy < tl.y || sy > br.y;
          if (outside) return { kind: 'rotate', handle: hp, box };
        }
      }
    }
    return null;
  }

  function drawBox(ctx, r) {
    const box = selectionBox();
    if (!box) return;
    const tl = r.toScreen(box.b.x, box.b.y), br = r.toScreen(box.b.x + box.b.width, box.b.y + box.b.height);
    ctx.save();
    ctx.strokeStyle = 'rgba(59,130,246,0.9)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(Math.round(tl.x) + 0.5, Math.round(tl.y) + 0.5, Math.round(br.x - tl.x), Math.round(br.y - tl.y));
    ctx.setLineDash([]);
    if (box.scalable) {
      for (const hp of handlePoints(box.b)) {
        const s = r.toScreen(hp.x, hp.y);
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#3b82f6';
        ctx.fillRect(Math.round(s.x) - 3.5, Math.round(s.y) - 3.5, 7, 7);
        ctx.strokeRect(Math.round(s.x) - 3.5, Math.round(s.y) - 3.5, 7, 7);
      }
    }
    ctx.restore();
  }

  // ---------- generic live transform session ----------
  function beginSession(label, objs) {
    const tx = ed.doc.begin(label);
    const originals = new Map(objs.map(o => [o.uid, geometryOf(o)]));
    return {
      objs, tx,
      reset() { for (const o of objs) { ed.doc.touch(o); restoreGeometry(o, originals.get(o.uid)); } },
      commit() { for (const o of objs) if (o.type === 'Food') refreshFoodArea(o); tx.commit(); },
      cancel() { tx.cancel(); }
    };
  }

  function drawMarquee(ctx, m) {
    if (!m) return;
    const x = Math.min(m.x0, m.x1), y = Math.min(m.y0, m.y1), w = Math.abs(m.x1 - m.x0), hgt = Math.abs(m.y1 - m.y0);
    const touching = m.x1 < m.x0;
    ctx.save();
    ctx.fillStyle = touching ? 'rgba(63,178,127,0.08)' : 'rgba(59,130,246,0.08)';
    ctx.strokeStyle = touching ? 'rgba(63,178,127,0.9)' : 'rgba(59,130,246,0.9)';
    ctx.setLineDash(touching ? [5, 3] : []);
    ctx.fillRect(x, y, w, hgt);
    ctx.strokeRect(x + 0.5, y + 0.5, w, hgt);
    ctx.restore();
  }

  function marqueeRect(m) {
    const a = R().toWorld(Math.min(m.x0, m.x1), Math.min(m.y0, m.y1));
    const b = R().toWorld(Math.max(m.x0, m.x1), Math.max(m.y0, m.y1));
    return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y, touch: m.x1 < m.x0 };
  }

  // ---------- move / rotate / scale drags shared by tools ----------
  // Smart guides: edges and centres of other visible objects and the world.
  function guideTargets(exclude) {
    const xs = [], ys = [];
    const W = ed.doc.pixelWidth, H = ed.doc.pixelHeight;
    xs.push(0, W / 2, W); ys.push(0, H / 2, H);
    for (const layerId of Object.keys(ed.doc.layers)) {
      if (!ed.state.visible.has(layerId) || LAYER_BY_ID[layerId].helper) continue;
      for (const o of ed.doc.layers[layerId]) {
        if (exclude.has(o.uid)) continue;
        const b = objectBounds(o, ed.catalog);
        xs.push(b.x, b.x + b.width / 2, b.x + b.width);
        ys.push(b.y, b.y + b.height / 2, b.y + b.height);
      }
    }
    return { xs: Float64Array.from(xs).sort(), ys: Float64Array.from(ys).sort() };
  }

  function nearest(sorted, v) {
    let lo = 0, hi = sorted.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
    let best = sorted[lo];
    if (lo > 0 && Math.abs(sorted[lo - 1] - v) < Math.abs(best - v)) best = sorted[lo - 1];
    return best;
  }

  function snapToGuides(box, dx, dy, targets) {
    const tol = 6 / zoom();
    const lines = [];
    let bestX = null, bestY = null;
    for (const v of [box.x, box.x + box.width / 2, box.x + box.width]) {
      const t = nearest(targets.xs, v + dx);
      if (Math.abs(t - (v + dx)) <= tol && (!bestX || Math.abs(t - (v + dx)) < Math.abs(bestX.d))) bestX = { d: t - (v + dx), at: t };
    }
    for (const v of [box.y, box.y + box.height / 2, box.y + box.height]) {
      const t = nearest(targets.ys, v + dy);
      if (Math.abs(t - (v + dy)) <= tol && (!bestY || Math.abs(t - (v + dy)) < Math.abs(bestY.d))) bestY = { d: t - (v + dy), at: t };
    }
    if (bestX) { dx += bestX.d; lines.push({ x: bestX.at }); }
    if (bestY) { dy += bestY.d; lines.push({ y: bestY.at }); }
    return { dx, dy, lines };
  }

  function drawGuides(ctx, r) {
    if (!ed.guides?.length) return;
    ctx.save();
    ctx.strokeStyle = '#ff4fd8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const g of ed.guides) {
      if (g.x != null) { const s = r.toScreen(g.x, 0).x; ctx.moveTo(Math.round(s) + 0.5, 0); ctx.lineTo(Math.round(s) + 0.5, r.height); }
      else { const s = r.toScreen(0, g.y).y; ctx.moveTo(0, Math.round(s) + 0.5); ctx.lineTo(r.width, Math.round(s) + 0.5); }
    }
    ctx.stroke();
    ctx.restore();
  }

  function moveDrag(e, objs, label = 'Move') {
    const session = beginSession(label, objs);
    const start = e.w;
    const startBox = ops.selectionBounds(objs, ed.catalog);
    const targets = ed.state.smartGuides ? guideTargets(new Set(objs.map(o => o.uid))) : null;
    return {
      move(ev) {
        let dx = ev.w.x - start.x, dy = ev.w.y - start.y;
        if (ev.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        session.reset();
        if (ed.state.snapGrid && startBox) {
          const g = ed.state.gridStep;
          dx = Math.round((startBox.x + dx) / g) * g - startBox.x;
          dy = Math.round((startBox.y + dy) / g) * g - startBox.y;
        }
        ed.guides = [];
        if (targets && startBox && !ed.state.snapGrid && !ev.alt) {
          const g = snapToGuides(startBox, dx, dy, targets);
          dx = g.dx; dy = g.dy; ed.guides = g.lines;
        }
        if (ed.state.keepInWorld) ({ dx, dy } = ops.clampDelta(ed.doc, objs, ed.catalog, dx, dy));
        ops.translate(ed.doc, objs, dx, dy);
        ed.state.cursorInfo = `dx ${(dx / 10).toFixed(2)}  dy ${(dy / 10).toFixed(2)}`;
        ed.requestRender();
      },
      up() { session.commit(); ed.state.cursorInfo = null; ed.guides = []; },
      cancel() { session.cancel(); ed.state.cursorInfo = null; ed.guides = []; }
    };
  }

  function rotateDrag(e, objs, pivot) {
    const session = beginSession('Rotate', objs);
    const a0 = Math.atan2(e.w.y - pivot.y, e.w.x - pivot.x);
    return {
      move(ev) {
        let deg = (Math.atan2(ev.w.y - pivot.y, ev.w.x - pivot.x) - a0) * 180 / Math.PI;
        if (ev.shift) deg = Math.round(deg / 15) * 15;
        session.reset();
        ops.rotate(ed.doc, objs, deg, pivot);
        ed.state.cursorInfo = `${ops.normalizeAngle(deg).toFixed(1)} deg`;
        ed.requestRender();
      },
      up() { session.commit(); ed.state.cursorInfo = null; },
      cancel() { session.cancel(); ed.state.cursorInfo = null; },
      pivot
    };
  }

  function scaleDrag(e, objs, handle, b) {
    const session = beginSession('Scale', objs);
    const hx = handle.i === 1 || handle.i === 5 ? null : (handle.i === 0 || handle.i === 6 || handle.i === 7 ? 'l' : 'r');
    const hy = handle.i === 3 || handle.i === 7 ? null : (handle.i <= 2 ? 't' : 'b');
    return {
      move(ev) {
        const center = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        const anchor = ev.alt ? center : { x: hx === 'l' ? b.x + b.width : b.x, y: hy === 't' ? b.y + b.height : b.y };
        const p = snap(ev.w, { exclude: ed.state.selection });
        let sx = 1, sy = 1;
        if (hx) { const base = (hx === 'l' ? b.x : b.x + b.width) - anchor.x; sx = base ? (p.x - anchor.x) / base : 1; }
        if (hy) { const base = (hy === 't' ? b.y : b.y + b.height) - anchor.y; sy = base ? (p.y - anchor.y) / base : 1; }
        if (ev.shift) {
          if (hx && hy) { const k = Math.max(Math.abs(sx), Math.abs(sy)); sx = Math.sign(sx || 1) * k; sy = Math.sign(sy || 1) * k; }
          else if (hx) sy = Math.abs(sx);
          else sx = Math.abs(sy);
        }
        if (Math.abs(sx) < 1e-3) sx = 1e-3 * Math.sign(sx || 1);
        if (Math.abs(sy) < 1e-3) sy = 1e-3 * Math.sign(sy || 1);
        session.reset();
        ops.scale(ed.doc, objs, sx, sy, anchor);
        ed.state.cursorInfo = `${(Math.abs(sx) * 100).toFixed(1)}%  x  ${(Math.abs(sy) * 100).toFixed(1)}%`;
        ed.requestRender();
      },
      up() { session.commit(); ed.state.cursorInfo = null; },
      cancel() { session.cancel(); ed.state.cursorInfo = null; }
    };
  }

  // ---------- tools ----------
  const tools = {};

  tools.select = {
    cursor: 'default',
    drag: null, marquee: null, hover: null, pending: null,
    down(e) {
      if (ed.inspectClick?.(e)) return;
      const hit = boxHit(e.sx, e.sy);
      if (hit?.kind === 'scale') { this.drag = scaleDrag(e, hit.box.sel, hit.handle, hit.box.b); return; }
      if (hit?.kind === 'rotate') {
        const sel = hit.box.sel;
        const pivot = sel.length === 1 && KIND_BY_TYPE[sel[0].type] === 'sprite' ? { x: sel[0].x, y: sel[0].y } : ops.pivotOf(sel, ed.catalog);
        this.drag = rotateDrag(e, sel, pivot);
        return;
      }
      const obj = ed.hitTest(e.w);
      if (obj) {
        if (e.shift) { ed.select(e.ctrl ? [obj] : ed.meta.expand([obj]), 'toggle'); return; }
        if (!ed.state.selection.has(obj.uid)) ed.select(e.ctrl ? [obj] : ed.meta.expand([obj]));
        this.pending = { e, alt: e.alt };
      } else {
        if (!e.shift) ed.deselect();
        this.marquee = { x0: e.sx, y0: e.sy, x1: e.sx, y1: e.sy, add: e.shift };
      }
    },
    move(e) {
      if (this.pending && Math.hypot(e.sx - this.pending.e.sx, e.sy - this.pending.e.sy) > 3) {
        let objs = ed.selected();
        if (this.pending.alt) {
          const tx = ed.doc.begin('Duplicate');
          objs = ops.duplicate(ed.doc, objs);
          tx.commit();
          ed.select(objs);
        }
        this.drag = moveDrag(this.pending.e, objs);
        this.pending = null;
      }
      if (this.drag) { this.drag.move(e); return; }
      if (this.marquee) { this.marquee.x1 = e.sx; this.marquee.y1 = e.sy; ed.requestRender(); return; }
      const hit = boxHit(e.sx, e.sy);
      ed.viewport.style.cursor = hit ? (hit.kind === 'scale' ? hit.handle.cursor : 'alias') : 'default';
      const hov = hit ? null : ed.hitTest(e.w);
      if (hov !== this.hover) { this.hover = hov; ed.requestRender(); }
    },
    up() {
      if (this.drag) { this.drag.up(); this.drag = null; }
      if (this.marquee) {
        const m = this.marquee;
        if (Math.abs(m.x1 - m.x0) > 2 || Math.abs(m.y1 - m.y0) > 2) {
          ed.select(ed.meta.expand(ed.objectsInRect(marqueeRect(m))), m.add ? 'add' : 'replace');
        }
        this.marquee = null;
        ed.requestRender();
      }
      this.pending = null;
    },
    cancel() { this.drag?.cancel(); this.drag = null; this.marquee = null; this.pending = null; ed.requestRender(); },
    overlay(ctx, r) { drawBox(ctx, r); drawMarquee(ctx, this.marquee); drawGuides(ctx, r); },
    deactivate() { this.hover = null; }
  };

  tools.move = {
    cursor: 'move',
    drag: null,
    down(e) {
      if (!ed.selected().length) { const o = ed.hitTest(e.w); if (o) ed.select([o]); }
      const objs = ed.selected();
      if (objs.length) this.drag = moveDrag(e, objs);
    },
    move(e) { this.drag?.move(e); },
    up() { this.drag?.up(); this.drag = null; },
    cancel() { this.drag?.cancel(); this.drag = null; ed.requestRender(); },
    overlay(ctx, r) { drawBox(ctx, r); drawGuides(ctx, r); }
  };

  tools.rotate = {
    cursor: 'alias',
    drag: null,
    down(e) {
      const o = ed.hitTest(e.w);
      if (o && !ed.state.selection.has(o.uid) && !ed.selected().length) ed.select([o]);
      const sel = ed.selected();
      if (!sel.length) return;
      const pivot = sel.length === 1 && KIND_BY_TYPE[sel[0].type] === 'sprite' ? { x: sel[0].x, y: sel[0].y } : ops.pivotOf(sel, ed.catalog);
      this.drag = rotateDrag(e, sel, pivot);
    },
    move(e) { this.drag?.move(e); },
    up() { this.drag?.up(); this.drag = null; },
    cancel() { this.drag?.cancel(); this.drag = null; ed.requestRender(); },
    overlay(ctx, r) {
      drawBox(ctx, r);
      const sel = ed.selected();
      if (!sel.length) return;
      const p = this.drag?.pivot || (sel.length === 1 && KIND_BY_TYPE[sel[0].type] === 'sprite'
        ? { x: sel[0].x, y: sel[0].y }
        : ops.pivotOf(sel, ed.catalog));
      const s = r.toScreen(p.x, p.y);
      ctx.save();
      ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
      ctx.moveTo(s.x - 10, s.y); ctx.lineTo(s.x + 10, s.y);
      ctx.moveTo(s.x, s.y - 10); ctx.lineTo(s.x, s.y + 10);
      ctx.stroke();
      ctx.restore();
    }
  };

  // ---------- point editing ----------
  function pointAt(sx, sy) {
    const r = R();
    for (const o of ed.selected()) {
      if (KIND_BY_TYPE[o.type] === 'sprite') continue;
      for (let i = o.points.length - 1; i >= 0; i--) {
        const s = r.toScreen(o.points[i].x, o.points[i].y);
        if (Math.abs(s.x - sx) <= 5 && Math.abs(s.y - sy) <= 5) return { o, i };
      }
    }
    return null;
  }

  function edgeAt(w) {
    const tol = 5 / zoom();
    for (const o of ed.selected()) {
      if (KIND_BY_TYPE[o.type] !== 'poly') continue;
      for (let i = 0; i < o.points.length; i++) {
        const d = distanceToSegment(w, o.points[i], o.points[(i + 1) % o.points.length]);
        if (d.distance <= tol && d.t > 0.001 && d.t < 0.999) return { o, index: i + 1, at: { x: d.x, y: d.y } };
      }
    }
    return null;
  }

  function insertPoint(edge) {
    ed.edit('Add point', () => {
      ed.doc.touch(edge.o);
      edge.o.points.splice(edge.index, 0, { x: edge.at.x, y: edge.at.y });
    });
    ed.state.points.set(edge.o.uid, new Set([edge.index]));
    ed.emit('selection');
    ed.requestRender();
  }

  tools.point = {
    cursor: 'default',
    drag: null, marquee: null, hover: null, snapMark: null,
    down(e) {
      const hit = pointAt(e.sx, e.sy);
      if (hit) {
        const set = ed.state.points.get(hit.o.uid) || new Set();
        if (e.shift) {
          set.has(hit.i) ? set.delete(hit.i) : set.add(hit.i);
          ed.state.points.set(hit.o.uid, set);
          ed.emit('selection');
          ed.requestRender();
          return;
        }
        if (!set.has(hit.i)) { ed.state.points.clear(); ed.state.points.set(hit.o.uid, new Set([hit.i])); ed.emit('selection'); }
        this.startPointDrag(e, hit);
        return;
      }
      if (e.alt) { const edge = edgeAt(e.w); if (edge) { insertPoint(edge); return; } }
      const obj = ed.hitTest(e.w);
      if (obj && !ed.state.selection.has(obj.uid)) { ed.select([obj], e.shift ? 'add' : 'replace'); return; }
      if (!obj && !e.shift && ed.state.points.size) { ed.state.points.clear(); ed.emit('selection'); }
      this.marquee = { x0: e.sx, y0: e.sy, x1: e.sx, y1: e.sy, add: e.shift, objectMode: !ed.selected().length };
      ed.requestRender();
    },
    dblclick(e) {
      const edge = edgeAt(e.w);
      if (edge) insertPoint(edge);
    },
    startPointDrag(e, hit) {
      const targets = [...ed.state.points.keys()].map(uid => ed.doc.get(uid)).filter(Boolean);
      const session = beginSession('Move points', targets);
      const start = { x: hit.o.points[hit.i].x, y: hit.o.points[hit.i].y };
      const exclude = new Set(targets.map(t => t.uid));
      this.drag = {
        move: ev => {
          const p = snap(ev.w, { exclude });
          let dx = p.x - start.x, dy = p.y - start.y;
          if (ev.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
          session.reset();
          for (const o of targets) {
            const set = ed.state.points.get(o.uid);
            if (!set) continue;
            if (KIND_BY_TYPE[o.type] === 'rect') {
              const i = [...set][0];
              const W = ed.doc.pixelWidth, H = ed.doc.pixelHeight;
              let x0 = o.position.x, y0 = o.position.y, x1 = x0 + o.size.width, y1 = y0 + o.size.height;
              const nx = clamp(o.points[i].x + dx, 0, W), ny = clamp(o.points[i].y + dy, 0, H);
              if (i === 0 || i === 3) x0 = Math.min(nx, x1 - 10); else x1 = Math.max(nx, x0 + 10);
              if (i === 0 || i === 1) y0 = Math.min(ny, y1 - 10); else y1 = Math.max(ny, y0 + 10);
              o.position = { x: x0, y: y0 }; o.size = { width: x1 - x0, height: y1 - y0 };
              syncDerived(o);
            } else {
              for (const i of set) { o.points[i].x += dx; o.points[i].y += dy; }
            }
          }
          this.snapMark = p.kind ? p : null;
          ed.requestRender();
        },
        up: () => { session.commit(); this.snapMark = null; },
        cancel: () => { session.cancel(); this.snapMark = null; }
      };
    },
    move(e) {
      if (this.drag) { this.drag.move(e); return; }
      if (this.marquee) { this.marquee.x1 = e.sx; this.marquee.y1 = e.sy; ed.requestRender(); return; }
      const p = pointAt(e.sx, e.sy);
      ed.viewport.style.cursor = p ? 'move' : (e.alt && edgeAt(e.w) ? 'copy' : 'default');
      const hov = p ? null : ed.hitTest(e.w);
      if (hov !== this.hover) { this.hover = hov; ed.requestRender(); }
    },
    up() {
      if (this.drag) { this.drag.up(); this.drag = null; }
      if (this.marquee) {
        const m = this.marquee;
        const r = marqueeRect(m);
        if (Math.abs(m.x1 - m.x0) > 2 || Math.abs(m.y1 - m.y0) > 2) {
          if (m.objectMode) ed.select(ed.objectsInRect({ ...r, touch: true }), m.add ? 'add' : 'replace');
          else {
            if (!m.add) ed.state.points.clear();
            for (const o of ed.selected()) {
              if (KIND_BY_TYPE[o.type] !== 'poly') continue;
              const set = ed.state.points.get(o.uid) || new Set();
              o.points.forEach((p, i) => { if (p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height) set.add(i); });
              if (set.size) ed.state.points.set(o.uid, set);
            }
            ed.emit('selection');
          }
        }
        this.marquee = null;
        ed.requestRender();
      }
    },
    cancel() { this.drag?.cancel(); this.drag = null; this.marquee = null; ed.requestRender(); },
    overlay(ctx, r) { drawMarquee(ctx, this.marquee); drawSnapMark(ctx, r, this.snapMark); },
    deactivate() { ed.state.points.clear(); this.hover = null; }
  };

  // ---------- draw points ----------
  tools.pen = createContourPenTool(ed, { snap, drawSnapMark, edgeAt, insertPoint });

  // ---------- shapes ----------
  function shapeTool(kind) {
    return {
      cursor: 'crosshair',
      start: null, end: null, mods: {}, snapMark: null,
      down(e) {
        const layer = LAYER_BY_ID[ed.state.activeLayer];
        if (kind === 'rect' ? !shapeLayer(layer) : !polyLayer(layer)) { ed.toast(`${TOOL_DEFS[kind].title} is not available on ${layer.title}`); return; }
        this.start = clampWorld(snap(e.w));
        this.end = this.start;
      },
      move(e) {
        const p = clampWorld(snap(e.w));
        this.snapMark = p.kind ? p : null;
        if (this.start) { this.end = p; this.mods = { shift: e.shift, alt: e.alt }; }
        ed.requestRender();
      },
      geometry() {
        const a = this.start, b = this.end;
        if (!a || !b) return null;
        if (kind === 'polygon') {
          const n = Math.max(3, Math.min(64, ed.state.brush.sides | 0));
          let rad = Math.hypot(b.x - a.x, b.y - a.y);
          let ang = Math.atan2(b.y - a.y, b.x - a.x);
          if (this.mods.shift) ang = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
          if (rad < 1) return null;
          return Array.from({ length: n }, (_, i) => clampWorld({
            x: a.x + Math.cos(ang + i * 2 * Math.PI / n) * rad,
            y: a.y + Math.sin(ang + i * 2 * Math.PI / n) * rad
          }));
        }
        let w = b.x - a.x, hgt = b.y - a.y;
        if (this.mods.shift) { const m = Math.max(Math.abs(w), Math.abs(hgt)); w = Math.sign(w || 1) * m; hgt = Math.sign(hgt || 1) * m; }
        let x0 = a.x, y0 = a.y;
        if (this.mods.alt) { x0 = a.x - w; y0 = a.y - hgt; w *= 2; hgt *= 2; }
        const r = { x: Math.min(x0, x0 + w), y: Math.min(y0, y0 + hgt), width: Math.abs(w), height: Math.abs(hgt) };
        const W = ed.doc.pixelWidth, H = ed.doc.pixelHeight;
        const x1 = clamp(r.x + r.width, 0, W), y1 = clamp(r.y + r.height, 0, H);
        r.x = clamp(r.x, 0, W); r.y = clamp(r.y, 0, H); r.width = x1 - r.x; r.height = y1 - r.y;
        if (r.width < 0.5 || r.height < 0.5) return null;
        if (kind === 'rect') return r;
        const n = Math.max(3, Math.min(256, ed.state.brush.segments | 0));
        const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
        return Array.from({ length: n }, (_, i) => ({
          x: cx + Math.cos(i / n * Math.PI * 2) * r.width / 2,
          y: cy + Math.sin(i / n * Math.PI * 2) * r.height / 2
        }));
      },
      up() {
        const g = this.geometry();
        this.start = this.end = null;
        ed.requestRender();
        if (!g) return;
        const layer = LAYER_BY_ID[ed.state.activeLayer];
        const rectPoly = () => [
          { x: g.x, y: g.y }, { x: g.x + g.width, y: g.y },
          { x: g.x + g.width, y: g.y + g.height }, { x: g.x, y: g.y + g.height }
        ];
        if (layer.kind !== 'rect') {
          const maskPts = Array.isArray(g) ? g : rectPoly();
          if (ed.drawInside?.commit(layer, maskPts, 'Draw ' + TOOL_DEFS[kind].title.toLowerCase())) return;
        }
        const obj = ed.edit('Draw ' + TOOL_DEFS[kind].title.toLowerCase(), () => {
          if (layer.kind === 'rect') {
            const o = ed.newObjectFromBrush(layer.type, layer.id, { position: { x: g.x, y: g.y }, size: { width: g.width, height: g.height } });
            if (o.type === 'Food') refreshFoodArea(o);
            return ed.doc.add(o);
          }
          const pts = Array.isArray(g) ? g : rectPoly();
          return ed.doc.add(ed.newObjectFromBrush(layer.type, layer.id, { points: pts }));
        });
        if (obj) ed.select([obj]);
      },
      cancel() { this.start = this.end = null; ed.requestRender(); },
      overlay(ctx, r) {
        drawSnapMark(ctx, r, this.snapMark);
        const g = this.geometry();
        if (!g) return;
        ctx.save();
        ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 1.5; ctx.fillStyle = 'rgba(59,130,246,0.12)';
        ctx.beginPath();
        if (Array.isArray(g)) g.forEach((p, i) => { const s = r.toScreen(p.x, p.y); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
        else { const a = r.toScreen(g.x, g.y), b = r.toScreen(g.x + g.width, g.y + g.height); ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y); }
        ctx.closePath(); ctx.fill(); ctx.stroke();
        const label = Array.isArray(g) ? `${g.length} points` : `${(g.width / 10).toFixed(2)} x ${(g.height / 10).toFixed(2)}`;
        const s = r.toScreen(this.end.x, this.end.y);
        ctx.font = '11px ' + getComputedStyle(document.body).getPropertyValue('--mono');
        ctx.fillStyle = 'rgba(17,20,26,0.9)'; const tw = ctx.measureText(label).width;
        ctx.fillRect(s.x + 12, s.y + 10, tw + 10, 18);
        ctx.fillStyle = '#d6dbe4'; ctx.fillText(label, s.x + 17, s.y + 23);
        ctx.restore();
      }
    };
  }
  tools.rect = shapeTool('rect');
  tools.ellipse = shapeTool('ellipse');
  tools.polygon = shapeTool('polygon');

  // ---------- sprite placement ----------
  function placeTool(type) {
    return {
      cursor: 'crosshair',
      ghost: null,
      make(w) {
        const b = ed.state.brush;
        const base = { type, x: w.x, y: w.y, rotation: 0 };
        if (type === 'H') base.hSType = b.hSType;
        if (type === 'A') base.fLevel = b.fLevel;
        if (type === 'P') base.pType = b.pType;
        return base;
      },
      move(e) { const p = snap(e.w, { allowPoints: false }); this.ghost = this.make(p); ed.requestRender(); },
      down(e) {
        const p = clampWorld(snap(e.w, { allowPoints: false }));
        const layer = { H: 'hide-spaces', A: 'animals', P: 'props' }[type];
        const init = this.make(p);
        const obj = ed.edit('Place ' + TOOL_DEFS[{ H: 'hide', A: 'animal', P: 'prop' }[type]].title.toLowerCase(), () => {
          const o = ed.newObjectFromBrush(type, layer, init);
          if (type === 'P') {
            const prop = ed.catalog.propById.get(o.pType);
            if (prop?.params?.some(pr => pr.key === 'text')) o.params = { text: '' };
          }
          return ed.doc.add(o);
        });
        if (obj) ed.select([obj]);
      },
      cancel() { this.ghost = null; ed.requestRender(); },
      deactivate() { this.ghost = null; },
      overlay(ctx, r) {
        if (!this.ghost) return;
        r.worldTransform();
        ctx.save();
        ctx.globalAlpha = 0.55;
        r.drawSpriteObject({ ...this.ghost, opacity: 1 }, false);
        ctx.restore();
        r.screenTransform();
      }
    };
  }
  tools.hide = placeTool('H');
  tools.animal = placeTool('A');
  tools.prop = placeTool('P');

  // ---------- measure ----------
  function constrainAngle(a, p, shift) {
    if (!shift) return p;
    const dx = p.x - a.x, dy = p.y - a.y;
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
    return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
  }

  function label(ctx, text, x, y) {
    ctx.save();
    ctx.font = '11px ' + getComputedStyle(document.body).getPropertyValue('--mono');
    const w = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(17,20,26,0.92)'; ctx.fillRect(x - 5, y - 13, w + 10, 18);
    ctx.fillStyle = '#ffe28a'; ctx.fillText(text, x, y);
    ctx.restore();
  }

  tools.measure = {
    cursor: 'crosshair',
    a: null, b: null, hoverW: null,
    down(e) { const p = snap(e.w); this.a = p; this.b = p; ed.requestRender(); },
    move(e) {
      const p = snap(e.w);
      this.hoverW = p;
      if (this.a && e.buttons & 1) this.b = constrainAngle(this.a, p, e.shift);
      ed.requestRender();
    },
    up() { ed.requestRender(); },
    cancel() { this.a = this.b = null; ed.requestRender(); },
    overlay(ctx, r) {
      const animal = { type: 'A', fLevel: ed.state.brush.fLevel, rotation: 0 };
      const info = ed.catalog.animalByLevel.get(animal.fLevel);
      const size = info ? spriteSize(animal, ed.catalog) : null;
      const at = this.b || this.hoverW;
      if (at && info) {
        r.worldTransform();
        ctx.save(); ctx.globalAlpha = 0.6;
        r.drawSpriteObject({ ...animal, x: at.x, y: at.y }, false);
        ctx.restore();
        r.screenTransform();
        const s = r.toScreen(at.x, at.y);
        label(ctx, `${info.name} ${(size.width / 10).toFixed(2)} x ${(size.height / 10).toFixed(2)} u`, s.x + 14, s.y - 26);
      }
      if (!this.a || !this.b) return;
      const p = r.toScreen(this.a.x, this.a.y), q = r.toScreen(this.b.x, this.b.y);
      ctx.save();
      ctx.strokeStyle = '#ffd24a'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      ctx.fillStyle = '#ffd24a';
      for (const t of [p, q]) { ctx.beginPath(); ctx.arc(t.x, t.y, 3.5, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
      const dx = (this.b.x - this.a.x) / 10, dy = (this.b.y - this.a.y) / 10;
      const dist = Math.hypot(dx, dy), ang = Math.atan2(-dy, dx) * 180 / Math.PI;
      let text = `${dist.toFixed(2)} u   dx ${dx.toFixed(2)}  dy ${dy.toFixed(2)}   ${ang.toFixed(1)} deg`;
      if (info) {
        const need = Math.max(size.width, size.height) / 10;
        text += dist >= need ? `   ${info.name} fits (${need.toFixed(2)} u)` : `   narrower than ${info.name} (${need.toFixed(2)} u)`;
      }
      label(ctx, text, (p.x + q.x) / 2 + 10, (p.y + q.y) / 2 - 10);
    },
    deactivate() { this.a = this.b = this.hoverW = null; }
  };

  // ---------- Napoleon blocks (editor-only measuring pieces) ----------
  tools.block = {
    cursor: 'crosshair',
    rotation: 0, hover: null, ghost: null, drag: null,
    blocks() { return ed.meta.blocks; },
    move(e) {
      if (this.drag) {
        const b = this.drag.block;
        b.x = e.w.x - this.drag.dx; b.y = e.w.y - this.drag.dy;
        ed.meta.setBlocks(this.blocks(), true);
        return;
      }
      this.hover = blockAt(this.blocks(), e.w.x, e.w.y);
      this.ghost = this.hover
        ? null
        : (e.ctrl ? { x: e.w.x, y: e.w.y, rotation: this.rotation } : snapBlock(this.blocks(), e.w.x, e.w.y, this.rotation));
      ed.viewport.style.cursor = this.hover ? (e.alt ? 'not-allowed' : 'move') : 'crosshair';
      ed.requestRender();
    },
    down(e) {
      const hit = blockAt(this.blocks(), e.w.x, e.w.y);
      if (hit && e.alt) { this.remove(hit); return; }
      if (hit) {
        hit.solid = false; // the game draws a moving block with the loose texture
        this.drag = { block: hit, dx: e.w.x - hit.x, dy: e.w.y - hit.y, start: { x: hit.x, y: hit.y } };
        return;
      }
      const at = e.ctrl ? { x: e.w.x, y: e.w.y, rotation: this.rotation } : snapBlock(this.blocks(), e.w.x, e.w.y, this.rotation);
      const b = { ...at, solid: true };
      ed.meta.setBlocks([...this.blocks(), b]);
      this.hover = b; this.ghost = null;
    },
    up() {
      if (!this.drag) return;
      this.drag.block.solid = true;
      this.drag = null;
      ed.meta.setBlocks(this.blocks());
    },
    cancel() {
      if (!this.drag) return;
      Object.assign(this.drag.block, this.drag.start, { solid: true });
      this.drag = null;
      ed.meta.setBlocks(this.blocks(), true);
    },
    remove(b) {
      ed.meta.setBlocks(this.blocks().filter(x => x !== b));
      if (this.hover === b) this.hover = null;
    },
    key(e) {
      // AltGr arrives as Ctrl+Alt on Windows (brackets on a Turkish keyboard), so only plain Ctrl is a shortcut
      if ((e.ctrlKey && !e.altKey) || e.metaKey) return false;
      const ROT = { ',': -15, '.': 15, ';': -1, ':': 1, '[': -15, ']': 15, '{': -1, '}': 1 };
      if (ROT[e.key]) {
        const step = Math.sign(ROT[e.key]) * (e.shiftKey || Math.abs(ROT[e.key]) === 1 ? 1 : 15);
        if (this.hover) {
          this.hover.rotation = ((this.hover.rotation || 0) + step + 360) % 360;
          this.rotation = this.hover.rotation;
          ed.meta.setBlocks(this.blocks());
        } else {
          this.rotation = (this.rotation + step + 360) % 360;
          if (this.ghost) this.ghost.rotation = this.rotation;
          ed.requestRender();
        }
        return true;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.hover) { this.remove(this.hover); return true; }
      return false;
    },
    overlay(ctx, r) {
      const z = r.view.zoom;
      r.worldTransform();
      if (this.hover) drawBlocks(ctx, [this.hover], { alpha: 0, outline: { color: '#ffd24a', width: 1.5 / z } });
      if (this.ghost && !this.drag) {
        drawBlocks(ctx, [{ ...this.ghost, solid: true }], { alpha: 0.5, outline: { color: 'rgba(255,255,255,0.8)', width: 1 / z } });
      }
      r.screenTransform();
      const at = this.drag?.block || this.hover || this.ghost;
      if (!at) return;
      const s = r.toScreen(at.x, at.y);
      const n = this.blocks().length;
      const sz = (BLOCK_SIZE / 10).toFixed(2);
      const text = `Napoleon block ${sz} x ${sz} u (78 game units)  ${Math.round(at.rotation || 0)} deg   ${n} placed`;
      label(ctx, text, s.x + BLOCK_SIZE * z / 2 + 10, s.y - BLOCK_SIZE * z / 2 - 6);
    },
    deactivate() { this.hover = this.ghost = null; if (this.drag) this.cancel(); ed.requestRender(); }
  };

  // ---------- reference image placement ----------
  tools.reference = {
    cursor: 'move',
    drag: null,
    corners(r) {
      const ref = ed.meta.reference;
      const pts = [
        [ref.x, ref.y], [ref.x + ref.width, ref.y],
        [ref.x + ref.width, ref.y + ref.height], [ref.x, ref.y + ref.height]
      ];
      return pts.map(([x, y], i) => ({ i, x, y, s: r.toScreen(x, y) }));
    },
    down(e) {
      const ref = ed.meta.reference;
      if (!ref || ref.locked) return;
      const hit = this.corners(R()).find(c => Math.abs(c.s.x - e.sx) <= 7 && Math.abs(c.s.y - e.sy) <= 7);
      const start = { ...ref };
      if (hit) {
        const opp = this.corners(R())[(hit.i + 2) % 4];
        this.drag = { kind: 'scale', start, anchor: { x: opp.x, y: opp.y }, corner: hit.i };
      } else if (e.w.x >= ref.x && e.w.x <= ref.x + ref.width && e.w.y >= ref.y && e.w.y <= ref.y + ref.height) {
        this.drag = { kind: 'move', start, from: e.w };
      }
    },
    move(e) {
      const ref = ed.meta.reference;
      if (!ref) return;
      if (!this.drag) {
        const hit = this.corners(R()).find(c => Math.abs(c.s.x - e.sx) <= 7 && Math.abs(c.s.y - e.sy) <= 7);
        ed.viewport.style.cursor = hit ? (hit.i % 2 ? 'nesw-resize' : 'nwse-resize') : 'move';
        return;
      }
      const d = this.drag;
      if (d.kind === 'move') {
        ed.meta.updateReference({ x: d.start.x + e.w.x - d.from.x, y: d.start.y + e.w.y - d.from.y }, true);
      } else {
        let w = Math.max(1, Math.abs(e.w.x - d.anchor.x)), hh = Math.max(1, Math.abs(e.w.y - d.anchor.y));
        if (ref.keepAspect !== false && !e.shift) {
          const k = Math.max(w / d.start.width, hh / d.start.height);
          w = d.start.width * k; hh = d.start.height * k;
        }
        const x = e.w.x < d.anchor.x ? d.anchor.x - w : d.anchor.x;
        const y = e.w.y < d.anchor.y ? d.anchor.y - hh : d.anchor.y;
        ed.meta.updateReference({ x, y, width: w, height: hh }, true);
      }
    },
    up() {
      if (this.drag) { this.drag = null; ed.meta.updateReference({}); ed.state.dirty = true; ed.emit('file'); }
    },
    cancel() {
      if (this.drag) { ed.meta.updateReference(this.drag.start); this.drag = null; }
    },
    key(e) { if (e.key === 'Escape' && !this.drag) { ed.setTool('select'); return true; } return false; },
    overlay(ctx, r) {
      const ref = ed.meta.reference;
      if (!ref) return;
      const cs = this.corners(r);
      ctx.save();
      ctx.strokeStyle = '#ff4fd8'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
      ctx.beginPath(); cs.forEach((c, i) => i ? ctx.lineTo(c.s.x, c.s.y) : ctx.moveTo(c.s.x, c.s.y)); ctx.closePath(); ctx.stroke();
      ctx.setLineDash([]);
      for (const c of cs) { ctx.fillStyle = '#fff'; ctx.fillRect(c.s.x - 4, c.s.y - 4, 8, 8); ctx.strokeRect(c.s.x - 4, c.s.y - 4, 8, 8); }
      ctx.restore();
      label(ctx, `${(ref.width / 10).toFixed(2)} x ${(ref.height / 10).toFixed(2)} u`, cs[2].s.x + 10, cs[2].s.y + 18);
    },
    deactivate() { this.drag = null; ed.emit('meta'); }
  };

  tools.pan = {
    cursor: 'grab',
    drag: null,
    down(e) { this.drag = { sx: e.sx, sy: e.sy, cx: R().view.cx, cy: R().view.cy }; ed.viewport.style.cursor = 'grabbing'; },
    move(e) {
      if (!this.drag) return;
      const v = R().view;
      v.cx = this.drag.cx - (e.sx - this.drag.sx) / v.zoom;
      v.cy = this.drag.cy - (e.sy - this.drag.sy) / v.zoom;
      ed.requestRender(); ed.emit('view');
    },
    up() { this.drag = null; ed.viewport.style.cursor = this.cursor; },
    cancel() { this.drag = null; }
  };

  tools.eyedropper = {
    cursor: 'crosshair',
    hover: null,
    down(e) {
      const obj = ed.hitTest(e.w);
      if (!obj) return;
      const res = sampleObjectToBrush(ed, obj);
      ed.toast(res.sampled ? 'Sampled ' + res.summary : res.summary, res.sampled ? 'ok' : '');
    },
    move(e) {
      const hov = ed.hitTest(e.w);
      if (hov !== this.hover || hov) { this.hover = hov; ed.requestRender(); }
    },
    overlay(ctx, r) {
      if (!this.hover || !ed.state.cursor) return;
      const o = this.hover;
      const s = r.toScreen(ed.state.cursor.x, ed.state.cursor.y);
      let text = LAYER_BY_ID[o.layerId]?.title || o.type;
      if (o.type === 'Ter' || o.type === 'C') text += `: ${ed.catalog.textureById.get(o.texture)?.name || '#' + o.texture}`;
      else if (o.type === 'Bg') text += `: ${ed.catalog.textureById.get(o.texture)?.name || '#' + o.texture} (${Number(o.opacity ?? 1).toFixed(2)})`;
      else if (o.type === 'Air') text += `: ${ed.catalog.textureById.get(o.texture)?.name || '#' + o.texture} ${intToHex(o.borderColor ?? 0)}`;
      else if (o.type === 'Sky' || o.type === 'Wat') text += `: ${(o.colors || []).slice(0, 2).map(intToHex).join(' -> ')}`;
      else if (o.type === 'H') text += `: ${ed.catalog.hideSpaceById.get(o.hSType)?.name || '#' + o.hSType}`;
      else if (o.type === 'A') text += `: ${ed.catalog.animalByLevel.get(o.fLevel)?.name || 'level ' + o.fLevel}`;
      else if (o.type === 'P') text += `: ${ed.catalog.propById.get(o.pType)?.name || '#' + o.pType}`;
      label(ctx, text, s.x + 14, s.y - 14);
    },
    deactivate() { this.hover = null; }
  };

  tools.zoom = {
    cursor: 'zoom-in',
    marquee: null,
    down(e) { this.marquee = { x0: e.sx, y0: e.sy, x1: e.sx, y1: e.sy, alt: e.alt }; },
    move(e) {
      ed.viewport.style.cursor = e.alt ? 'zoom-out' : 'zoom-in';
      if (this.marquee) { this.marquee.x1 = e.sx; this.marquee.y1 = e.sy; ed.requestRender(); }
    },
    up(e) {
      const m = this.marquee; this.marquee = null;
      if (!m) return;
      if (Math.abs(m.x1 - m.x0) > 6 && Math.abs(m.y1 - m.y0) > 6) {
        const r = marqueeRect(m);
        R().fitBounds(r, 10);
        ed.requestRender(); ed.emit('view');
      } else ed.zoomBy(m.alt || e.alt ? 0.5 : 2, { x: e.sx, y: e.sy });
    },
    cancel() { this.marquee = null; },
    overlay(ctx) { drawMarquee(ctx, this.marquee); }
  };

  tools.sculpt = createSculptTool(ed);
  tools.knife = createKnifeTool(ed);
  tools.scatter = createScatterTool(ed);
  return tools;
}
