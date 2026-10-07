import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepStaleTemps } from './sweep.js';

// Review #16: a crash mid-upload leaves its spooled body in KEPT_DATA_DIR/tmp, and a crash
// mid-put a `<key>.<uuid>.tmp` beside a blob. Boot sweeps what is older than an hour.

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kept-sweep-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function touch(file: string, ageMs: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'x');
  const at = new Date(Date.now() - ageMs);
  await utimes(file, at, at);
}

describe('sweepStaleTemps', () => {
  it('removes stale upload spools and blob .tmp files, and nothing else', async () => {
    const tmp = path.join(dir, 'tmp');
    const blobs = path.join(dir, 'blobs');
    const hour = 60 * 60 * 1000;
    await touch(path.join(tmp, 'old-spool'), 2 * hour);
    await touch(path.join(tmp, 'old-spool.display.jpg'), 2 * hour);
    await touch(path.join(tmp, 'fresh-spool'), 60_000);
    const loc = '01a0e000-0000-7000-8000-000000000001';
    const old = path.join(
      blobs,
      'f',
      loc,
      `01a0e000-0000-7000-8000-000000000002.${'a'.repeat(8)}.tmp`,
    );
    const fresh = path.join(
      blobs,
      'f',
      loc,
      `01a0e000-0000-7000-8000-000000000003.${'b'.repeat(8)}.tmp`,
    );
    const kept = path.join(blobs, 'f', loc, '01a0e000-0000-7000-8000-000000000004');
    const oldBlob = path.join(blobs, 'd', '01a0e000-0000-7000-8000-000000000004', 'thumb.jpg');
    await touch(old, 3 * hour);
    await touch(fresh, 60_000);
    await touch(kept, 5 * hour);
    await touch(oldBlob, 5 * hour);

    const removed = await sweepStaleTemps({ tmpDir: tmp, blobsRoot: blobs });
    expect(removed).toBe(3);
    expect((await readdir(tmp)).sort()).toEqual(['fresh-spool']);
    expect((await readdir(path.dirname(old))).sort()).toEqual(
      [path.basename(fresh), path.basename(kept)].sort(),
    );
    expect(await readdir(path.dirname(oldBlob))).toEqual(['thumb.jpg']);
  });

  it('is quiet about directories that are not there yet (a first boot)', async () => {
    const none = path.join(dir, 'nothing-here');
    expect(await sweepStaleTemps({ tmpDir: path.join(none, 'tmp'), blobsRoot: null })).toBe(0);
  });
});
