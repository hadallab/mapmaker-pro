// Canvas renderer. Visual layers, texture scale (0.1), Bg/Air texture offsets, gradient
// spans, water/air border strips and sprite anchoring follow the official engine so the
// canvas matches what Mapmaker shows.

import { LAYERS, Z_ORDER, HABITAT_AREAS, HABITAT_GROUPS, KIND_BY_TYPE } from './layers.js';
import { bounds, isClockwise, makeBrighter, mixColors, intToHex } from './geometry.js';
import { spriteSize } from './document.js';
import {
  testerGradientColors,
  isThinTwoStopSky,
  gradientTopSeam,
  diagnoseTeleports,
  teleportActionSummary
} from './tester.js';

const HELPER_STYLE = {
  Cu: { fill: 'rgba(80, 180, 255, 0.16)', stroke: 'rgba(120, 200, 255, 0.9)' },
  Food: { fill: 'rgba(70, 210, 120, 0.18)', stroke: 'rgba(90, 230, 140, 0.95)' },
  NPC: { fill: 'rgba(240, 90, 80, 0.16)', stroke: 'rgba(255, 120, 110, 0.95)' },
  Tr: { fill: 'rgba(250, 200, 60, 0.18)', stroke: 'rgba(255, 210, 80, 0.95)' }
};

const SCENE_PASSES = [
  ...LAYERS.map(layer => ({ z: Z_ORDER[layer.id], layer })),
  { z: Z_ORDER['above-background'], strip: 'top' },
  { z: Z_ORDER['above-animals'], strip: 'bottom' }
].sort((a, b) => a.z - b.z);

export function habitatColor(area) {
  let base = 0, factor = 1;
  for (const a of HABITAT_AREAS) {
    if (!(a.bit & area)) continue;
    if (a.color === 0) continue;
    if (a.color < 2) factor *= a.color;
    else base = base ? mixColors(base, a.color) : a.color;
  }
  return makeBrighter(base, factor);
}

export function habitatLabel(area) {
  const parts = [];
  for (const group of HABITAT_GROUPS) {
    const names = group.filter(bit => (area & bit) === bit).map(bit => HABITAT_AREAS.find(a => a.bit === bit).title);
    if (names.length) parts.push(names.join('/'));
  }
  return parts.join(', ');
}

// engine d8e2/6796.drawBorders: strips along edges heading right (dx > 10) after
// normalising winding (water: clockwise, air: counter-clockwise).
export function borderStrips(points, forWater) {
  const pts = points.slice();
  const cw = isClockwise(pts);
  if (forWater ? !cw : cw) pts.reverse();
  const top = [], bottom = [];
  for (let i = 0; i < pts.length; i++) {
    const l = pts[i], c = pts[i > 0 ? i - 1 : pts.length - 1];
    if (l.x > c.x && l.x - c.x > 10) {
      top.push([c.x, c.y - 1.5, l.x, l.y - 1.5, l.x, l.y, c.x, c.y]);
      bottom.push([c.x, c.y, l.x, l.y, l.x, l.y + 1.5, c.x, c.y + 1.5]);
    }
  }
  return { top, bottom };
}

// Official Mapmaker (app.a86e76d3.js Current.updateIcon) stores Cu.settings.angle in
// screen polar degrees (0 = right/+x, 90 = down/+y, -90 = up/-y, +-180 = left/-x) and
// rotates the up-pointing assets/ui/arrow.png sprite by `angle + 90` degrees clockwise.
export function currentArrowRotation(angle) {
  return (Number(angle) || 0) + 90;
}

export function currentDirectionVector(angle) {
  const rad = (Number(angle) || 0) * Math.PI / 180;
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

function objectZ(obj) {
  // engine: Bg and H use opacity as zOrder inside their sortable layer group
  if (obj.type === 'Bg') return obj.opacity ?? 0;
  if (obj.type === 'H') return obj.opacity ?? 1;
  return 0;
}

export class Renderer {
  constructor(canvas, { catalog, assets }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.catalog = catalog;
    this.assets = assets;
    this.view = { cx: 0, cy: 0, zoom: 1 };
    this.dpr = 1;
    this.width = 0;
    this.height = 0;
    this.patterns = new Map();
    this.gameView = false; // true: omit editor-only marks (ceiling icons, frame)
    this.testerPreview = false;
    this._renderCtx = null;
    this._teleportDiagCache = null;
    this._sortedLayerCache = null;
  }

  resize(width, height) {
    this.dpr = window.devicePixelRatio || 1;
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.canvas.style.width = width + 'px';
    this.canvas.style.height = height + 'px';
  }

  toScreen(x, y) {
    const v = this.view;
    return { x: (x - v.cx) * v.zoom + this.width / 2, y: (y - v.cy) * v.zoom + this.height / 2 };
  }

  toWorld(x, y) {
    const v = this.view;
    return { x: (x - this.width / 2) / v.zoom + v.cx, y: (y - this.height / 2) / v.zoom + v.cy };
  }

  fit(doc, padding = 40) {
    const W = doc.pixelWidth, H = doc.pixelHeight;
    const z = Math.min((this.width - padding * 2) / W, (this.height - padding * 2) / H);
    this.view = { cx: W / 2, cy: H / 2, zoom: Math.max(0.005, z) };
  }

  fitBounds(b, padding = 60) {
    if (!b) return;
    const z = Math.min((this.width - padding * 2) / Math.max(b.width, 10), (this.height - padding * 2) / Math.max(b.height, 10));
    this.view = { cx: b.x + b.width / 2, cy: b.y + b.height / 2, zoom: Math.min(40, Math.max(0.005, z)) };
  }

  worldTransform() {
    const v = this.view, d = this.dpr;
    this.ctx.setTransform(v.zoom * d, 0, 0, v.zoom * d, (this.width / 2 - v.cx * v.zoom) * d, (this.height / 2 - v.cy * v.zoom) * d);
  }

  screenTransform() {
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  pattern(textureId) {
    if (this.patterns.has(textureId)) return this.patterns.get(textureId);
    const img = this.assets.texture(textureId);
    if (!img) return null;
    const pat = this.ctx.createPattern(img, 'repeat');
    this.patterns.set(textureId, pat);
    return pat;
  }

  path(points) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
  }

  fillTexture(obj, offset = 0) {
    const ctx = this.ctx;
    const pat = this.pattern(obj.texture);
    if (pat) {
      pat.setTransform(new DOMMatrix([0.1, 0, 0, 0.1, offset, offset]));
      ctx.fillStyle = pat;
    } else ctx.fillStyle = '#7a6a55';
    ctx.fill();
  }

  gradientSpan(obj) {
    const b = bounds(obj.points);
    let top = b.y, bottom = b.y + b.height;
    if (obj.type === 'Wat' && obj.hasBorder) {
      const { top: t, bottom: btm } = borderStrips(obj.points, true);
      for (const s of t) top = Math.min(top, s[1], s[3]);
      for (const s of btm) bottom = Math.max(bottom, s[5], s[7]);
    }
    return { top: Math.round(top), height: bottom - top };
  }

  overrideColors(obj) {
    const ov = this._renderCtx?.colorOverrides?.get(obj.uid);
    return ov?.colors ?? obj.colors;
  }

  overrideBorderColor(obj) {
    const ov = this._renderCtx?.colorOverrides?.get(obj.uid);
    return (ov && 'borderColor' in ov) ? ov.borderColor : obj.borderColor;
  }

  fillGradient(obj, testerPreview = false) {
    const ctx = this.ctx;
    const rawColors = this.overrideColors(obj);
    const colors = testerPreview
      ? testerGradientColors({ colors: rawColors })
      : (rawColors && rawColors.length ? rawColors : [0, 0]);
    const { top, height } = this.gradientSpan(obj);
    const g = ctx.createLinearGradient(0, top, 0, top + Math.max(height, 0.001));
    const step = colors.length > 1 ? 1 / (colors.length - 1) : 1;
    colors.forEach((c, i) => g.addColorStop(Math.min(1, i * step), intToHex(c)));
    ctx.fillStyle = g;
    ctx.fill();
  }

  drawGradientSeam(obj) {
    const seam = gradientTopSeam(obj);
    if (!seam) return;
    const ctx = this.ctx;
    const z = this.view.zoom || 1;
    ctx.save();
    // Dashed bounding-box top edge showing where the tester's 1 px repeat-wrap row sits.
    ctx.strokeStyle = 'rgba(255, 176, 32, 0.9)';
    ctx.lineWidth = 1.25 / z;
    ctx.setLineDash([4 / z, 3 / z]);
    ctx.beginPath();
    ctx.moveTo(seam.x0, seam.top);
    ctx.lineTo(seam.x1, seam.top);
    ctx.stroke();
    // Highlight horizontal edges sitting directly on that top seam without a lift spike.
    if (seam.flatTopEdges.length) {
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(255, 64, 128, 0.95)';
      ctx.lineWidth = 2 / z;
      ctx.beginPath();
      for (const [a, b] of seam.flatTopEdges) {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  strips(list, color) {
    if (!list.length) return;
    const ctx = this.ctx;
    ctx.fillStyle = intToHex(color);
    ctx.beginPath();
    for (const s of list) {
      ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]); ctx.lineTo(s[4], s[5]); ctx.lineTo(s[6], s[7]); ctx.closePath();
    }
    ctx.fill();
  }

  // Readability curtain: collision x-ray styling for one polygon (view only).
  drawXRayPolygon(obj, xray) {
    const ctx = this.ctx;
    const z = this.view.zoom || 1;
    ctx.save();
    switch (obj.type) {
      case 'Sky':
        ctx.fillStyle = 'rgba(48, 60, 82, 0.24)'; ctx.fill();
        ctx.strokeStyle = 'rgba(110, 128, 156, 0.30)'; ctx.lineWidth = 1 / z; ctx.stroke();
        break;
      case 'Wat':
        ctx.fillStyle = 'rgba(24, 58, 96, 0.34)'; ctx.fill();
        ctx.strokeStyle = 'rgba(74, 148, 220, 0.45)'; ctx.lineWidth = 1 / z; ctx.stroke();
        break;
      case 'Bg': {
        const deceptive = Boolean(xray?.readability?.deceptiveBgUids?.has(obj.uid));
        ctx.fillStyle = deceptive ? 'rgba(227, 163, 59, 0.22)' : 'rgba(74, 84, 104, 0.22)'; ctx.fill();
        ctx.strokeStyle = deceptive ? 'rgba(227, 163, 59, 0.85)' : 'rgba(120, 134, 158, 0.32)';
        ctx.lineWidth = (deceptive ? 1.5 : 1) / z; ctx.stroke();
        break;
      }
      case 'Ter': {
        const platform = obj.layerId === 'platforms' || obj.settings?.collidable === false;
        if (platform) {
          ctx.fillStyle = 'rgba(56, 189, 248, 0.08)'; ctx.fill();
          ctx.setLineDash([6 / z, 4 / z]); ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 1.75 / z; ctx.stroke();
        } else {
          ctx.fillStyle = 'rgba(226, 232, 240, 0.22)'; ctx.fill();
          ctx.strokeStyle = obj.layerId === 'islands' ? '#93c5fd' : '#f1f5f9'; ctx.lineWidth = 2 / z; ctx.stroke();
        }
        break;
      }
      case 'Air':
        ctx.fillStyle = 'rgba(34, 211, 238, 0.22)'; ctx.fill();
        ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 2 / z; ctx.stroke();
        break;
      case 'C': {
        ctx.globalAlpha *= 0.75;
        ctx.fillStyle = 'rgba(148, 163, 184, 0.20)'; ctx.fill();
        ctx.setLineDash([5 / z, 4 / z]); ctx.strokeStyle = 'rgba(214, 219, 228, 0.75)'; ctx.lineWidth = 1.5 / z; ctx.stroke();
        break;
      }
      case 'Cu':
        ctx.fillStyle = HELPER_STYLE.Cu.fill; ctx.fill();
        ctx.strokeStyle = HELPER_STYLE.Cu.stroke; ctx.lineWidth = 1 / z; ctx.stroke();
        break;
      default:
        ctx.restore();
        return false;
    }
    ctx.restore();
    return true;
  }

  drawPolygonObject(obj, outline) {
    if (obj.points.length < 2) return;
    const ctx = this.ctx;
    this.path(obj.points);
    if (outline) { ctx.stroke(); return; }
    if (this._renderCtx?.xray && this.drawXRayPolygon(obj, this._renderCtx.xray)) return;
    switch (obj.type) {
      case 'Ter':
      case 'C':
        this.fillTexture(obj);
        if (obj.type === 'C' && !this.gameView) this.drawIcon('ui/ceiling.png', obj.points, 0);
        break;
      case 'Bg': {
        const off = this.assets.textureFrameWidth(obj.texture) / 3;
        ctx.save();
        ctx.globalAlpha *= obj.opacity ?? 1;
        this.fillTexture(obj, off);
        ctx.restore();
        break;
      }
      case 'Air': {
        const off = this.assets.textureFrameWidth(obj.texture) / 3;
        this.fillTexture(obj, off);
        ctx.fillStyle = 'rgba(0,0,0,0.3333)'; // engine tint 0xAAAAAA
        ctx.fill();
        const { top } = borderStrips(obj.points, false);
        this.strips(top, makeBrighter(this.overrideBorderColor(obj) | 0, 1.75));
        break;
      }
      case 'Sky':
      case 'Wat': {
        const rc = this._renderCtx;
        const tp = Boolean(rc?.testerPreview);
        const skyColors = obj.type === 'Sky' ? this.overrideColors(obj) : null;
        if (tp && obj.type === 'Sky' && isThinTwoStopSky({ type: obj.type, points: obj.points, colors: skyColors })) {
          ctx.fillStyle = '#000000';
          ctx.fill();
        } else {
          this.fillGradient(obj, tp);
          if (tp) this.drawGradientSeam(obj);
        }
        break;
      }
      case 'Cu': {
        const s = HELPER_STYLE.Cu;
        ctx.fillStyle = s.fill; ctx.fill();
        ctx.strokeStyle = s.stroke; ctx.lineWidth = 1 / this.view.zoom; ctx.stroke();
        this.drawIcon('ui/arrow.png', obj.points, currentArrowRotation(obj.settings?.angle));
        break;
      }
    }
  }

  drawIcon(rel, points, angle) {
    const img = this.assets.image(rel);
    if (!img) return;
    const b = bounds(points);
    const size = Math.min(Math.max(Math.min(b.width, b.height) * 0.5, 4), 40 / this.view.zoom);
    const h = size * img.height / img.width;
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(b.x + b.width / 2, b.y + b.height / 2);
    ctx.rotate(angle * Math.PI / 180);
    ctx.globalAlpha *= 0.85;
    ctx.drawImage(img, -size / 2, -h / 2, size, h);
    ctx.restore();
  }

  drawRectObject(obj, outline) {
    const ctx = this.ctx;
    const { x, y } = obj.position, { width: w, height: h } = obj.size;
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    if (outline) { ctx.stroke(); return; }
    let label = '';
    if (obj.type === 'Hab') {
      ctx.fillStyle = intToHex(habitatColor(obj.settings.area | 0));
      ctx.globalAlpha *= 0.3;
      ctx.fill();
      ctx.globalAlpha /= 0.3;
      label = habitatLabel(obj.settings.area | 0);
    } else {
      const s = HELPER_STYLE[obj.type];
      ctx.fillStyle = s.fill; ctx.fill();
      ctx.strokeStyle = s.stroke; ctx.lineWidth = 1 / this.view.zoom; ctx.stroke();
      if (obj.type === 'Food') label = (obj.settings.foodIds?.length ? 'x' + obj.settings.count : 'No foods selected');
      if (obj.type === 'NPC') label = (obj.settings.fishLevels?.length ? 'x' + obj.settings.animalCount : 'No animals selected');
      if (obj.type === 'Tr') {
        label = 'Trigger';
        const diag = this._renderCtx?.teleportDiag;
        for (const t of obj.triggers || []) for (const a of t.actions || []) {
          if (a.type === 1 && a.data?.pos) {
            const reason = diag ? teleportActionSummary(diag.get(a)) : null;
            this.drawTeleport(obj, a.data.pos, reason);
          }
        }
      }
    }
    const px = Math.min(w, h) * this.view.zoom;
    if (label && px > 34) {
      ctx.save();
      const size = Math.min(14, Math.max(9, px / 10)) / this.view.zoom;
      ctx.font = `600 ${size}px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`;
      const tw = ctx.measureText(label).width;
      // skip labels that would be squashed to fit or would sit on another label
      if (tw <= w * 0.9 && this.claimLabel(x + w / 2 - tw / 2, y + h / 2 - size / 2, tw, size)) {
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, x + w / 2, y + h / 2);
      }
      ctx.restore();
    }
  }

  // Reserves a label box (world units) for this frame; false when it would overlap one already drawn.
  claimLabel(x, y, w, h) {
    const boxes = this._labelBoxes || (this._labelBoxes = []);
    const pad = 3 / (this.view.zoom || 1);
    for (const b of boxes) {
      if (x < b.x + b.w + pad && b.x < x + w + pad && y < b.y + b.h + pad && b.y < y + h + pad) return false;
    }
    boxes.push({ x, y, w, h });
    return true;
  }

  drawTeleport(obj, pos, reason = null) {
    const ctx = this.ctx;
    const z = this.view.zoom || 1;
    const cx = obj.position.x + obj.size.width / 2, cy = obj.position.y + obj.size.height / 2;
    const flagged = Boolean(reason);
    ctx.save();
    ctx.setLineDash([6 / z, 4 / z]);
    ctx.strokeStyle = flagged ? 'rgba(239, 68, 68, 0.95)' : 'rgba(255, 210, 80, 0.8)';
    ctx.lineWidth = (flagged ? 1.5 : 1.2) / z;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(pos.x, pos.y); ctx.stroke();
    ctx.setLineDash([]);
    const r = 5 / z;
    ctx.beginPath(); ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(pos.x - r * 1.6, pos.y);
    ctx.lineTo(pos.x + r * 1.6, pos.y);
    ctx.moveTo(pos.x, pos.y - r * 1.6);
    ctx.lineTo(pos.x, pos.y + r * 1.6);
    ctx.stroke();
    if (flagged && z >= 0.15) {
      const fontSize = 10.5 / z;
      const padX = 5 / z, padY = 3 / z;
      const gap = r * 2.1;
      ctx.font = `600 ${fontSize}px Consolas, "JetBrains Mono", monospace`;
      const tw = ctx.measureText(reason).width;
      const bh = fontSize + padY * 2;
      const bx = pos.x + gap;
      const by = pos.y - bh / 2;
      if (!this.claimLabel(bx, by, tw + padX * 2, bh)) { ctx.restore(); return; }
      ctx.fillStyle = 'rgba(17, 20, 26, 0.92)';
      ctx.fillRect(bx, by, tw + padX * 2, bh);
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.85)';
      ctx.lineWidth = 1 / z;
      ctx.strokeRect(bx, by, tw + padX * 2, bh);
      ctx.fillStyle = '#fca5a5';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(reason, bx + padX, pos.y);
    }
    ctx.restore();
  }

  drawSpriteObject(obj, outline) {
    const ctx = this.ctx;
    const size = spriteSize(obj, this.catalog);
    const { width: w, height: h, ax, ay } = size;
    ctx.save();
    ctx.translate(obj.x, obj.y);
    ctx.rotate((obj.rotation || 0) * Math.PI / 180);
    // engine cdd1: inner pivot shifts the centred sprite by the anchor
    ctx.translate(-(w * ax - w / 2), -(h * ay - h / 2));
    if (obj.type === 'H') {
      ctx.globalAlpha *= obj.opacity ?? 1;
      if (this._renderCtx?.xray && !outline) ctx.globalAlpha *= 0.38;
    }
    const src = outline ? null : this.assets.spriteFor(obj);
    if (src) {
      ctx.drawImage(src.img, src.sx, src.sy, src.sw, src.sh, -w / 2, -h / 2, w, h);
      if (obj.type === 'P' && obj.params?.text && this.catalog.propById.get(obj.pType)?.params?.some(p => p.key === 'text')) {
        this.drawPropText(String(obj.params.text), w, h);
      }
    } else {
      ctx.strokeStyle = outline ? ctx.strokeStyle : 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1 / this.view.zoom;
      ctx.strokeRect(-w / 2, -h / 2, w, h);
    }
    ctx.restore();
  }

  // Message board text, as engine module 267c draws it: bold Arial in #756147 at 0.2 scale,
  // 0.9 alpha, centred 15% above the sprite centre, wrapped at 80% of the board width. The
  // font size goes from 12 to 8 as the single-line width grows from 60% to 100% of that width.
  drawPropText(text, w, h) {
    const ctx = this.ctx;
    ctx.save();
    const inner = 0.8 * w;
    ctx.font = 'bold 8px Arial';
    // Pixi measures without word wrap: the widest explicit line decides
    const a = 2 * Math.max(...text.split('\n').map(l => ctx.measureText(l).width)) / 10;
    const s = Math.max(0, Math.min(1, (a - 0.6 * inner) / (inner - 0.6 * inner)));
    const size = 8 + (1 - s) * 4;
    ctx.font = `bold ${size}px Arial`;
    const maxWidth = inner / 0.2;
    const lines = [];
    for (const para of text.split('\n')) {
      let line = '';
      for (const word of para.split(/(\s+)/)) {
        const next = line + word;
        if (line && ctx.measureText(next).width > maxWidth && word.trim()) {
          lines.push(line.trimEnd());
          line = word.trimStart();
          while (ctx.measureText(line).width > maxWidth && line.length > 1) { // breakWords
            let cut = line.length - 1;
            while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > maxWidth) cut--;
            lines.push(line.slice(0, cut));
            line = line.slice(cut);
          }
        } else line = next;
      }
      lines.push(line.trimEnd());
    }
    const lh = size + 1;
    ctx.translate(0, -0.15 * h);
    ctx.scale(0.2, 0.2);
    ctx.globalAlpha *= 0.9;
    ctx.fillStyle = '#756147';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const top = -((lines.length - 1) * lh) / 2;
    lines.forEach((l, i) => ctx.fillText(l, 0, top + i * lh));
    ctx.restore();
  }

  drawObject(obj, outline) {
    const kind = KIND_BY_TYPE[obj.type];
    if (kind === 'poly') this.drawPolygonObject(obj, outline);
    else if (kind === 'rect') this.drawRectObject(obj, outline);
    else this.drawSpriteObject(obj, outline);
  }

  // state: { doc, visible:Set, layerAlpha(layerId), outline:boolean, hiddenUids:Set }
  renderScene(state) {
    const ctx = this.ctx;
    this.screenTransform();
    if (state.backdrop === 'transparent') ctx.clearRect(0, 0, this.width, this.height);
    else {
      ctx.fillStyle = state.backdrop || '#0c0f14';
      ctx.fillRect(0, 0, this.width, this.height);
    }
    if (!state.xray) { this._renderScenePass(state, null); return; }
    if (Number.isFinite(state.xray.splitX)) {
      const sx = Math.max(0, Math.min(this.width, state.xray.splitX));
      ctx.save(); this.screenTransform(); ctx.beginPath(); ctx.rect(0, 0, sx, this.height); ctx.clip();
      this._renderScenePass(state, null);
      ctx.restore();
      ctx.save(); this.screenTransform(); ctx.beginPath(); ctx.rect(sx, 0, Math.max(0, this.width - sx), this.height); ctx.clip();
      this._renderScenePass(state, state.xray);
      ctx.restore();
      this.worldTransform();
    } else this._renderScenePass(state, state.xray);
  }

  _renderScenePass(state, xray = null) {
    const { doc } = state;
    const ctx = this.ctx;
    this.worldTransform();

    const W = doc.pixelWidth, H = doc.pixelHeight;
    if (!state.noWorldFill) {
      ctx.fillStyle = state.outline ? '#f4f5f7' : xray ? '#10151f' : '#dddddd'; // engine initBg 0xDDDDDD
      ctx.fillRect(0, 0, W, H);
    }
    if (state.reference && !state.reference.above) this.drawReference(state.reference);

    const testerPreview = Boolean(state.testerPreview ?? state.view?.testerPreview ?? this.testerPreview);
    const cacheable = !doc.history?.open && !(state.hiddenUids?.size);
    let sortedLayers = null;
    if (cacheable) {
      if (this._sortedLayerCache?.doc === doc && this._sortedLayerCache.rev === doc.revision) {
        sortedLayers = this._sortedLayerCache.map;
      } else {
        sortedLayers = new Map();
        this._sortedLayerCache = { doc, rev: doc.revision, map: sortedLayers };
      }
    }
    let teleportDiag = null;
    if (!state.outline && state.visible.has('triggers') && doc.layers.triggers.length) {
      if (cacheable && this._teleportDiagCache?.doc === doc && this._teleportDiagCache.rev === doc.revision) {
        teleportDiag = this._teleportDiagCache.map;
      } else {
        teleportDiag = diagnoseTeleports(doc);
        if (cacheable) this._teleportDiagCache = { doc, rev: doc.revision, map: teleportDiag };
      }
    }

    ctx.lineJoin = 'round';
    this._labelBoxes = []; // world-space boxes of labels drawn this frame, so labels never stack
    this._renderCtx = { testerPreview, teleportDiag, xray, colorOverrides: state.colorOverrides || null };
    try {
      for (const pass of SCENE_PASSES) {
        if (pass.strip) {
          if (state.outline) continue;
          this.drawBorderPass(doc, state, pass.strip);
          continue;
        }
        const id = pass.layer.id;
        if (!state.visible.has(id)) continue;
        const alpha = state.layerAlpha(id);
        if (alpha <= 0 && !state.objectAlpha) continue;
        const list = doc.layers[id];
        let sorted = list;
        if (id === 'background-terrains' || id === 'hide-spaces') {
          const cacheKey = id === 'hide-spaces' && testerPreview ? 'hide-spaces:tester' : id;
          sorted = sortedLayers?.get(cacheKey);
          if (!sorted) {
            if (id === 'hide-spaces' && testerPreview) {
              const lower = [], high = [];
              for (const o of list) {
                const hs = this.catalog.hideSpaceById.get(o.hSType);
                if (hs?.above && (o.opacity ?? 1) === 1) high.push(o);
                else lower.push(o);
              }
              sorted = [...lower, ...high];
            } else {
              sorted = list.map((o, i) => ({ o, i })).sort((a, b) => (objectZ(a.o) - objectZ(b.o)) || (a.i - b.i)).map(e => e.o);
            }
            sortedLayers?.set(cacheKey, sorted);
          }
        }
        if (state.outline) {
          ctx.strokeStyle = pass.layer.helper ? 'rgba(60,110,200,0.7)' : 'rgba(20,24,32,0.85)';
          ctx.lineWidth = 1 / this.view.zoom;
        }
        for (const obj of sorted) {
          if (state.hiddenUids?.has(obj.uid)) continue;
          const objAlpha = state.objectAlpha ? state.objectAlpha(obj, alpha) : alpha;
          if (objAlpha <= 0) continue;
          ctx.globalAlpha = objAlpha;
          this.drawObject(obj, state.outline);
        }
      }
    } finally {
      this._renderCtx = null;
    }
    ctx.globalAlpha = 1;

    if (state.reference?.above) this.drawReference(state.reference);
    if (!this.gameView) {
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 1 / this.view.zoom;
      ctx.strokeRect(0, 0, W, H);
    }
  }

  // Water top strips live in "above-background" (361); water and air bottom strips in
  // "above-animals" (421).
  drawBorderPass(doc, state, which) {
    const ctx = this.ctx;
    const xray = this._renderCtx?.xray;
    if (state.visible.has('water')) {
      const baseAlpha = state.layerAlpha('water');
      for (const w of doc.layers.water) {
        if (!w.hasBorder || w.points.length < 3 || state.hiddenUids?.has(w.uid)) continue;
        const objAlpha = (state.objectAlpha ? state.objectAlpha(w, baseAlpha) : baseAlpha) * (xray ? 0.45 : 1);
        if (objAlpha <= 0) continue;
        ctx.globalAlpha = objAlpha;
        const s = borderStrips(w.points, true);
        const wColors = this.overrideColors(w);
        this.strips(which === 'top' ? s.top : s.bottom, makeBrighter(wColors?.[0] | 0, 1.75));
      }
    }
    if (which === 'bottom' && state.visible.has('air-pockets')) {
      const baseAlpha = state.layerAlpha('air-pockets');
      for (const a of doc.layers['air-pockets']) {
        if (a.points.length < 3 || state.hiddenUids?.has(a.uid)) continue;
        const objAlpha = state.objectAlpha ? state.objectAlpha(a, baseAlpha) : baseAlpha;
        if (objAlpha <= 0) continue;
        ctx.globalAlpha = objAlpha;
        this.strips(borderStrips(a.points, false).bottom, xray ? 0x67e8f9 : makeBrighter(this.overrideBorderColor(a) | 0, 1.75));
      }
    }
    ctx.globalAlpha = 1;
  }

  // Tracing image under or over the map (editor only, never exported).
  drawReference(ref) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = ref.opacity ?? 0.5;
    ctx.drawImage(ref.img, ref.x, ref.y, ref.width, ref.height);
    ctx.restore();
  }

  drawGrid(doc, step) {
    const ctx = this.ctx;
    this.worldTransform();
    const W = doc.pixelWidth, H = doc.pixelHeight;
    let s = step;
    while (s * this.view.zoom < 8) s *= 5;
    const tl = this.toWorld(0, 0), br = this.toWorld(this.width, this.height);
    const x0 = Math.max(0, Math.floor(tl.x / s) * s), x1 = Math.min(W, br.x);
    const y0 = Math.max(0, Math.floor(tl.y / s) * s), y1 = Math.min(H, br.y);
    ctx.save();
    ctx.lineWidth = 1 / this.view.zoom;
    ctx.strokeStyle = 'rgba(20, 30, 60, 0.18)';
    ctx.beginPath();
    for (let x = x0; x <= x1; x += s) { ctx.moveTo(x, Math.max(0, tl.y)); ctx.lineTo(x, Math.min(H, br.y)); }
    for (let y = y0; y <= y1; y += s) { ctx.moveTo(Math.max(0, tl.x), y); ctx.lineTo(Math.min(W, br.x), y); }
    ctx.stroke();
    ctx.restore();
  }
}
