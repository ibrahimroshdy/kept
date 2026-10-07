import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AppError } from '../http/errors.js';
import { sniff } from './sniff.js';

// T2 step 6; D157: the content decides, never the declared type or the name.

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../test/fixtures/files/${name}`, import.meta.url));

describe('sniff', () => {
  it.each([
    ['photo.jpg', 'image/jpeg', 'image'],
    ['rotated.jpg', 'image/jpeg', 'image'],
    ['doc.pdf', 'application/pdf', 'pdf'],
    ['image.heic', 'image/heic', 'image'],
  ])('accepts %s as %s', async (name, mime, kind) => {
    expect(await sniff(fixture(name))).toMatchObject({ mime, kind });
  });

  it.each(['fake.jpg', 'drawing.svg'])(
    'refuses %s with 415 unsupported_media_type',
    async (name) => {
      const err = await sniff(fixture(name)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({ code: 'unsupported_media_type', status: 415 });
    },
  );

  it('accepts a video only through the video flag (D170)', async () => {
    await expect(sniff(fixture('clip.mp4'))).rejects.toMatchObject({
      code: 'unsupported_media_type',
    });
    expect(await sniff(fixture('clip.mp4'), { allowVideo: true })).toMatchObject({
      mime: 'video/mp4',
      kind: 'video',
    });
  });
});
