// Value View Grayscale (Shift+Y) and Readability Curtain (Shift+C).
// View-only overlays; never modifies the document.

import { bounds, clamp } from '../engine/geometry.js';
import { spriteCorners, spriteSize } from '../engine/document.js';
import { analyzeReadability } from '../engine/readability.js';
import { h } from './dom.js';

export function lensCommands(ed) {
  return [
    {
      id: 'view.grayscale',
      label: 'Value view (grayscale)',
      keys: 'Shift+Y',
      checked: () => !!ed.lens?.grayscaleEnabled,
      run: () => ed.lens?.toggleGrayscale()
    },
    {
      id: 'view.curtain',
      label: 'Readability curtain',
      keys: 'Shift+C',
      checked: () => !!ed.lens?.curtainEnabled,
      run: () => ed.lens?.toggleCurtain()
    }
  ];
}

function roundedRect(ctx, x, y, w, hgt, r) {
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

export class LensController {
  constructor(ed) {
    this.ed = ed;
    this.grayscaleEnabled = false;
    this.curtainEnabled = false;
    this.curtainRatio = 0.5;
    this._readabilityCache = null;
    this._rail = null;
    this._grayBadge = null;
    this._draggingCurtain = false;
    this._monoFont = null;

    ed.on?.('doc', () => {
      this._readabilityCache = null;
      if (this.curtainEnabled) ed.requestRender?.();
    });
    ed.on?.('rendered', () => this._syncDom());
  }

  _mono() {
    if (!this._monoFont) {
      const raw = typeof document !== 'undefined' && document.body
        ? getComputedStyle(document.body).getPropertyValue('--mono').trim()
        : '';
      this._monoFont = raw || 'Consolas, "JetBrains Mono", monospace';
    }
    return this._monoFont;
  }

  toggleGrayscale(on = !this.grayscaleEnabled) {
    this.grayscaleEnabled = Boolean(on);
    if (this.ed.canvas) {
      this.ed.canvas.style.filter = this.grayscaleEnabled ? 'grayscale(1)' : '';
    }
    this._syncGrayBadge();
    this.ed.emit?.('view-options');
    this.ed.requestRender?.();
    return this.grayscaleEnabled;
  }

  toggleCurtain(on = !this.curtainEnabled) {
    this.curtainEnabled = Boolean(on);
    if (!this.curtainEnabled) this._draggingCurtain = false;
    this._syncDom();
    this.ed.emit?.('view-options');
    this.ed.requestRender?.();
    return this.curtainEnabled;
  }

  setCurtainRatio(ratio) {
    if (!Number.isFinite(ratio)) return;
    this.curtainRatio = clamp(ratio, 0.02, 0.98);
    this._syncDom();
    this.ed.requestRender?.();
  }

  curtainScreenX() {
    const w = this.ed.renderer?.width || 0;
    return Math.round(this.curtainRatio * w);
  }

  getReadability() {
    const doc = this.ed.doc;
    const rev = doc?.revision ?? 0;
    if (this._readabilityCache && this._readabilityCache.doc === doc && this._readabilityCache.rev === rev) {
      return this._readabilityCache.data;
    }
    const data = analyzeReadability(doc, this.ed.catalog);
    this._readabilityCache = { doc, rev, data, geom: null };
    return data;
  }

  _readabilityGeom(read) {
    const doc = this.ed.doc;
    const liveDrag = Boolean(doc?.history?.open || this.ed.tool?.drag);
    if (!liveDrag && this._readabilityCache?.data === read && this._readabilityCache.geom) {
      return this._readabilityCache.geom;
    }
    const catalog = this.ed.catalog;
    const geom = {
      deceptiveBgs: read.deceptiveBgs.map(bg => ({ bg, b: bounds(bg.points) })),
      coverHides: read.coverHides.map(hs => {
        const corners = spriteCorners(hs, spriteSize(hs, catalog));
        return { hs, corners, b: bounds(corners) };
      }),
      misleadingHides: read.misleadingHides.map(hs => {
        const corners = spriteCorners(hs, spriteSize(hs, catalog));
        return { hs, corners, b: bounds(corners) };
      })
    };
    if (!liveDrag && this._readabilityCache?.data === read) {
      this._readabilityCache.geom = geom;
    }
    return geom;
  }

  renderState() {
    const xray = this.curtainEnabled
      ? { splitX: this.curtainScreenX(), readability: this.getReadability() }
      : null;
    return { xray };
  }

  _syncGrayBadge() {
    if (typeof document === 'undefined') return;
    const hud = document.getElementById('hud');
    if (!hud) return;
    if (this.grayscaleEnabled) {
      if (!this._grayBadge) {
        this._grayBadge = h('div', { class: 'hud-pill', style: { marginRight: '6px' } }, 'Value: Grayscale (Shift+Y)');
      }
      if (!this._grayBadge.isConnected) hud.append(this._grayBadge);
    } else if (this._grayBadge?.isConnected) {
      this._grayBadge.remove();
    }
  }

  _ensureRail() {
    if (this._rail || typeof document === 'undefined' || !this.ed.viewport) return;
    const rail = h('div', {
      title: 'Drag to move Readability Curtain (double-click to reset)',
      style: {
        position: 'absolute',
        top: '0',
        bottom: '0',
        width: '14px',
        marginLeft: '-7px',
        cursor: 'ew-resize',
        zIndex: '4',
        background: 'transparent',
        display: 'none'
      }
    });

    const updateFromClientX = clientX => {
      const rect = this.ed.viewport.getBoundingClientRect();
      if (!rect.width) return;
      this.curtainRatio = clamp((clientX - rect.left) / rect.width, 0.02, 0.98);
      this._syncDom();
      this.ed.requestRender?.();
    };

    rail.addEventListener('pointerdown', e => {
      if (e.button !== 0 || this.ed.isSpacePan?.() || this.ed.pickPoint || this.ed.pickRect) return;
      e.stopPropagation();
      e.preventDefault();
      this._draggingCurtain = true;
      rail.setPointerCapture(e.pointerId);
      updateFromClientX(e.clientX);
    });
    rail.addEventListener('pointermove', e => {
      if (!this._draggingCurtain) return;
      e.stopPropagation();
      updateFromClientX(e.clientX);
    });
    const stopDrag = e => {
      if (!this._draggingCurtain) return;
      this._draggingCurtain = false;
      rail.releasePointerCapture?.(e.pointerId);
    };
    rail.addEventListener('pointerup', stopDrag);
    rail.addEventListener('pointercancel', stopDrag);
    rail.addEventListener('dblclick', e => {
      e.stopPropagation();
      this.setCurtainRatio(0.5);
    });

    this.ed.viewport.append(rail);
    this._rail = rail;
  }

  _syncDom() {
    this._syncGrayBadge();
    if (!this.curtainEnabled && !this._rail) return;
    this._ensureRail();
    if (!this._rail) return;
    if (!this.curtainEnabled) {
      this._rail.style.display = 'none';
      return;
    }
    const splitX = this.curtainScreenX();
    this._rail.style.display = 'block';
    this._rail.style.left = splitX + 'px';
    this._rail.style.pointerEvents = (this.ed.pickPoint || this.ed.pickRect) ? 'none' : 'auto';
  }

  // Drawn in screen space after r.screenTransform().
  drawOverlay(ctx, r) {
    if (this.curtainEnabled) this._drawCurtainOverlay(ctx, r);
  }

  _drawCurtainOverlay(ctx, r) {
    const splitX = this.curtainScreenX();
    const read = this.getReadability();
    const geom = this._readabilityGeom(read);
    const visible = this.ed.state?.visible;
    const z = r.view.zoom || 1;
    const mono = this._mono();

    const wTL = r.toWorld(splitX, 0);
    const wBR = r.toWorld(r.width, r.height);
    const visMinX = Math.min(wTL.x, wBR.x);
    const visMaxX = Math.max(wTL.x, wBR.x);
    const visMinY = Math.min(wTL.y, wBR.y);
    const visMaxY = Math.max(wTL.y, wBR.y);

    // Right-half diagnostics clipped to the curtain split.
    ctx.save();
    ctx.beginPath();
    ctx.rect(splitX, 0, Math.max(0, r.width - splitX), r.height);
    ctx.clip();

    if (!visible || visible.has('background-terrains')) {
      for (let i = 0; i < geom.deceptiveBgs.length; i++) {
        const { bg, b } = geom.deceptiveBgs[i];
        if (b.x + b.width < visMinX || b.x > visMaxX || b.y + b.height < visMinY || b.y > visMaxY) continue;
        ctx.save();
        ctx.beginPath();
        for (let k = 0; k < bg.points.length; k++) {
          const s = r.toScreen(bg.points[k].x, bg.points[k].y);
          if (k === 0) ctx.moveTo(s.x, s.y);
          else ctx.lineTo(s.x, s.y);
        }
        ctx.closePath();
        ctx.strokeStyle = '#e3a33b';
        ctx.lineWidth = 2;
        ctx.stroke();
        const scrW = b.width * z;
        const scrH = b.height * z;
        if (scrW >= 46 && scrH >= 20) {
          const center = r.toScreen(b.x + b.width / 2, b.y + b.height / 2);
          const opPct = Math.round(((bg.opacity ?? 1) * 100));
          const tag = `BG ${opPct}%`;
          ctx.font = `600 10px ${mono}`;
          const tw = ctx.measureText(tag).width;
          const pw = tw + 10;
          const ph = 16;
          roundedRect(ctx, center.x - pw / 2, center.y - ph / 2, pw, ph, 3);
          ctx.fillStyle = 'rgba(17, 20, 26, 0.9)';
          ctx.fill();
          ctx.strokeStyle = '#e3a33b';
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.fillStyle = '#f0bf6c';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(tag, center.x, center.y + 0.5);
        }
        ctx.restore();
      }
    }

    if (!visible || visible.has('hide-spaces')) {
      for (let i = 0; i < geom.coverHides.length; i++) {
        const { corners, b } = geom.coverHides[i];
        if (b.x + b.width < visMinX || b.x > visMaxX || b.y + b.height < visMinY || b.y > visMaxY) continue;
        ctx.save();
        ctx.beginPath();
        for (let k = 0; k < corners.length; k++) {
          const s = r.toScreen(corners[k].x, corners[k].y);
          if (k === 0) ctx.moveTo(s.x, s.y);
          else ctx.lineTo(s.x, s.y);
        }
        ctx.closePath();
        ctx.strokeStyle = 'rgba(63, 178, 127, 0.78)';
        ctx.lineWidth = 1.25;
        ctx.stroke();
        ctx.restore();
      }

      for (let i = 0; i < geom.misleadingHides.length; i++) {
        const { corners, b } = geom.misleadingHides[i];
        if (b.x + b.width < visMinX || b.x > visMaxX || b.y + b.height < visMinY || b.y > visMaxY) continue;
        ctx.save();
        ctx.beginPath();
        for (let k = 0; k < corners.length; k++) {
          const s = r.toScreen(corners[k].x, corners[k].y);
          if (k === 0) ctx.moveTo(s.x, s.y);
          else ctx.lineTo(s.x, s.y);
        }
        ctx.closePath();
        ctx.fillStyle = 'rgba(255, 79, 216, 0.14)';
        ctx.fill();
        ctx.strokeStyle = '#ff4fd8';
        ctx.lineWidth = 1.75;
        ctx.stroke();

        const top = r.toScreen(b.x + b.width / 2, b.y);
        const scrW = b.width * z;
        if (scrW >= 18) {
          const label = scrW >= 54 ? 'ABOVE / NO HIDE' : 'NO HIDE';
          ctx.font = `600 9.5px ${mono}`;
          const tw = ctx.measureText(label).width;
          const pw = tw + 14;
          const ph = 15;
          const bx = top.x - pw / 2;
          const by = Math.max(28, top.y - ph - 3);
          roundedRect(ctx, bx, by, pw, ph, 3);
          ctx.fillStyle = 'rgba(17, 20, 26, 0.92)';
          ctx.fill();
          ctx.strokeStyle = '#ff4fd8';
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.fillStyle = '#ff4fd8';
          ctx.beginPath();
          ctx.arc(bx + 6, by + ph / 2, 2.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#f8c4ee';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, bx + 11, by + ph / 2 + 0.5);
        } else {
          ctx.fillStyle = '#ff4fd8';
          ctx.beginPath();
          ctx.arc(top.x, top.y, 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }
    ctx.restore();

    // Vertical divider, handle and top labels.
    ctx.save();
    ctx.strokeStyle = 'rgba(11, 14, 19, 0.75)';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(splitX + 0.5, 0);
    ctx.lineTo(splitX + 0.5, r.height);
    ctx.stroke();

    ctx.strokeStyle = '#5b9bff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(splitX + 0.5, 0);
    ctx.lineTo(splitX + 0.5, r.height);
    ctx.stroke();

    const midY = Math.round(r.height / 2);
    const gw = 12;
    const gh = 36;
    roundedRect(ctx, splitX - gw / 2 + 0.5, midY - gh / 2, gw, gh, 4);
    ctx.fillStyle = '#161a22';
    ctx.fill();
    ctx.strokeStyle = '#5b9bff';
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.strokeStyle = '#8b93a5';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(splitX - 1.5, midY - 8);
    ctx.lineTo(splitX - 1.5, midY + 8);
    ctx.moveTo(splitX + 2.5, midY - 8);
    ctx.lineTo(splitX + 2.5, midY + 8);
    ctx.stroke();

    ctx.font = `600 10px ${mono}`;
    const drawChip = (text, x, alignRight = false, border = '#323a4a', color = '#d6dbe4') => {
      const tw = ctx.measureText(text).width;
      const pw = tw + 12;
      const ph = 18;
      const rx = alignRight ? x - pw : x;
      if (rx < 4 || rx + pw > r.width - 4) return;
      roundedRect(ctx, rx, 10, pw, ph, 4);
      ctx.fillStyle = 'rgba(17, 20, 26, 0.9)';
      ctx.fill();
      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, rx + 6, 19.5);
    };

    drawChip('ART', splitX - 8, true);
    const warnParts = [];
    if (read.deceptiveBgs.length) warnParts.push(`${read.deceptiveBgs.length} BG`);
    if (read.misleadingHides.length) warnParts.push(`${read.misleadingHides.length} H`);
    const rightLabel = warnParts.length ? `X-RAY (${warnParts.join(' / ')})` : 'X-RAY';
    drawChip(rightLabel, splitX + 8, false, '#3b82f6', '#e8ecf3');
    ctx.restore();
  }
}

export function createLens(ed) {
  return new LensController(ed);
}
