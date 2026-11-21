// Surface Foliage / Hide Space Scatter Brush tool (`F`) + Re-seat command (`obj.reseatHideSpaces`).
// Keep free of ui/tools.js and ui/commands.js imports to avoid load-time TDZ cycles.

import { TOOL } from '../engine/layers.js';
import { clamp } from '../engine/geometry.js';
import { spriteCorners, spriteSize } from '../engine/document.js';
import { createObject } from '../engine/dpm.js';
import {
  PX_PER_UNIT,
  MIN_BRUSH_RADIUS,
  MAX_BRUSH_RADIUS,
  DEFAULT_BRUSH_RADIUS,
  MIN_SPACING,
  MAX_SPACING,
  DEFAULT_SPACING,
  DEFAULT_ROTATION_JITTER,
  DEFAULT_SPACING_JITTER,
  DEFAULT_EMBED,
  DEFAULT_RESEAT_MAX_DIST,
  SURFACE_FILTERS,
  ALIGN_MODES,
  createSurfaceCache,
  nearestSurfacePoint,
  computePlacement,
  createScatterStrokeState,
  planScatterStep,
  findHideSpacesInRadius,
  reseatHideSpaces,
  hideSpaceOpacityWarns
} from '../engine/scatter.js';
import { h, clear, numberField, select, toggle } from './dom.js';
import { mirrorPoint } from '../engine/sculpt.js';
import { getMonoFont } from './canvas-font.js';

export const SCATTER_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 13.5c3.5-2.2 8.5-2.2 12 0"/><path d="M4.5 11.4L3.2 7.2M4.5 11.4L6.2 8.2"/><path d="M8 10.6V4.5M8 7.5c0-1.8 1.3-3 3-3 0 1.8-1.2 3-3 3z"/><path d="M11.6 11.4l1.2-3.8M11.6 11.4l-1.5-2.6"/></svg>';

const WARN_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2l6.3 11.2H1.7z"/><path d="M8 6.5v3M8 11.3v.2"/></svg>';
const PLUS_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

export const SCATTER_TOOL_DEF = {
  title: 'Scatter',
  key: 'F',
  icon: 'scatter',
  native: TOOL.HideSpace,
  layer: 'hide-spaces',
  help: 'Drag along rock to place hide spaces. Alt+drag: erase. , / . or Ctrl+wheel: brush size.'
};

const syncedEditors = new WeakSet();

// Keep single-item mixes synced with ed.state.brush.hSType (Assets / Eyedropper).
export function ensureScatterState(ed) {
  if (!ed.state) ed.state = {};
  if (!ed.state.scatter) {
    const fallbackId = ed.state.brush?.hSType ?? ed.catalog?.hideSpaces?.[0]?.id ?? 1;
    ed.state.scatter = {
      radius: DEFAULT_BRUSH_RADIUS,
      spacing: DEFAULT_SPACING,
      rotationJitter: DEFAULT_ROTATION_JITTER,
      spacingJitter: DEFAULT_SPACING_JITTER,
      embed: DEFAULT_EMBED,
      opacity: 1,
      surfaceFilter: 'all',
      align: 'normal',
      flip180: false,
      assets: [fallbackId],
      customMix: false
    };
  }
  if (!syncedEditors.has(ed) && typeof ed.on === 'function') {
    syncedEditors.add(ed);
    ed.on('brush', () => {
      const s = ed.state.scatter;
      const nextId = ed.state.brush?.hSType;
      if (!s || s.customMix || nextId == null) return;
      if (s.assets.length === 1 && s.assets[0] === nextId) return;
      s.assets = [nextId];
      ed.emit?.('scatter');
      ed.requestRender?.();
    });
  }
  return ed.state.scatter;
}

export function setScatterRadius(ed, radiusPx) {
  const s = ensureScatterState(ed);
  const clamped = clamp(Number(radiusPx) || DEFAULT_BRUSH_RADIUS, MIN_BRUSH_RADIUS, MAX_BRUSH_RADIUS);
  const next = Math.round(clamped * 100) / 100;
  if (next === s.radius) return s.radius;
  s.radius = next;
  ed.emit?.('scatter');
  ed.requestRender?.();
  return s.radius;
}

export function setScatterSpacing(ed, spacingPx) {
  const s = ensureScatterState(ed);
  const clamped = clamp(Number(spacingPx) || DEFAULT_SPACING, MIN_SPACING, MAX_SPACING);
  const next = Math.round(clamped * 100) / 100;
  if (next === s.spacing) return s.spacing;
  s.spacing = next;
  ed.emit?.('scatter');
  ed.requestRender?.();
  return s.spacing;
}

export function setScatterRotationJitter(ed, deg) {
  const s = ensureScatterState(ed);
  const raw = Number(deg);
  const next = Math.round(clamp(Number.isFinite(raw) ? raw : DEFAULT_ROTATION_JITTER, 0, 90) * 10) / 10;
  if (next === s.rotationJitter) return s.rotationJitter;
  s.rotationJitter = next;
  ed.emit?.('scatter');
  return s.rotationJitter;
}

export function setScatterOpacity(ed, opacity) {
  const s = ensureScatterState(ed);
  const raw = Number(opacity);
  const next = Math.round(clamp(Number.isFinite(raw) ? raw : 1, 0.05, 1) * 100) / 100;
  if (next === s.opacity) return s.opacity;
  s.opacity = next;
  ed.emit?.('scatter');
  ed.requestRender?.();
  return s.opacity;
}

export function setScatterSurfaceFilter(ed, filter) {
  const s = ensureScatterState(ed);
  const next = SURFACE_FILTERS.includes(filter) ? filter : 'all';
  if (next === s.surfaceFilter) return s.surfaceFilter;
  s.surfaceFilter = next;
  ed.emit?.('scatter');
  ed.requestRender?.();
  return s.surfaceFilter;
}

export function setScatterAlign(ed, align) {
  const s = ensureScatterState(ed);
  const next = ALIGN_MODES.includes(align) ? align : 'normal';
  if (next === s.align) return s.align;
  s.align = next;
  ed.emit?.('scatter');
  ed.requestRender?.();
  return s.align;
}

export function setScatterEmbed(ed, embedPx) {
  const s = ensureScatterState(ed);
  const raw = Number(embedPx);
  const next = Math.round(clamp(Number.isFinite(raw) ? raw : 0, -20, 50) * 100) / 100;
  if (next === s.embed) return s.embed;
  s.embed = next;
  ed.emit?.('scatter');
  ed.requestRender?.();
  return s.embed;
}

export function toggleScatterAsset(ed, hSType) {
  const s = ensureScatterState(ed);
  const id = Number(hSType);
  if (!Number.isFinite(id)) return s.assets;
  const idx = s.assets.indexOf(id);
  if (idx >= 0) {
    if (s.assets.length <= 1) return s.assets;
    s.assets = s.assets.filter(x => x !== id);
  } else {
    s.assets = [...s.assets, id];
  }
  s.customMix = s.assets.length > 1;
  if (s.assets.length === 1 && ed.state.brush) {
    ed.state.brush.hSType = s.assets[0];
  }
  ed.emit?.('scatter');
  ed.requestRender?.();
  return s.assets;
}

function mirrorSpritePreview(o, mode, pixelWidth, pixelHeight) {
  const fx = mode === 'h' || mode === 'p';
  const fy = mode === 'v' || mode === 'p';
  const r = o.rotation || 0;
  let rot = mode === 'h' ? -r : mode === 'v' ? 180 - r : r + 180;
  rot = ((rot + 540) % 360) - 180;
  return {
    ...o,
    x: fx ? pixelWidth - o.x : o.x,
    y: fy ? pixelHeight - o.y : o.y,
    rotation: rot
  };
}

function activeMixIds(ed) {
  const s = ensureScatterState(ed);
  const byId = ed.catalog?.hideSpaceById;
  const valid = (s.assets || []).filter(id => !byId || byId.has(id));
  if (valid.length) return valid;
  const fallback = ed.state.brush?.hSType ?? ed.catalog?.hideSpaces?.[0]?.id ?? 1;
  s.assets = [fallback];
  return s.assets;
}

function opacityWarningBadge() {
  return h('span', {
    class: 'badge warn',
    style: { gap: '4px', height: '22px', padding: '0 7px', borderRadius: '4px', fontSize: '10.5px', flex: 'none' },
    title: 'Hide spaces with opacity below 1 do not spawn food in-game.'
  }, h('span', { html: WARN_ICON }), 'No food (opacity < 1)');
}

function openMixPopover(ed, anchorEl, onClose = null) {
  const s = ensureScatterState(ed);
  let query = '';
  let pop = null;

  const close = () => {
    if (!pop) return;
    window.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('keydown', onKey, true);
    ed.listeners?.get('scatter')?.delete(sync);
    ed.listeners?.get('tool')?.delete(close);
    pop.remove();
    pop = null;
    onClose?.();
  };

  const onOutside = e => {
    if (!pop) return;
    if (pop.contains(e.target) || anchorEl.contains(e.target)) return;
    close();
  };

  const onKey = e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const search = h('input', { placeholder: 'Search hide spaces (name, pack, id)...' });
  search.addEventListener('keydown', e => {
    if (e.key === 'Escape') { close(); e.stopPropagation(); return; }
    e.stopPropagation();
  });

  const closeBtn = h('button', { type: 'button', class: 'btn icon flat small', html: CLOSE_ICON, title: 'Close' });
  closeBtn.addEventListener('click', close);

  const countBadge = h('span', { class: 'badge' }, String(activeMixIds(ed).length));
  const grid = h('div', { class: 'mmp-scatter-pop-grid' });

  const renderGrid = () => {
    clear(grid);
    const chosen = new Set(activeMixIds(ed));
    countBadge.textContent = String(chosen.size);
    const list = ed.catalog?.hideSpaces || [];
    for (const hs of list) {
      if (query && !hs.name.toLowerCase().includes(query) && !String(hs.id).includes(query) && !(hs.packName || '').toLowerCase().includes(query)) {
        continue;
      }
      const on = chosen.has(hs.id);
      const item = h('button', {
        type: 'button',
        class: 'mmp-scatter-item' + (on ? ' on' : ''),
        title: `${hs.name} (${hs.packName}, id ${hs.id})${hs.canHide ? ' - Can hide' : ''}`
      },
        hs.canHide ? h('span', { class: 'mmp-scatter-tag' }, 'HIDE') : null,
        h('img', { src: ed.assets?.thumbnail('H', hs.id, 48) || '' }),
        h('span', { class: 'name' }, hs.name));
      item.addEventListener('click', () => {
        toggleScatterAsset(ed, hs.id);
        renderGrid();
      });
      grid.append(item);
    }
  };

  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    renderGrid();
  });

  const alignSeg = h('div', { class: 'seg' });
  const btnNormal = h('button', { type: 'button', class: s.align === 'normal' ? 'on' : '' }, 'Normal');
  const btnUpright = h('button', { type: 'button', class: s.align === 'upright' ? 'on' : '' }, 'Upright');
  btnNormal.addEventListener('click', () => setScatterAlign(ed, 'normal'));
  btnUpright.addEventListener('click', () => setScatterAlign(ed, 'upright'));
  alignSeg.append(btnNormal, btnUpright);

  const flipToggle = toggle({
    checked: !!s.flip180,
    label: 'Flip 180',
    title: 'Invert orientation relative to surface normal',
    onChange: v => {
      s.flip180 = !!v;
      ed.emit?.('scatter');
      ed.requestRender?.();
    }
  });
  const flipInput = flipToggle.querySelector('input');

  const embedField = numberField({
    label: 'Embed',
    value: s.embed / PX_PER_UNIT,
    step: 0.05,
    min: -2,
    max: 5,
    digits: 2,
    suffix: 'u',
    title: 'Sink sprite anchor into surface (negative lifts outward)',
    onCommit: v => setScatterEmbed(ed, v * PX_PER_UNIT)
  });

  const spaceJitterField = numberField({
    label: 'Gap +/-',
    value: Math.round((s.spacingJitter ?? DEFAULT_SPACING_JITTER) * 100),
    step: 5,
    min: 0,
    max: 50,
    digits: 0,
    suffix: '%',
    title: 'Random spacing variation percentage',
    onCommit: v => {
      s.spacingJitter = clamp(v / 100, 0, 0.5);
      ed.emit?.('scatter');
    }
  });

  const soloBtn = h('button', { type: 'button', class: 'btn small' }, 'Use active asset');
  soloBtn.addEventListener('click', () => {
    const id = ed.state.brush?.hSType ?? ed.catalog?.hideSpaces?.[0]?.id ?? 1;
    s.assets = [id];
    s.customMix = false;
    ed.emit?.('scatter');
    ed.requestRender?.();
  });

  const sync = () => {
    if (!pop || !pop.isConnected) return;
    const cur = ensureScatterState(ed);
    btnNormal.classList.toggle('on', cur.align === 'normal');
    btnUpright.classList.toggle('on', cur.align === 'upright');
    flipInput.checked = !!cur.flip180;
    renderGrid();
  };

  renderGrid();
  pop = h('div', { class: 'mmp-scatter-pop' },
    h('div', { class: 'mmp-scatter-pop-head' },
      h('span', { style: { fontWeight: '600', fontSize: '11.5px' } }, 'Hide Space Mix'),
      countBadge,
      h('span', { style: { flex: '1' } }),
      soloBtn,
      closeBtn),
    h('div', { style: { padding: '6px 8px 0' } },
      h('div', { class: 'search' }, search)),
    grid,
    h('div', { class: 'mmp-scatter-pop-foot' },
      h('div', { class: 'row' }, h('span', { class: 'k', style: { width: '54px' } }, 'Align'), alignSeg, h('span', { style: { flex: '1' } }), flipToggle),
      h('div', { class: 'grid2', style: { marginBottom: '0' } }, embedField, spaceJitterField)));

  pop.addEventListener('pointerdown', e => e.stopPropagation());
  document.body.append(pop);

  const ar = anchorEl.getBoundingClientRect();
  const pw = pop.offsetWidth || 348;
  const ph = pop.offsetHeight || 340;
  const left = clamp(ar.left, 8, Math.max(8, window.innerWidth - pw - 8));
  const top = clamp(ar.bottom + 4, 8, Math.max(8, window.innerHeight - ph - 8));
  pop.style.left = Math.round(left) + 'px';
  pop.style.top = Math.round(top) + 'px';

  ed.on?.('scatter', sync);
  ed.on?.('tool', close);
  window.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('keydown', onKey, true);
  search.focus();
  return close;
}

export function buildScatterControls(ed) {
  const s = ensureScatterState(ed);
  let closePop = null;

  const mixThumbs = h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '2px' } });
  const mixLabel = h('span', {});
  const mixBtn = h('button', {
    type: 'button',
    class: 'chip',
    style: { cursor: 'pointer' },
    title: 'Choose one or more hide spaces and alignment options'
  }, mixThumbs, mixLabel, h('span', { html: PLUS_ICON, style: { opacity: '0.75' } }));

  mixBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (closePop) { closePop(); closePop = null; return; }
    closePop = openMixPopover(ed, mixBtn, () => { closePop = null; });
  });

  const radiusField = numberField({
    label: 'R',
    value: s.radius / PX_PER_UNIT,
    step: 0.5,
    min: MIN_BRUSH_RADIUS / PX_PER_UNIT,
    max: MAX_BRUSH_RADIUS / PX_PER_UNIT,
    digits: 2,
    suffix: 'u',
    title: 'Brush radius (, / . or Ctrl+wheel)',
    onCommit: v => setScatterRadius(ed, v * PX_PER_UNIT)
  });
  radiusField.style.flex = '0 0 88px';

  const spacingField = numberField({
    label: 'Space',
    value: s.spacing / PX_PER_UNIT,
    step: 0.2,
    min: MIN_SPACING / PX_PER_UNIT,
    max: MAX_SPACING / PX_PER_UNIT,
    digits: 2,
    suffix: 'u',
    title: 'Spacing between placed items along the surface',
    onCommit: v => setScatterSpacing(ed, v * PX_PER_UNIT)
  });
  spacingField.style.flex = '0 0 106px';

  const jitterField = numberField({
    label: 'Rot',
    value: s.rotationJitter,
    step: 2,
    min: 0,
    max: 90,
    digits: 0,
    suffix: 'deg',
    title: 'Random rotation jitter (+/- degrees)',
    onCommit: v => setScatterRotationJitter(ed, v)
  });
  jitterField.style.flex = '0 0 92px';

  const surfaceSel = select({
    value: s.surfaceFilter,
    title: 'Filter placements by surface normal angle',
    options: [
      { value: 'all', label: 'All surfaces' },
      { value: 'floor', label: 'Floor' },
      { value: 'wall', label: 'Wall' },
      { value: 'ceiling', label: 'Ceiling' }
    ],
    onChange: v => setScatterSurfaceFilter(ed, v)
  });
  surfaceSel.style.width = '102px';
  surfaceSel.style.flex = 'none';

  const opacityField = numberField({
    label: 'Op',
    value: s.opacity,
    step: 0.05,
    min: 0.05,
    max: 1,
    digits: 2,
    title: 'Hide space opacity (below 1 spawns no food)',
    onCommit: v => setScatterOpacity(ed, v)
  });
  opacityField.style.flex = '0 0 78px';

  const warnBadge = opacityWarningBadge();

  const renderMixChip = cur => {
    clear(mixThumbs);
    const ids = activeMixIds(ed);
    for (const id of ids.slice(0, 3)) {
      mixThumbs.append(h('img', { src: ed.assets?.thumbnail('H', id, 28) || '' }));
    }
    if (ids.length === 1) {
      mixLabel.textContent = ed.catalog?.hideSpaceById?.get(ids[0])?.name || `#${ids[0]}`;
    } else {
      mixLabel.textContent = `Mix (${ids.length})`;
    }
    warnBadge.style.display = hideSpaceOpacityWarns(cur.opacity) ? 'inline-flex' : 'none';
  };

  const sync = () => {
    if (!mixBtn.isConnected) {
      ed.listeners?.get('scatter')?.delete(sync);
      closePop?.();
      return;
    }
    const cur = ensureScatterState(ed);
    renderMixChip(cur);
    radiusField.setValue(cur.radius / PX_PER_UNIT);
    spacingField.setValue(cur.spacing / PX_PER_UNIT);
    jitterField.setValue(cur.rotationJitter);
    opacityField.setValue(cur.opacity);
    surfaceSel.value = cur.surfaceFilter;
  };

  renderMixChip(s);
  ed.on?.('scatter', sync);

  return [
    h('span', { class: 'cb-sep' }),
    mixBtn,
    h('span', { class: 'cb-sep' }),
    radiusField,
    spacingField,
    jitterField,
    surfaceSel,
    opacityField,
    warnBadge
  ];
}

function strokeQueryOptions(ed, s, surfaceCache) {
  return {
    radius: s.radius,
    spacing: s.spacing,
    spacingJitter: s.spacingJitter,
    rotationJitter: s.rotationJitter,
    embed: s.embed,
    opacity: s.opacity,
    assets: activeMixIds(ed),
    surfaceFilter: s.surfaceFilter,
    align: s.align,
    flip180: s.flip180,
    visible: ed.state.visible,
    surfaceCache,
    catalog: ed.catalog
  };
}

function hoverSignature(ed, cursor, altDown) {
  const s = ensureScatterState(ed);
  return [
    ed.doc.revision,
    [...ed.state.visible].join(','),
    s.radius,
    s.surfaceFilter,
    s.align,
    s.flip180 ? 1 : 0,
    s.embed,
    s.opacity,
    activeMixIds(ed).join(','),
    altDown ? 1 : 0,
    cursor ? `${cursor.x.toFixed(2)},${cursor.y.toFixed(2)}` : ''
  ].join('|');
}

function eraseTargetsAlong(doc, fromW, toW, radius, catalog) {
  const out = [];
  const seen = new Set();
  const p0 = fromW || toW;
  const dx = toW.x - p0.x;
  const dy = toW.y - p0.y;
  const dist = Math.hypot(dx, dy);
  const stepLen = Math.max(4, radius * 0.5);
  const steps = fromW && dist > 0 ? Math.max(1, Math.ceil(dist / stepLen)) : 1;
  for (let i = 1; i <= steps; i++) {
    const t = fromW ? i / steps : 1;
    const pt = { x: p0.x + dx * t, y: p0.y + dy * t };
    const hits = findHideSpacesInRadius(doc, pt, radius, catalog);
    for (let k = 0; k < hits.length; k++) {
      if (!seen.has(hits[k].uid)) {
        seen.add(hits[k].uid);
        out.push(hits[k]);
      }
    }
  }
  return out;
}

export function createScatterTool(ed) {
  const surfaceCache = createSurfaceCache(ed.doc);

  const tool = {
    cursor: 'crosshair',
    drag: null,
    cursorW: null,
    altDown: false,
    hoverHit: null,
    hoverErase: [],
    _hoverSig: '',
    _hudUntil: 0,
    _hudTimer: 0,
    _onKeyMod: null,

    showHudBriefly() {
      this._hudUntil = Date.now() + 1100;
      clearTimeout(this._hudTimer);
      this._hudTimer = setTimeout(() => {
        if (ed.state.tool === 'scatter') ed.requestRender?.();
      }, 1150);
    },

    hiddenUids() {
      const d = this.drag;
      if (!d || d.mode !== 'erase' || !d.erasedUids.size) return null;
      const symMode = ed.meta?.symmetry;
      const twins = ed.meta?.twins;
      if (!symMode || symMode === 'off' || !twins || !twins.size) return d.erasedUids;
      const hidden = new Set(d.erasedUids);
      for (const uid of d.erasedUids) {
        const twinUid = twins.get(uid);
        if (twinUid != null) hidden.add(twinUid);
      }
      return hidden;
    },

    refreshHover(force = false) {
      if (this.drag || !this.cursorW) {
        if (!this.cursorW) { this.hoverHit = null; this.hoverErase = []; }
        return;
      }
      const sig = hoverSignature(ed, this.cursorW, this.altDown);
      if (!force && sig === this._hoverSig) return;
      this._hoverSig = sig;
      const s = ensureScatterState(ed);
      if (this.altDown) {
        this.hoverHit = null;
        this.hoverErase = ed.state.visible.has('hide-spaces')
          ? findHideSpacesInRadius(ed.doc, this.cursorW, s.radius, ed.catalog)
          : [];
      } else {
        this.hoverErase = [];
        this.hoverHit = nearestSurfacePoint(ed.doc, this.cursorW, s.radius, {
          surfaceFilter: s.surfaceFilter,
          visible: ed.state.visible,
          surfaceCache
        });
      }
    },

    activate() {
      ensureScatterState(ed);
      surfaceCache.clear();
      this._hoverSig = '';
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        this._onKeyMod = e => {
          if (e.key !== 'Alt') return;
          if (e.altKey === this.altDown) return;
          this.altDown = e.altKey;
          this.refreshHover(true);
          ed.requestRender?.();
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
      this.hoverHit = null;
      this.hoverErase = [];
      this._hoverSig = '';
      this.altDown = false;
      ed.state.cursorInfo = null;
      if (this._onKeyMod && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('keydown', this._onKeyMod);
        window.removeEventListener('keyup', this._onKeyMod);
        this._onKeyMod = null;
      }
    },

    down(e) {
      const s = ensureScatterState(ed);
      this.cursorW = { x: e.w.x, y: e.w.y };
      this.altDown = !!e.alt;

      if (!ed.state.visible.has('hide-spaces') || ed.state.locked.has('hide-spaces')) {
        ed.toast?.('Hide Spaces layer is hidden or locked');
        return;
      }

      if (e.alt) {
        const erasedUids = new Set();
        for (const o of findHideSpacesInRadius(ed.doc, e.w, s.radius, ed.catalog)) {
          erasedUids.add(o.uid);
        }
        this.drag = { mode: 'erase', lastW: { x: e.w.x, y: e.w.y }, erasedUids };
        ed.state.cursorInfo = `Erase ${erasedUids.size}`;
        this.hoverErase = [];
        return;
      }

      const planState = createScatterStrokeState();
      const opts = strokeQueryOptions(ed, s, surfaceCache);
      const placed = planScatterStep(ed.doc, planState, null, e.w, opts);
      this.drag = {
        mode: 'paint',
        lastW: { x: e.w.x, y: e.w.y },
        planState,
        placed,
        opts
      };
      this.hoverHit = null;
      ed.state.cursorInfo = `Placed ${placed.length}`;
    },

    move(e) {
      this.cursorW = { x: e.w.x, y: e.w.y };
      this.altDown = !!e.alt;
      const d = this.drag;
      if (!d) {
        this.refreshHover();
        ed.requestRender?.();
        return;
      }
      const s = ensureScatterState(ed);
      if (d.mode === 'erase') {
        const hits = eraseTargetsAlong(ed.doc, d.lastW, e.w, s.radius, ed.catalog);
        for (const o of hits) d.erasedUids.add(o.uid);
        d.lastW = { x: e.w.x, y: e.w.y };
        ed.state.cursorInfo = `Erase ${d.erasedUids.size}`;
      } else {
        const added = planScatterStep(ed.doc, d.planState, d.lastW, e.w, d.opts);
        if (added.length) d.placed.push(...added);
        d.lastW = { x: e.w.x, y: e.w.y };
        ed.state.cursorInfo = `Placed ${d.placed.length}`;
      }
      ed.requestRender?.();
    },

    up(e) {
      const d = this.drag;
      if (!d) return;
      if (e?.w) this.move(e);
      this.drag = null;
      ed.state.cursorInfo = null;

      if (d.mode === 'erase') {
        if (d.erasedUids.size > 0) {
          ed.edit('Erase hide spaces', () => {
            for (const uid of d.erasedUids) {
              const obj = ed.doc.get(uid);
              if (obj) ed.doc.remove(obj);
            }
          });
        }
      } else if (d.placed.length > 0) {
        ed.edit('Scatter hide spaces', () => {
          for (let i = 0; i < d.placed.length; i++) {
            const p = d.placed[i];
            ed.doc.add(createObject('H', 'hide-spaces', {
              hSType: p.hSType,
              x: p.x,
              y: p.y,
              rotation: p.rotation,
              opacity: p.opacity
            }));
          }
        });
      }

      this._hoverSig = '';
      this.refreshHover(true);
      ed.requestRender?.();
    },

    cancel() {
      if (!this.drag) return;
      this.drag = null;
      ed.state.cursorInfo = null;
      this._hoverSig = '';
      this.refreshHover(true);
      ed.requestRender?.();
    },

    key(e) {
      if ((e.ctrlKey && !e.altKey) || e.metaKey) return false;
      const s = ensureScatterState(ed);
      if (e.key === ',' || e.key === '<' || (e.shiftKey && e.key === ';')) {
        const factor = e.shiftKey ? 0.94 : 0.85;
        setScatterRadius(ed, s.radius * factor);
        this.showHudBriefly();
        this.refreshHover(true);
        return true;
      }
      if (e.key === '.' || e.key === '>' || (e.shiftKey && e.key === ':')) {
        const factor = e.shiftKey ? 1 / 0.94 : 1 / 0.85;
        setScatterRadius(ed, s.radius * factor);
        this.showHudBriefly();
        this.refreshHover(true);
        return true;
      }
      return false;
    },

    wheel(x, rawEvent) {
      if (!x.ctrl || x.alt) return false;
      const s = ensureScatterState(ed);
      const scale = Math.exp(-rawEvent.deltaY * (rawEvent.deltaMode ? 0.05 : 0.0018));
      setScatterRadius(ed, s.radius * scale);
      this.showHudBriefly();
      this.refreshHover(true);
      return true;
    },

    overlay(ctx, r) {
      if (!this.drag) this.refreshHover();
      drawScatterBrushOverlay(ctx, ed, r, this);
    }
  };

  return tool;
}

function drawSpriteOutline(ctx, r, obj, catalog, color, lineWidth = 1.5) {
  const corners = spriteCorners(obj, spriteSize(obj, catalog));
  if (!corners.length) return;
  ctx.beginPath();
  for (let i = 0; i < corners.length; i++) {
    const sp = r.toScreen(corners[i].x, corners[i].y);
    if (i === 0) ctx.moveTo(sp.x, sp.y);
    else ctx.lineTo(sp.x, sp.y);
  }
  ctx.closePath();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

function drawScatterBrushOverlay(ctx, ed, r, state) {
  if (!r) return;
  const s = ensureScatterState(ed);
  const d = state.drag;
  const cursorW = state.cursorW || ed.state.cursor;
  const symMode = ed.meta?.symmetry;
  const hasSym = symMode && symMode !== 'off';
  const W = ed.doc.pixelWidth;
  const H = ed.doc.pixelHeight;

  ctx.save();

  if (d && d.mode === 'paint' && d.placed.length) {
    r.worldTransform();
    for (let i = 0; i < d.placed.length; i++) {
      const o = d.placed[i];
      r.drawSpriteObject(o, false);
      if (hasSym) r.drawSpriteObject(mirrorSpritePreview(o, symMode, W, H), false);
    }
    r.screenTransform();
  }

  if (!d && !state.altDown && state.hoverHit) {
    const hit = state.hoverHit;
    const ids = activeMixIds(ed);
    const previewId = ids[0];
    const entry = ed.catalog?.hideSpaceById?.get(previewId) || null;
    const pos = computePlacement(hit, entry, {
      align: s.align,
      flip180: s.flip180,
      rotationJitter: 0,
      embed: s.embed
    });
    const ghost = {
      type: 'H',
      hSType: previewId,
      x: pos.x,
      y: pos.y,
      rotation: pos.rotation,
      opacity: s.opacity * 0.55
    };
    r.worldTransform();
    r.drawSpriteObject(ghost, false);
    if (hasSym) r.drawSpriteObject(mirrorSpritePreview(ghost, symMode, W, H), false);
    r.screenTransform();

    const sp = r.toScreen(hit.x, hit.y);
    const np = r.toScreen(hit.x + hit.nx * 14 / (r.view.zoom || 1), hit.y + hit.ny * 14 / (r.view.zoom || 1));
    ctx.beginPath();
    ctx.moveTo(sp.x, sp.y);
    ctx.lineTo(np.x, np.y);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#5b9bff';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#5b9bff';
    ctx.fill();
  }

  if (!d && state.altDown && state.hoverErase.length) {
    for (let i = 0; i < state.hoverErase.length; i++) {
      drawSpriteOutline(ctx, r, state.hoverErase[i], ed.catalog, 'rgba(229, 83, 75, 0.92)', 1.5);
    }
  }

  if (!cursorW) { ctx.restore(); return; }

  const eraseMode = d ? d.mode === 'erase' : state.altDown;
  const sc = r.toScreen(cursorW.x, cursorW.y);
  const outerR = s.radius * r.view.zoom;
  const ringColor = eraseMode ? 'rgba(229, 83, 75, 0.92)' : 'rgba(91, 155, 255, 0.92)';
  const fillTint = eraseMode ? 'rgba(229, 83, 75, 0.06)' : 'rgba(59, 130, 246, 0.04)';

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

  ctx.beginPath();
  ctx.moveTo(sc.x - 4, sc.y);
  ctx.lineTo(sc.x + 4, sc.y);
  ctx.moveTo(sc.x, sc.y - 4);
  ctx.lineTo(sc.x, sc.y + 4);
  ctx.lineWidth = 1;
  ctx.strokeStyle = ringColor;
  ctx.stroke();

  if (hasSym) {
    const mir = mirrorPoint(cursorW, symMode, W, H);
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
    const parts = eraseMode
      ? [`Erase (${d ? d.erasedUids.size : state.hoverErase.length})`, `R ${(s.radius / PX_PER_UNIT).toFixed(2)} u`]
      : [
          `R ${(s.radius / PX_PER_UNIT).toFixed(2)} u`,
          `Space ${(s.spacing / PX_PER_UNIT).toFixed(2)} u`,
          s.surfaceFilter
        ];
    if (d && d.mode === 'paint') parts.push(`${d.placed.length} placed`);
    const text = parts.join('  ');
    ctx.font = '11px ' + getMonoFont();
    const tw = ctx.measureText(text).width;
    const boxW = tw + 10;
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
    ctx.fillStyle = eraseMode ? '#ff8f88' : '#d6dbe4';
    ctx.fillText(text, bx + 5, by + 13);
  }

  ctx.restore();
}

export function drawScatterOverlay(ctx, ed) {
  if (ed?.state?.tool !== 'scatter') return;
  ed.tools?.scatter?.overlay?.(ctx, ed.renderer);
}

export function runReseatHideSpaces(ed) {
  if (!ed?.doc) return { moved: 0, alreadySeated: 0, outOfRange: 0, updated: [] };
  if (ed.state?.locked?.has('hide-spaces')) {
    ed.toast?.('Hide Spaces layer is locked', 'err');
    return { moved: 0, alreadySeated: 0, outOfRange: 0, updated: [] };
  }
  const hObjs = (ed.selected?.() || []).filter(o => o && o.type === 'H');
  if (!hObjs.length) {
    ed.toast?.('Select one or more hide spaces to re-seat');
    return { moved: 0, alreadySeated: 0, outOfRange: 0, updated: [] };
  }
  const res = ed.edit('Re-seat hide spaces', () => reseatHideSpaces(ed.doc, hObjs, ed.catalog, {
    maxDist: DEFAULT_RESEAT_MAX_DIST,
    visible: ed.state?.visible || null
  }));
  if (!res) return { moved: 0, alreadySeated: 0, outOfRange: 0, updated: [] };

  if (res.moved > 0) {
    const extra = res.outOfRange > 0 ? ` (${res.outOfRange} beyond 2 u)` : '';
    ed.toast?.(`Re-seated ${res.moved} hide space${res.moved === 1 ? '' : 's'}${extra}`, 'ok');
  } else if (res.alreadySeated > 0) {
    const extra = res.outOfRange > 0 ? ` (${res.outOfRange} beyond 2 u)` : '';
    ed.toast?.(`Selected hide spaces are already seated${extra}`);
  } else {
    ed.toast?.('No selected hide spaces within 2 u of a terrain surface');
  }
  return res;
}

export function scatterCommands(ed) {
  return [
    {
      id: 'obj.reseatHideSpaces',
      label: 'Re-seat hide spaces',
      enabled: () => (ed.selected?.() || []).some(o => o.type === 'H'),
      run: () => runReseatHideSpaces(ed)
    }
  ];
}

export function buildScatterPropertiesSection(ed) {
  const sel = ed?.selected?.() || [];
  const hSel = sel.filter(o => o && o.type === 'H');

  if (hSel.length > 0) {
    const lowOpacity = hSel.some(o => hideSpaceOpacityWarns(o.opacity ?? 1));
    const btn = h('button', {
      type: 'button',
      class: 'btn small',
      title: 'Snap selected hide spaces within 2 units back onto the nearest terrain surface'
    }, 'Re-seat to surface (<= 2 u)');
    btn.addEventListener('click', () => runReseatHideSpaces(ed));

    return h('div', { class: 'section' },
      h('div', { class: 'section-title' },
        h('span', {}, 'Surface seating'),
        h('span', { class: 'aside' }, `${hSel.length} hide space${hSel.length === 1 ? '' : 's'}`)),
      h('div', { class: 'btn-row' }, btn),
      lowOpacity
        ? h('p', { class: 'muted', style: { margin: '6px 0 0', color: 'var(--warn)' } }, 'Opacity below 1: hide spaces spawn no food in-game.')
        : null);
  }

  if (sel.length === 0 && ed?.state?.tool === 'scatter') {
    const s = ensureScatterState(ed);
    const ids = activeMixIds(ed);
    const warnEl = h('p', {
      class: 'muted',
      style: { margin: '6px 0 0', color: 'var(--warn)', display: hideSpaceOpacityWarns(s.opacity) ? '' : 'none' }
    }, 'Opacity below 1: hide spaces spawn no food in-game.');
    return h('div', { class: 'section' },
      h('div', { class: 'section-title' },
        h('span', {}, 'Scatter brush'),
        h('span', { class: 'aside' }, `${ids.length} asset${ids.length === 1 ? '' : 's'}`)),
      h('div', { class: 'grid2' },
        numberField({
          label: 'Radius',
          value: s.radius / PX_PER_UNIT,
          step: 0.5,
          min: MIN_BRUSH_RADIUS / PX_PER_UNIT,
          max: MAX_BRUSH_RADIUS / PX_PER_UNIT,
          digits: 2,
          suffix: 'u',
          onCommit: v => setScatterRadius(ed, v * PX_PER_UNIT)
        }),
        numberField({
          label: 'Space',
          value: s.spacing / PX_PER_UNIT,
          step: 0.2,
          min: MIN_SPACING / PX_PER_UNIT,
          max: MAX_SPACING / PX_PER_UNIT,
          digits: 2,
          suffix: 'u',
          onCommit: v => setScatterSpacing(ed, v * PX_PER_UNIT)
        })),
      h('div', { class: 'grid2' },
        numberField({
          label: 'Jitter',
          value: s.rotationJitter,
          step: 2,
          min: 0,
          max: 90,
          digits: 0,
          suffix: 'deg',
          onCommit: v => setScatterRotationJitter(ed, v)
        }),
        numberField({
          label: 'Embed',
          value: s.embed / PX_PER_UNIT,
          step: 0.05,
          min: -2,
          max: 5,
          digits: 2,
          suffix: 'u',
          onCommit: v => setScatterEmbed(ed, v * PX_PER_UNIT)
        })),
      h('div', { class: 'row' },
        h('span', { class: 'k' }, 'Surface'),
        select({
          value: s.surfaceFilter,
          options: [
            { value: 'all', label: 'All surfaces' },
            { value: 'floor', label: 'Floor' },
            { value: 'wall', label: 'Wall' },
            { value: 'ceiling', label: 'Ceiling' }
          ],
          onChange: v => setScatterSurfaceFilter(ed, v)
        })),
      h('div', { class: 'row' },
        h('span', { class: 'k' }, 'Align'),
        select({
          value: s.align,
          options: [
            { value: 'normal', label: 'Surface normal' },
            { value: 'upright', label: 'Upright' }
          ],
          onChange: v => setScatterAlign(ed, v)
        })),
      h('div', { class: 'row' },
        numberField({
          label: 'Opacity',
          value: s.opacity,
          step: 0.05,
          min: 0.05,
          max: 1,
          digits: 2,
          onCommit: v => {
            setScatterOpacity(ed, v);
            warnEl.style.display = hideSpaceOpacityWarns(s.opacity) ? '' : 'none';
          }
        }),
        toggle({
          checked: !!s.flip180,
          label: 'Flip 180',
          onChange: v => { s.flip180 = !!v; ed.emit?.('scatter'); ed.requestRender?.(); }
        })),
      warnEl);
  }

  return null;
}
