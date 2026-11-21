// Draw Inside silhouette masking mode (Shift+D).
// While active, every polygon committed by pen, rect, ellipse, or polygon is
// clipped to the selected mask polygon and placed on the active layer (directly
// above the mask when on the same layer) in a single undoable transaction.

import { LAYER_BY_ID, KIND_BY_TYPE } from '../engine/layers.js';
import {
  clipToMask,
  insertMaskedPieces,
  isWaterMaskConflict
} from '../engine/mask.js';
import { h, clear } from './dom.js';

export function drawInsideCommand(ed) {
  return {
    id: 'obj.drawInside',
    label: 'Draw inside mask',
    keys: 'Shift+D',
    checked: () => !!ed.drawInside?.active,
    enabled: () => !!ed.drawInside?.canToggle(),
    run: () => ed.drawInside?.toggle()
  };
}

export class DrawInside {
  constructor(ed) {
    this.ed = ed;
    this.active = false;
    this.maskUid = null;
    this.anchorUid = null;
    this.overlayCanvas = null;
    this.hud = null;
    this.raf = 0;
    this._lastAnimMs = 0;
    this._accent = null;

    ed.on?.('doc', reason => {
      if (!this.active) return;
      if (reason === 'load' || !this.mask()) this.exit({ silent: true });
      else {
        this.updateHud();
        this.drawOutlineOnly();
      }
    });
    ed.on?.('layer', () => {
      if (this.active) this.updateHud();
    });
    ed.on?.('rendered', () => {
      if (this.active) this.drawOutlineOnly();
    });
  }

  mask() {
    if (!this.active || this.maskUid == null) return null;
    return this.ed.doc?.get(this.maskUid) || null;
  }

  canToggle() {
    if (this.active) return true;
    const sel = this.ed.selected?.() || [];
    return sel.length === 1 && KIND_BY_TYPE[sel[0].type] === 'poly' && (sel[0].points?.length ?? 0) >= 3;
  }

  toggle() {
    return this.active ? this.exit() : this.enter();
  }

  enter() {
    const sel = this.ed.selected?.() || [];
    if (sel.length !== 1 || KIND_BY_TYPE[sel[0].type] !== 'poly' || (sel[0].points?.length ?? 0) < 3) {
      this.ed.toast?.('Select a single polygon to enter Draw Inside');
      return false;
    }
    const mask = sel[0];
    this.active = true;
    this.maskUid = mask.uid;
    this.anchorUid = null;
    this.ed.deselect?.();
    this.ensureDom();
    this.updateHud();
    this.drawOutlineOnly();
    this.startAnim();
    this.ed.emit?.('view-options');
    this.ed.emit?.('draw-inside', true);
    this.ed.requestRender?.();

    if (mask.type === 'Wat') {
      this.ed.toast?.('Draw Inside: Water mask (switch active layer from Water to draw inside)');
    } else {
      this.ed.toast?.('Draw Inside active (Esc or Shift+D to exit)');
    }
    return true;
  }

  exit({ silent = false } = {}) {
    if (!this.active) return false;
    const prevMask = this.ed.doc?.get(this.maskUid) || null;
    this.active = false;
    this.maskUid = null;
    this.anchorUid = null;
    this.stopAnim();
    this.clearOutlineCanvas();
    this.updateHud();
    if (!silent && prevMask && this.ed.state?.selection?.size === 0) {
      this.ed.select?.([prevMask]);
    }
    this.ed.emit?.('view-options');
    this.ed.emit?.('draw-inside', false);
    this.ed.requestRender?.();
    if (!silent) this.ed.toast?.('Exited Draw Inside');
    return true;
  }

  // Intercepts polygon commits while active. Returns true when handled (including
  // refusals or empty overlaps) so callers skip unclipped creation.
  commit(layer, strokePoints, label = 'Draw') {
    if (!this.active) return false;
    const mask = this.mask();
    if (!mask || !mask.points || mask.points.length < 3) {
      this.exit({ silent: true });
      return false;
    }
    if (!layer || layer.kind !== 'poly') return false;

    if (isWaterMaskConflict(mask, layer.id)) {
      this.ed.toast?.('Cannot output Water inside a Water mask (switch active layer to draw)', 'err');
      return true;
    }

    const pieces = clipToMask(strokePoints, mask.points);
    if (!pieces.length) {
      this.ed.toast?.('Drawn shape did not overlap the mask (or was < 0.25 u2)');
      return true;
    }

    const made = this.ed.edit(label, () => {
      const liveMask = this.ed.doc.get(this.maskUid);
      const res = insertMaskedPieces(this.ed.doc, {
        maskObj: liveMask,
        layerId: layer.id,
        pieces,
        anchorUid: this.anchorUid,
        makeObject: (type, layerId, pts) => this.ed.newObjectFromBrush(type, layerId, { points: pts })
      });
      return res.ok ? res.created : [];
    });

    if (made?.length) {
      if (layer.id === mask.layerId) this.anchorUid = made[made.length - 1].uid;
      this.ed.select?.(made);
    }
    return true;
  }

  // ---- rendering & overlay ----

  accentColor() {
    if (this._accent) return this._accent;
    if (typeof getComputedStyle === 'function' && typeof document !== 'undefined' && document.documentElement) {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--accent-hi').trim();
      if (v) return (this._accent = v);
    }
    return (this._accent = '#5b9bff');
  }

  ensureDom() {
    if (typeof document === 'undefined' || !this.ed.viewport) return;
    if (!this.overlayCanvas) {
      const c = document.createElement('canvas');
      c.style.cssText = 'position:absolute;inset:0;pointer-events:none;display:none;';
      if (this.ed.canvas?.parentNode === this.ed.viewport) this.ed.canvas.after(c);
      else this.ed.viewport.append(c);
      this.overlayCanvas = c;
    }
    if (!this.hud) {
      const hud = h('div', {
        style: {
          position: 'absolute', left: '50%', top: '10px', transform: 'translateX(-50%)',
          zIndex: '4', display: 'none', alignItems: 'center', gap: '8px',
          padding: '4px 6px 4px 10px', borderRadius: '5px',
          background: 'rgba(17, 20, 26, 0.92)', border: '1px solid var(--accent)',
          boxShadow: '0 6px 20px rgba(0, 0, 0, 0.45)',
          color: 'var(--text)', fontSize: '11.5px', whiteSpace: 'nowrap',
          pointerEvents: 'auto'
        }
      });
      hud.addEventListener('pointerdown', e => e.stopPropagation());
      this.ed.viewport.append(hud);
      this.hud = hud;
    }
  }

  updateHud() {
    if (!this.hud) return;
    clear(this.hud);
    const mask = this.mask();
    if (!this.active || !mask) {
      this.hud.style.display = 'none';
      return;
    }
    const layerTitle = LAYER_BY_ID[mask.layerId]?.title.replace(/s$/, '') || mask.type;
    const maskName = this.ed.meta?.name?.(mask);
    const targetName = maskName ? `${maskName} (${layerTitle})` : layerTitle;
    const watConflict = isWaterMaskConflict(mask, this.ed.state?.activeLayer);
    const exitBtn = h('button', {
      class: 'btn small',
      style: { height: '20px', padding: '0 7px', fontSize: '11px' }
    }, 'Exit');
    exitBtn.addEventListener('click', () => this.exit());

    this.hud.append(
      h('span', { style: { width: '7px', height: '7px', borderRadius: '50%', background: 'var(--accent-hi)', flex: 'none' } }),
      h('span', { style: { fontWeight: '600' } }, 'Draw Inside'),
      h('span', { style: { color: 'var(--text-dim)' } }, targetName),
      watConflict
        ? h('span', { style: { color: 'var(--warn)', fontSize: '11px' } }, 'Switch layer from Water')
        : h('span', { style: { color: 'var(--text-faint)', font: '10.5px var(--mono)' } }, 'Esc / Shift+D'),
      exitBtn
    );
    this.hud.style.display = 'flex';
  }

  startAnim() {
    if (this.raf || typeof requestAnimationFrame !== 'function' || !this.overlayCanvas) return;
    this._lastAnimMs = 0;
    const tick = now => {
      if (!this.active) { this.raf = 0; return; }
      if (now - this._lastAnimMs >= 32) {
        this._lastAnimMs = now;
        this.drawOutlineOnly();
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stopAnim() {
    if (this.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  clearOutlineCanvas() {
    const c = this.overlayCanvas;
    if (!c) return;
    const ctx = c.getContext?.('2d');
    if (ctx) ctx.clearRect(0, 0, c.width, c.height);
    c.style.display = 'none';
  }

  traceMaskScreenPath(ctx, r, pts) {
    const p0 = r.toScreen(pts[0].x, pts[0].y);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < pts.length; i++) {
      const p = r.toScreen(pts[i].x, pts[i].y);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
  }

  strokeAccentDashes(ctx) {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    ctx.strokeStyle = this.accentColor();
    ctx.lineWidth = 1.75;
    ctx.setLineDash([7, 5]);
    ctx.lineDashOffset = -((now * 0.018) % 12);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Dims the canvas outside the mask before tool overlays draw.
  drawOverlay(ctx, r) {
    if (!this.active) return;
    const mask = this.mask();
    if (!mask || !mask.points || mask.points.length < 3 || !r) return;
    ctx.save();
    r.screenTransform();
    ctx.beginPath();
    ctx.rect(0, 0, r.width, r.height);
    this.traceMaskScreenPath(ctx, r, mask.points);
    ctx.fillStyle = 'rgba(11, 14, 19, 0.28)';
    ctx.fill('evenodd');

    ctx.beginPath();
    this.traceMaskScreenPath(ctx, r, mask.points);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(11, 14, 19, 0.75)';
    ctx.lineWidth = 3;
    ctx.stroke();

    if (!this.overlayCanvas) {
      this.strokeAccentDashes(ctx);
    }
    ctx.restore();
  }

  // Draws only the animated dashed outline on its own canvas to avoid full scene redraws.
  drawOutlineOnly() {
    const c = this.overlayCanvas;
    if (!c) return;
    if (!this.active) {
      c.style.display = 'none';
      return;
    }
    const mask = this.mask();
    const r = this.ed.renderer;
    if (!mask || !mask.points || mask.points.length < 3 || !r || !r.width || !r.height) {
      c.style.display = 'none';
      return;
    }
    const dpr = r.dpr || 1;
    const pw = Math.round(r.width * dpr);
    const ph = Math.round(r.height * dpr);
    if (c.width !== pw || c.height !== ph) {
      c.width = pw;
      c.height = ph;
      c.style.width = r.width + 'px';
      c.style.height = r.height + 'px';
    }
    c.style.display = 'block';
    const ctx = c.getContext?.('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    ctx.save();
    ctx.beginPath();
    this.traceMaskScreenPath(ctx, r, mask.points);
    ctx.lineJoin = 'round';
    this.strokeAccentDashes(ctx);
    ctx.restore();
  }
}

export function createDrawInside(ed) {
  return new DrawInside(ed);
}
