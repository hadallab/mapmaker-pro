// Window chrome: menu bar, toolbar, control bar, rulers, navigator, status bar,
// pointer/keyboard routing, context menu, tooltips and file drop.

import { LAYERS, LAYER_BY_ID, KIND_BY_TYPE } from '../engine/layers.js';
import { createCommands, keyString } from './commands.js';
import { TOOL_DEFS, toolAllowed } from './tools.js';
import { icon } from './icons.js';
import { h, clear, fmt, numberField, colorField, nextFrame, toggle } from './dom.js';
import { host } from './host.js';
import * as ops from '../engine/ops.js';
import { buildSculptControls } from './sculpt-tool.js';
import { buildPenSnapControls } from './contour-snap.js';
import { buildKnifeControls } from './knife-tool.js';
import { buildScatterControls } from './scatter-tool.js';

const TOOL_ORDER = [
  'select', 'point', 'sculpt', 'move', 'rotate', '|',
  'pen', 'rect', 'ellipse', 'polygon', 'knife', '|',
  'hide', 'scatter', 'animal', 'prop', '|',
  'eyedropper', 'measure', 'block', 'pan', 'zoom'
];

export function buildChrome(ed) {
  const commands = createCommands(ed);
  ed.commands = commands;
  buildMenubar(ed, commands);
  buildToolbar(ed);
  buildControlbar(ed);
  buildStatusbar(ed);
  buildRulers(ed);
  buildMinimap(ed);
  bindViewport(ed);
  bindKeyboard(ed, commands);
  bindTooltips();
  bindSplitter();
  bindTitle(ed);
}

// ------------------------------------------------------------------ menus

let openMenu = null;

function closeMenus() {
  clear(document.getElementById('menu-root'));
  document.querySelectorAll('.menu-btn.open').forEach(b => b.classList.remove('open'));
  openMenu = null;
}

export function showMenu(items, x, y, { owner = null } = {}) {
  const root = document.getElementById('menu-root');
  if (!owner) closeMenus();
  const menu = h('div', { class: 'menu' });
  for (const it of items) {
    if (it === '-') { menu.append(h('div', { class: 'menu-sep' })); continue; }
    const disabled = it.enabled === false;
    const row = h('div', { class: 'menu-item' + (disabled ? ' disabled' : '') },
      it.checked ? h('span', { class: 'tick', html: icon('check') }) : null,
      h('span', { class: 'label' }, it.label),
      it.keys ? h('span', { class: 'accel' }, it.keys) : null,
      it.submenu ? h('span', { class: 'sub', html: icon('chevron') }) : null);
    if (it.submenu && !disabled) {
      row.addEventListener('mouseenter', () => {
        menu.querySelectorAll('.menu-item.active').forEach(r => r.classList.remove('active'));
        [...root.children].slice([...root.children].indexOf(menu) + 1).forEach(m => m.remove());
        row.classList.add('active');
        const r = row.getBoundingClientRect();
        showMenu(typeof it.submenu === 'function' ? it.submenu() : it.submenu, r.right - 2, r.top - 4, { owner: menu });
      });
    } else {
      row.addEventListener('mouseenter', () => {
        menu.querySelectorAll('.menu-item.active').forEach(r => r.classList.remove('active'));
        [...root.children].slice([...root.children].indexOf(menu) + 1).forEach(m => m.remove());
      });
      if (!disabled) row.addEventListener('click', () => { closeMenus(); it.run(); });
    }
    menu.append(row);
  }
  root.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 6) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 6) + 'px';
  return menu;
}

function cmdItem(commands, id) {
  const c = commands.get(id);
  return { label: commands.label(c), keys: c.keys, enabled: commands.enabled(c), checked: c.checked?.(), run: () => c.run() };
}

function menuModel(ed, commands) {
  const C = id => cmdItem(commands, id);
  const sel = ed.selected();
  const polys = sel.filter(o => KIND_BY_TYPE[o.type] === 'poly');
  const ters = sel.filter(o => o.type === 'Ter');
  return {
    File: () => [
      C('file.new'), C('file.open'),
      { label: 'Open recent', submenu: async () => [], enabled: host.kind === 'electron', lazyRecent: true },
      '-', C('file.save'), C('file.saveAs'), '-', C('file.screenshot'), C('file.screenshotRegion'),
      ...(ed.state.file.path && host.kind === 'electron' ? [{ label: 'Show in folder', run: () => host.reveal(ed.state.file.path) }] : []),
      '-', C('file.mapSettings')
    ],
    Edit: () => [
      C('edit.undo'), C('edit.redo'), '-',
      C('edit.cut'), C('edit.copy'), C('edit.paste'), C('edit.pasteInPlace'),
      C('edit.copyStyle'), C('edit.pasteStyle'), C('edit.paletteStudio'),
      C('edit.duplicate'), C('edit.delete'), '-',
      C('edit.selectAll'), C('edit.selectLayer'), C('edit.selectSame'),
      {
        label: 'Select similar',
        submenu: [
          C('edit.selectSimilarTexture'),
          C('edit.selectSimilarColor'),
          C('edit.selectSimilarAsset'),
          C('edit.selectSimilarOpacity'),
          '-',
          C('edit.selectSmallPolygons')
        ]
      },
      C('edit.deselect'), '-', C('edit.preferences')
    ],
    Object: () => [
      { label: 'Transform', submenu: [C('obj.rotCW'), C('obj.rotCCW'), C('obj.rot180'), '-', C('obj.flipH'), C('obj.flipV')] },
      { label: 'Symmetry', submenu: [C('obj.mirrorCopyH'), C('obj.mirrorCopyV'), C('obj.pointCopy')] },
      { label: 'Arrange', submenu: [C('obj.front'), C('obj.forward'), C('obj.backward'), C('obj.back')] },
      {
        label: 'Align',
        submenu: [
          C('obj.alignL'), C('obj.alignHC'), C('obj.alignR'), '-',
          C('obj.alignT'), C('obj.alignVC'), C('obj.alignB'), '-',
          C('obj.distH'), C('obj.distV')
        ]
      },
      '-',
      {
        label: 'Move terrain to',
        enabled: ters.length > 0,
        submenu: ['terrains', 'islands', 'platforms'].map(id => ({
          label: LAYER_BY_ID[id].title,
          run: () => ed.edit('Move to ' + LAYER_BY_ID[id].title, () => ters.forEach(o => ops.moveTerrainLayer(ed.doc, o, id)))
        }))
      },
      {
        label: 'Convert outline to',
        enabled: polys.length > 0,
        submenu: LAYERS.filter(l => l.kind === 'poly').map(l => ({
          label: l.title,
          run: () => {
            const made = ed.edit('Convert to ' + l.title, () => polys.map(o => o.layerId === l.id ? o : ops.convertPolygon(ed.doc, o, l.id)).filter(Boolean));
            if (made) ed.select(made);
          }
        }))
      },
      C('obj.simplify'), C('obj.simplifyShared'), C('obj.clamp'), C('obj.reseatHideSpaces'), C('obj.drawInside'), '-',
      C('obj.group'), C('obj.ungroup'), C('obj.rename'), C('obj.unlinkTwin'), '-', C('obj.saveSymbol')
    ],
    Shape: () => [
      C('shape.union'), C('shape.subtract'), C('shape.intersect'), C('shape.exclude'), C('shape.cutFrame'), '-',
      C('shape.offset'), C('shape.smooth'), C('obj.simplify'), C('shape.bevel')
    ],
    Mapmaker: () => [C('mm.send'), C('mm.open'), C('mm.pull'), '-', C('mm.copy'), C('mm.console')],
    View: () => [
      C('view.zoomIn'), C('view.zoomOut'), C('view.fit'), C('view.zoomSel'), C('view.actual'), '-',
      C('view.outline'), C('view.isolate'), C('view.testerPreview'), C('view.grayscale'), C('view.curtain'), '-',
      C('view.grid'), C('view.snapGrid'), C('view.snapPoints'), C('view.snapEdges'), C('view.smartGuides'), C('view.keepInWorld'), '-',
      C('view.sim'), C('view.clearBlocks'), '-',
      { label: 'Live symmetry', submenu: () => ['sym.off', 'sym.h', 'sym.v', 'sym.p'].map(C) }, '-',
      C('view.rulers'), C('view.minimap')
    ],
    Help: () => [C('help.shortcuts'), C('help.updates'), C('help.about')]
  };
}

async function resolveRecent(ed, items) {
  for (const it of items) {
    if (it.lazyRecent) {
      const recent = await host.recent();
      it.enabled = recent.length > 0;
      it.submenu = [
        ...recent.map(f => ({
          label: f.split(/[\\/]/).pop() + '   ' + f.replace(/[\\/][^\\/]*$/, ''),
          run: () => ed.openPath(f)
        })),
        '-',
        { label: 'Clear recent', run: () => host.clearRecent() }
      ];
    }
  }
  return items;
}

function buildMenubar(ed, commands) {
  const bar = document.getElementById('menubar');
  const names = ['File', 'Edit', 'Object', 'Shape', 'View', 'Mapmaker', 'Help'];
  const open = async (btn, name) => {
    closeMenus();
    btn.classList.add('open');
    openMenu = name;
    const items = await resolveRecent(ed, menuModel(ed, commands)[name]());
    const r = btn.getBoundingClientRect();
    showMenu(items, r.left, r.bottom + 2, { owner: btn });
  };
  for (const name of names) {
    const btn = h('button', { class: 'menu-btn' }, name);
    btn.addEventListener('mousedown', e => { e.stopPropagation(); if (openMenu === name) closeMenus(); else open(btn, name); });
    btn.addEventListener('mouseenter', () => { if (openMenu && openMenu !== name) open(btn, name); });
    bar.append(btn);
  }
  document.addEventListener('mousedown', e => { if (!e.target.closest('.menu')) closeMenus(); });
  window.addEventListener('blur', closeMenus);
  ed.showContextMenu = (x, y) => {
    const C = id => cmdItem(commands, id);
    const model = menuModel(ed, commands);
    const hasSel = ed.state.selection.size > 0;
    const items = hasSel
      ? [
        C('edit.cut'), C('edit.copy'), C('edit.paste'), C('edit.copyStyle'), C('edit.pasteStyle'),
        C('edit.duplicate'), C('edit.delete'), '-',
        ...model.Object().slice(0, 4), '-',
        ...model.Object().slice(5, 7), '-',
        C('obj.saveSymbol'), C('file.screenshotSel'), C('view.zoomSel')
      ]
      : [C('edit.paste'), C('edit.pasteInPlace'), C('edit.selectAll'), '-', C('view.fit'), C('view.outline'), C('view.grid')];
    showMenu(items, x, y);
  };
}

// ------------------------------------------------------------------ toolbar

function buildToolbar(ed) {
  const bar = document.getElementById('toolbar');
  const buttons = {};
  for (const name of TOOL_ORDER) {
    if (name === '|') { bar.append(h('div', { class: 'tool-sep' })); continue; }
    const def = TOOL_DEFS[name];
    const b = h('button', { class: 'tool', html: icon(def.icon), 'data-tip': def.title, 'data-key': def.key || '' });
    b.addEventListener('click', () => ed.setTool(name));
    buttons[name] = b;
    bar.append(b);
  }
  const shot = h('button', { class: 'tool', html: icon('camera'), 'data-tip': 'Screenshot', 'data-key': 'Ctrl+Shift+E' });
  shot.addEventListener('click', () => ed.commands.run('file.screenshot'));
  const sim = h('button', { class: 'tool', html: icon('sim'), 'data-tip': 'Game simulation: foods and NPCs on the map', 'data-key': 'F6' });
  sim.addEventListener('click', () => ed.commands.run('view.sim'));
  ed.on('view-options', () => sim.classList.toggle('active', !!ed.sim?.enabled));
  bar.append(h('div', { class: 'tool-sep' }), sim, shot);
  const sync = () => {
    for (const [name, b] of Object.entries(buttons)) {
      b.classList.toggle('active', ed.state.tool === name);
      b.classList.toggle('unavailable', !toolAllowed(name, ed.state.activeLayer));
    }
  };
  ed.on('tool', sync);
  ed.on('layer', sync);
  ed.on('keymap', () => { for (const [name, b] of Object.entries(buttons)) b.dataset.key = TOOL_DEFS[name].key || ''; });
  sync();
}

// ------------------------------------------------------------------ control bar

function buildControlbar(ed) {
  const bar = document.getElementById('controlbar');
  const render = () => {
    clear(bar);
    const st = ed.state, b = st.brush;
    const def = TOOL_DEFS[st.tool];
    const layer = LAYER_BY_ID[st.activeLayer];
    bar.append(h('span', { class: 'cb-title' }, def.title));
    bar.append(h('span', { class: 'chip', title: 'Active layer' }, h('span', { html: icon('layers') }), layer.title));
    const creating = ['pen', 'rect', 'ellipse', 'polygon'].includes(st.tool);
    if (creating) {
      if (['Ter', 'Bg', 'C', 'Air'].includes(layer.type)) {
        bar.append(h('span', { class: 'cb-sep' }));
        const tex = ed.catalog.textureById.get(b.texture);
        const chip = h(
          'button',
          { class: 'chip', title: 'Texture for new shapes (choose in Assets)' },
          h('img', { src: ed.assets.thumbnail('T', b.texture, 32) || '' }),
          tex?.name || 'Texture'
        );
        chip.addEventListener('click', () => ed.emit('show-assets', 'T'));
        bar.append(chip);
      }
      if (layer.type === 'Bg') {
        bar.append(numberField({
          label: 'Opacity', value: b.opacity, step: 0.05, min: 0, max: 1, digits: 2,
          onCommit: v => { b.opacity = v; }
        }));
      }
      if (layer.type === 'Air') {
        bar.append(h(
          'span',
          { class: 'cb-group' },
          h('span', { class: 'cb-hint' }, 'Border'),
          colorField({ value: b.borderColor, onCommit: v => { b.borderColor = v; } })
        ));
      }
      if (layer.type === 'Sky' || layer.type === 'Wat') {
        const key = layer.type === 'Sky' ? 'skyColors' : 'waterColors';
        bar.append(h('span', { class: 'cb-sep' }), h('span', { class: 'cb-hint' }, 'Gradient'),
          colorField({ value: b[key][0], onCommit: v => { b[key] = [v, b[key][1]]; } }),
          colorField({ value: b[key][1], onCommit: v => { b[key] = [b[key][0], v]; } }));
      }
      if (st.tool === 'pen') {
        bar.append(
          h('span', { class: 'cb-sep' }),
          toggle({
            checked: !!b.curve,
            label: 'Curve',
            title: 'Smooth curve through the clicked points',
            onChange: v => { b.curve = v; ed.emit('brush'); ed.requestRender(); }
          }),
          ...(b.curve
            ? [numberField({
              label: 'Detail', value: b.curveSteps || 6, step: 1, min: 2, max: 24, digits: 0,
              title: 'Points per curve span', onCommit: v => { b.curveSteps = Math.round(v); }
            })]
            : [])
        );
        bar.append(...buildPenSnapControls(ed));
      }
      if (st.tool === 'ellipse') {
        bar.append(
          h('span', { class: 'cb-sep' }),
          numberField({
            label: 'Segments', value: b.segments, step: 1, min: 3, max: 256, digits: 0,
            onCommit: v => { b.segments = Math.round(v); }
          })
        );
      }
      if (st.tool === 'polygon') {
        bar.append(
          h('span', { class: 'cb-sep' }),
          numberField({
            label: 'Sides', value: b.sides, step: 1, min: 3, max: 64, digits: 0,
            onCommit: v => { b.sides = Math.round(v); }
          })
        );
      }
    }
    if (['hide', 'animal', 'prop'].includes(st.tool)) {
      bar.append(h('span', { class: 'cb-sep' }));
      const kind = { hide: 'H', animal: 'A', prop: 'P' }[st.tool];
      const id = kind === 'H' ? b.hSType : kind === 'A' ? b.fLevel : b.pType;
      const name = kind === 'H'
        ? ed.catalog.hideSpaceById.get(id)?.name
        : kind === 'A' ? ed.catalog.animalByLevel.get(id)?.name : ed.catalog.propById.get(id)?.name;
      const chip = h('button', { class: 'chip', title: 'Choose in Assets' }, h('img', { src: ed.assets.thumbnail(kind, id, 32) || '' }), name || '');
      chip.addEventListener('click', () => ed.emit('show-assets', kind));
      bar.append(chip);
    }
    if (st.tool === 'sculpt') bar.append(...buildSculptControls(ed));
    if (st.tool === 'knife') bar.append(...buildKnifeControls(ed));
    if (st.tool === 'scatter') bar.append(...buildScatterControls(ed));
    bar.append(h('span', { class: 'cb-sep' }), h('span', { class: 'cb-hint' }, def.help));
  };
  ed.on('tool', render);
  ed.on('layer', render);
  ed.on('brush', render);
  render();
}

// ------------------------------------------------------------------ status bar

function buildStatusbar(ed) {
  const bar = document.getElementById('statusbar');
  const cursor = h('span', { class: 'mono' }, '-');
  const zoom = h('span', { class: 'mono' }, '100%');
  const selection = h('span', {}, '');
  const objects = h('span', { class: 'mono' }, '0');
  const foodMeter = h('i'), npcMeter = h('i');
  const foodText = h('span', { class: 'mono' }), npcText = h('span', { class: 'mono' });
  const compat = h('span', {}, '');
  const compatDot = h('span', { class: 'dot ok' });
  const zoomBox = h('div', { class: 'st click', title: 'Click: fit world' }, 'Zoom', zoom);
  zoomBox.addEventListener('click', () => ed.fitWorld());
  const compatBox = h('div', { class: 'st click', title: 'Open compatibility checks' }, compatDot, compat);
  compatBox.addEventListener('click', () => ed.emit('show-checks'));
  bar.append(
    h('div', { class: 'st', style: { minWidth: '150px' } }, 'X/Y', cursor),
    zoomBox,
    h('div', { class: 'st grow' }, selection),
    h('div', { class: 'st', title: 'Objects in map' }, 'Objects', objects),
    h('div', { class: 'st', title: 'Food spawn budget: floor(width x height / 12.3)' }, 'Food', h('span', { class: 'meter' }, foodMeter), foodText),
    h('div', { class: 'st', title: 'NPC budget: floor(min(200, width x height / 200))' }, 'NPC', h('span', { class: 'meter' }, npcMeter), npcText),
    compatBox
  );
  const meter = (el, v, max) => {
    const p = max > 0 ? v / max : (v > 0 ? 2 : 0);
    el.style.width = Math.min(100, p * 100) + '%';
    el.className = p > 1 ? 'err' : p > 0.9 ? 'warn' : '';
  };
  const update = () => {
    const z = ed.renderer.view.zoom;
    zoom.textContent = (z * 100 >= 10 ? Math.round(z * 100) : (z * 100).toFixed(1)) + '%';
    const c = ed.state.cursor;
    cursor.textContent = c ? `${fmt(c.x / 10, 2)}, ${fmt(c.y / 10, 2)}` : '-';
    if (ed.state.cursorInfo) cursor.textContent = ed.state.cursorInfo;
  };
  const updateDoc = () => {
    objects.textContent = ed.doc.count();
    const q = ed.quotaInfo();
    meter(foodMeter, q.food, q.foodMax); foodText.textContent = `${q.food}/${q.foodMax}`;
    meter(npcMeter, q.npc, q.npcMax); npcText.textContent = `${q.npc}/${q.npcMax}`;
  };
  const updateSel = () => {
    const sel = ed.selected();
    if (!sel.length) { selection.textContent = 'No selection'; return; }
    const pts = sel.reduce((s, o) => s + (o.points && KIND_BY_TYPE[o.type] === 'poly' ? o.points.length : 0), 0);
    const b = ops.selectionBounds(sel, ed.catalog);
    const kinds = new Set(sel.map(o => o.type));
    const label = sel.length === 1
      ? LAYER_BY_ID[sel[0].layerId].title.replace(/s$/, '')
      : `${sel.length} objects` + (kinds.size === 1 ? '' : ' (mixed)');
    selection.textContent = `${label}   W ${fmt(b.width / 10, 2)}  H ${fmt(b.height / 10, 2)}` + (pts ? `   ${pts} points` : '');
  };
  const updateIssues = () => {
    const s = ed.issueSummary();
    compatDot.className = 'dot ' + (s.error ? 'err' : s.warning ? 'warn' : 'ok');
    compat.textContent = s.error
      ? `${s.error} error${s.error > 1 ? 's' : ''}`
      : s.warning ? `${s.warning} warning${s.warning > 1 ? 's' : ''}` : 'Mapmaker compatible';
  };
  ed.on('view', update);
  ed.on('cursor', update);
  ed.on('rendered', update);
  ed.on('doc', () => { updateDoc(); updateSel(); });
  ed.on('selection', updateSel);
  ed.on('issues', updateIssues);
  updateDoc(); updateSel(); updateIssues(); update();
}

// ------------------------------------------------------------------ rulers

function buildRulers(ed) {
  const hC = document.getElementById('ruler-h'), vC = document.getElementById('ruler-v');
  const stage = document.getElementById('stage');
  const draw = () => {
    stage.style.setProperty('--ruler', ed.state.rulers ? '18px' : '0px');
    if (!ed.state.rulers) return;
    const dpr = window.devicePixelRatio || 1;
    const r = ed.renderer;
    for (const [c, horizontal] of [[hC, true], [vC, false]]) {
      const w = c.clientWidth, hgt = c.clientHeight;
      if (!w || !hgt) continue;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hgt * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hgt * dpr); }
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = '#161a22'; g.fillRect(0, 0, w, hgt);
      // spacing in world units (1 unit = 10 px)
      const unitPx = r.view.zoom * 10;
      const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
      const step = steps.find(s => s * unitPx >= 60) || 1000;
      const len = horizontal ? w : hgt;
      const startWorld = horizontal ? r.toWorld(0, 0).x / 10 : r.toWorld(0, 0).y / 10;
      const endWorld = horizontal ? r.toWorld(len, 0).x / 10 : r.toWorld(0, len).y / 10;
      g.strokeStyle = '#3a4252'; g.fillStyle = '#7d869a';
      g.font = '9.5px ' + getComputedStyle(document.body).getPropertyValue('--mono');
      g.beginPath();
      const minor = step / 5;
      for (let u = Math.floor(startWorld / minor) * minor; u <= endWorld; u += minor) {
        const s = horizontal ? r.toScreen(u * 10, 0).x : r.toScreen(0, u * 10).y;
        const major = Math.abs(u / step - Math.round(u / step)) < 1e-6;
        const t = major ? 18 : 5;
        if (horizontal) { g.moveTo(Math.round(s) + 0.5, hgt); g.lineTo(Math.round(s) + 0.5, hgt - t); }
        else { g.moveTo(w, Math.round(s) + 0.5); g.lineTo(w - t, Math.round(s) + 0.5); }
        if (major) {
          const label = fmt(Math.round(u / step) * step, 2);
          if (horizontal) g.fillText(label, s + 3, 10);
          else { g.save(); g.translate(10, s - 3); g.rotate(-Math.PI / 2); g.fillText(label, 0, 0); g.restore(); }
        }
      }
      g.stroke();
      const c2 = ed.state.cursor;
      if (c2) {
        const s = horizontal ? r.toScreen(c2.x, 0).x : r.toScreen(0, c2.y).y;
        g.strokeStyle = '#3b82f6'; g.beginPath();
        if (horizontal) { g.moveTo(Math.round(s) + 0.5, 0); g.lineTo(Math.round(s) + 0.5, hgt); }
        else { g.moveTo(0, Math.round(s) + 0.5); g.lineTo(w, Math.round(s) + 0.5); }
        g.stroke();
      }
    }
  };
  ed.on('rendered', draw);
  ed.on('view-options', draw);
}

// ------------------------------------------------------------------ navigator

function buildMinimap(ed) {
  const c = document.getElementById('minimap');
  let cache = null, cacheRev = -1, cacheKey = '';
  const size = () => {
    const W = ed.doc.pixelWidth, H = ed.doc.pixelHeight;
    const maxW = 220, maxH = 140;
    const k = Math.min(maxW / W, maxH / H);
    return { w: Math.max(40, Math.round(W * k)), h: Math.max(20, Math.round(H * k)), k };
  };
  const draw = () => {
    c.classList.toggle('hidden', !ed.state.minimap);
    if (!ed.state.minimap) return;
    const dpr = window.devicePixelRatio || 1;
    const { w, h: hh, k } = size();
    if (c.width !== w * dpr) { c.width = w * dpr; c.height = hh * dpr; c.style.width = w + 'px'; c.style.height = hh + 'px'; }
    const tp = !!(ed.state.testerPreview || ed.state.view?.testerPreview);
    const key = w + 'x' + hh + ':' + [...ed.state.visible].join() + ':' + tp;
    if (!cache || cacheRev !== ed.doc.revision || cacheKey !== key) {
      if (!cache) cache = document.createElement('canvas');
      cache.width = w * dpr; cache.height = hh * dpr;
      const RendererClass = ed.renderer.constructor;
      const mr = new RendererClass(cache, { catalog: ed.catalog, assets: ed.assets });
      mr.dpr = dpr; mr.width = w; mr.height = hh;
      mr.view = { cx: ed.doc.pixelWidth / 2, cy: ed.doc.pixelHeight / 2, zoom: k };
      const vis = new Set([...ed.state.visible].filter(id => !LAYER_BY_ID[id].helper));
      mr.renderScene({ doc: ed.doc, visible: vis, layerAlpha: () => 1, outline: false, testerPreview: tp, backdrop: '#0b0e13' });
      cacheRev = ed.doc.revision; cacheKey = key;
    }
    const g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(cache, 0, 0);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const r = ed.renderer;
    const a = r.toWorld(0, 0), b = r.toWorld(r.width, r.height);
    g.strokeStyle = '#5b9bff'; g.lineWidth = 1.5;
    g.fillStyle = 'rgba(59,130,246,0.12)';
    g.fillRect(a.x * k, a.y * k, (b.x - a.x) * k, (b.y - a.y) * k);
    g.strokeRect(a.x * k, a.y * k, (b.x - a.x) * k, (b.y - a.y) * k);
  };
  let pending = 0;
  const schedule = () => { if (!pending) pending = nextFrame(() => { pending = 0; draw(); }); };
  ed.on('rendered', schedule);
  ed.on('view-options', schedule);
  const jump = e => {
    const { k } = size();
    const rect = c.getBoundingClientRect();
    ed.renderer.view.cx = (e.clientX - rect.left) / k;
    ed.renderer.view.cy = (e.clientY - rect.top) / k;
    ed.requestRender(); ed.emit('view');
  };
  c.addEventListener('pointerdown', e => {
    e.stopPropagation();
    c.setPointerCapture(e.pointerId);
    jump(e);
    const move = ev => jump(ev);
    const up = () => { c.removeEventListener('pointermove', move); c.removeEventListener('pointerup', up); };
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
  });
}

// ------------------------------------------------------------------ viewport input

function bindViewport(ed) {
  const vp = ed.viewport;
  vp.tabIndex = 0;
  let spacePan = false, panDrag = null, active = false;
  const ev = e => {
    const rect = vp.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    return {
      sx, sy, w: ed.renderer.toWorld(sx, sy),
      shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey,
      buttons: e.buttons, button: e.button, event: e
    };
  };
  ed.isSpacePan = () => spacePan;
  ed.setSpacePan = v => { spacePan = v; vp.style.cursor = v ? 'grab' : (ed.tool.cursor || 'default'); };

  vp.addEventListener('pointerdown', e => {
    vp.focus({ preventScroll: true });
    closeMenus();
    const x = ev(e);
    if (e.button === 1 || (e.button === 0 && spacePan)) {
      panDrag = { sx: x.sx, sy: x.sy, cx: ed.renderer.view.cx, cy: ed.renderer.view.cy };
      vp.setPointerCapture(e.pointerId);
      vp.style.cursor = 'grabbing';
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    if (ed.pickPoint) {
      const fn = ed.pickPoint;
      ed.pickPoint = null;
      fn(x.w);
      return;
    }
    if (ed.pickRect) {
      vp.setPointerCapture(e.pointerId);
      ed.rectDrag = { a: x.w, b: x.w };
      return;
    }
    if (ed.gradientHandles?.onPointerDown?.(x)) {
      vp.setPointerCapture(e.pointerId);
      ed.requestRender();
      return;
    }
    vp.setPointerCapture(e.pointerId);
    active = true;
    ed.tool.down?.(x);
    ed.requestRender();
  });
  vp.addEventListener('pointermove', e => {
    const x = ev(e);
    ed.state.cursor = x.w;
    if (panDrag) {
      const v = ed.renderer.view;
      v.cx = panDrag.cx - (x.sx - panDrag.sx) / v.zoom;
      v.cy = panDrag.cy - (x.sy - panDrag.sy) / v.zoom;
      ed.requestRender(); ed.emit('view');
      return;
    }
    if (ed.rectDrag) {
      let b = x.w;
      if (e.shiftKey) {
        const a = ed.rectDrag.a;
        const d = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        b = { x: a.x + Math.sign(b.x - a.x || 1) * d, y: a.y + Math.sign(b.y - a.y || 1) * d };
      }
      ed.rectDrag.b = b;
      ed.requestRender();
      return;
    }
    if (!active && ed.gradientHandles?.onPointerMove?.(x)) {
      ed.emit('cursor');
      ed.requestRender();
      return;
    }
    ed.tool.move?.(x);
    ed.emit('cursor');
    if (ed.state.rulers) ed.requestRender();
  });
  const end = e => {
    if (panDrag) { panDrag = null; vp.style.cursor = spacePan ? 'grab' : (ed.tool.cursor || 'default'); return; }
    if (ed.rectDrag) {
      const { a, b } = ed.rectDrag, fn = ed.pickRect;
      ed.rectDrag = null; ed.pickRect = null;
      vp.style.cursor = ed.tool.cursor || 'default';
      ed.requestRender();
      fn({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) });
      return;
    }
    if (!active && ed.gradientHandles?.onPointerUp?.(ev(e))) { ed.requestRender(); return; }
    if (!active) return;
    active = false;
    ed.tool.up?.(ev(e));
    ed.requestRender();
  };
  vp.addEventListener('pointerup', end);
  vp.addEventListener('pointercancel', () => { ed.gradientHandles?.cancel?.(); if (active) { active = false; ed.tool.cancel?.(); } panDrag = null; });
  vp.addEventListener('pointerleave', () => { ed.state.cursor = null; ed.emit('cursor'); });
  vp.addEventListener('dblclick', e => ed.tool.dblclick?.(ev(e)));
  vp.addEventListener('wheel', e => {
    e.preventDefault();
    const x = ev(e);
    if (ed.tool.wheel?.(x, e)) return;
    if (e.ctrlKey || e.altKey) ed.zoomBy(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0018)), { x: x.sx, y: x.sy });
    else {
      const v = ed.renderer.view;
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX, dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      v.cx += dx / v.zoom; v.cy += dy / v.zoom;
      ed.requestRender(); ed.emit('view');
    }
  }, { passive: false });
  vp.addEventListener('contextmenu', e => {
    e.preventDefault();
    const x = ev(e);
    if (!ed.state.selection.size) { const o = ed.hitTest(x.w); if (o) ed.select([o]); }
    ed.showContextMenu(e.clientX, e.clientY);
  });

  // file drop
  vp.addEventListener('dragover', e => { if ([...e.dataTransfer.items].some(i => i.kind === 'file')) { e.preventDefault(); vp.classList.add('drop'); } });
  vp.addEventListener('dragleave', () => vp.classList.remove('drop'));
  vp.addEventListener('drop', async e => {
    e.preventDefault();
    vp.classList.remove('drop');
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (/^image\//.test(f.type)) { ed.meta.loadReferenceFile(f); return; }
    const dropPath = window.mmpHost?.pathForFile?.(f) || null;
    if (dropPath && host.kind === 'electron') { await ed.openPath(dropPath); return; }
    if (!(await ed.confirmDiscard())) return;
    ed.loadText(await f.text(), { name: f.name, path: dropPath });
  });
}

// ------------------------------------------------------------------ keyboard

function bindKeyboard(ed, commands) {
  const typing = e => e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]');
  window.addEventListener('keydown', e => {
    if (typing(e)) return;
    if (document.querySelector('.modal-backdrop')) return;
    if (e.key === ' ') { if (!e.repeat) ed.setSpacePan(true); e.preventDefault(); return; }
    if (ed.tool.key?.(e)) { e.preventDefault(); return; }
    if (ed.gradientHandles?.onKeyDown?.(e)) { e.preventDefault(); return; }
    if (e.key === 'Escape') {
      closeMenus();
      if (ed.pickPoint) { ed.pickPoint = null; ed.toast('Position pick cancelled'); }
      else if (ed.pickRect) { ed.pickRect = null; ed.rectDrag = null; ed.requestRender(); ed.toast('Region capture cancelled'); }
      else if (ed.tool.drag || ed.tool.marquee || ed.tool.start || ed.tool.draft) ed.tool.cancel?.();
      else if (ed.drawInside?.active) ed.drawInside.exit();
      else if (ed.state.points.size) { ed.state.points.clear(); ed.emit('selection'); ed.requestRender(); }
      else ed.deselect();
      return;
    }
    const k = keyString(e);
    const cmd = commands.byKey.get(k);
    if (cmd) { e.preventDefault(); if (!cmd.enabled || cmd.enabled()) cmd.run(); return; }
    if (!e.ctrlKey && !e.altKey && !e.metaKey) {
      const tool = Object.entries(TOOL_DEFS).find(([, d]) => d.key && d.key === k);
      if (tool) { ed.setTool(tool[0]); e.preventDefault(); return; }
    }
    if (e.key.startsWith('Arrow') && ed.state.selection.size) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      if (ed.state.tool === 'point' && ed.state.points.size) {
        ed.edit('Nudge points', () => {
          for (const [uid, set] of ed.state.points) {
            const o = ed.doc.get(uid);
            if (!o || KIND_BY_TYPE[o.type] !== 'poly') continue;
            ed.doc.touch(o);
            for (const i of set) { o.points[i].x += dx; o.points[i].y += dy; }
          }
        });
      } else ed.edit('Nudge', () => ops.translate(ed.doc, ed.selected(), dx, dy));
    }
  });
  window.addEventListener('keyup', e => { if (e.key === ' ') ed.setSpacePan(false); });
  window.addEventListener('blur', () => ed.setSpacePan(false));
}

// ------------------------------------------------------------------ misc

function bindTooltips() {
  let tip = null, timer = 0;
  document.addEventListener('mouseover', e => {
    const t = e.target.closest('[data-tip]');
    clearTimeout(timer);
    tip?.remove(); tip = null;
    if (!t) return;
    timer = setTimeout(() => {
      tip = h('div', { class: 'tip' }, t.dataset.tip, t.dataset.key ? h('kbd', {}, t.dataset.key) : null);
      document.body.append(tip);
      const r = t.getBoundingClientRect();
      const left = t.closest('#toolbar') ? r.right + 8 : r.left;
      const top = t.closest('#toolbar') ? r.top + 4 : r.bottom + 6;
      tip.style.left = Math.min(left, window.innerWidth - tip.offsetWidth - 6) + 'px';
      tip.style.top = Math.min(top, window.innerHeight - tip.offsetHeight - 6) + 'px';
    }, 450);
  });
  document.addEventListener('mousedown', () => { clearTimeout(timer); tip?.remove(); tip = null; });
}

function bindSplitter() {
  const sp = document.getElementById('dock-splitter');
  const dock = document.getElementById('dock');
  // Dock width: drag the dock's left edge (260-640 px), remembered per computer.
  const ws = document.getElementById('workspace');
  const setWidth = w => ws.style.setProperty('--dock-w', Math.round(Math.min(640, Math.max(260, w))) + 'px');
  try { const saved = Number(localStorage.getItem('mmp:dock-w')); if (saved) setWidth(saved); } catch { /* storage blocked */ }
  const edge = h('div', { id: 'dock-resize', title: 'Drag to resize the panel' });
  dock.append(edge);
  edge.addEventListener('pointerdown', e => {
    edge.setPointerCapture(e.pointerId);
    edge.classList.add('active');
    const move = ev => setWidth(window.innerWidth - ev.clientX);
    const up = () => {
      edge.removeEventListener('pointermove', move); edge.removeEventListener('pointerup', up);
      edge.classList.remove('active');
      try { localStorage.setItem('mmp:dock-w', String(dock.getBoundingClientRect().width)); } catch { /* storage blocked */ }
    };
    edge.addEventListener('pointermove', move);
    edge.addEventListener('pointerup', up);
  });
  edge.addEventListener('dblclick', () => { setWidth(316); try { localStorage.removeItem('mmp:dock-w'); } catch { /* blocked */ } });
  sp.addEventListener('pointerdown', e => {
    sp.setPointerCapture(e.pointerId);
    const move = ev => {
      const r = dock.getBoundingClientRect();
      const p = Math.min(85, Math.max(18, (ev.clientY - r.top) / r.height * 100));
      dock.style.setProperty('--dock-top', p + '%');
    };
    const up = () => { sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); };
    sp.addEventListener('pointermove', move);
    sp.addEventListener('pointerup', up);
  });
}

function bindTitle(ed) {
  const el = document.getElementById('doc-title');
  const update = () => {
    clear(el);
    el.append(ed.state.file.name, ed.state.dirty ? h('span', { class: 'dirty' }, ' - edited') : '');
    el.title = ed.state.file.path || '';
  };
  ed.on('file', update);
  ed.on('doc', update);
  update();
}
