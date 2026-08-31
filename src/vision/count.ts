import { connectedComponents, type Component } from './connected';
import { distanceTransform } from './distanceTransform';
import { flattenIllumination, medianFilter3 } from './filters';
import {
  borderForegroundRatio,
  downscaleRgba,
  invertMask,
  maskArea,
  toChannel,
  toLuma,
  toSaturation,
} from './image';
import { kmeans, type Point } from './kmeans';
import { open } from './morphology';
import {
  assessQuality,
  FOCUS_BLURRY_BELOW,
  GLARE_WARN_ABOVE,
  type QualityReport,
} from './quality';
import { clamp, median, medianAbsoluteDeviation, weightedMedian } from './stats';
import { otsu, threshold } from './threshold';
import {
  DEFAULT_OPTIONS,
  type BinaryMask,
  type ComponentReport,
  type CountOptions,
  type CountResult,
  type CountWarning,
  type GrayImage,
  type PillMarker,
  type RgbaImage,
} from './types';
import { watershedSplit, type Basin } from './watershed';

/** Otsu separability below this means pills and tray are barely distinguishable. */
const SEPARABILITY_FLOOR = 0.45;

/**
 * A blob must exceed the seed count's area by this much before we accept that
 * it is hiding an extra pill the watershed could not see.
 */
const AREA_OVERRIDE_MARGIN = 0.62;

/**
 * The largest blob-area-to-inscribed-circle ratio a single pill can have.
 *
 * A pill is a disc swept along a short line, so its area is at most
 * pi*r^2 + 2r*(L - 2r). Even a long capsule runs about 4:1 length to width,
 * which puts the ratio near 4.8; a round tablet sits at 1. Six leaves room for
 * threshold bloat and anti-aliasing and is still far below what a raft of
 * fused pills produces, which is routinely 20 or more.
 *
 * This is the one check that does not depend on the segmentation agreeing with
 * itself. When capsules lie flush in a row they merge into a bar with a single
 * flat distance ridge, and every estimator built on that ridge cheerfully
 * agrees the bar is one pill. Its sheer size relative to the widest circle
 * that fits inside it is what gives the lie away.
 */
const MAX_PILL_SHAPE_RATIO = 6;

/**
 * How many times the typical blob's area a single blob may count for when the
 * pill scale is being estimated.
 */
const CALIBRATION_WEIGHT_CAP = 4;

/**
 * How much larger than the calibrated pill a blob's inscribed circle may be
 * before the blob is treated as something other than pills.
 */
const MAX_INSCRIBED_RATIO = 3.5;

interface ChannelCandidate {
  name: string;
  gray: GrayImage;
  separability: number;
  threshold: number;
}

type ChannelName = 'luma' | 'saturation' | 'red' | 'green' | 'blue';

/** Extract and clean one channel, ready for thresholding. */
function prepareChannel(img: RgbaImage, name: ChannelName): GrayImage {
  switch (name) {
    case 'luma':
      return flattenIllumination(medianFilter3(toLuma(img)));
    case 'saturation':
      // Saturation is deliberately not illumination-flattened: it is already a
      // ratio of channels, so it is largely invariant to how brightly a spot
      // is lit, and flattening it would only inject noise.
      return medianFilter3(toSaturation(img));
    case 'red':
      return flattenIllumination(medianFilter3(toChannel(img, 0)));
    case 'green':
      return flattenIllumination(medianFilter3(toChannel(img, 1)));
    case 'blue':
      return flattenIllumination(medianFilter3(toChannel(img, 2)));
  }
}

const CHANNELS: ChannelName[] = ['luma', 'saturation', 'red', 'green', 'blue'];

/**
 * Grey levels of class separation a channel needs before it is trusted fully.
 *
 * Below this its score is scaled down in proportion. Ranking channels on
 * separability alone is a trap, because separability is scale-invariant: a
 * channel that splits pills from tray by six grey levels with no overlap
 * scores higher than one that splits them by two hundred with a little noise.
 * The first is an illusion - six levels does not survive sensor noise or JPEG
 * quantisation - and picking it produced counts of 0 and 59 on a tray of 16.
 */
const REFERENCE_CONTRAST = 40;

function channelContrastWeight(classSeparation: number): number {
  return Math.min(1, classSeparation / REFERENCE_CONTRAST);
}

/**
 * Pick the colour channel that most cleanly separates pills from tray.
 *
 * There is no single right channel. White tablets on a dark tray separate on
 * luminance; a red capsule on a white tray is nearly invisible on luminance
 * but leaps out on saturation; a blue tablet on a grey tray separates best on
 * the blue channel alone. Rather than guess, run Otsu on every candidate and
 * keep whichever produces the most strongly bimodal histogram, which is
 * exactly what Otsu's between-class variance already measures.
 *
 * The comparison runs on a thumbnail. Which channel best separates two
 * populations of pixels is a global property of the image's colour statistics,
 * and those survive downscaling intact, so there is no reason to pay for five
 * full-resolution passes to answer a question a 200px copy answers just as
 * well. Only the winner is then rebuilt at working resolution, where the
 * threshold is recomputed on the real pixels.
 */
function selectChannel(img: RgbaImage): ChannelCandidate {
  const thumb = downscaleRgba(img, 200);

  let bestName: ChannelName = 'luma';
  let bestScore = -1;
  for (const name of CHANNELS) {
    const { separability, classSeparation } = otsu(prepareChannel(thumb, name));
    const score = separability * channelContrastWeight(classSeparation);
    if (score > bestScore) {
      bestScore = score;
      bestName = name;
    }
  }

  const gray = prepareChannel(img, bestName);
  const full = otsu(gray);
  return {
    name: bestName,
    gray,
    separability: full.separability,
    threshold: full.threshold,
  };
}

/**
 * Decide which side of the threshold is pill and which is tray, then clean up.
 *
 * The polarity test leans on framing rather than brightness: whichever way
 * round it is, the border of a well-framed tray photo is mostly tray. If both
 * polarities put a lot of foreground on the border we fall back to assuming
 * pills occupy the minority of the frame, which is true of every sane photo of
 * pills on a tray.
 */
function buildMask(
  candidate: ChannelCandidate,
  polarity: Required<CountOptions>['polarity'],
): BinaryMask {
  const lightPills = threshold(candidate.gray, candidate.threshold, true);
  const darkPills = threshold(candidate.gray, candidate.threshold, false);

  let chosen: BinaryMask;
  if (polarity === 'lightPills') {
    chosen = lightPills;
  } else if (polarity === 'darkPills') {
    chosen = darkPills;
  } else {
    const lightBorder = borderForegroundRatio(lightPills);
    const darkBorder = borderForegroundRatio(darkPills);

    if (Math.abs(lightBorder - darkBorder) > 0.15) {
      chosen = lightBorder < darkBorder ? lightPills : darkPills;
    } else {
      const total = candidate.gray.data.length;
      chosen = maskArea(lightPills) / total < 0.5 ? lightPills : darkPills;
    }
  }

  // Opening removes dust and sensor speckle. That is all the cleanup the mask
  // gets, and the two operations left out are the interesting part.
  //
  // No closing. The textbook next step is to close hairline cracks that a
  // pill's score line opens across its face, and it measures out as pure
  // harm: closing bought nothing on scored tablets, because the persistence
  // watershed already absorbs a split ridge as one summit, while it welded
  // capsules lying 2px apart into single bars and turned 154 pills into 11.
  //
  // No flood-filling of enclosed holes either, for the same shape of reason:
  // the gaps between densely packed pills are also enclosed background, so
  // filling holes fuses a tray of touching pills into one solid slab. The
  // inscribed-circle calibration then measures the slab instead of a pill and
  // the count collapses toward 1.
  //
  // Both operations exist to tidy up a pill's interior, and both do it by
  // adding foreground - which is exactly how neighbouring pills get joined.
  // Leaving the mask alone and letting the watershed sort out the interior is
  // strictly better on every scene tested.
  return open(chosen, 1);
}

/** Largest inscribed radius within a component, from the distance map. */
function maxDistanceIn(component: Component, dist: Float64Array): number {
  let max = 0;
  for (let i = 0; i < component.pixels.length; i++) {
    const d = dist[component.pixels[i]];
    if (d > max) max = d;
  }
  return max;
}

/**
 * Calibrate the size of a single pill from the image itself.
 *
 * This is why the app needs no reference card and no per-medication setup: the
 * largest circle that fits inside a blob is the pill's own radius whether that
 * blob holds one pill or fifteen, because a clump of equal-sized pills has no
 * room in it for a circle bigger than one pill. Taking the median of that
 * measurement across every blob therefore survives even a photo where nothing
 * is isolated.
 *
 * Blobs vote in proportion to their area, so that dust specks cannot drag the
 * estimate down - but each blob's vote is capped. Uncapped area weighting has
 * a failure mode that field testing found immediately: a specular reflection
 * off a glossy surface is a single blob far larger than every pill combined,
 * so it wins the weighting outright and the app concludes one pill is 114px
 * across when the real answer is 11. Everything downstream then follows
 * correctly from a wrong premise - the noise floor is computed from that bogus
 * pill area, every real pill falls beneath it, and a tray of 8 comes back as
 * 2. Capping the vote keeps the protection against specks while denying any
 * single region the power to decide the scale by itself.
 */
function calibrateRadius(components: Component[], dist: Float64Array): number {
  if (components.length === 0) return 0;

  const radii = components.map((c) => maxDistanceIn(c, dist));
  const areas = components.map((c) => c.area);
  const cap = Math.max(1, median(areas) * CALIBRATION_WEIGHT_CAP);
  const weights = areas.map((a) => Math.min(a, cap));

  return weightedMedian(radii, weights);
}

/**
 * Reject regions too solid to be pills.
 *
 * A clump of pills, however large, cannot contain a circle much bigger than
 * one pill - the gaps between neighbours cut it short. That is the same
 * property the calibration relies on, used in reverse: a blob whose inscribed
 * circle dwarfs the calibrated pill is not pills at all. It is a reflection, a
 * shadow, or a stretch of tray that thresholded the wrong way.
 *
 * The multiple is deliberately loose. Two capsules lying flush measure about
 * 2x, and a genuine overlapping pile can reach 3x, while the reflections this
 * exists to catch measure 10x. Being generous costs nothing and avoids
 * throwing away real pills.
 */
function isPillLike(component: Component, dist: Float64Array, unitRadius: number): boolean {
  if (unitRadius <= 0) return true;
  return maxDistanceIn(component, dist) <= unitRadius * MAX_INSCRIBED_RATIO;
}

function componentPoints(component: Component, width: number): Point[] {
  const points: Point[] = new Array(component.pixels.length);
  for (let i = 0; i < component.pixels.length; i++) {
    const idx = component.pixels[i];
    points[i] = { x: idx % width, y: (idx / width) | 0 };
  }
  return points;
}

function buildWarnings(
  quality: QualityReport,
  separability: number,
  markers: PillMarker[],
  perComponent: ComponentReport[],
  areaSpread: number,
  edgePills: number,
  singletonCount: number,
  skipQualityGate: boolean,
  ignoredRegions: number,
): CountWarning[] {
  const warnings: CountWarning[] = [];

  if (markers.length === 0) {
    warnings.push({
      code: 'NO_PILLS_FOUND',
      message: 'No pills detected. Spread them on a plain surface that contrasts with the pills.',
      severity: 'block',
    });
  }

  if (!skipQualityGate && quality.focus < FOCUS_BLURRY_BELOW) {
    warnings.push({
      code: 'IMAGE_BLURRY',
      message: 'The photo looks out of focus. Hold steady, tap to focus, and shoot again.',
      severity: 'block',
    });
  }

  if (!skipQualityGate && quality.glare > GLARE_WARN_ABOVE) {
    warnings.push({
      code: 'GLARE',
      message: 'Bright glare is washing out part of the frame. Turn off the flash or move the light to one side.',
      severity: 'warn',
    });
  }

  if (separability < SEPARABILITY_FLOOR && markers.length > 0) {
    warnings.push({
      code: 'LOW_CONTRAST',
      message: 'The pills barely stand out from the background. Try a surface of a different colour.',
      severity: 'warn',
    });
  }

  const clustered = perComponent.filter((c) => c.count > 1);
  const inClusters = clustered.reduce((sum, c) => sum + c.count, 0);
  if (markers.length > 0 && inClusters / markers.length > 0.5) {
    warnings.push({
      code: 'HEAVY_CLUSTERING',
      message: 'Most pills are touching each other. Spread them apart for a more reliable count.',
      severity: 'warn',
    });
  }

  if (areaSpread > 0.35 && markers.length > 3) {
    warnings.push({
      code: 'INCONSISTENT_SIZES',
      message: 'The detected pills vary a lot in size. Check for debris or two different medications in frame.',
      severity: 'warn',
    });
  }

  if (edgePills > 0) {
    warnings.push({
      code: 'PILLS_TOUCHING_EDGE',
      message: `${edgePills} pill${edgePills === 1 ? ' is' : 's are'} cut off at the edge of the frame. Move the camera back.`,
      severity: 'warn',
    });
  }

  if (markers.length > 6 && singletonCount < 2) {
    warnings.push({
      code: 'SPARSE_CALIBRATION',
      message: 'No isolated pill was available to size the others against. Separate at least one pill.',
      severity: 'warn',
    });
  }

  if (ignoredRegions > 0) {
    warnings.push({
      code: 'BRIGHT_REGION_IGNORED',
      message:
        `${ignoredRegions} area${ignoredRegions === 1 ? '' : 's'} too solid to be pills ${ignoredRegions === 1 ? 'was' : 'were'} skipped, usually a reflection. Check nothing real was missed.`,
      severity: 'warn',
    });
  }

  const fusedPills = perComponent.filter((c) => c.fused).reduce((sum, c) => sum + c.count, 0);
  if (fusedPills > 0) {
    warnings.push({
      code: 'PILLS_FUSED',
      message:
        'Some pills are packed too tightly to tell apart and the count below is a guess. Spread them out and shoot again.',
      severity: 'block',
    });
  }

  const disagreement = perComponent.reduce(
    (sum, c) => sum + Math.abs(c.seedEstimate - c.areaEstimate),
    0,
  );
  if (markers.length > 0 && disagreement / markers.length > 0.15) {
    warnings.push({
      code: 'COUNT_AMBIGUOUS',
      message: 'Some clumps were hard to separate. Please check the highlighted pills.',
      severity: 'warn',
    });
  }

  return warnings;
}

/**
 * Count the pills in an RGBA image.
 *
 * The pipeline, end to end:
 *   downscale -> pick the most separable colour channel -> flatten the
 *   lighting -> Otsu threshold -> morphological cleanup and hole filling ->
 *   connected components -> calibrate pill radius from inscribed circles ->
 *   persistence watershed to split touching pills -> area cross-check ->
 *   confidence scoring.
 */
export function countPills(input: RgbaImage, options: CountOptions = {}): CountResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const started = Date.now();

  const img = downscaleRgba(input, opts.maxDimension);
  const { width, height } = img;

  const quality = assessQuality(toLuma(img));
  const candidate = selectChannel(img);
  const mask = buildMask(candidate, opts.polarity);

  const dist = distanceTransform(mask);
  const firstPass = connectedComponents(mask);

  // Calibrate on everything, then drop anything too small to be a pill and
  // recalibrate on what is left. The first estimate only has to be good enough
  // to set a sane noise floor; the second is the one the count relies on.
  const roughRadius = calibrateRadius(firstPass.components, dist);
  const noiseFloor = opts.minAreaRatio * Math.PI * roughRadius * roughRadius;
  let components = firstPass.components.filter((c) => c.area >= noiseFloor);

  if (components.length === 0) {
    return emptyResult(width, height, started, quality, candidate.separability, opts);
  }

  // Drop regions too solid to be pills - a reflection off a glossy surface, or
  // a stretch of tray that thresholded the wrong way - then recalibrate on
  // what is left, since the first estimate was taken in their company.
  const calibratedRadius = calibrateRadius(components, dist);
  const pillLike = components.filter((c) => isPillLike(c, dist, calibratedRadius));
  const ignoredRegions = components.length - pillLike.length;
  if (pillLike.length > 0) components = pillLike;

  const unitRadius = calibrateRadius(components, dist);
  const persistence = Math.max(0.75, unitRadius * opts.persistenceFactor);

  // First split pass, purely to learn what one pill's area looks like.
  const provisional = components.map((c) =>
    watershedSplit(c, dist, firstPass.labels, width, height, persistence, 0),
  );

  // Prefer to size a pill against blobs that hold exactly one, fully inside
  // the frame. Those are the only measurements that are genuinely independent
  // of the splitter, which is what makes the area cross-check below worth
  // anything: an estimate derived from the splitter's own output can never
  // catch the splitter being wrong.
  //
  // Fused pills do sneak into this set - a pair of capsules stuck flush looks
  // like one blob with one summit - but they land at double area, in the tail,
  // where a median ignores them.
  const isolatedAreas = components
    .filter((c, i) => provisional[i].length === 1 && c.touchesEdge === 0)
    .map((c) => c.area);

  const areaIsIndependent = isolatedAreas.length >= 2;

  // Blobs whose size the split can actually account for. Anything above the
  // shape ceiling is a fused raft, and letting it into the calibration would
  // teach the pipeline that one pill is the size of seventeen.
  const inscribedArea = Math.PI * unitRadius * unitRadius;
  const plausible = components.filter(
    (c, i) => c.area <= provisional[i].length * inscribedArea * MAX_PILL_SHAPE_RATIO,
  );
  const plausibleBasinAreas = components
    .flatMap((c, i) => (plausible.includes(c) ? provisional[i] : []))
    .map((b) => b.area);

  const allBasinAreas =
    plausibleBasinAreas.length > 0
      ? plausibleBasinAreas
      : provisional.flat().map((b) => b.area);

  // Falling back to basin areas is a real step down. Inside one big clump the
  // basins along the rim are clipped short by the blob's outline, which drags
  // their median a few percent under a true pill - enough to turn 20 pills
  // into 21 once it is divided into the clump's total area.
  const unitArea = areaIsIndependent
    ? median(isolatedAreas)
    : allBasinAreas.length > 0
      ? median(allBasinAreas)
      : Math.PI * unitRadius * unitRadius;

  const minBasinArea = opts.minAreaRatio * unitArea;

  const markers: PillMarker[] = [];
  const perComponent: ComponentReport[] = [];
  let singletonCount = 0;
  let edgePills = 0;
  let clusters = 0;
  let largestCluster = 0;

  for (let i = 0; i < components.length; i++) {
    const component = components[i];
    let basins: Basin[] = provisional[i].filter((b) => b.area >= minBasinArea);
    if (basins.length === 0) basins = provisional[i].slice(0, 1);

    const seedEstimate = basins.length;
    const areaEstimate = Math.max(1, Math.round(component.area / unitArea));

    // Trust the watershed unless the blob carries clearly more pill-area than
    // the seeds account for, which is the signature of pills fused with no
    // saddle between them (capsules lying flush side by side).
    //
    // Only when the unit area was measured independently, though. Without an
    // isolated pill to calibrate against, this "cross-check" is computed from
    // the very segmentation it is supposed to be checking, so letting it
    // override would be the blind leading the blind - and in practice it
    // reliably overrode a correct count into a wrong one. The disagreement is
    // still recorded, so it reaches the user as lower confidence instead.
    let count = seedEstimate;
    if (areaIsIndependent && areaEstimate > seedEstimate) {
      const excess = component.area / unitArea - seedEstimate;
      if (excess > AREA_OVERRIDE_MARGIN) count = areaEstimate;
    }

    // The blob is physically too large to be the number of pills claimed, no
    // matter how confidently the ridge says otherwise. If anything else in the
    // frame gave a usable pill size, divide by it; if nothing did, the honest
    // answer is that this photo cannot be counted, and the warning and
    // confidence penalty below say so rather than inventing a number.
    const fused = component.area > count * inscribedArea * MAX_PILL_SHAPE_RATIO;
    if (fused && plausibleBasinAreas.length > 0) {
      count = Math.max(count, Math.round(component.area / unitArea));
    }

    const positions: Point[] =
      count === seedEstimate
        ? basins.map((b) => ({ x: b.cx, y: b.cy }))
        : kmeans(componentPoints(component, width), count);

    const fromCluster = count > 1;
    const radius = Math.sqrt(unitArea / Math.PI);
    for (const p of positions) {
      markers.push({ x: p.x, y: p.y, r: radius, componentId: component.id, fromCluster });
    }

    if (count === 1) singletonCount++;
    if (count > 1) {
      clusters++;
      if (count > largestCluster) largestCluster = count;
    }
    if (component.touchesEdge > 0) edgePills += count;

    perComponent.push({
      id: component.id,
      area: component.area,
      count,
      areaEstimate,
      seedEstimate,
      touchesEdge: component.touchesEdge > 0,
      shapeRatio: component.area / (count * inscribedArea),
      fused,
    });
  }

  const basinAreas = provisional.flat().map((b) => b.area);
  const areaSpread =
    unitArea > 0 ? medianAbsoluteDeviation(basinAreas) / unitArea : 0;

  const warnings = buildWarnings(
    quality,
    candidate.separability,
    markers,
    perComponent,
    areaSpread,
    edgePills,
    singletonCount,
    opts.skipQualityGate,
    ignoredRegions,
  );

  const confidence = scoreConfidence({
    markers,
    perComponent,
    areaSpread,
    separability: candidate.separability,
    quality,
    edgePills,
    skipQualityGate: opts.skipQualityGate,
  });

  return {
    count: markers.length,
    markers,
    confidence,
    unitArea,
    unitRadius,
    components: components.length,
    clusters,
    largestCluster,
    warnings,
    processedWidth: width,
    processedHeight: height,
    elapsedMs: Date.now() - started,
    perComponent,
  };
}

interface ConfidenceInput {
  markers: PillMarker[];
  perComponent: ComponentReport[];
  areaSpread: number;
  separability: number;
  quality: QualityReport;
  edgePills: number;
  skipQualityGate: boolean;
}

/**
 * Turn the pipeline's internal disagreements into a single 0..1 number.
 *
 * Every term is a measurable way the count could be wrong, not a vibe: the two
 * independent estimators disagreeing, pills varying in size when they should
 * not, pills running off the frame, a weak threshold, a soft photo. A count
 * the app cannot stand behind is worth far more to the user as a flagged count
 * than as a confident wrong number, so these penalties are deliberately not
 * shy.
 */
function scoreConfidence(input: ConfidenceInput): number {
  const { markers, perComponent, areaSpread, separability, quality, edgePills } = input;
  if (markers.length === 0) return 0;

  let score = 1;

  // Disagreement between the seed count and the area estimate, per pill.
  const disagreement = perComponent.reduce(
    (sum, c) => sum + Math.abs(c.seedEstimate - c.areaEstimate),
    0,
  );
  score -= clamp(disagreement / markers.length, 0, 1) * 0.45;

  // Pills that should be one size but are not.
  score -= clamp((areaSpread - 0.12) / 0.5, 0, 1) * 0.2;

  // A weak pill/tray split means the mask itself may be wrong.
  score -= clamp((SEPARABILITY_FLOOR - separability) / SEPARABILITY_FLOOR, 0, 1) * 0.25;

  // Anything cut off by the frame may be a partial pill, or two.
  score -= clamp(edgePills / markers.length, 0, 1) * 0.2;

  // Clumps are where splitting errors happen.
  const inClusters = perComponent
    .filter((c) => c.count > 1)
    .reduce((sum, c) => sum + c.count, 0);
  score -= clamp(inClusters / markers.length, 0, 1) * 0.08;

  // Blobs too large to be the pills attributed to them. This is the heaviest
  // penalty in the function on purpose: it is the one situation where every
  // other signal agrees with itself and is wrong together, so without this the
  // app would hand over a badly wrong number wearing full confidence - the
  // single worst thing a counting app can do.
  const fusedPills = perComponent.filter((c) => c.fused).reduce((sum, c) => sum + c.count, 0);
  score -= clamp(fusedPills / markers.length, 0, 1) * 0.75;

  if (!input.skipQualityGate) {
    if (quality.focus < FOCUS_BLURRY_BELOW) {
      score -= clamp((FOCUS_BLURRY_BELOW - quality.focus) / FOCUS_BLURRY_BELOW, 0, 1) * 0.5;
    }
    score -= clamp((quality.glare - GLARE_WARN_ABOVE) / 0.2, 0, 1) * 0.15;
  }

  return clamp(score, 0, 1);
}

function emptyResult(
  width: number,
  height: number,
  started: number,
  quality: QualityReport,
  separability: number,
  opts: Required<CountOptions>,
): CountResult {
  return {
    count: 0,
    markers: [],
    confidence: 0,
    unitArea: 0,
    unitRadius: 0,
    components: 0,
    clusters: 0,
    largestCluster: 0,
    warnings: buildWarnings(quality, separability, [], [], 0, 0, 0, opts.skipQualityGate, 0),
    processedWidth: width,
    processedHeight: height,
    elapsedMs: Date.now() - started,
    perComponent: [],
  };
}
