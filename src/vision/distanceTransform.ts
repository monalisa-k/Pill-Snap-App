import type { BinaryMask } from './types';

const INF = 1e20;

/**
 * 1D squared Euclidean distance transform of a sampled function, from
 * Felzenszwalb & Huttenlocher, "Distance Transforms of Sampled Functions".
 *
 * It walks the lower envelope of the parabolas rooted at each sample, which
 * makes the whole thing O(n) per row/column instead of O(n^2). Applied to rows
 * then columns it gives the exact squared Euclidean distance, not the
 * chamfer/Manhattan approximation. Exactness matters here: the pill splitter
 * compares peak heights against a calibrated radius, and a chamfer metric's
 * ~5% directional error is enough to drop a real pill or invent a fake one in
 * a tight cluster.
 */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;

  for (let q = 1; q < n; q++) {
    // Intersection of the parabola from q with the one currently on top.
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dist = q - v[k];
    d[q] = dist * dist + f[v[k]];
  }
}

/**
 * Exact Euclidean distance from every foreground pixel to the nearest
 * background pixel. Background pixels get 0.
 *
 * For a round pill this peaks at the centre with a value equal to its radius,
 * which is precisely the signal the cluster splitter keys on: two touching
 * pills give two peaks separated by a saddle, however narrow the neck between
 * them is.
 */
export function distanceTransform(mask: BinaryMask): Float64Array {
  const { width, height, data } = mask;
  const f = new Float64Array(Math.max(width, height));
  const d = new Float64Array(Math.max(width, height));
  const v = new Int32Array(Math.max(width, height));
  const z = new Float64Array(Math.max(width, height) + 1);

  const result = new Float64Array(width * height);
  for (let i = 0; i < result.length; i++) result[i] = data[i] === 1 ? INF : 0;

  // Columns.
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = result[y * width + x];
    edt1d(f, height, d, v, z);
    for (let y = 0; y < height; y++) result[y * width + x] = d[y];
  }

  // Rows.
  for (let y = 0; y < height; y++) {
    const base = y * width;
    for (let x = 0; x < width; x++) f[x] = result[base + x];
    edt1d(f, width, d, v, z);
    for (let x = 0; x < width; x++) result[base + x] = Math.sqrt(d[x]);
  }

  return result;
}
