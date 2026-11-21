// Layer, tool and type definitions matching the official Mapmaker engine.
// Order matters: it is both the export order and the panel order (top of the list = drawn last).

export const TYPES = {
  Terrain: 'Ter', Water: 'Wat', Sky: 'Sky', Habitat: 'Hab', AirPocket: 'Air',
  Background: 'Bg', NPCSpawn: 'NPC', FoodSpawn: 'Food', Ceiling: 'C', HideSpace: 'H',
  Animal: 'A', Current: 'Cu', Trigger: 'Tr', Prop: 'P'
};

export const TOOL = {
  Creation: 1, Selection: 2, Move: 3, Pan: 4, PointSelection: 5, ShapeSquare: 6,
  Zoom: 7, HideSpace: 8, Rotate: 9, Animal: 10, Prop: 11
};

const SPRITE_TOOLS = [TOOL.HideSpace, TOOL.Animal, TOOL.Rotate, TOOL.Prop];

// excluded / only lists are copied verbatim from MapEditor.init().
export const LAYERS = [
  { id: 'habitats', title: 'Habitats', type: 'Hab', kind: 'rect', helper: true, excluded: [...SPRITE_TOOLS, TOOL.Creation], description: 'Define the areas where different animals can live' },
  { id: 'triggers', title: 'Triggers', type: 'Tr', kind: 'rect', helper: true, excluded: [...SPRITE_TOOLS, TOOL.Creation], description: 'Things happen when players enter/exit them' },
  { id: 'npc-spawns', title: 'NPC Spawns', type: 'NPC', kind: 'rect', helper: true, excluded: [...SPRITE_TOOLS, TOOL.Creation] },
  { id: 'food-spawns', title: 'Food Spawns', type: 'Food', kind: 'rect', helper: true, excluded: [...SPRITE_TOOLS, TOOL.Creation] },
  { id: 'currents', title: 'Currents', type: 'Cu', kind: 'poly', helper: true, excluded: SPRITE_TOOLS, description: 'Affects the movement of animals and food inside it' },
  { id: 'ceilings', title: 'Ceilings', type: 'C', kind: 'poly', excluded: SPRITE_TOOLS, description: 'Visible only to animals who are outside it' },
  { id: 'terrains', title: 'Terrains', type: 'Ter', kind: 'poly', excluded: SPRITE_TOOLS, description: 'Normal terrain' },
  { id: 'islands', title: 'Islands', type: 'Ter', kind: 'poly', excluded: SPRITE_TOOLS, description: 'Below the water border; some animals cannot dig through it' },
  { id: 'animals', title: 'Preview Animals', type: 'A', kind: 'sprite', only: [TOOL.Selection, TOOL.Move, TOOL.Pan, TOOL.Rotate, TOOL.Zoom, TOOL.Animal], description: 'Not visible in-game' },
  { id: 'props', title: 'Props', type: 'P', kind: 'sprite', only: [TOOL.Selection, TOOL.Move, TOOL.Pan, TOOL.Rotate, TOOL.Zoom, TOOL.Prop] },
  { id: 'platforms', title: 'Platforms', type: 'Ter', kind: 'poly', excluded: SPRITE_TOOLS, description: 'Uncollidable but standable terrains' },
  { id: 'hide-spaces', title: 'Hide Spaces', type: 'H', kind: 'sprite', only: [TOOL.Selection, TOOL.Move, TOOL.Pan, TOOL.Rotate, TOOL.Zoom, TOOL.HideSpace] },
  { id: 'air-pockets', title: 'Air Pockets', type: 'Air', kind: 'poly', excluded: SPRITE_TOOLS, description: 'Air space placed inside water' },
  { id: 'background-terrains', title: 'Background Terrains', type: 'Bg', kind: 'poly', excluded: SPRITE_TOOLS },
  { id: 'water', title: 'Water', type: 'Wat', kind: 'poly', excluded: SPRITE_TOOLS },
  { id: 'sky', title: 'Sky', type: 'Sky', kind: 'poly', excluded: SPRITE_TOOLS }
];

export const LAYER_BY_ID = Object.fromEntries(LAYERS.map(l => [l.id, l]));

// zOrder = 500 - 10 * (index + 1); helper render layers sit between them.
export const Z_ORDER = Object.fromEntries(LAYERS.map((l, i) => [l.id, 500 - 10 * (i + 1)]));
Z_ORDER['above-animals'] = 421;
Z_ORDER['above-background'] = 361;

export const KIND_BY_TYPE = {
  Ter: 'poly', Bg: 'poly', C: 'poly', Air: 'poly', Sky: 'poly', Wat: 'poly', Cu: 'poly',
  Hab: 'rect', Food: 'rect', NPC: 'rect', Tr: 'rect',
  H: 'sprite', A: 'sprite', P: 'sprite'
};

export const TEXTURED_TYPES = new Set(['Ter', 'Bg', 'C', 'Air']);
export const GRADIENT_TYPES = new Set(['Sky', 'Wat']);

export function layerAllowsTool(layer, tool) {
  if (!layer) return true;
  if (layer.only) return layer.only.includes(tool);
  return !(layer.excluded || []).includes(tool);
}

// Habitat bit field.
export const HABITAT_AREAS = [
  { bit: 1, name: 'cold', title: 'Cold', color: 1.25 },
  { bit: 2, name: 'warm', title: 'Warm', color: 0.75 },
  { bit: 4, name: 'shallow', title: 'Shallow', color: 0 },
  { bit: 8, name: 'deep', title: 'Deep', color: 13906743 },
  { bit: 16, name: 'fresh', title: 'Fresh', color: 5163081 },
  { bit: 32, name: 'salt', title: 'Salt', color: 22271 }
];
export const HABITAT_GROUPS = [[1, 2], [4, 8], [16, 32]];

export const NPC_TYPES = [
  { id: 1, name: 'Passive', description: 'Eats food. Escapes when attacked' },
  { id: 2, name: 'Passive Aggressive', description: 'Eats food. Attacks back when attacked' },
  { id: 3, name: 'Aggressive', description: 'Eats food. Attacks whoever it sees' },
  { id: 4, name: 'Passive Swarm', description: 'Eats food. Tends to form groups' },
  { id: 5, name: 'Passive Wanderer', description: "Just moves, doesn't eat" },
  { id: 6, name: 'Aggressive Swarm', description: 'Eats food and attacks whoever it sees. Tends to form groups' },
  { id: 7, name: 'Passive Dumb', description: 'Moves in random directions' }
];

export const TRIGGER_WHEN = [{ value: 1, title: 'On enter' }, { value: 3, title: 'On exit' }];
export const TRIGGER_ACTIONS = [{ value: 1, title: 'Teleport' }, { value: 2, title: 'Win (player)' }];

export const MAX_CURRENT = 100;

// A polygon layer the knife and sculpt tools may change under the current view state.
export function isLayerEditable(layerId, { activeLayer = null, visible = null, locked = null, isolate = false } = {}) {
  const layer = LAYER_BY_ID[layerId];
  if (!layer || layer.kind !== 'poly') return false;
  if (visible && !visible.has(layerId)) return false;
  if (locked && locked.has(layerId)) return false;
  if (isolate && activeLayer && layerId !== activeLayer) return false;
  if (layer.helper && layerId !== activeLayer) return false;
  return true;
}
