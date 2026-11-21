// Editor-only data that the DPM format cannot hold: object names, groups, live symmetry
// links and the reference image. Saved next to the map as "<map>.mmp.json" (desktop app)
// and keyed by export order, which is the order objects are loaded back in.

import { LAYERS, KIND_BY_TYPE } from '../engine/layers.js';
import { clone, syncDerived } from '../engine/document.js';
import { limitDecimals } from '../engine/geometry.js';

export const SYMMETRY_MODES = [
  { id: 'off', label: 'Off' },
  { id: 'h', label: 'Mirror left / right' },
  { id: 'v', label: 'Mirror top / bottom' },
  { id: 'p', label: 'Rotate 180 deg (point)' }
];

function roundCoord(v, digits = 2) {
  const num = Number(v);
  if (!Number.isFinite(num)) return 0;
  // Apply 3-decimal export rounding first so in-memory floats and exported DPMs match.
  const n = limitDecimals(limitDecimals(num, 3), digits);
  return n === 0 ? 0 : n;
}

function roundAngle(v) {
  const num = Number(v);
  if (!Number.isFinite(num)) return 0;
  const d = limitDecimals(num, 2);
  const w = limitDecimals(((d % 360) + 360) % 360, 2);
  return w === 360 || w === 0 ? 0 : w;
}

function joinList(items) {
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function objectSignature(obj) {
  if (!obj || !obj.type || !obj.layerId) return '';
  const kind = KIND_BY_TYPE[obj.type];
  const head = `${obj.type}|${obj.layerId}|`;
  if (kind === 'poly') {
    const pts = (obj.points || []).map(p => `${roundCoord(p.x)},${roundCoord(p.y)}`).join(';');
    return head + pts;
  }
  if (kind === 'rect') {
    const x = roundCoord(obj.position?.x), y = roundCoord(obj.position?.y);
    const w = roundCoord(obj.size?.width), h = roundCoord(obj.size?.height);
    return `${head}${x},${y},${w},${h}`;
  }
  if (kind === 'sprite') {
    return `${head}${roundCoord(obj.x)},${roundCoord(obj.y)},${roundAngle(obj.rotation)}`;
  }
  return head;
}

function docExportObjects(doc) {
  const order = [];
  for (const l of LAYERS) for (const o of doc.layers[l.id]) order.push(o);
  return order;
}

function parseBlocks(list) {
  return (list || [])
    .filter(b => b && Number.isFinite(b.x) && Number.isFinite(b.y))
    .map(b => ({ x: b.x, y: b.y, rotation: Number(b.rotation) || 0, solid: b.solid !== false }));
}

function buildReattachSummary({ names, groupOf, twins, blocks, reference, symmetry, matchedMeta, metaTotal, matchedTotal, sidecarTotal }) {
  const metaParts = [];
  if (names.size > 0) metaParts.push('names');
  if (groupOf.size > 0) metaParts.push('groups');
  if (twins.size > 0) metaParts.push('symmetry links');
  const docParts = [];
  if (blocks.length > 0) docParts.push('blocks');
  if (reference) docParts.push('reference image');
  if (matchedMeta > 0) {
    const allParts = [...metaParts, ...docParts];
    const noun = metaTotal === 1 ? 'object' : 'objects';
    return `Restored ${joinList(allParts)} for ${matchedMeta} of ${metaTotal} ${noun}`;
  }
  if (symmetry !== 'off') docParts.push('symmetry mode');
  if (!docParts.length) return null;
  const noun = sidecarTotal === 1 ? 'object' : 'objects';
  return `Restored ${joinList(docParts)} (${matchedTotal} of ${sidecarTotal} ${noun} matched)`;
}

// Re-attaches a stale sidecar (when the DPM was edited externally) by matching object signatures.
export function reattachSidecar(doc, sidecar) {
  const emptyResult = {
    restored: false, matchedTotal: 0, sidecarTotal: 0, matchedMeta: 0, metaTotal: 0,
    names: new Map(), groupOf: new Map(), nextGroup: 1, twins: new Map(),
    symmetry: 'off', reference: null, blocks: [], summary: null
  };
  const oldSigs = Array.isArray(sidecar?.signatures) ? sidecar.signatures : null;
  if (!sidecar || !oldSigs || !oldSigs.length) return emptyResult;

  const newBySig = new Map();
  for (const o of docExportObjects(doc)) {
    const sig = objectSignature(o);
    let list = newBySig.get(sig);
    if (!list) newBySig.set(sig, list = []);
    list.push(o.uid);
  }

  const cursor = new Map();
  const oldToNewUid = new Map();
  let matchedTotal = 0;
  for (let i = 0; i < oldSigs.length; i++) {
    const sig = oldSigs[i];
    if (!sig) continue;
    const list = newBySig.get(sig);
    if (!list) continue;
    const pos = cursor.get(sig) || 0;
    if (pos >= list.length) continue;
    cursor.set(sig, pos + 1);
    oldToNewUid.set(i, list[pos]);
    matchedTotal++;
  }
  if (!matchedTotal) return { ...emptyResult, sidecarTotal: oldSigs.length };

  const metaOldIndices = new Set();
  const names = new Map();
  for (const [rawIdx, n] of Object.entries(sidecar.names || {})) {
    if (!n) continue;
    const idx = Number(rawIdx);
    metaOldIndices.add(idx);
    const uid = oldToNewUid.get(idx);
    if (uid != null) names.set(uid, String(n).slice(0, 80));
  }

  const groupOf = new Map();
  let nextGroup = 1;
  for (const g of sidecar.groups || []) {
    if (!Array.isArray(g) || g.length < 2) continue;
    const members = [];
    for (const rawIdx of g) {
      const idx = Number(rawIdx);
      metaOldIndices.add(idx);
      const uid = oldToNewUid.get(idx);
      if (uid != null && !groupOf.has(uid) && !members.includes(uid)) members.push(uid);
    }
    if (members.length >= 2) {
      const gid = nextGroup++;
      for (const uid of members) groupOf.set(uid, gid);
    }
  }

  const twins = new Map();
  for (const pair of sidecar.twins || []) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const a = Number(pair[0]), b = Number(pair[1]);
    metaOldIndices.add(a);
    metaOldIndices.add(b);
    const ua = oldToNewUid.get(a), ub = oldToNewUid.get(b);
    if (ua != null && ub != null && ua !== ub && !twins.has(ua) && !twins.has(ub)) {
      twins.set(ua, ub);
      twins.set(ub, ua);
    }
  }

  const symmetry = SYMMETRY_MODES.some(m => m.id === sidecar.symmetry) ? sidecar.symmetry : 'off';
  const reference = sidecar.reference || null;
  const blocks = parseBlocks(sidecar.blocks);
  const restoredUids = new Set([...names.keys(), ...groupOf.keys(), ...twins.keys()]);
  const matchedMeta = restoredUids.size;
  const metaTotal = metaOldIndices.size;
  const summary = buildReattachSummary({
    names, groupOf, twins, blocks, reference, symmetry,
    matchedMeta, metaTotal, matchedTotal, sidecarTotal: oldSigs.length
  });
  if (!summary) return { ...emptyResult, sidecarTotal: oldSigs.length, matchedTotal, metaTotal };

  return {
    restored: true, matchedTotal, sidecarTotal: oldSigs.length, matchedMeta, metaTotal,
    names, groupOf, nextGroup, twins, symmetry, reference, blocks, summary
  };
}

export class EditorMeta {
  constructor(ed) {
    this.ed = ed;
    this.reset();
  }

  reset() {
    this.names = new Map();
    this.groupOf = new Map();
    this.twins = new Map();
    this.symmetry = 'off';
    this.reference = null;
    this.referenceImage = null;
    this.blocks = []; // Napoleon blocks: { x, y, rotation, solid } in world px
    this.nextGroup = 1;
  }

  // ---- Napoleon blocks (editor only) ----
  setBlocks(blocks, silent = false) {
    this.blocks = blocks;
    this.ed.requestRender();
    if (!silent) { this.ed.state.dirty = true; this.ed.emit('file'); this.ed.emit('meta'); }
  }

  // ---- names ----
  name(o) { return this.names.get(o.uid) || null; }
  setName(o, name) {
    if (name) this.names.set(o.uid, name.slice(0, 80)); else this.names.delete(o.uid);
    this.ed.emit('meta');
  }

  // ---- groups ----
  group(objs) {
    if (objs.length < 2) return;
    const gid = this.nextGroup++;
    for (const o of objs) this.groupOf.set(o.uid, gid);
    this.ed.emit('meta');
  }
  ungroup(objs) {
    for (const o of objs) this.groupOf.delete(o.uid);
    this.ed.emit('meta');
  }
  members(gid) {
    const out = [];
    for (const [uid, g] of this.groupOf) if (g === gid) { const o = this.ed.doc.get(uid); if (o) out.push(o); }
    return out;
  }
  expand(objs) {
    const seen = new Set(), out = [];
    for (const o of objs) {
      const gid = this.groupOf.get(o.uid);
      for (const m of gid ? this.members(gid) : [o]) if (!seen.has(m.uid)) { seen.add(m.uid); out.push(m); }
    }
    return out;
  }

  // ---- live symmetry ----
  setSymmetry(mode) {
    this.symmetry = mode;
    this.ed.emit('meta');
    this.ed.requestRender();
  }

  mirror(o, mode) {
    const W = this.ed.doc.pixelWidth, H = this.ed.doc.pixelHeight;
    const fx = mode === 'h' || mode === 'p', fy = mode === 'v' || mode === 'p';
    const mx = x => fx ? W - x : x, my = y => fy ? H - y : y;
    const kind = KIND_BY_TYPE[o.type];
    if (kind === 'poly') {
      o.points = o.points.map(p => ({ x: mx(p.x), y: my(p.y) }));
      if (mode !== 'p') o.points.reverse();
    } else if (kind === 'rect') {
      o.position = {
        x: fx ? W - o.position.x - o.size.width : o.position.x,
        y: fy ? H - o.position.y - o.size.height : o.position.y
      };
      syncDerived(o);
      if (o.type === 'Tr') {
        for (const t of o.triggers || []) {
          for (const a of t.actions || []) {
            if (a.data?.pos) a.data.pos = { x: mx(a.data.pos.x), y: my(a.data.pos.y) };
          }
        }
      }
    } else {
      o.x = mx(o.x); o.y = my(o.y);
      const r = o.rotation || 0;
      o.rotation = mode === 'h' ? -r : mode === 'v' ? 180 - r : r + 180;
      o.rotation = ((o.rotation + 540) % 360) - 180;
    }
    return o;
  }

  // Called by the document inside the committing transaction.
  beforeCommit(before, label) {
    const mode = this.symmetry;
    if (mode === 'off' || /^(Mirror copy|Point-symmetric copy|Load)/.test(label || '')) return;
    const doc = this.ed.doc;
    const touched = [...before.keys()];
    const touchedSet = new Set(touched);
    for (const uid of touched) {
      const obj = doc.get(uid);
      const twinUid = this.twins.get(uid);
      if (twinUid == null) {
        if (before.get(uid) === null && obj) {
          const c = clone(obj);
          delete c.uid; delete c.sourceId;
          const twin = doc.add(this.mirror(c, mode));
          this.twins.set(uid, twin.uid);
          this.twins.set(twin.uid, uid);
        }
        continue;
      }
      if (touchedSet.has(twinUid)) continue; // both sides edited together
      const twin = doc.get(twinUid);
      if (!obj) {
        if (twin) doc.remove(twin);
        this.twins.delete(uid); this.twins.delete(twinUid);
        continue;
      }
      if (!twin) { this.twins.delete(uid); continue; }
      doc.touch(twin);
      const c = this.mirror(clone(obj), mode);
      for (const k of Object.keys(twin)) if (k !== 'uid' && !(k in c)) delete twin[k];
      for (const [k, v] of Object.entries(c)) if (k !== 'uid' && k !== 'layerId') twin[k] = v;
      if (twin.layerId !== obj.layerId) doc.relayer(twin, obj.layerId);
    }
  }

  unlinkTwins(objs) {
    for (const o of objs) { const t = this.twins.get(o.uid); if (t != null) { this.twins.delete(t); this.twins.delete(o.uid); } }
    this.ed.emit('meta');
  }

  // ---- reference image ----
  setReference(ref) {
    this.reference = ref;
    this.referenceImage = null;
    if (ref?.src && typeof Image !== 'undefined') {
      const img = new Image();
      img.onload = () => { this.referenceImage = img; this.ed.requestRender(); };
      img.src = ref.src;
    }
    this.ed.emit('meta');
    this.ed.requestRender();
  }

  // Live edits (dragging) change the placement without reloading the image.
  updateReference(patch, silent = false) {
    if (!this.reference) return;
    this.reference = { ...this.reference, ...patch };
    this.ed.requestRender();
    if (!silent) this.ed.emit('meta');
  }

  loadReferenceFile(file) {
    if (!file || !/^image\//.test(file.type)) return false;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const W = this.ed.doc.pixelWidth, H = this.ed.doc.pixelHeight;
        const k = Math.min(W / img.width, H / img.height);
        this.setReference({
          src: reader.result,
          name: file.name || 'pasted image',
          x: (W - img.width * k) / 2,
          y: (H - img.height * k) / 2,
          width: img.width * k,
          height: img.height * k,
          aspect: img.width / img.height,
          naturalWidth: img.width,
          naturalHeight: img.height,
          opacity: 0.5,
          above: true,
          visible: true,
          locked: false
        });
        this.ed.state.dirty = true;
        this.ed.emit('file');
        this.ed.toast('Reference image placed. Drag it on the map to adjust (Properties > Reference image).', 'ok');
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
    return true;
  }

  renderState() {
    const r = this.reference;
    if (!r || !r.visible || !this.referenceImage) return null;
    return { img: this.referenceImage, x: r.x, y: r.y, width: r.width, height: r.height, opacity: r.opacity, above: r.above };
  }

  // ---- sidecar ----
  exportOrder() {
    return docExportObjects(this.ed.doc).map(o => o.uid);
  }

  toSidecar() {
    const objs = docExportObjects(this.ed.doc);
    const index = new Map(objs.map((o, i) => [o.uid, i]));
    const names = {};
    for (const [uid, n] of this.names) if (index.has(uid)) names[index.get(uid)] = n;
    const groups = {};
    for (const [uid, g] of this.groupOf) if (index.has(uid)) (groups[g] ||= []).push(index.get(uid));
    const twins = [];
    for (const [a, b] of this.twins) if (a < b && index.has(a) && index.has(b)) twins.push([index.get(a), index.get(b)]);
    const out = {
      version: 1,
      names,
      groups: Object.values(groups).filter(g => g.length > 1),
      twins,
      symmetry: this.symmetry,
      reference: this.reference
    };
    if (this.blocks.length) {
      out.blocks = this.blocks.map(b => ({
        x: +b.x.toFixed(3),
        y: +b.y.toFixed(3),
        rotation: +(b.rotation || 0).toFixed(2),
        solid: b.solid !== false
      }));
    }
    const empty = !Object.keys(names).length && !out.groups.length && !twins.length && this.symmetry === 'off' && !this.reference && !this.blocks.length;
    if (empty) return null;
    out.signatures = objs.map(objectSignature);
    return out;
  }

  toStaleSidecar() {
    const s = this.toSidecar();
    return s ? { ...s, stale: true } : null;
  }

  fromSidecar(meta) {
    this.reset();
    if (!meta) { this.ed.emit('meta'); return null; }
    if (meta.stale) {
      const r = reattachSidecar(this.ed.doc, meta);
      if (!r.restored) { this.ed.emit('meta'); return r; }
      this.names = r.names;
      this.groupOf = r.groupOf;
      this.nextGroup = r.nextGroup;
      this.twins = r.twins;
      this.symmetry = r.symmetry;
      this.blocks = r.blocks;
      if (r.reference) this.setReference(r.reference);
      else this.ed.emit('meta');
      if (this.blocks.length || this.symmetry !== 'off') this.ed.requestRender();
      if (r.summary) this.ed.toast?.(r.summary, 'ok');
      return r;
    }
    const order = this.exportOrder();
    for (const [i, n] of Object.entries(meta.names || {})) if (order[i] != null) this.names.set(order[i], n);
    for (const g of meta.groups || []) { const gid = this.nextGroup++; for (const i of g) if (order[i] != null) this.groupOf.set(order[i], gid); }
    for (const [a, b] of meta.twins || []) {
      if (order[a] != null && order[b] != null) {
        this.twins.set(order[a], order[b]);
        this.twins.set(order[b], order[a]);
      }
    }
    this.symmetry = meta.symmetry || 'off';
    if (meta.reference) this.setReference(meta.reference);
    this.blocks = parseBlocks(meta.blocks);
    this.ed.emit('meta');
    if (this.blocks.length || this.symmetry !== 'off') this.ed.requestRender();
    return null;
  }
}
