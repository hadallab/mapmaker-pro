// Spike cleanup shared by the checks (validate.js) and their fixes (ops.js).

import { findEdgeReversals } from './tester.js';

// Drops the tips of 180-degree backtracking spikes until none are left.
export function removeSpikes(points) {
  let pts = points.slice();
  for (let guard = 0; guard < points.length && pts.length > 3; guard++) {
    const hits = findEdgeReversals(pts);
    if (!hits.length) break;
    const drop = new Set(hits);
    const next = pts.filter((_, i) => !drop.has(i));
    if (next.length < 3) break;
    pts = next;
  }
  return pts;
}
