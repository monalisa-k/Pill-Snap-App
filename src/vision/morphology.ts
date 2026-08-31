import { createMask } from './image';
import type { BinaryMask } from './types';

/**
 * Binary erosion/dilation with a square structuring element.
 *
 * A square is separable, so this runs as a horizontal pass then a vertical
 * pass, each maintaining a running count of set pixels in the window. Cost is
 * O(n) in the number of pixels regardless of radius, where the equivalent disk
 * element would cost O(n * radius^2).
 *
 * The pipeline only ever uses radius 1-2 here, purely to knock off speckle and
 * close pinholes, so the corner-biting a square does relative to a disk stays
 * well under a pixel and never reaches the calibrated pill area.
 */
function morph(mask: BinaryMask, radius: number, mode: 'erode' | 'dilate'): BinaryMask {
  if (radius < 1) return { width: mask.width, height: mask.height, data: Uint8Array.from(mask.data) };
  const { width, height } = mask;
  const erode = mode === 'erode';

  // Horizontal pass into a scratch buffer, then vertical pass into the output.
  const pass = (src: Uint8Array, horizontal: boolean): Uint8Array => {
    const dst = new Uint8Array(width * height);
    const outer = horizontal ? height : width;
    const inner = horizontal ? width : height;
    const stride = horizontal ? 1 : width;

    for (let o = 0; o < outer; o++) {
      const base = horizontal ? o * width : o;
      let ones = 0;
      // Prime the window over [0, radius].
      for (let i = 0; i <= radius && i < inner; i++) ones += src[base + i * stride];

      for (let i = 0; i < inner; i++) {
        const windowStart = i - radius;
        const windowEnd = i + radius;
        const size =
          Math.min(inner - 1, windowEnd) - Math.max(0, windowStart) + 1;
        dst[base + i * stride] = erode ? (ones === size ? 1 : 0) : ones > 0 ? 1 : 0;

        // Slide: drop the pixel leaving the window, add the one entering it.
        const leaving = i - radius;
        if (leaving >= 0) ones -= src[base + leaving * stride];
        const entering = i + radius + 1;
        if (entering < inner) ones += src[base + entering * stride];
      }
    }
    return dst;
  };

  const horizontal = pass(mask.data, true);
  const vertical = pass(horizontal, false);
  return { width, height, data: vertical };
}

export function erode(mask: BinaryMask, radius = 1): BinaryMask {
  return morph(mask, radius, 'erode');
}

export function dilate(mask: BinaryMask, radius = 1): BinaryMask {
  return morph(mask, radius, 'dilate');
}

/** Erode then dilate: removes specks smaller than the element. */
export function open(mask: BinaryMask, radius = 1): BinaryMask {
  return dilate(erode(mask, radius), radius);
}

/** Dilate then erode: closes pinholes and hairline cracks inside pills. */
export function close(mask: BinaryMask, radius = 1): BinaryMask {
  return erode(dilate(mask, radius), radius);
}

/**
 * Fill background regions that cannot reach the image border.
 *
 * Printed imprints, score lines and specular highlights punch holes in a pill
 * after thresholding. Left alone those holes distort both the pill's area
 * (breaking calibration) and its distance transform (inventing extra peaks
 * inside one pill). Flood filling the background inward from the border and
 * treating everything unreached as pill interior removes the whole class of
 * error.
 */
export function fillHoles(mask: BinaryMask): BinaryMask {
  const { width, height, data } = mask;
  const reachable = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let sp = 0;

  const push = (idx: number) => {
    if (data[idx] === 0 && reachable[idx] === 0) {
      reachable[idx] = 1;
      stack[sp++] = idx;
    }
  };

  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }

  while (sp > 0) {
    const idx = stack[--sp];
    const x = idx % width;
    const y = (idx / width) | 0;
    if (x > 0) push(idx - 1);
    if (x < width - 1) push(idx + 1);
    if (y > 0) push(idx - width);
    if (y < height - 1) push(idx + width);
  }

  const out = createMask(width, height);
  for (let i = 0; i < out.data.length; i++) {
    out.data[i] = data[i] === 1 || reachable[i] === 0 ? 1 : 0;
  }
  return out;
}
