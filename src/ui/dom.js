// Minimal DOM helpers. Text is always inserted as text, never parsed as HTML,
// except trusted icon markup passed through `html`.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// requestAnimationFrame with a timer fallback: Chromium suspends animation frames for
// hidden or fully occluded windows, which must not leave the editor unpainted.
export function nextFrame(fn) {
  let done = false;
  const run = () => { if (done) return; done = true; cancelAnimationFrame(raf); clearTimeout(timer); fn(); };
  const raf = requestAnimationFrame(run);
  const timer = setTimeout(run, 120);
  return () => { done = true; cancelAnimationFrame(raf); clearTimeout(timer); };
}

export function clear(el) {
  if (activePixelSampler && activePixelSamplerButton && el.contains(activePixelSamplerButton)) activePixelSampler();
  while (el.firstChild) el.firstChild.remove();
  return el;
}

export function fmt(v, digits = 2) {
  if (!Number.isFinite(v)) return '';
  const s = v.toFixed(digits);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

// Numeric field with scrubbing (drag on the label), arrow-key stepping and Enter/blur commit.
export function numberField({
  label, value, step = 1, min = -Infinity, max = Infinity,
  digits = 2, suffix = '', onCommit, title, disabled = false, mixed = false
}) {
  const input = h('input', { class: 'num', type: 'text', inputmode: 'decimal', spellcheck: 'false', disabled });
  input.value = mixed ? '' : fmt(value, digits);
  if (mixed) input.placeholder = 'mixed';
  const commit = raw => {
    let v = Number(String(raw).replace(',', '.'));
    if (!Number.isFinite(v)) { input.value = mixed ? '' : fmt(value, digits); return; }
    v = Math.min(max, Math.max(min, v));
    input.value = fmt(v, digits);
    if (v !== value || mixed) { value = v; mixed = false; onCommit(v); }
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { commit(input.value); input.select(); }
    else if (e.key === 'Escape') { input.value = mixed ? '' : fmt(value, digits); input.blur(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const k = (e.shiftKey ? 10 : e.altKey ? 0.1 : 1) * step * (e.key === 'ArrowUp' ? 1 : -1);
      commit((Number(input.value) || 0) + k);
    }
    e.stopPropagation();
  });
  input.addEventListener('blur', () => { if (input.value !== '' || !mixed) commit(input.value); });
  input.addEventListener('focus', () => input.select());
  const lab = h('span', { class: 'num-label', title: title || '' }, label);
  if (!disabled) {
    lab.addEventListener('pointerdown', e => {
      const start = e.clientX, base = Number(input.value) || 0;
      lab.setPointerCapture(e.pointerId);
      let moved = false;
      const move = ev => {
        const dx = ev.clientX - start;
        if (Math.abs(dx) > 2) moved = true;
        if (moved) input.value = fmt(Math.min(max, Math.max(min, base + Math.round(dx / 2) * step * (ev.shiftKey ? 10 : 1))), digits);
      };
      const up = () => {
        lab.removeEventListener('pointermove', move);
        lab.removeEventListener('pointerup', up);
        if (moved) commit(input.value); else input.focus();
      };
      lab.addEventListener('pointermove', move);
      lab.addEventListener('pointerup', up);
    });
  }
  const el = h('label', { class: 'field' + (suffix ? ' has-suffix' : ''), title: title || '' },
    lab, input, suffix ? h('span', { class: 'suffix' }, suffix) : null);
  el.setValue = next => {
    if (!Number.isFinite(next)) return;
    value = Math.min(max, Math.max(min, next));
    mixed = false;
    if (document.activeElement !== input) input.value = fmt(value, digits);
  };
  return el;
}

const PIPETTE_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 2.5a1.8 1.8 0 0 0-2.5 0L8.8 4.7 7.5 3.4 6.4 4.5l1 1-4.6 4.6-.8 3.4 3.4-.8 4.6-4.6 1 1 1.1-1.1-1.3-1.3 2.2-2.2a1.8 1.8 0 0 0 0-2.5z"/></svg>';

let activePixelSampler = null;
let activePixelSamplerButton = null;

// Starts a one-shot pixel colour picker over the #scene canvas. Returns a cancel function.
export function sampleCanvasPixel(onPick, { button = null, onEnd = null } = {}) {
  if (activePixelSampler) activePixelSampler();
  const canvas = document.getElementById('scene');
  if (!canvas) {
    window.mmp?.toast?.('Canvas is not available for colour sampling', 'err');
    return () => {};
  }
  const vp = document.getElementById('viewport');
  const prevCursor = vp ? vp.style.cursor : '';
  if (vp) vp.style.cursor = 'crosshair';
  button?.classList.add('on');
  window.mmp?.toast?.('Click on the canvas to sample a pixel (Esc cancels)');

  const chip = h('div', {
    style: {
      position: 'fixed', pointerEvents: 'none', zIndex: '2500', display: 'none',
      alignItems: 'center', gap: '6px', padding: '3px 7px', borderRadius: '4px',
      background: 'rgba(17,20,26,0.92)', border: '1px solid #323a4a',
      font: '11px var(--mono)', color: '#d6dbe4', boxShadow: '0 4px 12px rgba(0,0,0,0.45)'
    }
  });
  const sw = h('span', { style: { width: '12px', height: '12px', borderRadius: '2px', border: '1px solid rgba(255,255,255,0.25)' } });
  const tx = h('span', {});
  chip.append(sw, tx);
  document.body.append(chip);

  const readHex = (clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height || !canvas.width || !canvas.height) return null;
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
    const x = Math.max(0, Math.min(canvas.width - 1, Math.floor((clientX - rect.left) * (canvas.width / rect.width))));
    const y = Math.max(0, Math.min(canvas.height - 1, Math.floor((clientY - rect.top) * (canvas.height / rect.height))));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const d = ctx.getImageData(x, y, 1, 1).data;
    return '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
  };

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    if (activePixelSampler === cleanup) { activePixelSampler = null; activePixelSamplerButton = null; }
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', cleanup);
    chip.remove();
    button?.classList.remove('on');
    if (vp) vp.style.cursor = prevCursor;
    onEnd?.();
  };

  const onMove = e => {
    if (button && !button.isConnected) { cleanup(); return; }
    const hex = readHex(e.clientX, e.clientY);
    if (!hex) { chip.style.display = 'none'; return; }
    chip.style.display = 'flex';
    chip.style.left = Math.min(e.clientX + 14, window.innerWidth - 96) + 'px';
    chip.style.top = Math.min(e.clientY + 14, window.innerHeight - 28) + 'px';
    sw.style.background = hex;
    tx.textContent = hex;
  };

  const swallowOnce = evName => {
    const hnd = ev => { ev.preventDefault(); ev.stopPropagation(); window.removeEventListener(evName, hnd, true); };
    window.addEventListener(evName, hnd, true);
    setTimeout(() => window.removeEventListener(evName, hnd, true), 400);
  };

  const onDown = e => {
    if (button && !button.isConnected) { cleanup(); return; }
    if (button && (e.target === button || button.contains(e.target))) return;
    e.preventDefault();
    e.stopPropagation();
    swallowOnce('pointerup');
    swallowOnce('click');
    const hex = e.button === 0 ? readHex(e.clientX, e.clientY) : null;
    cleanup();
    if (hex) onPick(hex);
  };

  const onKey = e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    }
  };

  activePixelSampler = cleanup;
  activePixelSamplerButton = button || null;
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', cleanup);
  return cleanup;
}

export function colorField({ value, onCommit, title, onSample, onFocusField }) {
  const input = h('input', { type: 'color', value, title: title || '' });
  input.addEventListener('change', () => onCommit(input.value));
  if (onFocusField) {
    input.addEventListener('focus', () => onFocusField());
    input.addEventListener('pointerdown', () => onFocusField());
  }
  let cancel = null;
  const pick = h('button', {
    type: 'button',
    class: 'btn icon flat small',
    html: PIPETTE_SVG,
    'data-tip': 'Sample colour from canvas (Esc cancels)',
    style: { width: '22px', height: '24px', padding: '0', flex: 'none' }
  });
  pick.addEventListener('click', e => {
    e.stopPropagation();
    onFocusField?.();
    if (cancel) { cancel(); cancel = null; return; }
    if (onSample) {
      onSample(hex => { input.value = hex; onCommit(hex); });
      return;
    }
    cancel = sampleCanvasPixel(hex => {
      input.value = hex;
      onCommit(hex);
    }, { button: pick, onEnd: () => { cancel = null; } });
  });
  return h('span', {
    class: 'color-field',
    style: { display: 'inline-flex', alignItems: 'center', gap: '2px', flex: 'none' }
  }, input, pick);
}

export function select({ value, options, onChange, title }) {
  const s = h('select', { title: title || '' },
    options.map(o => h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label)));
  s.addEventListener('change', () => onChange(s.value));
  s.addEventListener('keydown', e => e.stopPropagation());
  return s;
}

export function toggle({ checked, label, onChange, title }) {
  const input = h('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'toggle', title: title || '' }, input, h('span', { class: 'track' }), h('span', {}, label));
}
