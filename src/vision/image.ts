import type { BinaryMask, GrayImage, RgbaImage } from './types';

export function createGray(width: number, height: number): GrayImage {
  return { width, height, data: new Uint8Array(width * height) };
}

export function createMask(width: number, height: number): BinaryMask {
  return { width, height, data: new Uint8Array(width * height) };
}

/** Rec. 601 luma, the channel that behaves best for white pills on a dark tray. */
export function toLuma(img: RgbaImage): GrayImage {
  const { width, height, data } = img;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  }
  return { width, height, data: out };
}

/**
 * HSV saturation as a byte. Coloured pills on a white or steel tray separate
 * far better on saturation than on brightness, so the pipeline tries both.
 */
export function toSaturation(img: RgbaImage): GrayImage {
  const { width, height, data } = img;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const max = r > g ? (r > b ? r : b) : g > b ? g : b;
    const min = r < g ? (r < b ? r : b) : g < b ? g : b;
    out[i] = max === 0 ? 0 : Math.round(((max - min) * 255) / max);
  }
  return { width, height, data: out };
}

/** Extract one of the raw colour channels. */
export function toChannel(img: RgbaImage, channel: 0 | 1 | 2): GrayImage {
  const { width, height, data } = img;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = channel; i < out.length; i++, p += 4) out[i] = data[p];
  return { width, height, data: out };
}

/**
 * Box-average downscale. Averaging over the source footprint (rather than
 * nearest-neighbour sampling) matters here: it suppresses sensor noise and
 * print/imprint texture on the pills themselves, which would otherwise
 * fragment a pill into several blobs during thresholding.
 */
export function downscaleRgba(img: RgbaImage, maxDimension: number): RgbaImage {
  const { width, height, data } = img;
  const longest = Math.max(width, height);
  if (longest <= maxDimension) return img;

  const scale = maxDimension / longest;
  const dw = Math.max(1, Math.round(width * scale));
  const dh = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(dw * dh * 4);

  const xRatio = width / dw;
  const yRatio = height / dh;

  for (let dy = 0; dy < dh; dy++) {
    const sy0 = Math.floor(dy * yRatio);
    const sy1 = Math.max(sy0 + 1, Math.floor((dy + 1) * yRatio));
    for (let dx = 0; dx < dw; dx++) {
      const sx0 = Math.floor(dx * xRatio);
      const sx1 = Math.max(sx0 + 1, Math.floor((dx + 1) * xRatio));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1 && sy < height; sy++) {
        let sp = (sy * width + sx0) * 4;
        for (let sx = sx0; sx < sx1 && sx < width; sx++, sp += 4) {
          r += data[sp];
          g += data[sp + 1];
          b += data[sp + 2];
          a += data[sp + 3];
          n++;
        }
      }
      const dp = (dy * dw + dx) * 4;
      out[dp] = r / n;
      out[dp + 1] = g / n;
      out[dp + 2] = b / n;
      out[dp + 3] = a / n;
    }
  }

  return { width: dw, height: dh, data: out };
}

/** Count set pixels in a mask. */
export function maskArea(mask: BinaryMask): number {
  let n = 0;
  for (let i = 0; i < mask.data.length; i++) n += mask.data[i];
  return n;
}

/** Fraction of the 1px border that is foreground. Used to detect polarity. */
export function borderForegroundRatio(mask: BinaryMask): number {
  const { width, height, data } = mask;
  let fg = 0;
  let total = 0;
  for (let x = 0; x < width; x++) {
    fg += data[x] + data[(height - 1) * width + x];
    total += 2;
  }
  for (let y = 1; y < height - 1; y++) {
    fg += data[y * width] + data[y * width + width - 1];
    total += 2;
  }
  return total === 0 ? 0 : fg / total;
}

export function invertMask(mask: BinaryMask): BinaryMask {
  const out = new Uint8Array(mask.data.length);
  for (let i = 0; i < out.length; i++) out[i] = mask.data[i] ? 0 : 1;
  return { width: mask.width, height: mask.height, data: out };
}

/** Box-average downscale of a single channel. */
export function downscaleGray(img: GrayImage, factor: number): GrayImage {
  const { width, height, data } = img;
  if (factor <= 1) return { width, height, data: Uint8Array.from(data) };

  const dw = Math.max(1, Math.round(width / factor));
  const dh = Math.max(1, Math.round(height / factor));
  const out = new Uint8Array(dw * dh);
  const xRatio = width / dw;
  const yRatio = height / dh;

  for (let dy = 0; dy < dh; dy++) {
    const sy0 = Math.floor(dy * yRatio);
    const sy1 = Math.max(sy0 + 1, Math.floor((dy + 1) * yRatio));
    for (let dx = 0; dx < dw; dx++) {
      const sx0 = Math.floor(dx * xRatio);
      const sx1 = Math.max(sx0 + 1, Math.floor((dx + 1) * xRatio));
      let sum = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1 && sy < height; sy++) {
        const base = sy * width;
        for (let sx = sx0; sx < sx1 && sx < width; sx++) {
          sum += data[base + sx];
          n++;
        }
      }
      out[dy * dw + dx] = sum / n;
    }
  }
  return { width: dw, height: dh, data: out };
}

/** Bilinear upsample of a single channel to an exact target size. */
export function upsampleBilinear(
  img: GrayImage,
  targetWidth: number,
  targetHeight: number,
): GrayImage {
  const { width, height, data } = img;
  const out = new Uint8Array(targetWidth * targetHeight);
  const xScale = width > 1 ? (width - 1) / Math.max(1, targetWidth - 1) : 0;
  const yScale = height > 1 ? (height - 1) / Math.max(1, targetHeight - 1) : 0;

  for (let y = 0; y < targetHeight; y++) {
    const sy = y * yScale;
    const y0 = Math.floor(sy);
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = sy - y0;

    for (let x = 0; x < targetWidth; x++) {
      const sx = x * xScale;
      const x0 = Math.floor(sx);
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = sx - x0;

      const top = data[y0 * width + x0] * (1 - fx) + data[y0 * width + x1] * fx;
      const bottom = data[y1 * width + x0] * (1 - fx) + data[y1 * width + x1] * fx;
      out[y * targetWidth + x] = Math.round(top * (1 - fy) + bottom * fy);
    }
  }
  return { width: targetWidth, height: targetHeight, data: out };
}
