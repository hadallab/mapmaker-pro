// Loads the bundled official images (textures, sprite sheets, animal sprites, UI icons).

const BASE = new URL('../../assets/', import.meta.url);

function loadImage(rel) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = new URL(rel, BASE).href;
  });
}

export class AssetStore {
  constructor(catalog) {
    this.catalog = catalog;
    this.images = new Map();
    this.thumbs = new Map();
    this.onLoad = null;
  }

  async loadCore() {
    const files = [
      ...this.catalog.textures.map(t => t.file),
      ...this.catalog.sheets,
      ...['arrow', 'ceiling', 'spawn', 'tppos', 'trigger'].map(n => 'ui/' + n + '.png')
    ];
    await Promise.all(files.map(f => this.load(f)));
  }

  async load(rel) {
    if (!rel) return null;
    if (this.images.has(rel)) return this.images.get(rel);
    const pending = loadImage(rel).then(img => {
      this.images.set(rel, img);
      if (this.onLoad) this.onLoad(rel);
      return img;
    });
    this.images.set(rel, pending);
    return pending;
  }

  // Synchronous access for rendering; starts a load when missing.
  image(rel) {
    const v = this.images.get(rel);
    if (v instanceof HTMLImageElement) return v;
    if (!v) this.load(rel);
    return null;
  }

  texture(id) {
    const t = this.catalog.textureById.get(id);
    return t ? this.image(t.file) : null;
  }

  // Frame width of the texture inside its pack sprite sheet; engine Bg/Air use width/3
  // as texture translation.
  textureFrameWidth(id) {
    const t = this.catalog.textureById.get(id);
    if (!t) return 64;
    const f = this.catalog.frame(t.pack, t.file.split('/').pop());
    if (f) return f.w;
    return this.texture(id)?.width || 64;
  }

  spriteFor(obj) {
    if (obj.type === 'H') {
      const h = this.catalog.hideSpaceById.get(obj.hSType);
      if (!h?.frame) return null;
      const img = this.image(h.frame.file);
      return img ? { img, sx: h.frame.x, sy: h.frame.y, sw: h.frame.w, sh: h.frame.h } : null;
    }
    if (obj.type === 'P') {
      const p = this.catalog.propById.get(obj.pType);
      if (!p?.frame) return null;
      const img = this.image(p.frame.file);
      return img ? { img, sx: p.frame.x, sy: p.frame.y, sw: p.frame.w, sh: p.frame.h } : null;
    }
    const a = this.catalog.animalByLevel.get(obj.fLevel);
    if (!a?.file) return null;
    const img = this.image(a.file);
    return img ? { img, sx: 0, sy: 0, sw: img.width, sh: img.height } : null;
  }

  // Data-URL thumbnail for panels (cached).
  thumbnail(kind, id, size = 56) {
    const key = kind + ':' + id + ':' + size;
    if (this.thumbs.has(key)) return this.thumbs.get(key);
    let src = null;
    if (kind === 'H') src = this.spriteFor({ type: 'H', hSType: id });
    else if (kind === 'P') src = this.spriteFor({ type: 'P', pType: id });
    else if (kind === 'A') src = this.spriteFor({ type: 'A', fLevel: id });
    else if (kind === 'T') { const img = this.texture(id); if (img) src = { img, sx: 0, sy: 0, sw: img.width, sh: img.height, tile: true }; }
    else if (kind === 'F') {
      const f = this.catalog.foodById.get(id);
      const img = f && this.image(f.file);
      if (img) src = { img, sx: 0, sy: 0, sw: img.width, sh: img.height };
    }
    if (!src) return null;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    if (src.tile) {
      g.fillStyle = g.createPattern(src.img, 'repeat');
      g.fillRect(0, 0, size, size);
    } else {
      const k = Math.min(size / src.sw, size / src.sh);
      const w = src.sw * k, h = src.sh * k;
      g.drawImage(src.img, src.sx, src.sy, src.sw, src.sh, (size - w) / 2, (size - h) / 2, w, h);
    }
    const url = c.toDataURL();
    this.thumbs.set(key, url);
    return url;
  }
}
