// Pixel Stack inspector and Layer Stack scrubber (view-only state).

import { LAYERS, LAYER_BY_ID, KIND_BY_TYPE, Z_ORDER, TEXTURED_TYPES } from '../engine/layers.js';
import { pointInPolygon, distanceToSegment, intToHex } from '../engine/geometry.js';
import { spriteSize, spriteCorners } from '../engine/document.js';
import { habitatColor, habitatLabel } from '../engine/render.js';
import { h, fmt } from './dom.js';
import { icon } from './icons.js';
import { copyStyle, extractStyle, canCopyStyle } from './commands.js';

const SINGULAR = {
  habitats: 'Habitat', triggers: 'Trigger', 'npc-spawns': 'NPC spawn', 'food-spawns': 'Food spawn', currents: 'Current',
  ceilings: 'Ceiling', terrains: 'Terrain', islands: 'Island', animals: 'Preview animal', props: 'Prop', platforms: 'Platform',
  'hide-spaces': 'Hide space', 'air-pockets': 'Air pocket', 'background-terrains': 'Background', water: 'Water', sky: 'Sky'
};

const LAYER_SWATCH = {
  habitats: '#3a7bd5', triggers: '#e0b53a', 'npc-spawns': '#e05a4f', 'food-spawns': '#45c27a', currents: '#59b8ff',
  ceilings: '#8c7a62', terrains: '#7a6248', islands: '#9b8a6a', animals: '#c17bd6', props: '#d6a26b', platforms: '#a58d6b',
  'hide-spaces': '#5fa86a', 'air-pockets': '#9fb3c8', 'background-terrains': '#4b4f5c', water: '#1f5f8f', sky: '#8cc4ef'
};

const HELPER_SWATCH = {
  Cu: '#50b4ff',
  Food: '#46d278',
  NPC: '#f05a50',
  Tr: '#fac83c'
};

// Back-to-front draw order matching engine/render.js (lowest Z_ORDER draws first).
export const DRAW_LAYERS = LAYERS.slice().sort((a, b) => Z_ORDER[a.id] - Z_ORDER[b.id]);

const editorStates = new WeakMap();

function getEditorState(ed) {
  let st = editorStates.get(ed);
  if (!st) {
    st = {
      card: null,
      cleanupCard: null,
      world: null,
      hoveredUid: null,
      peelCount: LAYERS.length,
      baselineVisible: null,
      preSoloVisible: null,
      onScrubberSync: null
    };
    editorStates.set(ed, st);
  }
  return st;
}

// Uses Alt+Shift+Click because Alt+Click is taken by duplicate-drag and centre-scale.
export function isInspectClick(e) {
  return Boolean(e && e.alt && e.shift && !e.ctrl);
}

export function objectOpacity(obj) {
  if (!obj) return 1;
  if (obj.type === 'Bg' || obj.type === 'H') {
    const v = Number(obj.opacity);
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
  }
  return 1;
}

function objectDrawZ(obj) {
  if (obj.type === 'Bg') return obj.opacity ?? 0;
  if (obj.type === 'H') return obj.opacity ?? 1;
  return 0;
}

function hitTestFallback(obj, world, catalog, tol = 0) {
  const kind = KIND_BY_TYPE[obj.type];
  if (kind === 'sprite') {
    if (!catalog) return false;
    return pointInPolygon(world.x, world.y, spriteCorners(obj, spriteSize(obj, catalog)));
  }
  const pts = obj.points;
  if (!pts || pts.length < 3) return false;
  if (pointInPolygon(world.x, world.y, pts)) return true;
  if (tol >= 0) {
    for (let i = 0; i < pts.length; i++) {
      if (distanceToSegment(world, pts[i], pts[(i + 1) % pts.length]).distance <= tol) return true;
    }
  }
  return false;
}

// Ordered back-to-front to match Renderer.renderScene().
export function collectPixelStack(ed, world, options = {}) {
  const doc = options.doc || ed?.doc;
  const catalog = options.catalog || ed?.catalog;
  if (!doc || !world) return [];
  const visible = options.includeHidden ? null : (options.visible || ed?.state?.visible || null);
  const tol = options.tol ?? 0;
  const hitFn = typeof ed?.hits === 'function'
    ? (o => ed.hits(o, world, tol))
    : (o => hitTestFallback(o, world, catalog, tol));

  const stack = [];
  for (const layer of DRAW_LAYERS) {
    if (visible && !visible.has(layer.id)) continue;
    const list = doc.layers?.[layer.id];
    if (!list?.length) continue;
    const hitsInLayer = [];
    for (let i = 0; i < list.length; i++) {
      const obj = list[i];
      if (hitFn(obj)) hitsInLayer.push({ obj, index: i });
    }
    if (!hitsInLayer.length) continue;
    if (layer.id === 'background-terrains' || layer.id === 'hide-spaces') {
      hitsInLayer.sort((a, b) => (objectDrawZ(a.obj) - objectDrawZ(b.obj)) || (a.index - b.index));
    }
    for (const { obj, index } of hitsInLayer) {
      const op = objectOpacity(obj);
      stack.push({
        obj,
        layer,
        layerId: layer.id,
        index,
        drawIndex: stack.length,
        type: obj.type,
        name: ed?.meta?.name?.(obj) || `${SINGULAR[layer.id] || obj.type} ${index + 1}`,
        opacity: op,
        opacityPct: Math.round(op * 100)
      });
    }
  }
  return stack;
}

// Keeps the current selection intact when copying from an unselected stack row.
export function copyObjectStyle(ed, obj) {
  if (!ed || !obj || !canCopyStyle([obj])) {
    ed?.toast?.(`Style copy is unavailable for ${LAYER_BY_ID[obj?.layerId]?.title || obj?.type || 'object'}`);
    return null;
  }
  const sel = ed.selected?.() || [];
  if (sel.length === 1 && sel[0].uid === obj.uid) {
    return copyStyle(ed);
  }
  const style = extractStyle(obj);
  ed.styleClipboard = style;
  ed.toast?.(`Copied style (${LAYER_BY_ID[obj.layerId]?.title || obj.type})`);
  return style;
}

export function toggleSoloLayer(ed, layerId) {
  if (!ed?.state?.visible || !LAYER_BY_ID[layerId]) return false;
  const st = getEditorState(ed);
  const vis = ed.state.visible;
  const alreadySolo = vis.size === 1 && vis.has(layerId);

  if (alreadySolo) {
    const restore = st.preSoloVisible && st.preSoloVisible.size
      ? new Set(st.preSoloVisible)
      : new Set(LAYERS.map(l => l.id));
    st.preSoloVisible = null;
    ed.state.visible = restore;
  } else {
    st.preSoloVisible = new Set(st.baselineVisible || vis);
    ed.state.visible = new Set([layerId]);
  }

  st.peelCount = LAYERS.length;
  st.baselineVisible = null;
  st.onScrubberSync?.();

  if (ed.state.selection?.size) {
    for (const uid of [...ed.state.selection]) {
      const o = ed.doc?.get?.(uid);
      if (o && !ed.state.visible.has(o.layerId)) ed.state.selection.delete(uid);
    }
  }
  ed.emit?.('layer');
  ed.emit?.('selection');
  ed.emit?.('view-options');
  ed.requestRender?.();
  return !alreadySolo;
}

// Hides the top (layers.length - count) layers while keeping already-hidden layers off.
export function computePeelVisibility(baselineVisible, count, layers = LAYERS) {
  const total = layers.length;
  const clamped = Math.max(0, Math.min(total, Math.round(Number(count) || 0)));
  const start = total - clamped;
  const next = new Set();
  for (let i = start; i < total; i++) {
    const id = layers[i].id;
    if (!baselineVisible || baselineVisible.has(id)) next.add(id);
  }
  return next;
}

export function setLayerPeelCount(ed, count) {
  if (!ed?.state?.visible) return LAYERS.length;
  const st = getEditorState(ed);
  const total = LAYERS.length;
  const nextCount = Math.max(0, Math.min(total, Math.round(Number(count) || 0)));
  if (nextCount === st.peelCount && !(nextCount < total && !st.baselineVisible)) {
    st.onScrubberSync?.();
    return nextCount;
  }
  if (nextCount < total && !st.baselineVisible) {
    st.baselineVisible = new Set(ed.state.visible);
  }
  const base = st.baselineVisible || ed.state.visible;
  ed.state.visible = computePeelVisibility(base, nextCount, LAYERS);
  st.peelCount = nextCount;
  if (nextCount === total) st.baselineVisible = null;
  st.preSoloVisible = null;
  st.onScrubberSync?.();
  if (ed.state.selection?.size) {
    let selChanged = false;
    for (const uid of [...ed.state.selection]) {
      const o = ed.doc?.get?.(uid);
      if (o && !ed.state.visible.has(o.layerId)) { ed.state.selection.delete(uid); selChanged = true; }
    }
    if (selChanged) ed.emit?.('selection');
  }
  ed.emit?.('layer');
  ed.emit?.('view-options');
  ed.requestRender?.();
  return nextCount;
}

export function resetLayerScrubber(ed) {
  return setLayerPeelCount(ed, LAYERS.length);
}

export function syncLayerVisibility(ed, layerId, soloed = false) {
  const st = editorStates.get(ed);
  if (!st) return;
  if (soloed) {
    st.peelCount = LAYERS.length;
    st.baselineVisible = null;
    st.preSoloVisible = null;
    st.onScrubberSync?.();
    return;
  }
  st.preSoloVisible = null;
  if (st.baselineVisible && layerId) {
    if (ed?.state?.visible?.has(layerId)) st.baselineVisible.add(layerId);
    else st.baselineVisible.delete(layerId);
  }
}

function buildThumbnail(ed, obj) {
  const box = h('div', { class: 'mmp-stack-thumb' });
  const assets = ed.assets;

  if (TEXTURED_TYPES.has(obj.type)) {
    const url = assets?.thumbnail?.('T', obj.texture, 24);
    if (url) {
      box.append(h('img', {
        src: url,
        style: {
          imageRendering: 'pixelated',
          opacity: obj.type === 'Bg' ? String(Math.max(0.6, objectOpacity(obj))) : '1'
        }
      }));
    } else {
      box.style.background = '#7a6a55';
    }
    if (obj.type === 'Air') box.style.borderColor = intToHex(obj.borderColor ?? 0);
    return box;
  }

  if (obj.type === 'Sky' || obj.type === 'Wat') {
    const cols = (obj.colors?.length ? obj.colors : [0x888888]).map(intToHex);
    const stops = cols.length === 1 ? [cols[0], cols[0]] : cols;
    box.style.background = `linear-gradient(to bottom, ${stops.join(', ')})`;
    return box;
  }

  if (obj.type === 'H' || obj.type === 'A' || obj.type === 'P') {
    const id = obj.type === 'H' ? obj.hSType : obj.type === 'A' ? obj.fLevel : obj.pType;
    const url = assets?.thumbnail?.(obj.type, id, 24);
    if (url) {
      box.append(h('img', { src: url, style: { objectFit: 'contain', opacity: obj.type === 'H' ? String(Math.max(0.6, objectOpacity(obj))) : '1' } }));
    } else {
      box.style.background = LAYER_SWATCH[obj.layerId] || '#5c6476';
    }
    return box;
  }

  if (obj.type === 'Hab') {
    box.style.background = intToHex(habitatColor(obj.settings?.area | 0));
    return box;
  }

  box.style.background = HELPER_SWATCH[obj.type] || LAYER_SWATCH[obj.layerId] || '#5c6476';
  return box;
}

function describeObject(ed, entry) {
  const { obj, layer } = entry;
  const cat = ed.catalog;
  const locked = ed.state?.locked?.has(layer.id) ? ' (locked)' : '';
  if (TEXTURED_TYPES.has(obj.type)) {
    const tex = cat?.textureById?.get(obj.texture)?.name || `#${obj.texture}`;
    const extra = obj.type === 'Air' ? ` / ${intToHex(obj.borderColor ?? 0)}` : '';
    return `${layer.title} / ${tex}${extra}${locked}`;
  }
  if (obj.type === 'Sky' || obj.type === 'Wat') {
    const cols = (obj.colors || []).map(intToHex);
    const span = cols.length > 2 ? `${cols[0]} -> ${cols[1]} (+${cols.length - 2})` : cols.join(' -> ');
    return `${layer.title}${span ? ' / ' + span : ''}${locked}`;
  }
  if (obj.type === 'H') return `${layer.title} / ${cat?.hideSpaceById?.get(obj.hSType)?.name || '#' + obj.hSType}${locked}`;
  if (obj.type === 'A') return `${layer.title} / ${cat?.animalByLevel?.get(obj.fLevel)?.name || 'lv ' + obj.fLevel}${locked}`;
  if (obj.type === 'P') return `${layer.title} / ${cat?.propById?.get(obj.pType)?.name || '#' + obj.pType}${locked}`;
  if (obj.type === 'Hab') return `${layer.title} / ${habitatLabel(obj.settings?.area | 0) || 'none'}${locked}`;
  if (obj.type === 'Cu') return `${layer.title} / ${obj.settings?.angle ?? 0} deg, str ${obj.settings?.strength ?? 0}${locked}`;
  if (obj.type === 'Food') return `${layer.title} / x${obj.settings?.count ?? 0}${locked}`;
  if (obj.type === 'NPC') return `${layer.title} / x${obj.settings?.animalCount ?? 0}${locked}`;
  if (obj.type === 'Tr') return `${layer.title} / ${(obj.triggers || []).length} trigger(s)${locked}`;
  return `${layer.title}${locked}`;
}

export function closePixelStack(ed) {
  const st = editorStates.get(ed);
  if (!st) return;
  if (st.cleanupCard) {
    const fn = st.cleanupCard;
    st.cleanupCard = null;
    fn();
  }
  if (st.card) {
    st.card.remove();
    st.card = null;
  }
  st.world = null;
  st.hoveredUid = null;
  ed?.requestRender?.();
}

export function openPixelStack(ed, e) {
  if (!ed || !e?.w || typeof document === 'undefined') return null;
  closePixelStack(ed);

  const st = getEditorState(ed);
  const world = { x: e.w.x, y: e.w.y };
  const stack = collectPixelStack(ed, world);
  st.world = world;
  st.hoveredUid = null;

  const closeBtn = h('button', {
    type: 'button',
    class: 'btn icon flat small',
    html: icon('close'),
    title: 'Close (Esc)',
    style: { width: '20px', height: '20px' }
  });
  closeBtn.addEventListener('click', () => closePixelStack(ed));

  const head = h('div', { class: 'mmp-stack-head' },
    h('span', { class: 'mmp-stack-title' }, 'Pixel Stack'),
    h('span', { class: 'mmp-stack-coord' }, `${fmt(world.x / 10, 2)}, ${fmt(world.y / 10, 2)} u`),
    h('span', { class: 'badge' }, String(stack.length)),
    h('span', { class: 'mmp-stack-order' }, 'back -> front'),
    closeBtn
  );

  const rowRecords = [];
  const listEl = h('div', { class: 'mmp-stack-list' });
  listEl.addEventListener('mouseleave', () => {
    if (st.hoveredUid != null) {
      st.hoveredUid = null;
      ed.requestRender?.();
    }
  });

  if (!stack.length) {
    listEl.append(h('div', { class: 'mmp-stack-empty' }, 'No visible objects contain this point.'));
  } else {
    for (const entry of stack) {
      const { obj, layerId } = entry;
      const canCopy = canCopyStyle([obj]);
      const selBtn = h('button', {
        type: 'button',
        class: 'btn small' + (ed.state.selection.has(obj.uid) ? ' on' : ''),
        title: 'Select object'
      }, 'Select');
      const soloBtn = h('button', {
        type: 'button',
        class: 'btn small' + (ed.state.visible.size === 1 && ed.state.visible.has(layerId) ? ' on' : ''),
        title: 'Solo layer (click again to restore)'
      }, 'Solo');
      const copyBtn = h('button', {
        type: 'button',
        class: 'btn small',
        disabled: !canCopy,
        title: canCopy ? 'Copy style (Ctrl+Alt+C)' : 'Style copy unavailable for this type'
      }, 'Copy style');

      const rowEl = h('div', { class: 'mmp-stack-row' + (ed.state.selection.has(obj.uid) ? ' sel' : '') },
        h('span', { class: 'mmp-stack-dot', style: { background: LAYER_SWATCH[layerId] || '#5c6476' }, title: entry.layer.title }),
        buildThumbnail(ed, obj),
        h('div', { class: 'mmp-stack-info' },
          h('div', { class: 'mmp-stack-top' },
            h('span', { class: 'mmp-stack-name', title: entry.name }, entry.name),
            h('span', { class: 'mmp-stack-type' }, entry.type)
          ),
          h('div', { class: 'mmp-stack-sub', title: describeObject(ed, entry) }, describeObject(ed, entry))
        ),
        h('span', { class: 'mmp-stack-op', title: 'Object opacity' }, `${entry.opacityPct}%`),
        h('div', { class: 'mmp-stack-acts' }, selBtn, soloBtn, copyBtn)
      );

      rowEl.addEventListener('mouseenter', () => {
        if (st.hoveredUid !== obj.uid) {
          st.hoveredUid = obj.uid;
          ed.requestRender?.();
        }
      });

      selBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        const live = ed.doc?.get?.(obj.uid);
        if (!live) { closePixelStack(ed); return; }
        ed.select([live]);
        if (entry.layer.helper) ed.setActiveLayer(layerId);
        syncRowStates();
      });

      soloBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        toggleSoloLayer(ed, layerId);
        syncRowStates();
      });

      copyBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        const live = ed.doc?.get?.(obj.uid);
        if (!live) { closePixelStack(ed); return; }
        copyObjectStyle(ed, live);
      });

      rowRecords.push({ obj, layerId, rowEl, selBtn, soloBtn });
      listEl.append(rowEl);
    }
  }

  function syncRowStates() {
    for (const r of rowRecords) {
      const selected = ed.state.selection.has(r.obj.uid);
      const soloed = ed.state.visible.size === 1 && ed.state.visible.has(r.layerId);
      r.rowEl.classList.toggle('sel', selected);
      r.selBtn.classList.toggle('on', selected);
      r.soloBtn.classList.toggle('on', soloed);
    }
  }

  const card = h('div', { class: 'mmp-stack-card', role: 'dialog', 'aria-label': 'Pixel Stack Inspector' }, head, listEl);
  for (const evName of ['pointerdown', 'mousedown', 'dblclick', 'contextmenu']) {
    card.addEventListener(evName, ev => ev.stopPropagation());
  }
  document.body.append(card);
  st.card = card;

  const rect = (ed.canvas || ed.renderer?.canvas)?.getBoundingClientRect?.() || { left: 0, top: 0 };
  const clientX = e.event?.clientX ?? (rect.left + (e.sx || 0));
  const clientY = e.event?.clientY ?? (rect.top + (e.sy || 0));
  const cw = card.offsetWidth || 416;
  const ch = card.offsetHeight || 200;
  let left = clientX + 14;
  let top = clientY + 14;
  if (left + cw > window.innerWidth - 8) left = clientX - cw - 14;
  if (top + ch > window.innerHeight - 8) top = clientY - ch - 14;
  left = Math.max(8, Math.min(left, window.innerWidth - cw - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - ch - 8));
  card.style.left = Math.round(left) + 'px';
  card.style.top = Math.round(top) + 'px';

  const onKeyDown = ev => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      closePixelStack(ed);
    }
  };
  const onOutsidePointerDown = ev => {
    if (card.contains(ev.target)) return;
    closePixelStack(ed);
  };
  const onToolChange = () => {
    if (ed.state.tool !== 'select') closePixelStack(ed);
  };
  const onFileChange = () => closePixelStack(ed);
  const onDocChange = () => closePixelStack(ed);
  const onSelection = () => syncRowStates();
  const onView = () => syncRowStates();

  window.addEventListener('keydown', onKeyDown, true);
  // Defer outside-click binding past the opening pointerdown event.
  const bindTimer = setTimeout(() => {
    if (st.card === card) window.addEventListener('pointerdown', onOutsidePointerDown, true);
  }, 0);
  const unsubTool = subscribeEditor(ed, 'tool', onToolChange);
  const unsubFile = subscribeEditor(ed, 'file', onFileChange);
  const unsubDoc = subscribeEditor(ed, 'doc', onDocChange);
  const unsubSel = subscribeEditor(ed, 'selection', onSelection);
  const unsubView = subscribeEditor(ed, 'view-options', onView);

  st.cleanupCard = () => {
    clearTimeout(bindTimer);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('pointerdown', onOutsidePointerDown, true);
    unsubTool();
    unsubFile();
    unsubDoc();
    unsubSel();
    unsubView();
  };

  ed.requestRender?.();
  return card;
}

function subscribeEditor(ed, eventName, fn) {
  if (!ed?.on) return () => {};
  ed.on(eventName, fn);
  return () => ed.listeners?.get?.(eventName)?.delete?.(fn);
}

// Drawn in screen space after Editor.drawSelection().
export function drawInspectorOverlay(ctx, ed) {
  const st = editorStates.get(ed);
  if (!st?.card || !st.world || !ed?.renderer) return;
  const r = ed.renderer;
  const z = r.view?.zoom || 1;

  if (st.hoveredUid != null) {
    const obj = ed.doc?.get?.(st.hoveredUid);
    if (obj) {
      r.worldTransform();
      ctx.save();
      const kind = KIND_BY_TYPE[obj.type];
      const pts = kind === 'sprite' ? spriteCorners(obj, spriteSize(obj, ed.catalog)) : obj.points;
      if (pts?.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        ctx.fillStyle = 'rgba(255, 210, 74, 0.14)';
        ctx.fill();
        ctx.strokeStyle = '#ffd24a';
        ctx.lineWidth = 2 / z;
        ctx.stroke();
      }
      ctx.restore();
      r.screenTransform();
    }
  }

  const s = r.toScreen(st.world.x, st.world.y);
  ctx.save();
  ctx.strokeStyle = 'rgba(11, 14, 19, 0.85)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = '#ffd24a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
  ctx.moveTo(s.x - 10, s.y); ctx.lineTo(s.x - 3, s.y);
  ctx.moveTo(s.x + 3, s.y); ctx.lineTo(s.x + 10, s.y);
  ctx.moveTo(s.x, s.y - 10); ctx.lineTo(s.x, s.y - 3);
  ctx.moveTo(s.x, s.y + 3); ctx.lineTo(s.x, s.y + 10);
  ctx.stroke();
  ctx.restore();
}

export function createLayerScrubber(ed) {
  const st = getEditorState(ed);
  const total = LAYERS.length;

  const range = h('input', {
    type: 'range',
    class: 'mmp-scrubber-range',
    min: '0',
    max: String(total),
    step: '1',
    value: String(st.peelCount ?? total),
    'aria-label': 'Layer stack scrubber',
    title: 'Peel layers from top down (view only)'
  });
  const readout = h('span', { class: 'mmp-scrubber-readout' });
  const resetBtn = h('button', {
    type: 'button',
    class: 'btn small flat mmp-scrubber-reset',
    title: 'Show all peeled layers'
  }, 'All');

  const sync = () => {
    const count = st.peelCount ?? total;
    if (Number(range.value) !== count) range.value = String(count);
    if (count >= total) {
      readout.textContent = `${total}/${total} All`;
      readout.title = 'All layers shown';
    } else if (count <= 0) {
      readout.textContent = `0/${total} None`;
      readout.title = 'All layers hidden';
    } else {
      const topLayer = LAYERS[total - count];
      readout.textContent = `${count}/${total} ${topLayer.title}`;
      readout.title = `Showing Sky through ${topLayer.title}`;
    }
    resetBtn.disabled = count >= total;
  };

  st.onScrubberSync = sync;

  range.addEventListener('input', () => setLayerPeelCount(ed, Number(range.value)));
  range.addEventListener('keydown', e => e.stopPropagation());
  resetBtn.addEventListener('click', () => resetLayerScrubber(ed));

  if (ed?.on) {
    ed.on('doc', reason => {
      if (reason !== 'load') return;
      const restore = st.baselineVisible || st.preSoloVisible;
      if (restore && ed.state) {
        ed.state.visible = new Set(restore);
      }
      st.peelCount = total;
      st.baselineVisible = null;
      st.preSoloVisible = null;
      sync();
      if (restore) {
        ed.emit?.('layer');
        ed.emit?.('view-options');
        ed.requestRender?.();
      }
    });
  }

  sync();
  return h('div', {
    class: 'mmp-scrubber',
    title: 'Layer stack scrubber: drag left to peel layers from the top down'
  },
    h('span', { class: 'mmp-scrubber-label' }, 'Peel'),
    range,
    readout,
    resetBtn
  );
}
