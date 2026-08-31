import type { RgbaImage } from '../types';

/**
 * Synthetic pill-scene generator.
 *
 * The counting core is pure arithmetic over pixels, so it can be exercised
 * exhaustively without a camera: these helpers render trays of pills with
 * known ground truth and then degrade them the way real photos are degraded -
 * uneven lighting, sensor noise, soft focus, glare, pills shoved together.
 * Every scene is driven by a seeded PRNG, so a failure is always reproducible
 * from the seed printed in the test name.
 */

/** Mulberry32: small, fast, and reproducible across machines. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface PillSpec {
  x: number;
  y: number;
  /** Half-width: the radius of a round tablet, or half a capsule's thickness. */
  radius: number;
  /** Centre-line length for a capsule. 0 makes a circle. */
  length: number;
  /** Rotation in radians. */
  angle: number;
  colour: Rgb;
}

export interface SceneOptions {
  width?: number;
  height?: number;
  background?: Rgb;
  /** Strength of the corner-to-corner lighting falloff, 0..1. */
  lighting?: number;
  /** Gaussian sensor noise standard deviation, in 8-bit levels. */
  noise?: number;
  /** Box-blur radius applied at the end, simulating soft focus. */
  blur?: number;
  /** Adds a bright specular blob, simulating flash glare. */
  glare?: boolean;
  /**
   * Draws a debossed score line across each pill, 0..1 for how dark it goes.
   * Real tablets are almost all scored or imprinted, and a score line deep
   * enough to cross the threshold is what splits one pill into two blobs.
   */
  imprint?: number;
  /** Width of that score line in pixels. */
  imprintWidth?: number;
}

export interface Scene {
  image: RgbaImage;
  /** The number the counter is expected to return. */
  truth: number;
  pills: PillSpec[];
}

const DEFAULT_BG: Rgb = { r: 24, g: 28, b: 34 };
const DEFAULT_PILL: Rgb = { r: 238, g: 238, b: 232 };

/** Squared distance from a point to a line segment; the capsule primitive. */
function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Popcount over the 9-bit subsample coverage masks used by renderScene. */
const POPCOUNT_9 = (() => {
  const table = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    let n = 0;
    for (let b = 0; b < 9; b++) if (i & (1 << b)) n++;
    table[i] = n;
  }
  return table;
})();

/**
 * Render pills onto a tray.
 *
 * Coverage is supersampled 3x3 per pixel so pill edges are anti-aliased the
 * way a real lens and sensor would produce them. Hard-edged shapes would make
 * the thresholding look better than it is.
 *
 * Each pill only rasterises within its own bounding box, and coverage is kept
 * as a 9-bit subsample mask per pixel so overlapping pills compose correctly
 * without double counting. Testing every pill against every pixel instead
 * would make generating the benchmark scenes cost far more than running the
 * counter on them.
 */
export function renderScene(pills: PillSpec[], options: SceneOptions = {}): Scene {
  const width = options.width ?? 640;
  const height = options.height ?? 480;
  const bg = options.background ?? DEFAULT_BG;
  const lighting = options.lighting ?? 0;
  const noise = options.noise ?? 0;
  const rng = makeRng(0x9e3779b9);

  const SS = 3;
  const step = 1 / SS;
  const offset = step / 2;

  const covMask = new Uint16Array(width * height);
  const colR = new Uint8Array(width * height);
  const colG = new Uint8Array(width * height);
  const colB = new Uint8Array(width * height);

  for (const pill of pills) {
    const half = pill.length / 2;
    const ax = pill.x - Math.cos(pill.angle) * half;
    const ay = pill.y - Math.sin(pill.angle) * half;
    const bx = pill.x + Math.cos(pill.angle) * half;
    const by = pill.y + Math.sin(pill.angle) * half;

    const reach = pill.radius + half + 1;
    const x0 = Math.max(0, Math.floor(pill.x - reach));
    const x1 = Math.min(width - 1, Math.ceil(pill.x + reach));
    const y0 = Math.max(0, Math.floor(pill.y - reach));
    const y1 = Math.min(height - 1, Math.ceil(pill.y + reach));

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * width + x;
        const before = covMask[i];
        let mask = before;

        for (let sy = 0; sy < SS; sy++) {
          const py = y + offset + sy * step;
          for (let sx = 0; sx < SS; sx++) {
            const bit = 1 << (sy * SS + sx);
            if (mask & bit) continue;
            const px = x + offset + sx * step;
            if (distanceToSegment(px, py, ax, ay, bx, by) <= pill.radius) mask |= bit;
          }
        }

        if (mask !== before) {
          covMask[i] = mask;
          if (before === 0) {
            colR[i] = pill.colour.r;
            colG[i] = pill.colour.g;
            colB[i] = pill.colour.b;
          }
        }
      }
    }
  }

  const data = new Uint8Array(width * height * 4);
  const samples = SS * SS;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const alpha = POPCOUNT_9[covMask[i]] / samples;

      let r = bg.r * (1 - alpha) + colR[i] * alpha;
      let g = bg.g * (1 - alpha) + colG[i] * alpha;
      let b = bg.b * (1 - alpha) + colB[i] * alpha;

      if (lighting > 0) {
        // Diagonal falloff, as from a light source off one corner.
        const t = (x / width + y / height) / 2;
        const gain = 1 - lighting * t;
        r *= gain;
        g *= gain;
        b *= gain;
      }

      if (noise > 0) {
        // Box-Muller for genuinely Gaussian noise; uniform noise is far easier
        // for a median filter to remove than the real thing.
        const u1 = Math.max(1e-9, rng());
        const u2 = rng();
        const n = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * noise;
        r += n;
        g += n;
        b += n;
      }

      const p = i * 4;
      data[p] = clampByte(r);
      data[p + 1] = clampByte(g);
      data[p + 2] = clampByte(b);
      data[p + 3] = 255;
    }
  }

  let image: RgbaImage = { width, height, data };
  if (options.imprint) {
    image = addImprints(image, pills, options.imprint, options.imprintWidth ?? 2.5);
  }
  if (options.glare) image = addGlare(image);
  if (options.blur) image = blurRgba(image, options.blur);

  return { image, truth: pills.length, pills };
}

/**
 * Darken a score line across the middle of each pill, perpendicular to its
 * long axis - where a real tablet is scored so it can be snapped in half.
 */
function addImprints(
  img: RgbaImage,
  pills: PillSpec[],
  depth: number,
  lineWidth: number,
): RgbaImage {
  const { width, height, data } = img;
  const out = Uint8Array.from(data);

  for (const pill of pills) {
    // The score runs across the pill, so its direction is the pill's normal.
    const nx = -Math.sin(pill.angle);
    const ny = Math.cos(pill.angle);
    const halfLine = pill.radius * 0.85;
    const ax = pill.x - nx * halfLine;
    const ay = pill.y - ny * halfLine;
    const bx = pill.x + nx * halfLine;
    const by = pill.y + ny * halfLine;

    const reach = pill.radius + pill.length / 2 + 2;
    const x0 = Math.max(0, Math.floor(pill.x - reach));
    const x1 = Math.min(width - 1, Math.ceil(pill.x + reach));
    const y0 = Math.max(0, Math.floor(pill.y - reach));
    const y1 = Math.min(height - 1, Math.ceil(pill.y + reach));

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (distanceToSegment(x, y, ax, ay, bx, by) > lineWidth / 2) continue;
        const i = (y * width + x) * 4;
        for (let c = 0; c < 3; c++) out[i + c] = clampByte(out[i + c] * (1 - depth));
      }
    }
  }

  return { width, height, data: out };
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/**
 * A blown-out specular highlight, as a flash bouncing off a glossy tray.
 *
 * Modelled with a fully saturated core and a falloff skirt, which is how a
 * real specular reflection lands on a sensor: a hard clipped centre where all
 * detail is gone, ringed by a gradient. A pure gradient with no clipped core
 * would be a much gentler test than the real thing, since it is precisely the
 * clipped region that swallows a pill whole.
 */
function addGlare(img: RgbaImage): RgbaImage {
  const { width, height, data } = img;
  const out = Uint8Array.from(data);
  const cx = width * 0.3;
  const cy = height * 0.3;
  const radius = Math.min(width, height) * 0.22;
  const core = 0.5;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x - cx, y - cy) / radius;
      if (d > 1) continue;
      const strength = d < core ? 1 : Math.max(0, 1 - (d - core) / (1 - core));
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        out[i + c] = clampByte(out[i + c] + 300 * strength);
      }
    }
  }
  return { width, height, data: out };
}

/** Box blur over RGBA, standing in for a soft-focus photo. */
export function blurRgba(img: RgbaImage, radius: number): RgbaImage {
  const { width, height, data } = img;
  const out = new Uint8Array(data.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const i = (yy * width + xx) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n++;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}

export interface LayoutOptions extends SceneOptions {
  count: number;
  radius?: number;
  /** Capsule centre-line length. 0 for round tablets. */
  length?: number;
  /**
   * Minimum centre-to-centre distance as a multiple of the pill's full width.
   * 1.3 leaves clear gaps, 1.0 has pills just touching, 0.9 fuses them.
   */
  spacing?: number;
  /** Randomise each pill's orientation. */
  randomAngles?: boolean;
  colour?: Rgb;
  seed?: number;
}

/**
 * Place `count` pills by rejection sampling with a minimum separation, keeping
 * them clear of the frame edge so tests are not measuring edge handling unless
 * they mean to.
 */
export function layoutScene(options: LayoutOptions): Scene {
  const {
    count,
    radius = 16,
    length = 0,
    spacing = 1.35,
    randomAngles = false,
    colour = DEFAULT_PILL,
    seed = 1,
  } = options;

  const width = options.width ?? 640;
  const height = options.height ?? 480;
  const rng = makeRng(seed);

  // Reach: how far the pill extends from its centre in the worst direction.
  const reach = radius + length / 2;
  const minDistance = spacing * 2 * radius;
  const margin = reach + 6;

  const pills: PillSpec[] = [];
  const maxAttempts = count * 4000;

  for (let attempt = 0; attempt < maxAttempts && pills.length < count; attempt++) {
    const x = margin + rng() * (width - 2 * margin);
    const y = margin + rng() * (height - 2 * margin);
    const angle = randomAngles ? rng() * Math.PI * 2 : 0;

    // For capsules the required clearance depends on orientation; using the
    // full reach is conservative but keeps the generator simple and honest.
    const clearance = length > 0 ? minDistance + length / 2 : minDistance;

    let ok = true;
    for (const p of pills) {
      if (Math.hypot(p.x - x, p.y - y) < clearance) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    pills.push({ x, y, radius, length, angle, colour });
  }

  if (pills.length < count) {
    throw new Error(
      `layoutScene could not place ${count} pills (placed ${pills.length}). ` +
        `Increase the canvas or reduce spacing/radius.`,
    );
  }

  return renderScene(pills, options);
}

/**
 * A deliberately hard scene: pills placed in a tight chain so each one touches
 * the next, producing a single large connected blob that only the splitter can
 * resolve.
 */
export function chainScene(options: LayoutOptions): Scene {
  const {
    count,
    radius = 16,
    length = 0,
    spacing = 0.98,
    colour = DEFAULT_PILL,
    seed = 1,
  } = options;

  const width = options.width ?? 640;
  const height = options.height ?? 480;
  const rng = makeRng(seed);
  const step = spacing * 2 * radius;

  const pills: PillSpec[] = [];
  let x = radius + 20;
  let y = radius + 30;
  let direction = 1;

  for (let i = 0; i < count; i++) {
    if (x + radius + 10 > width) {
      x = radius + 20;
      y += step * 1.02;
      direction *= -1;
    }
    // A little jitter keeps the chain from being a perfectly regular lattice,
    // which would be unrealistically easy.
    pills.push({
      x: x + (rng() - 0.5) * radius * 0.15,
      y: y + (rng() - 0.5) * radius * 0.15,
      radius,
      length,
      angle: 0,
      colour,
    });
    x += step;
  }

  if (y + radius + 10 > height) {
    throw new Error(`chainScene needs a taller canvas for ${count} pills.`);
  }

  return renderScene(pills, options);
}

/**
 * Exact shortest distance between two pills' centre lines.
 *
 * A pill is a segment swept by a disc, so two pills clear each other exactly
 * when this distance is at least the sum of their radii. In 2D the minimum
 * between two segments is either zero (they cross) or attained at one of the
 * four endpoint-to-segment pairs, which makes this exact and cheap - no
 * sampling, so it can sit inside the placement loop.
 */
export function segmentDistance(a: PillSpec, b: PillSpec): number {
  const ends = (p: PillSpec) => {
    const half = p.length / 2;
    const dx = Math.cos(p.angle) * half;
    const dy = Math.sin(p.angle) * half;
    return { ax: p.x - dx, ay: p.y - dy, bx: p.x + dx, by: p.y + dy };
  };

  const s1 = ends(a);
  const s2 = ends(b);

  const d1x = s1.bx - s1.ax;
  const d1y = s1.by - s1.ay;
  const d2x = s2.bx - s2.ax;
  const d2y = s2.by - s2.ay;

  // Proper crossing means the segments touch, so the distance is zero.
  const denominator = d1x * d2y - d1y * d2x;
  if (Math.abs(denominator) > 1e-12) {
    const ex = s2.ax - s1.ax;
    const ey = s2.ay - s1.ay;
    const t = (ex * d2y - ey * d2x) / denominator;
    const u = (ex * d1y - ey * d1x) / denominator;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }

  return Math.min(
    pointToSegment(s1.ax, s1.ay, s2),
    pointToSegment(s1.bx, s1.by, s2),
    pointToSegment(s2.ax, s2.ay, s1),
    pointToSegment(s2.bx, s2.by, s1),
  );
}

function pointToSegment(
  px: number,
  py: number,
  s: { ax: number; ay: number; bx: number; by: number },
): number {
  return distanceToSegment(px, py, s.ax, s.ay, s.bx, s.by);
}

/**
 * How deeply the two most overlapping pills in a scene interpenetrate.
 * Zero or less means the tray is physically realisable.
 */
export function worstOverlap(pills: PillSpec[]): number {
  if (pills.length < 2) return 0;
  let worst = -Infinity;
  for (let i = 0; i < pills.length; i++) {
    for (let j = i + 1; j < pills.length; j++) {
      worst = Math.max(
        worst,
        pills[i].radius + pills[j].radius - segmentDistance(pills[i], pills[j]),
      );
    }
  }
  return worst;
}
