import { downscaleGray, upsampleBilinear } from './image';
import type { GrayImage } from './types';

/**
 * Mean filter over a (2r+1)^2 window via a summed-area table, so cost is
 * independent of the radius. The illumination model needs a very large radius
 * (tens of pixels), which a naive convolution could not afford on device.
 */
export function boxBlur(img: GrayImage, radius: number): GrayImage {
  const { width, height, data } = img;
  if (radius < 1) return { width, height, data: Uint8Array.from(data) };

  // Integral image with a zero row/column so window sums need no clamping.
  const sat = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += data[y * width + x];
      sat[(y + 1) * (width + 1) + (x + 1)] = sat[y * (width + 1) + (x + 1)] + rowSum;
    }
  }

  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const sum =
        sat[(y1 + 1) * (width + 1) + (x1 + 1)] -
        sat[y0 * (width + 1) + (x1 + 1)] -
        sat[(y1 + 1) * (width + 1) + x0] +
        sat[y0 * (width + 1) + x0];
      const n = (y1 - y0 + 1) * (x1 - x0 + 1);
      out[y * width + x] = Math.round(sum / n);
    }
  }
  return { width, height, data: out };
}

/**
 * Remove the low-frequency lighting gradient.
 *
 * A phone flash or an overhead lamp makes one corner of the tray much brighter
 * than the other. A single global threshold then either loses the pills in the
 * dark corner or floods the bright one. Dividing the image by a heavily
 * blurred copy of itself (a homomorphic-style flat field correction) removes
 * that gradient while preserving the local pill-vs-tray contrast, which is
 * what Otsu actually needs.
 *
 * The blur radius must be large relative to a pill or the pills would flatten
 * themselves away; a quarter of the shortest edge is comfortably larger than
 * any single pill in a sane framing.
 *
 * The illumination model is estimated on a 1/8-scale copy and bilinearly
 * upsampled. Since the thing being estimated is by construction the lowest
 * frequency content in the frame, that costs nothing in accuracy and turns the
 * most expensive step in the pipeline into one of the cheapest - which is what
 * makes the whole count feel instant on a phone rather than a two-second wait.
 */
export function flattenIllumination(img: GrayImage, radius?: number): GrayImage {
  const { width, height, data } = img;
  const r = radius ?? Math.max(8, Math.round(Math.min(width, height) / 4));

  const factor = 8;
  const small = downscaleGray(img, factor);
  const smallRadius = Math.max(1, Math.round(r / factor));
  const smallBackground = boxBlur(small, smallRadius);
  const background = upsampleBilinear(smallBackground, width, height);

  let mean = 0;
  for (let i = 0; i < data.length; i++) mean += data[i];
  mean /= data.length || 1;

  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const bg = background.data[i] || 1;
    const v = (data[i] / bg) * mean;
    out[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }
  return { width, height, data: out };
}

/**
 * 3x3 median filter. Kills isolated speckle (dust on the tray, sensor noise)
 * without the edge rounding a Gaussian would cause, which keeps pill borders
 * crisp enough for the distance transform to find clean peaks.
 */
export function medianFilter3(img: GrayImage): GrayImage {
  const { width, height, data } = img;
  const out = new Uint8Array(width * height);
  const w: number[] = new Array(9);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          w[n++] = data[yy * width + xx];
        }
      }
      // Insertion sort: n is at most 9, so this beats Array.prototype.sort.
      for (let i = 1; i < n; i++) {
        const v = w[i];
        let j = i - 1;
        while (j >= 0 && w[j] > v) {
          w[j + 1] = w[j];
          j--;
        }
        w[j + 1] = v;
      }
      out[y * width + x] = w[n >> 1];
    }
  }
  return { width, height, data: out };
}
