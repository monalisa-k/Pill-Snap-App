import { countPills } from '../count';
import {
  makeRng,
  renderScene,
  segmentDistance,
  worstOverlap,
  type PillSpec,
  type Rgb,
  type Scene,
} from './synth';

/**
 * Randomised accuracy benchmark.
 *
 * The scenario tests each pin down one behaviour. This one asks the question
 * the app is actually judged on: across a spread of pill sizes, shapes,
 * colours, densities and photo conditions, how often is the number exactly
 * right, and - just as important - when it is wrong, does the app know?
 *
 * The confidence-gated figures are the ones that matter for the product. A
 * wrong count the app flags for review costs the user ten seconds; a wrong
 * count it reports confidently is the failure that makes the whole thing
 * untrustworthy.
 */

const TRAYS: Rgb[] = [
  { r: 24, g: 28, b: 34 },
  { r: 244, g: 244, b: 240 },
  { r: 120, g: 122, b: 126 },
  { r: 40, g: 62, b: 52 },
];

const PILLS: Rgb[] = [
  { r: 238, g: 238, b: 232 },
  { r: 198, g: 44, b: 48 },
  { r: 46, g: 78, b: 190 },
  { r: 250, g: 214, b: 70 },
  { r: 40, g: 40, b: 44 },
];

/** Contrast between pill and tray, as the pipeline would have to find it. */
function contrast(a: Rgb, b: Rgb): number {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}

type Difficulty = 'spread' | 'close' | 'packed';

interface Trial {
  seed: number;
  scene: Scene;
  label: string;
  difficulty: Difficulty;
}

/**
 * Centre-to-centre spacing as a multiple of pill width, per tier.
 *
 * Below 1.0 the pills genuinely overlap in the mask and merge into one blob,
 * which is the regime where counting stops being image processing and starts
 * being inference. The tiers are kept separate in the report because averaging
 * them would hide exactly the thing worth knowing.
 */
const SPACING: Record<Difficulty, [number, number]> = {
  spread: [1.25, 1.9],
  close: [1.04, 1.25],
  packed: [1.02, 1.12],
};

/**
 * Build a random but legible scene. Pills are placed by rejection sampling at
 * the tier's density, so trials range from comfortably spread out to a solid
 * raft of touching pills.
 */
function makeTrial(seed: number, difficulty: Difficulty): Trial {
  const rng = makeRng(seed);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];

  const width = 520;
  const height = 400;
  const isCapsule = rng() < 0.35;
  const radius = isCapsule ? 7 + rng() * 5 : 9 + rng() * 8;
  const length = isCapsule ? radius * (1.6 + rng() * 1.6) : 0;

  const [lo, hi] = SPACING[difficulty];
  const spacing = lo + rng() * (hi - lo);

  const tray = pick(TRAYS);
  let pill = pick(PILLS);
  // Reject a pill/tray pairing no camera could separate either; that is a
  // photography problem, and the app's answer to it is a warning, not a count.
  let guard = 0;
  while (contrast(pill, tray) < 90 && guard++ < 10) pill = pick(PILLS);

  const reach = radius + length / 2;
  const margin = reach + 5;
  // Separation between centre lines, so it means the same thing for a round
  // tablet and for a capsule at any angle.
  const minDistance = spacing * 2 * radius;

  const pills: PillSpec[] = [];

  if (difficulty === 'packed') {
    // Fill the tray on a jittered lattice rather than by rejection sampling.
    // Sampling random points at a low density almost never actually produces a
    // clump - it just permits one - so a "packed" tier built that way flatters
    // the algorithm by testing the easy case under a hard-sounding name. A
    // lattice guarantees every pill touches its neighbours and the whole tray
    // becomes one or two large merged blobs, which is the real stress case.
    //
    // The lattice steps must keep the pills from actually overlapping. Rigid
    // tablets lying on a tray can touch, but they cannot occupy the same
    // space, so a generator that lets them interpenetrate produces ground
    // truth no camera could ever recover - 200 capsules stacked into what
    // looks like 12 solid bars - and would score the counter as catastrophically
    // wrong for reading the image correctly. Capsules therefore need clearance
    // along their length, not just across their width.
    const xStep = (length + 2 * radius) * spacing;
    const yStep = 2 * radius * spacing;
    // Jitter has to stay inside the slack the spacing bought, or it would
    // reintroduce the overlap the steps just ruled out.
    const jitter = radius * (spacing - 1) * 0.9;

    for (let y = margin; y <= height - margin; y += yStep) {
      for (let x = margin; x <= width - margin; x += xStep) {
        pills.push({
          x: x + (rng() - 0.5) * jitter,
          y: y + (rng() - 0.5) * jitter,
          radius,
          length,
          angle: 0,
          colour: pill,
        });
      }
    }
  } else {
    const target = 1 + Math.floor(rng() * 44);
    for (let attempt = 0; attempt < target * 3000 && pills.length < target; attempt++) {
      const candidate: PillSpec = {
        x: margin + rng() * (width - 2 * margin),
        y: margin + rng() * (height - 2 * margin),
        radius,
        length,
        angle: rng() * Math.PI * 2,
        colour: pill,
      };
      // Centre distance is the wrong test for a capsule: two of them laid end
      // to end need clearance along their whole length, not just across their
      // width. Measuring between centre lines gets every orientation right.
      const clear = pills.every(
        (p) => segmentDistance(p, candidate) >= minDistance,
      );
      if (clear) pills.push(candidate);
    }
  }

  const scene = renderScene(pills, {
    width,
    height,
    background: tray,
    lighting: rng() * 0.5,
    noise: rng() * 9,
  });

  return {
    seed,
    difficulty,
    scene,
    label:
      `${isCapsule ? 'capsule' : 'tablet'} n=${pills.length} r=${radius.toFixed(1)} ` +
      `spacing=${spacing.toFixed(2)}`,
  };
}

describe('accuracy benchmark', () => {
  const PER_TIER = 24;
  /** The app auto-accepts at or above this; below it, it asks for a look. */
  const AUTO_ACCEPT = 0.9;

  interface Outcome {
    label: string;
    seed: number;
    difficulty: Difficulty;
    truth: number;
    got: number;
    confidence: number;
    accepted: boolean;
  }

  let outcomes: Outcome[] = [];

  beforeAll(() => {
    outcomes = [];
    const tiers: Difficulty[] = ['spread', 'close', 'packed'];
    for (const difficulty of tiers) {
      for (let i = 0; i < PER_TIER; i++) {
        const trial = makeTrial(1000 + i * 17 + tiers.indexOf(difficulty) * 911, difficulty);
        const result = countPills(trial.scene.image, { skipQualityGate: true });
        outcomes.push({
          label: trial.label,
          seed: trial.seed,
          difficulty,
          truth: trial.scene.truth,
          got: result.count,
          confidence: result.confidence,
          accepted: result.confidence >= AUTO_ACCEPT,
        });
      }
    }
  }, 900000);

  const pct = (n: number, d: number) => (d === 0 ? '-' : `${((100 * n) / d).toFixed(1)}%`);

  const summarise = (rows: Outcome[]) => {
    const exact = rows.filter((o) => o.got === o.truth).length;
    const pills = rows.reduce((s, o) => s + o.truth, 0);
    const error = rows.reduce((s, o) => s + Math.abs(o.got - o.truth), 0);
    return { exact, pills, error, scenes: rows.length };
  };

  it('only ever scores itself against physically realisable trays', () => {
    // A generator bug here is worse than a counting bug: it invents ground
    // truth the image does not contain, and then blames the counter for not
    // seeing pills that are buried underneath other pills. Checking the
    // premise keeps the rest of the benchmark meaningful.
    const tiers: Difficulty[] = ['spread', 'close', 'packed'];
    for (const difficulty of tiers) {
      for (let i = 0; i < 6; i++) {
        const trial = makeTrial(1000 + i * 17 + tiers.indexOf(difficulty) * 911, difficulty);
        // Sub-pixel contact is contact, not overlap; allow half a pixel.
        expect(worstOverlap(trial.scene.pills)).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it('reports the accuracy it actually achieves', () => {
    const lines: string[] = ['', '  Pill Snap accuracy benchmark', ''];
    lines.push('  tier      scenes  exact        pills  per-pill accuracy');

    for (const tier of ['spread', 'close', 'packed'] as Difficulty[]) {
      const rows = outcomes.filter((o) => o.difficulty === tier);
      const s = summarise(rows);
      lines.push(
        `  ${tier.padEnd(9)} ${String(s.scenes).padStart(5)}  ` +
          `${`${s.exact}/${s.scenes}`.padEnd(7)} ${pct(s.exact, s.scenes).padStart(6)}  ` +
          `${String(s.pills).padStart(5)}  ${pct(s.pills - s.error, s.pills).padStart(6)}`,
      );
    }

    const all = summarise(outcomes);
    lines.push(
      '',
      `  overall   ${String(all.scenes).padStart(5)}  ` +
        `${`${all.exact}/${all.scenes}`.padEnd(7)} ${pct(all.exact, all.scenes).padStart(6)}  ` +
        `${String(all.pills).padStart(5)}  ${pct(all.pills - all.error, all.pills).padStart(6)}`,
    );

    const accepted = outcomes.filter((o) => o.accepted);
    const acceptedExact = accepted.filter((o) => o.got === o.truth);
    const flagged = outcomes.filter((o) => !o.accepted);
    const flaggedWrong = flagged.filter((o) => o.got !== o.truth);

    lines.push(
      '',
      `  auto-accepted (conf>=${AUTO_ACCEPT})  ${accepted.length} scenes, ${pct(acceptedExact.length, accepted.length)} exact`,
      `  flagged for review         ${flagged.length} scenes, ${flaggedWrong.length} of them genuinely wrong`,
      '',
    );

    const misses = outcomes.filter((o) => o.got !== o.truth);
    if (misses.length > 0) {
      lines.push('  misses:');
      for (const o of misses) {
        lines.push(
          `    [${o.difficulty}] seed=${o.seed} ${o.label} truth=${o.truth} got=${o.got} ` +
            `conf=${o.confidence.toFixed(2)}${o.accepted ? '  <-- ACCEPTED WHILE WRONG' : ''}`,
        );
      }
    }

    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
    expect(outcomes).toHaveLength(PER_TIER * 3);
  });

  it('is essentially exact when pills are spread out, as the app asks users to do', () => {
    const rows = outcomes.filter((o) => o.difficulty === 'spread');
    const s = summarise(rows);
    expect(s.exact / s.scenes).toBeGreaterThanOrEqual(0.95);
    expect((s.pills - s.error) / s.pills).toBeGreaterThanOrEqual(0.99);
  });

  it('holds up when pills are merely touching', () => {
    const rows = outcomes.filter((o) => o.difficulty === 'close');
    const s = summarise(rows);
    expect(s.exact / s.scenes).toBeGreaterThanOrEqual(0.95);
    expect((s.pills - s.error) / s.pills).toBeGreaterThanOrEqual(0.98);
  });

  it('degrades rather than collapsing on a packed raft of pills', () => {
    // This tier is deliberately past what the app asks of a user: hundreds of
    // pills locked into a lattice with sub-pixel gaps, where whole rows fuse
    // into single blobs. Some of these images genuinely do not contain the
    // information needed to recover the count. The bar is that the pipeline
    // stays in the right neighbourhood, not that it is exact.
    const rows = outcomes.filter((o) => o.difficulty === 'packed');
    const s = summarise(rows);
    expect((s.pills - s.error) / s.pills).toBeGreaterThanOrEqual(0.85);
  });

  it('gets the overwhelming majority of individual pills right overall', () => {
    const s = summarise(outcomes);
    expect((s.pills - s.error) / s.pills).toBeGreaterThanOrEqual(0.88);
  });

  it('is almost always exact on the counts it puts its name to', () => {
    const accepted = outcomes.filter((o) => o.accepted);
    const exact = accepted.filter((o) => o.got === o.truth);
    expect(exact.length / Math.max(1, accepted.length)).toBeGreaterThanOrEqual(0.95);
  });

  it('is never wildly wrong without saying so', () => {
    // The guarantee that actually matters. Being unable to count a photo is
    // recoverable - the app says so and the user spreads the pills out. Being
    // badly wrong while sounding certain is not, because nothing downstream
    // ever questions it. Every gross miss must arrive flagged.
    for (const o of outcomes) {
      if (!o.accepted) continue;
      const off = Math.abs(o.got - o.truth);
      expect(off).toBeLessThanOrEqual(Math.max(2, o.truth * 0.05));
    }
  });

  it('flags every scene it gets badly wrong', () => {
    const badlyWrong = outcomes.filter(
      (o) => Math.abs(o.got - o.truth) > Math.max(3, o.truth * 0.2),
    );
    for (const o of badlyWrong) {
      expect(o.confidence).toBeLessThan(AUTO_ACCEPT);
    }
  });
});
