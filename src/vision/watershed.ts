import type { Component } from './connected';

export interface Basin {
  /** Pixel index of the distance-map maximum that seeded this basin. */
  peakIndex: number;
  /** Height of that maximum, i.e. the pill's inscribed radius in px. */
  peak: number;
  /** Area-weighted centroid, a steadier marker position than the peak. */
  cx: number;
  cy: number;
  area: number;
}

interface UnionFind {
  find(a: number): number;
  union(a: number, b: number): number;
}

function makeUnionFind(capacity: number, peaks: Float64Array): UnionFind {
  const parent = new Int32Array(capacity);
  for (let i = 0; i < capacity; i++) parent[i] = i;

  const find = (a: number): number => {
    let root = a;
    while (parent[root] !== root) root = parent[root];
    // Path compression keeps the repeated saddle lookups near constant time.
    while (parent[a] !== root) {
      const next = parent[a];
      parent[a] = root;
      a = next;
    }
    return root;
  };

  // Always keep the deeper peak as the representative, so a merged basin
  // reports the dominant pill's maximum rather than whichever id came first.
  const union = (a: number, b: number): number => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return ra;
    const winner = peaks[ra] >= peaks[rb] ? ra : rb;
    const loser = winner === ra ? rb : ra;
    parent[loser] = winner;
    return winner;
  };

  return { find, union };
}

/**
 * Light 3x3 mean smoothing of the distance map, restricted to one component.
 *
 * Rasterising a circle leaves single-pixel jitter along the distance ridge.
 * Without this, a perfectly good pill grows a handful of one-pixel-tall local
 * maxima. The persistence test below would discard them anyway, but smoothing
 * first keeps the basin count small and the sweep cheap.
 */
function smoothWithinComponent(
  dist: Float64Array,
  pixels: Int32Array,
  labels: Int32Array,
  componentId: number,
  width: number,
  height: number,
): Float64Array {
  const out = new Float64Array(dist.length);
  for (let i = 0; i < pixels.length; i++) {
    const idx = pixels[i];
    const x = idx % width;
    const y = (idx / width) | 0;
    let sum = 0;
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const nIdx = ny * width + nx;
        // Outside the component the distance is 0, which correctly pulls the
        // ridge down near the blob's border.
        sum += labels[nIdx] === componentId ? dist[nIdx] : 0;
        n++;
      }
    }
    out[idx] = sum / n;
  }
  return out;
}

/**
 * Split one connected blob into individual pills using a persistence-filtered
 * watershed on the Euclidean distance map.
 *
 * The idea: on the distance map each pill is a hill whose summit height equals
 * its inscribed radius, and two touching pills are two hills joined by a
 * saddle at the neck between them. Flooding downward from the highest pixel
 * assigns every pixel to a hill, which would over-segment wildly, so each time
 * two basins meet we measure the *persistence* of the shallower one - how far
 * its summit rises above the saddle where they met - and merge it away unless
 * that rise clears `h`.
 *
 * Persistence, rather than a fixed minimum separation between peaks, is what
 * lets one algorithm handle both shapes the app cares about:
 *
 *   - Two touching round tablets: the neck between them drops close to zero
 *     while both summits sit at the pill radius, so persistence is large and
 *     they stay apart.
 *   - A single oblong capsule: its distance ridge runs the length of the
 *     capsule at a near-constant height, so any bumps along that ridge are
 *     separated by saddles only a hair below them. Persistence is tiny and
 *     they collapse into the one pill they actually are.
 *
 * A minimum-distance-between-peaks rule, which is the obvious first thing to
 * reach for, gets the capsule case badly wrong: it reports one capsule as
 * three or four pills.
 *
 * @param h Persistence threshold in pixels. Summits that rise less than this
 *          above the saddle joining them are treated as the same pill.
 * @param minArea Basins smaller than this are absorbed into their deepest
 *          neighbour; they are edge slivers, not pills.
 */
export function watershedSplit(
  component: Component,
  dist: Float64Array,
  labels: Int32Array,
  width: number,
  height: number,
  h: number,
  minArea: number,
): Basin[] {
  const { pixels, id } = component;
  const smooth = smoothWithinComponent(dist, pixels, labels, id, width, height);

  // Descending sweep order: highest ground first, so every pixel already sees
  // the basins uphill of it by the time it is processed.
  const order = Array.from(pixels);
  order.sort((a, b) => smooth[b] - smooth[a]);

  const basinOf = new Map<number, number>();
  const peaks = new Float64Array(order.length + 1);
  const peakIndex = new Int32Array(order.length + 1);
  const uf = makeUnionFind(order.length + 1, peaks);
  let basinCount = 0;

  const neighbourRoots: number[] = [];

  for (let i = 0; i < order.length; i++) {
    const idx = order[i];
    const x = idx % width;
    const y = (idx / width) | 0;
    const level = smooth[idx];

    neighbourRoots.length = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const nIdx = ny * width + nx;
        const nb = basinOf.get(nIdx);
        if (nb === undefined) continue;
        const root = uf.find(nb);
        if (!neighbourRoots.includes(root)) neighbourRoots.push(root);
      }
    }

    if (neighbourRoots.length === 0) {
      // A new local maximum: the summit of a candidate pill.
      const b = ++basinCount;
      peaks[b] = level;
      peakIndex[b] = idx;
      basinOf.set(idx, b);
      continue;
    }

    if (neighbourRoots.length > 1) {
      // A saddle. Merge every basin that fails to clear `h` above this point
      // into the deepest one present.
      let deepest = neighbourRoots[0];
      for (const r of neighbourRoots) if (peaks[r] > peaks[deepest]) deepest = r;

      for (const r of neighbourRoots) {
        if (r === deepest) continue;
        if (peaks[r] - level < h) {
          const merged = uf.union(deepest, r);
          // union keeps the deeper summit, so refresh our handle on it.
          deepest = merged;
        }
      }
      basinOf.set(idx, uf.find(deepest));
      continue;
    }

    basinOf.set(idx, neighbourRoots[0]);
  }

  // Accumulate geometry per surviving root.
  const stats = new Map<number, { area: number; sx: number; sy: number }>();
  for (const [idx, b] of basinOf) {
    const root = uf.find(b);
    let s = stats.get(root);
    if (!s) {
      s = { area: 0, sx: 0, sy: 0 };
      stats.set(root, s);
    }
    s.area++;
    s.sx += idx % width;
    s.sy += (idx / width) | 0;
  }

  let basins: Basin[] = [];
  for (const [root, s] of stats) {
    basins.push({
      peakIndex: peakIndex[root],
      peak: peaks[root],
      cx: s.sx / s.area,
      cy: s.sy / s.area,
      area: s.area,
    });
  }

  // Drop slivers. A basin far below one pill's worth of area is a rim artifact
  // where the blob's outline bulges, not a pill somebody has to swallow.
  if (basins.length > 1) {
    const kept = basins.filter((b) => b.area >= minArea);
    if (kept.length > 0) basins = kept;
  }

  basins.sort((a, b) => b.peak - a.peak);
  return basins;
}
