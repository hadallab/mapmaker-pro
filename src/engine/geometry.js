// Pure geometry and colour helpers. Functions marked "engine" reproduce the official
// Mapmaker implementation exactly, because export rounding and border placement depend on them.

// engine: dfb9.limitDecimals
export function limitDecimals(value, digits) {
  const text = '' + value;
  if (text.includes('e')) {
    const parts = text.split('e');
    const sign = +parts[1] + digits > 0 ? '+' : '';
    const shifted = Number(+parts[0] + 'e' + sign + (+parts[1] + digits));
    return +(Math.round(shifted) + 'e-' + digits);
  }
  return +(Math.round(Number(value + 'e+' + digits)) + 'e-' + digits);
}

// engine: dfb9.isClockwise (y axis points down)
export function isClockwise(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    sum += (b.x - a.x) * (b.y + a.y);
  }
  return sum < 0;
}

export function bounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function unionBounds(list) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of list) {
    if (!b) continue;
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function signedArea(points) {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    sum += (points[j].x * points[i].y) - (points[i].x * points[j].y);
  }
  return sum / 2;
}

export function perimeter(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    sum += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return sum;
}

export function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function distanceToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  let t = len ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a.x + t * dx, y = a.y + t * dy;
  return { distance: Math.hypot(p.x - x, p.y - y), x, y, t };
}

function orientation(a, b, c) {
  const v = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(v) < 1e-12) return 0;
  return v > 0 ? 1 : 2;
}

function onSegment(a, b, c) {
  return b.x <= Math.max(a.x, c.x) && b.x >= Math.min(a.x, c.x) && b.y <= Math.max(a.y, c.y) && b.y >= Math.min(a.y, c.y);
}

export function segmentsIntersect(p1, q1, p2, q2) {
  const o1 = orientation(p1, q1, p2), o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1), o4 = orientation(p2, q2, q1);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}

// Returns the index pairs of non-adjacent edges that cross. Uses a sweep over x-sorted
// edge boxes so large terrain contours stay fast.
export function selfIntersections(points, limit = 4) {
  const n = points.length;
  if (n < 4) return [];
  const edges = [];
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    edges.push({ i, minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) });
  }
  edges.sort((e1, e2) => e1.minX - e2.minX);
  const hits = [];
  const active = [];
  for (const e of edges) {
    for (let k = active.length - 1; k >= 0; k--) if (active[k].maxX < e.minX) active.splice(k, 1);
    for (const o of active) {
      const d = Math.abs(o.i - e.i);
      if (d <= 1 || d === n - 1) continue;
      if (o.maxY < e.minY || o.minY > e.maxY) continue;
      if (segmentsIntersect(points[o.i], points[(o.i + 1) % n], points[e.i], points[(e.i + 1) % n])) {
        hits.push([Math.min(o.i, e.i), Math.max(o.i, e.i)]);
        if (hits.length >= limit) return hits;
      }
    }
    active.push(e);
  }
  return hits;
}

// Douglas-Peucker on a closed ring. Keeps at least three points.
export function simplifyRing(points, epsilon) {
  if (points.length <= 3 || epsilon <= 0) return points.map(p => ({ x: p.x, y: p.y }));
  // split the ring at the two most distant points so both halves are open polylines
  let far = 0, best = -1;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i].x - points[0].x, points[i].y - points[0].y);
    if (d > best) { best = d; far = i; }
  }
  const first = points.slice(0, far + 1);
  const second = points.slice(far).concat([points[0]]);
  const a = simplifyLine(first, epsilon);
  const b = simplifyLine(second, epsilon);
  const ring = a.concat(b.slice(1, -1));
  if (ring.length < 3) return points.map(p => ({ x: p.x, y: p.y }));
  return ring;
}

function simplifyLine(points, epsilon) {
  if (points.length < 3) return points.map(p => ({ x: p.x, y: p.y }));
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let index = -1, max = 0;
    for (let i = s + 1; i < e; i++) {
      const d = distanceToSegment(points[i], points[s], points[e]).distance;
      if (d > max) { max = d; index = i; }
    }
    if (max > epsilon && index > 0) {
      keep[index] = 1;
      stack.push([s, index], [index, e]);
    }
  }
  return points.filter((_, i) => keep[i]).map(p => ({ x: p.x, y: p.y }));
}

export function triArea(a, b, c) {
  return Math.abs((a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y)) / 2);
}

class MinAreaHeap {
  constructor() { this.data = []; }
  get size() { return this.data.length; }
  push(item) {
    const d = this.data;
    d.push(item);
    let i = d.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (d[p].area <= d[i].area) break;
      [d[p], d[i]] = [d[i], d[p]];
      i = p;
    }
  }
  pop() {
    const d = this.data;
    const top = d[0];
    const last = d.pop();
    if (d.length) {
      d[0] = last;
      let i = 0;
      const len = d.length;
      while (true) {
        let m = i;
        const l = i * 2 + 1, r = l + 1;
        if (l < len && d[l].area < d[m].area) m = l;
        if (r < len && d[r].area < d[m].area) m = r;
        if (m === i) break;
        [d[i], d[m]] = [d[m], d[i]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Visvalingam-Whyatt decimation on a closed ring down to `targetCount` points (>= 3)
 * while rejecting vertex removals that would create degenerate edges, 180-degree
 * edge reversals, or new self-intersections.
 */
export function simplifyToCount(ring, targetCount) {
  if (!Array.isArray(ring)) return [];
  const n = ring.length;
  if (n <= 3 || targetCount == null || !Number.isFinite(Number(targetCount))) {
    return ring.map(p => ({ x: p.x, y: p.y }));
  }
  const target = Math.max(3, Math.floor(Number(targetCount)));
  if (n <= target) return ring.map(p => ({ x: p.x, y: p.y }));

  const pts = ring.map(p => ({ x: p.x, y: p.y }));
  const prev = new Int32Array(n);
  const next = new Int32Array(n);
  const alive = new Uint8Array(n);
  const blocked = new Uint8Array(n);
  const ver = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    prev[i] = (i - 1 + n) % n;
    next[i] = (i + 1) % n;
    alive[i] = 1;
  }
  let aliveCount = n;

  const canRemove = i => {
    if (!alive[i] || aliveCount <= 3) return false;
    const p = prev[i], q = next[i];
    if (p === q || prev[p] === q) return false;
    const A = pts[p], B = pts[i], C = pts[q];
    if (aliveCount === 4 && triArea(A, C, pts[next[q]]) <= 1e-6) return false;
    if (Math.hypot(B.x - A.x, B.y - A.y) < 1e-9 || Math.hypot(B.x - C.x, B.y - C.y) < 1e-9) return true;
    if (Math.hypot(C.x - A.x, C.y - A.y) < 1e-6) return false;

    const pp = pts[prev[p]], nn = pts[next[q]];
    if (orientation(pp, A, C) === 0 && (pp.x - A.x) * (C.x - A.x) + (pp.y - A.y) * (C.y - A.y) > 0) return false;
    if (orientation(A, C, nn) === 0 && (A.x - C.x) * (nn.x - C.x) + (A.y - C.y) * (nn.y - C.y) > 0) return false;

    const minX = Math.min(A.x, C.x), maxX = Math.max(A.x, C.x);
    const minY = Math.min(A.y, C.y), maxY = Math.max(A.y, C.y);
    for (let u = next[q]; u !== prev[p]; u = next[u]) {
      const w = next[u];
      const uPt = pts[u], wPt = pts[w];
      if (Math.max(uPt.x, wPt.x) < minX || Math.min(uPt.x, wPt.x) > maxX ||
          Math.max(uPt.y, wPt.y) < minY || Math.min(uPt.y, wPt.y) > maxY) continue;
      if (segmentsIntersect(A, C, uPt, wPt)) return false;
    }
    return true;
  };

  const heap = new MinAreaHeap();
  let minArea = 0;
  const pushVertex = i => {
    ver[i]++;
    const area = Math.max(triArea(pts[prev[i]], pts[i], pts[next[i]]), minArea);
    heap.push({ area, i, v: ver[i] });
  };
  for (let i = 0; i < n; i++) pushVertex(i);

  const tryRemove = i => {
    if (!canRemove(i)) { blocked[i] = 1; return false; }
    const area = triArea(pts[prev[i]], pts[i], pts[next[i]]);
    if (area > minArea) minArea = area;
    const p = prev[i], q = next[i];
    alive[i] = 0;
    aliveCount--;
    next[p] = q;
    prev[q] = p;
    blocked[p] = 0;
    blocked[q] = 0;
    pushVertex(p);
    pushVertex(q);
    return true;
  };

  while (aliveCount > target) {
    while (heap.size && aliveCount > target) {
      const top = heap.pop();
      if (!alive[top.i] || top.v !== ver[top.i]) continue;
      tryRemove(top.i);
    }
    if (aliveCount <= target) break;
    let progressed = false;
    const candidates = [];
    for (let i = 0; i < n; i++) {
      if (alive[i] && blocked[i]) {
        candidates.push({ i, area: triArea(pts[prev[i]], pts[i], pts[next[i]]) });
      }
    }
    candidates.sort((a, b) => a.area - b.area);
    for (const c of candidates) {
      if (!alive[c.i] || aliveCount <= target) continue;
      blocked[c.i] = 0;
      if (tryRemove(c.i)) { progressed = true; break; }
    }
    if (!progressed) break;
  }

  let start = 0;
  while (start < n && !alive[start]) start++;
  const out = [];
  let cur = start;
  for (let k = 0; k < aliveCount; k++) {
    out.push({ x: pts[cur].x, y: pts[cur].y });
    cur = next[cur];
  }
  return out;
}

/**
 * Splits a total point budget across multiple rings proportionally while keeping at
 * least 3 points per ring.
 */
export function allocatePointBudget(rings, totalTarget) {
  const mins = rings.map(r => Math.min(3, r.length));
  const caps = rings.map(r => r.length);
  const minSum = mins.reduce((a, b) => a + b, 0);
  const maxSum = caps.reduce((a, b) => a + b, 0);
  const budget = Math.max(minSum, Math.min(maxSum, Math.round(totalTarget)));
  const rem = budget - minSum;
  const slack = maxSum - minSum;
  if (slack <= 0) return caps;
  const alloc = mins.map((m, i) => m + Math.floor(rem * (caps[i] - m) / slack));
  let leftover = budget - alloc.reduce((a, b) => a + b, 0);
  if (leftover > 0) {
    const order = rings.map((_, i) => ({
      i,
      frac: (rem * (caps[i] - mins[i]) / slack) % 1
    })).sort((a, b) => b.frac - a.frac);
    for (const { i } of order) {
      if (!leftover) break;
      if (alloc[i] < caps[i]) { alloc[i]++; leftover--; }
    }
  }
  return alloc;
}

export function rotatePoint(p, cx, cy, radians) {
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const dx = p.x - cx, dy = p.y - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

// ---- colour (engine: module 2475 / dfb9) ----

export function hexToInt(value) {
  if (typeof value === 'number') return value | 0;
  if (typeof value !== 'string') return 0;
  return parseInt(value.replace('#', '').slice(0, 6), 16) || 0;
}

export function intToHex(value) {
  if (typeof value === 'string') return value.startsWith('#') ? value.toLowerCase() : '#' + value.toLowerCase();
  return '#' + ('00000' + (value | 0).toString(16)).slice(-6);
}

function redistributeRgb(r, g, b) {
  const t = 255.999;
  const m = Math.max(r, g, b);
  if (m <= t) return [r, g, b];
  const total = r + g + b;
  if (total >= 3 * t) return [t, t, t];
  const x = (3 * t - total) / (3 * m - total);
  const gray = t - x * m;
  return [gray + x * r, gray + x * g, gray + x * b];
}

function rgbToInt(c) {
  const h = v => ('0' + Math.floor(v).toString(16)).slice(-2);
  return parseInt(h(c[0]) + h(c[1]) + h(c[2]), 16);
}

function channels(color) {
  const s = ('00000' + (color | 0).toString(16)).slice(-6);
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

export function makeBrighter(color, factor) {
  let [r, g, b] = channels(color);
  let k = factor, a;
  if (r * factor > 280 && (a = 280 / r) < k) k = a;
  if (g * factor > 280 && (a = 280 / g) < k) k = a;
  if (b * factor > 280 && (a = 280 / b) < k) k = a;
  return rgbToInt(redistributeRgb(r * k, g * k, b * k));
}

export function mixColors(c1, c2) {
  let [n, r, o] = channels(c1);
  const [l, c, u] = channels(c2);
  const d = n + r + o, p = l + c + u;
  const h = ((d ? n / d : 0.33) + (p ? l / p : 0.33)) / 2;
  const m = ((d ? r / d : 0.33) + (p ? c / p : 0.33)) / 2;
  const g = ((d ? o / d : 0.33) + (p ? u / p : 0.33)) / 2;
  n = n + l === 0 ? 0 : n / (n + l) * n + l / (n + l) * l;
  r = r + c === 0 ? 0 : r / (r + c) * r + c / (r + c) * c;
  o = o + u === 0 ? 0 : o / (o + u) * o + u / (o + u) * u;
  n = Math.min(n, n * h); r = Math.min(r, r * m); o = Math.min(o, o * g);
  return rgbToInt(redistributeRgb(n, r, o));
}

export const finite = v => typeof v === 'number' && Number.isFinite(v);

/** Axis-aligned box of a point list as { minX, minY, maxX, maxY }. */
export function polygonBounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function boxOverlaps(b, minX, minY, maxX, maxY) {
  return b.maxX >= minX && b.minX <= maxX && b.maxY >= minY && b.minY <= maxY;
}
