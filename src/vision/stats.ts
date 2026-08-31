/** Median of a numeric array. Does not mutate the input. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Median of `values` where each entry carries a weight.
 *
 * Used to calibrate pill size from blob measurements: weighting by blob area
 * means a handful of dust specks cannot drag the estimate down, because they
 * contribute almost nothing to the total weight, while a plain median over
 * blob counts would let them vote as loudly as a real pill.
 */
export function weightedMedian(values: number[], weights: number[]): number {
  if (values.length === 0) return 0;
  const pairs = values
    .map((v, i) => ({ v, w: weights[i] }))
    .sort((a, b) => a.v - b.v);

  const total = pairs.reduce((sum, p) => sum + p.w, 0);
  if (total <= 0) return median(values);

  let acc = 0;
  for (const p of pairs) {
    acc += p.w;
    if (acc >= total / 2) return p.v;
  }
  return pairs[pairs.length - 1].v;
}

/** Median absolute deviation, a spread measure that outliers cannot inflate. */
export function medianAbsoluteDeviation(values: number[]): number {
  if (values.length === 0) return 0;
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
