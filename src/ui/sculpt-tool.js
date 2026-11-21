// Soft-falloff sculpt brush tool: pointer/key/wheel handling, control bar and overlay.

import { LAYER_BY_ID, KIND_BY_TYPE, TOOL } from '../engine/layers.js';
import { clamp } from '../engine/geometry.js';
import {
  PX_PER_UNIT,
  DEFAULT_SEAM_TOLERANCE,
  MIN_BRUSH_RADIUS,
  MAX_BRUSH_RADIUS,
  DEFAULT_BRUSH_RADIUS,
  DEFAULT_BRUSH_STRENGTH,
  createBoundsCache,
  prepareSculptStroke,
  applySculptStroke,
  mirrorPoint,
  mirrorPolygonPoints
} from '../engine/sculpt.js';
import { h, fmt, numberField, toggle } from './dom.js';

export const SCULPT_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2.5" stroke-dasharray="1.8 1.6"/><path d="M2.2 12.2c2.2-1.8 3.6-2.4 5.8-2.4s3.6.6 5.8 2.4"/><circle cx="8" cy="9.8" r="1" fill="currentColor"/></svg>';

export const SCULPT_TOOL_DEF = {
  title: 'Sculpt',
  key: 'S',
  icon: 'sculpt',
  native: TOOL.Creation,
  preferLayer: () => 'terrains',
  help: 'Drag to push/pull vertices with cosine falloff. Alt+drag: edge-slide. [ / ] or Ctrl+wheel: radius. L: Seam-Lock.'
};

export function ensureSculptState(ed) {
  if (!ed.state.sculpt) {
    ed.state.sculpt = {
      radius: DEFAULT_BRUSH_RADIUS,
      strength: DEFAULT_BRUSH_STRENGTH,
      seamLock: true
    };
  }
  return ed.state.sculpt;
}

export function setBrushRadius(ed, radiusPx) {
  const s = ensureSculptState(ed);
  const clamped = clamp(Number(radiusPx) || DEFAULT_BRUSH_RADIUS, MIN_BRUSH_RADIUS, MAX_BRUSH_RADIUS);
  const next = Math.round(clamped * 100) / 100;
  if (next === s.radius) return s.radius;
  s.radius = next;
  ed.emit?.('sculpt');
  ed.requestRender?.();
  return s.radius;
}

export function setBrushStrength(ed, strength) {
  const s = ensureSculptState(ed);
  const raw = Number(strength);
  const clamped = clamp(Number.isFinite(raw) ? raw : DEFAULT_BRUSH_STRENGTH, 0, 1);
  const next = Math.round(clamped * 100) / 100;
  if (next === s.strength) return s.strength;
  s.strength = next;
  ed.emit?.('sculpt');
  ed.requestRender?.();
  return s.strength;
}

export function toggleSeamLock(ed) {
  const s = ensureSculptState(ed);
  s.seamLock = !s.seamLock;
  ed.emit?.('sculpt');
  ed.toast?.(s.seamLock ? 'Seam-Lock on (0.05 u)' : 'Seam-Lock off');
  ed.requestRender?.();
  return s.seamLock;
}

export function buildSculptControls(ed) {
  const s = ensureSculptState(ed);
  const radiusField = numberField({
    label: 'Radius',
    value: s.radius / PX_PER_UNIT,
    step: 0.5,
    min: MIN_BRUSH_RADIUS / PX_PER_UNIT,
    max: MAX_BRUSH_RADIUS / PX_PER_UNIT,
    digits: 2,
    suffix: 'u',
    title: 'Brush radius ([ / ] or Ctrl+wheel)',
    onCommit: v => setBrushRadius(ed, v * PX_PER_UNIT)
  });
  radiusField.style.flex = '0 0 124px';

  const strengthField = numberField({
    label: 'Strength',
    value: s.strength,
    step: 0.05,
    min: 0,
    max: 1,
    digits: 2,
    title: 'Brush strength (0..1)',
    onCommit: v => setBrushStrength(ed, v)
  });
  strengthField.style.flex = '0 0 112px';

  const strengthSlider = h('input', {
    type: 'range',
    min: 0,
    max: 1,
    step: 0.05,
    value: s.strength,
    title: 'Brush strength (0..1)',
    style: { width: '68px', flex: 'none' }
  });
  strengthSlider.addEventListener('input', () => setBrushStrength(ed, Number(strengthSlider.value)));
  strengthSlider.addEventListener('keydown', e => e.stopPropagation());

  const seamToggle = toggle({
    checked: !!s.seamLock,
    label: 'Seam-Lock (L)',
    title: 'Move co-located vertices (<= 0.05 u) on other visible unlocked polygons identically',
    onChange: v => {
      s.seamLock = !!v;
      ed.emit?.('sculpt');
      ed.requestRender?.();
    }
  });

  const radiusInput = radiusField.querySelector('input');
  const strengthInput = strengthField.querySelector('input');
  const seamInput = seamToggle.querySelector('input');

  const sync = () => {
    if (!radiusField.isConnected) {
      ed.listeners?.get('sculpt')?.delete(sync);
      return;
    }
    const cur = ensureSculptState(ed);
    if (document.activeElement !== radiusInput) radiusInput.value = fmt(cur.radius / PX_PER_UNIT, 2);
    if (document.activeElement !== strengthInput) strengthInput.value = fmt(cur.strength, 2);
    strengthSlider.value = String(cur.strength);
    seamInput.checked = !!cur.seamLock;
  };
  ed.on('sculpt', sync);

  return [
    h('span', { class: 'cb-sep' }),
    radiusField,
    h('span', { class: 'cb-group' }, strengthField, strengthSlider),
    h('span', { class: 'cb-sep' }),
    seamToggle
  ];
}

function strokeQueryOptions(ed, center, boundsCache) {
  const s = ensureSculptState(ed);
  return {
    center,
    radius: s.radius,
    strength: s.strength,
    seamLock: s.seamLock,
    seamTolerance: DEFAULT_SEAM_TOLERANCE,
    selection: ed.selected(),
    activeLayer: ed.state.activeLayer,
    visible: ed.state.visible,
    locked: ed.state.locked,
    isolate: ed.state.isolate,
    boundsCache
  };
}

function hoverSignature(ed, cursor) {
  const s = ensureSculptState(ed);
  return [
    ed.doc.revision,
    ed.state.activeLayer,
    ed.state.isolate ? 1 : 0,
    ed.state.selection.size,
    [...ed.state.selection].join(','),
    [...ed.state.visible].join(','),
    [...ed.state.locked].join(','),
    s.radius,
    s.strength,
    s.seamLock ? 1 : 0,
    cursor ? cursor.x.toFixed(2) + ',' + cursor.y.toFixed(2) : ''
  ].join('|');
}

function explainEmptyTarget(ed) {
  const sel = ed.selected();
  if (sel.length > 0 && !sel.some(o => KIND_BY_TYPE[o.type] === 'poly')) {
    ed.toast?.('Select a polygon or deselect to sculpt on the active layer');
    return;
  }
  const layer = LAYER_BY_ID[ed.state.activeLayer];
  if (!layer || layer.kind !== 'poly') {
    ed.toast?.('Sculpt works on polygon layers (terrains, water, background, sky...)');
    return;
  }
  if (!ed.state.visible.has(layer.id) || ed.state.locked.has(layer.id)) {
    ed.toast?.(`${layer.title} layer is hidden or locked`);
  }
}

function collectTwinPairs(ed, affectedObjects) {
  const mode = ed.meta?.symmetry;
  const twinsMap = ed.meta?.twins;
  if (!mode || mode === 'off' || !twinsMap || !twinsMap.size) return { twinOriginals: new Map(), twinPairs: [] };

  const affectedSet = new Set(affectedObjects);
  const twinOriginals = new Map();
  const twinPairs = [];
  for (const src of affectedObjects) {
    const twinUid = twinsMap.get(src.uid);
    if (twinUid == null) continue;
    const twin = ed.doc.get(twinUid);
    if (!twin || affectedSet.has(twin) || KIND_BY_TYPE[twin.type] !== 'poly' || !Array.isArray(twin.points)) continue;
    if (!twinOriginals.has(twin)) {
      twinOriginals.set(twin, twin.points.map(p => ({ x: p.x, y: p.y })));
    }
    twinPairs.push({ src, twin });
  }
  return { twinOriginals, twinPairs };
}

function applyTwinPreview(ed, twinPairs) {
  if (!twinPairs?.length) return;
  const mode = ed.meta?.symmetry;
  if (!mode || mode === 'off') return;
  const W = ed.doc.pixelWidth, H = ed.doc.pixelHeight;
  for (const { src, twin } of twinPairs) {
    const mirrored = mirrorPolygonPoints(src.points, mode, W, H);
    if (twin.points.length === mirrored.length) {
      for (let i = 0; i < mirrored.length; i++) {
        twin.points[i].x = mirrored[i].x;
        twin.points[i].y = mirrored[i].y;
      }
    } else {
      twin.points = mirrored;
    }
  }
}

function restoreTwins(twinOriginals) {
  if (!twinOriginals?.size) return;
  for (const [twin, origPts] of twinOriginals) {
    if (twin.points.length === origPts.length) {
      for (let i = 0; i < origPts.length; i++) {
        twin.points[i].x = origPts[i].x;
        twin.points[i].y = origPts[i].y;
      }
    } else {
      twin.points = origPts.map(p => ({ x: p.x, y: p.y }));
    }
  }
}

function strokeChangedOriginals(stroke) {
  for (const [obj, origPts] of stroke.originals) {
    const pts = obj.points;
    for (let i = 0; i < origPts.length; i++) {
      if (Math.abs(pts[i].x - origPts[i].x) > 1e-6 || Math.abs(pts[i].y - origPts[i].y) > 1e-6) {
        return true;
      }
    }
  }
  return false;
}

export function createSculptTool(ed) {
  const boundsCache = createBoundsCache(ed.doc);

  const tool = {
    cursor: 'crosshair',
    drag: null,
    cursorW: null,
    altDown: false,
    shiftDown: false,
    hoverStroke: null,
    _hoverSig: '',
    _hudUntil: 0,
    _hudTimer: 0,
    _onKeyMod: null,

    showHudBriefly() {
      this._hudUntil = Date.now() + 1100;
      clearTimeout(this._hudTimer);
      this._hudTimer = setTimeout(() => {
        if (ed.state.tool === 'sculpt') ed.requestRender?.();
      }, 1150);
    },

    refreshHover(force = false) {
      if (this.drag || !this.cursorW) {
        if (!this.cursorW) this.hoverStroke = null;
        return;
      }
      const sig = hoverSignature(ed, this.cursorW);
      if (!force && sig === this._hoverSig) return;
      this._hoverSig = sig;
      this.hoverStroke = prepareSculptStroke(ed.doc, strokeQueryOptions(ed, this.cursorW, boundsCache));
    },

    activate() {
      ensureSculptState(ed);
      boundsCache.clear();
      this._hoverSig = '';
      if (typeof window !== 'undefined') {
        this._onKeyMod = e => {
          if (e.key !== 'Alt' && e.key !== 'Shift') return;
          const nextAlt = e.altKey;
          const nextShift = e.shiftKey;
          if (nextAlt === this.altDown && nextShift === this.shiftDown) return;
          this.altDown = nextAlt;
          this.shiftDown = nextShift;
          if (this.drag && this.cursorW) {
            this.applyDragAt(this.cursorW, nextShift, nextAlt);
          }
          ed.requestRender();
        };
        window.addEventListener('keydown', this._onKeyMod);
        window.addEventListener('keyup', this._onKeyMod);
      }
    },

    deactivate() {
      if (this.drag) this.cancel();
      clearTimeout(this._hudTimer);
      this._hudTimer = 0;
      this._hudUntil = 0;
      this.cursorW = null;
      this.hoverStroke = null;
      this._hoverSig = '';
      this.altDown = false;
      this.shiftDown = false;
      ed.state.cursorInfo = null;
      if (this._onKeyMod && typeof window !== 'undefined') {
        window.removeEventListener('keydown', this._onKeyMod);
        window.removeEventListener('keyup', this._onKeyMod);
        this._onKeyMod = null;
      }
    },

    applyDragAt(w, shift, alt) {
      const d = this.drag;
      if (!d) return;
      let dx = w.x - d.start.x;
      let dy = w.y - d.start.y;
      if (shift) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      d.lastDelta = { x: dx, y: dy };
      d.edgeSlide = !!alt;
      applySculptStroke(d.stroke, d.lastDelta, { edgeSlide: d.edgeSlide });
      applyTwinPreview(ed, d.twinPairs);
      const modeTag = d.edgeSlide ? 'Slide  ' : '';
      ed.state.cursorInfo = `${modeTag}dx ${(dx / PX_PER_UNIT).toFixed(2)}  dy ${(dy / PX_PER_UNIT).toFixed(2)}  (${d.stroke.leaders.length} pts)`;
    },

    down(e) {
      ensureSculptState(ed);
      this.cursorW = { x: e.w.x, y: e.w.y };
      this.altDown = !!e.alt;
      this.shiftDown = !!e.shift;

      const stroke = prepareSculptStroke(ed.doc, strokeQueryOptions(ed, e.w, boundsCache));
      if (!stroke.leaders.length) {
        explainEmptyTarget(ed);
        this.hoverStroke = stroke;
        this._hoverSig = hoverSignature(ed, this.cursorW);
        return;
      }

      const { twinOriginals, twinPairs } = collectTwinPairs(ed, stroke.affectedObjects);
      this.hoverStroke = null;
      this.drag = {
        start: { x: e.w.x, y: e.w.y },
        lastDelta: { x: 0, y: 0 },
        edgeSlide: !!e.alt,
        stroke,
        twinOriginals,
        twinPairs
      };
      this.applyDragAt(e.w, e.shift, e.alt);
    },

    move(e) {
      this.cursorW = { x: e.w.x, y: e.w.y };
      this.altDown = !!e.alt;
      this.shiftDown = !!e.shift;
      if (this.drag) {
        this.applyDragAt(e.w, e.shift, e.alt);
      } else {
        this.refreshHover();
      }
      ed.requestRender();
    },

    up(e) {
      const d = this.drag;
      if (!d) return;

      if (e?.w) {
        this.cursorW = { x: e.w.x, y: e.w.y };
        this.altDown = !!e.alt;
        this.shiftDown = !!e.shift;
        this.applyDragAt(e.w, e.shift, e.alt);
      }

      this.drag = null;
      ed.state.cursorInfo = null;

      const moved = strokeChangedOriginals(d.stroke);
      // Restore exact pre-drag geometry before ed.edit so doc.touch captures the true
      // before-state and meta.beforeCommit mirrors into the same single undo step.
      applySculptStroke(d.stroke, { x: 0, y: 0 });
      restoreTwins(d.twinOriginals);

      if (moved) {
        const label = d.edgeSlide ? 'Sculpt edge-slide' : 'Sculpt';
        ed.edit(label, () => {
          for (const obj of d.stroke.affectedObjects) ed.doc.touch(obj);
          applySculptStroke(d.stroke, d.lastDelta, { edgeSlide: d.edgeSlide });
        });
      }

      this._hoverSig = '';
      this.refreshHover(true);
      ed.requestRender();
    },

    cancel() {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      ed.state.cursorInfo = null;
      applySculptStroke(d.stroke, { x: 0, y: 0 });
      restoreTwins(d.twinOriginals);
      this._hoverSig = '';
      this.refreshHover(true);
      ed.requestRender();
    },

    key(e) {
      // AltGr arrives as Ctrl+Alt on Windows (brackets on some layouts), so reject only plain Ctrl/Meta.
      if ((e.ctrlKey && !e.altKey) || e.metaKey) return false;
      const s = ensureSculptState(ed);

      if (e.key === '[' || e.key === '{' || e.code === 'BracketLeft') {
        const factor = e.shiftKey ? 0.94 : 0.85;
        setBrushRadius(ed, s.radius * factor);
        this.showHudBriefly();
        this.refreshHover(true);
        return true;
      }
      if (e.key === ']' || e.key === '}' || e.code === 'BracketRight') {
        const factor = e.shiftKey ? 1 / 0.94 : 1 / 0.85;
        setBrushRadius(ed, s.radius * factor);
        this.showHudBriefly();
        this.refreshHover(true);
        return true;
      }
      if ((e.key === 'l' || e.key === 'L' || e.code === 'KeyL') && !e.shiftKey && !e.altKey) {
        toggleSeamLock(ed);
        this.showHudBriefly();
        this.refreshHover(true);
        return true;
      }
      return false;
    },

    wheel(x, rawEvent) {
      if (!x.ctrl || x.alt) return false;
      const s = ensureSculptState(ed);
      const scale = Math.exp(-rawEvent.deltaY * (rawEvent.deltaMode ? 0.05 : 0.0018));
      setBrushRadius(ed, s.radius * scale);
      this.showHudBriefly();
      this.refreshHover(true);
      return true;
    },

    overlay(ctx, r) {
      if (!this.drag) this.refreshHover();
      drawBrushOverlay(ctx, ed, r, this);
    }
  };

  return tool;
}

function drawBrushOverlay(ctx, ed, r, state) {
  const s = ensureSculptState(ed);
  const d = state.drag;
  const cursorW = state.cursorW || ed.state.cursor;
  const ringCenter = d ? d.start : cursorW;
  if (!ringCenter) return;

  const edgeSlide = d ? d.edgeSlide : state.altDown;
  const stroke = d ? d.stroke : state.hoverStroke;

  ctx.save();

  if (stroke && stroke.leaders.length) {
    const rgb = edgeSlide ? '227, 163, 59' : '91, 155, 255';
    const invStrength = stroke.strength > 0 ? 1 / stroke.strength : 0;

    for (let i = 0; i < stroke.leaders.length; i++) {
      const leader = stroke.leaders[i];
      const p = leader.obj.points[leader.index];
      const sp = r.toScreen(p.x, p.y);
      const t = clamp(leader.weight * invStrength, 0, 1);

      if (edgeSlide && t > 0.12) {
        drawSlideTangents(ctx, r, leader, sp, t);
      }

      const rad = 2.4 + 2.0 * t;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, rad, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${rgb}, ${(0.4 + 0.6 * t).toFixed(3)})`;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(11, 14, 19, 0.9)';
      ctx.stroke();

      if (t >= 0.72) {
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 1.2, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
      }

      const followers = leader.followers;
      for (let j = 0; j < followers.length; j++) {
        const fp = followers[j].obj.points[followers[j].index];
        const sf = r.toScreen(fp.x, fp.y);
        const hs = 4.2;
        ctx.beginPath();
        ctx.moveTo(sf.x, sf.y - hs);
        ctx.lineTo(sf.x + hs, sf.y);
        ctx.lineTo(sf.x, sf.y + hs);
        ctx.lineTo(sf.x - hs, sf.y);
        ctx.closePath();
        ctx.fillStyle = 'rgba(63, 178, 127, 0.9)';
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(11, 14, 19, 0.9)';
        ctx.stroke();
      }
    }
  }

  const sc = r.toScreen(ringCenter.x, ringCenter.y);
  const outerR = s.radius * r.view.zoom;
  const innerR = outerR * 0.5;
  const ringColor = edgeSlide ? 'rgba(227, 163, 59, 0.92)' : 'rgba(91, 155, 255, 0.92)';
  const innerColor = edgeSlide ? 'rgba(227, 163, 59, 0.58)' : 'rgba(91, 155, 255, 0.58)';
  const fillTint = edgeSlide ? 'rgba(227, 163, 59, 0.04)' : 'rgba(59, 130, 246, 0.04)';

  ctx.beginPath();
  ctx.arc(sc.x, sc.y, outerR, 0, Math.PI * 2);
  ctx.fillStyle = fillTint;
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = 'rgba(11, 14, 19, 0.55)';
  ctx.stroke();
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = ringColor;
  ctx.stroke();

  if (innerR >= 3) {
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(sc.x, sc.y, innerR, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(11, 14, 19, 0.45)';
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = innerColor;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.beginPath();
  ctx.moveTo(sc.x - 4, sc.y);
  ctx.lineTo(sc.x + 4, sc.y);
  ctx.moveTo(sc.x, sc.y - 4);
  ctx.lineTo(sc.x, sc.y + 4);
  ctx.lineWidth = 1;
  ctx.strokeStyle = ringColor;
  ctx.stroke();

  if (d && cursorW) {
    const curS = r.toScreen(cursorW.x, cursorW.y);
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(sc.x, sc.y);
    ctx.lineTo(curS.x, curS.y);
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = ringColor;
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(curS.x, curS.y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(11, 14, 19, 0.9)';
    ctx.stroke();
  }

  const symMode = ed.meta?.symmetry;
  if (symMode && symMode !== 'off') {
    const mir = mirrorPoint(ringCenter, symMode, ed.doc.pixelWidth, ed.doc.pixelHeight);
    const sm = r.toScreen(mir.x, mir.y);
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.arc(sm.x, sm.y, outerR, 0, Math.PI * 2);
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = 'rgba(255, 79, 216, 0.58)';
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (d || Date.now() < state._hudUntil) {
    const parts = [
      `R ${(s.radius / PX_PER_UNIT).toFixed(2)} u`,
      `${Math.round(s.strength * 100)}%`
    ];
    if (s.seamLock) parts.push('Seam-Lock');
    if (edgeSlide) parts.push('Slide');
    const text = parts.join('  ');
    const mono = typeof document !== 'undefined'
      ? getComputedStyle(document.body).getPropertyValue('--mono') || 'monospace'
      : 'monospace';
    ctx.font = '11px ' + mono;
    const tw = ctx.measureText(text).width;
    const padX = 10;
    const boxW = tw + padX;
    const boxH = 18;
    const rawX = sc.x + Math.min(outerR * 0.72 + 8, 90);
    const rawY = sc.y + Math.min(outerR * 0.72 + 8, 90);
    const bx = clamp(rawX, 6, Math.max(6, r.width - boxW - 6));
    const by = clamp(rawY, 6, Math.max(6, r.height - boxH - 6));

    ctx.fillStyle = 'rgba(17, 20, 26, 0.92)';
    ctx.fillRect(bx, by, boxW, boxH);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#323a4a';
    ctx.strokeRect(bx + 0.5, by + 0.5, boxW, boxH);
    ctx.fillStyle = edgeSlide ? '#f0bf6c' : '#d6dbe4';
    ctx.fillText(text, bx + 5, by + 13);
  }

  ctx.restore();
}

function drawSlideTangents(ctx, r, leader, sp, t) {
  const pts = leader.obj.points;
  const n = pts.length;
  const prev = pts[(leader.index - 1 + n) % n];
  const next = pts[(leader.index + 1) % n];
  ctx.beginPath();
  for (const nb of [prev, next]) {
    const sn = r.toScreen(nb.x, nb.y);
    const dx = sn.x - sp.x, dy = sn.y - sp.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) continue;
    const tick = Math.min(10, len * 0.45);
    ctx.moveTo(sp.x, sp.y);
    ctx.lineTo(sp.x + (dx / len) * tick, sp.y + (dy / len) * tick);
  }
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = `rgba(227, 163, 59, ${(0.35 + 0.5 * t).toFixed(3)})`;
  ctx.stroke();
}

export function drawSculptOverlay(ctx, ed) {
  if (ed?.state?.tool !== 'sculpt') return;
  const tool = ed.tools?.sculpt;
  if (tool?.overlay) {
    tool.overlay(ctx, ed.renderer);
  }
}
