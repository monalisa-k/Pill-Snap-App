/**
 * Core data types for the Pill Snap vision pipeline.
 *
 * Everything here is plain TypeScript over typed arrays with no React Native,
 * DOM or Node dependencies, so the exact same code path runs on device and
 * inside the Jest suite. If it passes in tests, it is the same arithmetic that
 * runs on the phone.
 */

/** Interleaved 8-bit RGBA, 4 bytes per pixel, row major. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** Single channel 8-bit image, 1 byte per pixel, row major. */
export interface GrayImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** Binary mask where 1 means foreground (pill) and 0 means background. */
export interface BinaryMask {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** A single pill the pipeline believes it found, in processing-image pixels. */
export interface PillMarker {
  /** Centre x in processing-image pixel coordinates. */
  x: number;
  /** Centre y in processing-image pixel coordinates. */
  y: number;
  /** Estimated radius in processing-image pixels, for drawing. */
  r: number;
  /** Which connected component this pill came from. */
  componentId: number;
  /**
   * True when this pill was separated out of a touching cluster rather than
   * found as its own isolated blob. Cluster splits are the main source of
   * error, so the UI highlights them for review.
   */
  fromCluster: boolean;
}

export type WarningCode =
  | 'NO_PILLS_FOUND'
  | 'LOW_CONTRAST'
  | 'IMAGE_BLURRY'
  | 'GLARE'
  | 'HEAVY_CLUSTERING'
  | 'INCONSISTENT_SIZES'
  | 'PILLS_TOUCHING_EDGE'
  | 'SPARSE_CALIBRATION'
  | 'PILLS_FUSED'
  | 'BRIGHT_REGION_IGNORED'
  | 'FRAME_NOT_JUST_TRAY'
  | 'COUNT_AMBIGUOUS';

export interface CountWarning {
  code: WarningCode;
  /** Human readable, written to be shown directly in the UI. */
  message: string;
  /** 'block' means do not trust the number, 'warn' means review it. */
  severity: 'warn' | 'block';
}

/** Per-component diagnostics, useful for tests and the debug overlay. */
export interface ComponentReport {
  id: number;
  area: number;
  /** Pills attributed to this component. */
  count: number;
  /** count derived purely from area / unitArea. */
  areaEstimate: number;
  /** count derived purely from distance-transform seeds. */
  seedEstimate: number;
  touchesEdge: boolean;
  /**
   * Blob area divided by the area the attributed pills should occupy. Near 1
   * for round tablets and near 3 for capsules; anything far higher means the
   * blob is a raft of fused pills being reported as one.
   */
  shapeRatio: number;
  /** The blob is too big for the pills attributed to it to explain. */
  fused: boolean;
}

export interface CountResult {
  /** The headline number. */
  count: number;
  /** One marker per counted pill. */
  markers: PillMarker[];
  /** 0..1. Below ~0.9 the UI asks the user to confirm. */
  confidence: number;
  /** Median area in px^2 of one pill, as calibrated from this image. */
  unitArea: number;
  /** Median radius in px of one pill. */
  unitRadius: number;
  /** Number of connected blobs found. */
  components: number;
  /** Number of blobs that held more than one pill. */
  clusters: number;
  /** Pills in the single busiest cluster. */
  largestCluster: number;
  warnings: CountWarning[];
  /** Size of the image the pipeline actually ran on. */
  processedWidth: number;
  processedHeight: number;
  /** Milliseconds spent in the pipeline. */
  elapsedMs: number;
  perComponent: ComponentReport[];
}

export interface CountOptions {
  /**
   * Longest edge the pipeline downscales to before working. Smaller is faster,
   * larger resolves pills that are close together. 900 is a good balance for a
   * 12MP phone photo of a tray.
   */
  maxDimension?: number;
  /** Discard blobs smaller than this fraction of the calibrated pill area. */
  minAreaRatio?: number;
  /**
   * Radius factor for seed suppression when splitting clusters. Lower finds
   * more pills in a cluster (risking over-count), higher finds fewer.
   */
  seedSuppression?: number;
  /** Skip the blur/glare quality gate. Tests use this. */
  skipQualityGate?: boolean;
  /** Force foreground polarity instead of auto-detecting it. */
  polarity?: 'auto' | 'darkPills' | 'lightPills';
  /**
   * Watershed persistence threshold as a fraction of the calibrated pill
   * radius. Lower splits clumps more eagerly.
   */
  persistenceFactor?: number;
}

export const DEFAULT_OPTIONS: Required<CountOptions> = {
  maxDimension: 900,
  minAreaRatio: 0.28,
  seedSuppression: 0.72,
  skipQualityGate: false,
  polarity: 'auto',
  persistenceFactor: 0.18,
};
