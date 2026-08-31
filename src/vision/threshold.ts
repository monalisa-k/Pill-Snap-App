import { createMask } from './image';
import type { BinaryMask, GrayImage } from './types';

export interface OtsuResult {
  threshold: number;
  /**
   * Otsu's between-class variance at the chosen threshold. This doubles as a
   * separability score: a strongly bimodal image (pills clearly distinct from
   * tray) scores high, a flat or noisy one scores near zero.
   */
  betweenClassVariance: number;
  /** betweenClassVariance / totalVariance, in 0..1. */
  separability: number;
  /**
   * Gap between the two class means, in grey levels.
   *
   * Separability is scale-invariant, which makes it blind to whether a clean
   * split is also a meaningful one: two classes three levels apart score just
   * as high as two classes two hundred apart. This says how far apart they
   * actually are, which is what decides whether the split survives noise and
   * JPEG compression.
   */
  classSeparation: number;
}

export function histogram(img: GrayImage): Int32Array {
  const hist = new Int32Array(256);
  for (let i = 0; i < img.data.length; i++) hist[img.data[i]]++;
  return hist;
}

/**
 * Otsu's method: pick the threshold maximising between-class variance.
 * Single pass over the 256-bin histogram.
 */
export function otsu(img: GrayImage): OtsuResult {
  const hist = histogram(img);
  const total = img.data.length;

  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];

  let mean = sumAll / (total || 1);
  let totalVariance = 0;
  for (let t = 0; t < 256; t++) {
    const d = t - mean;
    totalVariance += hist[t] * d * d;
  }
  totalVariance /= total || 1;

  let sumBackground = 0;
  let weightBackground = 0;
  let best = 0;
  let bestVariance = -1;
  let bestSeparation = 0;

  for (let t = 0; t < 256; t++) {
    weightBackground += hist[t];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += t * hist[t];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sumAll - sumBackground) / weightForeground;
    const delta = meanBackground - meanForeground;
    const variance = weightBackground * weightForeground * delta * delta;

    if (variance > bestVariance) {
      bestVariance = variance;
      best = t;
      bestSeparation = Math.abs(delta);
    }
  }

  const betweenClassVariance = bestVariance / (total * total || 1);
  return {
    threshold: best,
    betweenClassVariance,
    separability: totalVariance > 0 ? betweenClassVariance / totalVariance : 0,
    classSeparation: bestSeparation,
  };
}

/** Threshold to a mask. `above` selects which side becomes foreground. */
export function threshold(img: GrayImage, t: number, above: boolean): BinaryMask {
  const mask = createMask(img.width, img.height);
  for (let i = 0; i < img.data.length; i++) {
    const hit = above ? img.data[i] > t : img.data[i] <= t;
    mask.data[i] = hit ? 1 : 0;
  }
  return mask;
}

/**
 * Sauvola local thresholding, used as a fallback when the global Otsu split is
 * weak. It adapts the threshold per pixel from the local mean and standard
 * deviation, which recovers pale pills sitting on a pale tray where a single
 * global cut cannot work.
 */
export function sauvola(img: GrayImage, radius: number, k = 0.16, R = 128): BinaryMask {
  const { width, height, data } = img;

  const sat = new Float64Array((width + 1) * (height + 1));
  const satSq = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    let rowSumSq = 0;
    for (let x = 0; x < width; x++) {
      const v = data[y * width + x];
      rowSum += v;
      rowSumSq += v * v;
      sat[(y + 1) * (width + 1) + (x + 1)] = sat[y * (width + 1) + (x + 1)] + rowSum;
      satSq[(y + 1) * (width + 1) + (x + 1)] = satSq[y * (width + 1) + (x + 1)] + rowSumSq;
    }
  }

  const mask = createMask(width, height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const n = (y1 - y0 + 1) * (x1 - x0 + 1);

      const s =
        sat[(y1 + 1) * (width + 1) + (x1 + 1)] -
        sat[y0 * (width + 1) + (x1 + 1)] -
        sat[(y1 + 1) * (width + 1) + x0] +
        sat[y0 * (width + 1) + x0];
      const sq =
        satSq[(y1 + 1) * (width + 1) + (x1 + 1)] -
        satSq[y0 * (width + 1) + (x1 + 1)] -
        satSq[(y1 + 1) * (width + 1) + x0] +
        satSq[y0 * (width + 1) + x0];

      const localMean = s / n;
      const variance = Math.max(0, sq / n - localMean * localMean);
      const stdDev = Math.sqrt(variance);
      const t = localMean * (1 + k * (stdDev / R - 1));
      mask.data[y * width + x] = data[y * width + x] > t ? 1 : 0;
    }
  }
  return mask;
}
