import { connectedComponents } from '../connected';
import { distanceTransform } from '../distanceTransform';
import { boxBlur, flattenIllumination, medianFilter3 } from '../filters';
import {
  borderForegroundRatio,
  createMask,
  downscaleGray,
  downscaleRgba,
  invertMask,
  maskArea,
  toLuma,
  toSaturation,
  upsampleBilinear,
} from '../image';
import { kmeans } from '../kmeans';
import { close, dilate, erode, fillHoles, open } from '../morphology';
import { focusMeasure } from '../quality';
import { median, medianAbsoluteDeviation, weightedMedian } from '../stats';
import { otsu, threshold } from '../threshold';
import type { BinaryMask, GrayImage, RgbaImage } from '../types';
import { watershedSplit } from '../watershed';

function grayFrom(rows: number[][]): GrayImage {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Uint8Array(width * height);
  rows.forEach((row, y) => row.forEach((v, x) => (data[y * width + x] = v)));
  return { width, height, data };
}

function maskFrom(rows: number[][]): BinaryMask {
  const g = grayFrom(rows);
  return { width: g.width, height: g.height, data: g.data };
}

function maskToRows(mask: BinaryMask): number[][] {
  const rows: number[][] = [];
  for (let y = 0; y < mask.height; y++) {
    rows.push(Array.from(mask.data.subarray(y * mask.width, (y + 1) * mask.width)));
  }
  return rows;
}

/** A filled disk mask, the shape the whole pipeline is tuned around. */
function diskMask(size: number, cx: number, cy: number, r: number): BinaryMask {
  const mask = createMask(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (Math.hypot(x - cx, y - cy) <= r) mask.data[y * size + x] = 1;
    }
  }
  return mask;
}

describe('stats', () => {
  it('takes the median of odd and even length inputs', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it('does not mutate its input', () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });

  it('lets weight rather than count decide the weighted median', () => {
    // Three specks and one real blob: the specks outnumber the blob but carry
    // almost no weight, which is exactly the pill-calibration situation.
    const values = [1, 1, 1, 14];
    const weights = [2, 2, 2, 600];
    expect(weightedMedian(values, weights)).toBe(14);
    expect(median(values)).toBe(1);
  });

  it('measures spread with the median absolute deviation', () => {
    expect(medianAbsoluteDeviation([10, 10, 10, 10])).toBe(0);
    expect(medianAbsoluteDeviation([1, 2, 3, 4, 100])).toBe(1);
  });
});

describe('otsu', () => {
  it('finds the split between two separated intensity clusters', () => {
    const data = new Uint8Array(1000);
    for (let i = 0; i < 500; i++) data[i] = 30;
    for (let i = 500; i < 1000; i++) data[i] = 200;
    const result = otsu({ width: 1000, height: 1, data });

    expect(result.threshold).toBeGreaterThanOrEqual(30);
    expect(result.threshold).toBeLessThan(200);
    expect(result.separability).toBeGreaterThan(0.95);
  });

  it('reports low separability for a flat image', () => {
    const data = new Uint8Array(1000).fill(128);
    expect(otsu({ width: 1000, height: 1, data }).separability).toBeLessThan(0.1);
  });

  it('thresholds on the requested side', () => {
    const img = grayFrom([[0, 100, 200]]);
    expect(Array.from(threshold(img, 100, true).data)).toEqual([0, 0, 1]);
    expect(Array.from(threshold(img, 100, false).data)).toEqual([1, 1, 0]);
  });
});

describe('morphology', () => {
  it('erodes away a single stray pixel', () => {
    const mask = maskFrom([
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);
    expect(maskArea(erode(mask, 1))).toBe(0);
  });

  it('dilate then erode returns a solid block unchanged', () => {
    // The block is kept clear of the frame on purpose. Erosion treats the
    // image border as "no data" rather than as background, so a blob that
    // dilation pushes up against the frame does not get eaten back off it.
    // That is the behaviour a pill cut off by the edge of the photo needs.
    const mask = createMask(20, 20);
    for (let y = 8; y < 13; y++) for (let x = 8; x < 13; x++) mask.data[y * 20 + x] = 1;
    expect(maskToRows(close(mask, 1))).toEqual(maskToRows(mask));
  });

  it('open removes speckle while leaving a real blob', () => {
    const mask = createMask(40, 40);
    for (let y = 15; y < 25; y++) for (let x = 15; x < 25; x++) mask.data[y * 40 + x] = 1;
    mask.data[2 * 40 + 2] = 1;
    mask.data[35 * 40 + 30] = 1;

    const opened = open(mask, 1);
    expect(maskArea(opened)).toBe(100);
    expect(opened.data[2 * 40 + 2]).toBe(0);
  });

  it('fills an enclosed hole but not a bay open to the outside', () => {
    const enclosed = maskFrom([
      [1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1],
      [1, 1, 0, 1, 1],
      [1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1],
    ]);
    expect(maskArea(fillHoles(enclosed))).toBe(25);

    const bay = maskFrom([
      [1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1],
      [1, 1, 0, 0, 0],
      [1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1],
    ]);
    expect(maskArea(fillHoles(bay))).toBe(22);
  });

  it('grows a blob by roughly the dilation radius', () => {
    const disk = diskMask(60, 30, 30, 10);
    const grown = dilate(disk, 2);
    expect(maskArea(grown)).toBeGreaterThan(maskArea(disk));
    // A square element of radius 2 cannot add more than the perimeter band.
    expect(maskArea(grown)).toBeLessThan(maskArea(diskMask(60, 30, 30, 13)));
  });
});

describe('distance transform', () => {
  it('peaks at the centre of a disk with the disk radius', () => {
    const disk = diskMask(80, 40, 40, 15);
    const dist = distanceTransform(disk);

    const centre = dist[40 * 80 + 40];
    expect(centre).toBeGreaterThan(14.5);
    expect(centre).toBeLessThan(16.5);
    expect(dist[0]).toBe(0);
  });

  it('is exactly Euclidean, not a chamfer approximation', () => {
    // One background pixel at the origin of an otherwise solid field: every
    // other pixel's value must be its true straight-line distance to it.
    const mask = createMask(20, 20);
    mask.data.fill(1);
    mask.data[0] = 0;
    const dist = distanceTransform(mask);

    for (const [x, y] of [
      [3, 4],
      [5, 12],
      [19, 19],
      [7, 7],
    ]) {
      expect(dist[y * 20 + x]).toBeCloseTo(Math.hypot(x, y), 6);
    }
  });

  it('gives a capsule a flat ridge rather than a single summit', () => {
    // A 60x20 capsule: every point along the centre line sits the same
    // distance from an edge, which is what makes a "peaks are pills" rule
    // mistake one capsule for several, and what the persistence rule in the
    // watershed is built to survive.
    //
    // The ridge reads 11 rather than 10 because the transform measures the
    // distance to the nearest *background* pixel, and for a shape rasterised
    // at radius 10 the first background pixel is one step beyond the last
    // foreground one. The pipeline only ever uses this measurement relatively,
    // so the consistent off-by-one costs nothing.
    const mask = createMask(100, 40);
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 100; x++) {
        const cx = Math.min(Math.max(x, 30), 70);
        if (Math.hypot(x - cx, y - 20) <= 10) mask.data[y * 100 + x] = 1;
      }
    }
    const dist = distanceTransform(mask);

    const ridge = [32, 40, 50, 60, 68].map((x) => dist[20 * 100 + x]);
    for (const v of ridge) {
      expect(v).toBeGreaterThan(10.2);
      expect(v).toBeLessThan(11.2);
    }
    // Flat, not peaked: that flatness is the whole point. The slight dip
    // toward the ends is the rounded cap bringing background in diagonally.
    expect(Math.max(...ridge) - Math.min(...ridge)).toBeLessThan(0.75);
  });
});

describe('connected components', () => {
  it('separates disjoint blobs and measures each one', () => {
    const mask = createMask(60, 30);
    for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) mask.data[y * 60 + x] = 1;
    for (let y = 5; y < 15; y++) for (let x = 40; x < 50; x++) mask.data[y * 60 + x] = 1;

    const { components } = connectedComponents(mask);
    expect(components).toHaveLength(2);
    expect(components[0].area).toBe(100);
    expect(components[0].cx).toBeCloseTo(9.5, 5);
    expect(components[1].cx).toBeCloseTo(44.5, 5);
  });

  it('keeps a diagonal staircase as one component', () => {
    // 4-connectivity would split this into three; a pill photographed at an
    // angle has exactly this edge structure.
    const mask = maskFrom([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    expect(connectedComponents(mask).components).toHaveLength(1);
  });

  it('flags components that run off the frame', () => {
    const mask = createMask(20, 20);
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) mask.data[y * 20 + x] = 1;
    expect(connectedComponents(mask).components[0].touchesEdge).toBeGreaterThan(0);
  });

  it('handles a component far larger than the JS call stack allows recursion for', () => {
    const mask = createMask(400, 400);
    mask.data.fill(1);
    const { components } = connectedComponents(mask);
    expect(components).toHaveLength(1);
    expect(components[0].area).toBe(160000);
  });
});

describe('watershed splitting', () => {
  function splitCount(mask: BinaryMask, h: number): number {
    const dist = distanceTransform(mask);
    const { labels, components } = connectedComponents(mask);
    return watershedSplit(components[0], dist, labels, mask.width, mask.height, h, 0).length;
  }

  it('splits two touching disks into two', () => {
    const mask = createMask(120, 60);
    for (let y = 0; y < 60; y++) {
      for (let x = 0; x < 120; x++) {
        if (Math.hypot(x - 44, y - 30) <= 15 || Math.hypot(x - 74, y - 30) <= 15) {
          mask.data[y * 120 + x] = 1;
        }
      }
    }
    expect(connectedComponents(mask).components).toHaveLength(1);
    expect(splitCount(mask, 15 * 0.18)).toBe(2);
  });

  it('keeps a single capsule as one pill despite its long flat ridge', () => {
    const mask = createMask(120, 50);
    for (let y = 0; y < 50; y++) {
      for (let x = 0; x < 120; x++) {
        const cx = Math.min(Math.max(x, 35), 85);
        if (Math.hypot(x - cx, y - 25) <= 12) mask.data[y * 120 + x] = 1;
      }
    }
    expect(splitCount(mask, 12 * 0.18)).toBe(1);
  });

  it('leaves a lone disk as one pill', () => {
    expect(splitCount(diskMask(80, 40, 40, 16), 16 * 0.18)).toBe(1);
  });
});

describe('kmeans', () => {
  it('recovers two well-separated clusters', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
      { x: 100, y: 100 },
      { x: 101, y: 101 },
      { x: 100, y: 101 },
    ];
    const centres = kmeans(points, 2);
    expect(centres).toHaveLength(2);

    const xs = centres.map((c) => c.x).sort((a, b) => a - b);
    expect(xs[0]).toBeLessThan(10);
    expect(xs[1]).toBeGreaterThan(90);
  });

  it('is deterministic, so the same photo never yields two different counts', () => {
    const points = Array.from({ length: 200 }, (_, i) => ({
      x: (i * 37) % 100,
      y: (i * 61) % 100,
    }));
    expect(kmeans(points, 4)).toEqual(kmeans(points, 4));
  });

  it('degenerates gracefully when k exceeds the point count', () => {
    expect(kmeans([{ x: 1, y: 1 }], 5)).toHaveLength(1);
    expect(kmeans([], 3)).toHaveLength(0);
  });
});

describe('image utilities', () => {
  const solid = (w: number, h: number, r: number, g: number, b: number): RgbaImage => {
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = r;
      data[i * 4 + 1] = g;
      data[i * 4 + 2] = b;
      data[i * 4 + 3] = 255;
    }
    return { width: w, height: h, data };
  };

  it('computes luma and saturation', () => {
    expect(toLuma(solid(2, 2, 255, 255, 255)).data[0]).toBeGreaterThan(250);
    expect(toLuma(solid(2, 2, 0, 0, 0)).data[0]).toBe(0);
    // A saturated red is bright on the saturation channel but mid on luma.
    expect(toSaturation(solid(2, 2, 255, 0, 0)).data[0]).toBe(255);
    expect(toSaturation(solid(2, 2, 128, 128, 128)).data[0]).toBe(0);
  });

  it('downscales by averaging rather than dropping pixels', () => {
    const img = solid(8, 8, 100, 100, 100);
    // Make one pixel bright; averaging must carry some of it into the result.
    img.data[0] = 255;
    const small = downscaleRgba(img, 4);
    expect(small.width).toBe(4);
    expect(small.data[0]).toBeGreaterThan(100);
    expect(small.data[0]).toBeLessThan(255);
  });

  it('leaves an already-small image untouched', () => {
    const img = solid(10, 10, 50, 50, 50);
    expect(downscaleRgba(img, 100)).toBe(img);
  });

  it('round-trips a smooth gradient through downscale and upsample', () => {
    const width = 64;
    const height = 64;
    const data = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) data[y * width + x] = Math.round((x / width) * 200) + 20;
    }
    const original: GrayImage = { width, height, data };
    const restored = upsampleBilinear(downscaleGray(original, 8), width, height);

    // This is the approximation the illumination model relies on: a smooth
    // gradient must survive the round trip nearly intact.
    let maxError = 0;
    for (let i = 0; i < data.length; i++) {
      maxError = Math.max(maxError, Math.abs(restored.data[i] - data[i]));
    }
    expect(maxError).toBeLessThan(12);
  });

  it('reports border coverage, which is how pill/tray polarity is decided', () => {
    const mask = createMask(10, 10);
    expect(borderForegroundRatio(mask)).toBe(0);
    mask.data.fill(1);
    expect(borderForegroundRatio(mask)).toBe(1);
    expect(maskArea(invertMask(mask))).toBe(0);
  });
});

describe('filters', () => {
  it('box blur preserves a constant field', () => {
    const img = grayFrom(Array.from({ length: 20 }, () => new Array(20).fill(120)));
    const blurred = boxBlur(img, 3);
    for (let i = 0; i < blurred.data.length; i++) expect(blurred.data[i]).toBe(120);
  });

  it('median filter removes salt-and-pepper noise but keeps an edge', () => {
    const rows: number[][] = Array.from({ length: 9 }, () =>
      Array.from({ length: 9 }, (_, x) => (x < 4 ? 20 : 200)),
    );
    rows[4][1] = 255;
    rows[6][7] = 0;

    const filtered = medianFilter3(grayFrom(rows));
    expect(filtered.data[4 * 9 + 1]).toBe(20);
    expect(filtered.data[6 * 9 + 7]).toBe(200);
    // The edge itself must survive.
    expect(filtered.data[4 * 9 + 2]).toBe(20);
    expect(filtered.data[4 * 9 + 6]).toBe(200);
  });

  it('flattens a lighting gradient off a uniform surface', () => {
    const width = 120;
    const height = 120;
    const data = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // A steep corner-to-corner falloff over an otherwise flat tray.
        data[y * width + x] = Math.round(200 - 120 * ((x / width + y / height) / 2));
      }
    }

    const before = { width, height, data };
    const after = flattenIllumination(before);

    const spread = (img: GrayImage) => {
      let min = 255;
      let max = 0;
      for (let i = 0; i < img.data.length; i++) {
        if (img.data[i] < min) min = img.data[i];
        if (img.data[i] > max) max = img.data[i];
      }
      return max - min;
    };

    expect(spread(before)).toBeGreaterThan(100);
    // Most of the gradient goes, not all of it: the background estimate is a
    // mean filter, and in the extreme corners its window is clipped by the
    // frame, so it under-reads the falloff there. What matters downstream is
    // that Otsu sees one population of tray pixels rather than two, and the
    // end-to-end lighting-gradient scenes in counting.test.ts confirm that
    // this much correction is enough.
    expect(spread(after)).toBeLessThan(spread(before) * 0.4);
  });
});

describe('focus measure', () => {
  it('scores a sharp edge far above a smooth ramp', () => {
    const size = 60;
    const sharp = new Uint8Array(size * size);
    const smooth = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        sharp[y * size + x] = x < size / 2 ? 20 : 230;
        smooth[y * size + x] = Math.round((x / size) * 210) + 20;
      }
    }
    const sharpScore = focusMeasure({ width: size, height: size, data: sharp });
    const smoothScore = focusMeasure({ width: size, height: size, data: smooth });
    expect(sharpScore).toBeGreaterThan(smoothScore * 10);
  });
});
