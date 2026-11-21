// On-canvas gradient stop pins and "Match seam" chips for Sky / Wat polygons.

import { clamp, hexToInt, intToHex } from '../engine/geometry.js';
import {
  isGradientObject,
  isThinSky,
  normalizeGradientColors,
  gradientSpan,
  setGradientStop,
  matchSeam,
  findGradientSeams
} from '../engine/gradient.js';
import { h, clear, colorField } from './dom.js';

const MIN_SHAPE_SCREEN_HEIGHT = 24;
const ACTIVE_TOOLS = new Set(['select', 'move', 'rotate']);
const PIN_SIZE = 14;
const PIN_RADIUS = 3.5;
const PIN_HIT_HALF = 10;
const CHIP_HEIGHT = 20;
const CHIP_PAD_X = 7;
const CHIP_RADIUS = 4;
const UI_FONT = '500 11px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
const MONO_FONT = '11px "JetBrains Mono", "Cascadia Mono", Consolas, ui-monospace, monospace';

function sameColors(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (hexToInt(a[i]) !== hexToInt(b[i])) return false;
  }
  return true;
}

function roundRectPath(ctx, x, y, w, hgt, r) {
  const rad = Math.min(r, w / 2, hgt / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + hgt - rad);
  ctx.quadraticCurveTo(x + w, y + hgt, x + w - rad, y + hgt);
  ctx.lineTo(x + rad, y + hgt);
  ctx.quadraticCurveTo(x, y + hgt, x, y + hgt - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

export function applyStopColor(ed, obj, stop, hexOrInt) {
  if (!ed?.doc || !obj) return false;
  const live = ed.doc.get(obj.uid);
  if (!live || !isGradientObject(live)) return false;
  if (ed.state?.locked?.has(live.layerId)) {
    ed.toast?.('Layer is locked', 'err');
    return false;
  }
  const tp = Boolean(ed.state?.testerPreview || ed.state?.view?.testerPreview);
  const effectiveStop = (stop === 'bottom' && tp && (live.colors?.length ?? 0) > 2) ? 1 : stop;
  const next = setGradientStop(live, effectiveStop, hexOrInt);
  if (sameColors(live.colors, next)) return false;
  ed.edit('Gradient colour', () => {
    ed.doc.touch(live);
    live.colors = next;
  });
  return true;
}

export function applyMatchSeam(ed, seam) {
  if (!ed?.doc || !seam?.upper || !seam?.lower) return false;
  const upper = ed.doc.get(seam.upper.uid);
  const lower = ed.doc.get(seam.lower.uid);
  if (!upper || !lower) return false;
  if (ed.state?.locked?.has(lower.layerId)) {
    ed.toast?.('Layer is locked', 'err');
    return false;
  }
  const tp = Boolean(ed.state?.testerPreview || ed.state?.view?.testerPreview);
  const res = matchSeam(upper, lower, { seamY: seam.seamY, testerPreview: tp });
  if (!res || (!res.upperChanged && !res.lowerChanged)) {
    ed.toast?.('Seam already matched');
    return false;
  }
  if (res.upperChanged && ed.state?.locked?.has(upper.layerId)) {
    ed.toast?.('Upper layer is locked', 'err');
    return false;
  }
  ed.edit('Match seam', () => {
    if (res.upperChanged) {
      ed.doc.touch(upper);
      upper.colors = res.upperColors;
    }
    if (res.lowerChanged) {
      ed.doc.touch(lower);
      lower.colors = res.lowerColors;
    }
  });
  ed.toast?.(`Matched seam to ${res.hex}`, 'ok');
  return true;
}

export function createGradientHandles(ed) {
  let hover = null;   // { kind: 'pin', stop } | { kind: 'seam', seamIndex }
  let pressed = null; // { hit, sx, sy }
  let layout = null;
  let seamCache = null; // { rev, uid, tp, seams }
  let picker = null;  // { el, uid, stop, sync() }

  function closePicker() {
    if (!picker) return;
    clear(picker.el);
    picker.el.remove();
    picker = null;
    ed.requestRender();
  }

  function getSeams(obj, tp) {
    const rev = ed.doc.revision;
    if (seamCache && seamCache.rev === rev && seamCache.uid === obj.uid && seamCache.tp === tp) {
      return seamCache.seams;
    }
    const candidates = ed.state.visible.has(obj.layerId) ? (ed.doc.layers[obj.layerId] || []) : [];
    const seams = findGradientSeams(obj, candidates, { testerPreview: tp });
    seamCache = { rev, uid: obj.uid, tp, seams };
    return seams;
  }

  function computeAxisScreenX(r, b) {
    const tl = r.toScreen(b.x, b.y);
    const br = r.toScreen(b.x + b.width, b.y + b.height);
    const screenW = br.x - tl.x;
    if (screenW < 36) {
      return { ax: br.x + 18, leaderX: br.x };
    }
    const minX = tl.x + 18;
    const maxX = br.x - 18;
    const vpMin = Math.max(minX, 44);
    const vpMax = Math.min(maxX, r.width - 44);
    let ax = vpMin <= vpMax
      ? clamp((tl.x + br.x) / 2, vpMin, vpMax)
      : clamp((tl.x + br.x) / 2, minX, maxX);

    // Avoid overlapping the transform box's top-middle / bottom-middle resize handles.
    const midX = (tl.x + br.x) / 2;
    if (Math.abs(ax - midX) < 16) {
      const right = midX + 24;
      const left = midX - 24;
      if (right <= maxX && right <= r.width - 44) ax = right;
      else if (left >= minX && left >= 44) ax = left;
      else if (right <= maxX) ax = right;
      else if (left >= minX) ax = left;
    }
    return { ax, leaderX: null };
  }

  function computeLayout(ctx, r) {
    if (!r || r.gameView) return null;
    if (!ACTIVE_TOOLS.has(ed.state.tool)) return null;
    if (ed.pickPoint || ed.pickRect || ed.tool?.drag || ed.tool?.marquee) return null;

    const sel = ed.selected();
    if (sel.length !== 1) return null;
    const obj = sel[0];
    if (!isGradientObject(obj) || !ed.state.visible.has(obj.layerId)) return null;

    const span = gradientSpan(obj);
    if (!span) return null;
    const b = span.bounds;
    const z = r.view.zoom || 1;
    if (b.height * z < MIN_SHAPE_SCREEN_HEIGHT) return null;

    const { ax, leaderX } = computeAxisScreenX(r, b);
    const axisWorldX = r.toWorld(ax, 0).x;
    const topY = r.toScreen(axisWorldX, span.top).y;
    const botY = r.toScreen(axisWorldX, span.bottom).y;

    const tp = Boolean(ed.state.testerPreview || ed.state.view?.testerPreview);
    const colors = normalizeGradientColors(obj.colors);
    const thin = isThinSky(obj, b);
    const topColor = colors[0];
    const bottomColor = thin ? colors[0] : (tp ? colors[1] : colors[colors.length - 1]);

    const pins = [
      {
        kind: 'pin',
        stop: 'top',
        label: thin ? 'Solid (< 0.15 u)' : 'Top stop',
        x: ax,
        y: topY,
        color: topColor,
        hex: intToHex(topColor)
      },
      {
        kind: 'pin',
        stop: 'bottom',
        label: thin ? 'Solid (< 0.15 u)' : 'Bottom stop',
        x: ax,
        y: botY,
        color: bottomColor,
        hex: intToHex(bottomColor)
      }
    ];

    const seams = getSeams(obj, tp);
    const chips = [];
    if (seams.length) {
      if (ctx) ctx.font = UI_FONT;
      const vpLeftW = r.toWorld(48, 0).x;
      const vpRightW = r.toWorld(r.width - 48, 0).x;

      for (let i = 0; i < seams.length; i++) {
        const seam = seams[i];
        const text = seam.alreadyMatched ? 'Matched' : 'Match seam';
        const textW = ctx ? ctx.measureText(text).width : text.length * 6.2;
        const w = Math.ceil(CHIP_PAD_X * 2 + 12 + textW);
        const hgt = CHIP_HEIGHT;

        const clampMin = Math.max(seam.x0, vpLeftW);
        const clampMax = Math.min(seam.x1, vpRightW);
        const worldX = clampMin <= clampMax ? clamp(seam.seamX, clampMin, clampMax) : seam.seamX;
        const pt = r.toScreen(worldX, seam.seamY);

        let cx = pt.x;
        const cy = pt.y;
        // Keep the chip clear of the stop pin sitting on the same y boundary.
        const nearTop = Math.abs(cy - topY) < 16;
        const nearBot = Math.abs(cy - botY) < 16;
        if ((nearTop || nearBot) && Math.abs(cx - ax) < w / 2 + 16) {
          const rightCx = ax + 16 + w / 2;
          const leftCx = ax - 16 - w / 2;
          cx = rightCx + w / 2 <= r.width - 8 ? rightCx : leftCx;
        }
        for (const prev of chips) {
          if (Math.abs(cy - prev.cy) < hgt + 4 && Math.abs(cx - prev.cx) < (w + prev.w) / 2 + 6) {
            cx = prev.x + prev.w + 6 + w / 2;
          }
        }
        cx = clamp(cx, w / 2 + 6, Math.max(w / 2 + 6, r.width - w / 2 - 6));

        chips.push({
          kind: 'seam',
          seamIndex: i,
          seam,
          text,
          x: cx - w / 2,
          y: cy - hgt / 2,
          w,
          h: hgt,
          cx,
          cy
        });
      }
    }

    return { obj, span, thin, ax, leaderX, topY, botY, pins, chips };
  }

  function hitTestLayout(cur, sx, sy) {
    if (!cur) return null;
    for (let i = cur.chips.length - 1; i >= 0; i--) {
      const c = cur.chips[i];
      if (sx >= c.x && sx <= c.x + c.w && sy >= c.y && sy <= c.y + c.h) {
        return { kind: 'seam', seamIndex: c.seamIndex, seam: c.seam, chip: c };
      }
    }
    for (let i = cur.pins.length - 1; i >= 0; i--) {
      const p = cur.pins[i];
      if (Math.abs(sx - p.x) <= PIN_HIT_HALF && Math.abs(sy - p.y) <= PIN_HIT_HALF) {
        return { kind: 'pin', stop: p.stop, pin: p, obj: cur.obj };
      }
    }
    return null;
  }

  function openPicker(pin, obj) {
    closePicker();
    if (!ed.viewport) return;
    if (ed.state.locked.has(obj.layerId)) {
      ed.toast?.('Layer is locked', 'err');
      return;
    }

    const thin = isThinSky(obj);
    const readHex = liveObj => {
      const cols = normalizeGradientColors(liveObj.colors);
      const tp = Boolean(ed.state.testerPreview || ed.state.view?.testerPreview);
      const col = pin.stop === 'top' || thin
        ? cols[0]
        : (tp ? cols[1] : cols[cols.length - 1]);
      return intToHex(col);
    };

    const hexInput = h('input', {
      type: 'text',
      class: 'text',
      value: pin.hex,
      maxlength: '7',
      spellcheck: 'false',
      style: { width: '74px', height: '24px', font: '11px var(--mono)', padding: '0 6px' }
    });

    const commitHex = raw => {
      const trimmed = String(raw || '').trim();
      if (!/^#?[0-9a-f]{6}$/i.test(trimmed)) {
        const live = ed.doc.get(obj.uid);
        if (live) hexInput.value = readHex(live);
        return;
      }
      const norm = (trimmed.startsWith('#') ? '' : '#') + trimmed.toLowerCase();
      const live = ed.doc.get(obj.uid);
      if (!live) return;
      applyStopColor(ed, live, pin.stop, norm);
    };

    const cf = colorField({
      value: pin.hex,
      title: 'Pick colour or sample from canvas',
      onCommit: hex => commitHex(hex)
    });
    const nativeColorInput = cf.querySelector('input[type="color"]');

    hexInput.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { commitHex(hexInput.value); hexInput.select(); }
      else if (e.key === 'Escape') { closePicker(); }
    });
    hexInput.addEventListener('change', () => commitHex(hexInput.value));

    const closeBtn = h('button', {
      type: 'button',
      class: 'btn icon flat small',
      title: 'Close',
      style: { width: '20px', height: '20px', padding: '0', fontSize: '13px', lineHeight: '1' }
    }, '×');
    closeBtn.addEventListener('click', () => closePicker());

    const pop = h('div', {
      style: {
        position: 'absolute',
        zIndex: '40',
        minWidth: '176px',
        padding: '8px',
        borderRadius: '6px',
        background: 'var(--bg2, #161a22)',
        border: '1px solid var(--line2, #323a4a)',
        boxShadow: '0 10px 26px rgba(0, 0, 0, 0.55)',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px'
      }
    },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
        h('span', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--text-dim, #8b93a5)', letterSpacing: '0.02em' } }, pin.label),
        closeBtn
      ),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, cf, hexInput),
      thin
        ? h('div', {
          class: 'muted',
          style: { fontSize: '10.5px', lineHeight: '1.3', maxWidth: '170px' }
        }, 'Thin Sky (< 0.15 u) stays solid [c, c] for the map tester.')
        : null
    );

    pop.addEventListener('pointerdown', e => e.stopPropagation());
    pop.addEventListener('pointerup', e => e.stopPropagation());
    pop.addEventListener('click', e => e.stopPropagation());

    ed.viewport.append(pop);
    const vpW = ed.viewport.clientWidth || ed.renderer.width || 400;
    const vpH = ed.viewport.clientHeight || ed.renderer.height || 300;
    const popW = pop.offsetWidth || 184;
    const popH = pop.offsetHeight || 68;
    const left = pin.x + 16 + popW <= vpW - 8
      ? pin.x + 16
      : Math.max(8, pin.x - 16 - popW);
    const top = clamp(pin.y - popH / 2, 8, Math.max(8, vpH - popH - 8));
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(top) + 'px';

    picker = {
      el: pop,
      uid: obj.uid,
      stop: pin.stop,
      sync() {
        const live = ed.doc.get(obj.uid);
        if (!live || !isGradientObject(live)) { closePicker(); return; }
        const hex = readHex(live);
        if (nativeColorInput) nativeColorInput.value = hex;
        if (document.activeElement !== hexInput) hexInput.value = hex;
      }
    };
    ed.requestRender();
  }

  function sameHit(a, b) {
    if (!a && !b) return true;
    if (!a || !b || a.kind !== b.kind) return false;
    return a.kind === 'pin' ? a.stop === b.stop : a.seamIndex === b.seamIndex;
  }

  function onSelectionOrDocChange() {
    layout = null;
    seamCache = null;
    const sel = ed.selected();
    if (picker) {
      if (sel.length !== 1 || sel[0].uid !== picker.uid) closePicker();
      else picker.sync();
    }
  }

  ed.on('selection', onSelectionOrDocChange);
  ed.on('doc', onSelectionOrDocChange);
  ed.on('layer', () => { layout = null; seamCache = null; });
  ed.on('view', () => { layout = null; closePicker(); });
  ed.on('tool', () => {
    layout = null;
    if (!ACTIVE_TOOLS.has(ed.state.tool)) {
      hover = null;
      pressed = null;
      closePicker();
    }
  });

  function drawOverlay(ctx, r = ed.renderer) {
    const cur = computeLayout(ctx, r);
    layout = cur;
    if (!cur) return;

    const { ax, leaderX, topY, botY, pins, chips } = cur;
    ctx.save();

    if (hover?.kind === 'seam') {
      const chip = chips.find(c => c.seamIndex === hover.seamIndex);
      if (chip && !chip.seam.alreadyMatched) {
        const p0 = r.toScreen(chip.seam.x0, chip.seam.seamY);
        const p1 = r.toScreen(chip.seam.x1, chip.seam.seamY);
        ctx.save();
        ctx.strokeStyle = 'rgba(91, 155, 255, 0.85)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(p0.x, Math.round(p0.y) + 0.5);
        ctx.lineTo(p1.x, Math.round(p1.y) + 0.5);
        ctx.stroke();
        ctx.restore();
      }
    }

    if (leaderX != null) {
      ctx.save();
      ctx.strokeStyle = 'rgba(214, 219, 228, 0.55)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(leaderX, Math.round(topY) + 0.5);
      ctx.lineTo(ax, Math.round(topY) + 0.5);
      ctx.moveTo(leaderX, Math.round(botY) + 0.5);
      ctx.lineTo(ax, Math.round(botY) + 0.5);
      ctx.stroke();
      ctx.restore();
    }

    const lineX = Math.round(ax) + 0.5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(11, 14, 19, 0.72)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(lineX, topY);
    ctx.lineTo(lineX, botY);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.88)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(lineX, topY);
    ctx.lineTo(lineX, botY);
    ctx.stroke();

    // Draw the pin hover tooltip after seam chips so chips never cover it.
    let hoverTip = null;
    for (const pin of pins) {
      const isHovered = hover?.kind === 'pin' && hover.stop === pin.stop;
      const isActive = picker && picker.uid === cur.obj.uid && picker.stop === pin.stop;
      const px = Math.round(pin.x - PIN_SIZE / 2);
      const py = Math.round(pin.y - PIN_SIZE / 2);

      if (isActive || isHovered) {
        roundRectPath(ctx, px - 2, py - 2, PIN_SIZE + 4, PIN_SIZE + 4, PIN_RADIUS + 1.5);
        ctx.strokeStyle = isActive ? '#3b82f6' : '#5b9bff';
        ctx.lineWidth = 1.75;
        ctx.stroke();
      }

      roundRectPath(ctx, px, py, PIN_SIZE, PIN_SIZE, PIN_RADIUS);
      ctx.fillStyle = pin.hex;
      ctx.fill();
      ctx.strokeStyle = 'rgba(11, 14, 19, 0.92)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.25;
      ctx.stroke();

      if (isHovered && !isActive) hoverTip = pin;
    }

    for (const chip of chips) {
      const matched = chip.seam.alreadyMatched;
      const isHovered = hover?.kind === 'seam' && hover.seamIndex === chip.seamIndex;

      roundRectPath(ctx, chip.x, chip.y, chip.w, chip.h, CHIP_RADIUS);
      ctx.fillStyle = matched
        ? 'rgba(17, 20, 26, 0.84)'
        : (isHovered ? 'rgba(29, 34, 44, 0.96)' : 'rgba(17, 20, 26, 0.92)');
      ctx.fill();
      ctx.strokeStyle = matched
        ? 'rgba(63, 178, 127, 0.55)'
        : (isHovered ? '#5b9bff' : '#323a4a');
      ctx.lineWidth = 1;
      ctx.stroke();

      const swX = chip.x + CHIP_PAD_X;
      const swY = chip.cy - 4;
      if (matched) {
        ctx.beginPath();
        ctx.arc(swX + 4, chip.cy, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = '#3fb27f';
        ctx.fill();
      } else {
        roundRectPath(ctx, swX, swY, 8, 8, 2);
        ctx.fillStyle = chip.seam.match.hex;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      ctx.font = UI_FONT;
      ctx.fillStyle = matched ? '#6fd3a5' : '#d6dbe4';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(chip.text, swX + 12, chip.cy + 0.5);
    }

    if (hoverTip) {
      const pin = hoverTip;
      const tip = `${pin.label}  ${pin.hex}`;
      ctx.font = MONO_FONT;
      const tw = ctx.measureText(tip).width;
      const bw = tw + 12;
      const bh = 18;
      const by = clamp(pin.y - bh / 2, 4, r.height - bh - 4);
      const hits = x => chips.some(c => x < c.x + c.w && x + bw > c.x && by < c.y + c.h && by + bh > c.y);
      const rightX = pin.x + 14, leftX = pin.x - 14 - bw;
      const rightOk = rightX + bw <= r.width - 6;
      const bx = rightOk && !hits(rightX) ? rightX : (leftX >= 6 && !hits(leftX) ? leftX : (rightOk ? rightX : leftX));
      roundRectPath(ctx, bx, by, bw, bh, 4);
      ctx.fillStyle = 'rgba(17, 20, 26, 0.92)';
      ctx.fill();
      ctx.strokeStyle = '#323a4a';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#d6dbe4';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(tip, bx + 6, by + bh / 2 + 0.5);
    }

    ctx.restore();
  }

  function hitTest(sx, sy) {
    const cur = layout || computeLayout(ed.renderer?.ctx, ed.renderer);
    return hitTestLayout(cur, sx, sy);
  }

  function onPointerDown(e) {
    if (e.alt && e.shift && !e.ctrl) return false;
    const hit = hitTest(e.sx, e.sy);
    if (!hit) {
      if (picker) closePicker();
      return false;
    }
    pressed = { hit, sx: e.sx, sy: e.sy };
    return true;
  }

  function onPointerMove(e) {
    if (pressed) {
      // Pins are positional only in DPM: dragging vertically moves nothing.
      ed.viewport.style.cursor = pressed.hit.kind === 'seam' ? 'pointer' : 'default';
      return true;
    }
    const wasHover = Boolean(hover);
    const hit = hitTest(e.sx, e.sy);
    if (!sameHit(hit, hover)) {
      hover = hit;
      ed.requestRender();
    }
    if (hit) {
      ed.viewport.style.cursor = hit.kind === 'seam' && hit.seam.alreadyMatched ? 'default' : 'pointer';
      return true;
    }
    if (wasHover) {
      ed.viewport.style.cursor = ed.tool?.cursor || 'default';
    }
    return false;
  }

  function onPointerUp(e) {
    if (!pressed) return false;
    const p = pressed;
    pressed = null;
    const dist = Math.hypot(e.sx - p.sx, e.sy - p.sy);
    const hit = hitTest(e.sx, e.sy);

    if (p.hit.kind === 'pin') {
      const samePin = hit?.kind === 'pin' && hit.stop === p.hit.stop;
      if (dist <= 6 || samePin) {
        if (picker && picker.uid === p.hit.obj.uid && picker.stop === p.hit.stop) {
          closePicker();
        } else {
          openPicker(p.hit.pin, p.hit.obj);
        }
      }
      return true;
    }

    if (p.hit.kind === 'seam') {
      const sameChip = hit?.kind === 'seam' && hit.seamIndex === p.hit.seamIndex;
      if (dist <= 6 || sameChip) {
        applyMatchSeam(ed, p.hit.seam);
      }
      return true;
    }

    return true;
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && picker) {
      closePicker();
      return true;
    }
    return false;
  }

  function cancel() {
    pressed = null;
    hover = null;
  }

  return {
    drawOverlay,
    hitTest,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onKeyDown,
    cancel,
    closePicker
  };
}
