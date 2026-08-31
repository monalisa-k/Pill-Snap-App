import * as ImageManipulator from 'expo-image-manipulator';
import { decode as decodeJpeg } from 'jpeg-js';

import type { RgbaImage } from '../vision/types';
import { base64ToBytes } from './base64';

/**
 * Longest edge handed to the counting pipeline.
 *
 * The native resize happens first, so the pure-JS JPEG decoder only ever sees
 * a small image. Decoding a full 12MP frame in JavaScript would take several
 * seconds on a phone and dominate the whole operation; at this size it is a
 * rounding error next to the counting itself, and 900px still resolves pills
 * that are touching.
 */
export const WORKING_DIMENSION = 900;

export interface DecodedPhoto {
  image: RgbaImage;
  /** Dimensions of the original photo, for mapping markers back if needed. */
  sourceWidth: number;
  sourceHeight: number;
}

/**
 * Load a photo from disk and hand back raw RGBA pixels.
 *
 * The native module does the resize (fast, hardware assisted) and JavaScript
 * does only the JPEG decode. Quality is kept high on the re-encode: chroma
 * artifacts around a pill's edge would land straight in the threshold step,
 * and a few hundred kilobytes is a cheap price for not blurring the exact
 * boundaries the count depends on.
 */
export async function decodePhoto(uri: string): Promise<DecodedPhoto> {
  const resized = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width: WORKING_DIMENSION } }],
    { base64: true, compress: 0.92, format: ImageManipulator.SaveFormat.JPEG },
  );

  if (!resized.base64) {
    throw new Error('Image resize did not return any data.');
  }

  const bytes = base64ToBytes(resized.base64);
  const decoded = decodeJpeg(bytes, { useTArray: true });

  return {
    image: {
      width: decoded.width,
      height: decoded.height,
      data: new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.length),
    },
    sourceWidth: resized.width,
    sourceHeight: resized.height,
  };
}
