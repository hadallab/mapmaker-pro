// Napoleon wrasse sand blocks: editor-only measuring pieces (Napoleon block tool, B).
//
// In the game the Napoleon wrasse digs blocks out of terrain and places them where it likes.
// The client draws them as a square entity of 78 x 78 game units (getSize in the client) with
// sandblock.png while it moves and sandblock_solid.png once it has set. Here they are 7.8 px
// squares (1 DPM px = 10 game units, so 0.78 Mapmaker units), kept in the map's sidecar file,
// never in the DPM. The 78 is the client's drawing size; the server's collision box is not measured.

export const BLOCK_SIZE = 7.8;

const images = {};
function image(solid) {
  const key = solid ? 'solid' : 'loose';
  if (!images[key]) {
    const img = new Image();
    img.src = new URL(solid ? '../../assets/img/sandblock_solid.png' : '../../assets/img/sandblock.png', import.meta.url).href;
    images[key] = img;
  }
  return images[key];
}

// Block centre in the frame of `b`: a point (x, y) as seen from that block, unrotated.
function local(b, x, y) {
  const r = -(b.rotation || 0) * Math.PI / 180, dx = x - b.x, dy = y - b.y;
  return { x: dx * Math.cos(r) - dy * Math.sin(r), y: dx * Math.sin(r) + dy * Math.cos(r) };
}

export function blockAt(blocks, x, y) {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const p = local(blocks[i], x, y);
    if (Math.abs(p.x) <= BLOCK_SIZE / 2 && Math.abs(p.y) <= BLOCK_SIZE / 2) return blocks[i];
  }
  return null;
}

// Edge-to-edge snapping: near an existing block, the new one takes the free neighbouring slot
// (same rotation), so rows and stacks line up the way the game packs them.
export function snapBlock(blocks, x, y, rotation) {
  let best = null;
  for (const b of blocks) {
    const p = local(b, x, y);
    if (Math.abs(p.x) > BLOCK_SIZE * 1.5 || Math.abs(p.y) > BLOCK_SIZE * 1.5) continue;
    let i = Math.round(p.x / BLOCK_SIZE), j = Math.round(p.y / BLOCK_SIZE);
    if (!i && !j) { if (Math.abs(p.x) > Math.abs(p.y)) i = Math.sign(p.x) || 1; else j = Math.sign(p.y) || 1; }
    const r = (b.rotation || 0) * Math.PI / 180, lx = i * BLOCK_SIZE, ly = j * BLOCK_SIZE;
    const c = { x: b.x + lx * Math.cos(r) - ly * Math.sin(r), y: b.y + lx * Math.sin(r) + ly * Math.cos(r), rotation: b.rotation || 0 };
    if (blockAt(blocks, c.x, c.y)) continue;
    const d = Math.hypot(c.x - x, c.y - y);
    if (!best || d < best.d) best = { ...c, d };
  }
  return best ? { x: best.x, y: best.y, rotation: best.rotation } : { x, y, rotation };
}

// Draws blocks in world space (the renderer's world transform must be active).
export function drawBlocks(ctx, blocks, { alpha = 1, outline = null } = {}) {
  for (const b of blocks) {
    const img = image(b.solid !== false);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(b.x, b.y);
    ctx.rotate((b.rotation || 0) * Math.PI / 180);
    if (img.complete && img.naturalWidth) ctx.drawImage(img, -BLOCK_SIZE / 2, -BLOCK_SIZE / 2, BLOCK_SIZE, BLOCK_SIZE);
    else { ctx.fillStyle = '#d8c070'; ctx.fillRect(-BLOCK_SIZE / 2, -BLOCK_SIZE / 2, BLOCK_SIZE, BLOCK_SIZE); }
    if (outline) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = outline.color;
      ctx.lineWidth = outline.width;
      ctx.strokeRect(-BLOCK_SIZE / 2, -BLOCK_SIZE / 2, BLOCK_SIZE, BLOCK_SIZE);
    }
    ctx.restore();
  }
}

export function preloadBlocks(onload) {
  for (const solid of [true, false]) {
    const img = image(solid);
    if (!img.complete) img.addEventListener('load', onload, { once: true });
  }
}
