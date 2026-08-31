import type { BinaryMask } from './types';

export interface Component {
  id: number;
  area: number;
  /** Inclusive bounding box. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Area-weighted centroid. */
  cx: number;
  cy: number;
  /** Touches the outer 1px frame, so the pill may be cut off. */
  touchesEdge: number;
  /** Set pixel indices, in raster order. */
  pixels: Int32Array;
}

export interface LabelResult {
  /** Per-pixel label, 0 for background, 1..n for components. */
  labels: Int32Array;
  components: Component[];
}

/**
 * 8-connected component labelling by iterative flood fill.
 *
 * 8-connectivity rather than 4 is deliberate: pills photographed at a slight
 * angle produce diagonal staircase edges, and 4-connectivity would split a
 * single pill into two blobs across such a staircase.
 *
 * The fill is an explicit stack rather than recursion because a large tray of
 * pills can produce components of tens of thousands of pixels, which would
 * blow the JS call stack on device.
 */
export function connectedComponents(mask: BinaryMask): LabelResult {
  const { width, height, data } = mask;
  const labels = new Int32Array(width * height);
  const components: Component[] = [];
  const stack = new Int32Array(width * height);

  let nextLabel = 0;

  for (let seed = 0; seed < data.length; seed++) {
    if (data[seed] === 0 || labels[seed] !== 0) continue;

    nextLabel++;
    let sp = 0;
    stack[sp++] = seed;
    labels[seed] = nextLabel;

    const pixels: number[] = [];
    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let touchesEdge = 0;

    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % width;
      const y = (idx / width) | 0;

      pixels.push(idx);
      area++;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge++;

      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const nIdx = ny * width + nx;
          if (data[nIdx] === 1 && labels[nIdx] === 0) {
            labels[nIdx] = nextLabel;
            stack[sp++] = nIdx;
          }
        }
      }
    }

    components.push({
      id: nextLabel,
      area,
      minX,
      minY,
      maxX,
      maxY,
      cx: sumX / area,
      cy: sumY / area,
      touchesEdge,
      pixels: Int32Array.from(pixels),
    });
  }

  return { labels, components };
}
