// Dock panels: Properties, Assets, Library (top) and Layers, Checks (bottom).

import {
  LAYERS, LAYER_BY_ID, KIND_BY_TYPE, HABITAT_AREAS, HABITAT_GROUPS,
  NPC_TYPES, TRIGGER_WHEN, TRIGGER_ACTIONS, MAX_CURRENT, TEXTURED_TYPES
} from '../engine/layers.js';
import { intToHex, hexToInt, signedArea, perimeter } from '../engine/geometry.js';
import { foodBoxCap, foodBudget, npcBudget, totalFood, totalNpc } from '../engine/dpm.js';
import { habitatColor, habitatLabel } from '../engine/render.js';
import { NPC_HIDDEN_LEVELS } from '../engine/validate.js';
import { clone } from '../engine/document.js';
import * as ops from '../engine/ops.js';
import { icon } from './icons.js';
import { h, clear, fmt, numberField, colorField, select, toggle, nextFrame } from './dom.js';
import { host } from './host.js';
import * as dialogs from './dialogs.js';
import { createLayerScrubber, syncLayerVisibility } from './inspector.js';
import { contourPropertiesSection } from './contour-snap.js';
import { buildSelectionColorsSection, buildBgDepthSection } from './palette-studio.js';
import { buildBevelSection } from './knife-tool.js';
import { buildScatterPropertiesSection, toggleScatterAsset } from './scatter-tool.js';

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

export function buildPanels(ed) {
  const top = tabbed(document.getElementById('dock-top'), [
    { id: 'props', title: 'Properties' },
    { id: 'assets', title: 'Assets' },
    { id: 'library', title: 'Library' }
  ]);
  const bottom = tabbed(document.getElementById('dock-bottom'), [
    { id: 'layers', title: 'Layers' },
    { id: 'checks', title: 'Checks' },
    { id: 'history', title: 'History' }
  ]);
  propertiesPanel(ed, top.body('props'));
  const assets = assetsPanel(ed, top.body('assets'));
  libraryPanel(ed, top.body('library'));
  layersPanel(ed, bottom.body('layers'));
  checksPanel(ed, bottom.body('checks'), bottom.tab('checks'));
  historyPanel(ed, bottom.body('history'));
  ed.on('show-checks', () => bottom.show('checks'));
  ed.on('show-assets', kind => { top.show('assets'); assets.setKind(kind); });
}

function tabbed(root, tabs) {
  const head = h('div', { class: 'tabs' });
  const bodies = {}, buttons = {};
  for (const t of tabs) {
    const b = h('button', { class: 'tab' }, t.title);
    b.addEventListener('click', () => show(t.id));
    buttons[t.id] = b;
    head.append(b);
    bodies[t.id] = h('div', { class: 'pane-body', style: { display: 'none' } });
  }
  root.append(head, ...Object.values(bodies));
  const show = id => {
    for (const t of tabs) {
      buttons[t.id].classList.toggle('active', t.id === id);
      bodies[t.id].style.display = t.id === id ? '' : 'none';
    }
  };
  show(tabs[0].id);
  return { body: id => bodies[id], tab: id => buttons[id], show };
}

function section(title, aside, ...content) {
  const head = h('div', { class: 'section-title' },
    h('span', {}, title),
    aside ? h('span', { class: 'aside' }, aside) : null);
  return h('div', { class: 'section' }, head, ...content);
}

function row(label, ...content) {
  return h('div', { class: 'row' }, label ? h('span', { class: 'k' }, label) : null, ...content);
}

// ------------------------------------------------------------------ properties

export function collectMapPalette(doc) {
  const counts = new Map();
  const add = c => {
    if (c == null) return;
    const hex = intToHex(hexToInt(c));
    counts.set(hex, (counts.get(hex) || 0) + 1);
  };
  for (const o of doc.objects()) {
    if (o.type === 'Sky' || o.type === 'Wat') {
      for (const c of o.colors || []) add(c);
    } else if (o.type === 'Air') {
      add(o.borderColor ?? 0);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([hex, count]) => ({ hex, count }));
}

function mapPaletteSection(ed, target, uiState) {
  const colors = collectMapPalette(ed.doc);
  if (!colors.length && !target) return null;
  const labelText = () => target ? 'apply to ' + target.label() : `${colors.length} colour${colors.length === 1 ? '' : 's'}`;
  const sec = section('Map palette', labelText());
  const aside = sec.querySelector('.aside');
  uiState.onStopChange = () => { if (aside) aside.textContent = labelText(); };
  if (!colors.length) {
    sec.append(h('p', { class: 'muted', style: { margin: 0 } }, 'No sky, water or air pocket colours in this map yet.'));
    return sec;
  }
  const strip = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px', maxHeight: '88px', overflowY: 'auto' } });
  for (const { hex, count } of colors) {
    const tip = target ? `Apply ${hex} (${count}x in map)` : `Copy ${hex} (${count}x in map)`;
    const sw = h('button', {
      type: 'button',
      title: tip,
      style: {
        width: '18px', height: '18px', padding: '0', borderRadius: '3px',
        border: '1px solid rgba(255,255,255,0.18)', background: hex, flex: 'none'
      }
    });
    sw.addEventListener('click', () => {
      if (target) target.apply(hex);
      else {
        navigator.clipboard?.writeText(hex).catch(() => {});
        ed.toast(`Copied ${hex}`);
      }
    });
    strip.append(sw);
  }
  sec.append(strip);
  return sec;
}

function propertiesPanel(ed, el) {
  let stale = false;
  const uiState = {
    stop: 0,
    onStopChange: null,
    setStop(i) {
      this.stop = i;
      this.onStopChange?.();
    }
  };
  const render = () => {
    stale = false;
    uiState.onStopChange = null;
    const scroll = el.scrollTop;
    clear(el);
    const sel = ed.selected();
    if (!sel.length) renderDocument(ed, el, uiState);
    else renderSelection(ed, el, sel, uiState);
    el.scrollTop = scroll;
  };
  const maybe = () => { if (el.contains(document.activeElement)) stale = true; else render(); };
  el.addEventListener('focusout', () => setTimeout(() => { if (stale && !el.contains(document.activeElement)) render(); }, 0));
  ed.on('selection', render);
  ed.on('meta', maybe);
  ed.on('tool', () => { if (!ed.state.selection.size || ed.selected().some(o => KIND_BY_TYPE[o.type] === 'poly')) maybe(); });
  ed.on('doc', maybe);
  ed.on('layer', () => { if (!ed.state.selection.size) render(); });
  ed.on('brush', () => { if (!ed.state.selection.size) render(); });
  ed.on('scatter', () => { if (!ed.state.selection.size && ed.state.tool === 'scatter') maybe(); });
  render();
}

function renderDocument(ed, el, uiState) {
  const d = ed.doc;
  const q = ed.quotaInfo();
  el.append(section('Map', null,
    h('div', { class: 'grid2' },
      numberField({
        label: 'W', value: d.worldSize.width, digits: 2, min: 1, title: 'World width (units)',
        onCommit: v => ed.edit('World width', () => d.setWorld({ width: v, height: d.worldSize.height }))
      }),
      numberField({
        label: 'H', value: d.worldSize.height, digits: 2, min: 1, title: 'World height (units)',
        onCommit: v => ed.edit('World height', () => d.setWorld({ width: d.worldSize.width, height: v }))
      })),
    h('div', { class: 'grid2' },
      numberField({
        label: 'Gravity', value: Number(d.settings.gravity), digits: 2, step: 0.1,
        onCommit: v => ed.edit('Gravity', () => d.setWorld(null, { gravity: v }))
      }),
      h('div', { class: 'v', style: { alignSelf: 'center', textAlign: 'right' } }, `${fmt(d.pixelWidth, 0)} x ${fmt(d.pixelHeight, 0)} px`)),
    row('Objects', h('span', { class: 'v' }, String(d.count()))),
    row('Food budget', h('span', { class: 'v' }, `${q.food} / ${q.foodMax}`)),
    row('NPC budget', h('span', { class: 'v' }, `${q.npc} / ${q.npcMax}`))));

  const layer = LAYER_BY_ID[ed.state.activeLayer];
  const b = ed.state.brush;
  const brush = [];
  let paletteTarget = null;
  if (TEXTURED_TYPES.has(layer.type)) brush.push(row('Texture'), texturePicker(ed, b.texture, id => { b.texture = id; ed.emit('brush'); }));
  if (layer.type === 'Bg') brush.push(opacityRow(b.opacity, v => { b.opacity = v; ed.emit('brush'); }));
  if (layer.type === 'Air') {
    brush.push(row('Border', colorField({ value: b.borderColor, onCommit: v => { b.borderColor = v; ed.emit('brush'); } })));
    paletteTarget = { label: () => 'brush border', apply: hex => { b.borderColor = hex; ed.emit('brush'); } };
  }
  if (layer.type === 'Sky' || layer.type === 'Wat') {
    const key = layer.type === 'Sky' ? 'skyColors' : 'waterColors';
    uiState.stop = Math.max(0, Math.min(uiState.stop, 1));
    brush.push(row('Gradient',
      colorField({ value: b[key][0], onFocusField: () => uiState.setStop(0), onCommit: v => { b[key] = [v, b[key][1]]; ed.emit('brush'); } }),
      colorField({ value: b[key][1], onFocusField: () => uiState.setStop(1), onCommit: v => { b[key] = [b[key][0], v]; ed.emit('brush'); } })));
    if (layer.type === 'Wat') brush.push(row('', toggle({ checked: b.hasBorder, label: 'Surface border', onChange: v => { b.hasBorder = v; } })));
    paletteTarget = {
      label: () => 'brush stop ' + (Math.max(0, Math.min(uiState.stop, 1)) + 1),
      apply: hex => {
        const idx = Math.max(0, Math.min(uiState.stop, 1));
        b[key] = idx === 0 ? [hex, b[key][1]] : [b[key][0], hex];
        ed.emit('brush');
      }
    };
  }
  el.append(section('Active layer', layer.title,
    h('p', { class: 'muted', style: { margin: '0 0 8px' } }, layer.description || layerHint(layer)),
    ...brush,
    brush.length ? h('p', { class: 'muted', style: { margin: '8px 0 0' } }, 'These settings apply to new shapes drawn on this layer.') : null));

  const pal = mapPaletteSection(ed, paletteTarget, uiState);
  if (pal) el.append(pal);
  el.append(referenceSection(ed));
  const scatterSec = buildScatterPropertiesSection(ed);
  if (scatterSec) el.append(scatterSec);
  el.append(h('div', { class: 'empty' }, h('strong', {}, 'Nothing selected'), 'Click an object, drag a marquee, or choose a drawing tool. Press F1 for shortcuts.'));
}

function layerHint(layer) {
  if (layer.id === 'water') return 'Gradient water bodies. Colour does not set habitat; use the Habitats layer for that.';
  if (layer.id === 'sky') return 'Gradient background shapes drawn behind everything.';
  if (layer.id === 'hide-spaces') return 'Decor and hiding sprites from the official asset packs.';
  if (layer.id === 'props') return 'Parametric objects such as message boards.';
  if (layer.id === 'background-terrains') return 'Textured background rock with opacity.';
  if (layer.id === 'npc-spawns') return 'Areas that spawn NPC animals.';
  if (layer.id === 'food-spawns') return 'Areas that spawn food.';
  return '';
}

function opacityRow(value, commit) {
  const range = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value });
  const num = numberField({ label: '', value, step: 0.05, min: 0, max: 1, digits: 2, onCommit: commit });
  num.style.flex = '0 0 72px';
  range.addEventListener('change', () => commit(Number(range.value)));
  return row('Opacity', range, num);
}

function texturePicker(ed, current, onPick, mixed = false) {
  const grid = h('div', { class: 'swatches' });
  for (const t of ed.catalog.textures) {
    const sw = h('button', {
      class: 'swatch' + (!mixed && t.id === current ? ' on' : ''),
      title: `${t.name} (${t.id})`,
      style: { backgroundImage: `url(${ed.assets.thumbnail('T', t.id, 44) || ''})` }
    }, h('span', { class: 'cap' }, t.name));
    sw.addEventListener('click', () => onPick(t.id));
    grid.append(sw);
  }
  return grid;
}

function common(objs, get) {
  const v0 = JSON.stringify(get(objs[0]));
  return objs.every(o => JSON.stringify(get(o)) === v0) ? get(objs[0]) : undefined;
}

function renderSelection(ed, el, sel, uiState) {
  const apply = (label, fn) => ed.edit(label, () => sel.forEach(o => { ed.doc.touch(o); fn(o); }));
  const types = new Set(sel.map(o => o.type));
  const layers = new Set(sel.map(o => o.layerId));
  const one = sel.length === 1 ? sel[0] : null;
  const title = one
    ? (ed.meta.name(one) || `${SINGULAR[one.layerId]} ${ed.doc.layers[one.layerId].indexOf(one) + 1}`)
    : `${sel.length} objects`;
  const subtitle = layers.size === 1 ? LAYER_BY_ID[sel[0].layerId].title : 'Mixed layers';

  // header + terrain layer switch
  const head = section(title, subtitle);
  if (types.size === 1 && sel[0].type === 'Ter') {
    const seg = h('div', { class: 'seg' });
    for (const id of ['terrains', 'islands', 'platforms']) {
      const b = h('button', { class: layers.size === 1 && layers.has(id) ? 'on' : '' }, LAYER_BY_ID[id].title);
      b.addEventListener('click', () => ed.edit('Move to ' + LAYER_BY_ID[id].title, () => sel.forEach(o => ops.moveTerrainLayer(ed.doc, o, id))));
      seg.append(b);
    }
    head.append(row('Layer', seg));
  }
  el.append(head);

  // transform
  const b = ops.selectionBounds(sel, ed.catalog);
  const spritesOnly = sel.every(o => KIND_BY_TYPE[o.type] === 'sprite');
  const moveTo = (x, y) => ed.edit('Move', () => ops.translate(ed.doc, sel, x - b.x, y - b.y));
  const resize = (w, hh) => ed.edit('Resize', () => ops.scale(ed.doc, sel, b.width ? w / b.width : 1, b.height ? hh / b.height : 1, { x: b.x, y: b.y }));
  const tr = section('Transform', 'units');
  tr.append(h('div', { class: 'grid2' },
    numberField({ label: 'X', value: b.x / 10, digits: 3, step: 0.1, onCommit: v => moveTo(v * 10, b.y) }),
    numberField({ label: 'Y', value: b.y / 10, digits: 3, step: 0.1, onCommit: v => moveTo(b.x, v * 10) })));
  if (!(spritesOnly && sel.length === 1)) {
    tr.append(h('div', { class: 'grid2' },
      numberField({ label: 'W', value: b.width / 10, digits: 3, step: 0.1, min: 0.001, onCommit: v => resize(v * 10, b.height) }),
      numberField({ label: 'H', value: b.height / 10, digits: 3, step: 0.1, min: 0.001, onCommit: v => resize(b.width, v * 10) })));
  }
  if (one && KIND_BY_TYPE[one.type] === 'sprite') {
    tr.append(h('div', { class: 'grid2' },
      numberField({
        label: 'Angle', value: one.rotation || 0, digits: 2, step: 1, suffix: 'deg',
        onCommit: v => apply('Rotate', o => { o.rotation = ops.normalizeAngle(v); })
      }),
      numberField({
        label: 'Origin', value: one.x / 10, digits: 3, step: 0.1, title: 'Sprite anchor X',
        onCommit: v => apply('Move', o => { o.x = v * 10; })
      })));
  } else if (sel.some(o => KIND_BY_TYPE[o.type] !== 'rect')) {
    tr.append(h('div', { class: 'row' }, numberField({
      label: 'Rotate by', value: 0, digits: 2, step: 15, suffix: 'deg',
      onCommit: v => { if (v) ed.edit('Rotate', () => ops.rotate(ed.doc, sel, v, ops.pivotOf(sel, ed.catalog))); }
    })));
  }
  const btn = (ic, tip, id) => {
    const x = h('button', { class: 'btn icon flat', html: icon(ic), 'data-tip': tip });
    x.addEventListener('click', () => ed.commands.run(id));
    return x;
  };
  tr.append(h('div', { class: 'btn-row' },
    btn('rotCCW', 'Rotate 90 deg counter-clockwise', 'obj.rotCCW'), btn('rotCW', 'Rotate 90 deg clockwise', 'obj.rotCW'),
    btn('flipH', 'Flip horizontal (Shift+H)', 'obj.flipH'), btn('flipV', 'Flip vertical (Shift+V)', 'obj.flipV'),
    btn('front', 'Bring to front', 'obj.front'), btn('back', 'Send to back', 'obj.back')));
  if (sel.length > 1) {
    tr.append(h('div', { class: 'btn-row', style: { marginTop: '6px' } },
      btn('alignL', 'Align left', 'obj.alignL'), btn('alignHC', 'Align centres', 'obj.alignHC'),
      btn('alignR', 'Align right', 'obj.alignR'), btn('alignT', 'Align top', 'obj.alignT'),
      btn('alignVC', 'Align middles', 'obj.alignVC'), btn('alignB', 'Align bottom', 'obj.alignB'),
      btn('distH', 'Distribute horizontally', 'obj.distH'), btn('distV', 'Distribute vertically', 'obj.distV')));
  }
  el.append(tr);

  // geometry
  const polys = sel.filter(o => KIND_BY_TYPE[o.type] === 'poly');
  if (polys.length) {
    const pts = polys.reduce((s, o) => s + o.points.length, 0);
    const area = polys.reduce((s, o) => s + Math.abs(signedArea(o.points)), 0) / 100;
    const per = polys.reduce((s, o) => s + perimeter(o.points), 0) / 10;
    const simp = h('button', { class: 'btn small' }, h('span', { html: icon('simplify') }), 'Simplify...');
    simp.addEventListener('click', () => ed.commands.run('obj.simplify'));
    el.append(section('Geometry', null,
      row('Points', h('span', { class: 'v' }, String(pts)), h('span', { style: { flex: 1 } }), simp),
      row('Area', h('span', { class: 'v' }, fmt(area, 2) + ' u2')),
      row('Perimeter', h('span', { class: 'v' }, fmt(per, 2) + ' u'))));
  }

  const contourSec = contourPropertiesSection(ed, sel);
  if (contourSec) el.append(contourSec);
  const bevelSec = buildBevelSection(ed);
  if (bevelSec) el.append(bevelSec);
  const selColors = buildSelectionColorsSection(ed, sel);
  if (selColors) el.append(selColors);
  const scatterSec = buildScatterPropertiesSection(ed);
  if (scatterSec) el.append(scatterSec);

  if (types.size !== 1) {
    el.append(h('div', { class: 'empty' }, 'Select objects of one type to edit their settings together.'));
    return;
  }
  const type = sel[0].type;
  const content = typeSections(ed, type, sel, apply, uiState);
  for (const s of content) if (s) el.append(s);
}

function typeSections(ed, type, sel, apply, uiState) {
  const out = [];
  if (TEXTURED_TYPES.has(type)) {
    const t = common(sel, o => o.texture);
    out.push(section('Texture', t != null ? ed.catalog.textureById.get(t)?.name : 'mixed',
      texturePicker(ed, t, id => { apply('Texture', o => { o.texture = id; }); ed.state.brush.texture = id; }, t == null)));
  }
  if (type === 'Bg') {
    const v = common(sel, o => o.opacity);
    out.push(section('Appearance', null,
      opacityRow(v ?? 0.9, val => apply('Opacity', o => { o.opacity = val; })),
      h('p', { class: 'muted', style: { margin: '6px 0 0' } },
        'Higher opacity draws on top inside this layer (the engine sorts background terrain by opacity).')));
    const bgDepth = buildBgDepthSection(ed, sel);
    if (bgDepth) out.push(bgDepth);
  }
  if (type === 'Air') {
    const v = common(sel, o => o.borderColor);
    out.push(section('Appearance', null, row('Border', colorField({
      value: intToHex(v ?? 0x003a62),
      onCommit: c => apply('Border colour', o => { o.borderColor = hexToInt(c); })
    }))));
    out.push(mapPaletteSection(ed, {
      label: () => 'border',
      apply: hex => apply('Border colour', o => { o.borderColor = hexToInt(hex); })
    }, uiState));
  }
  if (type === 'Sky' || type === 'Wat') {
    out.push(gradientSection(ed, sel, apply, type, uiState));
    const colors = common(sel, o => o.colors);
    if (colors?.length) {
      out.push(mapPaletteSection(ed, {
        label: () => 'stop ' + (Math.max(0, Math.min(uiState.stop, colors.length - 1)) + 1),
        apply: hex => {
          const c = hexToInt(hex);
          apply('Gradient colour', o => {
            if (!o.colors?.length) return;
            const idx = Math.max(0, Math.min(uiState.stop, o.colors.length - 1));
            o.colors = o.colors.map((x, j) => j === idx ? c : x);
          });
        }
      }, uiState));
    }
  }
  if (type === 'Ter' && sel.every(o => o.layerId === 'terrains')) out.push(terrainFoodSection(ed, sel, apply));
  if (type === 'Cu') out.push(currentSection(sel, apply));
  if (type === 'Hab') out.push(habitatSection(ed, sel, apply));
  if (type === 'Food') out.push(foodSection(ed, sel, apply));
  if (type === 'NPC') out.push(npcSection(ed, sel, apply));
  if (type === 'Tr' && sel.length === 1) out.push(triggerSection(ed, sel[0], apply));
  if (type === 'H') {
    const v = common(sel, o => o.hSType);
    const hs = v != null ? ed.catalog.hideSpaceById.get(v) : null;
    const o = common(sel, x => x.opacity);
    const flags = hs ? [
      hs.canHide ? 'Can hide' : null,
      hs.collidable ? 'Collidable' : null,
      hs.climbable ? 'Climbable' : null,
      hs.above ? 'Drawn above animals' : null
    ].filter(Boolean).join(' / ') || 'Decor only' : null;
    out.push(section('Hide space', hs ? hs.packName : 'mixed',
      assetChip(ed, 'H', v, hs?.name || 'Mixed types'),
      opacityRow(o ?? 1, val => apply('Opacity', x => { x.opacity = val; })),
      flags ? h('p', { class: 'muted', style: { margin: '6px 0 0' } }, flags) : null));
  }
  if (type === 'A') {
    const v = common(sel, o => o.fLevel);
    const a = v != null ? ed.catalog.animalByLevel.get(v) : null;
    out.push(section('Preview animal', 'editor only', assetChip(ed, 'A', v, a ? `${a.name} (level ${a.level})` : 'Mixed'),
      h('p', { class: 'muted', style: { margin: '6px 0 0' } }, 'Preview animals are never visible in game; use them to judge scale.')));
  }
  if (type === 'P') {
    const v = common(sel, o => o.pType);
    const p = v != null ? ed.catalog.propById.get(v) : null;
    const s = section('Prop', null, assetChip(ed, 'P', v, p?.name || 'Mixed'));
    if (p?.params?.some(x => x.key === 'text') && sel.length === 1) {
      const ta = h('textarea', {}, sel[0].params?.text ?? '');
      ta.addEventListener('change', () => apply('Prop text', o => { o.params = { ...(o.params || {}), text: ta.value }; }));
      ta.addEventListener('keydown', e => e.stopPropagation());
      s.append(row('Text'), ta);
    }
    out.push(s);
  }
  return out;
}

function assetChip(ed, kind, id, name) {
  const b = h('button', { class: 'chip', style: { width: '100%', height: '34px', marginBottom: '8px' }, title: 'Pick a replacement in Assets' },
    h('img', { src: (id != null && ed.assets.thumbnail(kind, id, 32)) || '', style: { width: '26px', height: '26px' } }),
    h('span', { style: { flex: 1, textAlign: 'left' } }, name),
    h('span', { class: 'muted' }, 'Replace...'));
  b.addEventListener('click', () => ed.emit('show-assets', kind));
  return b;
}

function gradientSection(ed, sel, apply, type, uiState) {
  const colors = common(sel, o => o.colors);
  const s = section(type === 'Sky' ? 'Sky gradient' : 'Water gradient', colors ? `${colors.length} stops` : 'mixed');
  if (!colors) {
    const b = h('button', { class: 'btn small' }, 'Use first object\'s gradient for all');
    b.addEventListener('click', () => { const c = [...sel[0].colors]; apply('Gradient', o => { o.colors = [...c]; }); });
    s.append(b);
    return s;
  }
  uiState.stop = Math.max(0, Math.min(uiState.stop, Math.max(0, colors.length - 1)));
  const hexes = colors.map(intToHex);
  s.append(h('div', { class: 'gradient-preview', style: { background: `linear-gradient(${hexes.join(', ')})` } }));
  const stops = h('div', { class: 'stops' });
  hexes.forEach((hex, i) => {
    const text = h('input', { type: 'text', class: 'text hex', value: hex, spellcheck: 'false' });
    text.addEventListener('keydown', e => e.stopPropagation());
    text.addEventListener('focus', () => uiState.setStop(i));
    const set = v => { const c = hexToInt(v); apply('Gradient colour', o => { o.colors = o.colors.map((x, j) => j === i ? c : x); }); };
    text.addEventListener('change', () => {
      if (/^#?[0-9a-f]{6}$/i.test(text.value.trim())) set(text.value.trim().replace(/^#?/, '#'));
    });
    const rm = h('button', { class: 'btn icon flat small', html: icon('minus'), 'data-tip': 'Remove stop', disabled: colors.length <= 2 });
    rm.addEventListener('click', () => apply('Remove stop', o => { o.colors = o.colors.filter((_, j) => j !== i); }));
    stops.append(h('div', { class: 'stop' },
      h('span', { class: 'muted', style: { width: '18px' } }, String(i + 1)),
      colorField({ value: hex, onFocusField: () => uiState.setStop(i), onCommit: set }),
      text, rm));
  });
  s.append(stops);
  const add = h('button', { class: 'btn small' }, h('span', { html: icon('plus') }), 'Add stop');
  add.addEventListener('click', () => apply('Add stop', o => { o.colors = [...o.colors, o.colors.at(-1)]; }));
  const rev = h('button', { class: 'btn small' }, h('span', { html: icon('swap') }), 'Reverse');
  rev.addEventListener('click', () => apply('Reverse gradient', o => { o.colors = [...o.colors].reverse(); }));
  const solid = h('button', { class: 'btn small', 'data-tip': 'Use the first colour twice' }, 'Solid');
  solid.addEventListener('click', () => apply('Solid colour', o => { o.colors = [o.colors[0], o.colors[0]]; }));
  s.append(h('div', { class: 'btn-row', style: { marginTop: '8px' } }, add, rev, solid));
  if (type === 'Sky') {
    const bake = h('button', { class: 'btn small', 'data-tip': 'Slice Sky gradient into tester-safe 2-stop bands' }, 'Bake to 2-stop bands...');
    bake.addEventListener('click', async () => {
      const opts = await dialogs.bakeGradientDialog(sel);
      if (!opts) return;
      const res = ed.edit('Bake Sky gradient', () => ops.bakeSkySelection(ed.doc, sel, opts));
      if (res?.created?.length) {
        ed.select(res.created);
        if (res.created.length > 1) ed.meta.group(res.created);
        ed.toast(`Baked into ${res.created.length} Sky bands`, 'ok');
      } else if (res?.errors?.length) {
        ed.toast(res.errors[0], 'err');
      }
    });
    s.append(h('div', { class: 'btn-row', style: { marginTop: '6px' } }, bake));
  }
  if (colors.length > 2) {
    s.append(h('p', { class: 'muted', style: { margin: '8px 0 0', color: 'var(--warn)' } },
      'The community map tester draws only the first two stops.'));
  }
  if (type === 'Wat') {
    const hb = common(sel, o => o.hasBorder);
    s.append(h('div', { class: 'row', style: { marginTop: '8px' } }, toggle({
      checked: !!hb,
      label: 'Surface border (lighter line on top edges)',
      onChange: v => apply('Water border', o => { o.hasBorder = v; })
    })));
  }
  return s;
}

function foodPicker(ed, ids, onChange) {
  const grid = h('div', { class: 'swatches' });
  for (const f of ed.catalog.foods) {
    const on = ids.map(Number).includes(f.id);
    const sw = h('button', {
      class: 'swatch' + (on ? ' on' : ''),
      title: `${f.name} (${f.xp} xp, id ${f.id})`,
      style: { backgroundImage: `url(${ed.assets.thumbnail('F', f.id, 44) || ''})`, backgroundSize: '70%', imageRendering: 'auto' }
    }, h('span', { class: 'cap' }, f.name));
    sw.addEventListener('click', () => onChange(on ? ids.filter(x => Number(x) !== f.id) : [...ids, f.id]));
    grid.append(sw);
  }
  return grid;
}

function spawnTimingRows(s, apply, key) {
  return h('div', { class: 'grid2' },
    numberField({
      label: 'First', value: Number(s.firstSpawnMs) || 0, digits: 0, step: 100, min: 0, suffix: 'ms',
      title: 'Delay before the first spawn',
      onCommit: v => apply('Spawn timing', o => { o[key].firstSpawnMs = v; })
    }),
    numberField({
      label: 'Respawn', value: Number(s.reSpawnMs) || 0, digits: 0, step: 100, min: 0, suffix: 'ms',
      title: 'Delay before respawning',
      onCommit: v => apply('Spawn timing', o => { o[key].reSpawnMs = v; })
    }));
}

function terrainFoodSection(ed, sel, apply) {
  const one = sel[0];
  const fs = one.foodSpawnSettings || { foodIds: [], count: 0, firstSpawnMs: 0, reSpawnMs: 1000 };
  return section('Food on terrain', 'not in budget',
    foodPicker(ed, fs.foodIds || [], ids => apply('Terrain food', o => { o.foodSpawnSettings = { ...(o.foodSpawnSettings || {}), foodIds: ids }; })),
    h('div', { style: { height: '8px' } }),
    numberField({
      label: 'Count', value: Number(fs.count) || 0, digits: 0, min: 0,
      onCommit: v => apply('Terrain food', o => { o.foodSpawnSettings = { ...(o.foodSpawnSettings || {}), count: v }; })
    }),
    h('div', { style: { height: '6px' } }),
    spawnTimingRows(fs, apply, 'foodSpawnSettings'),
    h('p', { class: 'muted', style: { margin: '4px 0 0' } }, 'The editor\'s food budget counts only Food Spawn areas, not terrain food.'));
}

function currentSection(sel, apply) {
  const s = sel[0].settings;
  const dial = h('div', { class: 'dial', 'data-tip': 'Drag to set the angle (Shift: 15 deg steps)' },
    h('div', { class: 'needle', style: { transform: `rotate(${s.angle}deg)` } }),
    h('div', { class: 'hub' }));
  dial.addEventListener('pointerdown', e => {
    dial.setPointerCapture(e.pointerId);
    const r = dial.getBoundingClientRect();
    let last = s.angle;
    const move = ev => {
      let a = Math.atan2(ev.clientY - (r.top + r.height / 2), ev.clientX - (r.left + r.width / 2)) * 180 / Math.PI;
      if (ev.shiftKey) a = Math.round(a / 15) * 15;
      last = Math.round(a);
      dial.firstChild.style.transform = `rotate(${last}deg)`;
    };
    const up = () => {
      dial.removeEventListener('pointermove', move);
      dial.removeEventListener('pointerup', up);
      apply('Current angle', o => { o.settings.angle = last; });
    };
    dial.addEventListener('pointermove', move);
    dial.addEventListener('pointerup', up);
    move(e);
  });
  const angleVal = common(sel, o => o.settings.angle);
  const strengthVal = common(sel, o => o.settings.strength);
  return section('Current', null,
    h('div', { class: 'row' }, dial, h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' } },
      numberField({
        label: 'Angle', value: angleVal ?? 0, mixed: angleVal == null, digits: 0, min: -180, max: 180, suffix: 'deg',
        onCommit: v => apply('Current angle', o => { o.settings.angle = v; })
      }),
      numberField({
        label: 'Strength', value: strengthVal ?? 0, mixed: strengthVal == null, digits: 0, min: 0, max: MAX_CURRENT,
        onCommit: v => apply('Current strength', o => { o.settings.strength = v; })
      }))));
}

let habPreviewOpen = true;

export function habitatCompatibility(animals, area) {
  const list = (animals || []).filter(a => !NPC_HIDDEN_LEVELS.has(a.level) && a.file);
  const bits = (area != null && Number.isFinite(area) && area > 0) ? (area & 63) : 0;
  if (bits <= 0) {
    return { animals: [], partial: false, missingAxes: ['temperature', 'depth', 'salinity'] };
  }
  const axisNames = ['temperature', 'depth', 'salinity'];
  const missingAxes = [];
  HABITAT_GROUPS.forEach((group, gi) => {
    const mask = group[0] | group[1];
    if ((bits & mask) === 0) missingAxes.push(axisNames[gi]);
  });
  const matched = list.filter(a => {
    const h = a.habitat | 0;
    return HABITAT_GROUPS.every(([b0, b1]) => {
      const zoneBits = bits & (b0 | b1);
      return zoneBits === 0 || (h & zoneBits) !== 0;
    });
  });
  return { animals: matched, partial: missingAxes.length > 0, missingAxes };
}

export function compatibleAnimalsForHabitat(animals, area) {
  return habitatCompatibility(animals, area).animals;
}

function habitatSection(ed, sel, apply) {
  const area = common(sel, o => o.settings.area);
  const s = section('Habitat', area != null ? `code ${area}` : 'mixed');
  if (area != null) {
    s.append(h('div', { class: 'row' },
      h('span', { class: 'dot', style: { width: '12px', height: '12px', background: intToHex(habitatColor(area)) } }),
      h('span', {}, habitatLabel(area) || 'No conditions')));
  }
  const grid = h('div', { class: 'habitat-grid' });
  for (const group of HABITAT_GROUPS) {
    for (const bit of group) {
      const a = HABITAT_AREAS.find(x => x.bit === bit);
      const on = area != null && (area & bit) === bit;
      const dotColor = a.color > 2 ? intToHex(a.color) : a.color === 0 ? '#8b93a5' : a.color > 1 ? '#9ecbff' : '#ffb27a';
      const opt = h('button', { class: 'hab-opt' + (on ? ' on' : '') },
        h('span', { class: 'dot', style: { background: dotColor } }),
        a.title,
        h('span', { class: 'muted', style: { marginLeft: 'auto' } }, String(bit)));
      opt.addEventListener('click', () => apply('Habitat', o => { o.settings.area = on ? (o.settings.area & ~bit) : (o.settings.area | bit); }));
      grid.append(opt);
    }
  }
  s.append(grid, h('div', { style: { height: '8px' } }),
    numberField({
      label: 'Code', value: area ?? 0, mixed: area == null, digits: 0, min: 0, max: 63,
      title: 'Bit field: 1 cold, 2 warm, 4 shallow, 8 deep, 16 fresh, 32 salt',
      onCommit: v => apply('Habitat', o => { o.settings.area = Math.round(v); })
    }));

  if (area == null) {
    s.append(h('p', { class: 'muted', style: { margin: '8px 0 0' } }, 'Select habitats with matching code to preview compatible animals.'));
    return s;
  }
  const compat = habitatCompatibility(ed.catalog.animals, area);
  const previewWrap = h('div', { style: { marginTop: '8px' } });
  const head = h('button', {
    type: 'button',
    class: 'btn small flat',
    style: { width: '100%', justifyContent: 'space-between', padding: '0 4px' }
  },
    h('span', {}, `Compatible animals (${compat.animals.length})`),
    h('span', { html: icon(habPreviewOpen ? 'chevronDown' : 'chevron') }));
  const body = h('div', { style: { display: habPreviewOpen ? '' : 'none', marginTop: '6px' } });
  head.addEventListener('click', () => {
    habPreviewOpen = !habPreviewOpen;
    body.style.display = habPreviewOpen ? '' : 'none';
    head.lastChild.innerHTML = icon(habPreviewOpen ? 'chevronDown' : 'chevron');
  });

  if (area === 0) {
    body.append(h('p', { class: 'muted', style: { margin: '2px 0 0' } }, 'Set habitat bits above to preview animals without biome penalties.'));
  } else {
    if (compat.partial) {
      body.append(h('p', { class: 'muted', style: { margin: '0 0 6px', color: 'var(--warn)' } },
        `Partial zone (missing ${compat.missingAxes.join(', ')}): showing animals matching active bits.`));
    }
    const list = h('div', { class: 'pick-list', style: { maxHeight: '160px' } });
    for (const a of compat.animals) {
      list.append(h('div', { class: 'pick', style: { height: '26px', cursor: 'default' } },
        h('img', { src: ed.assets.thumbnail('A', a.level, 24) || '' }),
        h('span', { class: 'name' }, a.name),
        h('span', { class: 'meta' }, `lv ${a.level}`)));
    }
    body.append(list);
  }
  previewWrap.append(head, body);
  s.append(previewWrap);
  return s;
}

function foodSection(ed, sel, apply) {
  const one = sel[0];
  const s = one.settings;
  const others = totalFood(ed.doc) - sel.reduce((t, o) => t + Number(o.settings.count || 0), 0);
  const worldLeft = Math.floor(foodBudget(ed.doc.worldSize)) - others;
  const cap = sel.length === 1 ? Math.min(foodBoxCap(one), Math.max(0, worldLeft)) : Math.max(0, worldLeft);
  const sec = section('Food spawn', `${sel.length === 1 ? 'box cap ' + foodBoxCap(one) + ' / ' : ''}world left ${worldLeft}`);
  const foodCount = common(sel, o => Number(o.settings.count));
  sec.append(
    foodPicker(ed, common(sel, o => o.settings.foodIds) || [], ids => apply('Foods', o => { o.settings.foodIds = ids; })),
    h('div', { style: { height: '8px' } }),
    numberField({
      label: 'Count', value: foodCount ?? 0, mixed: foodCount == null, digits: 0, min: 0, max: cap,
      title: 'Simultaneous food count; limited per box and by the world budget',
      onCommit: v => apply('Food count', o => { o.settings.count = Math.min(v, foodBoxCap(o)); })
    }),
    h('div', { style: { height: '6px' } }),
    spawnTimingRows(s, apply, 'settings'),
    row('', toggle({
      checked: !!common(sel, o => !!o.settings.onlyOnWater),
      label: 'Only on water',
      onChange: v => apply('Only on water', o => { o.settings.onlyOnWater = v; })
    })));
  return sec;
}

function npcSection(ed, sel, apply) {
  const s = sel[0].settings;
  const others = totalNpc(ed.doc) - sel.reduce((t, o) => t + Number(o.settings.animalCount || 0), 0);
  const left = Math.floor(npcBudget(ed.doc.worldSize)) - others;
  const levels = common(sel, o => o.settings.fishLevels) || [];
  const sec = section('NPC spawn', `world left ${left}`);
  const chips = h('div', { class: 'chips', style: { marginBottom: '6px' } });
  for (const lvl of levels) {
    const a = ed.catalog.animalByLevel.get(Number(lvl));
    const x = h('button', { html: icon('close') });
    x.addEventListener('click', () => apply('NPC animals', o => { o.settings.fishLevels = o.settings.fishLevels.filter(v => Number(v) !== Number(lvl)); }));
    chips.append(h('span', { class: 'chip' }, a?.name || 'level ' + lvl, x));
  }
  const search = h('input', { placeholder: 'Search animals' });
  search.addEventListener('keydown', e => e.stopPropagation());
  const list = h('div', { class: 'pick-list' });
  const fill = () => {
    clear(list);
    const q = search.value.trim().toLowerCase();
    for (const a of ed.catalog.animals) {
      if (NPC_HIDDEN_LEVELS.has(a.level)) continue;
      if (q && !a.name.includes(q) && String(a.level) !== q) continue;
      const on = levels.map(Number).includes(a.level);
      const r = h('div', { class: 'pick' + (on ? ' on' : '') },
        h('img', { src: ed.assets.thumbnail('A', a.level, 24) || '' }),
        h('span', { class: 'name' }, a.name),
        h('span', { class: 'meta' }, String(a.level)));
      r.addEventListener('click', () => apply('NPC animals', o => {
        o.settings.fishLevels = on ? o.settings.fishLevels.filter(v => Number(v) !== a.level) : [...o.settings.fishLevels, a.level];
      }));
      list.append(r);
    }
  };
  search.addEventListener('input', fill);
  fill();
  const type = common(sel, o => Number(o.settings.npcType));
  const npcCount = common(sel, o => Number(o.settings.animalCount));
  sec.append(chips, h('div', { class: 'search', style: { marginBottom: '6px' } }, h('span', { html: icon('search') }), search), list,
    h('div', { style: { height: '8px' } }),
    numberField({
      label: 'Count', value: npcCount ?? 0, mixed: npcCount == null, digits: 0, min: 0, max: Math.min(100, Math.max(0, left)),
      title: 'Per spawn at most 100, and within the world budget',
      onCommit: v => apply('NPC count', o => { o.settings.animalCount = v; })
    }),
    h('div', { style: { height: '6px' } }),
    spawnTimingRows(s, apply, 'settings'),
    row('Behaviour', select({
      value: type ?? '',
      options: NPC_TYPES.map(t => ({ value: t.id, label: t.name })),
      onChange: v => apply('NPC behaviour', o => { o.settings.npcType = Number(v); })
    })),
    type ? h('p', { class: 'muted', style: { margin: '0 0 6px' } }, NPC_TYPES.find(t => t.id === type)?.description || '') : null,
    row('', toggle({
      checked: !!common(sel, o => !!o.settings.restrictMovement),
      label: 'Restrict movement to the spawn box',
      onChange: v => apply('Restrict movement', o => { o.settings.restrictMovement = v; })
    })));
  return sec;
}

function triggerSection(ed, obj, apply) {
  const sec = section('Triggers', `${obj.triggers.length}`);
  const edit = (label, fn) => apply(label, o => { o.triggers = clone(o.triggers); fn(o.triggers); });
  obj.triggers.forEach((t, ti) => {
    const card = h('div', { class: 'trigger-card' });
    const rm = h('button', { class: 'btn icon flat small', html: icon('trash'), 'data-tip': 'Remove trigger' });
    rm.addEventListener('click', () => edit('Remove trigger', list => list.splice(ti, 1)));
    card.append(h('div', { class: 'row' },
      select({
        value: t.when,
        options: TRIGGER_WHEN.map(w => ({ value: w.value, label: w.title })),
        onChange: v => edit('Trigger event', list => { list[ti].when = Number(v); })
      }),
      select({ value: t.delay ?? 0, options: [{ value: 0, label: 'immediately' }], onChange: () => {} }),
      rm));
    (t.actions || []).forEach((a, ai) => {
      const delA = h('button', { class: 'btn icon flat small', html: icon('close'), 'data-tip': 'Remove action' });
      delA.addEventListener('click', () => edit('Remove action', list => list[ti].actions.splice(ai, 1)));
      const actionTitle = TRIGGER_ACTIONS.find(x => x.value === a.type)?.title || 'Action ' + a.type;
      const r = h('div', { class: 'row' },
        h('span', { class: 'k', style: { width: '64px' } }, actionTitle),
        h('span', { style: { flex: 1 } }),
        delA);
      card.append(r);
      if (a.type === 1) {
        const pos = a.data?.pos;
        const pick = h('button', { class: 'btn small', html: icon('target'), 'data-tip': 'Click a point on the map' });
        pick.addEventListener('click', () => {
          ed.toast('Click the teleport target on the map (Esc cancels)');
          ed.pickPoint = w => edit('Teleport target', list => {
            list[ti].actions[ai].data = { ...(list[ti].actions[ai].data || {}), pos: { x: w.x, y: w.y } };
          });
        });
        card.append(h('div', { class: 'row' },
          numberField({
            label: 'X', value: pos ? pos.x / 10 : 0, mixed: !pos, digits: 3,
            onCommit: v => edit('Teleport target', list => {
              const d = list[ti].actions[ai];
              d.data = { ...(d.data || {}), pos: { x: v * 10, y: d.data?.pos?.y ?? 0 } };
            })
          }),
          numberField({
            label: 'Y', value: pos ? pos.y / 10 : 0, mixed: !pos, digits: 3,
            onCommit: v => edit('Teleport target', list => {
              const d = list[ti].actions[ai];
              d.data = { ...(d.data || {}), pos: { x: d.data?.pos?.x ?? 0, y: v * 10 } };
            })
          }),
          pick));
      }
    });
    const addA = select({
      value: '',
      options: [{ value: '', label: 'Add action...' }, ...TRIGGER_ACTIONS.map(x => ({ value: x.value, label: x.title }))],
      onChange: v => {
        if (!v) return;
        edit('Add action', list => {
          list[ti].actions = [...(list[ti].actions || []), Number(v) === 1 ? { type: 1, data: {} } : { type: Number(v) }];
        });
      }
    });
    card.append(h('div', { class: 'row' }, addA));
    sec.append(card);
  });
  const add = h('button', { class: 'btn small' }, h('span', { html: icon('plus') }), 'Add trigger');
  add.addEventListener('click', () => edit('Add trigger', list => list.push({ actions: [], delay: 0, when: 1 })));
  sec.append(add);
  return sec;
}

// ------------------------------------------------------------------ assets

function assetsPanel(ed, el) {
  let kind = 'H';
  let query = '';
  const kinds = [{ id: 'H', label: 'Hide spaces' }, { id: 'A', label: 'Animals' }, { id: 'P', label: 'Props' }, { id: 'T', label: 'Textures' }];
  const seg = h('div', { class: 'seg' });
  const segButtons = {};
  for (const k of kinds) {
    const b = h('button', {}, k.label);
    b.addEventListener('click', () => setKind(k.id));
    segButtons[k.id] = b;
    seg.append(b);
  }
  const search = h('input', { placeholder: 'Search' });
  search.addEventListener('keydown', e => e.stopPropagation());
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); fill(); });
  const hint = h('div', { class: 'muted', style: { padding: '6px 12px 0' } });
  const grid = h('div', { class: 'assets-grid' });
  el.append(
    h('div', { class: 'asset-toolbar' }, seg),
    h('div', { class: 'asset-toolbar' }, h('div', { class: 'search' }, h('span', { html: icon('search') }), search)),
    hint, grid);

  const replaceTargets = () => {
    const sel = ed.selected();
    if (kind === 'T') return sel.filter(o => TEXTURED_TYPES.has(o.type));
    return sel.filter(o => o.type === kind);
  };

  const pick = id => {
    const b = ed.state.brush;
    const targets = replaceTargets();
    if (targets.length) {
      ed.edit('Replace asset', () => targets.forEach(o => {
        ed.doc.touch(o);
        if (kind === 'H') o.hSType = id;
        if (kind === 'A') o.fLevel = id;
        if (kind === 'P') {
          o.pType = id;
          const p = ed.catalog.propById.get(id);
          o.params = p?.params?.some(x => x.key === 'text') ? { text: o.params?.text ?? '' } : null;
        }
        if (kind === 'T') o.texture = id;
      }));
    }
    if (kind === 'H') b.hSType = id;
    if (kind === 'A') b.fLevel = id;
    if (kind === 'P') b.pType = id;
    if (kind === 'T') b.texture = id;
    if (!targets.length && kind !== 'T') ed.setTool({ H: 'hide', A: 'animal', P: 'prop' }[kind]);
    ed.emit('brush');
    fill();
  };

  function fill() {
    clear(grid);
    for (const [k, b] of Object.entries(segButtons)) b.classList.toggle('on', k === kind);
    const n = replaceTargets().length;
    hint.textContent = n
      ? `Click to replace the ${n} selected object${n > 1 ? 's' : ''}`
      : (kind === 'T' ? 'Click to set the texture for new shapes' : 'Click to choose, then click on the map to place');
    const b = ed.state.brush;
    const current = kind === 'H' ? b.hSType : kind === 'A' ? b.fLevel : kind === 'P' ? b.pType : b.texture;
    let items = [];
    if (kind === 'H') items = ed.catalog.hideSpaces.map(x => ({ id: x.id, name: x.name, group: x.packName }));
    if (kind === 'A') items = ed.catalog.animals.filter(a => a.file).map(a => ({ id: a.level, name: a.name, group: null }));
    if (kind === 'P') items = ed.catalog.props.map(p => ({ id: p.id, name: p.name, group: null }));
    if (kind === 'T') items = ed.catalog.textures.map(t => ({ id: t.id, name: t.name, group: null }));
    let group = null;
    for (const it of items) {
      if (query && !it.name.toLowerCase().includes(query) && String(it.id) !== query) continue;
      if (it.group && it.group !== group) { group = it.group; grid.append(h('div', { class: 'pack-title' }, group)); }
      const a = h('button', {
        class: 'asset' + (it.id === current ? ' on' : ''),
        title: `${it.name} (${kind === 'A' ? 'level' : 'id'} ${it.id})`
      },
        h('img', {
          src: ed.assets.thumbnail(kind, it.id, 64) || '',
          style: kind === 'T' ? { imageRendering: 'pixelated', borderRadius: '4px' } : {}
        }),
        h('span', { class: 'name' }, it.name));
      a.addEventListener('click', e => {
        if (kind === 'H' && e.shiftKey) {
          toggleScatterAsset(ed, it.id);
          if (ed.state.tool !== 'scatter') ed.setTool('scatter');
          return;
        }
        pick(it.id);
      });
      grid.append(a);
    }
  }

  function setKind(k) { if (k) kind = k; fill(); }
  ed.on('selection', () => { if (el.offsetParent) fill(); });
  setKind('H');
  return { setKind };
}

// ------------------------------------------------------------------ library

function libraryPanel(ed, el) {
  const render = async () => {
    clear(el);
    const list = (await host.storeGet('symbols')) || [];
    const save = h('button', { class: 'btn small primary', disabled: !ed.state.selection.size }, h('span', { html: icon('plus') }), 'Save selection');
    save.addEventListener('click', () => ed.saveSymbol());
    el.append(h('div', { class: 'section' },
      h('div', { class: 'row' },
        h('span', { class: 'muted', style: { flex: 1 } }, 'Reusable object groups, stored on this computer.'),
        save)));
    if (!list.length) {
      el.append(h('div', { class: 'empty' },
        h('strong', {}, 'No symbols yet'),
        'Select objects and save them to reuse across maps.'));
      return;
    }
    for (const sym of list) {
      const c = h('canvas', { width: 112, height: 80 });
      drawSymbolThumb(c, sym);
      const place = h('button', { class: 'btn small' }, 'Place');
      place.addEventListener('click', () => ed.placeSymbol(sym));
      const ren = h('button', { class: 'btn icon flat small', html: icon('pen'), 'data-tip': 'Rename' });
      ren.addEventListener('click', async () => {
        const name = await dialogs.prompt('Rename symbol', 'Name', sym.name);
        if (!name) return;
        const all = (await host.storeGet('symbols')) || [];
        const s = all.find(x => x.id === sym.id); if (s) s.name = name;
        await host.storeSet('symbols', all); render();
      });
      const del = h('button', { class: 'btn icon flat small danger', html: icon('trash'), 'data-tip': 'Delete' });
      del.addEventListener('click', async () => {
        if (!(await dialogs.confirm('Delete symbol', `Delete "${sym.name}" from the library?`, 'Delete'))) return;
        const all = ((await host.storeGet('symbols')) || []).filter(x => x.id !== sym.id);
        await host.storeSet('symbols', all); render();
      });
      el.append(h('div', { class: 'symbol' },
        c,
        h('div', { class: 'info' },
          h('div', { class: 'name' }, sym.name),
          h('div', { class: 'meta' }, `${sym.objects.length} object${sym.objects.length > 1 ? 's' : ''}`)),
        place, ren, del));
    }
  };
  ed.on('symbols', render);
  ed.on('selection', () => { const b = el.querySelector('.btn.primary'); if (b) b.disabled = !ed.state.selection.size; });
  render();
}

function drawSymbolThumb(canvas, sym) {
  const g = canvas.getContext('2d');
  const b = sym.bounds || { x: 0, y: 0, width: 1, height: 1 };
  const k = Math.min((canvas.width - 8) / Math.max(b.width, 1), (canvas.height - 8) / Math.max(b.height, 1));
  g.fillStyle = '#11141a'; g.fillRect(0, 0, canvas.width, canvas.height);
  g.translate((canvas.width - b.width * k) / 2 - b.x * k, (canvas.height - b.height * k) / 2 - b.y * k);
  g.scale(k, k);
  const order = LAYERS.slice().reverse();
  for (const layer of order) {
    for (const o of sym.objects.filter(x => x.layerId === layer.id)) {
      g.fillStyle = o.colors ? intToHex(o.colors[0]) : LAYER_SWATCH[o.layerId] || '#888';
      if (o.points?.length) {
        g.beginPath(); o.points.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.closePath(); g.fill();
      } else if (o.x != null) {
        g.beginPath(); g.arc(o.x, o.y, 3 / k, 0, Math.PI * 2); g.fill();
      }
    }
  }
}

// ------------------------------------------------------------------ layers

export function parseLayerQuery(query) {
  const normalized = String(query || '').trim().replace(/\s*(<=|>=|<|>|=)\s*/g, '$1');
  if (!normalized) return { empty: true, ops: [], terms: [] };
  const opsList = [];
  const terms = [];
  for (const tok of normalized.split(/\s+/)) {
    const m = tok.match(/^(area|pts|points|opacity|op)(<=|>=|<|>|=)(-?\d+(?:\.\d+)?)(%?)$/i);
    if (m) {
      const rawField = m[1].toLowerCase();
      const field = rawField === 'area' ? 'area' : (rawField === 'opacity' || rawField === 'op') ? 'opacity' : 'pts';
      let value = Number(m[3]);
      if (field === 'opacity' && (m[4] === '%' || value > 1)) value = value / 100;
      opsList.push({ field, op: m[2], value });
    } else {
      terms.push(tok.toLowerCase());
    }
  }
  return { empty: opsList.length === 0 && terms.length === 0, ops: opsList, terms };
}

function compareOp(actual, op, target) {
  if (actual == null || !Number.isFinite(actual) || !Number.isFinite(target)) return false;
  switch (op) {
    case '<': return actual < target;
    case '<=': return actual <= target;
    case '>': return actual > target;
    case '>=': return actual >= target;
    case '=': return Math.abs(actual - target) < 1e-9;
    default: return false;
  }
}

function objectAreaUnits(o) {
  const k = KIND_BY_TYPE[o.type];
  if (k === 'poly') return o.points?.length >= 3 ? Math.abs(signedArea(o.points)) / 100 : 0;
  if (k === 'rect') return (Number(o.size?.width || 0) * Number(o.size?.height || 0)) / 100;
  return null;
}

function objectPointCount(o) {
  const k = KIND_BY_TYPE[o.type];
  if (k === 'poly' || k === 'rect') return (o.points || []).length;
  return null;
}

function objectOpacityValue(o) {
  if (o.type === 'Bg' || o.type === 'H') return o.opacity ?? 1;
  return null;
}

function objectSearchText(o, { catalog, name, index } = {}) {
  const parts = [];
  if (name) parts.push(name);
  if (index != null) parts.push(`${SINGULAR[o.layerId] || o.type} ${index + 1}`);
  const layer = LAYER_BY_ID[o.layerId];
  if (layer) parts.push(layer.title, layer.id);
  parts.push(o.type);
  if (TEXTURED_TYPES.has(o.type) && o.texture != null) {
    const t = catalog?.textureById?.get(o.texture);
    if (t?.name) parts.push(t.name);
    parts.push('#' + o.texture);
  }
  if (o.type === 'H') {
    const hs = catalog?.hideSpaceById?.get(o.hSType);
    if (hs) parts.push(hs.name, hs.packName || '');
    parts.push('#' + o.hSType);
  }
  if (o.type === 'A') {
    const a = catalog?.animalByLevel?.get(o.fLevel);
    if (a) parts.push(a.name);
    parts.push('#' + o.fLevel);
  }
  if (o.type === 'P') {
    const p = catalog?.propById?.get(o.pType);
    if (p) parts.push(p.name);
    if (o.params?.text) parts.push(String(o.params.text));
    parts.push('#' + o.pType);
  }
  if (o.type === 'Sky' || o.type === 'Wat') {
    for (const c of o.colors || []) parts.push(intToHex(c));
  }
  if (o.type === 'Air') {
    parts.push(intToHex(o.borderColor ?? 0));
  }
  if (o.type === 'Hab') {
    const area = o.settings?.area | 0;
    parts.push(habitatLabel(area), intToHex(habitatColor(area)));
  }
  if (o.type === 'Food') {
    for (const id of o.settings?.foodIds || []) {
      const f = catalog?.foodById?.get(Number(id));
      if (f?.name) parts.push(f.name);
    }
  }
  if (o.type === 'NPC') {
    for (const lvl of o.settings?.fishLevels || []) {
      const a = catalog?.animalByLevel?.get(Number(lvl));
      if (a?.name) parts.push(a.name);
    }
  }
  return parts.join(' ').toLowerCase();
}

export function matchesLayerFilter(o, queryOrParsed, ctx = {}) {
  const parsed = typeof queryOrParsed === 'string' ? parseLayerQuery(queryOrParsed) : queryOrParsed;
  if (!parsed || parsed.empty) return true;
  for (const cond of parsed.ops) {
    const actual = cond.field === 'area'
      ? objectAreaUnits(o)
      : cond.field === 'opacity'
        ? objectOpacityValue(o)
        : objectPointCount(o);
    if (!compareOp(actual, cond.op, cond.value)) return false;
  }
  if (parsed.terms.length) {
    const text = objectSearchText(o, ctx);
    for (const t of parsed.terms) if (!text.includes(t)) return false;
  }
  return true;
}

function layersPanel(ed, el) {
  const open = new Set();
  const limits = new Map();
  let query = '';
  let scheduled = 0;

  const searchInput = h('input', { placeholder: 'Filter: name, texture, #hex, area<0.1, pts>40, op<1' });
  const clearBtn = h('button', {
    type: 'button',
    class: 'btn icon flat small',
    html: icon('close'),
    'data-tip': 'Clear filter',
    style: { display: 'none', width: '20px', height: '20px' }
  });
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape' && searchInput.value) {
      searchInput.value = '';
      query = '';
      clearBtn.style.display = 'none';
      render();
    }
    e.stopPropagation();
  });
  searchInput.addEventListener('input', () => {
    query = searchInput.value;
    clearBtn.style.display = query.trim() ? '' : 'none';
    schedule();
  });
  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    query = '';
    clearBtn.style.display = 'none';
    render();
    searchInput.focus();
  });

  const focusStatus = h('span', { class: 'layer-focus-status' }, 'All layers');
  const viewAllBtn = h('button', {
    type: 'button',
    class: 'btn small layer-view-all',
    'data-action': 'view-all',
    'data-tip': 'Show all layers and objects at full opacity',
    'data-key': 'Ctrl+Shift+I',
    disabled: !ed.state.isolate
  }, 'View all');
  viewAllBtn.addEventListener('click', () => ed.setIsolate(false));
  const focusBar = h('div', { class: 'layer-focus-bar' }, focusStatus, viewAllBtn);

  const toolbar = h('div', {
    style: {
      position: 'sticky', top: '0', zIndex: '2', background: 'var(--bg2)',
      padding: '6px 8px', borderBottom: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: '6px'
    }
  },
    h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } },
      h('div', { class: 'search' }, h('span', { html: icon('search') }), searchInput, clearBtn)),
    createLayerScrubber(ed),
    focusBar);
  const listEl = h('div');
  el.append(toolbar, listEl);

  const renderObjectRow = (layer, o, i) => {
    const rowEl = h('div', { class: 'obj-row' + (ed.state.selection.has(o.uid) ? ' sel' : '') },
      h('span', { class: 'oname' }, ed.meta.name(o) || `${SINGULAR[layer.id]} ${i + 1}`),
      ed.meta.groupOf.has(o.uid) ? h('span', { class: 'badge', title: 'Group' }, 'G' + ed.meta.groupOf.get(o.uid)) : null,
      ed.meta.twins.has(o.uid) ? h('span', { class: 'badge', title: 'Symmetry twin', style: { color: '#ff8fe6' } }, 'S') : null,
      h('span', { class: 'meta' }, objectMeta(ed, o)));
    rowEl.addEventListener('click', e => { ed.setActiveLayer(layer.id); ed.select([o], e.shiftKey || e.ctrlKey ? 'toggle' : 'replace'); });
    rowEl.addEventListener('dblclick', () => ed.focusObject(o));
    return rowEl;
  };

  const render = () => {
    scheduled = 0;
    const scroll = el.scrollTop;
    clear(listEl);
    const isolated = !!ed.state.isolate;
    const sel = isolated ? ed.selected() : [];
    const activeTitle = LAYER_BY_ID[ed.state.activeLayer]?.title || '';
    let focusLabel = 'All layers';
    if (isolated) {
      if (sel.length === 1) {
        const o = sel[0];
        const name = ed.meta.name(o) || `${SINGULAR[o.layerId] || o.type} ${ed.doc.layers[o.layerId].indexOf(o) + 1}`;
        focusLabel = `Focused: ${name}`;
      } else if (sel.length > 1) {
        focusLabel = `Focused: ${sel.length} selected`;
      } else {
        focusLabel = `Focused: ${activeTitle}`;
      }
    }
    focusBar.classList.toggle('active', isolated);
    focusStatus.textContent = focusLabel;
    focusStatus.title = focusLabel;
    viewAllBtn.disabled = !isolated;
    viewAllBtn.classList.toggle('primary', isolated);

    const frag = document.createDocumentFragment();
    const parsed = parseLayerQuery(query);
    const filtering = !parsed.empty;
    let totalMatches = 0;

    for (const layer of LAYERS) {
      const list = ed.doc.layers[layer.id];
      let matched = null;
      if (filtering) {
        matched = [];
        for (let i = 0; i < list.length; i++) {
          const o = list[i];
          if (matchesLayerFilter(o, parsed, { catalog: ed.catalog, name: ed.meta.name(o), index: i })) {
            matched.push({ o, i });
          }
        }
        if (!matched.length) continue;
        totalMatches += matched.length;
      }

      const vis = ed.state.visible.has(layer.id), locked = ed.state.locked.has(layer.id);
      const expanded = filtering ? true : open.has(layer.id);
      const twist = h('button', { class: 'twist' + (expanded ? ' open' : ''), html: icon('chevron'), disabled: !list.length || filtering });
      if (!filtering) {
        twist.addEventListener('click', e => { e.stopPropagation(); open.has(layer.id) ? open.delete(layer.id) : open.add(layer.id); render(); });
      }
      const eye = h('button', {
        class: 'lbtn' + (vis ? '' : ' off'),
        html: icon(vis ? 'eye' : 'eyeOff'),
        'data-tip': vis ? 'Hide layer (editor only)' : 'Show layer'
      });
      eye.addEventListener('click', e => {
        e.stopPropagation();
        if (e.altKey) {
          const only = !(ed.state.visible.size === 1 && vis);
          ed.state.visible = new Set(only ? [layer.id] : LAYERS.map(l => l.id));
        } else {
          vis ? ed.state.visible.delete(layer.id) : ed.state.visible.add(layer.id);
        }
        syncLayerVisibility(ed, layer.id, e.altKey);
        if (!ed.state.visible.has(layer.id)) for (const o of list) ed.state.selection.delete(o.uid);
        ed.emit('selection'); ed.emit('view-options'); ed.requestRender(); render();
      });
      const lock = h('button', {
        class: 'lbtn' + (locked ? ' locked' : ''),
        html: icon(locked ? 'lock' : 'unlock'),
        'data-tip': locked ? 'Unlock layer' : 'Lock layer'
      });
      lock.addEventListener('click', e => {
        e.stopPropagation();
        locked ? ed.state.locked.delete(layer.id) : ed.state.locked.add(layer.id);
        if (!locked) { for (const o of list) ed.state.selection.delete(o.uid); ed.emit('selection'); }
        ed.requestRender(); render();
      });
      const countText = filtering ? `${matched.length}/${list.length}` : String(list.length);
      const isActive = ed.state.activeLayer === layer.id;
      const rowCls = 'layer-row'
        + (isActive ? ' active' : '')
        + (isolated ? (isActive ? ' focused' : ' dimmed') : '');
      const r = h('div', { class: rowCls, 'data-layer-id': layer.id, title: layer.description || '' },
        twist, h('span', { class: 'sw', style: { background: LAYER_SWATCH[layer.id] } }),
        h('span', { class: 'lname' }, layer.title, layer.helper ? h('small', {}, 'helper') : null),
        h('span', { class: 'count' }, countText), eye, lock);
      r.addEventListener('click', () => ed.focusLayer(layer.id));
      r.addEventListener('dblclick', () => ed.select(filtering ? matched.map(m => m.o) : list));
      frag.append(r);

      if (filtering) {
        // Lift the 200-item truncation for filtered results so all matches are reachable.
        for (let k = matched.length - 1; k >= 0; k--) {
          frag.append(renderObjectRow(layer, matched[k].o, matched[k].i));
        }
      } else if (open.has(layer.id) && list.length) {
        const limit = limits.get(layer.id) || 200;
        const start = Math.max(0, list.length - limit);
        for (let i = list.length - 1; i >= start; i--) {
          frag.append(renderObjectRow(layer, list[i], i));
        }
        if (start > 0) {
          const more = h('button', { class: 'btn small flat' }, `Show ${Math.min(500, start)} more of ${start}`);
          more.addEventListener('click', () => { limits.set(layer.id, limit + 500); render(); });
          frag.append(h('div', { class: 'obj-more' }, more));
        }
      }
    }
    if (filtering && totalMatches === 0) {
      frag.append(h('div', { class: 'empty' },
        h('strong', {}, 'No matching objects'),
        'Try a name, texture, asset, #hex colour, area<0.1 or pts>40.'));
    }
    listEl.append(frag);
    el.scrollTop = scroll;
  };
  const schedule = () => { if (!scheduled) scheduled = nextFrame(render); };
  ed.on('doc', schedule);
  ed.on('selection', schedule);
  ed.on('layer', schedule);
  ed.on('meta', schedule);
  ed.on('view-options', schedule);
  render();
}

function objectMeta(ed, o) {
  switch (o.type) {
    case 'Ter': case 'C': return `${ed.catalog.textureById.get(o.texture)?.name || '?'}  ${o.points.length}p`;
    case 'Bg': return `${ed.catalog.textureById.get(o.texture)?.name || '?'}  ${fmt(o.opacity ?? 0, 2)}`;
    case 'Air': return `${o.points.length}p`;
    case 'Sky': case 'Wat': return (o.colors || []).map(intToHex).join(' ');
    case 'Cu': return `${o.settings.angle} deg  ${o.settings.strength}`;
    case 'Hab': return habitatLabel(o.settings.area | 0) || 'none';
    case 'Food': return 'x' + o.settings.count;
    case 'NPC': return 'x' + o.settings.animalCount;
    case 'Tr': return `${o.triggers.length} trigger${o.triggers.length === 1 ? '' : 's'}`;
    case 'H': {
      const name = ed.catalog.hideSpaceById.get(o.hSType)?.name || '#' + o.hSType;
      const op = o.opacity ?? 1;
      return op < 1 ? `${name}  ${Math.round(op * 100)}%` : name;
    }
    case 'A': return ed.catalog.animalByLevel.get(o.fLevel)?.name || '#' + o.fLevel;
    case 'P': return ed.catalog.propById.get(o.pType)?.name || '#' + o.pType;
  }
  return '';
}

// ------------------------------------------------------------------ checks

const GROUP_TEXT = {
  'layer-type': 'objects on a layer that does not accept their type',
  points: 'polygons with fewer than 3 points',
  nan: 'objects with non-numeric coordinates',
  bounds: 'objects extending outside the world',
  flat: 'polygons with zero width or height',
  'off-world': 'objects completely outside the world',
  'self-intersection': 'outlines that cross themselves',
  texture: 'objects using a texture missing from the catalog',
  colors: 'gradients with fewer than two colours',
  'tester-colors': 'gradients with more than two stops (the map tester draws two)',
  'tester-thin-sky': 'two-colour Sky shapes under 1.5 px tall (black in the map tester)',
  'tester-hide-order': 'semi-transparent hide spaces that draw above opaque ones in-game/tester',
  opacity: 'background terrains without opacity',
  'hide-space': 'hide spaces missing from the catalog',
  prop: 'props missing from the catalog',
  animal: 'preview animals missing from the catalog',
  'animal-asset': 'preview animals without an official sprite',
  'food-id': 'food spawns with unknown food ids',
  'food-empty': 'food spawns with no food selected',
  'food-box': 'food spawns over their box cap',
  'npc-level': 'NPC spawns with unknown animals',
  'npc-empty': 'NPC spawns with no animal selected',
  'npc-state': 'NPC spawns using animal states the official picker hides',
  'npc-count': 'NPC spawns above 100 animals',
  teleport: 'teleport actions without a target',
  'teleport-bounds': 'teleport targets outside the world',
  'teleport-solid': 'teleports whose target lands inside solid terrain',
  'teleport-dry': 'teleports whose target lands outside water',
  'teleport-loop': 'teleports that send players straight back (A to B to A)',
  'duplicate-contour': 'solid terrains duplicating another terrain contour',
  'micro-terrain': 'tiny terrains (< 0.25 u2) on the terrains layer (move to platforms)',
  'edge-reversal': 'polygons with 180-degree backtracking edges'
};

function checksPanel(ed, el, tabButton) {
  const badge = h('span', { class: 'badge' }, '0');
  tabButton.append(badge);
  const render = () => {
    clear(el);
    const issues = ed.issues;
    const s = ed.issueSummary();
    badge.textContent = String(s.error + s.warning);
    badge.className = 'badge ' + (s.error ? 'err' : s.warning ? 'warn' : 'ok');
    const fixable = issues.filter(i => i.fix);
    const fixAll = h('button', { class: 'btn small', disabled: !fixable.length }, `Fix ${fixable.length}`);
    fixAll.addEventListener('click', () => {
      ed.edit('Fix compatibility', () => { for (const i of fixable) ops.applyFix(ed.doc, ed.catalog, i); });
      ed.toast(`Applied ${fixable.length} fix${fixable.length === 1 ? '' : 'es'}`, 'ok');
    });
    const verdict = s.error ? 'Will not open cleanly in Mapmaker' : s.warning ? 'Opens in Mapmaker, review warnings' : 'Mapmaker and tester compatible';
    el.append(h('div', { class: 'check-summary' },
      h('span', { class: 'dot ' + (s.error ? 'err' : s.warning ? 'warn' : 'ok') }), h('span', { class: 'verdict' }, verdict),
      h('span', { class: 'badge err' }, String(s.error)), h('span', { class: 'badge warn' }, String(s.warning)), h('span', { class: 'badge' }, String(s.info)), fixAll));
    if (!issues.length) {
      el.append(h('div', { class: 'empty' },
        h('strong', {}, 'No issues found'),
        'Exports from this map open in the official Mapmaker unchanged.'));
      return;
    }
    const groups = new Map();
    for (const i of issues) {
      const k = i.severity + ':' + i.code;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(i);
    }
    for (const [k, list] of groups) {
      const first = list[0];
      const objs = list.map(i => i.uid != null ? ed.doc.get(i.uid) : null).filter(Boolean);
      const acts = h('div', { class: 'acts' });
      if (objs.length) {
        const show = h('button', { class: 'btn small flat' }, objs.length > 1 ? 'Select' : 'Show');
        show.addEventListener('click', () => {
          for (const o of objs) ed.state.visible.add(o.layerId);
          ed.select(objs);
          if (objs.length === 1) ed.focusObject(objs[0]); else ed.zoomSelection();
        });
        acts.append(show);
      }
      const fixable = list.filter(i => i.fix);
      if (fixable.length) {
        const kind = fixable[0].fix;
        const fixLabel = kind === 'bakeSky'
          ? (fixable.length > 1 ? `Bake ${fixable.length}` : 'Bake gradient')
          : kind === 'moveToPlatforms'
            ? (fixable.length > 1 ? `Move ${fixable.length} to Platforms` : 'Move to Platforms')
            : kind === 'deleteDuplicate'
              ? (fixable.length > 1 ? `Delete ${fixable.length} duplicates` : 'Delete duplicate')
              : kind === 'deleteObject'
                ? (fixable.length > 1 ? `Delete ${fixable.length}` : 'Delete')
              : kind === 'moveTeleports'
                ? (fixable.length > 1 ? `Move ${fixable.length} targets` : 'Move target')
              : kind === 'sortHideSpacesByOpacity'
                ? 'Sort hide spaces by opacity'
              : (fixable.length > 1 ? `Fix ${fixable.length}` : 'Fix');
        const fix = h('button', { class: 'btn small' }, fixLabel);
        fix.addEventListener('click', () => ed.edit('Fix ' + first.code, () => fixable.forEach(i => ops.applyFix(ed.doc, ed.catalog, i))));
        acts.append(fix);
      }
      const ic = h('span', { class: 'ic', html: icon(first.severity === 'error' ? 'error' : first.severity === 'warning' ? 'warn' : 'info') });
      const msg = h('div', { class: 'msg' }, list.length > 1 ? `${list.length} x ${GROUP_TEXT[first.code] || first.message}` : first.message);
      if (list.length === 1) {
        const o = objs[0];
        const src = o ? `${SINGULAR[o.layerId]} ${ed.doc.layers[o.layerId].indexOf(o) + 1}` : 'Map';
        msg.append(h('div', { class: 'src' }, src + '  ' + first.code));
      } else {
        const more = h('button', { class: 'btn small flat', style: { padding: 0, height: '18px' } }, expanded.has(k) ? 'Hide list' : 'List objects');
        more.addEventListener('click', () => { expanded.has(k) ? expanded.delete(k) : expanded.add(k); render(); });
        msg.append(h('div', { class: 'src' }, first.code + '  ', more));
      }
      el.append(h('div', { class: 'check ' + first.severity }, ic, msg, acts));
      if (expanded.has(k)) {
        for (const i of list.slice(0, 150)) {
          const o = i.uid != null ? ed.doc.get(i.uid) : null;
          if (!o) continue;
          const r = h('div', { class: 'obj-row' },
            h('span', { class: 'oname' }, `${SINGULAR[o.layerId]} ${ed.doc.layers[o.layerId].indexOf(o) + 1}`),
            h('span', { class: 'meta' }, i.message.slice(0, 48)));
          r.addEventListener('click', () => { ed.state.visible.add(o.layerId); ed.select([o]); ed.focusObject(o); });
          el.append(r);
        }
        if (list.length > 150) el.append(h('div', { class: 'obj-more muted' }, `${list.length - 150} more`));
      }
    }
  };
  const expanded = new Set();
  ed.on('issues', render);
  render();
}

// ------------------------------------------------------------------ reference image

function pickImage(ed) {
  const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/bmp' });
  input.addEventListener('change', () => ed.meta.loadReferenceFile(input.files[0]));
  input.click();
}

async function pasteImage(ed) {
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find(t => t.startsWith('image/'));
      if (type) { const blob = await item.getType(type); ed.meta.loadReferenceFile(new File([blob], 'pasted image', { type })); return; }
    }
    ed.toast('There is no image on the clipboard');
  } catch (e) { ed.toast('Clipboard unavailable: ' + e.message, 'err'); }
}

function referenceSection(ed) {
  const ref = ed.meta.reference;
  const sec = section('Reference image', 'editor only, not exported');
  const load = h('button', { class: 'btn small' }, ref ? 'Replace...' : 'Load image...');
  load.addEventListener('click', () => pickImage(ed));
  const paste = h('button', { class: 'btn small' }, 'Paste');
  paste.addEventListener('click', () => pasteImage(ed));
  if (!ref) {
    sec.append(
      h('p', { class: 'muted', style: { margin: '0 0 8px' } },
        'Trace over a sketch, screenshot or photo. Load a file, paste an image, or drop an image file on the map. ' +
        'Saved beside the map in its .mmp.json file, never in the DPM.'),
      h('div', { class: 'btn-row' }, load, paste));
    return sec;
  }
  const set = (patch, silent) => ed.meta.updateReference(patch, silent);
  const editing = ed.state.tool === 'reference';
  const edit = h('button', { class: 'btn small' + (editing ? ' on' : ''), disabled: !!ref.locked }, editing ? 'Done' : 'Move / resize on map');
  edit.addEventListener('click', () => ed.setTool(editing ? 'select' : 'reference'));
  const remove = h('button', { class: 'btn small danger' }, 'Remove');
  remove.addEventListener('click', () => { if (ed.state.tool === 'reference') ed.setTool('select'); ed.meta.setReference(null); });
  const W = ed.doc.pixelWidth, H = ed.doc.pixelHeight;
  const fitMap = h('button', { class: 'btn small' }, 'Fit map');
  fitMap.addEventListener('click', () => {
    const k = Math.min(W / ref.aspect, H);
    set({ width: ref.aspect * k, height: k, x: (W - ref.aspect * k) / 2, y: (H - k) / 2 });
  });
  const fillMap = h('button', { class: 'btn small', 'data-tip': 'Stretch to the whole world (ignores the aspect ratio)' }, 'Stretch to map');
  fillMap.addEventListener('click', () => set({ x: 0, y: 0, width: W, height: H }));
  const fitView = h('button', { class: 'btn small' }, 'Fit view');
  fitView.addEventListener('click', () => {
    const r = ed.renderer, a = r.toWorld(40, 40), b = r.toWorld(r.width - 40, r.height - 40);
    const k = Math.min((b.x - a.x) / ref.aspect, b.y - a.y);
    set({ width: ref.aspect * k, height: k, x: (a.x + b.x) / 2 - ref.aspect * k / 2, y: (a.y + b.y) / 2 - k / 2 });
  });
  const range = h('input', { type: 'range', min: 0.05, max: 1, step: 0.01, value: ref.opacity });
  range.addEventListener('input', () => set({ opacity: Number(range.value) }, true));
  range.addEventListener('change', () => set({ opacity: Number(range.value) }));
  sec.append(
    h('div', { class: 'row' },
      h('span', { class: 'v', style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: ref.name || '' }, ref.name || 'image'),
      load, paste, remove),
    h('div', { class: 'row' }, edit),
    h('div', { class: 'grid2' },
      numberField({ label: 'X', value: ref.x / 10, digits: 2, step: 0.5, onCommit: v => set({ x: v * 10 }), disabled: !!ref.locked }),
      numberField({ label: 'Y', value: ref.y / 10, digits: 2, step: 0.5, onCommit: v => set({ y: v * 10 }), disabled: !!ref.locked })),
    h('div', { class: 'grid2' },
      numberField({
        label: 'W', value: ref.width / 10, digits: 2, min: 0.1, step: 0.5, disabled: !!ref.locked,
        onCommit: v => set(ref.keepAspect === false ? { width: v * 10 } : { width: v * 10, height: v * 10 / ref.aspect })
      }),
      numberField({
        label: 'H', value: ref.height / 10, digits: 2, min: 0.1, step: 0.5, disabled: !!ref.locked,
        onCommit: v => set(ref.keepAspect === false ? { height: v * 10 } : { height: v * 10, width: v * 10 * ref.aspect })
      })),
    row('Opacity', range),
    h('div', { class: 'btn-row', style: { marginBottom: '8px' } }, fitMap, fillMap, fitView),
    h('div', { class: 'row' },
      toggle({ checked: ref.visible, label: 'Show', onChange: v => set({ visible: v }) }),
      toggle({ checked: ref.above, label: 'Above the map', onChange: v => set({ above: v }) })),
    h('div', { class: 'row' },
      toggle({ checked: ref.keepAspect !== false, label: 'Keep proportions', onChange: v => set({ keepAspect: v }) }),
      toggle({
        checked: !!ref.locked, label: 'Lock',
        onChange: v => { if (v && ed.state.tool === 'reference') ed.setTool('select'); set({ locked: v }); }
      })),
    ref.naturalWidth
      ? h('p', { class: 'muted', style: { margin: '4px 0 0' } },
        `Image ${ref.naturalWidth} x ${ref.naturalHeight} px, shown at ${(ref.width / ref.naturalWidth * 10).toFixed(2)} image px per map unit.`)
      : null);
  return sec;
}

// ------------------------------------------------------------------ history

function historyPanel(ed, el) {
  let scheduled = 0;
  const render = () => {
    scheduled = 0;
    clear(el);
    const hist = ed.doc.history;
    const undo = hist.undoStack, redo = hist.redoStack;
    const goTo = target => {
      // target: number of undo entries that should remain
      while (hist.undoStack.length > target && hist.canUndo) hist.undo();
      while (hist.undoStack.length < target && hist.canRedo) hist.redo();
    };
    const top = h('div', { class: 'obj-row' + (undo.length === 0 ? ' sel' : ''), style: { paddingLeft: '12px' } }, h('span', { class: 'oname' }, 'Opened / new map'));
    top.addEventListener('click', () => goTo(0));
    el.append(top);
    undo.forEach((entry, i) => {
      const r = h('div', { class: 'obj-row' + (i === undo.length - 1 ? ' sel' : ''), style: { paddingLeft: '12px' } },
        h('span', { class: 'oname' }, entry.label || 'Edit'),
        h('span', { class: 'meta' }, `${entry.before.size} obj`));
      r.addEventListener('click', () => goTo(i + 1));
      el.append(r);
    });
    for (let i = redo.length - 1; i >= 0; i--) {
      const entry = redo[i];
      const r = h('div', { class: 'obj-row', style: { paddingLeft: '12px', opacity: 0.45 } },
        h('span', { class: 'oname' }, entry.label || 'Edit'),
        h('span', { class: 'meta' }, 'undone'));
      r.addEventListener('click', () => goTo(undo.length + (redo.length - i)));
      el.append(r);
    }
    el.scrollTop = el.scrollHeight;
  };
  const schedule = () => { if (!scheduled) scheduled = nextFrame(render); };
  ed.on('doc', schedule);
  render();
}
