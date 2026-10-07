import { readFileSync } from 'node:fs';
import path from 'node:path';
import { newId } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import { testFiles, uniqueJpeg, upload } from '../../test/files.js';
import { call, peopleApp, person } from '../../test/people.js';
import {
  asOwner,
  insertLocation,
  ownerTx,
  pgError,
  seedTenant,
  type Tenant,
} from '../../test/tenancy.js';
import { builtinType, createLocation, createThing, ok, own } from '../../test/things.js';
import { migrationsFolder } from './migrate.js';
import { type Scope, withScope } from './scope.js';

// Step 5, task 4 (0060, 0061): the stale-reading nudge's interval, readings that reach the
// offline snapshot, and step 3's proof photos moved onto their reading (D27, D52, D195; plan Q10,
// Q18, Q19).

const db = await testDb();
const app = db.pools.app;

beforeEach(async () => {
  await db.reset();
});

const as = (userId: string): Scope => ({ userId, mfa: false });

async function q<T extends pg.QueryResultRow = Record<string, unknown>>(
  scope: Scope,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  return withScope(app, scope, async (_tx, client) => (await client.query<T>(text, values)).rows);
}

async function car(t: Tenant): Promise<{ thing: string; meter: string }> {
  const thing = newId();
  const meter = newId();
  await q(
    as(t.userId),
    `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Corolla')`,
    [thing, t.locationId, t.unplacedId],
  );
  await q(
    as(t.userId),
    `INSERT INTO public.meters (id, location_id, thing_id, kind, unit)
     VALUES ($1, $2, $3, 'distance', 'km')`,
    [meter, t.locationId, thing],
  );
  return { thing, meter };
}

const versions = async (thing: string) =>
  (
    await asOwner(db, (c) =>
      c.query<{ meter_version: number; row_version: number; change_seq: string }>(
        'SELECT meter_version, row_version, change_seq::text FROM public.things WHERE id = $1',
        [thing],
      ),
    )
  ).rows[0] as { meter_version: number; row_version: number; change_seq: string };

describe('meters.nudge_days (Q19)', () => {
  it('is 30 days by default, 7–365 or none, and the meter’s writers set it', async () => {
    const a = await seedTenant(db, 'a');
    const { meter } = await car(a);
    expect(
      await q(as(a.userId), 'SELECT nudge_days FROM public.meters WHERE id = $1', [meter]),
    ).toEqual([{ nudge_days: 30 }]);
    for (const days of [6, 366]) {
      expect(
        await pgError(
          q(as(a.userId), 'UPDATE public.meters SET nudge_days = $2 WHERE id = $1', [meter, days]),
        ),
      ).toMatchObject({ code: '23514', constraint: 'meters_nudge_days_chk' });
    }
    await q(as(a.userId), 'UPDATE public.meters SET nudge_days = NULL WHERE id = $1', [meter]);
    await q(as(a.userId), 'UPDATE public.meters SET nudge_days = 7 WHERE id = $1', [meter]);
    expect(
      await q(as(a.userId), 'SELECT nudge_days FROM public.meters WHERE id = $1', [meter]),
    ).toEqual([{ nudge_days: 7 }]);
  });
});

describe('readings reach the snapshot (Q18)', () => {
  it('bump the thing’s change_seq, never its row_version, on a real change only', async () => {
    const a = await seedTenant(db, 'a');
    const { thing, meter } = await car(a);
    const start = await versions(thing);
    const reading = newId();
    await q(
      as(a.userId),
      `INSERT INTO public.meter_readings (id, location_id, meter_id, value, taken_at)
       VALUES ($1, $2, $3, 1000, now() - interval '1 day')`,
      [reading, a.locationId, meter],
    );
    const added = await versions(thing);
    expect(added.meter_version).toBe(start.meter_version + 1);
    expect(added.row_version).toBe(start.row_version);
    expect(BigInt(added.change_seq)).toBeGreaterThan(BigInt(start.change_seq));

    // A note changes nothing READING shows.
    await q(as(a.userId), `UPDATE public.meter_readings SET note = 'tyres' WHERE id = $1`, [
      reading,
    ]);
    expect((await versions(thing)).meter_version).toBe(added.meter_version);
    for (const set of ['value = 1001', `taken_at = now()`, `state = 'needs_review'`]) {
      const before = await versions(thing);
      await q(as(a.userId), `UPDATE public.meter_readings SET ${set} WHERE id = $1`, [reading]);
      expect((await versions(thing)).meter_version).toBe(before.meter_version + 1);
    }
    const before = await versions(thing);
    await q(as(a.userId), 'DELETE FROM public.meter_readings WHERE id = $1', [reading]);
    const removed = await versions(thing);
    expect(removed.meter_version).toBe(before.meter_version + 1);
    expect(removed.row_version).toBe(start.row_version);
  });

  it('a move carries the readings and bumps no meter version', async () => {
    const a = await seedTenant(db, 'a');
    const flat = await ownerTx(db, (c) => insertLocation(c, a, { name: 'Flat' }));
    const { thing, meter } = await car(a);
    await q(
      as(a.userId),
      `INSERT INTO public.meter_readings (location_id, meter_id, value, taken_at)
       VALUES ($1, $2, 1000, now())`,
      [a.locationId, meter],
    );
    const before = await versions(thing);
    await q(as(a.userId), 'SELECT * FROM kept.move_things($1, $2, $3, NULL)', [
      [thing],
      flat.locationId,
      flat.unplacedId,
    ]);
    expect((await versions(thing)).meter_version).toBe(before.meter_version);
    expect(
      await q(as(a.userId), 'SELECT location_id FROM public.meter_readings WHERE meter_id = $1', [
        meter,
      ]),
    ).toEqual([{ location_id: flat.locationId }]);
  });

  it('the trash purge deletes a car with readings (no bump of a thing being deleted)', async () => {
    const a = await seedTenant(db, 'a');
    const { thing, meter } = await car(a);
    await q(
      as(a.userId),
      `INSERT INTO public.meter_readings (location_id, meter_id, value, taken_at)
       VALUES ($1, $2, 1000, now() - interval '2 days'), ($1, $2, 1100, now() - interval '1 day')`,
      [a.locationId, meter],
    );
    await asOwner(db, (c) =>
      c.query(`UPDATE public.things SET deleted_at = now() - interval '40 days' WHERE id = $1`, [
        thing,
      ]),
    );
    const { rows } = await asOwner(db, (c) =>
      c.query<{ n: number }>(`SELECT kept.purge_trash(now() - interval '30 days', 10) AS n`),
    );
    expect(rows[0]?.n).toBe(1);
    const { rows: left } = await asOwner(db, (c) =>
      c.query('SELECT 1 FROM public.meter_readings WHERE meter_id = $1', [meter]),
    );
    expect(left).toEqual([]);
  });
});

describe('proof photos move to their reading (Q10)', () => {
  // 0061's last statement, run again on captures made through step 3's capture service. It is
  // idempotent, and a proof already on its reading (T8's capture) is left as it is.
  const moveProofs = (() => {
    const text = readFileSync(path.join(migrationsFolder, '0061_meter_readings_step5.sql'), 'utf8');
    return (text.split('--> statement-breakpoint').at(-1) as string).trim();
  })();

  it('moves a typed reading capture’s proof onto its reading; one without a reading stays', async () => {
    const files = await testFiles();
    const t = await peopleApp(db, { files, sent: [] });
    try {
      const ibrahim = await person(t, db, 'ibrahim');
      const home = await createLocation(t, db, ibrahim, 'household');
      const corolla = await createThing(t, ibrahim, home, {
        name: 'Corolla',
        typeId: await builtinType(db, 'car'),
      });
      const up = async () => {
        const res = await upload(t, ibrahim, home.id, await uniqueJpeg(), { cls: 'evidence' });
        expect(res.statusCode, res.body).toBe(201);
        return (res.json() as { id: string }).id;
      };
      const capture = async (over: Record<string, unknown>) =>
        ok(
          await call(t, '/api/v1/captures', {
            as: ibrahim,
            headers: { 'idempotency-key': newId() },
            body: {
              locationId: home.id,
              target: { unplaced: true },
              mode: 'reading',
              batchId: newId(),
              attachToThingId: corolla.id,
              ...over,
            },
          }),
          201,
        );
      const typedId = newId();
      const typedFile = await up();
      await capture({
        id: typedId,
        files: [{ fileId: typedFile, role: 'proof' }],
        readingValue: '52340',
      });
      const askedFile = await up();
      await capture({ id: newId(), files: [{ fileId: askedFile, role: 'proof' }] });

      await asOwner(db, (c) => c.query(moveProofs));
      await asOwner(db, (c) => c.query(moveProofs));
      const rows = await own<{ file_id: string; thing_id: string | null; reading: string | null }>(
        db,
        `SELECT file_id, thing_id, meter_reading_id AS reading FROM public.attachments
          WHERE file_id = ANY ($1::uuid[]) ORDER BY file_id = $2 DESC`,
        [[typedFile, askedFile], typedFile],
      );
      expect(rows).toEqual([
        { file_id: typedFile, thing_id: null, reading: typedId },
        { file_id: askedFile, thing_id: corolla.id, reading: null },
      ]);
    } finally {
      await t.app.close();
      await files.cleanup();
    }
  });
});
