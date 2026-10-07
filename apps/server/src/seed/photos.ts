import { createHash } from 'node:crypto';
import sharp from 'sharp';

// The seed's photos (task 23): small JPEGs made on the spot with sharp, one flat colour each, so
// the photo rows, derivatives and thumbnails are real without shipping image files. A receipt is
// portrait and a thing photo landscape; the colour makes each file's bytes (and so its sha256,
// the per-location dedup key, D117) its own.

export async function photoJpeg(colour: string, shape: 'photo' | 'receipt'): Promise<Buffer> {
  const [width, height] = shape === 'receipt' ? [60, 120] : [120, 90];
  return sharp({ create: { width, height, channels: 3, background: colour } })
    .jpeg({ quality: 80 })
    .toBuffer();
}

export const sha256Hex = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');
