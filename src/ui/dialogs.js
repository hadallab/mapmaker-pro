// Modal dialogs. Each returns a promise that resolves when the dialog closes.

import { h, clear, numberField, toggle, select } from './dom.js';
import { LAYERS } from '../engine/layers.js';
import { icon } from './icons.js';
import { simplifyRing, simplifyToCount, allocatePointBudget, bounds } from '../engine/geometry.js';
import { host } from './host.js';

export function modal({ title, body, buttons, wide = false, onKey, onOpen, captureKeys }) {
  return new Promise(resolve => {
    const root = document.getElementById('modal-root');
    const close = value => { backdrop.remove(); window.removeEventListener('keydown', key, true); resolve(value); };
    const foot = h('div', { class: 'modal-foot' });
    for (const b of buttons) {
      const el = h('button', { class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '') }, b.label);
      el.addEventListener('click', () => close(typeof b.value === 'function' ? b.value() : b.value));
      foot.append(el);
      if (b.primary) setTimeout(() => el.focus(), 0);
    }
    const x = h('button', { class: 'btn icon flat', html: icon('close') });
    x.addEventListener('click', () => close(null));
    const dlg = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog' },
      h('div', { class: 'modal-head' }, title, x),
      h('div', { class: 'modal-body' }, body),
      foot);
    const backdrop = h('div', { class: 'modal-backdrop' }, dlg);
    backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) close(null); });
    const key = e => {
      if (captureKeys?.()) { onKey?.(e); return; }
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      if (e.key === 'Enter' && !e.target.closest('textarea')) {
        const primary = buttons.find(b => b.primary);
        if (primary) {
          e.preventDefault(); e.stopPropagation();
          if (e.target instanceof HTMLElement && e.target.tagName === 'INPUT') e.target.blur();
          setTimeout(() => close(typeof primary.value === 'function' ? primary.value() : primary.value), 0);
        }
      }
      onKey?.(e);
    };
    window.addEventListener('keydown', key, true);
    root.append(backdrop);
    onOpen?.(close);
    const first = dlg.querySelector('.modal-body input');
    if (first) setTimeout(() => first.focus(), 0);
  });
}

export function alert(title, text) {
  return modal({ title, body: h('p', {}, text), buttons: [{ label: 'OK', primary: true, value: true }] });
}

export function confirm(title, text, ok = 'OK') {
  return modal({
    title,
    body: h('p', {}, text),
    buttons: [{ label: 'Cancel', value: false }, { label: ok, primary: true, value: true }]
  }).then(v => !!v);
}

export function confirmSave(name) {
  return modal({
    title: 'Unsaved changes',
    body: h('p', {}, `Save changes to ${name} before continuing?`),
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: "Don't save", value: 'discard', danger: true },
      { label: 'Save', primary: true, value: 'save' }
    ]
  }).then(v => v || 'cancel');
}

export function prompt(title, label, value = '') {
  const input = h('input', { type: 'text', class: 'text', value });
  input.addEventListener('keydown', e => e.stopPropagation());
  return modal({
    title,
    body: h('div', {}, h('div', { class: 'row' }, h('span', { class: 'k' }, label), input)),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'OK', primary: true, value: () => input.value.trim() || null }
    ]
  });
}

// Sizes follow typical Deeeep.io map dimensions (1v1 20x20, PD ~240x40, FFA 700-950 x 100).
const PRESETS = [
  { id: '1v1', name: '1v1 arena', w: 20, h: 20 },
  { id: '1v1t', name: '1v1 tall', w: 20, h: 25 },
  { id: 'pd', name: 'Pearl Defense', w: 240, h: 40 },
  { id: 'ffa', name: 'FFA', w: 800, h: 100 },
  { id: 'ffaw', name: 'Wide FFA', w: 900, h: 100 },
  { id: 'custom', name: 'Custom', w: null, h: null }
];

export function newMap() {
  let w = 20, hh = 20, gravity = 9.8, template = true, chosen = '1v1';
  const presets = h('div', { class: 'presets' });
  const fields = h('div');
  const draw = () => {
    clear(presets);
    for (const p of PRESETS) {
      const b = h('button', { class: 'preset' + (chosen === p.id ? ' on' : '') },
        h('b', {}, p.name),
        h('span', {}, p.w ? `${p.w} x ${p.h}` : 'any size'));
      b.addEventListener('click', () => { chosen = p.id; if (p.w) { w = p.w; hh = p.h; } draw(); });
      presets.append(b);
    }
    clear(fields);
    fields.append(
      h('div', { class: 'grid3' },
        numberField({ label: 'Width', value: w, digits: 2, min: 1, onCommit: v => { w = v; chosen = 'custom'; draw(); } }),
        numberField({ label: 'Height', value: hh, digits: 2, min: 1, onCommit: v => { hh = v; chosen = 'custom'; draw(); } }),
        numberField({ label: 'Gravity', value: gravity, digits: 2, step: 0.1, onCommit: v => { gravity = v; } })),
      h('div', { class: 'row' }, toggle({ checked: template, label: 'Start with sky and water', onChange: v => { template = v; } })),
      h('p', { class: 'muted', style: { margin: '8px 0 0' } },
        `Food budget ${Math.floor(w * hh / 12.3)}, NPC budget ${Math.floor(Math.min(200, w * hh / 200))}. ` +
        'Size is in Mapmaker units (1 unit = 10 px in the file).'));
  };
  draw();
  return modal({
    title: 'New map',
    body: h('div', {}, presets, fields),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Create', primary: true, value: () => ({ width: w, height: hh, gravity, template }) }
    ]
  });
}

export function mapSettings(doc) {
  let w = doc.worldSize.width, hh = doc.worldSize.height, g = Number(doc.settings.gravity);
  const body = h('div', {},
    h('div', { class: 'grid3' },
      numberField({ label: 'Width', value: w, digits: 2, min: 1, onCommit: v => { w = v; } }),
      numberField({ label: 'Height', value: hh, digits: 2, min: 1, onCommit: v => { hh = v; } }),
      numberField({ label: 'Gravity', value: g, digits: 2, step: 0.1, onCommit: v => { g = v; } })),
    h('p', { class: 'muted', style: { margin: '6px 0 0' } }, 'Shrinking the world leaves objects in place; the Checks panel lists anything that ends up outside.'));
  return modal({
    title: 'Map settings',
    body,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Apply', primary: true, value: () => ({ width: w, height: hh, gravity: g }) }
    ]
  });
}

export function simplify(targets) {
  let mode = 'tolerance';
  let eps = 1;
  const before = targets.reduce((s, o) => s + o.points.length, 0);
  const minTarget = targets.reduce((s, o) => s + Math.min(3, o.points.length), 0);
  let targetPoints = Math.max(minTarget, Math.min(before, Math.round(before * 0.5)));

  const seg = h('div', { class: 'seg', style: { marginBottom: '10px' } });
  const controls = h('div');
  const result = h('span', { class: 'v' });

  const update = () => {
    let after;
    if (mode === 'tolerance') {
      after = targets.reduce((s, o) => s + simplifyRing(o.points, eps * 10).length, 0);
    } else {
      const alloc = allocatePointBudget(targets.map(o => o.points), targetPoints);
      after = targets.reduce((s, o, i) => s + simplifyToCount(o.points, alloc[i]).length, 0);
    }
    result.textContent = `${before} -> ${after} points (${before ? Math.round((1 - after / before) * 100) : 0}% fewer)`;
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
        label: 'Tolerance', value: eps, digits: 2, step: 0.05, min: 0.01, max: 50, suffix: 'u',
        onCommit: v => { eps = v; range.value = v; update(); }
      });
      range.addEventListener('input', () => { eps = Number(range.value); update(); num.querySelector('input').value = eps; });
      controls.append(
        h('p', {},
          'Removes vertices that deviate less than the tolerance from the outline (Douglas-Peucker). ' +
          'Fewer points mean fewer physics edges in game.'),
        h('div', { class: 'row' }, range),
        num
      );
    } else {
      const maxTarget = Math.max(minTarget, before);
      const range = h('input', {
        type: 'range', min: minTarget, max: maxTarget, step: 1, value: targetPoints,
        disabled: before <= minTarget
      });
      const num = numberField({
        label: 'Target', value: targetPoints, digits: 0, step: 1, min: minTarget, max: maxTarget, suffix: 'pts',
        disabled: before <= minTarget,
        onCommit: v => { targetPoints = Math.round(v); range.value = targetPoints; update(); }
      });
      range.addEventListener('input', () => {
        targetPoints = Math.round(Number(range.value));
        update();
        num.querySelector('input').value = targetPoints;
      });
      controls.append(
        h('p', {},
          'Reduces the outline to a target vertex count by dropping the smallest-area corners first ' +
          'while keeping the ring valid (Visvalingam-Whyatt).'),
        h('div', { class: 'row' }, range),
        num
      );
    }
    update();
  };

  renderControls();
  return modal({
    title: 'Simplify outline',
    body: h('div', {}, seg, controls, h('div', { class: 'row', style: { marginTop: '10px' } }, result)),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Simplify', primary: true, value: () => (mode === 'tolerance' ? eps * 10 : { mode: 'target', targetPoints }) }
    ]
  });
}

export function importNotes(name, notes) {
  return modal({
    title: 'Opened with adjustments',
    wide: true,
    body: h('div', {},
      h('p', {},
        `${name || 'The map'} was opened the way the official Mapmaker opens it. ` +
        'These changes were applied so the editor shows exactly what Mapmaker would:'),
      h('div', { class: 'notes' }, notes.map(n => h('div', {}, n)))),
    buttons: [{ label: 'OK', primary: true, value: true }]
  });
}

export function shortcuts(ed) {
  const groups = [
    ['Tools', [
      ['Selection', 'O'],
      ['Point selection', 'P'],
      ['Sculpt brush', 'S'],
      ['Move', 'M'],
      ['Rotate', 'T'],
      ['Draw points', 'D'],
      ['Rectangle', 'R'],
      ['Ellipse', 'E'],
      ['Regular polygon', 'N'],
      ['Knife', 'K'],
      ['Hide space', 'H'],
      ['Scatter brush', 'F'],
      ['Preview animal', 'A'],
      ['Prop', 'X'],
      ['Eyedropper', 'I'],
      ['Measure', 'U'],
      ['Napoleon block', 'B'],
      ['Pan', 'V or hold Space'],
      ['Zoom', 'Z']
    ]],
    ['Canvas', [
      ['Pan', 'Wheel / middle drag'],
      ['Zoom', 'Ctrl + wheel'],
      ['Nudge 0.1 unit / 1 unit', 'Arrows / Shift+Arrows'],
      ['Constrain, square, 15 deg', 'Shift'],
      ['From centre / duplicate drag', 'Alt'],
      ['Finish polygon', 'Enter or double-click'],
      ['Remove last point', 'Backspace'],
      ['Cancel', 'Esc'],
      ['Insert point on edge', 'Double-click (point tool)'],
      ['Trace contour segment (Draw points)', 'Alt+Click (Shift flips)'],
      ['Constrain knife to 45 deg / finish polyline', 'Shift / Enter or double-click'],
      ['Scatter brush size', ', / . or Ctrl + wheel'],
      ['Scatter erase', 'Alt + drag'],
      ['Inspect everything under the cursor', 'Alt+Shift+Click (selection tool)'],
      ['Sculpt brush size', '[ / ] or Ctrl + wheel'],
      ['Sculpt edge slide', 'Alt + drag'],
      ['Sculpt seam lock', 'L'],
      ['Draw inside selected shape', 'Shift+D'],
      ['Value view / readability curtain', 'Shift+Y / Shift+C']
    ]],
    ['Commands', ed.commands.list.filter(c => c.keys).map(c => [ed.commands.label(c), c.keys])]
  ];
  const body = h('div', { class: 'keys' });
  for (const [title, rows] of groups) {
    body.append(h('h4', {}, title));
    for (const [label, key] of rows) body.append(h('span', {}, label), h('span', {}, h('kbd', {}, key)));
  }
  return modal({ title: 'Keyboard shortcuts', wide: true, body, buttons: [{ label: 'Close', primary: true, value: true }] });
}

export async function about(ed) {
  const v = await host.version();
  const src = ed.catalog.raw.source;
  return modal({
    title: 'Mapmaker Pro',
    body: h('div', {},
      h('p', {}, `Version ${v}. A standalone editor for Deeeep.io maps with its own engine that reads and writes the official Mapmaker DPM format.`),
      h('p', {},
        `Format and rendering rules follow ${src.engine} (engine ${src.engineVersion}). ` +
        'Every export is checked against that engine by the native round-trip test.'),
      h('p', {},
        `${ed.catalog.textures.length} textures, ${ed.catalog.hideSpaces.length} hide spaces, ` +
        `${ed.catalog.props.length} props, ${ed.catalog.foods.length} foods and ` +
        `${ed.catalog.animals.length} animals from the official asset packs are bundled.`)),
    buttons: [{ label: 'Close', primary: true, value: true }]
  });
}

export function offsetDialog(activeLayer) {
  let distance = 1, join = 'round', target = 'replace';
  const layers = LAYERS.filter(l => l.kind === 'poly');
  const body = h('div', {},
    h('p', {},
      'Grows (positive) or shrinks (negative) the outline. ' +
      'Use a copy on another layer to build a shoreline band or a background behind terrain.'),
    h('div', { class: 'row' }, numberField({
      label: 'Distance', value: distance, digits: 2, step: 0.5, min: -500, max: 500, suffix: 'u',
      onCommit: v => { distance = v; }
    })),
    h('div', { class: 'row' },
      h('span', { class: 'k' }, 'Corners'),
      select({
        value: join,
        options: [
          { value: 'round', label: 'Round' },
          { value: 'miter', label: 'Sharp (miter)' },
          { value: 'square', label: 'Square' }
        ],
        onChange: v => { join = v; }
      })),
    h('div', { class: 'row' },
      h('span', { class: 'k' }, 'Result'),
      select({
        value: target,
        options: [
          { value: 'replace', label: 'Replace the outline' },
          ...layers.map(l => ({ value: l.id, label: 'New copy on ' + l.title + (l.id === activeLayer ? ' (active)' : '') }))
        ],
        onChange: v => { target = v; }
      })));
  return modal({
    title: 'Offset outline',
    body,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Apply', primary: true, value: () => (distance ? { distance, join, target } : null) }
    ]
  });
}

export function smoothDialog(targets) {
  let iterations = 2, amount = 0.25;
  const before = targets.reduce((s, o) => s + o.points.length, 0);
  const info = h('span', { class: 'v' });
  const update = () => { info.textContent = `${before} -> ${before * Math.pow(2, iterations)} points`; };
  update();
  const body = h('div', {},
    h('p', {}, 'Rounds corners by cutting them (Chaikin). Each pass doubles the point count; use Simplify afterwards to thin flat stretches.'),
    h('div', { class: 'grid2' },
      numberField({ label: 'Passes', value: iterations, digits: 0, min: 1, max: 5, onCommit: v => { iterations = Math.round(v); update(); } }),
      numberField({ label: 'Strength', value: amount, digits: 2, step: 0.05, min: 0.05, max: 0.45, onCommit: v => { amount = v; } })),
    h('div', { class: 'row' }, info));
  return modal({
    title: 'Smooth outline',
    body,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Smooth', primary: true, value: () => ({ iterations, amount }) }
    ]
  });
}

export function bakeGradientDialog(targets = []) {
  let bands = 16, overlap = 0.1, seamLift = true;
  const maxH = targets.reduce((m, o) => Math.max(m, o.points?.length ? bounds(o.points).height / 10 : 0), 0);
  const info = h('span', { class: 'v' });
  const update = () => {
    if (!maxH) { info.textContent = `${bands} horizontal 2-stop bands`; return; }
    const stepU = maxH / bands;
    info.textContent = `~${stepU.toFixed(2)} u per band (${stepU < 0.15 ? 'solid [c,c] under 0.15 u' : '2-stop gradient'})`;
  };
  update();
  const body = h('div', {},
    h('p', {},
      'Slices multi-stop Sky polygons into consecutive 2-stop bands for the map tester. ' +
      'Bands shorter than 1.5 px automatically become solid colour so they never turn black.'),
    h('div', { class: 'grid2' },
      numberField({
        label: 'Bands', value: bands, digits: 0, min: 2, max: 64, step: 1,
        onCommit: v => { bands = Math.max(2, Math.round(v)); update(); }
      }),
      numberField({
        label: 'Overlap', value: overlap, digits: 2, min: 0, max: 5, step: 0.05, suffix: 'u',
        onCommit: v => { overlap = Math.max(0, v); }
      })),
    h('div', { class: 'row' }, toggle({ checked: seamLift, label: 'Edge seam-lift (prevents 1 px texture wrap seam)', onChange: v => { seamLift = v; } })),
    h('div', { class: 'row' }, info));
  return modal({
    title: 'Bake Sky gradient to bands',
    body,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Bake', primary: true, value: () => ({ bands, overlap: overlap * 10, seamLift: seamLift ? 0.6 : 0 }) }
    ]
  });
}

export function frameCutDialog() {
  let side = 'left', slitWidth = 0.01;
  const body = h('div', {},
    h('p', {},
      'Subtracts the inner ring from the outer frame into a single hole-free polygon ' +
      'through a hairline side-wall slit instead of cutting the ceiling and floor.'),
    h('div', { class: 'row' },
      h('span', { class: 'k' }, 'Side wall'),
      select({
        value: side,
        options: [{ value: 'left', label: 'Left wall' }, { value: 'right', label: 'Right wall' }],
        onChange: v => { side = v; }
      })),
    h('div', { class: 'row' }, numberField({
      label: 'Slit width', value: slitWidth, digits: 3, min: 0.01, max: 5, step: 0.01, suffix: 'u',
      onCommit: v => { slitWidth = Math.max(0.01, v); }
    })));
  return modal({
    title: 'Cut single-ring arena frame',
    body,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Cut frame', primary: true, value: () => ({ side, slitWidth: Math.max(0.1, slitWidth * 10) }) }
    ]
  });
}
