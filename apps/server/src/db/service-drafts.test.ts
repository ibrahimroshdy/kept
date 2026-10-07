import { newId } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import {
  addMember,
  ownerTx,
  pgError,
  seedTenant,
  seedUser,
  type Tenant,
} from '../../test/tenancy.js';
import { withScope } from './scope.js';

// Step 5, task 5 (0062, 0063): service drafts for invoices read by AI (screens §5; plan Q11,
// Q12). A draft is seen by the location's members, counts nowhere until confirmed, and is
// confirmed one way; the extraction reading its invoice points at it.

const db = await testDb();

let ibrahim: Tenant;
let louis: string; // member
let talia: string; // viewer
let car: string;
let meter: string;

const as = <T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  withScope(db.pools.app, { userId, mfa: true }, (_tx, c) => fn(c));
const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);

beforeEach(async () => {
  await db.reset();
  ibrahim = await seedTenant(db, 'drafts-ibrahim');
  louis = await seedUser(db, 'drafts-louis');
  talia = await seedUser(db, 'drafts-talia');
  await addMember(db, ibrahim.locationId, louis, 'member');
  await addMember(db, ibrahim.locationId, talia, 'viewer');
  car = newId();
  meter = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Corolla')`,
    [car, ibrahim.locationId, ibrahim.unplacedId],
  );
  await own(
    `INSERT INTO public.meters (id, location_id, thing_id, kind, unit)
     VALUES ($1, $2, $3, 'distance', 'km')`,
    [meter, ibrahim.locationId, car],
  );
});

const reading = (value: number, takenAt: string) =>
  as(louis, async (c) => {
    const id = newId();
    await c.query(
      `INSERT INTO public.meter_readings (id, location_id, meter_id, value, taken_at, source)
       VALUES ($1, $2, $3, $4, $5, 'service')`,
      [id, ibrahim.locationId, meter, value, takenAt],
    );
    return id;
  });

const service = (on: string, state: 'draft' | 'confirmed', readingId: string | null = null) =>
  as(louis, async (c) => {
    const id = newId();
    await c.query(
      `INSERT INTO public.service_records (id, location_id, thing_id, serviced_on,
                                           meter_reading_id, review_state, logged_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, ibrahim.locationId, car, on, readingId, state, louis],
    );
    return id;
  });

const oilChange = () =>
  as(louis, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO public.schedules (location_id, thing_id, name, every_months, every_units,
                                     meter_id, anchor_on, anchor_value, skip_next, created_by)
       VALUES ($1, $2, 'Oil change', 12, 10000, $3, '2026-01-10', 40000, true, $4) RETURNING id`,
      [ibrahim.locationId, car, meter, louis],
    );
    return rows[0]?.id as string;
  });

const complete = (record: string, schedule: string) =>
  as(louis, (c) =>
    c.query(
      `INSERT INTO public.service_completions (location_id, service_record_id, schedule_id)
       VALUES ($1, $2, $3)`,
      [ibrahim.locationId, record, schedule],
    ),
  );

const scheduleRow = async (id: string) =>
  (
    await own<{ anchor_on: string; anchor_value: string | null; skip_next: boolean }>(
      `SELECT anchor_on::text, anchor_value::text, skip_next FROM public.schedules WHERE id = $1`,
      [id],
    )
  )[0];

describe('service drafts (Q12)', () => {
  it('are confirmed by default, and every member of the location sees a draft', async () => {
    const plain = await as(louis, async (c) => {
      const id = newId();
      await c.query(
        `INSERT INTO public.service_records (id, location_id, thing_id, serviced_on, logged_by)
         VALUES ($1, $2, $3, '2026-09-01', $4)`,
        [id, ibrahim.locationId, car, louis],
      );
      return id;
    });
    const draft = await service('2026-09-20', 'draft');
    for (const who of [ibrahim.userId, louis, talia]) {
      const rows = await as(who, (c) =>
        c.query<{ id: string; review_state: string }>(
          'SELECT id, review_state FROM public.service_records ORDER BY serviced_on',
        ),
      );
      expect(rows.rows).toEqual([
        { id: plain, review_state: 'confirmed' },
        { id: draft, review_state: 'draft' },
      ]);
    }
    expect(
      await pgError(
        as(louis, (c) =>
          c.query(
            `INSERT INTO public.service_records (location_id, thing_id, serviced_on, review_state,
                                                 logged_by)
             VALUES ($1, $2, '2026-09-21', 'pending', $3)`,
            [ibrahim.locationId, car, louis],
          ),
        ),
      ),
    ).toMatchObject({ code: '23514', constraint: 'service_records_review_state_chk' });
  });

  it('a draft that completes a schedule neither re-anchors it nor ends its skip; confirming does both', async () => {
    const oil = await oilChange();
    const r = await reading(49800, '2026-09-20T09:00:00Z');
    const draft = await service('2026-09-20', 'draft', r);
    await complete(draft, oil);
    expect(await scheduleRow(oil)).toEqual({
      anchor_on: '2026-01-10',
      anchor_value: '40000.000',
      skip_next: true,
    });
    await as(louis, (c) =>
      c.query(`UPDATE public.service_records SET review_state = 'confirmed' WHERE id = $1`, [
        draft,
      ]),
    );
    expect(await scheduleRow(oil)).toEqual({
      anchor_on: '2026-09-20',
      anchor_value: '49800.000',
      skip_next: false,
    });
    // One way: a confirmed record never goes back to being a draft, except by undo.
    expect(
      await pgError(
        as(louis, (c) =>
          c.query(`UPDATE public.service_records SET review_state = 'draft' WHERE id = $1`, [
            draft,
          ]),
        ),
      ),
    ).toMatchObject({ code: '23514', constraint: 'service_records_review_state' });
    const undoEvent = newId();
    await withScope(db.pools.app, { userId: louis, mfa: true }, async (_tx, c) => {
      await c.query(`SELECT set_config('app.undo', $1, true)`, [undoEvent]);
      await c.query(`UPDATE public.service_records SET review_state = 'draft' WHERE id = $1`, [
        draft,
      ]);
    });
    expect((await scheduleRow(oil))?.anchor_on).toBe('2026-01-10');
  });

  it('one record owns a reading (Q11)', async () => {
    const r = await reading(50000, '2026-09-21T09:00:00Z');
    await service('2026-09-21', 'confirmed', r);
    expect(await pgError(service('2026-09-21', 'draft', r))).toMatchObject({
      code: '23505',
      constraint: 'service_records_reading_uq',
    });
  });
});

describe('the extraction reading a draft’s invoice', () => {
  const invoice = async (draft: string) =>
    as(louis, async (c) => {
      const id = newId();
      await c.query(
        `INSERT INTO public.attachments (id, location_id, url, service_record_id, role, created_by)
         VALUES ($1, $2, 'https://example.test/invoice.pdf', $3, 'receipt', $4)`,
        [id, ibrahim.locationId, draft, louis],
      );
      return id;
    });
  const extraction = (
    attachment: string,
    draft: string,
    extra: { thing?: string; attempt?: number } = {},
  ) =>
    as(louis, (c) =>
      c.query(
        `INSERT INTO public.extractions (location_id, attachment_id, service_record_id, thing_id,
                                         mode, attempt, requested_by)
         VALUES ($1, $2, $3, $4, 'receipt', $5, $6)`,
        [ibrahim.locationId, attachment, draft, extra.thing ?? null, extra.attempt ?? 1, louis],
      ),
    );

  it('points at the draft, one live attempt per invoice, one subject per row, gone with it', async () => {
    const draft = await service('2026-09-22', 'draft');
    const pdf = await invoice(draft);
    await extraction(pdf, draft);
    expect(await pgError(extraction(pdf, draft, { attempt: 2 }))).toMatchObject({
      code: '23505',
      constraint: 'extractions_live_uq',
    });
    const other = await invoice(draft);
    expect(await pgError(extraction(other, draft, { thing: car }))).toMatchObject({
      code: '23514',
      constraint: 'extractions_one_draft_chk',
    });
    // No grant: the target is set at insert only.
    expect(
      await pgError(
        as(louis, (c) => c.query('UPDATE public.extractions SET service_record_id = NULL')),
      ),
    ).toMatchObject({ code: '42501' });
    await as(louis, (c) => c.query('DELETE FROM public.service_records WHERE id = $1', [draft]));
    expect(await own('SELECT 1 FROM public.extractions')).toEqual([]);
  });

  it('refuses a draft of another location (the composite key)', async () => {
    const b = await seedTenant(db, 'drafts-bruce');
    const theirs = newId();
    await own(
      `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Van')`,
      [theirs, b.locationId, b.unplacedId],
    );
    const theirDraft = newId();
    await own(
      `INSERT INTO public.service_records (id, location_id, thing_id, serviced_on, review_state,
                                           logged_by)
       VALUES ($1, $2, $3, '2026-09-22', 'draft', $4)`,
      [theirDraft, b.locationId, theirs, b.userId],
    );
    const mine = await service('2026-09-22', 'draft');
    const pdf = await invoice(mine);
    expect(await pgError(extraction(pdf, theirDraft))).toMatchObject({ code: '23503' });
  });
});
