import { countPills } from '../count';
import type { CountResult, WarningCode } from '../types';
import { chainScene, layoutScene, renderScene, type Rgb } from './synth';

const WHITE_PILL: Rgb = { r: 238, g: 238, b: 232 };
const DARK_TRAY: Rgb = { r: 24, g: 28, b: 34 };
const WHITE_TRAY: Rgb = { r: 244, g: 244, b: 240 };
const RED_CAPSULE: Rgb = { r: 198, g: 44, b: 48 };
const BLUE_TABLET: Rgb = { r: 46, g: 78, b: 190 };

/** Tests drive the pipeline directly, so the blur/glare gate is opt-in. */
const analyse = (image: Parameters<typeof countPills>[0], options = {}): CountResult =>
  countPills(image, { skipQualityGate: true, ...options });

const codes = (result: CountResult): WarningCode[] => result.warnings.map((w) => w.code);

describe('separated tablets', () => {
  it.each([1, 2, 5, 12, 25, 45])('counts exactly %i pills', (n) => {
    const scene = layoutScene({ count: n, radius: 14, seed: n * 31 + 5 });
    const result = analyse(scene.image);

    expect(result.count).toBe(n);
    expect(result.markers).toHaveLength(n);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('places one marker inside each pill it counted', () => {
    const scene = layoutScene({ count: 14, radius: 15, seed: 77 });
    const result = analyse(scene.image);
    expect(result.count).toBe(14);

    // Every marker must land within its own pill, and every pill must claim
    // exactly one marker. A right total made of markers in the wrong places
    // would still be wrong on screen, where the user checks the work.
    const claimed = new Set<number>();
    for (const marker of result.markers) {
      const hit = scene.pills.findIndex(
        (p) => Math.hypot(p.x - marker.x, p.y - marker.y) <= p.radius,
      );
      expect(hit).toBeGreaterThanOrEqual(0);
      expect(claimed.has(hit)).toBe(false);
      claimed.add(hit);
    }
    expect(claimed.size).toBe(14);
  });

  it('returns zero for an empty tray and says why', () => {
    const scene = renderScene([]);
    const result = analyse(scene.image);

    expect(result.count).toBe(0);
    expect(result.confidence).toBe(0);
    expect(codes(result)).toContain('NO_PILLS_FOUND');
  });
});

describe('touching and clumped pills', () => {
  it.each([2, 4, 9, 18, 35, 60])('splits a touching chain of %i', (n) => {
    const scene = chainScene({ count: n, radius: 14, spacing: 0.97, seed: n * 13 });
    const result = analyse(scene.image);
    expect(result.count).toBe(n);
  });

  it('reports clumps as clusters rather than as single pills', () => {
    const scene = chainScene({ count: 12, radius: 14, spacing: 0.97, seed: 3 });
    const result = analyse(scene.image);

    expect(result.count).toBe(12);
    expect(result.components).toBeLessThan(12);
    expect(result.largestCluster).toBeGreaterThan(1);
    expect(codes(result)).toContain('HEAVY_CLUSTERING');
    // Every pill teased out of a clump is flagged for the user to eyeball.
    expect(result.markers.filter((m) => m.fromCluster).length).toBeGreaterThan(0);
  });

  it('is less confident about a solid clump than about spread-out pills', () => {
    const spread = analyse(layoutScene({ count: 20, radius: 14, seed: 21 }).image);
    const clumped = analyse(
      chainScene({ count: 20, radius: 14, spacing: 0.97, seed: 21 }).image,
    );

    expect(spread.count).toBe(20);
    expect(clumped.count).toBe(20);
    expect(clumped.confidence).toBeLessThan(spread.confidence);
  });
});

describe('pill shapes', () => {
  it('counts oblong capsules without splitting them lengthwise', () => {
    const scene = layoutScene({
      count: 9,
      radius: 10,
      length: 26,
      randomAngles: true,
      spacing: 1.5,
      seed: 42,
    });
    const result = analyse(scene.image);
    expect(result.count).toBe(9);
  });

  it('counts long capsules at every orientation', () => {
    for (const seed of [3, 8, 19]) {
      const scene = layoutScene({
        count: 6,
        radius: 8,
        length: 42,
        randomAngles: true,
        spacing: 1.8,
        seed,
      });
      expect(analyse(scene.image).count).toBe(6);
    }
  });

  it('counts capsules that touch each other', () => {
    const scene = layoutScene({
      count: 10,
      radius: 9,
      length: 24,
      randomAngles: true,
      spacing: 1.05,
      seed: 7,
    });
    expect(analyse(scene.image).count).toBe(10);
  });

  it('recovers capsules fused flush side by side using the area cross-check', () => {
    // Two pairs stuck together with no saddle between them for the watershed
    // to find, plus four singles that give the area check a pill to calibrate
    // against. Without the cross-check this reports 6.
    const pills = [
      { x: 120, y: 100 },
      { x: 120, y: 120 },
      { x: 400, y: 100 },
      { x: 400, y: 120 },
      { x: 120, y: 260 },
      { x: 300, y: 260 },
      { x: 480, y: 260 },
      { x: 300, y: 380 },
    ].map((p) => ({ ...p, radius: 10, length: 30, angle: 0, colour: WHITE_PILL }));

    const result = analyse(renderScene(pills).image);
    expect(result.count).toBe(8);
    // It got there by inference rather than by seeing them, and says so.
    expect(codes(result)).toContain('COUNT_AMBIGUOUS');
    expect(result.confidence).toBeLessThan(0.9);
  });
});

describe('colour and contrast', () => {
  it('counts white pills on a dark tray', () => {
    const scene = layoutScene({
      count: 15,
      radius: 13,
      colour: WHITE_PILL,
      background: DARK_TRAY,
      seed: 101,
    });
    expect(analyse(scene.image).count).toBe(15);
  });

  it('counts dark pills on a white tray', () => {
    const scene = layoutScene({
      count: 15,
      radius: 13,
      colour: { r: 38, g: 38, b: 42 },
      background: WHITE_TRAY,
      seed: 102,
    });
    expect(analyse(scene.image).count).toBe(15);
  });

  it('counts red capsules on a white tray, where luminance alone barely sees them', () => {
    const scene = layoutScene({
      count: 11,
      radius: 10,
      length: 22,
      randomAngles: true,
      spacing: 1.5,
      colour: RED_CAPSULE,
      background: WHITE_TRAY,
      seed: 103,
    });
    expect(analyse(scene.image).count).toBe(11);
  });

  it('counts blue tablets on a mid-grey tray of similar brightness', () => {
    const scene = layoutScene({
      count: 13,
      radius: 12,
      colour: BLUE_TABLET,
      background: { r: 120, g: 120, b: 120 },
      seed: 104,
    });
    expect(analyse(scene.image).count).toBe(13);
  });
});

describe('photographic degradation', () => {
  it('counts through a strong lighting gradient', () => {
    for (const lighting of [0.3, 0.5, 0.65]) {
      const scene = layoutScene({ count: 18, radius: 13, lighting, seed: 55 });
      const result = analyse(scene.image);
      expect(result.count).toBe(18);
    }
  });

  it('counts through sensor noise', () => {
    for (const noise of [4, 8, 14]) {
      const scene = layoutScene({ count: 16, radius: 14, noise, seed: 66 });
      expect(analyse(scene.image).count).toBe(16);
    }
  });

  it('counts through combined noise and uneven lighting', () => {
    const scene = layoutScene({
      count: 22,
      radius: 14,
      noise: 10,
      lighting: 0.5,
      seed: 88,
    });
    expect(analyse(scene.image).count).toBe(22);
  });

  it('warns about glare instead of silently miscounting', () => {
    const scene = layoutScene({ count: 14, radius: 14, glare: true, seed: 99 });
    const result = countPills(scene.image);
    expect(codes(result)).toContain('GLARE');
  });

  it('refuses to stand behind a blurred photo', () => {
    const scene = layoutScene({ count: 12, radius: 14, blur: 6, seed: 12 });
    const result = countPills(scene.image);

    const blocking = result.warnings.filter((w) => w.severity === 'block');
    expect(blocking.map((w) => w.code)).toContain('IMAGE_BLURRY');
    expect(result.confidence).toBeLessThan(0.75);
  });

  it('accepts a sharp photo without a blur warning', () => {
    const scene = layoutScene({ count: 12, radius: 14, seed: 12 });
    const result = countPills(scene.image);
    expect(codes(result)).not.toContain('IMAGE_BLURRY');
    expect(result.confidence).toBeGreaterThan(0.9);
  });
});

describe('framing', () => {
  it('flags pills cut off by the edge of the frame', () => {
    const pills = [
      { x: 4, y: 100 },
      { x: 150, y: 150 },
      { x: 250, y: 200 },
      { x: 350, y: 120 },
      { x: 450, y: 260 },
    ].map((p) => ({ ...p, radius: 14, length: 0, angle: 0, colour: WHITE_PILL }));

    const result = analyse(renderScene(pills).image);
    expect(codes(result)).toContain('PILLS_TOUCHING_EDGE');
    expect(result.confidence).toBeLessThan(1);
  });

  it('scales the answer with resolution, not the count', () => {
    // The same tray shot at three resolutions must give the same number.
    const counts = [640, 1000, 1500].map((width) => {
      const scene = layoutScene({
        count: 20,
        radius: Math.round(14 * (width / 640)),
        width,
        height: Math.round(width * 0.75),
        seed: 4,
      });
      return analyse(scene.image).count;
    });
    expect(counts).toEqual([20, 20, 20]);
  });
});

describe('result reporting', () => {
  it('calibrates a pill size close to the truth', () => {
    const radius = 15;
    const scene = layoutScene({ count: 18, radius, seed: 202 });
    const result = analyse(scene.image);

    const trueArea = Math.PI * radius * radius;
    expect(result.unitArea).toBeGreaterThan(trueArea * 0.85);
    expect(result.unitArea).toBeLessThan(trueArea * 1.15);
    expect(result.unitRadius).toBeGreaterThan(radius * 0.85);
    expect(result.unitRadius).toBeLessThan(radius * 1.2);
  });

  it('gives every marker a drawable radius and a home component', () => {
    const result = analyse(layoutScene({ count: 8, radius: 14, seed: 5 }).image);
    for (const marker of result.markers) {
      expect(marker.r).toBeGreaterThan(0);
      expect(marker.componentId).toBeGreaterThan(0);
      expect(marker.x).toBeGreaterThanOrEqual(0);
      expect(marker.x).toBeLessThanOrEqual(result.processedWidth);
      expect(marker.y).toBeGreaterThanOrEqual(0);
      expect(marker.y).toBeLessThanOrEqual(result.processedHeight);
    }
  });

  it('is deterministic: the same photo always gives the same count', () => {
    const scene = chainScene({ count: 24, radius: 14, spacing: 0.97, seed: 8 });
    const first = analyse(scene.image);
    const second = analyse(scene.image);

    expect(second.count).toBe(first.count);
    expect(second.confidence).toBeCloseTo(first.confidence, 10);
    expect(second.markers).toEqual(first.markers);
  });

  it('keeps confidence inside 0..1 across wildly different scenes', () => {
    const scenes = [
      layoutScene({ count: 3, radius: 14, seed: 1 }),
      chainScene({ count: 30, radius: 14, spacing: 0.97, seed: 2 }),
      layoutScene({ count: 10, radius: 14, blur: 5, noise: 12, seed: 3 }),
      renderScene([]),
    ];
    for (const scene of scenes) {
      const result = countPills(scene.image);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });
});

/**
 * Regression tests from the first real-world field test.
 *
 * Eight small orange pills on a black surface, photographed five times, came
 * back as 2, 3, 30, 2 and 3. Nothing in the synthetic suite predicted it,
 * because every scene it generated used a matte background filling the whole
 * frame - no glossy surface, no room light, no specular highlight. 7,818
 * simulated pills and not one reflection among them.
 *
 * Two independent defects were behind it, and each gets pinned down here.
 */
describe('dark and glossy surfaces', () => {
  const BLACK_SURFACE: Rgb = { r: 12, g: 12, b: 14 };
  const ORANGE_PILL: Rgb = { r: 232, g: 124, b: 42 };

  /** Eight pills to one side, so a reflection falls on bare surface. */
  function trayWithHighlight(options: {
    radius: number;
    noise?: number;
    lighting?: number;
    glare?: boolean;
  }) {
    const width = 1200;
    const height = 900;
    const pills = Array.from({ length: 8 }, (_, i) => ({
      x: width * (0.42 + 0.13 * (i % 4)),
      y: height * (0.55 + 0.2 * Math.floor(i / 4)),
      radius: options.radius,
      length: 0,
      angle: 0,
      colour: ORANGE_PILL,
    }));
    return renderScene(pills, {
      width,
      height,
      background: BLACK_SURFACE,
      noise: options.noise ?? 0,
      lighting: options.lighting ?? 0,
      glare: options.glare ?? false,
    });
  }

  it('counts small pills on a black surface', () => {
    for (const radius of [14, 9, 6]) {
      expect(analyse(trayWithHighlight({ radius }).image).count).toBe(8);
    }
  });

  it('is not fooled by a reflection off a glossy surface', () => {
    // The original bug. A specular highlight is one blob far larger than every
    // pill combined; when blobs voted for pill size in proportion to area it
    // won outright, and the app concluded one pill was 114px across instead of
    // 11. The noise floor derived from that put every real pill below it.
    const scene = trayWithHighlight({ radius: 14, glare: true });
    const result = analyse(scene.image);

    expect(result.count).toBe(8);
    // The measurement that went wrong, asserted directly.
    expect(result.unitRadius).toBeGreaterThan(8);
    expect(result.unitRadius).toBeLessThan(20);
  });

  it('counts through a reflection combined with noise and uneven light', () => {
    expect(analyse(trayWithHighlight({ radius: 14, glare: true, noise: 6 }).image).count).toBe(8);
    expect(
      analyse(trayWithHighlight({ radius: 14, glare: true, noise: 6, lighting: 0.5 }).image).count,
    ).toBe(8);
    expect(
      analyse(trayWithHighlight({ radius: 9, glare: true, noise: 6, lighting: 0.4 }).image).count,
    ).toBe(8);
  });

  it('does not mistake dark-pixel sensor noise for vivid pills', () => {
    // The second defect, and the source of the 30. Saturation is
    // (max - min) / max, so as a pixel darkens that ratio amplifies noise
    // without limit: a stray (5, 1, 2) on a black surface reads as saturation
    // 204, against a real orange pill's 209. The saturation channel became
    // static, the channel selector sometimes preferred it, and a tray of 8
    // came back as thousands of specks.
    for (const noise of [4, 8, 12]) {
      const result = analyse(trayWithHighlight({ radius: 6, noise }).image);
      expect(result.count).toBe(8);
    }
  });

  it('never returns a wildly inflated count on a dark noisy frame', () => {
    // Guards the specific shape of the failure: whatever else goes wrong on a
    // dark surface, the answer must stay in the right order of magnitude.
    for (const noise of [4, 8, 12, 16]) {
      for (const glare of [false, true]) {
        const result = analyse(trayWithHighlight({ radius: 6, noise, glare }).image);
        expect(result.count).toBeLessThan(30);
      }
    }
  });
});
