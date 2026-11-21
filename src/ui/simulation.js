// Game simulation overlay on the editor canvas (View > Game simulation, F6).
// Positions and movement come from engine/sim.js; see the accuracy notes there.

import { buildWorld, placeFoods, placeNpcs, stepNpcs, makeHideSpaceFoods, stepHideSpaceFoods, foodSizePx, TICK_S } from '../engine/sim.js';
import { spriteSize } from '../engine/document.js';
import { h, clear, toggle } from './dom.js';
import { icon } from './icons.js';

export class Simulation {
  constructor(ed) {
    this.ed = ed;
    this.enabled = false;
    this.running = true;
    this.show = { foods: true, terrainFoods: true, hideSpaceFoods: true, npcs: true };
    this.foods = [];
    this.npcs = [];
    this.hsFoods = null;
    this.world = null;
    this.timer = 0;
    this.rebuildTimer = 0;
    this.hud = h('div', { class: 'sim-hud' });
    ed.viewport.append(this.hud);
    this.hud.addEventListener('pointerdown', e => e.stopPropagation());
    ed.on('doc', () => { if (this.enabled) { clearTimeout(this.rebuildTimer); this.rebuildTimer = setTimeout(() => this.rebuild(), 250); } });
    this.renderHud();
  }

  toggle(on = !this.enabled) {
    this.enabled = on;
    if (on) this.rebuild(); else { this.stop(); this.foods = []; this.npcs = []; this.hsFoods = null; }
    this.renderHud();
    this.ed.emit('view-options');
    this.ed.requestRender();
  }

  rebuild() {
    this.world = buildWorld(this.ed.doc);
    this.foods = placeFoods(this.world, this.show);
    this.npcs = this.show.npcs ? placeNpcs(this.world) : [];
    this.hsFoods = this.show.hideSpaceFoods ? makeHideSpaceFoods(this.world, o => spriteSize(o, this.ed.catalog)) : null;
    for (const n of this.npcs) this.ed.assets.load(this.ed.catalog.animalByLevel.get(n.fLevel)?.file);
    const allFoods = [
      ...this.foods,
      ...(this.hsFoods?.emitters.map(e => ({ type: e.e.food })) || []),
      ...(this.hsFoods?.foods || [])
    ];
    for (const f of allFoods) this.ed.assets.load(this.ed.catalog.foodById.get(f.type)?.file);
    this.stop();
    const moving = this.npcs.length || this.hsFoods?.emitters.length;
    if (this.running && moving) {
      let hudClock = 0;
      this.timer = setInterval(() => {
        stepNpcs(this.world, this.npcs);
        if (this.hsFoods) {
          stepHideSpaceFoods(this.world, this.hsFoods);
          if ((hudClock += TICK_S) >= 1) { hudClock = 0; this.updateCounts(); }
        }
        this.ed.requestRender();
      }, TICK_S * 1000);
    }
    this.renderHud();
    this.ed.requestRender();
  }

  stop() { clearInterval(this.timer); this.timer = 0; }

  renderHud() {
    clear(this.hud);
    this.hud.style.display = this.enabled ? '' : 'none';
    if (!this.enabled) return;
    const terrainFoods = this.foods.filter(f => f.terrain).length;
    const opt = (key, label, tip) => toggle({ checked: this.show[key], label, title: tip, onChange: v => { this.show[key] = v; this.rebuild(); } });
    const play = h('button', {
      class: 'btn icon flat small',
      html: icon(this.running ? 'pause' : 'play'),
      'data-tip': this.running ? 'Pause NPCs' : 'Move NPCs'
    });
    play.addEventListener('click', () => { this.running = !this.running; this.rebuild(); });
    const close = h('button', { class: 'btn icon flat small', html: icon('close'), 'data-tip': 'Close the simulation (F6)' });
    close.addEventListener('click', () => this.toggle(false));
    this.hud.append(
      h('div', { class: 'sim-head' }, h('b', {}, 'Game simulation'), h('span', { style: { flex: 1 } }), play, close),
      h('div', { class: 'sim-row' },
        opt('foods', 'Food spawns',
          'Count and food types from each spawn, uniform inside the area, never inside terrain; ' +
          'only in water when the spawn has "only on water". Respawn is not simulated.'),
        h('span', { class: 'v' }, String(this.foods.length - terrainFoods))),
      h('div', { class: 'sim-row' },
        opt('terrainFoods', 'Food on terrain',
          'Measured in the real game: foods sit on the outline where it meets water, about one per 13 px of outline. ' +
          'The count setting of terrains is not used by the server.'),
        h('span', { class: 'v' }, String(terrainFoods))),
      h('div', { class: 'sim-row' },
        opt('hideSpaceFoods', 'Hide-space food',
          'Measured in the real game: volcanoes throw volcanofood out of the crater, bubble vents release rising bubbles, ' +
          'bushes hold 10 fruit. Hide spaces below 100% opacity make no food. Trees, pines and shipwrecks were not seen making food and are not shown.'),
        this.hsCount = h('span', { class: 'v' }, String(this.hsFoods?.foods.length || 0))),
      h('div', { class: 'sim-row' },
        opt('npcs', 'NPCs',
          'Count and animals from each spawn in open water. Movement is an approximate patrol, the same for every behaviour type.'),
        h('span', { class: 'v' }, String(this.npcs.length))),
      h('div', { class: 'sim-note' },
        'Food spawns as on the game server, never inside terrain; terrain and hide-space food measured from real-game recordings. ' +
        'NPC movement is approximate.'));
  }

  updateCounts() {
    if (this.hsCount) this.hsCount.textContent = String(this.hsFoods?.foods.length || 0);
  }

  draw(r) {
    if (!this.enabled) return;
    const ctx = r.ctx, ed = this.ed;
    r.worldTransform();
    ctx.save();
    for (const f of this.hsFoods ? this.foods.concat(this.hsFoods.foods) : this.foods) {
      const info = ed.catalog.foodById.get(f.type);
      const img = info && ed.assets.image(info.file);
      const s = foodSizePx(f.type);
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(f.angle * Math.PI / 180);
      if (f.life !== undefined && f.life !== Infinity) ctx.globalAlpha = Math.min(1, f.age / 0.3, (f.life - f.age) / 1);
      if (img) ctx.drawImage(img, -s.width / 2, -s.height / 2, s.width, s.height);
      else { ctx.fillStyle = '#9be36a'; ctx.beginPath(); ctx.arc(0, 0, s.width / 2, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    }
    for (const n of this.npcs) {
      const sprite = { type: 'A', fLevel: n.fLevel, x: n.x, y: n.y, rotation: 0 };
      const src = ed.assets.spriteFor(sprite);
      const size = spriteSize(sprite, ed.catalog);
      ctx.save();
      ctx.translate(n.x, n.y);
      // character art points up; turn it to the heading and keep it upright when facing left
      const left = n.angle > 90 && n.angle < 270;
      ctx.rotate((n.angle + 90) * Math.PI / 180);
      if (left) ctx.scale(-1, 1);
      if (src) ctx.drawImage(src.img, src.sx, src.sy, src.sw, src.sh, -size.width / 2, -size.height / 2, size.width, size.height);
      else { ctx.strokeStyle = '#ff7a6b'; ctx.lineWidth = 1 / r.view.zoom; ctx.strokeRect(-size.width / 2, -size.height / 2, size.width, size.height); }
      ctx.restore();
    }
    ctx.restore();
  }
}
