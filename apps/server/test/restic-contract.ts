import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Restic, ResticError, type ResticRepo } from '../src/backup/restic/restic.js';

// What every Restic implementation promises (src/backup/restic/restic.ts; step-8 plan T2): the
// in-memory fake in backup/restic/restic.contract.test.ts, and T5's real wrapper there too under
// KEPT_TEST_RESTIC=1. What only one does (the fake's test hooks, the real one's argv and exit
// codes) stays in that one's tests.

export type ResticHarness = {
  restic: Restic;
  /** A repository location not yet initialised, opened with `password`. Each call is a new
   * location unless `same` names an earlier repo whose location to reuse. */
  makeRepo(password: string, same?: ResticRepo): Promise<ResticRepo>;
  cleanup?(): Promise<void>;
};

const PASSWORD = 'correct horse battery staple';

export function resticContract(name: string, makeHarness: () => Promise<ResticHarness>): void {
  describe(`${name}: the Restic contract`, () => {
    let h: ResticHarness;
    let scratch: string;
    let data: string;

    beforeAll(async () => {
      h = await makeHarness();
      scratch = await mkdtemp(path.join(tmpdir(), 'kept-restic-'));
      data = path.join(scratch, 'data');
      await mkdir(path.join(data, 'backup', 'db'), { recursive: true });
      await mkdir(path.join(data, 'blobs', 'f'), { recursive: true });
      await mkdir(path.join(data, 'tmp'), { recursive: true });
      await writeFile(path.join(data, 'backup', 'db', 'db.dump'), 'dump v1');
      await writeFile(path.join(data, 'blobs', 'f', 'one'), 'first file');
      await writeFile(path.join(data, 'tmp', 'scratch'), 'never backed up');
    });

    afterAll(async () => {
      await rm(scratch, { recursive: true, force: true });
      await h.cleanup?.();
    });

    it('reports a version', async () => {
      expect(await h.restic.version()).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('creates a repository once, and refuses a missing one or a wrong password', async () => {
      const repo = await h.makeRepo(PASSWORD);
      await expect(h.restic.snapshots(repo)).rejects.toMatchObject({ reason: 'no_repository' });
      expect(await h.restic.init(repo)).toEqual({ created: true });
      expect(await h.restic.init(repo)).toEqual({ created: false });
      expect(await h.restic.snapshots(repo)).toEqual([]);
      const wrong = await h.makeRepo('not the password at all', repo);
      const err = await h.restic.snapshots(wrong).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ResticError);
      expect(err).toMatchObject({ reason: 'wrong_password' });
      expect(String((err as Error).message)).not.toContain(PASSWORD);
    });

    it('backs up, deduplicates, lists, and leaves out what is excluded', async () => {
      const repo = await h.makeRepo(PASSWORD);
      await h.restic.init(repo);
      const opts = {
        paths: [path.join(data, 'backup'), path.join(data, 'blobs')],
        tags: ['kept', 'nightly', 'v0.0.0-test'],
        exclude: [path.join(data, 'tmp')],
      };
      const first = await h.restic.backup(repo, opts);
      expect(first).toMatchObject({ filesNew: 2, filesChanged: 0, filesTotal: 2 });
      expect(first.snapshotId).toMatch(/^[0-9a-f]{8,64}$/);
      expect(first.bytesAdded).toBeGreaterThan(0);

      const second = await h.restic.backup(repo, opts);
      expect(second).toMatchObject({ filesNew: 0, filesChanged: 0, filesUnmodified: 2 });

      await writeFile(path.join(data, 'blobs', 'f', 'two'), 'second file');
      const third = await h.restic.backup(repo, opts);
      expect(third).toMatchObject({ filesNew: 1, filesUnmodified: 2, filesTotal: 3 });

      const snaps = await h.restic.snapshots(repo, { tags: ['nightly'] });
      expect(snaps.map((s) => s.id)).toEqual([
        third.snapshotId,
        second.snapshotId,
        first.snapshotId,
      ]);
      expect(snaps[0]?.tags).toEqual(expect.arrayContaining(['kept', 'nightly', 'v0.0.0-test']));
      expect(snaps[0]?.host).toBe('kept');

      const files = (await h.restic.ls(repo, third.snapshotId, { path: path.join(data, 'blobs') }))
        .filter((n) => n.type === 'file')
        .map((n) => n.path);
      expect(files).toEqual([
        path.join(data, 'blobs', 'f', 'one'),
        path.join(data, 'blobs', 'f', 'two'),
      ]);
      const all = await h.restic.ls(repo, third.snapshotId);
      expect(all.some((n) => n.path.startsWith(path.join(data, 'tmp')))).toBe(false);

      const stats = await h.restic.stats(repo);
      expect(stats.snapshots).toBe(3);
      expect(stats.totalBytes).toBeGreaterThan(0);
      expect(await h.restic.check(repo)).toEqual({ ok: true, errors: [] });
    });

    it('restores one subtree under the target, byte for byte', async () => {
      const repo = await h.makeRepo(PASSWORD);
      await h.restic.init(repo);
      const { snapshotId } = await h.restic.backup(repo, {
        paths: [path.join(data, 'backup'), path.join(data, 'blobs')],
        tags: ['kept', 'manual'],
      });
      const target = path.join(scratch, `restore-${snapshotId.slice(0, 8)}`);
      await mkdir(target);
      const result = await h.restic.restore(repo, snapshotId, {
        target,
        include: [path.join(data, 'backup', 'db')],
      });
      expect(result.filesRestored).toBe(1);
      const dump = path.join(target, data, 'backup', 'db', 'db.dump');
      expect(await readFile(dump, 'utf8')).toBe('dump v1');
      await expect(readFile(path.join(target, data, 'blobs', 'f', 'one'))).rejects.toThrow();
    });

    it('backs up paths relative to a working directory, stored and restored under /', async () => {
      const repo = await h.makeRepo(PASSWORD);
      await h.restic.init(repo);
      const { snapshotId } = await h.restic.backup(repo, {
        paths: ['backup'],
        cwd: data,
        tags: ['kept', 'nightly'],
      });
      const nodes = (await h.restic.ls(repo, snapshotId)).filter((n) => n.type === 'file');
      expect(nodes.map((n) => n.path)).toEqual(['/backup/db/db.dump']);
      const target = path.join(scratch, `relative-${snapshotId.slice(0, 8)}`);
      await mkdir(target);
      await h.restic.restore(repo, snapshotId, { target, include: ['/backup/db'] });
      expect(await readFile(path.join(target, 'backup', 'db', 'db.dump'), 'utf8')).toBe('dump v1');
    });

    it('keeps 7 daily, 4 weekly and 6 monthly over 40 days, within the tags only', async () => {
      const repo = await h.makeRepo(PASSWORD);
      await h.restic.init(repo);
      const paths = [path.join(data, 'backup')];
      const byId = new Map<string, string>();
      for (let day = 0; day < 40; day++) {
        // Noon UTC: the same calendar day in every zone the tests run in (TZ=Africa/Cairo).
        const time = new Date(Date.UTC(2026, 0, 1 + day, 12));
        const { snapshotId } = await h.restic.backup(repo, {
          paths,
          tags: ['kept', 'nightly'],
          time,
        });
        byId.set(snapshotId, time.toISOString().slice(0, 10));
      }
      const upgrade = await h.restic.backup(repo, {
        paths,
        tags: ['kept', 'pre_upgrade'],
        time: new Date(Date.UTC(2026, 0, 2, 12)),
      });

      const result = await h.restic.forget(repo, {
        tags: ['kept', 'nightly'],
        keep: { daily: 7, weekly: 4, monthly: 6 },
        prune: true,
      });
      const keptDays = result.kept.map((id) => byId.get(id)).sort();
      // Daily: 3–9 Feb. Weekly (ISO weeks from Monday): 9 Feb, 8 Feb, 1 Feb, 25 Jan.
      // Monthly: 9 Feb, 31 Jan, and, with 4 of the 6 months unfilled, the oldest (R1: restic's
      // "oldest monthly snapshot").
      expect(keptDays).toEqual([
        '2026-01-01',
        '2026-01-25',
        '2026-01-31',
        '2026-02-01',
        '2026-02-03',
        '2026-02-04',
        '2026-02-05',
        '2026-02-06',
        '2026-02-07',
        '2026-02-08',
        '2026-02-09',
      ]);
      expect(result.removed).toHaveLength(29);
      const left = await h.restic.snapshots(repo);
      expect(left.map((s) => s.id)).toContain(upgrade.snapshotId);
      expect(left).toHaveLength(12);
      expect(await h.restic.check(repo)).toMatchObject({ ok: true });
    });

    it('unlocks a repository nothing holds', async () => {
      const repo = await h.makeRepo(PASSWORD);
      await h.restic.init(repo);
      await expect(h.restic.unlock(repo)).resolves.toBeUndefined();
    });
  });
}
