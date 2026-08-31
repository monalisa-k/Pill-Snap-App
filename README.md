# Pill Snap

Photograph pills on a tray, get the count. Everything runs on the device — no
network call, no account, no photo leaves the phone.

Built with Expo (SDK 56) and React Native. The counting engine is plain
TypeScript over typed arrays, so the exact code that runs on the phone also
runs under Jest.

```bash
npm install
npm start          # then scan the QR code with Expo Go
npm test           # 91 tests, including the accuracy benchmark
npm run typecheck
```

## About the 99.99% target

It is worth being straight about this up front: **no app counts pills from a
photo with 99.99% accuracy, and this one does not either.** PillEye does not
either — it gets close by controlling the conditions (its own mat, good
lighting, pills spread out) and by letting you fix the result.

What a photo can and cannot support:

- **Pills spread out with decent contrast** — essentially always exact. In the
  benchmark below this is 24/24 scenes and 658/658 individual pills.
- **Pills touching each other** — still exact in every benchmark scene, because
  the splitter is built for it.
- **Pills genuinely packed into a raft**, hundreds of them locked shoulder to
  shoulder — around 89% of individual pills. Some of these images simply do not
  contain the information needed to recover the count, and no algorithm gets
  them all.

So the design goal here is not a number that is always right. It is:

1. Be exact whenever the photo supports it.
2. **Know when it doesn't**, and say so instead of guessing confidently.
3. Make the fix take five seconds when it is needed.

Point 2 is the one that actually decides whether a counting app is usable. A
count that arrives flagged costs you a glance. A wrong count that arrives
looking certain gets written down. The benchmark asserts that every badly wrong
scene is flagged, and that any count the app *does* stand behind is within 5%.

Point 3 is why the result screen shows a dot on every pill it counted. Tap a
dot to remove it, tap a gap to add one, pinch to zoom in on a clump. The
detector gets you to roughly the right number; you close the last gap yourself,
and you can see exactly where to look.

## How the counting works

`src/vision/` — no React Native imports anywhere in it, which is what makes it
testable.

| Step | File | What it does |
| --- | --- | --- |
| Downscale | `image.ts` | Box-average to 900px. Averaging (not sampling) suppresses noise and imprint texture that would otherwise fragment a pill. |
| Pick a channel | `count.ts` | Runs Otsu on luma, saturation and each RGB channel, keeps whichever is most bimodal. White-on-dark separates on luma; a red capsule on a white tray is nearly invisible there but leaps out on saturation. Judged on a thumbnail, since it is a global colour-statistics question. |
| Flatten lighting | `filters.ts` | Divides by a heavily blurred copy of itself, removing the flash/lamp gradient that would otherwise make one global threshold impossible. The background model is estimated at 1/8 scale — it is by construction the lowest-frequency content in the frame. |
| Threshold | `threshold.ts` | Otsu, with polarity decided by which side puts less foreground on the frame border. |
| Clean up | `morphology.ts` | Opening only. See "what was deliberately left out". |
| Calibrate | `count.ts` | Pill size comes from the largest circle that fits inside each blob. This works whether a blob holds one pill or fifteen, because a clump of equal pills has no room for a circle bigger than one pill — which is why the app needs no reference card and no per-medication setup. |
| Split clumps | `watershed.ts` | Persistence-filtered watershed on the exact Euclidean distance transform. |
| Cross-check | `count.ts` | Compares against a second, area-based estimate; disagreement becomes lower confidence. |

### Why persistence, and not "peaks are pills"

On the distance map each pill is a hill whose summit equals its inscribed
radius, and two touching pills are two hills joined by a saddle. The obvious
rule — find local maxima, require them to be some minimum distance apart — gets
capsules badly wrong: a capsule's distance ridge runs its whole length at a
near-constant height, so it reports one capsule as three or four pills.

Instead, each time two basins meet, the *persistence* of the shallower one is
measured: how far its summit rises above the saddle where they met. One rule
then handles both shapes:

- **Two touching tablets** — the neck between them drops to near zero while both
  summits sit at the pill radius. Large persistence, they stay apart.
- **One capsule** — bumps along its flat ridge are separated by saddles a hair
  below them. Tiny persistence, they collapse into the one pill they are.

### What was deliberately left out

Three things that look like obvious improvements and measurably are not. Each
was implemented, measured, and removed:

- **Flood-filling enclosed holes** — the textbook fix for score-line artifacts.
  It also fills the gaps *between* packed pills, welding a tray into one slab.
  The inscribed-circle calibration then measures the slab instead of a pill and
  a 40-pill count collapses to 1.
- **Morphological closing** — meant to seal hairline cracks across a pill's
  face. It bought nothing (the persistence watershed already absorbs a split
  ridge as one summit) while welding capsules 2px apart into single bars,
  turning 154 pills into 11.
- **Letting the area cross-check override the splitter unconditionally** — when
  no isolated pill is in frame, that "cross-check" is computed from the very
  segmentation it is meant to check. It reliably turned correct counts into
  wrong ones. It now only overrides when an isolated pill was available to
  calibrate against independently.

The pattern in the first two: both tidy a pill's interior by *adding*
foreground, and adding foreground is how neighbouring pills get joined.

### Catching the failure that hides itself

One case defeats every estimator above: pills fused with no saddle at all, like
capsules lying flush side by side. The ridge is genuinely single, so every
distance-based signal agrees the bar is one pill — they are wrong *together*,
which means agreement between them proves nothing.

The check that catches it is dimensional rather than statistical. A pill is a
disc swept along a short line, so even a long capsule has an area at most about
5× the largest circle that fits inside it. A fused raft routinely hits 20×.
When a blob is too big for the pills attributed to it, the count is corrected
if anything else in frame gives a usable pill size, and the confidence is cut
hard either way. In the benchmark this turned the worst case from *0.92
confident and 17× wrong* into *0.17 confident and flagged*.

## Accuracy benchmark

`npm run bench` runs 72 randomised scenes across pill sizes, shapes, colours,
tray colours, lighting gradients and sensor noise:

```
  tier      scenes  exact        pills  per-pill accuracy
  spread       24  24/24   100.0%    658  100.0%
  close        24  24/24   100.0%    498  100.0%
  packed       24  16/24    66.7%   6662   89.3%

  overall      72  64/72    88.9%   7818   90.9%

  auto-accepted (conf>=0.9)  65 scenes, 96.9% exact
  flagged for review          7 scenes, 6 of them genuinely wrong
```

- **spread** — pills clearly apart, what the capture screen coaches you toward.
- **close** — pills touching, one to two pixels of clearance.
- **packed** — hundreds of pills in a lattice with sub-pixel gaps. Deliberately
  past what the app asks of you.

The generator asserts its own scenes are physically realisable (`worstOverlap`)
— an early version let rigid pills interpenetrate, which invented ground truth
no camera could recover and scored the counter as catastrophically wrong for
reading the image correctly.

## Test suite

91 tests in five files:

- `src/vision/__tests__/primitives.test.ts` — Otsu, morphology, the distance
  transform (asserted exactly Euclidean, not chamfer), connected components,
  k-means determinism, the illumination model.
- `src/vision/__tests__/counting.test.ts` — end-to-end scenarios: counts from 1
  to 45, touching chains, capsules at every orientation, dark-on-light and
  light-on-dark, coloured pills on similar-brightness trays, lighting
  gradients, noise, glare, blur rejection, edge framing, determinism.
- `src/vision/__tests__/benchmark.test.ts` — the tiered accuracy report above,
  with the guarantees asserted as tests.
- `src/lib/__tests__/pipeline.test.ts` — the real photo path, encoding to JPEG
  and back through the app's own base64 decoder, down to quality 40.
- `src/lib/__tests__/lib.test.ts` — the base64 decoder at every padding length,
  and the history screen's relative-date formatting across month boundaries.

Note that Jest's sandbox inflates runtime roughly 8×. Compiled and run
normally, a 1600×1200 photo of 120 pills counts in **~520ms cold, ~380ms warm**.

## Project layout

```
App.tsx                  screen state machine
src/vision/              the counting engine (no React Native imports)
src/lib/                 photo decoding, history storage, theme
src/ui/                  camera, result-and-correct, history screens
```

## Known limits

- Pills that **overlap or stack** cannot be counted from one photo. Nothing in
  a single 2D image recovers what is underneath.
- **Hundreds of pills locked in a raft** with no isolated pill anywhere in frame
  is sometimes genuinely ambiguous. The app flags these rather than guessing.
- Pills must **contrast with the surface**. White pills on a white tray warn
  rather than count.
- The blur gate is tuned on synthetic soft-focus and should be re-checked
  against real handheld photos before shipping.
