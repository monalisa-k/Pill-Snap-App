import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js';

import { countPills } from '../../vision/count';
import { chainScene, layoutScene } from '../../vision/__tests__/synth';
import type { RgbaImage } from '../../vision/types';
import { base64ToBytes } from '../base64';

/**
 * End-to-end test of the data path a real photo takes.
 *
 * The scenario suites feed the counter pristine pixel buffers. On a phone the
 * pixels arrive via JPEG, and JPEG does specific damage that matters here:
 * chroma subsampling smears colour across pill boundaries and the DCT rings
 * around every high-contrast edge, which is exactly where the threshold has to
 * land. Encoding, base64-ing and decoding the way `decodePhoto` does keeps
 * that damage in the test rather than discovering it on a device.
 */
function throughJpeg(image: RgbaImage, quality: number): RgbaImage {
  const encoded = encodeJpeg(
    { data: Buffer.from(image.data), width: image.width, height: image.height },
    quality,
  );

  // Take the same base64 round trip the app does, so the decoder is exercised
  // on real image bytes and not just on synthetic buffers.
  const base64 = Buffer.from(encoded.data).toString('base64');
  const bytes = base64ToBytes(base64);

  const decoded = decodeJpeg(bytes, { useTArray: true });
  return {
    width: decoded.width,
    height: decoded.height,
    data: new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.length),
  };
}

describe('photo pipeline', () => {
  it('survives the JPEG round trip at the quality the app encodes with', () => {
    const scene = layoutScene({ count: 24, radius: 14, seed: 31 });
    const result = countPills(throughJpeg(scene.image, 92), { skipQualityGate: true });

    expect(result.count).toBe(24);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('still counts touching pills after JPEG compression', () => {
    const scene = chainScene({ count: 18, radius: 14, spacing: 0.97, seed: 5 });
    expect(countPills(throughJpeg(scene.image, 92), { skipQualityGate: true }).count).toBe(18);
  });

  it('holds up on heavily compressed photos', () => {
    // Well below what the app produces, as a margin check rather than a target.
    const scene = layoutScene({ count: 20, radius: 14, seed: 12 });
    for (const quality of [80, 60, 40]) {
      expect(countPills(throughJpeg(scene.image, quality), { skipQualityGate: true }).count).toBe(20);
    }
  });

  it('counts coloured pills after chroma subsampling', () => {
    // Colour takes the worst of JPEG, and this scene is separated on the
    // saturation channel, so it is the case most exposed to that damage.
    const scene = layoutScene({
      count: 14,
      radius: 12,
      colour: { r: 198, g: 44, b: 48 },
      background: { r: 244, g: 244, b: 240 },
      seed: 44,
    });
    expect(countPills(throughJpeg(scene.image, 92), { skipQualityGate: true }).count).toBe(14);
  });

  it('does not let compression noise trip the blur gate', () => {
    const scene = layoutScene({ count: 16, radius: 14, seed: 8 });
    const result = countPills(throughJpeg(scene.image, 92));
    expect(result.warnings.map((w) => w.code)).not.toContain('IMAGE_BLURRY');
  });
});
