// Atmosphere & Palette Studio dialog, Selection colors section, and Bg depth stepper.

import { clamp, hexToInt } from '../engine/geometry.js';
import {
  BG_ALLOWED_OPACITIES,
  BG_DECEPTIVE_OPACITY,
  collectSelectionColors,
  replaceSelectionColor,
  collectPaletteTargets,
  computeObjectDepths,
  computeAtmospherePreview,
  applyAtmosphereAdjust,
  computeBgDepthSteps,
  orderBgObjects,
  compoundedOpacity,
  stepBgDepthOpacities,
  extractPaletteFromPixels
} from '../engine/palette.js';
import { h, clear, fmt, colorField, select } from './dom.js';
import { icon } from './icons.js';

const DEFAULT_HAZE_HEX = '#cfe9fc';

const bgDepthState = {
  far: 0.1,
  near: 0.5,
  orderBy: 'z'
};

let activeStudio = null;
const refPaletteCache = new WeakMap();

export function paletteCommands(ed) {
  return [
    {
      id: 'edit.paletteStudio',
      label: 'Atmosphere & palette studio...',
      keys: 'Shift+A',
      run: () => openPaletteStudio(ed)
    }
  ];
}

function isValidHex6(raw) {
  return /^#?[0-9a-f]{6}$/i.test(String(raw || '').trim());
}

function normalizeHex6(raw) {
  const s = String(raw || '').trim();
  return (s.startsWith('#') ? '' : '#') + s.toLowerCase();
}

export function buildSelectionColorsSection(ed, sel) {
  const gradObjs = (sel || []).filter(o => o && (o.type === 'Sky' || o.type === 'Wat'));
  if (gradObjs.length < 2) return null;

  const entries = collectSelectionColors(gradObjs);
  if (!entries.length) return null;

  const sec = h('div', { class: 'section' },
    h('div', { class: 'section-title' },
      h('span', {}, 'Selection colors'),
      h('span', { class: 'aside' }, `${entries.length} color${entries.length === 1 ? '' : 's'}`)
    )
  );

  const applyReplace = (fromColor, rawHex) => {
    if (!isValidHex6(rawHex)) return false;
    const nextHex = normalizeHex6(rawHex);
    const toInt = hexToInt(nextHex) & 0xffffff;
    if ((fromColor & 0xffffff) === toInt) return false;

    const editable = gradObjs.filter(o => !ed.state?.locked?.has(o.layerId));
    if (!editable.length) {
      ed.toast?.('Selected layers are locked', 'err');
      return false;
    }

    const res = ed.edit('Replace selection color', () =>
      replaceSelectionColor(ed.doc, editable, fromColor, toInt, { preserveThinSky: true })
    );
    if (res?.changedObjects) {
      const stopWord = res.changedStops === 1 ? 'stop' : 'stops';
      const objWord = res.changedObjects === 1 ? 'object' : 'objects';
      ed.toast?.(`Updated ${res.changedStops} ${stopWord} in ${res.changedObjects} ${objWord}`, 'ok');
    }
    return true;
  };

  const list = h('div', { class: 'mmp-sel-colors' });
  for (const entry of entries) {
    const hexInput = h('input', {
      type: 'text',
      class: 'hex-in',
      value: entry.hex,
      maxlength: '7',
      spellcheck: 'false',
      title: `Used in ${entry.objectCount} object${entry.objectCount === 1 ? '' : 's'}`
    });
    const commitHex = () => {
      if (!isValidHex6(hexInput.value)) {
        hexInput.value = entry.hex;
        return;
      }
      applyReplace(entry.color, hexInput.value);
    };
    hexInput.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { commitHex(); hexInput.select(); }
      else if (e.key === 'Escape') { hexInput.value = entry.hex; hexInput.blur(); }
    });
    hexInput.addEventListener('change', commitHex);

    const cf = colorField({
      value: entry.hex,
      title: `Replace ${entry.hex} across selection`,
      onCommit: hex => applyReplace(entry.color, hex)
    });

    const countText = `${entry.count} stop${entry.count === 1 ? '' : 's'}`;
    list.append(h('div', { class: 'mmp-sel-color-row' },
      cf,
      hexInput,
      h('span', { class: 'mmp-sel-color-count', title: `${entry.objectCount} object${entry.objectCount === 1 ? '' : 's'}` }, countText)
    ));
  }

  const studioBtn = h('button', {
    type: 'button',
    class: 'btn small',
    'data-tip': 'Hue, saturation, lightness & depth haze (Shift+A)'
  }, 'Atmosphere studio...');
  studioBtn.addEventListener('click', () => openPaletteStudio(ed));

  sec.append(list, h('div', { class: 'btn-row', style: { marginTop: '8px' } }, studioBtn));
  return sec;
}

export function buildBgDepthSection(ed, sel) {
  const bgs = (sel || []).filter(o => o && o.type === 'Bg');
  if (bgs.length < 2) return null;

  const options = BG_ALLOWED_OPACITIES.map(v => ({
    value: String(v),
    label: `${Math.round(v * 100)}% (${v.toFixed(1)})`
  }));

  const sec = h('div', { class: 'section' },
    h('div', { class: 'section-title' },
      h('span', {}, 'Depth stepper'),
      h('span', { class: 'aside' }, `${bgs.length} layers`)
    )
  );

  const previewEl = h('div', { class: 'mmp-bg-preview' });
  const warnEl = h('p', { class: 'muted', style: { margin: '6px 0 0', color: 'var(--warn)', display: 'none' } },
    'Opacities >= 65% in playable water trigger readability warnings.');

  const refreshPreview = () => {
    clear(previewEl);
    const ordered = orderBgObjects(bgs, ed.doc, bgDepthState.orderBy);
    const steps = computeBgDepthSteps(ordered.length, bgDepthState.far, bgDepthState.near);
    const comp = compoundedOpacity(steps);
    const stepText = steps.length <= 5
      ? steps.map(v => v.toFixed(1)).join(' -> ')
      : `${steps[0].toFixed(1)} .. ${steps[steps.length - 1].toFixed(1)} (${steps.length})`;
    const hasHigh = steps.some(v => v >= BG_DECEPTIVE_OPACITY);
    previewEl.append(
      h('span', {}, stepText),
      h('span', { class: hasHigh ? 'warn' : '' }, `Stack ${Math.round(comp * 100)}%`)
    );
    warnEl.style.display = hasHigh ? '' : 'none';
  };

  const farSel = select({
    value: String(bgDepthState.far),
    options,
    title: 'Farthest Bg opacity (drawn behind)',
    onChange: v => { bgDepthState.far = Number(v); refreshPreview(); }
  });
  const nearSel = select({
    value: String(bgDepthState.near),
    options,
    title: 'Nearest Bg opacity (drawn on top)',
    onChange: v => { bgDepthState.near = Number(v); refreshPreview(); }
  });
  const orderSel = select({
    value: bgDepthState.orderBy,
    options: [
      { value: 'z', label: 'Draw order (far -> near)' },
      { value: 'y-asc', label: 'Top -> Bottom (skyline)' },
      { value: 'y-desc', label: 'Bottom -> Top' },
      { value: 'selection', label: 'Selection order' }
    ],
    title: 'How selected Bg polygons are ordered from far to near',
    onChange: v => { bgDepthState.orderBy = v; refreshPreview(); }
  });

  const applyBtn = h('button', { type: 'button', class: 'btn small primary', style: { flex: '1' } }, 'Apply depth steps');
  applyBtn.addEventListener('click', () => {
    const editable = bgs.filter(o => !ed.state?.locked?.has(o.layerId));
    if (editable.length < 2) {
      ed.toast?.('Unlock Background Terrains layer first', 'err');
      return;
    }
    const res = ed.edit('Step Bg depth opacities', () =>
      stepBgDepthOpacities(ed.doc, editable, bgDepthState)
    );
    if (res) {
      ed.toast?.(`Stepped ${res.count} Bg opacities (${bgDepthState.far.toFixed(1)} -> ${bgDepthState.near.toFixed(1)})`, 'ok');
    }
  });

  refreshPreview();
  sec.append(
    h('div', { class: 'grid2' },
      h('div', { class: 'row', style: { marginBottom: 0 } }, h('span', { class: 'k', style: { width: '34px', minWidth: '34px' } }, 'Far'), farSel),
      h('div', { class: 'row', style: { marginBottom: 0 } }, h('span', { class: 'k', style: { width: '34px', minWidth: '34px' } }, 'Near'), nearSel)
    ),
    h('div', { class: 'row', style: { marginTop: '6px' } }, h('span', { class: 'k', style: { width: '48px', minWidth: '48px' } }, 'Order'), orderSel),
    previewEl,
    warnEl,
    h('div', { class: 'btn-row', style: { marginTop: '8px' } }, applyBtn)
  );
  return sec;
}

function sampleReferencePalette(img) {
  if (!img || typeof document === 'undefined') return [];
  if (refPaletteCache.has(img)) return refPaletteCache.get(img);
  try {
    const w0 = img.naturalWidth || img.width || 0;
    const h0 = img.naturalHeight || img.height || 0;
    if (!w0 || !h0) return [];
    const scale = Math.min(1, 48 / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale));
    const hgt = Math.max(1, Math.round(h0 * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = hgt;
    const ctx = canvas.getContext('2d');
    if (!ctx) return [];
    ctx.drawImage(img, 0, 0, w, hgt);
    const data = ctx.getImageData(0, 0, w, hgt).data;
    const palette = extractPaletteFromPixels(data, 6);
    refPaletteCache.set(img, palette);
    return palette;
  } catch {
    return [];
  }
}

function sliderControl({ label, min, max, step, value, suffix = '', onInput }) {
  let current = value;
  const range = h('input', { type: 'range', min, max, step, value });
  const input = h('input', { class: 'num', type: 'text', inputmode: 'decimal', spellcheck: 'false', value: fmt(value, 0) });
  const lab = h('span', { class: 'num-label', title: 'Drag horizontally to scrub' }, '');

  const set = (next, notify = true) => {
    const v = clamp(Math.round(Number(next) || 0), min, max);
    current = v;
    range.value = String(v);
    if (document.activeElement !== input) input.value = fmt(v, 0);
    if (notify) onInput(v);
  };

  range.addEventListener('input', () => set(Number(range.value), true));

  const commitText = () => {
    const parsed = Number(String(input.value).replace(',', '.'));
    if (!Number.isFinite(parsed)) { input.value = fmt(current, 0); return; }
    set(parsed, true);
    input.value = fmt(current, 0);
  };

  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { commitText(); input.select(); }
    else if (e.key === 'Escape') { input.value = fmt(current, 0); input.blur(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const mult = e.shiftKey ? 10 : 1;
      set(current + mult * step * (e.key === 'ArrowUp' ? 1 : -1), true);
      input.value = fmt(current, 0);
    }
  });
  input.addEventListener('blur', commitText);
  input.addEventListener('focus', () => input.select());

  lab.addEventListener('pointerdown', e => {
    const startX = e.clientX;
    const base = current;
    lab.setPointerCapture(e.pointerId);
    let moved = false;
    const move = ev => {
      const dx = ev.clientX - startX;
      if (Math.abs(dx) > 2) moved = true;
      if (moved) {
        set(base + Math.round(dx / 2) * step * (ev.shiftKey ? 5 : 1), true);
        input.value = fmt(current, 0);
      }
    };
    const up = () => {
      lab.removeEventListener('pointermove', move);
      lab.removeEventListener('pointerup', up);
      if (!moved) input.focus();
    };
    lab.addEventListener('pointermove', move);
    lab.addEventListener('pointerup', up);
  });

  const field = h('label', { class: 'field' + (suffix ? ' has-suffix' : '') },
    lab,
    input,
    suffix ? h('span', { class: 'suffix' }, suffix) : null
  );

  return {
    row: h('div', { class: 'mmp-studio-row' },
      h('span', { class: 'mmp-studio-label' }, label),
      range,
      field
    ),
    sync(v) {
      current = clamp(Math.round(Number(v) || 0), min, max);
      range.value = String(current);
      input.value = fmt(current, 0);
    }
  };
}

export function openPaletteStudio(ed) {
  if (!ed?.doc || typeof document === 'undefined') return null;
  if (activeStudio) {
    activeStudio.close(true);
  }

  const selInitial = collectPaletteTargets(ed.doc, {
    scope: 'selection',
    selection: ed.selected(),
    includeAir: true,
    locked: ed.state.locked
  });

  const state = {
    scope: selInitial.length > 0 ? 'selection' : 'map',
    hue: 0,
    saturation: 0,
    lightness: 0,
    haze: 0,
    hazeColor: DEFAULT_HAZE_HEX,
    direction: 'top-to-bottom'
  };

  let cachedDepthKey = '';
  let cachedTargets = [];
  let cachedDepths = null;
  let committing = false;
  let closed = false;

  const getMapTargets = () => collectPaletteTargets(ed.doc, {
    scope: 'map',
    includeAir: true,
    locked: ed.state.locked
  });

  const resolveTargets = () => {
    const targets = state.scope === 'selection'
      ? collectPaletteTargets(ed.doc, { scope: 'selection', selection: ed.selected(), includeAir: true, locked: ed.state.locked })
      : getMapTargets();
    const key = state.scope + ':' + state.direction + ':' + targets.map(o => o.uid).join(',');
    if (key !== cachedDepthKey) {
      cachedDepthKey = key;
      cachedTargets = targets;
      cachedDepths = computeObjectDepths(targets, {
        worldHeight: ed.doc.pixelHeight,
        direction: state.direction,
        range: 'auto'
      });
    }
    return { targets: cachedTargets, depths: cachedDepths };
  };

  const statusEl = h('div', { class: 'mmp-studio-status' });
  const selScopeBtn = h('button', { type: 'button' });
  const mapScopeBtn = h('button', { type: 'button' });
  const dirTopBtn = h('button', { type: 'button' }, 'Top -> Bottom');
  const dirBotBtn = h('button', { type: 'button' }, 'Bottom -> Top');

  const syncScopeButtons = () => {
    const selCount = collectPaletteTargets(ed.doc, {
      scope: 'selection',
      selection: ed.selected(),
      includeAir: true,
      locked: ed.state.locked
    }).length;
    const mapCount = getMapTargets().length;
    selScopeBtn.textContent = `Selection (${selCount})`;
    mapScopeBtn.textContent = `Entire map (${mapCount})`;
    selScopeBtn.className = state.scope === 'selection' ? 'on' : '';
    mapScopeBtn.className = state.scope === 'map' ? 'on' : '';
    dirTopBtn.className = state.direction === 'top-to-bottom' ? 'on' : '';
    dirBotBtn.className = state.direction === 'bottom-to-top' ? 'on' : '';
  };

  const updatePreview = () => {
    if (closed) return;
    const { targets, depths } = resolveTargets();
    const res = computeAtmospherePreview(targets, {
      hue: state.hue,
      saturation: state.saturation,
      lightness: state.lightness,
      haze: state.haze,
      hazeColor: hexToInt(state.hazeColor)
    }, {
      worldHeight: ed.doc.pixelHeight,
      direction: state.direction,
      includeAir: true,
      preserveThinSky: true,
      depths
    });
    ed.previewColors = res.overrides.size ? res.overrides : null;
    syncScopeButtons();
    if (!targets.length) {
      statusEl.textContent = state.scope === 'selection'
        ? 'No unlocked Sky, Water or Air objects selected.'
        : 'No unlocked Sky, Water or Air objects in map.';
    } else {
      const thinNote = res.thinSkyCount ? ` · ${res.thinSkyCount} thin Sky locked [c,c]` : '';
      statusEl.textContent = `${targets.length} target${targets.length === 1 ? '' : 's'} · ${res.changed} modified${thinNote}`;
    }
    ed.requestRender?.();
  };

  const hueCtrl = sliderControl({
    label: 'Hue', min: -180, max: 180, step: 1, value: 0, suffix: 'deg',
    onInput: v => { state.hue = v; updatePreview(); }
  });
  const satCtrl = sliderControl({
    label: 'Saturation', min: -100, max: 100, step: 1, value: 0, suffix: '%',
    onInput: v => { state.saturation = v; updatePreview(); }
  });
  const lightCtrl = sliderControl({
    label: 'Lightness', min: -100, max: 100, step: 1, value: 0, suffix: '%',
    onInput: v => { state.lightness = v; updatePreview(); }
  });
  const hazeCtrl = sliderControl({
    label: 'Depth haze', min: 0, max: 100, step: 1, value: 0, suffix: '%',
    onInput: v => { state.haze = v; updatePreview(); }
  });

  const hazeHexInput = h('input', {
    type: 'text',
    class: 'text',
    value: state.hazeColor,
    maxlength: '7',
    spellcheck: 'false',
    style: { width: '76px', height: '26px', font: '11px var(--mono)', padding: '0 6px' }
  });
  const hazeColorWrap = colorField({
    value: state.hazeColor,
    title: 'Haze color (or sample pixel from canvas)',
    onCommit: hex => setHazeColor(hex)
  });
  const hazeNativeInput = hazeColorWrap.querySelector('input[type="color"]');

  const setHazeColor = raw => {
    if (!isValidHex6(raw)) {
      hazeHexInput.value = state.hazeColor;
      return;
    }
    state.hazeColor = normalizeHex6(raw);
    if (hazeNativeInput) hazeNativeInput.value = state.hazeColor;
    if (document.activeElement !== hazeHexInput) hazeHexInput.value = state.hazeColor;
    updatePreview();
  };

  hazeNativeInput?.addEventListener('input', () => setHazeColor(hazeNativeInput.value));
  hazeHexInput.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { setHazeColor(hazeHexInput.value); hazeHexInput.select(); }
    else if (e.key === 'Escape') { hazeHexInput.value = state.hazeColor; hazeHexInput.blur(); }
  });
  hazeHexInput.addEventListener('change', () => setHazeColor(hazeHexInput.value));

  selScopeBtn.addEventListener('click', () => { state.scope = 'selection'; updatePreview(); });
  mapScopeBtn.addEventListener('click', () => { state.scope = 'map'; updatePreview(); });
  dirTopBtn.addEventListener('click', () => { state.direction = 'top-to-bottom'; updatePreview(); });
  dirBotBtn.addEventListener('click', () => { state.direction = 'bottom-to-top'; updatePreview(); });

  const refPalette = ed.meta?.referenceImage ? sampleReferencePalette(ed.meta.referenceImage) : [];
  let refSection = null;
  if (refPalette.length) {
    const swRow = h('div', { class: 'mmp-studio-swatches' });
    for (const hex of refPalette) {
      const btn = h('button', {
        type: 'button',
        class: 'mmp-studio-swatch',
        title: `Set haze color to ${hex}`,
        style: { background: hex }
      });
      btn.addEventListener('click', () => setHazeColor(hex));
      swRow.append(btn);
    }
    refSection = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
      h('span', { class: 'mmp-studio-label' }, 'Reference palette (click to set haze)'),
      swRow
    );
  }

  const closeBtn = h('button', { type: 'button', class: 'btn icon flat small', html: icon('close'), title: 'Cancel (Esc)' });
  const resetBtn = h('button', { type: 'button', class: 'btn small' }, 'Reset');
  const cancelBtn = h('button', { type: 'button', class: 'btn small' }, 'Cancel');
  const applyBtn = h('button', { type: 'button', class: 'btn small primary' }, 'Apply');

  const head = h('div', { class: 'mmp-studio-head' },
    h('span', { class: 'mmp-studio-title' }, 'Atmosphere & Palette Studio'),
    closeBtn
  );

  const body = h('div', { class: 'mmp-studio-body' },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
      h('span', { class: 'mmp-studio-label' }, 'Scope'),
      h('div', { class: 'seg' }, selScopeBtn, mapScopeBtn)
    ),
    hueCtrl.row,
    satCtrl.row,
    lightCtrl.row,
    h('div', { class: 'mmp-studio-sep' }),
    hazeCtrl.row,
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
      h('span', { class: 'mmp-studio-label' }, 'Haze color'),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, hazeColorWrap, hazeHexInput)
    ),
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
      h('span', { class: 'mmp-studio-label' }, 'Depth ramp'),
      h('div', { class: 'seg' }, dirTopBtn, dirBotBtn)
    ),
    refSection ? h('div', { class: 'mmp-studio-sep' }) : null,
    refSection,
    statusEl
  );

  const foot = h('div', { class: 'mmp-studio-foot' },
    resetBtn,
    h('span', { style: { flex: '1' } }),
    cancelBtn,
    applyBtn
  );

  const panel = h('div', { class: 'mmp-studio', role: 'dialog', 'aria-label': 'Atmosphere & Palette Studio' }, head, body, foot);
  panel.addEventListener('pointerdown', e => e.stopPropagation());

  head.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    head.setPointerCapture(e.pointerId);
    const rect = panel.getBoundingClientRect();
    const ox = e.clientX - rect.left;
    const oy = e.clientY - rect.top;
    const move = ev => {
      const x = clamp(ev.clientX - ox, 8, Math.max(8, window.innerWidth - panel.offsetWidth - 8));
      const y = clamp(ev.clientY - oy, 8, Math.max(8, window.innerHeight - panel.offsetHeight - 8));
      panel.style.left = Math.round(x) + 'px';
      panel.style.top = Math.round(y) + 'px';
      panel.style.right = 'auto';
    };
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
  });

  const cleanup = () => {
    if (closed) return;
    closed = true;
    ed.previewColors = null;
    document.removeEventListener('keydown', onKeyDown, true);
    ed.listeners?.get('selection')?.delete(onSelection);
    ed.listeners?.get('layer')?.delete(onSelection);
    ed.listeners?.get('doc')?.delete(onExternalDoc);
    clear(panel);
    panel.remove();
    if (activeStudio?.panel === panel) activeStudio = null;
  };

  const close = (restore = true) => {
    if (closed) return;
    cleanup();
    if (restore) ed.requestRender?.();
  };

  const applyAndClose = () => {
    if (closed) return;
    ed.previewColors = null;
    const { targets, depths } = resolveTargets();
    committing = true;
    let res = null;
    try {
      res = ed.edit('Atmosphere & palette', () =>
        applyAtmosphereAdjust(ed.doc, targets, {
          hue: state.hue,
          saturation: state.saturation,
          lightness: state.lightness,
          haze: state.haze,
          hazeColor: hexToInt(state.hazeColor)
        }, {
          worldHeight: ed.doc.pixelHeight,
          direction: state.direction,
          includeAir: true,
          preserveThinSky: true,
          depths
        })
      );
    } finally {
      committing = false;
    }
    cleanup();
    ed.requestRender?.();
    if (res?.changed) {
      ed.toast?.(`Updated colors on ${res.changed} object${res.changed === 1 ? '' : 's'}`, 'ok');
    } else {
      ed.toast?.('No color changes to apply');
    }
  };

  const onKeyDown = e => {
    if (e.key === 'Escape') {
      // Allow canvas pixel sampler to handle Esc first when active
      if (e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  };

  const onSelection = () => {
    if (closed || committing) return;
    updatePreview();
  };

  const onExternalDoc = reason => {
    if (closed || committing) return;
    if (reason === 'load') {
      close(true);
      return;
    }
    cachedDepthKey = '';
    updatePreview();
  };

  resetBtn.addEventListener('click', () => {
    state.hue = 0;
    state.saturation = 0;
    state.lightness = 0;
    state.haze = 0;
    hueCtrl.sync(0);
    satCtrl.sync(0);
    lightCtrl.sync(0);
    hazeCtrl.sync(0);
    updatePreview();
  });
  cancelBtn.addEventListener('click', () => close(true));
  closeBtn.addEventListener('click', () => close(true));
  applyBtn.addEventListener('click', applyAndClose);

  document.body.append(panel);
  const dock = document.getElementById('dock');
  const rightOffset = dock ? Math.min(window.innerWidth - 360, dock.getBoundingClientRect().width + 16) : 16;
  panel.style.top = '84px';
  panel.style.right = Math.max(12, Math.round(rightOffset)) + 'px';

  document.addEventListener('keydown', onKeyDown, true);
  ed.on('selection', onSelection);
  ed.on('layer', onSelection);
  ed.on('doc', onExternalDoc);

  activeStudio = { panel, close };
  updatePreview();
  return activeStudio;
}
