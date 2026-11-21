// Compatibility checks. Each rule cites what breaks:
//  error   - the official Mapmaker throws or drops data when opening the export
//  warning - the official editor changes the data, or the community map tester renders/loads differently
//  info    - geometry hygiene that matters for physics but is accepted by both tools

import { LAYER_BY_ID, KIND_BY_TYPE, TEXTURED_TYPES } from './layers.js';
import { bounds, signedArea, selfIntersections, finite } from './geometry.js';
import { untangle } from './shapes.js';
import { removeSpikes } from './spikes.js';
import { foodBudget, npcBudget, totalFood, totalNpc, foodBoxCap } from './dpm.js';
import {
  MICRO_TERRAIN_MAX_AREA_PX2,
  hasExtraGradientStops,
  isThinTwoStopSky,
  findDuplicateContours,
  findEdgeReversals,
  diagnoseTeleports
} from './tester.js';

// The official NPC picker skips these closed/filled animal states (template filter in
// the NPC spawn settings component).
export const NPC_HIDDEN_LEVELS = new Set([51, 65, 84]);

export function validate(doc, catalog) {
  const issues = [];
  const add = (severity, code, message, obj = null, fix = null) =>
    issues.push({ severity, code, message, uid: obj?.uid ?? null, type: obj?.type ?? null, fix });

  const W = doc.pixelWidth, H = doc.pixelHeight;
  if (!(doc.worldSize.width > 0) || !(doc.worldSize.height > 0)) add('error', 'world-size', 'World size must be positive');
  if (!finite(Number(doc.settings.gravity))) add('error', 'gravity', 'Gravity is not a number');

  const solidTerrains = [];
  const teleportDiag = doc.layers.triggers.length ? diagnoseTeleports(doc) : null;
  for (const obj of doc.objects()) {
    const layer = LAYER_BY_ID[obj.layerId];
    const kind = KIND_BY_TYPE[obj.type];
    if (!layer || layer.type !== obj.type) {
      add('error', 'layer-type', `${obj.type} is on the "${obj.layerId}" layer; the official editor expects ${layer?.type ?? 'nothing'} there`, obj);
      continue;
    }

    if (kind === 'poly' || kind === 'rect') {
      const pts = obj.points;
      if (pts.length < 3) { add('error', 'points', `${obj.type} has ${pts.length} points; at least 3 are required`, obj, 'deleteObject'); continue; }
      if (!pts.every(p => finite(p.x) && finite(p.y))) { add('error', 'nan', `${obj.type} has non-numeric coordinates`, obj); continue; }
      const b = bounds(pts);
      if (b.x + b.width < 0 || b.y + b.height < 0 || b.x > W || b.y > H) {
        add('warning', 'off-world', `${obj.type} lies completely outside the world, so nobody can see it`, obj, 'deleteObject');
        continue;
      }
      if (b.x < -0.0005 || b.y < -0.0005 || b.x + b.width > W + 0.0005 || b.y + b.height > H + 0.0005) {
        add('warning', 'bounds', `${obj.type} extends outside the world (${W}x${H}); the official editor clamps edits to the world`, obj, 'clampToWorld');
      }
      if (kind === 'poly') {
        const sliver = Math.abs(signedArea(pts)) < 0.002 * Math.max(b.width, b.height) ** 2 && !selfIntersections(pts, 1).length;
        if (b.width === 0 || b.height === 0 || sliver) {
          // zero area, or a sliver thinner than 0.2 % of its length (small round decorations are kept)
          add('warning', 'flat', `${obj.type} has no area (a line or a sliver), so it only adds stray edges`, obj, 'deleteObject');
          continue;
        }
        if (obj.type === 'Ter' || obj.type === 'Air' || obj.type === 'C') {
          const hits = selfIntersections(pts, 1);
          if (hits.length) {
            const msg = `${obj.type} outline crosses itself near points ${hits[0][0] + 1} and ${hits[0][1] + 1}; the tester turns every edge into a physics edge`;
            add('info', 'self-intersection', msg, obj, untangle(pts) ? 'untangle' : null);
          }
          const revs = findEdgeReversals(pts);
          if (revs.length) {
            // a 3-4 point needle is all spike: delete it; otherwise drop the spike tips when that clears them
            const fix = pts.length <= 4 ? 'deleteObject' : (findEdgeReversals(removeSpikes(pts)).length ? null : 'removeSpikes');
            const msg = `${obj.type} has ${revs.length} 180-degree backtracking edge(s) near point ${revs[0] + 1}; players snag on the thin spike`;
            add('info', 'edge-reversal', msg, obj, fix);
          }
        }
        if (obj.type === 'Ter' && obj.layerId === 'terrains' && Math.abs(signedArea(pts)) < MICRO_TERRAIN_MAX_AREA_PX2) {
          add('info', 'micro-terrain', 'Small terrain (< 0.25 u2) on terrains layer adds unnecessary physics edges; move to platforms', obj, 'moveToPlatforms');
        }
        if (obj.type === 'Ter' && (obj.layerId === 'terrains' || obj.layerId === 'islands') && obj.settings?.collidable !== false) {
          solidTerrains.push(obj);
        }
      }
    } else {
      if (!finite(obj.x) || !finite(obj.y) || !finite(obj.rotation)) { add('error', 'nan', `${obj.type} has non-numeric position or rotation`, obj); continue; }
      if (obj.x < 0 || obj.y < 0 || obj.x > W || obj.y > H) add('warning', 'bounds', `${obj.type} origin is outside the world`, obj, 'clampToWorld');
    }

    if (TEXTURED_TYPES.has(obj.type) && !catalog.textureById.has(obj.texture)) {
      add('error', 'texture', `${obj.type} uses texture ${obj.texture}, which is not in the official catalog`, obj, 'defaultTexture');
    }
    switch (obj.type) {
      case 'Sky':
      case 'Wat': {
        const n = obj.colors?.length ?? 0;
        if (n < 2) add('error', 'colors', `${obj.type} needs at least two gradient colours (the editor divides by colours-1)`, obj, 'fixColors');
        else {
          if (hasExtraGradientStops(obj)) {
            add('warning', 'tester-colors', `${obj.type} has ${n} colour stops; the map tester draws only the first two`, obj, obj.type === 'Sky' ? 'bakeSky' : null);
          }
          const b = bounds(obj.points);
          if (isThinTwoStopSky(obj, b)) {
            add('warning', 'tester-thin-sky', 'Two-colour Sky shorter than 1.5 px renders black in the map tester', obj, 'solidColor');
          }
        }
        break;
      }
      case 'Bg':
        if (obj.opacity === undefined) add('warning', 'opacity', 'Background terrain has no opacity value', obj, 'defaultOpacity');
        break;
      case 'H':
        if (!catalog.hideSpaceById.has(obj.hSType)) add('error', 'hide-space', `Hide space type ${obj.hSType} is not in the official catalog`, obj, 'deleteObject');
        break;
      case 'P':
        if (!catalog.propById.has(obj.pType)) add('error', 'prop', `Prop type ${obj.pType} is not in the official catalog`, obj, 'deleteObject');
        break;
      case 'A': {
        const a = catalog.animalByLevel.get(obj.fLevel);
        if (!a) add('error', 'animal', `Preview animal level ${obj.fLevel} is not in the official catalog`, obj, 'deleteObject');
        else if (!a.file) add('warning', 'animal-asset', `Preview animal "${a.name}" has no sprite on the official server`, obj);
        break;
      }
      case 'Food': {
        const s = obj.settings;
        const unknown = (s.foodIds || []).filter(id => !catalog.foodById.has(Number(id)));
        if (unknown.length) add('warning', 'food-id', `Food spawn references unknown food id(s) ${unknown.join(', ')}`, obj, 'dropUnknownFood');
        if (!(s.foodIds || []).length) add('info', 'food-empty', 'Food spawn has no food selected', obj);
        const cap = foodBoxCap(obj);
        if (Number(s.count) > cap) add('warning', 'food-box', `Food count ${s.count} exceeds this box's cap ${cap}; the editor lowers it`, obj, 'capFoodBox');
        if (!finite(Number(s.firstSpawnMs)) || !finite(Number(s.reSpawnMs))) add('warning', 'food-timing', 'Food spawn timing is not numeric', obj);
        break;
      }
      case 'NPC': {
        const s = obj.settings;
        const unknown = (s.fishLevels || []).filter(l => !catalog.animalByLevel.has(Number(l)));
        if (unknown.length) add('warning', 'npc-level', `NPC spawn references unknown animal level(s) ${unknown.join(', ')}`, obj, 'dropBadNpcLevels');
        const hidden = (s.fishLevels || []).filter(l => NPC_HIDDEN_LEVELS.has(Number(l)));
        if (hidden.length) {
          add('warning', 'npc-state', `NPC spawn uses animal state level(s) ${hidden.join(', ')} that the official NPC picker does not offer`, obj, 'dropBadNpcLevels');
        }
        if (Number(s.animalCount) > 100) add('warning', 'npc-count', `NPC count ${s.animalCount} is above the editor's per-spawn maximum of 100`, obj, 'capNpcCount');
        if (!(s.fishLevels || []).length) add('info', 'npc-empty', 'NPC spawn has no animal selected', obj);
        break;
      }
      case 'Tr':
        for (const t of obj.triggers || []) {
          for (const a of t.actions || []) {
            if (a.type === 1 && !(a.data && a.data.pos && finite(a.data.pos.x) && finite(a.data.pos.y))) {
              add('warning', 'teleport', 'Teleport action has no target position', obj);
            }
            if (a.type === 1 && a.data?.pos && (a.data.pos.x < 0 || a.data.pos.y < 0 || a.data.pos.x > W || a.data.pos.y > H)) {
              add('warning', 'teleport-bounds', 'Teleport target is outside the world', obj, 'moveTeleports');
            }
            const flags = teleportDiag?.get(a);
            if (flags) {
              if (flags.solid) add('warning', 'teleport-solid', 'Teleport target is inside solid terrain', obj, 'moveTeleports');
              if (flags.dry) add('warning', 'teleport-dry', 'Teleport target is outside water', obj, 'moveTeleports');
              if (flags.loop) add('warning', 'teleport-loop', 'Teleport sends players straight back (instant A to B to A loop)', obj);
            }
          }
        }
        break;
    }
  }

  for (const { duplicate } of findDuplicateContours(solidTerrains)) {
    const msg = 'Terrain contour duplicates another solid terrain; duplicate physics edges can snag players';
    add('warning', 'duplicate-contour', msg, duplicate, 'deleteDuplicate');
  }

  const fb = foodBudget(doc.worldSize), ft = totalFood(doc);
  if (ft > fb) add('warning', 'food-budget', `Total food ${ft} exceeds the world budget ${Math.floor(fb)}; the editor trims every spawn on open`, null, 'trimQuotas');
  const nb = npcBudget(doc.worldSize), nt = totalNpc(doc);
  if (nt > nb) add('warning', 'npc-budget', `Total NPCs ${nt} exceed the world budget ${Math.floor(nb)}; the editor trims every spawn on open`, null, 'trimQuotas');

  const order = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  return issues;
}

export function summarize(issues) {
  const s = { error: 0, warning: 0, info: 0 };
  for (const i of issues) s[i.severity]++;
  return s;
}
