export interface Point {
  x: number;
  y: number;
}

/**
 * Deterministic 2D k-means over pixel coordinates.
 *
 * This is the fallback for the one case the watershed cannot resolve: pills
 * fused into a blob with no saddle between them at all. Two capsules lying
 * side by side with their long edges flush merge into a single rounded
 * rectangle whose distance ridge has exactly one summit, so the watershed
 * honestly sees one hill. The blob's *area*, though, is unmistakably two
 * pills' worth, and when that cross-check fires we fall back to splitting the
 * blob's pixels geometrically so the markers land in the right places.
 *
 * Seeding is farthest-point rather than random so the same photo always
 * produces the same answer - a count that changed between two runs of the same
 * image would destroy trust in the number far faster than being off by one.
 */
export function kmeans(points: Point[], k: number, iterations = 24): Point[] {
  if (k <= 1 || points.length <= k) {
    return points.length === 0 ? [] : [centroid(points)];
  }

  // Farthest-point seeding: start at the centroid's nearest point, then
  // repeatedly take the point furthest from everything chosen so far.
  const centres: Point[] = [];
  const c0 = centroid(points);
  centres.push(nearestTo(points, c0));

  while (centres.length < k) {
    let best = points[0];
    let bestDist = -1;
    for (const p of points) {
      let nearest = Infinity;
      for (const c of centres) {
        const d = (p.x - c.x) ** 2 + (p.y - c.y) ** 2;
        if (d < nearest) nearest = d;
      }
      if (nearest > bestDist) {
        bestDist = nearest;
        best = p;
      }
    }
    centres.push({ x: best.x, y: best.y });
  }

  const assignment = new Int32Array(points.length);
  for (let iter = 0; iter < iterations; iter++) {
    let moved = false;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const d = (p.x - centres[c].x) ** 2 + (p.y - centres[c].y) ** 2;
        if (d < bestDist) {
          bestDist = d;
          bestIdx = c;
        }
      }
      if (assignment[i] !== bestIdx) {
        assignment[i] = bestIdx;
        moved = true;
      }
    }

    const sums = centres.map(() => ({ x: 0, y: 0, n: 0 }));
    for (let i = 0; i < points.length; i++) {
      const s = sums[assignment[i]];
      s.x += points[i].x;
      s.y += points[i].y;
      s.n++;
    }
    for (let c = 0; c < centres.length; c++) {
      if (sums[c].n > 0) {
        centres[c] = { x: sums[c].x / sums[c].n, y: sums[c].y / sums[c].n };
      }
    }

    if (!moved && iter > 0) break;
  }

  return centres;
}

function centroid(points: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

function nearestTo(points: Point[], target: Point): Point {
  let best = points[0];
  let bestDist = Infinity;
  for (const p of points) {
    const d = (p.x - target.x) ** 2 + (p.y - target.y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return { x: best.x, y: best.y };
}
