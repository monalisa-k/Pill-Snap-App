import type { GrayImage } from './types';

export interface QualityReport {
  /** Variance of the Laplacian, normalised. Higher is sharper. */
  focus: number;
  /** Fraction of pixels that are blown out to near-white. */
  glare: number;
  /** Fraction of pixels crushed to near-black. */
  crush: number;
}

/**
 * Variance of the Laplacian, the standard no-reference sharpness measure.
 *
 * A blurred photo is the single biggest cause of a wrong count that no amount
 * of downstream cleverness can fix: pill borders smear together, the mask
 * fuses neighbours into one blob, and the distance ridge between them fills
 * in. Detecting it up front and asking for a re-shoot is far better than
 * confidently returning a wrong number, which is the failure mode users
 * actually get burned by.
 */
export function focusMeasure(img: GrayImage): number {
  const { width, height, data } = img;
  if (width < 3 || height < 3) return 0;

  let sum = 0;
  let sumSq = 0;
  let n = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      // 4-neighbour discrete Laplacian.
      const lap =
        data[i - 1] + data[i + 1] + data[i - width] + data[i + width] - 4 * data[i];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }

  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export function exposureRatios(img: GrayImage): { glare: number; crush: number } {
  let hot = 0;
  let cold = 0;
  for (let i = 0; i < img.data.length; i++) {
    if (img.data[i] >= 250) hot++;
    else if (img.data[i] <= 5) cold++;
  }
  return { glare: hot / img.data.length, crush: cold / img.data.length };
}

export function assessQuality(gray: GrayImage): QualityReport {
  const { glare, crush } = exposureRatios(gray);
  return { focus: focusMeasure(gray), glare, crush };
}

/**
 * Empirical cutoffs, tuned against the synthetic suite and sanity-checked to
 * leave headroom: a genuinely sharp tray photo scores in the hundreds, while a
 * visibly soft one falls under 30.
 *
 * The glare cutoff is deliberately low. Two per cent of the frame sounds
 * negligible, but a blown highlight that size is comfortably bigger than a
 * pill, so it can hide one completely - and a hidden pill costs the user a
 * silently wrong count, which is the one outcome worth being twitchy about.
 */
export const FOCUS_BLURRY_BELOW = 30;
export const GLARE_WARN_ABOVE = 0.02;
