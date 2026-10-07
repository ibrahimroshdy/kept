import { newId } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb } from '../../test/db.js';
import { addMember, ownerTx, seedTenant, seedUser, type Tenant } from '../../test/tenancy.js';
import { withSystem } from '../db/scope.js';
import { factsOf } from '../notify/senders.js';
import { REMINDER_WORDS } from '../notify/words.js';
import { OCCURRENCE_COLUMNS, type OccurrenceRow, reminderItems } from './items.js';
import { runScan, type ScanDeps } from './scan.js';

// Step 5, T14: reminders for vehicles. The stale-reading nudge (0066's `reading_stale` branch)
// through step 4's scan with no engine change (D52, D111, Q19); a reading crossing a unit
// schedule's point; selling stops a thing's sources and keeps its history (§7.13); a service
// counts only once confirmed, and a draft confirmed after the occurrence opened completes it.

const db = await testDb();
vi.setConfig({ testTimeout: 60_000 });

const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);

const deps = (): ScanDeps => ({ pools: db.pools, channels: {} });

let ibrahim: Tenant; // owns Garage
let bruce: string; // admin
let talia: string; // viewer
let corolla: string;
let odometer: string;

const builtin = async (key: string) =>
  (
    await own<{ id: string }>(
      'SELECT id FROM public.types WHERE owner_account_id IS NULL AND builtin_key = $1',
      [key],
    )
  )[0]?.id as string;

async function meterOf(thing: string, nudge: number | null = 30): Promise<string> {
  const id = newId();
  await own(
    `INSERT INTO public.meters (id, location_id, thing_id, kind, unit, nudge_days)
     VALUES ($1, $2, $3, 'distance', 'km', $4)`,
    [id, ibrahim.locationId, thing, nudge],
  );
  return id;
}

/** A reading `days` days before now (or at `at`), and its local day in Cairo. */
async function read(m: string, value: number, when: { days: number } | { at: string }) {
  const at = 'at' in when ? when.at : null;
  const days = 'days' in when ? when.days : 0;
  const rows = await own<{ d: string }>(
    `INSERT INTO public.meter_readings (location_id, meter_id, value, taken_at)
     VALUES ($1, $2, $3, coalesce($4::timestamptz, now() - make_interval(days => $5)))
     RETURNING (taken_at AT TIME ZONE 'Africa/Cairo')::date::text AS d`,
    [ibrahim.locationId, m, value, at, days],
  );
  return rows[0]?.d as string;
}

const plusDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const occurrences = (sourceId: string) =>
  own<{ id: string; kind: string; state: string; due_period: string }>(
    `SELECT id, kind, state, due_period FROM public.reminder_occurrences
      WHERE source_id = $1 ORDER BY created_at, id`,
    [sourceId],
  );

const notified = async (sourceId: string) =>
  (
    await own<{ user_id: string }>(
      `SELECT n.user_id FROM public.notifications n
         JOIN public.reminder_occurrences o ON o.id = n.occurrence_id
        WHERE o.source_id = $1 ORDER BY n.user_id`,
      [sourceId],
    )
  ).map((r) => r.user_id);

/** A unit schedule on the odometer: every `every` km from `from`, due at from + every. */
async function unitSchedule(name: string, from: number, every: number): Promise<string> {
  const id = newId();
  await own(
    `INSERT INTO public.schedules (id, location_id, thing_id, name, every_units, meter_id,
                                   anchor_on, anchor_value, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, (now() AT TIME ZONE 'Africa/Cairo')::date - 10, $7, $8)`,
    [id, ibrahim.locationId, corolla, name, every, odometer, from, ibrahim.userId],
  );
  return id;
}

beforeEach(async () => {
  await db.reset();
  ibrahim = await seedTenant(db, 'veh-ibrahim', { name: 'Garage' });
  bruce = await seedUser(db, 'veh-bruce');
  talia = await seedUser(db, 'veh-talia');
  await addMember(db, ibrahim.locationId, bruce, 'admin');
  await addMember(db, ibrahim.locationId, talia, 'viewer');
  corolla = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name, type_id)
     VALUES ($1, $2, $3, 'Toyota Corolla', $4)`,
    [corolla, ibrahim.locationId, ibrahim.unplacedId, await builtin('car')],
  );
  odometer = await meterOf(corolla);
});

describe('the stale-reading nudge (D52, Q19)', () => {
  it('a meter last read 31 days ago in Cairo reminds once across two scans, owner and admin only', async () => {
    const readOn = await read(odometer, 52_340, { days: 31 });
    await runScan(deps());
    await runScan(deps());
    expect(await occurrences(odometer)).toEqual([
      expect.objectContaining({
        kind: 'due',
        state: 'open',
        due_period: `date:${plusDays(readOn, 30)}`,
      }),
    ]);
    expect(await notified(odometer)).toEqual([ibrahim.userId, bruce].sort());

    // Its words name the meter, the thing, the location and the day it was last read (L113).
    const [item] = await withSystem(db.pools.system, async (_tx, c) => {
      const { rows } = await c.query<OccurrenceRow>(
        `SELECT ${OCCURRENCE_COLUMNS} FROM public.reminder_occurrences o WHERE o.source_id = $1`,
        [odometer],
      );
      return reminderItems(c, rows, 'https://kept.example.org');
    });
    expect(item?.meter).toEqual({ kind: 'distance', label: null, readOn });
    const facts = factsOf(item as NonNullable<typeof item>);
    const day = new Intl.DateTimeFormat('en', { dateStyle: 'long', timeZone: 'UTC' }).format(
      new Date(`${readOn}T00:00:00Z`),
    );
    expect(REMINDER_WORDS.en.headline(facts)).toBe(
      `The odometer on Toyota Corolla was last read on ${day}`,
    );
    expect(REMINDER_WORDS.en.where(facts)).toBe('Garage');
    expect(REMINDER_WORDS.ar.headline(facts)).toContain(
      'آخر قراءة لعداد المسافة في «Toyota Corolla»',
    );
  });

  it('a newer reading answers it (done); one typed for an earlier day does not', async () => {
    await read(odometer, 52_340, { days: 31 });
    await runScan(deps());
    await read(odometer, 52_000, { days: 40 });
    expect((await runScan(deps())).closed).toEqual({ done: 0, superseded: 0, cancelled: 0 });
    await read(odometer, 53_100, { days: 0 });
    expect((await runScan(deps())).closed.done).toBe(1);
    expect(await occurrences(odometer)).toEqual([expect.objectContaining({ state: 'done' })]);
  });

  it('nudges again a period later while no reading comes, and its words keep the reading day', async () => {
    const readOn = await read(odometer, 52_340, { days: 31 });
    await runScan(deps());
    // A month passes with no reading: everything moves 30 days into the past, the reading (now
    // 61 days old) and the reminder it opened.
    await own(
      `UPDATE public.meter_readings SET taken_at = taken_at - interval '30 days',
                                        received_at = received_at - interval '30 days'
        WHERE meter_id = $1`,
      [odometer],
    );
    await own(
      `UPDATE public.reminder_occurrences
          SET due_on = due_on - 30, due_period = 'date:' || (due_on - 30)::text,
              created_at = created_at - interval '30 days'
        WHERE source_id = $1`,
      [odometer],
    );
    const older = plusDays(readOn, -30);
    const { closed } = await runScan(deps());
    expect(closed.superseded).toBe(1);
    const open = (await occurrences(odometer)).filter((o) => o.state === 'open');
    expect(open).toEqual([expect.objectContaining({ due_period: `date:${plusDays(older, 60)}` })]);
    const [item] = await withSystem(db.pools.system, async (_tx, c) => {
      const { rows } = await c.query<OccurrenceRow>(
        `SELECT ${OCCURRENCE_COLUMNS} FROM public.reminder_occurrences o
          WHERE o.source_id = $1 AND o.state = 'open'`,
        [odometer],
      );
      return reminderItems(c, rows, 'https://kept.example.org');
    });
    expect(item?.meter?.readOn).toBe(older);
  });

  it('none with nudge_days NULL, none before the first reading', async () => {
    const bike = newId();
    await own(
      `INSERT INTO public.things (id, location_id, place_id, name, type_id)
       VALUES ($1, $2, $3, 'Motorbike', $4)`,
      [bike, ibrahim.locationId, ibrahim.unplacedId, await builtin('motorbike')],
    );
    const quiet = await meterOf(bike, null);
    await read(quiet, 100, { days: 90 });
    await meterOf(bike); // never read
    expect((await runScan(deps())).occurrences).toBe(0);
  });

  it("Egypt's DST end doesn't move the day: 23:30 on 30 Oct 2025 in Cairo is still the 30th", async () => {
    // Clocks went back from 00:00 to 23:00 on 30/31 Oct 2025 (UTC+3 → UTC+2, V21): 21:30Z is
    // 23:30 local on the 30th, where a fixed +3 would say 00:30 on the 31st.
    expect(await read(odometer, 40_000, { at: '2025-10-30T21:30:00Z' })).toBe('2025-10-30');
    await runScan(deps());
    // Due 30 days on from the 30th (29 Nov), rolled forward in 30-day steps to today's period
    // (0089): a whole number of steps from the 30th, never from the 31st.
    const [o] = await occurrences(odometer);
    const due = String(o?.due_period).replace('date:', '');
    const days = (Date.parse(`${due}T00:00:00Z`) - Date.parse('2025-10-30T00:00:00Z')) / 86_400_000;
    expect(days % 30).toBe(0);
    expect(days).toBeGreaterThanOrEqual(30);
  });
});

describe('unit schedules on the odometer', () => {
  it('a reading that crosses 55,000 km raises the oil change by the next scan', async () => {
    const oil = await unitSchedule('Oil change', 50_000, 5_000);
    await read(odometer, 53_900, { days: 1 });
    await runScan(deps());
    expect(await occurrences(oil)).toEqual([]);
    await read(odometer, 55_120, { days: 0 });
    await runScan(deps());
    expect(await occurrences(oil)).toEqual([
      expect.objectContaining({ kind: 'overdue', state: 'open', due_period: 'meter:55000' }),
    ]);
  });
});

describe('selling (D52, §7.13)', () => {
  it("a sold Corolla's nudge and schedules raise nothing, and its services stay", async () => {
    await read(odometer, 52_340, { days: 31 });
    const oil = await unitSchedule('Oil change', 47_000, 5_000);
    const service = newId();
    await own(
      `INSERT INTO public.service_records (id, location_id, thing_id, serviced_on, logged_by)
       VALUES ($1, $2, $3, (now() AT TIME ZONE 'Africa/Cairo')::date - 40, $4)`,
      [service, ibrahim.locationId, corolla, ibrahim.userId],
    );
    await runScan(deps());
    expect((await occurrences(odometer)).map((o) => o.state)).toEqual(['open']);
    expect((await occurrences(oil)).map((o) => o.state)).toEqual(['open']);

    await own(`UPDATE public.things SET lifecycle = 'sold' WHERE id = $1`, [corolla]);
    const after = await runScan(deps());
    expect(after.occurrences).toBe(0);
    expect(after.closed.cancelled).toBe(2);
    expect(await own('SELECT id FROM public.service_records WHERE id = $1', [service])).toEqual([
      { id: service },
    ]);
  });
});

describe('services complete schedules once confirmed (T14; 0063)', () => {
  /** A dated schedule, 6 months from 190 days ago: overdue. */
  async function overdue(): Promise<string> {
    const id = newId();
    await own(
      `INSERT INTO public.schedules (id, location_id, thing_id, name, every_months, anchor_on,
                                     created_by)
       VALUES ($1, $2, $3, 'Brake fluid', 6, (now() AT TIME ZONE 'Africa/Cairo')::date - 190, $4)`,
      [id, ibrahim.locationId, corolla, ibrahim.userId],
    );
    return id;
  }

  /** A service record on the Corolla, made a day before now (as a draft's would be). */
  async function service(state: 'draft' | 'confirmed'): Promise<string> {
    const id = newId();
    await own(
      `INSERT INTO public.service_records (id, location_id, thing_id, serviced_on, review_state,
                                           logged_by, created_at, updated_at)
       VALUES ($1, $2, $3, (now() AT TIME ZONE 'Africa/Cairo')::date, $4, $5,
               now() - interval '1 day', now() - interval '1 day')`,
      [id, ibrahim.locationId, corolla, state, ibrahim.userId],
    );
    return id;
  }

  const complete = (record: string, schedule: string) =>
    own(
      `INSERT INTO public.service_completions (location_id, service_record_id, schedule_id)
       VALUES ($1, $2, $3)`,
      [ibrahim.locationId, record, schedule],
    );

  it('a draft made before the occurrence and confirmed after it closes it as done', async () => {
    const fluid = await overdue();
    const draft = await service('draft');
    await runScan(deps());
    expect((await occurrences(fluid)).map((o) => o.state)).toEqual(['open']);
    // The confirm: the draft becomes confirmed and gets its completions (schedules/services.ts).
    await own(`UPDATE public.service_records SET review_state = 'confirmed' WHERE id = $1`, [
      draft,
    ]);
    await complete(draft, fluid);
    expect((await runScan(deps())).closed.done).toBe(1);
  });

  it("a draft's completion never marks a dropped occurrence done", async () => {
    const fluid = await overdue();
    await runScan(deps());
    const draft = await service('draft');
    await own(
      `UPDATE public.service_records SET created_at = now(), updated_at = now() WHERE id = $1`,
      [draft],
    );
    await complete(draft, fluid);
    // Snoozed a week: the occurrence drops for its snooze, not for the draft.
    await own(
      `UPDATE public.schedules SET snoozed_until = (now() AT TIME ZONE 'Africa/Cairo')::date + 7
        WHERE id = $1`,
      [fluid],
    );
    expect((await runScan(deps())).closed).toEqual({ done: 0, superseded: 1, cancelled: 0 });
  });
});
