// In-editor game simulation: where foods appear and how NPCs move, drawn over the map.
//
// Source: a local recreation of the game server,
// which stands in for the Deeeep.io server when the official client plays a map. Placement
// and NPC movement below are a line-for-line port, including its random generator and
// seeds, so the same map gives the same positions as that tester.
//
// What is measured and what is not (from that recreation):
// - Food spawns: `count` foods of the listed ids, uniform inside the area, never inside
//   terrain; in water only when onlyOnWater is set. Respawn timing and eating are not simulated.
// - Food on terrain (Ter foodSpawnSettings): measured from real-game recordings (see below).
// - Hide-space foods (volcanoes, bubble vents, bushes): measured from real-game recordings;
//   the recreation does not simulate them.
// - NPCs: count and animals per spawn, placed in open water. Movement is the tester's
//   patrol (left/right inside the spawn box, turn at walls), the same for every behaviour
//   type: the real NPC AI runs on the game server and has not been measured. Approximate.
//
// Units: the tester works in game units = DPM pixels x 10; this port works in DPM pixels.

export const TICK_S = 0.05; // 20 Hz server tick

// foodData width/height in game units, from a recorded live server session
const FOOD_SIZE = {
  1: [20, 20], 2: [32, 22], 3: [32, 27], 4: [32, 73], 5: [27, 27], 6: [27, 27], 7: [27, 27],
  8: [20, 20], 9: [20, 20], 10: [27, 27], 11: [27, 27], 12: [27, 27], 13: [39, 39], 14: [27, 27],
  15: [37, 37], 16: [20, 20], 17: [27, 27], 18: [40, 45], 19: [27, 27], 20: [27, 27], 21: [33, 33],
  22: [27, 27], 23: [167, 309], 24: [20, 20], 25: [27, 27], 26: [100, 100]
};

export function foodSizePx(type) {
  const s = FOOD_SIZE[type] || [27, 27];
  return { width: s[0] / 10, height: s[1] / 10 };
}

function lcg(seed) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

function inside(pts, x, y) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    if (pts[i].y > y !== pts[j].y > y && x < ((pts[j].x - pts[i].x) * (y - pts[i].y)) / (pts[j].y - pts[i].y) + pts[i].x) c = !c;
  }
  return c;
}

function bbox(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
  return { minX, minY, maxX, maxY };
}

// Spatial lists with bounding boxes so point tests stay fast on large FFA maps.
function shapeSet(polys) {
  return polys.map(pts => ({ pts, b: bbox(pts) }));
}
function anyContains(set, x, y) {
  for (const s of set) if (x >= s.b.minX && x <= s.b.maxX && y >= s.b.minY && y <= s.b.maxY && inside(s.pts, x, y)) return true;
  return false;
}

export function buildWorld(doc) {
  const objects = [...doc.objects()]; // export order = the order the server reads the file
  const water = shapeSet(doc.layers.water.map(o => o.points));
  const air = shapeSet(doc.layers['air-pockets'].map(o => o.points));
  // server occupancy: terrains and islands are solid unless collidable is false
  const solid = shapeSet([...doc.layers.terrains, ...doc.layers.islands].filter(o => o.settings?.collidable !== false).map(o => o.points));
  const inWater = (x, y) => anyContains(water, x, y) && !anyContains(air, x, y);
  const isSolid = (x, y) => anyContains(solid, x, y);
  return { objects, inWater, isSolid };
}

export function placeFoods(world, { foods = true, terrainFoods = true } = {}) {
  const list = [];
  const rnd = lcg(12345);
  // own generator, so toggling terrain food does not move the spawn-area foods
  if (terrainFoods) list.push(...placeTerrainFoods(world, lcg(9001)));
  if (foods) {
    for (const o of world.objects) {
      if (o.type !== 'Food') continue;
      const s = o.settings || {};
      const ids = (s.foodIds || []).map(Number);
      const count = Math.max(0, Math.floor(Number(s.count) || 0));
      if (!ids.length) continue;
      const { minX, maxX, minY, maxY } = bbox(o.points);
      for (let n = 0, tries = 0; n < count && tries < count * 50; tries++) {
        const x = minX + rnd() * (maxX - minX), y = minY + rnd() * (maxY - minY);
        if (!inside(o.points, x, y)) continue;
        // never inside terrain (2818 recorded foods: none in terrain; the server checks it only
        // with onlyOnWater). Out of the water only when the spawn allows it: map makers use
        // onlyOnWater off to put food in the air, e.g. on icicles above the waterline.
        if (world.isSolid(x, y)) continue;
        if (s.onlyOnWater && !world.inWater(x, y)) continue;
        list.push({ x, y, angle: Math.round(rnd() * 360), type: ids[Math.floor(rnd() * ids.length)], source: o.uid });
        n++;
      }
    }
  }
  return list;
}

// Food on terrain, measured on a public FFA map from two real-game recordings (977 algae):
// - every food sits on the outline itself (within 0.1 px), on edges facing any direction;
// - the editor always saves count 0 for terrains and the server ignores it: the amount follows
//   the outline length, about one food per 13 px on fully observed terrains;
// - the type is picked from the terrain's food ids.
// Only outline stretches that border open water get food. Positions along the outline are
// random, so the exact spots differ from the game; density and placement rule match.
const TERRAIN_FOOD_SPACING = 13;

function placeTerrainFoods(world, rnd) {
  const list = [];
  for (const o of world.objects) {
    if (o.type !== 'Ter' || o.layerId !== 'terrains') continue;
    const ids = (o.foodSpawnSettings?.foodIds || []).map(Number);
    if (!ids.length) continue;
    const pts = o.points;
    const edges = [];
    let total = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 0.01) continue;
      const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const open = side => world.inWater(mx + nx * side, my + ny * side) && !world.isSolid(mx + nx * side, my + ny * side);
      if (!open(1.5) && !open(-1.5)) continue;
      edges.push({ a, b, len });
      total += len;
    }
    const count = Math.floor(total / TERRAIN_FOOD_SPACING);
    for (let n = 0; n < count; n++) {
      let d = rnd() * total, i = 0;
      while (d > edges[i].len && i < edges.length - 1) d -= edges[i++].len;
      const { a, b, len } = edges[i], t = d / len;
      list.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        angle: Math.round(rnd() * 360),
        type: ids[Math.floor(rnd() * ids.length)],
        source: o.uid,
        terrain: true
      });
    }
  }
  return list;
}

// Foods made by hide spaces, measured on a public FFA map from real-game recordings (game units
// converted to px). `at` is the emission point in the sprite (0..1, top-left origin).
// - Volcanoes throw volcanofood out of the crater: within 40 degrees of the volcano's up,
//   86-121 px/s, coming to rest in an arc 29-41 px from the crater, 52-126 degrees (median
//   up) in the volcano's own frame (226 resting foods). Seen alive up to ~16 s.
//   Volcano 5 has no food shape in the catalog; the crater is the top of the sprite.
// - Bubble vents release bubbles that rise straight up at 5 px/s until they leave the water;
//   one every ~2.5 s (spacing 12 px in the recorded columns). Turbulent water (the slowing
//   waves) makes none.
// - Bushes hold 10 fruit each, scattered over the lower three quarters of the sprite.
// - A hide space with opacity below 100% makes no food at all.
// Trees, shipwrecks and pines have food areas in the catalog but no food was recorded from
// them, so they are left out rather than guessed. Emission rates of volcanoes are estimated
// from how many of their foods were visible at once (up to 17 per volcano).
const EMITTERS = {
  5: { food: 10, kind: 'eject', at: [0.5, 0] },
  77: { food: 10, kind: 'eject', at: [0.557, 0.05] },
  70: { food: 10, kind: 'eject', at: [0.461, 0.042] },
  78: { food: 11, kind: 'bubble', at: [0.436, 0.231] },
  3: { food: 8, kind: 'fruit', count: 10, area: [0, 0.25, 1, 1] }
};
const EJECT_EVERY = 0.8, EJECT_LIFE = 10, EJECT_DRAG = 2.95, EJECT_SPREAD = 40, EJECT_SPEED = [86, 121];
const BUBBLE_EVERY = 2.5, BUBBLE_SPEED = 5, BUBBLE_MAX_LIFE = 120;

export function hideSpaceEmitter(type) { return EMITTERS[type] || null; }

// World position of a point given in sprite fractions (u, v) of a hide space.
function spritePoint(o, size, u, v) {
  const lx = (u - size.ax) * size.width, ly = (v - size.ay) * size.height;
  const r = (o.rotation || 0) * Math.PI / 180;
  return { x: o.x + lx * Math.cos(r) - ly * Math.sin(r), y: o.y + lx * Math.sin(r) + ly * Math.cos(r) };
}

// Sets up the hide-space food state; `sizeOf(obj)` gives {width, height, ax, ay} in px.
export function makeHideSpaceFoods(world, sizeOf) {
  const rnd = lcg(4242);
  const emitters = [], foods = [];
  for (const o of world.objects) {
    if (o.type !== 'H') continue;
    const e = EMITTERS[o.hSType];
    if (!e || (o.opacity ?? 1) < 1) continue;
    const size = sizeOf(o);
    if (e.kind === 'fruit') {
      for (let n = 0; n < e.count; n++) {
        const p = spritePoint(o, size, e.area[0] + rnd() * (e.area[2] - e.area[0]), e.area[1] + rnd() * (e.area[3] - e.area[1]));
        foods.push({ x: p.x, y: p.y, vx: 0, vy: 0, angle: Math.round(rnd() * 360), type: e.food, age: 0, life: Infinity, source: o.uid });
      }
      continue;
    }
    const p = spritePoint(o, size, e.at[0], e.at[1]);
    emitters.push({
      ...p, e, up: (o.rotation || 0) - 90,
      every: e.kind === 'eject' ? EJECT_EVERY : BUBBLE_EVERY,
      clock: rnd() * 2, source: o.uid
    });
  }
  const state = { emitters, foods, rnd };
  // run the emitters for a while so the first picture shows the steady state
  for (let t = 0; t < 70; t += TICK_S) stepHideSpaceFoods(world, state);
  return state;
}

export function stepHideSpaceFoods(world, state) {
  const { rnd } = state;
  for (const em of state.emitters) {
    em.clock -= TICK_S;
    if (em.clock > 0) continue;
    em.clock += em.every;
    if (em.e.kind === 'bubble') {
      if (!world.inWater(em.x, em.y)) continue;
      state.foods.push({
        x: em.x, y: em.y, vx: 0, vy: -BUBBLE_SPEED,
        angle: Math.round(rnd() * 360), type: em.e.food,
        age: 0, life: BUBBLE_MAX_LIFE, bubble: true, source: em.source
      });
    } else {
      const a = (em.up + (rnd() * 2 - 1) * EJECT_SPREAD) * Math.PI / 180;
      const v = EJECT_SPEED[0] + rnd() * (EJECT_SPEED[1] - EJECT_SPEED[0]);
      state.foods.push({
        x: em.x, y: em.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        angle: Math.round(rnd() * 360), type: em.e.food,
        age: 0, life: EJECT_LIFE, source: em.source
      });
    }
  }
  const keep = [];
  const drag = Math.exp(-EJECT_DRAG * TICK_S);
  for (const f of state.foods) {
    f.age += TICK_S;
    if (f.age > f.life) continue;
    if (f.vx || f.vy) {
      const nx = f.x + f.vx * TICK_S, ny = f.y + f.vy * TICK_S;
      if (f.bubble) {
        if (!world.inWater(nx, ny) || world.isSolid(nx, ny)) continue; // pops at the surface or a ceiling
      } else {
        f.vx *= drag; f.vy *= drag;
        if (Math.hypot(f.vx, f.vy) < 1) f.vx = f.vy = 0;
        if (world.isSolid(nx, ny)) { f.vx = f.vy = 0; keep.push(f); continue; }
      }
      f.x = nx; f.y = ny;
    }
    keep.push(f);
  }
  state.foods = keep;
}

export function placeNpcs(world) {
  const list = [];
  const rnd = lcg(777);
  for (const o of world.objects) {
    if (o.type !== 'NPC') continue;
    const s = o.settings || {};
    const levels = (s.fishLevels || []).map(Number);
    const count = Math.max(0, Math.floor(Number(s.animalCount) || 0));
    if (!levels.length) continue;
    const b = bbox(o.points);
    for (let n = 0, tries = 0; n < count && tries < count * 50; tries++) {
      const x = b.minX + rnd() * (b.maxX - b.minX), y = b.minY + rnd() * (b.maxY - b.minY);
      if (!inside(o.points, x, y) || !world.inWater(x, y) || world.isSolid(x, y)) continue;
      const fLevel = levels[Math.floor(rnd() * levels.length)];
      const angle = rnd() < 0.5 ? 0 : 180;
      list.push({ x, y, vx: 0, vy: 0, angle, fLevel, npcType: Number(s.npcType) || 1, b, source: o.uid });
      n++;
    }
  }
  return list;
}

// One server tick of the tester's NPC patrol (75 game units/s = 7.5 px/s).
export function stepNpcs(world, npcs) {
  const speed = 7.5;
  for (const npc of npcs) {
    const tvx = Math.cos(npc.angle * Math.PI / 180) * speed, tvy = Math.sin(npc.angle * Math.PI / 180) * speed;
    npc.vx = npc.vx * 0.85 + tvx * 0.15;
    npc.vy = npc.vy * 0.85 + tvy * 0.15;
    let nx = npc.x + npc.vx * TICK_S, ny = npc.y + npc.vy * TICK_S;
    if (nx < npc.b.minX || nx > npc.b.maxX || !world.inWater(nx, ny) || world.isSolid(nx, ny)) {
      npc.angle = (npc.angle + 180) % 360;
      npc.vx = -npc.vx * 0.5;
      nx = Math.max(npc.b.minX, Math.min(npc.b.maxX, npc.x));
    }
    if (ny < npc.b.minY || ny > npc.b.maxY) {
      npc.vy = -npc.vy * 0.5;
      ny = Math.max(npc.b.minY, Math.min(npc.b.maxY, npc.y));
    }
    npc.x = nx; npc.y = ny;
  }
}
